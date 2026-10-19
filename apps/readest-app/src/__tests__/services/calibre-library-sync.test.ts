import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalibreClient } from '@/services/calibre/client';
import { syncCalibreServer } from '@/services/calibre/librarySync';
import { reconcileCalibreBooks } from '@/services/calibre/metadata';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useCalibreSyncStore } from '@/store/calibreSyncStore';
import type { Book } from '@/types/book';
import type { CalibreBookRecord, CalibreServer } from '@/types/calibre';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';

const server: CalibreServer = {
  id: 'sync',
  name: 'Test',
  url: 'https://books.test',
  kind: 'calibre',
  libraryId: 'Library',
  enabled: true,
  syncProgress: false,
};
const record: CalibreBookRecord = {
  id: '1',
  title: 'Book',
  authors: ['Author'],
  formats: ['EPUB'],
  tags: [],
};
const saveLibraryBooks = vi.fn();
const service = { saveLibraryBooks } as unknown as AppService;
beforeEach(() => {
  useSettingsStore.setState({ settings: { calibreServers: [server] } as SystemSettings });
  useLibraryStore.getState().setLibrary(reconcileCalibreBooks([], server, [record], 100).books);
  useCalibreSyncStore.setState({ byServer: {} });
  saveLibraryBooks.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('Calibre sync commit boundaries', () => {
  it('rebases metadata on current downloads, deletions and progress after network I/O', async () => {
    let complete: (records: CalibreBookRecord[]) => void = () => {};
    vi.spyOn(CalibreClient.prototype, 'listBooks').mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const run = syncCalibreServer(service, server);
    const old = useLibraryStore.getState().library[0]!;
    useLibraryStore.getState().setLibrary([
      {
        ...old,
        downloadedAt: 200,
        format: 'PDF',
        progress: [30, 100],
        groupName: 'Mine',
        deletedAt: 300,
      },
    ]);
    complete([{ ...record, title: 'Changed' }]);
    await run;
    expect(useLibraryStore.getState().library[0]).toMatchObject({
      title: 'Book',
      downloadedAt: 200,
      format: 'PDF',
      progress: [30, 100],
      groupName: 'Mine',
      deletedAt: 300,
    });
    expect(saveLibraryBooks).not.toHaveBeenCalled();
  });
  it('does not commit or report removals after failure or disconnect', async () => {
    const list = vi
      .spyOn(CalibreClient.prototype, 'listBooks')
      .mockRejectedValue(new Error('Incomplete catalog'));
    await syncCalibreServer(service, server);
    expect(useLibraryStore.getState().library[0]?.metadata?.calibreSource?.missing).toBeUndefined();
    expect(useCalibreSyncStore.getState().byServer['sync']?.error).toBe('Incomplete catalog');
    list.mockImplementation(async () => {
      useSettingsStore.setState({ settings: { calibreServers: [] } as unknown as SystemSettings });
      return [];
    });
    await syncCalibreServer(service, server);
    expect(saveLibraryBooks).not.toHaveBeenCalled();
    expect(useLibraryStore.getState().library[0]?.metadata?.calibreSource?.missing).toBeUndefined();
  });
  it('shares a single in-flight run and skips writes for unchanged catalogs', async () => {
    const list = vi.spyOn(CalibreClient.prototype, 'listBooks').mockResolvedValue([record]);
    await Promise.all([syncCalibreServer(service, server), syncCalibreServer(service, server)]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(saveLibraryBooks).not.toHaveBeenCalled();
  });
  describe('sending local books', () => {
    const writer = { ...server, username: 'reader' };
    const local = (hash: string, title: string): Book => ({
      hash,
      format: 'EPUB',
      title,
      author: 'Writer',
      createdAt: 1,
      updatedAt: 1,
      downloadedAt: 1,
    });
    beforeEach(() => {
      useSettingsStore.setState({ settings: { calibreServers: [writer] } as SystemSettings });
      useLibraryStore
        .getState()
        .setLibrary([
          ...useLibraryStore.getState().library,
          local('new', 'New'),
          local('dup', 'Book'),
        ]);
      service.loadBookContent = vi.fn(async (book: Book) => ({
        book,
        file: new File(['epub'], `${book.title}.epub`),
      }));
    });

    it('sends books the server lacks, links the new server id and skips books it has', async () => {
      vi.spyOn(CalibreClient.prototype, 'listBooks').mockResolvedValue([
        { ...record, authors: ['Writer'] },
      ]);
      const add = vi.spyOn(CalibreClient.prototype, 'addBook').mockResolvedValue({ bookId: '7' });
      await syncCalibreServer(service, writer);
      expect(add).toHaveBeenCalledTimes(1);
      const library = useLibraryStore.getState().library;
      expect(library.find((book) => book.hash === 'new')?.metadata?.calibreSource).toMatchObject({
        serverId: 'sync',
        bookId: '7',
        formats: ['EPUB'],
      });
      expect(library.find((book) => book.hash === 'dup')?.metadata?.calibreSource?.bookId).toBe(
        '1',
      );
      expect(saveLibraryBooks).toHaveBeenCalled();
      expect(useCalibreSyncStore.getState().byServer['sync']?.sent).toBe(1);
    });

    it('marks a queued upload so it is sent once and linked when the server lists it', async () => {
      const list = vi.spyOn(CalibreClient.prototype, 'listBooks').mockResolvedValue([record]);
      const add = vi.spyOn(CalibreClient.prototype, 'addBook').mockResolvedValue({});
      await syncCalibreServer(service, writer);
      await syncCalibreServer(service, writer);
      expect(add).toHaveBeenCalledTimes(2);
      expect(add.mock.calls.map(([file]) => file.name)).toEqual(['New.epub', 'Book.epub']);
      list.mockResolvedValue([record, { ...record, id: '2', title: 'New', authors: ['Writer'] }]);
      await syncCalibreServer(service, writer);
      expect(add).toHaveBeenCalledTimes(2);
      const sent = useLibraryStore.getState().library.find((book) => book.hash === 'new');
      expect(sent?.metadata?.calibreSource?.bookId).toBe('2');
      expect(sent?.metadata?.calibreSentTo).toBeUndefined();
    });

    it('links a duplicate Calibre refused to the book it already has', async () => {
      vi.spyOn(CalibreClient.prototype, 'listBooks').mockResolvedValue([
        { ...record, id: '5', title: 'Novel', authors: ['Someone'] },
      ]);
      vi.spyOn(CalibreClient.prototype, 'addBook').mockResolvedValue({
        title: 'Novel',
        authors: ['Someone'],
      });
      await syncCalibreServer(service, writer);
      const linked = useLibraryStore.getState().library.find((book) => book.hash === 'new');
      expect(linked?.metadata?.calibreSource?.bookId).toBe('5');
    });

    it('sends nothing when turned off, without credentials, or to Calibre-Web in a browser', async () => {
      vi.spyOn(CalibreClient.prototype, 'listBooks').mockResolvedValue([record]);
      const add = vi.spyOn(CalibreClient.prototype, 'addBook').mockResolvedValue({ bookId: '7' });
      for (const target of [
        { ...writer, uploadBooks: false },
        server,
        { ...writer, kind: 'calibre-web' as const },
      ]) {
        useSettingsStore.setState({ settings: { calibreServers: [target] } as SystemSettings });
        await syncCalibreServer(service, target);
      }
      expect(add).not.toHaveBeenCalled();
    });
  });

  it('retries a failed persistence write even when the next catalog is unchanged', async () => {
    vi.spyOn(CalibreClient.prototype, 'listBooks').mockResolvedValue([
      { ...record, title: 'New title' },
    ]);
    saveLibraryBooks.mockRejectedValueOnce(new Error('Disk unavailable'));
    await syncCalibreServer(service, server);
    expect(useCalibreSyncStore.getState().byServer['sync']?.error).toBe('Disk unavailable');
    await syncCalibreServer(service, server);
    expect(saveLibraryBooks).toHaveBeenCalledTimes(2);
    expect(useCalibreSyncStore.getState().byServer['sync']?.error).toBeUndefined();
  });
});
