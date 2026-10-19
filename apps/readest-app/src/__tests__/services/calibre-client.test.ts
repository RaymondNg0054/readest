import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalibreClient } from '@/services/calibre/client';
import type { CalibreServer } from '@/types/calibre';

const server: CalibreServer = {
  id: 'test',
  name: 'Test',
  url: 'https://books.test/mount',
  kind: 'calibre',
  libraryId: 'My Library',
  enabled: true,
  syncProgress: true,
  username: 'reader',
  password: 'secret',
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const metadata = {
  title: 'A book',
  authors: ['Author'],
  formats: ['EPUB', 'PDF'],
  tags: ['Fiction'],
  pubdate: '2000-01-01',
  last_modified: '2026-09-20T00:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());

describe('Calibre transport and snapshots', () => {
  it('works in supported WebViews without AbortSignal.timeout', async () => {
    vi.stubGlobal('AbortSignal', {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ library_map: { Library: 'Library' } })),
    );
    expect(await new CalibreClient(server).getLibraries()).toEqual([
      { id: 'Library', name: 'Library' },
    ]);
  });
  it('keeps metadata batches bounded and auto-sync cheap across thousands of books', async () => {
    const ids = Array.from({ length: 2500 }, (_, index) => index + 1);
    let metadataRequests = 0;
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.includes('/ajax/search/')) {
        const matches = url.searchParams.get('query') ? [] : ids;
        const offset = Number(url.searchParams.get('offset'));
        return json({
          book_ids: matches.slice(offset, offset + 500),
          total_num: matches.length,
          offset,
        });
      }
      const batch = url.searchParams.get('ids')!.split(',');
      expect(batch.length).toBeLessThanOrEqual(50);
      metadataRequests++;
      return json(Object.fromEntries(batch.map((id) => [id, metadata])));
    });
    vi.stubGlobal('fetch', fetcher);
    const client = new CalibreClient(server);
    expect(await client.listBooks()).toHaveLength(2500);
    expect(metadataRequests).toBe(50);
    const initialRequests = fetcher.mock.calls.length;
    expect(await client.listBooks()).toHaveLength(2500);
    expect(fetcher.mock.calls.length - initialRequests).toBe(6);
    expect(metadataRequests).toBe(50);
  });
  it('reads Calibre position epochs in seconds, choosing the latest device record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          '12:epub': [
            { cfi: 'epubcfi(/4/2/4/2)', pos_frac: 0.1, epoch: 100 },
            { cfi: 'epubcfi(/12/2/4/2/2[chapter]/4/46)', pos_frac: 0.5, epoch: 200 },
          ],
        }),
      ),
    );
    expect(await new CalibreClient(server).getPosition('12', 'EPUB')).toMatchObject({
      cfi: 'epubcfi(/6/12!/4/2/2[chapter]/4/46)',
      timestamp: 200,
    });
  });
  it("writes positions in Calibre's CFI form: spine step first, path from the document node", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetcher);
    await new CalibreClient(server).setPosition(
      '12',
      'EPUB',
      'epubcfi(/6/12!/4/2/2[chapter]/4,/46,/110/1:9)',
      0.2,
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toMatchObject({
      cfi: 'epubcfi(/12/2/4/2/2[chapter]/4/46)',
      pos_frac: 0.2,
    });
  });
  it('preserves mount paths, encodes library IDs, authenticates without weakening TLS', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        json({ library_map: { 'My Library': 'My Library' }, default_library: 'My Library' }),
      );
    vi.stubGlobal('fetch', fetcher);
    await new CalibreClient(server).getLibraries();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://books.test/mount/ajax/library-info');
    const options = fetcher.mock.calls[0]?.[1];
    expect(new Headers(options.headers).get('Authorization')).toMatch(/^Basic /);
    expect(options.danger).toBeUndefined();
    expect(options.redirect).toBe('error');
  });

  it('asks the content server for a shelf-sized cover instead of its tiny default thumbnail', () => {
    expect(new CalibreClient(server).coverUrl('7')).toBe(
      'https://books.test/mount/get/thumb/7/My%20Library?sz=512x512',
    );
  });

  it('negotiates Calibre digest auth after its 400 rejection of Basic', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Digest realm="calibre", nonce="nonce", qop="auth"' },
        }),
      )
      .mockResolvedValueOnce(
        json({ library_map: { library: 'Library' }, default_library: 'library' }),
      );
    vi.stubGlobal('fetch', fetcher);
    const digestServer = { ...server, url: 'https://digest.test' };
    await new CalibreClient(digestServer).getLibraries();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Headers(fetcher.mock.calls[1]?.[1].headers).has('Authorization')).toBe(false);
    expect(new Headers(fetcher.mock.calls[2]?.[1].headers).get('Authorization')).toContain(
      'Digest ',
    );
    // Calibre accepts a nonce for an hour: later requests answer the last challenge directly.
    fetcher.mockResolvedValueOnce(
      json({ library_map: { library: 'Library' }, default_library: 'library' }),
    );
    await new CalibreClient(digestServer).getLibraries();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(new Headers(fetcher.mock.calls[3]?.[1].headers).get('Authorization')).toContain(
      'Digest ',
    );
  });

  it('fetches every ID even when the server caps page sizes, and disables category expansion', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ book_ids: [1], total_num: 2, offset: 0 }))
      .mockResolvedValueOnce(json({ book_ids: [2], total_num: 2, offset: 1 }))
      .mockResolvedValueOnce(json({ 1: metadata, 2: metadata }));
    vi.stubGlobal('fetch', fetcher);
    const result = await new CalibreClient(server).listBooks();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: '1', published: '2000-01-01', formats: ['EPUB', 'PDF'] });
    expect(fetcher.mock.calls[0]?.[0]).toContain('/ajax/search/My%20Library?');
    expect(fetcher.mock.calls[1]?.[0]).toContain('offset=1');
    expect(fetcher.mock.calls[2]?.[0]).toContain('category_urls=false');
  });

  it('leaves series, publisher and date unset when Calibre sends null or its placeholder date', async () => {
    const undated = {
      ...metadata,
      pubdate: '0101-01-01T00:00:00+00:00',
      series: null,
      series_index: 1,
      publisher: null,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ book_ids: [1], total_num: 1, offset: 0 }))
      .mockResolvedValueOnce(json({ 1: undated }));
    vi.stubGlobal('fetch', fetcher);
    const [book] = await new CalibreClient(server).listBooks();
    expect(book).toMatchObject({ title: 'A book' });
    expect(book?.published).toBeUndefined();
    expect(book?.series).toBeUndefined();
    expect(book?.seriesIndex).toBeUndefined();
    expect(book?.publisher).toBeUndefined();
  });

  it('refuses incomplete or cycling pagination instead of reporting unseen books removed', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ book_ids: [1], total_num: 2, offset: 0 }))
      .mockResolvedValueOnce(json({ book_ids: [], total_num: 2, offset: 1 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(new CalibreClient(server).listBooks()).rejects.toThrow('Incomplete');
  });

  it('auto-sync fetches IDs and recently changed metadata, not the whole catalog again', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ book_ids: [1], total_num: 1, offset: 0 }))
      .mockResolvedValueOnce(json({ 1: metadata }))
      .mockResolvedValueOnce(json({ book_ids: [1], total_num: 1, offset: 0 }))
      .mockResolvedValueOnce(json({ book_ids: [], total_num: 0, offset: 0 }));
    vi.stubGlobal('fetch', fetcher);
    const client = new CalibreClient(server);
    await client.listBooks();
    expect(await client.listBooks()).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(new URL(fetcher.mock.calls[3]?.[0]).searchParams.get('query')).toContain(
      'last_modified:',
    );
  });

  it('uses conditional Calibre-Web pages and rejects credential-bearing foreign pagination links', async () => {
    const feed =
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Book</title><link rel="http://opds-spec.org/acquisition" href="/mount/opds/download/1/epub/"/></entry></feed>';
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(feed, { headers: { ETag: 'version1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(
        new Response('<feed><link rel="next" href="https://evil.test/opds"/></feed>'),
      );
    vi.stubGlobal('fetch', fetcher);
    const client = new CalibreClient({ ...server, kind: 'calibre-web' });
    expect(await client.listBooks()).toHaveLength(1);
    expect(await client.listBooks()).toHaveLength(1);
    expect(new Headers(fetcher.mock.calls[1]?.[1].headers).get('If-None-Match')).toBe('version1');
    await expect(client.listBooks()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
