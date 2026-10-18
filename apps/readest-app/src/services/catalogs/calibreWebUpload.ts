import type { Book, BookFormat } from '@/types/book';
import { EXTS, MIMETYPES } from '@/libs/document';
import type { CatalogUploadAdapter, CatalogUploadTarget } from '@/types/catalogUpload';
import { CalibreWebClient, CalibreWebHttpError } from './calibreWebClient';
import { stubTranslation as _ } from '@/utils/misc';
import { CatalogUploadRejectedError } from './errors';

interface SessionCookie {
  value: string;
  path: string;
  secure: boolean;
}

class CalibreWebUploadAdapter implements CatalogUploadAdapter {
  private cookies = new Map<string, SessionCookie>();
  private csrf?: string;
  private readClient: CalibreWebClient;
  private formClient: CalibreWebClient;

  constructor(private readonly target: CatalogUploadTarget) {
    this.readClient = new CalibreWebClient(target);
    // Form POSTs must not be replayed by the OPDS client's auth negotiation.
    const headers = Object.fromEntries(
      Object.entries(target.customHeaders ?? {}).filter(
        ([name]) => !['content-type', 'cookie'].includes(name.toLowerCase()),
      ),
    );
    this.formClient = new CalibreWebClient({
      ...target,
      username: undefined,
      password: undefined,
      customHeaders: headers,
    });
  }

  private localUrl(href: string): URL {
    const base = new URL(this.formClient.url(''));
    const url = new URL(href, base);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname) ||
      url.username ||
      url.password
    )
      throw new Error(_('Catalog redirect points outside the configured server.'));
    return url;
  }

  private saveCookies(headers: Headers) {
    // Older WebKit exposes combined Set-Cookie headers; Expires also contains commas.
    const cookies = (headers.getSetCookie?.() ?? [headers.get('Set-Cookie') ?? '']).flatMap(
      (header) => header.split(/,(?=\s*[^;,\s]+=)/),
    );
    for (const cookie of cookies) {
      const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const path = attributes.find((part) => /^path=/i.test(part))?.slice(5) ?? '/';
      const domain = attributes
        .find((part) => /^domain=/i.test(part))
        ?.slice(7)
        .replace(/^\./, '')
        .toLowerCase();
      const host = new URL(this.target.url).hostname;
      if (domain && host !== domain && !host.endsWith(`.${domain}`)) continue;
      if (attributes.some((part) => /^max-age=/i.test(part) && Number(part.slice(8)) <= 0))
        this.cookies.delete(name);
      else
        this.cookies.set(name, {
          value,
          path,
          secure: attributes.some((part) => /^secure$/i.test(part)),
        });
    }
  }

  private async request(href: string, options: RequestInit = {}): Promise<Response> {
    const url = this.localUrl(href);
    const headers = new Headers(options.headers);
    const cookie = Array.from(this.cookies)
      .filter(
        ([, cookie]) =>
          (!cookie.secure || url.protocol === 'https:') &&
          url.pathname.startsWith(cookie.path) &&
          (cookie.path.endsWith('/') ||
            url.pathname.length === cookie.path.length ||
            url.pathname[cookie.path.length] === '/'),
      )
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join('; ');
    // An explicit empty header prevents borrowing another account's native cookie-jar session.
    headers.set('Cookie', cookie);
    if (this.target.username && !headers.has('Authorization')) {
      const { createBasicAuth } = await import('@/app/opds/utils/opdsReq');
      headers.set(
        'Authorization',
        createBasicAuth(this.target.username, this.target.password ?? ''),
      );
    }
    const response = await this.formClient.request(url.href, {
      ...options,
      headers,
      credentials: 'omit',
      redirect: 'manual',
    });
    this.saveCookies(response.headers);
    return response;
  }

  private token(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const token = doc.querySelector<HTMLInputElement>('input[name="csrf_token"]')?.value;
    if (!token)
      throw new Error(
        _(
          'Calibre-Web did not provide a CSRF token. Check that username/password login is enabled.',
        ),
      );
    return token;
  }

  private async uploadForm(): Promise<string> {
    let page: Response;
    if (this.csrf) {
      page = await this.request(this.formClient.url(''), { headers: { Accept: 'text/html' } });
      if (page.status >= 300) this.csrf = undefined;
    }
    if (!this.csrf) {
      if (!this.target.username)
        throw new Error(_('Configure a Calibre-Web username and password with upload permission.'));
      const login = await this.request(this.formClient.url('login'), {
        headers: { Accept: 'text/html' },
      });
      if (login.status >= 300) {
        const location = login.headers.get('Location');
        if (!location) throw new Error(_('Calibre-Web login failed.'));
        page = await this.request(this.localUrl(location).href, {
          headers: { Accept: 'text/html' },
        });
      } else {
        const csrf = this.token(await login.text());
        const loggedIn = await this.request(this.formClient.url('login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
          body: new URLSearchParams({
            username: this.target.username,
            password: this.target.password ?? '',
            csrf_token: csrf,
            next: new URL(this.formClient.url('')).pathname,
          }).toString(),
        });
        const location = loggedIn.headers.get('Location');
        if (
          loggedIn.status < 300 ||
          !location ||
          this.localUrl(location).pathname === new URL(this.formClient.url('login')).pathname
        )
          throw new Error(_('Calibre-Web login failed. Check your credentials.'));
        page = await this.request(this.formClient.url(''), { headers: { Accept: 'text/html' } });
      }
    }
    const html = await page!.text();
    if (
      !new DOMParser()
        .parseFromString(html, 'text/html')
        .querySelector('input[type="file"][name="btn-upload"]')
    )
      throw new Error(
        _('Calibre-Web uploads are disabled or this account lacks upload permission.'),
      );
    this.csrf = this.token(html);
    return this.csrf;
  }

  async upload(file: File, onSend: () => void): Promise<{ bookId?: string }> {
    try {
      const csrf = await this.uploadForm();
      const body = new FormData();
      body.append('csrf_token', csrf);
      body.append('btn-upload', file, file.name);
      onSend();
      const response = await this.request(this.formClient.url('upload'), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'X-CSRFToken': csrf,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
      });
      if (!response.ok)
        throw new Error(
          _('The catalog did not confirm the upload. Check the server before sending it again.'),
        );
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== 'object' ||
        !('location' in data) ||
        typeof data.location !== 'string'
      )
        throw new Error(
          _('The catalog did not confirm the upload. Check the server before sending it again.'),
        );
      const location = this.localUrl(data.location);
      const path = location.pathname.slice(new URL(this.formClient.url('')).pathname.length);
      const bookId = path.match(/^(?:admin\/)?book\/(\d+)\/?$/)?.[1];
      if (bookId) return { bookId };
      if (/^tasks\/?$/.test(path)) return {};
      throw new Error(
        _('The catalog did not confirm the upload. Check the server before sending it again.'),
      );
    } catch (error) {
      this.csrf = undefined;
      if (error instanceof CalibreWebHttpError && [400, 401, 403, 413, 415].includes(error.status))
        throw new CatalogUploadRejectedError(error.message);
      throw error;
    }
  }

  async listBooks() {
    return (await this.readClient.listBooks()).map((book) => ({
      id: book.id,
      title: book.title,
      author: book.authors.join(', '),
      formats: book.formats,
      modified: book.modified,
      sourceUrls: [
        ...(book.publicationId ? [book.publicationId] : []),
        ...book.formats.map((format) => this.readClient.downloadUrl(book.id, format)),
      ],
    }));
  }

  async getBookFile(bookId: string, format: BookFormat): Promise<File> {
    const response = await this.readClient.request(this.readClient.downloadUrl(bookId, format), {
      credentials: 'omit',
      headers: { Cookie: '' },
    });
    return new File([await response.arrayBuffer()], `catalog.${EXTS[format]}`, {
      type: MIMETYPES[format][0],
    });
  }

  getBookId(book: Book): string | undefined {
    if (book.metadata?.catalogSource?.targetId === this.target.id)
      return book.metadata.catalogSource.bookId;
    return undefined;
  }
}

const adapters = new Map<string, { config: string; adapter: CalibreWebUploadAdapter }>();

export function createCalibreWebUploadAdapter(target: CatalogUploadTarget): CatalogUploadAdapter {
  const config = JSON.stringify([
    target.url,
    target.username,
    target.password,
    target.customHeaders,
  ]);
  const existing = adapters.get(target.id);
  if (existing?.config === config) return existing.adapter;
  const adapter = new CalibreWebUploadAdapter(target);
  adapters.set(target.id, { config, adapter });
  return adapter;
}
