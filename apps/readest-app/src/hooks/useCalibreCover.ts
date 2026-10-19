import { useEffect, useState, type RefObject } from 'react';
import type { Book } from '@/types/book';
import { getInitializedAppService } from '@/services/environment';
import { observeCoverForThumbnail } from '@/services/coverThumbnailService';
import { CalibreClient } from '@/services/calibre/client';
import { findCalibreServer } from '@/services/calibre/download';
import { getCoverFilename } from '@/utils/book';

export function useCalibreCover(
  book: Book,
  element: RefObject<HTMLElement | null>,
  hidden: boolean,
) {
  const [cover, setCover] = useState<string | null>(null);
  const source = book.metadata?.calibreSource;
  useEffect(() => {
    setCover(null);
    const appService = getInitializedAppService();
    if (
      !source ||
      !element.current ||
      !appService ||
      hidden ||
      book.deletedAt ||
      book.metadata?.coverImageUrl
    )
      return;
    let cancelled = false;
    const controller = new AbortController();
    const stop = observeCoverForThumbnail(element.current, () => {
      void (async () => {
        const path = getCoverFilename(book);
        if (!(await appService.exists(path, 'Books'))) {
          const server = findCalibreServer(source.serverId);
          if (!server) return;
          const client = new CalibreClient({ ...server, libraryId: source.libraryId });
          const response = await client.request(client.coverUrl(source.bookId), {
            headers: { Accept: 'image/*' },
            signal: controller.signal,
          });
          if (!response.headers.get('Content-Type')?.startsWith('image/')) return;
          const bytes = await response.arrayBuffer();
          if (cancelled || !bytes.byteLength) return;
          await appService.writeFile(path, 'Books', bytes);
        }
        const url = await appService.generateCoverImageUrl(book);
        // Native hydration supplies an asset URL even before the file exists.
        // Bust its failed image request once the missing cover has landed.
        if (!cancelled)
          setCover(
            url.startsWith('blob:')
              ? url
              : `${url}${url.includes('?') ? '&' : '?'}calibre=${Date.now()}`,
          );
      })().catch(() => {}); // A missing cover must not prevent browsing or reading.
    });
    return () => {
      cancelled = true;
      controller.abort();
      stop();
    };
  }, [source, book.hash, book.deletedAt, book.metadata?.coverImageUrl, element, hidden]);
  return cover;
}
