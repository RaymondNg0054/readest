import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useCatalogUploadStore } from '@/store/catalogUploadStore';
import { isTauriAppPlatform } from '@/services/environment';
import {
  canUploadBookToCatalog,
  getCatalogUploadTargets,
  uploadBookToCatalog,
  finishCatalogUploads,
} from '@/services/catalogs/upload';
import { getOPDSCatalogBookHashes } from '@/services/opds/sourceMap';
import { eventDispatcher } from '@/utils/event';
import { isMainAppWindow } from '@/utils/window';

const CHECK_INTERVAL = 5 * 60_000;

const configuredTargets = () => getCatalogUploadTargets(useSettingsStore.getState().settings);

export function useCatalogAutoUpload() {
  const _ = useTranslation();
  const { appService } = useEnv();
  const ready = useLibraryStore((state) => state.libraryLoaded);

  useEffect(() => {
    if (!appService || !ready || !isTauriAppPlatform() || !isMainAppWindow()) return;
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout>;
    const pendingSince = Date.now();
    const retryAfter = new Map<string, number>();
    const canRun = () =>
      !stopped &&
      !document.hidden &&
      navigator.onLine &&
      useCatalogUploadStore.persist.hasHydrated();

    const check = async () => {
      if (running || !canRun()) return;
      running = true;
      try {
        for (const target of configuredTargets()) {
          if (!canRun()) break;
          if ((retryAfter.get(target.id) ?? 0) > Date.now()) continue;
          try {
            if (await finishCatalogUploads(appService, target.id))
              eventDispatcher.dispatch('check-opds-subscriptions', {});
            if (!canRun()) break;
            if (!configuredTargets().some((live) => live.id === target.id)) continue;
            const existing = await getOPDSCatalogBookHashes(appService, target.catalogIds);
            for (const row of useLibraryStore.getState().library) {
              if (!canRun() || !configuredTargets().some((live) => live.id === target.id)) break;
              const book = useLibraryStore.getState().getBookByHash(row.hash);
              if (
                !book ||
                !canUploadBookToCatalog(book) ||
                book.metadata?.catalogSource ||
                existing.has(book.hash) ||
                Object.values(useCatalogUploadStore.getState().receipts).some(
                  (receipt) => receipt.bookHash === book.hash,
                )
              )
                continue;
              await uploadBookToCatalog(appService, book.hash, target.id);
            }
          } catch (error) {
            retryAfter.set(target.id, Date.now() + CHECK_INTERVAL);
            eventDispatcher.dispatch('toast', {
              type: 'error',
              message: _('Automatic catalog upload failed: {{catalog}}', { catalog: target.name }),
            });
            console.error('Automatic catalog upload failed:', error);
          }
        }
      } finally {
        running = false;
        const targets = new Set(configuredTargets().map((target) => target.id));
        const pending = Object.values(useCatalogUploadStore.getState().receipts).filter((receipt) =>
          targets.has(receipt.targetId),
        );
        if (!stopped && pending.length) {
          clearTimeout(timer);
          const recent = pending.some(
            (receipt) => Date.now() - (receipt.startedAt ?? pendingSince) < CHECK_INTERVAL,
          );
          timer = setTimeout(() => void check(), recent ? 5000 : CHECK_INTERVAL);
        }
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void check(), 1000);
    };
    const unsubscribeLibrary = useLibraryStore.subscribe((state, previous) => {
      if (state.library === previous.library) return;
      if (
        state.library.some((book) => {
          const index = previous.hashIndex.get(book.hash);
          const old = index === undefined ? undefined : previous.library[index];
          return (
            book !== old && canUploadBookToCatalog(book) && (!old || !canUploadBookToCatalog(old))
          );
        })
      )
        schedule();
    });
    const unsubscribeUploads = useCatalogUploadStore.subscribe((state, previous) => {
      if (state.receipts !== previous.receipts) schedule();
    });
    const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
      if (state.settings.opdsCatalogs !== previous.settings.opdsCatalogs) {
        retryAfter.clear();
        schedule();
      }
    });
    schedule();
    const interval = setInterval(schedule, CHECK_INTERVAL);
    window.addEventListener('online', schedule);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(interval);
      unsubscribeLibrary();
      unsubscribeUploads();
      unsubscribeSettings();
      window.removeEventListener('online', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [_, appService, ready]);
}
