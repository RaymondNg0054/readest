import type { AppService } from '@/types/system';
import type { CalibreServer } from '@/types/calibre';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { setCalibreSyncStatus } from '@/store/calibreSyncStore';
import { CalibreClient, CalibreHttpError } from './client';
import { reconcileCalibreBooks } from './metadata';
import { stubTranslation as _ } from '@/utils/misc';

// One snapshot cache per active connection. Credentials/settings changes replace the client.
const clients = new Map<string, { server: CalibreServer; client: CalibreClient }>();
const runs = new Map<string, Promise<void>>();
const unpersisted = new Set<string>();

export const calibreErrorMessage = (error: unknown): string => {
  if (error instanceof CalibreHttpError) {
    return error.status === 401 || error.status === 403
      ? _('Calibre authentication failed. Check your credentials and permissions.')
      : _('Calibre request failed. Check the server and try again.');
  }
  return error instanceof Error ? error.message : _('Calibre sync failed.');
};

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
      const current = useSettingsStore
        .getState()
        .settings.calibreServers?.find((s) => s.id === server.id);
      if (JSON.stringify(current) !== JSON.stringify(server)) {
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
      setCalibreSyncStatus(server.id, {
        running: false,
        fetched: records.length,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
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
