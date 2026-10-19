import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { syncCalibreServer } from '@/services/calibre/librarySync';

export function useCalibreSync() {
  const { appService } = useEnv();
  const servers = useSettingsStore((s) => s.settings.calibreServers);
  const ready = useLibraryStore((s) => s.libraryLoaded);
  // A new local book is sent to Calibre right away instead of on the next check.
  const localBooks = useLibraryStore(
    (s) => s.library.filter((book) => !book.deletedAt && !book.metadata?.calibreSource).length,
  );
  useEffect(() => {
    if (!appService || !ready) return;
    const check = async () => {
      if (document.hidden || !navigator.onLine) return;
      for (const server of useSettingsStore.getState().settings.calibreServers ?? []) {
        if (server.enabled) await syncCalibreServer(appService, server);
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5 * 60_000);
    return () => clearInterval(timer);
  }, [appService, ready, servers, localBooks]);
}
