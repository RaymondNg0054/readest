import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { DocumentLoader, type BookDoc } from '@/libs/document';
import type { CatalogUploadFingerprint } from '@/types/catalogUpload';
import { formatTitle } from '@/utils/book';

export const normalizeCatalogTitle = (title: string) =>
  title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export async function fingerprintCatalogFile(file: File): Promise<CatalogUploadFingerprint> {
  const fingerprint: CatalogUploadFingerprint = {
    sha256: bytesToHex(sha256(new Uint8Array(await file.arrayBuffer()))),
  };
  if (!/\.(epub|pdf|mobi|azw3?|fb2|fbz|txt|md|html?)$/i.test(file.name)) return fingerprint;
  let book: BookDoc | undefined;
  try {
    book = (await new DocumentLoader(file).open()).book;
    if (!book) return fingerprint;
    fingerprint.title = formatTitle(book.metadata.title);
    const parts: string[] = [];
    for (const section of book.sections) {
      const doc = await section.createDocument();
      doc.querySelectorAll('script, style, head').forEach((node) => node.remove());
      parts.push((doc.body ?? doc.documentElement).textContent ?? '');
    }
    // Conversions can rewrite ZIP metadata, markup and whitespace without changing the book text.
    const text = parts
      .join('')
      .normalize('NFC')
      .replace(/[\s\u00ad\u200b]+/g, '');
    if (text.length >= 1024) fingerprint.textSha256 = bytesToHex(sha256(text));
  } catch {
    /* Exact file matching still works for books that cannot be parsed. */
  } finally {
    await book?.destroy?.();
  }
  return fingerprint;
}

export const catalogFingerprintsMatch = (
  local: CatalogUploadFingerprint,
  remote: CatalogUploadFingerprint,
) =>
  local.sha256 === remote.sha256 || (!!local.textSha256 && local.textSha256 === remote.textSha256);
