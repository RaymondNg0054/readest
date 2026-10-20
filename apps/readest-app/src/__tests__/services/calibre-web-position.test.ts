import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalibreClient } from '@/services/calibre/client';
import type { CalibreServer } from '@/types/calibre';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import * as environment from '@/services/environment';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

const uuid = 'c286817e-22f3-4cae-a495-755d371fd824';
const token = '0123456789abcdef0123456789abcdef';
const cfi = 'epubcfi(/6/12!/4/2/2[chapter]/4/46)';
const server = {
  id: 'web',
  name: 'Calibre-Web',
  url: 'https://books.test/mount',
  kind: 'calibre-web',
  libraryId: 'calibre-web',
  enabled: true,
  syncProgress: true,
  koboToken: token,
} satisfies CalibreServer;
const bookmark = {
  LastModified: '2026-10-19T12:00:00Z',
  ProgressPercent: 35,
  ContentSourceProgressPercent: 35,
  Location: { Value: cfi, Type: 'CFI', Source: 'Readest' },
};
const state = (current: unknown = bookmark) => [{ EntitlementId: uuid, CurrentBookmark: current }];
const success = {
  RequestResult: 'Success',
  UpdateResults: [
    {
      EntitlementId: uuid,
      CurrentBookmarkResult: { Result: 'Success' },
      StatusInfoResult: { Result: 'Success' },
    },
  ],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Calibre-Web reading positions', () => {
  it('pulls the timestamped EPUB position by UUID through the mounted Kobo endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(state()));
    vi.stubGlobal('fetch', fetcher);
    expect(await new CalibreClient(server).getPosition(uuid, 'EPUB')).toEqual({
      cfi,
      pos_frac: 0.35,
      timestamp: Date.parse(bookmark.LastModified) / 1000,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://books.test/mount/kobo/${token}/v1/library/${uuid}/state`,
    );
  });

  it("uses percentage fallback for another client's location instead of treating it as a Readest CFI", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          state({
            ...bookmark,
            Location: { Value: 'chapter.xhtml#kobo.1.2', Type: 'KoboSpan', Source: 'Kobo' },
          }),
        ),
      ),
    );
    expect(await new CalibreClient(server).getPosition(uuid, 'EPUB')).toMatchObject({
      cfi: '',
      pos_frac: 0.35,
    });
  });

  it('does not mistake an empty bookmark created by GET for a remote reading position', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json([
            { EntitlementId: uuid, CurrentBookmark: { LastModified: bookmark.LastModified } },
          ]),
        ),
    );
    expect(await new CalibreClient(server).getPosition(uuid, 'EPUB')).toBeUndefined();
  });

  it.each([
    {},
    [],
    [{ EntitlementId: 'another-book', CurrentBookmark: bookmark }],
    state(42),
    state({}),
    state({ ...bookmark, ProgressPercent: 200, ContentSourceProgressPercent: 200 }),
    state({ ...bookmark, LastModified: 'invalid-date' }),
    state({ ...bookmark, ProgressPercent: '35', ContentSourceProgressPercent: '35' }),
  ])('rejects malformed or unrelated state without authorizing a local overwrite: %j', async (data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)));
    await expect(new CalibreClient(server).getPosition(uuid, 'EPUB')).rejects.toThrow();
  });

  it.each([
    [0, 'ReadyToRead'],
    [0.35, 'Reading'],
    [1, 'Finished'],
  ] as const)('publishes fraction %s, the exact CFI and its reading status without replacing statistics', async (fraction, status) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(success));
    vi.stubGlobal('fetch', fetcher);
    await new CalibreClient(server).setPosition(uuid, 'EPUB', cfi, fraction);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://books.test/mount/kobo/${token}/v1/library/${uuid}/state`);
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({
      ReadingStates: [
        {
          CurrentBookmark: {
            ProgressPercent: fraction * 100,
            ContentSourceProgressPercent: fraction * 100,
            Location: { Value: cfi, Type: 'CFI', Source: 'Readest' },
          },
          Statistics: null,
          StatusInfo: { Status: status },
        },
      ],
    });
  });

  it('reports an unsuccessful write even when the server returns HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ RequestResult: 'Failure' })));
    await expect(new CalibreClient(server).setPosition(uuid, 'EPUB', cfi, 0.35)).rejects.toThrow();
  });

  it('requires a token and a book UUID before making any requests', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      new CalibreClient({ ...server, koboToken: '' }).getPosition(uuid, 'EPUB'),
    ).rejects.toThrow();
    await expect(new CalibreClient(server).getPosition('12', 'EPUB')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops native redirects before the token-bearing request can leave the server', async () => {
    vi.spyOn(environment, 'isTauriAppPlatform').mockReturnValue(true);
    vi.mocked(tauriFetch).mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://other.test' } }),
    );
    await expect(new CalibreClient(server).getPosition(uuid, 'EPUB')).rejects.toThrow();
    expect(tauriFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxRedirections: 0 }),
    );
  });
});
