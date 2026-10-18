import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { CatalogRemoteBook } from '@/types/catalogUpload';
import { EXTS, MIMETYPES } from '@/libs/document';

const adapter = vi.hoisted(() => ({
  upload: vi.fn(),
  listBooks: vi.fn(),
  getBookId: vi.fn(),
  getBookFile: vi.fn(),
}));
vi.mock('@/services/catalogs/adapters', () => ({
  createCatalogUploadAdapter: async () => adapter,
}));
vi.mock('@/services/opds/sourceMap', () => ({
  upsertOPDSSourceMapping: vi.fn(async () => {}),
  findBookByOPDSSources: vi.fn(async () => null),
}));
vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isTauriAppPlatform: () => true,
}));

import {
  getCatalogUploadTargets,
  canUploadBookToCatalog,
  uploadBookToCatalog,
  linkCatalogUpload,
  finishCatalogUploads,
} from '@/services/catalogs/upload';
import { catalogUploadTargetId } from '@/services/catalogs/identity';
import { useCatalogUploadStore } from '@/store/catalogUploadStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { upsertOPDSSourceMapping } from '@/services/opds/sourceMap';
import { CatalogUploadRejectedError } from '@/services/catalogs/errors';
import { calibreWebBaseUrl } from '@/services/catalogs/identity';
import { opdsCatalogOperationId } from '@/services/catalogs/identity';

const targetId = catalogUploadTargetId('calibre-web', 'https://books.test/mount', 'reader');
const book: Book = {
  hash: 'original-hash',
  format: 'EPUB',
  title: 'My book',
  author: 'Author',
  createdAt: 1,
  updatedAt: 2,
  sourceTitle: 'Original filename',
  downloadedAt: 3,
  progress: [10, 100],
  groupName: 'My group',
  metadata: { title: 'My book', author: 'Author', language: 'en' },
};
const remote: CatalogRemoteBook = {
  id: '12',
  title: 'My book',
  author: 'Author',
  formats: ['EPUB'],
  sourceUrls: ['https://books.test/mount/opds/download/12/epub/'],
};
const settings = {
  opdsCatalogs: [
    {
      id: 'opds',
      contentId: 'catalog',
      name: 'Same server',
      url: 'https://books.test/mount/opds',
      username: 'reader',
      password: 'secret',
      uploadProtocol: 'calibre-web',
    },
    { id: 'readonly', name: 'Read only', url: 'https://public.test/opds' },
  ],
} as SystemSettings;
const service = {
  exists: vi.fn(async () => true),
  openFile: vi.fn(async () => new File(['ebook'], 'book.epub')),
  loadBookConfig: vi.fn(async () => ({ updatedAt: 1, booknotes: [] })),
  saveLibraryBooks: vi.fn(async () => {}),
} as unknown as AppService;

beforeEach(() => {
  vi.clearAllMocks();
  useCatalogUploadStore.setState({ receipts: {} });
  useSettingsStore.setState({ settings });
  useLibraryStore.getState().setLibrary([structuredClone(book)]);
  adapter.upload.mockImplementation(async (_file: File, onSend: () => void) => {
    onSend();
    return {};
  });
  adapter.listBooks.mockResolvedValue([remote]);
  adapter.getBookId.mockImplementation((book: Book) => book.metadata?.catalogSource?.bookId);
  adapter.getBookFile.mockResolvedValue(new File(['another book'], 'remote.epub'));
  vi.mocked(service.loadBookConfig).mockResolvedValue({ updatedAt: 1, booknotes: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('catalog upload capabilities', () => {
  it('does not use a separate Calibre connection as an upload destination', () => {
    const legacySettings = {
      ...settings,
      opdsCatalogs: [],
      calibreServers: [
        {
          id: 'server',
          name: 'My server',
          url: 'https://books.test/mount',
          kind: 'calibre-web',
          username: 'reader',
          password: 'secret',
        },
      ],
    };
    expect(getCatalogUploadTargets(legacySettings)).toEqual([]);
  });

  it('pauses an existing read-only OPDS alias even when its username is embedded in the URL', () => {
    expect(
      opdsCatalogOperationId({ id: 'legacy', url: 'https://reader:unused@books.test/mount/opds' }),
    ).toBe(targetId);
  });
  it('preserves a reverse-proxy prefix that itself contains an opds segment', () => {
    expect(calibreWebBaseUrl('https://books.test/services/opds/cwa/opds/new')).toBe(
      'https://books.test/services/opds/cwa',
    );
  });
  it('offers only supported upload protocols and combines aliases for the same account/server', () => {
    const targets = getCatalogUploadTargets(settings);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: targetId,
      protocol: 'calibre-web',
      url: 'https://books.test/mount',
      catalogIds: ['catalog', 'opds'],
    });
    expect(
      getCatalogUploadTargets({
        ...settings,
        opdsCatalogs: [settings.opdsCatalogs[1]!],
      }),
    ).toEqual([]);
  });
  it('accepts local ebook files, never streaming audiobooks, feed books or fileless stubs', () => {
    expect(canUploadBookToCatalog(book)).toBe(true);
    expect(canUploadBookToCatalog({ ...book, downloadedAt: undefined })).toBe(false);
    expect(canUploadBookToCatalog({ ...book, format: 'ABS', filePath: 'abs://server/id' })).toBe(
      false,
    );
  });
});

describe('queued catalog uploads', () => {
  it.each([
    'EPUB',
    'PDF',
    'MOBI',
    'AZW',
    'AZW3',
    'CBZ',
    'FB2',
    'FBZ',
    'TXT',
    'MD',
    'HTML',
  ] as const)('uses the same queued upload and verified linking path for %s files', async (format) => {
    useLibraryStore.getState().setLibrary([{ ...book, format }]);
    adapter.listBooks.mockResolvedValue([{ ...remote, formats: [format] }]);
    adapter.getBookFile.mockResolvedValue(new File(['ebook'], `remote.${EXTS[format]}`));

    expect(await uploadBookToCatalog(service, book.hash, targetId)).toMatchObject({
      state: 'queued',
    });
    const sent = adapter.upload.mock.calls[0]![0] as File;
    expect(sent.name).toBe(`My book.${EXTS[format]}`);
    expect(sent.type).toBe(MIMETYPES[format][0]);
    expect(await finishCatalogUploads(service, targetId)).toBe(1);
    expect(adapter.upload).toHaveBeenCalledTimes(1);
    expect(useLibraryStore.getState().getBookByHash(book.hash)).toMatchObject({
      hash: book.hash,
      format,
      progress: book.progress,
      metadata: { catalogSource: { targetId, bookId: remote.id } },
    });
    expect(Object.values(useCatalogUploadStore.getState().receipts)).toHaveLength(0);
  });

  it('recovers uploads saved before automatic linking was available without sending them again', async () => {
    useCatalogUploadStore.getState().setReceipt({ bookHash: book.hash, targetId, state: 'queued' });
    adapter.getBookFile.mockResolvedValue(new File(['ebook'], 'remote.epub'));
    expect(await finishCatalogUploads(service, targetId)).toBe(1);
    expect(adapter.upload).not.toHaveBeenCalled();
    expect(
      useLibraryStore.getState().getBookByHash(book.hash)?.metadata?.catalogSource?.bookId,
    ).toBe(remote.id);
  });

  it('checks recently processed books even when server metadata changed their title', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    adapter.listBooks.mockResolvedValue([
      { ...remote, title: 'Server corrected the title', modified: new Date().toISOString() },
    ]);
    adapter.getBookFile.mockResolvedValue(new File(['ebook'], 'remote.epub'));
    expect(await finishCatalogUploads(service, targetId)).toBe(1);
  });

  it('does not revive a receipt forgotten while the server file was being verified', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    adapter.getBookFile.mockImplementationOnce(async () => {
      useCatalogUploadStore.getState().removeReceipt(targetId, book.hash);
      return new File(['ebook'], 'remote.epub');
    });
    expect(await finishCatalogUploads(service, targetId)).toBe(0);
    expect(
      useLibraryStore.getState().getBookByHash(book.hash)?.metadata?.catalogSource,
    ).toBeUndefined();
    expect(Object.values(useCatalogUploadStore.getState().receipts)).toHaveLength(0);
  });

  it('automatically recovers a lost response only after verifying the server content', async () => {
    adapter.upload.mockImplementationOnce(async (_file: File, onSend: () => void) => {
      onSend();
      throw new Error('Connection lost');
    });
    await expect(uploadBookToCatalog(service, book.hash, targetId)).rejects.toThrow(
      'Connection lost',
    );
    adapter.getBookFile.mockResolvedValue(new File(['ebook'], 'remote.epub'));
    expect(await finishCatalogUploads(service, targetId)).toBe(1);
    expect(adapter.upload).toHaveBeenCalledTimes(1);
  });

  it('finishes a queued upload automatically once the matching server file is available', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    adapter.getBookFile.mockResolvedValue(new File(['ebook'], 'remote.epub'));

    expect(await uploadBookToCatalog(service, book.hash, targetId)).toBeNull();
    expect(adapter.upload).toHaveBeenCalledTimes(1);
    expect(useLibraryStore.getState().getBookByHash(book.hash)).toMatchObject({
      hash: book.hash,
      progress: book.progress,
      groupName: book.groupName,
      metadata: { catalogSource: { targetId, bookId: remote.id } },
    });
    expect(Object.values(useCatalogUploadStore.getState().receipts)).toHaveLength(0);
  });

  it('does not automatically link a different book with the same title and author', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    expect(await uploadBookToCatalog(service, book.hash, targetId)).toMatchObject({
      state: 'queued',
    });
    expect(adapter.getBookFile).toHaveBeenCalled();
    expect(
      useLibraryStore.getState().getBookByHash(book.hash)?.metadata?.catalogSource,
    ).toBeUndefined();
  });

  it('keeps ambiguous identical server copies pending rather than choosing one', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    adapter.listBooks.mockResolvedValue([remote, { ...remote, id: '13' }]);
    adapter.getBookFile.mockResolvedValue(new File(['ebook'], 'remote.epub'));
    expect(await uploadBookToCatalog(service, book.hash, targetId)).toMatchObject({
      state: 'queued',
    });
    expect(adapter.getBookFile).toHaveBeenCalledTimes(2);
    expect(
      useLibraryStore.getState().getBookByHash(book.hash)?.metadata?.catalogSource,
    ).toBeUndefined();
  });

  it('keeps a concurrent deletion timestamp and its file-sync deletion authorization unchanged', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    const stub: Book = {
      ...book,
      hash: 'deleting-stub',
      downloadedAt: undefined,
      progress: undefined,
      groupName: undefined,
      metadata: {
        ...book.metadata!,
        catalogSource: { targetId, bookId: remote.id, protocol: 'calibre-web' },
      },
    };
    useLibraryStore.getState().setLibrary([book, stub]);
    vi.mocked(service.loadBookConfig).mockImplementationOnce(async () => {
      useLibraryStore
        .getState()
        .setLibrary([book, { ...stub, deletedAt: 50, fileSyncDeletionRequestedAt: 50 }]);
      return { updatedAt: 1 };
    });
    await linkCatalogUpload(service, book.hash, targetId, remote.id);
    expect(useLibraryStore.getState().getBookByHash(stub.hash)).toMatchObject({
      deletedAt: 50,
      fileSyncDeletionRequestedAt: 50,
    });
  });
  it('only replaces an empty source stub, not a second book with annotations', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    const stub: Book = {
      ...book,
      hash: 'empty-stub',
      downloadedAt: undefined,
      progress: undefined,
      groupName: undefined,
      metadata: {
        ...book.metadata!,
        catalogSource: { targetId, bookId: remote.id, protocol: 'calibre-web' },
      },
    };
    useLibraryStore.getState().setLibrary([book, stub]);
    await linkCatalogUpload(service, book.hash, targetId, remote.id);
    expect(useLibraryStore.getState().visibleLibrary).toHaveLength(1);
    expect(useLibraryStore.getState().visibleLibrary[0]?.hash).toBe(book.hash);

    useLibraryStore.getState().setLibrary([book, stub]);
    await uploadBookToCatalog(service, book.hash, targetId);
    vi.mocked(service.loadBookConfig).mockResolvedValueOnce({
      updatedAt: 1,
      booknotes: [
        {
          id: 'note',
          type: 'annotation',
          cfi: 'epubcfi(/6/2)',
          note: 'Keep me',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    await expect(linkCatalogUpload(service, book.hash, targetId, remote.id)).rejects.toThrow(
      'reading data was kept',
    );
    expect(useLibraryStore.getState().getBookByHash(stub.hash)?.deletedAt).toBeUndefined();
  });
  it('does not discard a source stub that downloads a file while linking checks its config', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    const stub: Book = {
      ...book,
      hash: 'source-stub',
      downloadedAt: undefined,
      progress: undefined,
      groupName: undefined,
      metadata: {
        ...book.metadata!,
        catalogSource: { targetId, bookId: remote.id, protocol: 'calibre-web' },
      },
    };
    useLibraryStore.getState().setLibrary([book, stub]);
    vi.mocked(service.loadBookConfig).mockImplementationOnce(async () => {
      useLibraryStore.getState().setLibrary([book, { ...stub, downloadedAt: 100 }]);
      return { updatedAt: 1 };
    });
    await expect(linkCatalogUpload(service, book.hash, targetId, remote.id)).rejects.toThrow(
      'changed while linking',
    );
    expect(useLibraryStore.getState().getBookByHash(stub.hash)).toMatchObject({
      downloadedAt: 100,
    });
    expect(useLibraryStore.getState().getBookByHash(stub.hash)?.deletedAt).toBeUndefined();
  });
  it('does not send without durable pending-state storage', async () => {
    vi.spyOn(useCatalogUploadStore.persist, 'hasHydrated').mockReturnValue(false);
    let sent = false;
    adapter.upload.mockImplementation(async (_file: File, onSend: () => void) => {
      onSend();
      sent = true;
      return {};
    });
    await expect(uploadBookToCatalog(service, book.hash, targetId)).rejects.toThrow(
      'pending upload state',
    );
    expect(sent).toBe(false);
  });
  it('allows retry after an explicit server rejection, without retaining a false queued receipt', async () => {
    adapter.upload.mockImplementation(async (_file: File, onSend: () => void) => {
      onSend();
      throw new CatalogUploadRejectedError('Permission denied');
    });
    await expect(uploadBookToCatalog(service, book.hash, targetId)).rejects.toThrow(
      'Permission denied',
    );
    expect(Object.keys(useCatalogUploadStore.getState().receipts)).toHaveLength(0);
  });
  it('persists a receipt before sending, reports CWA ingestion as queued, and does not resend on retry', async () => {
    adapter.upload.mockImplementation(async (_file: File, onSend: () => void) => {
      onSend();
      expect(Object.values(useCatalogUploadStore.getState().receipts)[0]?.state).toBe('sending');
      return {};
    });
    expect(await uploadBookToCatalog(service, book.hash, targetId)).toMatchObject({
      state: 'queued',
    });
    await uploadBookToCatalog(service, book.hash, targetId);
    expect(adapter.upload).toHaveBeenCalledTimes(1);
    expect(useLibraryStore.getState().library[0]?.uploadedAt).toBeUndefined();
  });
  it('links the confirmed server ID without changing the local hash, file, progress, groups or note keys', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    await linkCatalogUpload(service, book.hash, targetId, remote.id);
    const linked = useLibraryStore.getState().library[0]!;
    expect(linked).toMatchObject({
      hash: book.hash,
      sourceTitle: book.sourceTitle,
      format: 'EPUB',
      downloadedAt: 3,
      progress: [10, 100],
      groupName: 'My group',
      metadata: { catalogSource: { targetId, bookId: '12', protocol: 'calibre-web' } },
    });
    expect(upsertOPDSSourceMapping).toHaveBeenCalledWith(service, {
      catalogId: 'catalog',
      sourceUrl: remote.sourceUrls[0],
      bookHash: book.hash,
    });
    expect(Object.values(useCatalogUploadStore.getState().receipts)).toHaveLength(0);
  });
  it('does not turn an unprocessed queue response into a guessed title-based link', async () => {
    await uploadBookToCatalog(service, book.hash, targetId);
    adapter.listBooks.mockResolvedValue([]);
    await expect(linkCatalogUpload(service, book.hash, targetId, '12')).rejects.toThrow();
    expect(useLibraryStore.getState().library[0]?.metadata?.catalogSource).toBeUndefined();
  });
  it('keeps an uncertain upload pending rather than posting it again after a lost response', async () => {
    adapter.upload.mockImplementation(async (_file: File, onSend: () => void) => {
      onSend();
      throw new Error('Connection lost');
    });
    await expect(uploadBookToCatalog(service, book.hash, targetId)).rejects.toThrow(
      'Connection lost',
    );
    await uploadBookToCatalog(service, book.hash, targetId);
    expect(adapter.upload).toHaveBeenCalledTimes(1);
    expect(Object.values(useCatalogUploadStore.getState().receipts)[0]?.state).toBe('sending');
  });
  it('links an immediate upload result automatically and preserves a concurrent local deletion', async () => {
    adapter.upload.mockImplementation(async (_file: File, onSend: () => void) => {
      onSend();
      useLibraryStore.getState().setLibrary([{ ...book, deletedAt: 10, progress: [20, 100] }]);
      return { bookId: '12' };
    });
    await uploadBookToCatalog(service, book.hash, targetId);
    expect(useLibraryStore.getState().library[0]).toMatchObject({
      deletedAt: 10,
      progress: [20, 100],
      metadata: { catalogSource: { bookId: '12' } },
    });
  });
});
