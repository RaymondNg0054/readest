import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useCatalogUploadStore } from '@/store/catalogUploadStore';
import { catalogUploadTargetId } from '@/services/catalogs/identity';

const mocks = vi.hoisted(() => ({
  native: true,
  mainWindow: true,
  upload: vi.fn(),
  finish: vi.fn(),
  select: vi.fn(async () => [] as { book_hash: string }[]),
  close: vi.fn(async () => {}),
  toast: vi.fn(),
}));
const appService = {
  openDatabase: vi.fn(async () => ({ select: mocks.select, close: mocks.close })),
};
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService }) }));
const translate = (key: string) => key;
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => translate }));
vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isTauriAppPlatform: () => mocks.native,
}));
vi.mock('@/services/catalogs/upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/catalogs/upload')>()),
  uploadBookToCatalog: mocks.upload,
  finishCatalogUploads: mocks.finish,
}));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: mocks.toast } }));
vi.mock('@/utils/window', () => ({ isMainAppWindow: () => mocks.mainWindow }));

import { useCatalogAutoUpload } from '@/hooks/useCatalogAutoUpload';

const targetId = catalogUploadTargetId('calibre-web', 'https://books.test', 'reader');
const book: Book = {
  hash: 'local',
  title: 'Local book',
  author: 'Author',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 1,
  downloadedAt: 1,
};
const settings = {
  opdsCatalogs: [
    {
      id: 'server',
      name: 'Calibre-Web',
      url: 'https://books.test/opds',
      username: 'reader',
      uploadProtocol: 'calibre-web',
    },
  ],
} as unknown as SystemSettings;

const advance = async (ms = 1000) => {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.native = true;
  mocks.mainWindow = true;
  mocks.finish.mockResolvedValue(0);
  mocks.select.mockResolvedValue([]);
  mocks.upload.mockImplementation(async (_app, hash: string, id: string) => {
    useCatalogUploadStore.getState().setReceipt({ bookHash: hash, targetId: id, state: 'queued' });
    return { bookHash: hash, targetId: id, state: 'queued' };
  });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  useCatalogUploadStore.setState({ receipts: {} });
  useSettingsStore.setState({ settings: structuredClone(settings) });
  useLibraryStore.getState().setLibrary([structuredClone(book)]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('automatic catalog uploads', () => {
  it('keeps verification on its retry timer instead of rechecking on every page turn', async () => {
    useCatalogUploadStore.getState().setReceipt({ bookHash: book.hash, targetId, state: 'queued' });
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.finish).toHaveBeenCalledTimes(1);
    act(() => useLibraryStore.getState().updateBookProgress(book.hash, [2, 100], undefined));
    await advance();
    expect(mocks.finish).toHaveBeenCalledTimes(1);
    await advance(4000);
    expect(mocks.finish).toHaveBeenCalledTimes(2);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('does not start another upload worker in a secondary reader window', async () => {
    mocks.mainWindow = false;
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('checks a manually queued upload promptly after the initial library check has finished', async () => {
    useLibraryStore.getState().setLibrary([{ ...book, downloadedAt: undefined }]);
    renderHook(() => useCatalogAutoUpload());
    await advance();
    mocks.finish.mockClear();

    act(() =>
      useCatalogUploadStore
        .getState()
        .setReceipt({ bookHash: book.hash, targetId, state: 'queued' }),
    );
    await advance();

    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(appService, targetId);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('does not process uploads for a disabled OPDS catalog', async () => {
    useSettingsStore.setState({
      settings: {
        ...settings,
        opdsCatalogs: [{ ...settings.opdsCatalogs[0]!, disabled: true }],
      },
    });
    useCatalogUploadStore.getState().setReceipt({ bookHash: book.hash, targetId, state: 'queued' });
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('checks pending uploads in the background without opening Finish catalog upload', async () => {
    useCatalogUploadStore.getState().setReceipt({ bookHash: book.hash, targetId, state: 'queued' });
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.finish).toHaveBeenCalledWith(appService, targetId);
    await advance(5000);
    expect(mocks.finish).toHaveBeenCalledTimes(2);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('sends existing local books without selecting them or signing in to Readest Cloud', async () => {
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).toHaveBeenCalledExactlyOnceWith(appService, book.hash, targetId);
  });

  it('sends newly imported and newly downloaded books', async () => {
    useLibraryStore.getState().setLibrary([{ ...book, downloadedAt: undefined }]);
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
    act(() => useLibraryStore.getState().setLibrary([book, { ...book, hash: 'imported' }]));
    await advance();
    expect(mocks.upload.mock.calls.map((call) => call[1])).toEqual(['local', 'imported']);
  });

  it('uses upload-enabled OPDS targets and deduplicates Calibre-Web aliases', async () => {
    useSettingsStore.setState({
      settings: {
        ...settings,
        opdsCatalogs: [
          {
            id: 'opds',
            name: 'CWA',
            url: 'https://books.test/opds',
            username: 'reader',
            uploadProtocol: 'calibre-web',
          },
          {
            ...settings.opdsCatalogs[0]!,
            id: 'alias',
            url: 'https://books.test/opds/new',
          },
        ],
      },
    });
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.select).toHaveBeenCalledWith(expect.any(String), ['opds', 'alias']);
    expect(mocks.close).toHaveBeenCalled();
  });

  it('does not send books downloaded from the destination OPDS catalog back to it', async () => {
    useSettingsStore.setState({
      settings: {
        ...settings,
        opdsCatalogs: [
          {
            id: 'opds',
            name: 'CWA',
            url: 'https://books.test/opds',
            username: 'reader',
            uploadProtocol: 'calibre-web',
          },
        ],
      },
    });
    mocks.select.mockResolvedValue([{ book_hash: book.hash }]);
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('does not upload when the OPDS source map cannot be read', async () => {
    useSettingsStore.setState({
      settings: {
        ...settings,
        opdsCatalogs: [{ ...settings.opdsCatalogs[0]!, id: 'opds' }],
      },
    });
    mocks.select.mockRejectedValue(new Error('Database unavailable'));
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalled();
  });

  it('waits for durable pending upload storage', async () => {
    vi.spyOn(useCatalogUploadStore.persist, 'hasHydrated').mockReturnValue(false);
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('skips deleted, fileless, streaming, linked and pending books', async () => {
    useCatalogUploadStore
      .getState()
      .setReceipt({ bookHash: 'pending', targetId, state: 'sending' });
    useLibraryStore.getState().setLibrary([
      { ...book, deletedAt: 1 },
      { ...book, hash: 'stub', downloadedAt: undefined },
      { ...book, hash: 'audio', format: 'ABS' },
      { ...book, hash: 'pending' },
      {
        ...book,
        hash: 'linked',
        metadata: {
          title: book.title,
          author: book.author,
          language: 'en',
          catalogSource: { targetId, bookId: '12', protocol: 'calibre-web' },
        },
      },
    ]);
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('honors the OPDS upload protocol and starts when uploads are enabled', async () => {
    const disabled = { ...settings.opdsCatalogs[0]!, uploadProtocol: 'none' as const };
    useSettingsStore.setState({ settings: { ...settings, opdsCatalogs: [disabled] } });
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
    act(() => useSettingsStore.setState({ settings }));
    await advance();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('does not upload from the browser or before the library is loaded', async () => {
    mocks.native = false;
    const { unmount } = renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
    unmount();
    mocks.native = true;
    useLibraryStore.setState({ libraryLoaded: false });
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
    act(() => useLibraryStore.setState({ libraryLoaded: true }));
    await advance();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('waits while offline or hidden and resumes on returning to the library', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await advance();
    expect(mocks.upload).not.toHaveBeenCalled();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await advance();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('does not resend queued uploads on subsequent library updates or periodic checks', async () => {
    renderHook(() => useCatalogAutoUpload());
    await advance();
    act(() => useLibraryStore.getState().setLibrary([{ ...book, progress: [1, 10] }]));
    await advance(5 * 60_000);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('reports failures and waits before retrying instead of looping on library updates', async () => {
    mocks.upload.mockRejectedValue(new Error('Permission denied'));
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.toast).toHaveBeenCalledWith('toast', expect.objectContaining({ type: 'error' }));
    act(() => useLibraryStore.getState().setLibrary([{ ...book, progress: [1, 10] }]));
    await advance();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    await advance(5 * 60_000);
    expect(mocks.upload).toHaveBeenCalledTimes(2);
  });

  it('stops sending if the destination is disabled during an upload', async () => {
    useLibraryStore.getState().setLibrary([book, { ...book, hash: 'next' }]);
    mocks.upload.mockImplementationOnce(async () => {
      useSettingsStore.setState({ settings: { ...settings, opdsCatalogs: [] } });
    });
    renderHook(() => useCatalogAutoUpload());
    await advance();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('serializes sends and rechecks deletion after an in-flight upload', async () => {
    useLibraryStore.getState().setLibrary([book, { ...book, hash: 'next' }]);
    let finish: () => void = () => {};
    mocks.upload.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderHook(() => useCatalogAutoUpload());
    await advance();
    act(() =>
      useLibraryStore.getState().setLibrary([book, { ...book, hash: 'next', deletedAt: 1 }]),
    );
    await advance();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('cancels scheduled uploads on unmount', async () => {
    const { unmount } = renderHook(() => useCatalogAutoUpload());
    unmount();
    await advance(5 * 60_000);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
