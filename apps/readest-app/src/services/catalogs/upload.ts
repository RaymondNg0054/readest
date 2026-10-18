import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { AppService } from '@/types/system';
import type { CatalogUploadTarget, CatalogUploadReceipt } from '@/types/catalogUpload';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { catalogUploadReceiptKey, useCatalogUploadStore } from '@/store/catalogUploadStore';
import { isTauriAppPlatform } from '@/services/environment';
import { findBookByOPDSSources, upsertOPDSSourceMapping } from '@/services/opds/sourceMap';
import { EXTS, MIMETYPES } from '@/libs/document';
import { getLocalBookFilename } from '@/utils/book';
import { isFeedBook } from '@/services/rss/feedBookUrl';
import { makeSafeFilename, stubTranslation as _ } from '@/utils/misc';
import { createCatalogUploadAdapter } from './adapters';
import { calibreWebBaseUrl, catalogUploadTargetId, opdsCatalogOperationId } from './identity';
import { withCatalogOperation } from './operationQueue';
import { CatalogUploadRejectedError } from './errors';
import {
  catalogFingerprintsMatch,
  fingerprintCatalogFile,
  normalizeCatalogTitle,
} from './fingerprint';
import { CalibreWebHttpError } from './calibreWebClient';

export function getCatalogUploadTargets(settings: SystemSettings): CatalogUploadTarget[] {
  const targets = new Map<string, CatalogUploadTarget>();
  const add = (input: Omit<CatalogUploadTarget, 'id'>) => {
    try {
      const id = catalogUploadTargetId(input.protocol, input.url, input.username);
      const old = targets.get(id);
      targets.set(
        id,
        old
          ? { ...old, catalogIds: [...new Set([...old.catalogIds, ...input.catalogIds])] }
          : { ...input, id },
      );
    } catch {
      /* A restored invalid catalog must not break the library menu. */
    }
  };
  for (const catalog of settings.opdsCatalogs ?? []) {
    if (catalog.disabled || catalog.deletedAt || catalog.uploadProtocol !== 'calibre-web') continue;
    try {
      add({
        protocol: catalog.uploadProtocol,
        name: catalog.name,
        url: calibreWebBaseUrl(catalog.url),
        username: catalog.username,
        password: catalog.password,
        customHeaders: catalog.customHeaders,
        catalogIds: [
          ...new Set([catalog.contentId, catalog.id].filter((id): id is string => !!id)),
        ],
      });
    } catch {
      /* Invalid imported URLs are not upload targets. */
    }
  }
  for (const catalog of settings.opdsCatalogs ?? []) {
    if (catalog.disabled || catalog.deletedAt) continue;
    try {
      const target = targets.get(opdsCatalogOperationId(catalog));
      if (target)
        target.catalogIds = [
          ...new Set(
            [...target.catalogIds, catalog.contentId, catalog.id].filter(
              (id): id is string => !!id,
            ),
          ),
        ];
    } catch {}
  }
  return Array.from(targets.values());
}

export const canUploadBookToCatalog = (book: Book): boolean =>
  !book.deletedAt &&
  !!(book.downloadedAt || book.filePath) &&
  !isFeedBook(book) &&
  !['ABS', 'OPDSAUDIO', 'BOOKORBIT'].includes(book.format);

const targetById = (targetId: string) => {
  const target = getCatalogUploadTargets(useSettingsStore.getState().settings).find(
    (target) => target.id === targetId,
  );
  if (!target) throw new Error(_('This upload catalog is no longer configured.'));
  return target;
};

export const listCatalogUploadBooks = async (targetId: string) =>
  (await createCatalogUploadAdapter(targetById(targetId))).listBooks();

async function openLocalBookFile(appService: AppService, book: Book): Promise<File | null> {
  const managed = getLocalBookFilename(book);
  return (await appService.exists(managed, 'Books'))
    ? appService.openFile(managed, 'Books')
    : book.filePath
      ? appService.openFile(book.filePath, 'None')
      : null;
}

async function finishUpload(
  appService: AppService,
  bookHash: string,
  targetId: string,
): Promise<boolean> {
  const key = catalogUploadReceiptKey(targetId, bookHash);
  let receipt = useCatalogUploadStore.getState().receipts[key];
  if (!receipt) return false;
  const book = useLibraryStore.getState().getBookByHash(bookHash);
  if (!book) return false;
  if (receipt.bookId) {
    await linkBook(appService, bookHash, targetId, receipt.bookId);
    return true;
  }
  let fingerprint = receipt.fingerprint;
  if (!fingerprint) {
    const file = await openLocalBookFile(appService, book);
    if (!file) return false;
    try {
      if (!file.size) return false;
      fingerprint = await fingerprintCatalogFile(file);
    } finally {
      await (file as File & { close?: () => Promise<void> }).close?.();
    }
    if (useCatalogUploadStore.getState().receipts[key] !== receipt) return false;
    receipt = { ...receipt, fingerprint };
    useCatalogUploadStore.getState().setReceipt(receipt);
  }
  const adapter = await createCatalogUploadAdapter(targetById(targetId));
  const titles = new Set(
    [book.title, book.sourceTitle, fingerprint.title]
      .filter((title): title is string => !!title)
      .map(normalizeCatalogTitle),
  );
  const matches: string[] = [];
  for (const remote of await adapter.listBooks()) {
    const recentlyModified =
      receipt.startedAt && Date.parse(remote.modified ?? '') >= receipt.startedAt - 5 * 60_000;
    if (!titles.has(normalizeCatalogTitle(remote.title)) && !recentlyModified) continue;
    const formats = [...new Set([book.format, ...remote.formats])].filter((format) =>
      remote.formats.includes(format),
    );
    for (const format of formats) {
      try {
        const file = await adapter.getBookFile(remote.id, format);
        if (catalogFingerprintsMatch(fingerprint, await fingerprintCatalogFile(file))) {
          matches.push(remote.id);
          break;
        }
      } catch (error) {
        if (!(error instanceof CalibreWebHttpError && error.status === 404)) throw error;
      }
    }
    if (matches.length > 1) return false;
  }
  const bookId = matches[0];
  const current = useCatalogUploadStore.getState().receipts[key];
  if (!bookId || current !== receipt || (current.bookId && current.bookId !== bookId)) return false;
  useCatalogUploadStore.getState().setReceipt({ ...current, state: 'uploaded', bookId });
  await linkBook(appService, bookHash, targetId, bookId);
  return true;
}

export async function finishCatalogUploads(
  appService: AppService,
  targetId: string,
): Promise<number> {
  if (!isTauriAppPlatform() || !useCatalogUploadStore.persist.hasHydrated()) return 0;
  let finished = 0;
  for (const receipt of Object.values(useCatalogUploadStore.getState().receipts)) {
    if (receipt.targetId !== targetId) continue;
    if (
      await withCatalogOperation(`book:${receipt.bookHash}`, () =>
        withCatalogOperation(targetId, () => finishUpload(appService, receipt.bookHash, targetId)),
      )
    )
      finished++;
  }
  return finished;
}

async function linkBook(
  appService: AppService,
  bookHash: string,
  targetId: string,
  bookId: string,
): Promise<void> {
  const key = catalogUploadReceiptKey(targetId, bookHash);
  const expectedReceipt = useCatalogUploadStore.getState().receipts[key];
  if (!expectedReceipt) throw new Error(_('No pending catalog upload was found for this book.'));
  const target = targetById(targetId);
  const adapter = await createCatalogUploadAdapter(target);
  const remote = (await adapter.listBooks()).find((book) => book.id === bookId);
  if (!remote)
    throw new Error(_('The book is not in the catalog yet. Wait for ingestion, then refresh.'));
  const receipt = useCatalogUploadStore.getState().receipts[key];
  if (receipt !== expectedReceipt)
    throw new Error(_('The pending catalog upload changed. Please try again.'));
  if (receipt?.bookId && receipt.bookId !== bookId)
    throw new Error(_('The server identified a different book for this upload.'));

  const duplicates = new Set<string>();
  for (const book of useLibraryStore.getState().library) {
    if (book.hash !== bookHash && !book.deletedAt && adapter.getBookId(book) === bookId)
      duplicates.add(book.hash);
  }
  for (const catalogId of target.catalogIds) {
    const owner = await findBookByOPDSSources(appService, {
      catalogId,
      sourceUrls: remote.sourceUrls,
      library: useLibraryStore.getState().library,
    });
    if (owner && owner.hash !== bookHash) duplicates.add(owner.hash);
  }
  const emptyStubs = new Map<string, Book>();
  for (const hash of duplicates) {
    const other = useLibraryStore.getState().getBookByHash(hash);
    if (!other || other.deletedAt) continue;
    if (
      other.downloadedAt ||
      other.filePath ||
      other.uploadedAt ||
      other.progress ||
      other.groupName ||
      other.groupId ||
      other.group ||
      other.groupUpdatedAt ||
      other.readingStatus
    ) {
      throw new Error(
        _(
          'This catalog book is already linked to another Readest book. Its reading data was kept.',
        ),
      );
    }
    const config = await appService.loadBookConfig(other, useSettingsStore.getState().settings);
    if (config.location || config.booknotes?.length)
      throw new Error(
        _(
          'This catalog book is already linked to another Readest book. Its reading data was kept.',
        ),
      );
    emptyStubs.set(hash, other);
  }

  targetById(targetId);
  const state = useLibraryStore.getState();
  const current = state.getBookByHash(bookHash);
  if (!current)
    throw new Error(_('The book was removed locally. Its server copy has not been deleted.'));
  if (current.metadata?.catalogSource && current.metadata.catalogSource.targetId !== targetId)
    throw new Error(_('This book is already linked to a different catalog.'));
  const currentId = adapter.getBookId(current);
  if (currentId && currentId !== bookId)
    throw new Error(
      _(
        'This Readest entry was linked to another catalog book while uploading. Its data was kept.',
      ),
    );
  for (const [hash, previous] of emptyStubs) {
    const live = state.getBookByHash(hash);
    if (
      live &&
      !live.deletedAt &&
      (live !== previous ||
        live.downloadedAt ||
        live.filePath ||
        live.uploadedAt ||
        live.progress ||
        live.groupName ||
        live.groupId ||
        live.group ||
        live.groupUpdatedAt ||
        live.readingStatus)
    )
      throw new Error(
        _('The other Readest entry changed while linking. Its data was kept; please try again.'),
      );
  }
  const now = Date.now();
  const updated: Book = {
    ...current,
    metadataUpdatedAt: now,
    metadata: {
      title: current.title,
      author: current.author,
      language: current.primaryLanguage ?? '',
      ...current.metadata,
      catalogSource: { targetId, bookId, protocol: target.protocol },
    },
  };
  // Only discard empty source stubs; downloaded copies and reading data never lose ownership.
  const library = state.library.map((book) =>
    book.hash === bookHash
      ? updated
      : duplicates.has(book.hash) && !book.deletedAt
        ? { ...book, deletedAt: now, updatedAt: now }
        : book,
  );
  state.setLibrary(library);
  await appService.saveLibraryBooks(library);
  for (const catalogId of target.catalogIds) {
    for (const sourceUrl of remote.sourceUrls)
      await upsertOPDSSourceMapping(appService, { catalogId, sourceUrl, bookHash });
  }
  useCatalogUploadStore.getState().removeReceipt(targetId, bookHash);
}

export async function uploadBookToCatalog(
  appService: AppService,
  bookHash: string,
  targetId: string,
): Promise<CatalogUploadReceipt | null> {
  return withCatalogOperation(`book:${bookHash}`, () =>
    withCatalogOperation(targetId, async () => {
      if (!isTauriAppPlatform())
        throw new Error(_('Catalog uploads require the desktop or mobile app.'));
      const previous =
        useCatalogUploadStore.getState().receipts[catalogUploadReceiptKey(targetId, bookHash)];
      if (previous) {
        await finishUpload(appService, bookHash, targetId);
        return (
          useCatalogUploadStore.getState().receipts[catalogUploadReceiptKey(targetId, bookHash)] ??
          null
        );
      }
      if (
        Object.values(useCatalogUploadStore.getState().receipts).some(
          (receipt) => receipt.bookHash === bookHash,
        )
      )
        throw new Error(_('A catalog upload is already pending for this book.'));
      const target = targetById(targetId);
      const book = useLibraryStore.getState().getBookByHash(bookHash);
      if (!book || !canUploadBookToCatalog(book))
        throw new Error(_('Download this book to the device before uploading it to a catalog.'));
      const adapter = await createCatalogUploadAdapter(target);
      if (adapter.getBookId(book)) return null;
      if (book.metadata?.catalogSource)
        throw new Error(_('This book is already linked to a catalog.'));
      const file = await openLocalBookFile(appService, book);
      if (!file) throw new Error(_('The local book file is missing. No upload was sent.'));
      try {
        const bytes = await file.arrayBuffer();
        if (!bytes.byteLength)
          throw new Error(_('The local book file is empty. No upload was sent.'));
        const upload = new File([bytes], `${makeSafeFilename(book.title)}.${EXTS[book.format]}`, {
          type: MIMETYPES[book.format][0] ?? 'application/octet-stream',
        });
        const fingerprint = await fingerprintCatalogFile(upload);
        const startedAt = Date.now();
        const result = await adapter.upload(upload, () => {
          // Save before the non-idempotent POST: a lost response must not trigger a duplicate upload.
          if (!useCatalogUploadStore.persist?.hasHydrated())
            throw new Error(
              _('Cannot save pending upload state on this device. No file was sent.'),
            );
          useCatalogUploadStore
            .getState()
            .setReceipt({ bookHash, targetId, state: 'sending', fingerprint, startedAt });
        });
        const receipt: CatalogUploadReceipt = {
          bookHash,
          targetId,
          state: result.bookId ? 'uploaded' : 'queued',
          bookId: result.bookId,
          fingerprint,
          startedAt,
        };
        useCatalogUploadStore.getState().setReceipt(receipt);
        if (result.bookId) {
          await linkBook(appService, bookHash, targetId, result.bookId);
          return null;
        }
        return receipt;
      } catch (error) {
        if (error instanceof CatalogUploadRejectedError)
          useCatalogUploadStore.getState().removeReceipt(targetId, bookHash);
        throw error;
      } finally {
        await (file as File & { close?: () => Promise<void> }).close?.();
      }
    }),
  );
}

export function linkCatalogUpload(
  appService: AppService,
  bookHash: string,
  targetId: string,
  bookId: string,
): Promise<void> {
  return withCatalogOperation(`book:${bookHash}`, () =>
    withCatalogOperation(targetId, () => linkBook(appService, bookHash, targetId, bookId)),
  );
}
