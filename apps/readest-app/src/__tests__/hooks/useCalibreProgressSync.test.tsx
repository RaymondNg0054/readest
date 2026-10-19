import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Book, BookConfig, BookProgress } from '@/types/book';
import type { CalibrePosition, CalibreServer } from '@/types/calibre';
import type { SystemSettings } from '@/types/settings';

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => translate }));
const translate = (text: string) => text;
const client = { getPosition: vi.fn(), setPosition: vi.fn() };
vi.mock('@/services/calibre/client', () => ({
  CalibreClient: class {
    getPosition = client.getPosition;
    setPosition = client.setPosition;
  },
}));

import { useCalibreProgressSync } from '@/app/reader/hooks/useCalibreProgressSync';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { useReaderProgressStore } from '@/store/readerProgressStore';
import { eventDispatcher } from '@/utils/event';

const key = 'hash-0';
const local = 'epubcfi(/6/4!/4/2/2/1:0)';
const remote = 'epubcfi(/6/14!/4/2/10/1:0)';
const next = 'epubcfi(/6/8!/4/2/6/1:0)';
const server: CalibreServer = {
  id: 'server',
  name: 'Calibre',
  url: 'https://books.test',
  kind: 'calibre',
  libraryId: 'Library',
  username: 'reader',
  enabled: true,
  syncProgress: true,
};
const book: Book = {
  hash: 'hash',
  title: 'Book',
  author: 'Author',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 1,
  metadata: {
    title: 'Book',
    author: 'Author',
    language: 'en',
    calibreSource: {
      serverId: server.id,
      libraryId: server.libraryId,
      bookId: '1',
      formats: ['EPUB'],
    },
  },
};
const view = { goTo: vi.fn() };
const seedProgress = (location = local, fraction = 0.1) =>
  useReaderProgressStore.setState({
    progresses: { [key]: { location, fraction } as BookProgress },
  });
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
let restore: Pick<ReturnType<typeof useReaderStore.getState>, 'getView' | 'getViewState'>;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  restore = {
    getView: useReaderStore.getState().getView,
    getViewState: useReaderStore.getState().getViewState,
  };
  useReaderStore.setState({
    getView: () => view as never,
    getViewState: () => ({ previewMode: false }) as never,
  });
  useSettingsStore.setState({ settings: { calibreServers: [server] } as SystemSettings });
  useBookDataStore.setState({
    booksData: {
      hash: { id: 'hash', book, config: { updatedAt: 1 } as BookConfig },
    } as unknown as ReturnType<typeof useBookDataStore.getState>['booksData'],
  });
  seedProgress();
  client.getPosition.mockResolvedValue(undefined);
  client.setPosition.mockResolvedValue(undefined);
  view.goTo.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  useReaderStore.setState(restore);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Calibre reader sync', () => {
  it('pulls newer progress and does not echo the opening location back', async () => {
    client.getPosition.mockResolvedValue({ cfi: remote, pos_frac: 0.5, timestamp: 5 });
    renderHook(() => useCalibreProgressSync(key));
    await settle();
    expect(view.goTo).toHaveBeenCalledWith(remote);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(client.setPosition).not.toHaveBeenCalled();
  });
  it('holds close/manual pushes until the initial pull settles and does not yank a page turned meanwhile', async () => {
    let complete: (position: CalibrePosition) => void = () => {};
    client.getPosition.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    renderHook(() => useCalibreProgressSync(key));
    await settle();
    act(() => {
      seedProgress(next, 0.3);
    });
    await settle();
    act(() => {
      eventDispatcher.dispatch('sync-book-progress', { bookKey: key });
    });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(client.setPosition).not.toHaveBeenCalled();
    await act(async () => {
      complete({ cfi: remote, pos_frac: 0.5, timestamp: 5 });
    });
    await settle();
    expect(view.goTo).not.toHaveBeenCalled();
    expect(client.setPosition).toHaveBeenCalledWith('1', 'EPUB', next, 0.3);
  });
  it('never overwrites unread remote progress after a failed pull', async () => {
    client.getPosition.mockRejectedValue(new Error('offline'));
    renderHook(() => useCalibreProgressSync(key));
    await settle();
    act(() => {
      seedProgress(next, 0.3);
      eventDispatcher.dispatch('sync-book-progress', { bookKey: key });
    });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(client.setPosition).not.toHaveBeenCalled();
  });
  it('ignores late pulls after unmount and skips Calibre-Web', async () => {
    let complete: (position: CalibrePosition) => void = () => {};
    client.getPosition.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const mounted = renderHook(() => useCalibreProgressSync(key));
    await settle();
    mounted.unmount();
    await act(async () => {
      complete({ cfi: remote, pos_frac: 0.5, timestamp: 5 });
    });
    expect(view.goTo).not.toHaveBeenCalled();
    client.getPosition.mockClear();
    useSettingsStore.setState({
      settings: { calibreServers: [{ ...server, kind: 'calibre-web' }] } as SystemSettings,
    });
    renderHook(() => useCalibreProgressSync(key));
    await settle();
    expect(client.getPosition).not.toHaveBeenCalled();
  });
  it('publishes locally saved progress from a previous offline session after a successful pull', async () => {
    localStorage.setItem('calibre-position-hash', '9000');
    client.getPosition.mockResolvedValue({ cfi: remote, pos_frac: 0.5, timestamp: 5 });
    renderHook(() => useCalibreProgressSync(key));
    await settle();
    act(() => {
      eventDispatcher.dispatch('sync-book-progress', { bookKey: key });
    });
    await settle();
    expect(view.goTo).not.toHaveBeenCalled();
    expect(client.setPosition).toHaveBeenCalledWith('1', 'EPUB', local, 0.1);
  });
});
