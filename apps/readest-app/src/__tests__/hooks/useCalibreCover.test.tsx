import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  writeFile: vi.fn(),
  generateCoverImageUrl: vi.fn(),
}));
vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  getInitializedAppService: () => mocks,
}));
vi.mock('@/services/coverThumbnailService', () => ({
  observeCoverForThumbnail: (_element: Element, callback: () => void) => {
    callback();
    return () => {};
  },
}));
import { useCalibreCover } from '@/hooks/useCalibreCover';
import { CalibreClient } from '@/services/calibre/client';
import { useSettingsStore } from '@/store/settingsStore';

const book: Book = {
  hash: 'hash',
  title: 'Book',
  author: 'Author',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 1,
  coverImageUrl: 'asset://localhost/Books/hash/cover.png',
  metadata: {
    title: 'Book',
    author: 'Author',
    language: '',
    calibreSource: { serverId: 'server', libraryId: 'Library', bookId: '1', formats: ['EPUB'] },
  },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('lazy Calibre covers', () => {
  it('fetches a missing native cover even when library hydration supplied an asset URL', async () => {
    useSettingsStore.setState({
      settings: {
        calibreServers: [
          {
            id: 'server',
            name: 'Server',
            kind: 'calibre',
            url: 'https://books.test',
            libraryId: 'Library',
            enabled: true,
            syncProgress: false,
          },
        ],
      } as SystemSettings,
    });
    mocks.exists.mockResolvedValue(false);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.generateCoverImageUrl.mockResolvedValue(book.coverImageUrl);
    const request = vi
      .spyOn(CalibreClient.prototype, 'request')
      .mockResolvedValue(new Response('cover', { headers: { 'Content-Type': 'image/jpeg' } }));
    const element = { current: document.createElement('div') };
    const { result } = renderHook(() => useCalibreCover(book, element, false));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current).toContain('asset://localhost/Books/hash/cover.png?'),
    );
    expect(mocks.writeFile).toHaveBeenCalled();
  });
  it('never requests hidden covers', () => {
    const request = vi.spyOn(CalibreClient.prototype, 'request');
    renderHook(() => useCalibreCover(book, { current: document.createElement('div') }, true));
    expect(request).not.toHaveBeenCalled();
  });
});
