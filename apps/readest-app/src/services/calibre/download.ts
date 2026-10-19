import type { Book, BookFormat } from '@/types/book';
import type { AppService } from '@/types/system';
import type { ProgressHandler } from '@/utils/transfer';
import { getDir, getLocalBookFilename } from '@/utils/book';
import { stubTranslation as _, uniqueId } from '@/utils/misc';
import { useSettingsStore } from '@/store/settingsStore';
import { CalibreClient, CalibreHttpError } from './client';

export class CalibreFilesMissingError extends Error {
  constructor() {
    super(_('Book files are missing on the Calibre server.'));
  }
}

export const findCalibreServer = (id: string) =>
  useSettingsStore.getState().settings.calibreServers?.find((server) => server.id === id);

/** Download into the existing managed directory, retaining stable annotation/config keys. */
export async function downloadCalibreBook(
  appService: AppService,
  book: Book,
  format?: BookFormat,
  onProgress?: ProgressHandler,
): Promise<{ format: BookFormat; downloadedAt: number }> {
  if (!format && (await appService.exists(getLocalBookFilename(book), 'Books'))) {
    return { format: book.format, downloadedAt: book.downloadedAt ?? Date.now() };
  }
  const source = book.metadata?.calibreSource;
  const server = source && findCalibreServer(source.serverId);
  if (!source || !server) throw new Error(_('Calibre server is not configured on this device.'));
  const client = new CalibreClient({ ...server, libraryId: source.libraryId });
  const formats = [...new Set([format ?? book.format, ...source.formats])].filter((fmt) =>
    source.formats.includes(fmt),
  );
  if (!formats.length) throw new Error(_('No supported formats are available for this book.'));
  for (const candidate of formats) {
    let response: Response;
    try {
      response = await client.request(client.downloadUrl(source.bookId, candidate), {
        headers: { Accept: '*/*' },
      });
    } catch (error) {
      // A missing advertised file is not a bad password, network failure or disk error.
      if (error instanceof CalibreHttpError && error.status === 404) continue;
      throw error;
    }
    if (response.headers.get('Content-Type')?.includes('text/html') && candidate !== 'HTML') {
      throw new Error(_('Calibre returned a login page instead of a book.'));
    }
    const total = Number(response.headers.get('Content-Length')) || 0;
    const reader = response.body?.getReader();
    let bytes: ArrayBuffer;
    if (reader) {
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value);
          received += chunk.value.byteLength;
          onProgress?.({ progress: received, total, transferSpeed: 0 });
        }
      } finally {
        reader.releaseLock();
      }
      const buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      bytes = buffer.buffer;
    } else bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw new Error(_('Calibre returned an empty book file.'));
    const temp = `calibre-${uniqueId()}`;
    try {
      await appService.writeFile(temp, 'Cache', bytes);
      await appService.createDir(getDir(book), 'Books', true);
      await appService.copyFile(
        temp,
        'Cache',
        getLocalBookFilename({ ...book, format: candidate }),
        'Books',
      );
    } finally {
      await appService.deleteFile(temp, 'Cache').catch(() => {});
    }
    return { format: candidate, downloadedAt: Date.now() };
  }
  throw new CalibreFilesMissingError();
}
