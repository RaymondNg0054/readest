import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import * as CFI from 'foliate-js/epubcfi.js';
import { isTauriAppPlatform } from '@/services/environment';
import type { CalibreBookRecord, CalibrePosition, CalibreServer } from '@/types/calibre';
import type { BookFormat } from '@/types/book';
import { calibreDate, calibreFormats, parseCalibreWebFeed } from './metadata';
import { stubTranslation as _ } from '@/utils/misc';

export class CalibreHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? _('Calibre authentication failed. Check your credentials and permissions.')
        : _('Calibre request failed. Check the server and try again.'),
    );
  }
}

export const normalizeCalibreUrl = (input: string): string => {
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

interface BookJSON {
  title: string;
  authors?: string[];
  formats?: string[];
  tags?: string[];
  languages?: string[];
  pubdate?: string | null;
  publisher?: string | null;
  comments?: string | null;
  series?: string | null;
  series_index?: number | null;
  last_modified?: string;
}

// Calibre's viewer writes epubcfi(/12/2/4/...): the spine step, then a path from the
// document node, where Readest uses epubcfi(/6/12!/4/...).
const fromCalibreCfi = (cfi: string): string => {
  try {
    return CFI.fromCalibrePos(cfi);
  } catch {
    return '';
  }
};

const toCalibreCfi = (cfi: string): string => {
  const [pkg, doc] = CFI.parse(CFI.collapse(cfi));
  return CFI.toString([[pkg.at(-1), { index: 2 }, ...doc]]);
};

// Calibre accepts a digest nonce for an hour and ignores nonce counts, so later
// requests answer the last challenge instead of renegotiating each time.
const digestChallenges = new Map<string, string>();

/** Direct client: self-hosted credentials never pass through a public proxy. TLS stays verified. */
export class CalibreClient {
  private base: string;
  private cookies = new Map<string, string>();
  private metadata = new Map<string, CalibreBookRecord>();
  private pages = new Map<
    string,
    { etag?: string; modified?: string; feed: ReturnType<typeof parseCalibreWebFeed> }
  >();

  constructor(readonly server: CalibreServer) {
    this.base = normalizeCalibreUrl(server.url);
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
    // OPDS auth also initializes proxy URLs. Keep that work out of reader/cover
    // initialization when there is no Calibre connection to request.
    const { createBasicAuth, createDigestAuth, withOriginSuppressed } = await import(
      '@/app/opds/utils/opdsReq'
    );
    const headers = new Headers(withOriginSuppressed({ Accept: 'application/json' }));
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    const { username, password } = this.server;
    const digest = (challenge: string) =>
      createDigestAuth(
        username!,
        password ?? '',
        challenge,
        options.method ?? 'GET',
        target.pathname + target.search,
      );
    const challengeKey = `${this.base}\n${username}`;
    const cachedChallenge = username ? digestChallenges.get(challengeKey) : undefined;
    if (cachedChallenge) headers.set('Authorization', await digest(cachedChallenge));
    else if (username) headers.set('Authorization', createBasicAuth(username, password ?? ''));
    if (this.cookies.size)
      headers.set(
        'Cookie',
        Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; '),
      );
    const manual = options.redirect === 'manual';
    const fetcher = isTauriAppPlatform() ? tauriFetch : globalThis.fetch;
    const send = async () => {
      // AbortSignal.timeout is absent on supported older WebKit versions.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        return await fetcher(url, {
          ...options,
          // Native HTTP uses maxRedirections rather than Request.redirect.
          ...(manual && isTauriAppPlatform() ? { maxRedirections: 0 } : {}),
          headers: new Headers(headers),
          redirect: manual ? 'manual' : 'error',
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
      digestChallenges.set(challengeKey, challenge);
      headers.set('Authorization', await digest(challenge));
      res = await send();
    }
    if (this.server.kind === 'calibre-web') this.saveCookies(res.headers);
    if (!res.ok && res.status !== 304 && !(manual && res.status >= 300 && res.status < 400))
      throw new CalibreHttpError(res.status);
    return res;
  }

  // Calibre-Web uploads need its web session. Native HTTP keeps no cookie jar.
  private saveCookies(headers: Headers) {
    // Older WebKit joins Set-Cookie headers, and Expires values contain commas.
    const cookies =
      headers.getSetCookie?.() ?? (headers.get('Set-Cookie') ?? '').split(/,(?=\s*[^;,\s]+=)/);
    for (const cookie of cookies) {
      const pair = cookie.split(';')[0] ?? '';
      const at = pair.indexOf('=');
      if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }

  /**
   * Adds a book file. Without a bookId, Calibre refused a duplicate (title and
   * authors are read from the file) or Calibre-Web Automated queued ingestion.
   */
  async addBook(file: File): Promise<{ bookId?: string; title?: string; authors?: string[] }> {
    // Managed books are named "<hash>/<title>.<ext>".
    const name = file.name.split(/[\\/]/).pop()!;
    if (this.server.kind === 'calibre-web') return { bookId: await this.webUpload(file, name) };
    const data = (await (
      await this.request(
        this.url(
          `cdb/add-book/${Date.now()}/n/${encodeURIComponent(name)}/${encodeURIComponent(this.server.libraryId)}`,
        ),
        { method: 'POST', body: file },
      )
    ).json()) as { book_id?: number; title?: string; authors?: string[] };
    return { bookId: data.book_id?.toString(), title: data.title, authors: data.authors };
  }

  // Calibre-Web has no upload API: sign in through its form, then post the upload form.
  private async webUpload(file: File, name: string): Promise<string | undefined> {
    const page = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'text/html');
      const res = await this.request(this.url(path), { ...init, headers, redirect: 'manual' });
      return { res, doc: new DOMParser().parseFromString(await res.text(), 'text/html') };
    };
    const token = (doc: Document) =>
      doc.querySelector<HTMLInputElement>('input[name="csrf_token"]')?.value ?? '';
    const canUpload = (doc?: Document) => !!doc?.querySelector('input[name="btn-upload"]');
    let home = this.cookies.size ? (await page('')).doc : undefined;
    if (!canUpload(home)) {
      const login = await page('login');
      const { res } = await page('login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: this.server.username ?? '',
          password: this.server.password ?? '',
          csrf_token: token(login.doc),
          next: new URL(this.url('')).pathname,
        }),
      });
      if (res.status < 300 || res.status >= 400)
        throw new Error(_('Calibre-Web login failed. Check your credentials.'));
      home = (await page('')).doc;
    }
    const csrf = token(home!);
    if (!csrf || !canUpload(home))
      throw new Error(_('Calibre-Web uploads are off or this account cannot upload.'));
    const body = new FormData();
    body.append('csrf_token', csrf);
    body.append('btn-upload', file, name);
    const res = await this.request(this.url('upload'), {
      method: 'POST',
      headers: { 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' },
      body,
      redirect: 'manual',
    });
    const { location } = (await res.json()) as { location?: string };
    return location?.match(/\/book\/(\d+)\/?$/)?.[1];
  }

  async getLibraries(): Promise<{ id: string; name: string }[]> {
    if (this.server.kind === 'calibre-web') {
      parseCalibreWebFeed(
        await (
          await this.request(this.url('opds'), { headers: { Accept: 'application/atom+xml' } })
        ).text(),
      );
      return [{ id: 'calibre-web', name: 'Calibre-Web' }];
    }
    const data = (await (await this.request(this.url('ajax/library-info'))).json()) as {
      library_map: Record<string, string>;
    };
    if (!data.library_map || typeof data.library_map !== 'object')
      throw new Error(_('Invalid Calibre library response.'));
    return Object.entries(data.library_map).map(([id, name]) => ({ id, name }));
  }

  private async ids(query = ''): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    let total: number | undefined;
    for (let page = 0; page < 2000; page++) {
      const params = new URLSearchParams({
        num: '500',
        offset: String(ids.length),
        sort: 'title',
        sort_order: 'asc',
        query,
      });
      const data = (await (
        await this.request(
          this.url(`ajax/search/${encodeURIComponent(this.server.libraryId)}?${params}`),
        )
      ).json()) as { book_ids: number[]; total_num: number; offset: number };
      if (
        !Array.isArray(data.book_ids) ||
        !Number.isSafeInteger(data.total_num) ||
        data.total_num < 0 ||
        (total !== undefined && total !== data.total_num) ||
        data.offset !== ids.length
      )
        throw new Error(_('Incomplete Calibre catalog. Please sync again.'));
      total = data.total_num;
      for (const id of data.book_ids) {
        if (!Number.isSafeInteger(id) || id < 0 || seen.has(String(id)))
          throw new Error(_('Incomplete Calibre catalog. Please sync again.'));
        seen.add(String(id));
        ids.push(String(id));
      }
      if (ids.length === total) return ids;
      if (!data.book_ids.length || ids.length > total) break;
    }
    throw new Error(_('Incomplete Calibre catalog. Please sync again.'));
  }

  /** IDs are cheap; after the initial pass fetch only new/recently modified metadata, in bounded batches. */
  async listBooks(
    onProgress?: (done: number, total?: number) => void,
    full = false,
  ): Promise<CalibreBookRecord[]> {
    if (this.server.kind === 'calibre-web') return this.webBooks(onProgress);
    const ids = await this.ids();
    const modified = Array.from(this.metadata.values())
      .map((book) => Date.parse(book.modified ?? ''))
      .filter(Number.isFinite);
    let changed = new Set(ids);
    if (!full && this.metadata.size && modified.length === this.metadata.size) {
      // Calibre date searches are day-granular. Overlap a day for timezone and equal-timestamp edits.
      const since = new Date(
        modified.reduce((latest, stamp) => Math.max(latest, stamp), 0) - 86400_000,
      )
        .toISOString()
        .slice(0, 10);
      changed = new Set(await this.ids(`last_modified:>=${since}`));
      for (const id of ids) if (!this.metadata.has(id)) changed.add(id);
    }
    const next = new Map(this.metadata);
    const fetchIds = ids.filter((id) => changed.has(id));
    onProgress?.(0, fetchIds.length);
    for (let offset = 0; offset < fetchIds.length; offset += 50) {
      const batch = fetchIds.slice(offset, offset + 50);
      const params = new URLSearchParams({ ids: batch.join(','), category_urls: 'false' });
      const data = (await (
        await this.request(
          this.url(`ajax/books/${encodeURIComponent(this.server.libraryId)}?${params}`),
        )
      ).json()) as Record<string, BookJSON | null>;
      for (const id of batch) {
        if (!(id in data)) throw new Error(_('Incomplete Calibre catalog. Please sync again.'));
        const book = data[id];
        if (!book) {
          next.delete(id);
          continue;
        }
        if (typeof book.title !== 'string') throw new Error(_('Invalid Calibre library response.'));
        next.set(id, {
          id,
          title: book.title,
          authors: book.authors ?? [],
          formats: calibreFormats(book.formats ?? []),
          tags: book.tags ?? [],
          language: book.languages?.[0],
          published: calibreDate(book.pubdate),
          publisher: book.publisher ?? undefined,
          description: book.comments ?? undefined,
          series: book.series ?? undefined,
          seriesIndex: book.series ? (book.series_index ?? undefined) : undefined,
          modified: book.last_modified,
        });
      }
      onProgress?.(Math.min(offset + 50, fetchIds.length), fetchIds.length);
    }
    const live = new Set(ids);
    for (const id of next.keys()) if (!live.has(id)) next.delete(id);
    this.metadata = next;
    return Array.from(next.values());
  }

  private async webBooks(
    onProgress?: (done: number, total?: number) => void,
  ): Promise<CalibreBookRecord[]> {
    let url: string | undefined = this.url('opds/books/letter/00');
    const visited = new Set<string>();
    const books = new Map<string, CalibreBookRecord>();
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
      onProgress?.(books.size);
      url = page.feed.next ? new URL(page.feed.next, url).href : undefined;
    }
    this.pages = pages;
    return Array.from(books.values());
  }

  downloadUrl(bookId: string, format: BookFormat): string {
    return this.url(
      this.server.kind === 'calibre-web'
        ? `opds/download/${encodeURIComponent(bookId)}/${format.toLowerCase()}/`
        : `get/${format.toLowerCase()}/${encodeURIComponent(bookId)}/${encodeURIComponent(this.server.libraryId)}`,
    );
  }

  coverUrl(bookId: string): string {
    return this.url(
      this.server.kind === 'calibre-web'
        ? `opds/cover/${encodeURIComponent(bookId)}`
        : `get/thumb/${encodeURIComponent(bookId)}/${encodeURIComponent(this.server.libraryId)}?sz=512x512`,
    );
  }

  async getPosition(bookId: string, format: BookFormat): Promise<CalibrePosition | undefined> {
    const fmt = format.toLowerCase();
    const data = (await (
      await this.request(
        this.url(
          `book-get-last-read-position/${encodeURIComponent(this.server.libraryId)}/${encodeURIComponent(bookId)}-${fmt}`,
        ),
      )
    ).json()) as Record<string, { cfi: string; epoch: number; pos_frac: number }[]>;
    return data[`${bookId}:${fmt}`]
      ?.map(
        (p): CalibrePosition => ({
          cfi: fromCalibreCfi(p.cfi),
          timestamp: p.epoch,
          pos_frac: p.pos_frac,
        }),
      )
      .filter((p) => p.cfi && Number.isFinite(p.timestamp) && Number.isFinite(p.pos_frac))
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  async setPosition(
    bookId: string,
    format: BookFormat,
    cfi: string,
    fraction: number,
  ): Promise<void> {
    await this.request(
      this.url(
        `book-set-last-read-position/${encodeURIComponent(this.server.libraryId)}/${encodeURIComponent(bookId)}/${format.toLowerCase()}`,
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: 'Readest', cfi: toCalibreCfi(cfi), pos_frac: fraction }),
      },
    );
  }
}
