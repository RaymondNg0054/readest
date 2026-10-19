import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type { CalibreBookRecord, CalibreServer } from '@/types/calibre';
import { isTauriAppPlatform } from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { setCalibreSyncStatus } from '@/store/calibreSyncStore';
import { CalibreClient, CalibreHttpError } from './client';
import {
  calibreUploadCandidates,
  findCalibreRecord,
  isStub,
  reconcileCalibreBooks,
} from './metadata';
import { stubTranslation as _ } from '@/utils/misc';

// One snapshot cache per active connection. Credentials/settings changes replace the client.
const clients = new Map<string, { server: CalibreServer; client: CalibreClient }>();
const runs = new Map<string, Promise<void>>();
const unpersisted = new Set<string>();
// Files a server refused this session, so they are not sent again every sync.
const rejected = new Set<string>();

export const calibreErrorMessage = (error: unknown): string => {
  if (error instanceof CalibreHttpError) {
    return error.status === 401 || error.status === 403
      ? _('Calibre authentication failed. Check your credentials and permissions.')
      : _('Calibre request failed. Check the server and try again.');
  }
  return error instanceof Error ? error.message : _('Calibre sync failed.');
};

const isCurrent = (server: CalibreServer) =>
  JSON.stringify(
    useSettingsStore.getState().settings.calibreServers?.find((s) => s.id === server.id),
  ) === JSON.stringify(server);

/**
 * Sends local books the server does not list, after reconcile linked the ones it has.
 * Each result is linked at once, so a book is never sent twice.
 */
async function sendLocalBooks(
  appService: AppService,
  server: CalibreServer,
  client: CalibreClient,
  records: CalibreBookRecord[],
): Promise<number> {
  // Calibre-Web sign-in needs cookies, which browsers do not let a page set.
  if (
    server.uploadBooks === false ||
    !server.username ||
    (server.kind === 'calibre-web' && !isTauriAppPlatform())
  )
    return 0;
  const key = (book: Book) => `${server.id}/${book.hash}`;
  const books = calibreUploadCandidates(useLibraryStore.getState().library, records).filter(
    (book) => !rejected.has(key(book)),
  );
  let sent = 0;
  for (const book of books) {
    if (!isCurrent(server)) break;
    setCalibreSyncStatus(server.id, {
      running: true,
      sending: true,
      fetched: sent,
      total: books.length,
    });
    const file = await appService.loadBookContent(book).then(
      (content) => content.file,
      () => undefined,
    );
    if (!file) {
      rejected.add(key(book)); // The local file is gone.
      continue;
    }
    let result: Awaited<ReturnType<CalibreClient['addBook']>>;
    try {
      result = await client.addBook(file);
    } catch (error) {
      // The server refused this file (format, size). Other failures stop the run.
      if (error instanceof CalibreHttpError && [400, 413, 415, 422].includes(error.status)) {
        rejected.add(key(book));
        continue;
      }
      throw error;
    }
    const record =
      result.bookId || !result.title
        ? undefined
        : findCalibreRecord(records, result.title, result.authors ?? []);
    const bookId = result.bookId ?? record?.id;
    const state = useLibraryStore.getState();
    const current = state.getBookByHash(book.hash);
    if (!current || current.deletedAt) continue;
    const owner = state.library.find(
      (row) =>
        row.metadata?.calibreSource?.serverId === server.id &&
        row.metadata.calibreSource.bookId === bookId,
    );
    // Like reconcile, the local copy replaces a row that only mirrors the server.
    const stub = owner && isStub(owner) ? owner : undefined;
    const metadata = {
      ...(current.metadata ?? { title: current.title, author: current.author, language: '' }),
      ...(bookId && (!owner || stub)
        ? {
            calibreSource: {
              serverId: server.id,
              libraryId: server.libraryId,
              bookId,
              formats: record?.formats ?? [current.format],
            },
          }
        : { calibreSentTo: server.id }),
    };
    const now = Date.now();
    const library = state.library.map((row) =>
      row === stub
        ? { ...row, deletedAt: now }
        : row.hash === book.hash
          ? { ...current, metadata, metadataUpdatedAt: now }
          : row,
    );
    state.setLibrary(library);
    await appService.saveLibraryBooks(library);
    sent++;
  }
  return sent;
}

/** A failed/partial walk never reconciles removals. Rebase on live rows only after all I/O. */
export function syncCalibreServer(
  appService: AppService,
  server: CalibreServer,
  full = false,
): Promise<void> {
  const active = runs.get(server.id);
  if (active) return active;
  const run = (async () => {
    setCalibreSyncStatus(server.id, { running: true, fetched: 0 });
    try {
      let cached = clients.get(server.id);
      if (!cached || JSON.stringify(cached.server) !== JSON.stringify(server)) {
        cached = { server, client: new CalibreClient(server) };
        clients.set(server.id, cached);
      }
      const records = await cached.client.listBooks((fetched, total) => {
        setCalibreSyncStatus(server.id, { running: true, fetched, total });
      }, full);
      // A disconnected/disabled/reconfigured connection must not commit a late response.
      if (!isCurrent(server)) {
        setCalibreSyncStatus(server.id, { running: false, fetched: 0 });
        return;
      }
      const state = useLibraryStore.getState();
      if (!state.libraryLoaded) throw new Error(_('Library is not ready. Please sync again.'));
      const result = reconcileCalibreBooks(state.library, server, records, Date.now());
      // No awaits between this read/reconcile and the store commit: a concurrent download,
      // deletion, grouping edit or reader update cannot be replaced by an earlier snapshot.
      if (result.books !== state.library) {
        state.setLibrary(result.books);
        unpersisted.add(server.id);
      }
      if (unpersisted.has(server.id)) {
        await appService.saveLibraryBooks(result.books);
        unpersisted.delete(server.id);
      }
      const sent = await sendLocalBooks(appService, server, cached.client, records);
      setCalibreSyncStatus(server.id, {
        running: false,
        fetched: records.length,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        sent,
        finishedAt: Date.now(),
      });
    } catch (error) {
      // Drop caches after an incomplete run; the next retry starts with an authoritative walk.
      clients.delete(server.id);
      setCalibreSyncStatus(server.id, {
        running: false,
        fetched: 0,
        error: calibreErrorMessage(error),
      });
    }
  })().finally(() => runs.delete(server.id));
  runs.set(server.id, run);
  return run;
}
