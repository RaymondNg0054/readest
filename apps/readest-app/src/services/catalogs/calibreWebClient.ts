import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import type { CatalogUploadTarget } from '@/types/catalogUpload';
import type { BookFormat } from '@/types/book';
import { parseCalibreWebFeed, type CalibreWebBook } from './calibreWebFeed';
import { stubTranslation as _ } from '@/utils/misc';

export class CalibreWebHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? _('Calibre authentication failed. Check your credentials and permissions.')
        : _('Calibre request failed. Check the server and try again.'),
    );
  }
}

const normalizeCalibreWebUrl = (input: string): string => {
  const url = new URL(input.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(_('Enter an HTTP or HTTPS server URL without credentials, query or fragment.'));
  }
  return url.href.replace(/\/+$/, '');
};

/** Direct client: self-hosted credentials never pass through a public proxy. TLS stays verified. */
export class CalibreWebClient {
  private base: string;
  private pages = new Map<
    string,
    { etag?: string; modified?: string; feed: ReturnType<typeof parseCalibreWebFeed> }
  >();

  constructor(private readonly target: CatalogUploadTarget) {
    this.base = normalizeCalibreWebUrl(target.url);
  }

  url(path: string): string {
    return `${this.base}/${path.replace(/^\/+/, '')}`;
  }

  async request(url: string, options: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    const base = new URL(this.base);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}/`) ||
      target.username ||
      target.password
    ) {
      throw new Error(_('Calibre link points outside the configured server.'));
    }
    const { createBasicAuth, createDigestAuth, withOriginSuppressed } = await import(
      '@/app/opds/utils/opdsReq'
    );
    const headers = new Headers(
      withOriginSuppressed({ Accept: 'application/json', ...this.target.customHeaders }),
    );
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    const { username, password } = this.target;
    if (username) headers.set('Authorization', createBasicAuth(username, password ?? ''));
    const fetcher = isTauriAppPlatform() ? tauriFetch : globalThis.fetch;
    const send = async () => {
      // AbortSignal.timeout is absent on supported older WebKit versions.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        return await fetcher(url, {
          ...options,
          // Native HTTP uses maxRedirections rather than Request.redirect.
          ...(isTauriAppPlatform() ? { maxRedirections: 0 } : {}),
          headers: new Headers(headers),
          redirect: options.redirect === 'manual' ? 'manual' : 'error',
          signal: options.signal ?? controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    let res = await send();
    if (username && res.status === 400) {
      headers.delete('Authorization');
      res = await send();
    }
    const challenge = res.headers.get('WWW-Authenticate');
    if (username && res.status === 401 && challenge?.toLowerCase().startsWith('digest')) {
      headers.set(
        'Authorization',
        await createDigestAuth(
          username,
          password ?? '',
          challenge,
          options.method ?? 'GET',
          target.pathname + target.search,
        ),
      );
      res = await send();
    }
    if (
      !res.ok &&
      res.status !== 304 &&
      !(options.redirect === 'manual' && res.status >= 300 && res.status < 400)
    )
      throw new CalibreWebHttpError(res.status);
    return res;
  }

  async listBooks(): Promise<CalibreWebBook[]> {
    let url: string | undefined = this.url('opds/books/letter/00');
    const visited = new Set<string>();
    const books = new Map<string, CalibreWebBook>();
    const pages = new Map<string, typeof this.pages extends Map<string, infer T> ? T : never>();
    while (url) {
      if (visited.has(url) || visited.size >= 2000)
        throw new Error(_('Incomplete Calibre catalog. Please sync again.'));
      visited.add(url);
      const cached = this.pages.get(url);
      const headers = new Headers({ Accept: 'application/atom+xml' });
      if (cached?.etag) headers.set('If-None-Match', cached.etag);
      if (cached?.modified) headers.set('If-Modified-Since', cached.modified);
      const res = await this.request(url, { headers });
      const page =
        res.status === 304 && cached
          ? cached
          : {
              etag: res.headers.get('ETag') ?? undefined,
              modified: res.headers.get('Last-Modified') ?? undefined,
              feed: parseCalibreWebFeed(await res.text()),
            };
      pages.set(url, page);
      for (const book of page.feed.books) {
        if (books.has(book.id))
          throw new Error(_('Incomplete Calibre catalog. Please sync again.'));
        books.set(book.id, book);
      }
      url = page.feed.next ? new URL(page.feed.next, url).href : undefined;
    }
    this.pages = pages;
    return Array.from(books.values());
  }

  downloadUrl(bookId: string, format: BookFormat): string {
    return this.url(`opds/download/${encodeURIComponent(bookId)}/${format.toLowerCase()}/`);
  }
}
