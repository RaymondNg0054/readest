import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';

const sync = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/services/calibre/librarySync', () => ({ syncCalibreServer: sync }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: {} }) }));

import { useCalibreSync } from '@/hooks/useCalibreSync';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';

const book = (hash: string): Book => ({
  hash,
  format: 'EPUB',
  title: hash,
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
  downloadedAt: 1,
});

afterEach(() => {
  cleanup();
  sync.mockClear();
});

describe('useCalibreSync', () => {
  it('syncs as soon as a local book is added, so it is sent without waiting', async () => {
    useSettingsStore.setState({
      settings: {
        calibreServers: [
          {
            id: 's',
            name: 'Calibre',
            url: 'https://books.test',
            kind: 'calibre',
            libraryId: 'l',
            enabled: true,
            syncProgress: false,
          },
        ],
      } as SystemSettings,
    });
    useLibraryStore.setState({ libraryLoaded: true });
    useLibraryStore.getState().setLibrary([book('a')]);
    renderHook(() => useCalibreSync());
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    act(() => useLibraryStore.getState().setLibrary([book('a'), book('b')]));
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
  });
});
