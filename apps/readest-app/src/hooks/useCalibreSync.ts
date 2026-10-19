import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { syncCalibreServer } from '@/services/calibre/librarySync';

export function useCalibreSync() {
  const { appService } = useEnv();
  const servers = useSettingsStore((s) => s.settings.calibreServers);
  const ready = useLibraryStore((s) => s.libraryLoaded);
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
  }, [appService, ready, servers]);
}
