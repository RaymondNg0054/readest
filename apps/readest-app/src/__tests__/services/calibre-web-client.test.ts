import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalibreWebClient } from '@/services/catalogs/calibreWebClient';
import type { CatalogUploadTarget } from '@/types/catalogUpload';

const target: CatalogUploadTarget = {
  id: 'test',
  name: 'Test',
  url: 'https://books.test/mount',
  protocol: 'calibre-web',
  catalogIds: ['opds'],
  username: 'reader',
  password: 'secret',
};
const feed = (id = '1', next = '') =>
  `<feed xmlns="http://www.w3.org/2005/Atom">${next && `<link rel="next" href="${next}"/>`}<entry><title>Book</title><link rel="http://opds-spec.org/acquisition" href="/mount/opds/download/${id}/epub/"/></entry></feed>`;

afterEach(() => vi.unstubAllGlobals());

describe('Calibre-Web upload transport and snapshots', () => {
  it('works in supported WebViews without AbortSignal.timeout', async () => {
    vi.stubGlobal('AbortSignal', {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(feed())));
    expect(await new CalibreWebClient(target).listBooks()).toHaveLength(1);
  });

  it('preserves mount paths and authenticates without weakening TLS', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(feed()));
    vi.stubGlobal('fetch', fetcher);
    const client = new CalibreWebClient(target);
    await client.listBooks();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://books.test/mount/opds/books/letter/00');
    const options = fetcher.mock.calls[0]?.[1];
    expect(new Headers(options.headers).get('Authorization')).toMatch(/^Basic /);
    expect(options.danger).toBeUndefined();
    expect(options.redirect).toBe('error');
    expect(client.downloadUrl('12', 'EPUB')).toBe(
      'https://books.test/mount/opds/download/12/epub/',
    );
  });

  it('negotiates digest auth after a 400 rejection of Basic', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Digest realm="calibre", nonce="nonce", qop="auth"' },
        }),
      )
      .mockResolvedValueOnce(new Response(feed()));
    vi.stubGlobal('fetch', fetcher);
    await new CalibreWebClient(target).listBooks();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Headers(fetcher.mock.calls[1]?.[1].headers).has('Authorization')).toBe(false);
    expect(new Headers(fetcher.mock.calls[2]?.[1].headers).get('Authorization')).toContain(
      'Digest ',
    );
  });

  it('uses conditional pages and rejects foreign pagination before forwarding credentials', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(feed(), { headers: { ETag: 'version1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(
        new Response('<feed><link rel="next" href="https://evil.test/opds"/></feed>'),
      );
    vi.stubGlobal('fetch', fetcher);
    const client = new CalibreWebClient(target);
    expect(await client.listBooks()).toHaveLength(1);
    expect(await client.listBooks()).toHaveLength(1);
    expect(new Headers(fetcher.mock.calls[1]?.[1].headers).get('If-None-Match')).toBe('version1');
    await expect(client.listBooks()).rejects.toThrow('outside the configured server');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reads every page without accepting cycles or duplicate book IDs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(feed('1', '/mount/opds/page2')))
      .mockResolvedValueOnce(new Response(feed('2')));
    vi.stubGlobal('fetch', fetcher);
    expect((await new CalibreWebClient(target).listBooks()).map((book) => book.id)).toEqual([
      '1',
      '2',
    ]);
    fetcher
      .mockResolvedValueOnce(new Response(feed('1', '/mount/opds/page2')))
      .mockResolvedValueOnce(new Response(feed('2', '/mount/opds/page2')));
    await expect(new CalibreWebClient(target).listBooks()).rejects.toThrow('Incomplete');
    fetcher
      .mockResolvedValueOnce(new Response(feed('1', '/mount/opds/page2')))
      .mockResolvedValueOnce(new Response(feed('1')));
    await expect(new CalibreWebClient(target).listBooks()).rejects.toThrow('Incomplete');
  });
});
