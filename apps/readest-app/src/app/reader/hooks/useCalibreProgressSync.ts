import { useEffect } from 'react';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import {
  getBookProgress,
  useBookProgress,
  useReaderProgressStore,
} from '@/store/readerProgressStore';
import { useSettingsStore } from '@/store/settingsStore';
import { CalibreClient } from '@/services/calibre/client';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import { useTranslation } from '@/hooks/useTranslation';
import { isMalformedLocationCfi } from '@/utils/cfi';

/** Opt-in EPUB position sync. Never publish the opening position before a successful pull. */
export function useCalibreProgressSync(bookKey: string) {
  const _ = useTranslation();
  const progress = useBookProgress(bookKey);
  const ready = !!progress?.location;
  const servers = useSettingsStore((s) => s.settings.calibreServers);
  useEffect(() => {
    if (!ready) return;
    const book = useBookDataStore.getState().getBookData(bookKey)?.book;
    const source = book?.metadata?.calibreSource;
    const server = servers?.find((s) => s.id === source?.serverId);
    // Calibre renders other formats through its own EPUB conversion: their CFIs
    // are not interchangeable with Readest's PDF/MOBI/etc. locations.
    if (
      !book ||
      book.format !== 'EPUB' ||
      !source ||
      !server?.syncProgress ||
      !server.username ||
      server.kind !== 'calibre'
    )
      return;
    const client = new CalibreClient({ ...server, libraryId: source.libraryId });
    const stampKey = `calibre-position-${book.hash}`;
    const openingLocation = getBookProgress(bookKey)?.location;
    let disposed = false;
    let settled = false;
    let applying = false;
    let dirty = false;
    let writing = false;
    let flushRequested = false;
    const previewing = () => useReaderStore.getState().getViewState(bookKey)?.previewMode;
    const hint = (message: string) => eventDispatcher.dispatch('hint', { bookKey, message });

    const push = async () => {
      if (disposed || !settled || !dirty || applying || previewing()) return;
      if (writing) {
        flushRequested = true;
        return;
      }
      const local = getBookProgress(bookKey);
      if (
        !local?.location ||
        isMalformedLocationCfi(local.location) ||
        !Number.isFinite(local.fraction)
      )
        return;
      writing = true;
      dirty = false;
      try {
        await client.setPosition(
          source.bookId,
          'EPUB',
          local.location,
          Math.max(0, Math.min(1, local.fraction)),
        );
      } catch {
        dirty = true;
        if (!disposed) hint(_('Calibre reading-position sync failed'));
      } finally {
        writing = false;
        if (flushRequested) {
          flushRequested = false;
          void push();
        }
      }
    };
    const schedule = debounce(push, 10_000);

    const unsubscribe = useReaderProgressStore.subscribe((state, previous) => {
      const local = state.progresses[bookKey];
      if (
        !local?.location ||
        local.location === previous.progresses[bookKey]?.location ||
        applying ||
        previewing()
      )
        return;
      dirty = true;
      localStorage.setItem(stampKey, String(Date.now()));
      if (settled) schedule();
    });

    const pull = async () => {
      try {
        const remote = await client.getPosition(source.bookId, 'EPUB');
        if (disposed) return;
        const localStamp = Number(localStorage.getItem(stampKey) ?? 0);
        if (localStamp > (remote?.timestamp ?? 0) * 1000) dirty = true;
        // The user reading on while the request was pending always beats the pull.
        if (!dirty && remote && remote.timestamp * 1000 > localStamp) {
          const view = useReaderStore.getState().getView(bookKey);
          if (!view || previewing()) return;
          if (!remote.cfi?.startsWith('epubcfi(') || isMalformedLocationCfi(remote.cfi))
            throw new Error('Invalid remote position');
          applying = true;
          await view.goTo(remote.cfi);
          if (disposed) return;
          localStorage.setItem(stampKey, String(remote.timestamp * 1000));
          hint(_('Reading Progress Synced'));
        }
        settled = true;
        if (dirty || (getBookProgress(bookKey)?.location !== openingLocation && !remote)) {
          if (flushRequested) {
            flushRequested = false;
            void push();
          } else schedule();
        }
      } catch {
        // An unread or unapplied newer remote position is NOT permission to overwrite it.
        if (!disposed) hint(_('Calibre reading-position sync failed'));
      } finally {
        applying = false;
      }
    };
    void pull();

    const flush = (event: CustomEvent) => {
      if (event.detail.bookKey !== bookKey) return;
      if (!settled) {
        flushRequested = true;
        return;
      }
      schedule.cancel();
      void push();
    };
    eventDispatcher.on('sync-book-progress', flush);
    return () => {
      disposed = true;
      schedule.cancel();
      unsubscribe();
      eventDispatcher.off('sync-book-progress', flush);
    };
  }, [bookKey, ready, servers, _]);
}
