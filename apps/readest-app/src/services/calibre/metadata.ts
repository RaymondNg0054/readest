import type { Book, BookFormat } from '@/types/book';
import type { CalibreBookRecord, CalibreServer } from '@/types/calibre';
import { md5 } from '@/utils/md5';
import { stubTranslation as _ } from '@/utils/misc';

const FORMAT_ORDER: BookFormat[] = [
  'EPUB',
  'AZW3',
  'MOBI',
  'AZW',
  'PDF',
  'FB2',
  'FBZ',
  'CBZ',
  'TXT',
  'MD',
  'HTML',
];

export const calibreFormats = (formats: string[]): BookFormat[] => {
  const offered = new Set(formats.map((format) => format.toUpperCase()));
  return FORMAT_ORDER.filter((format) => offered.has(format));
};

// Calibre stores an unknown publication date as the year 101.
export const calibreDate = (value?: string | null): string | undefined =>
  value && !value.startsWith('0101-') ? value : undefined;

const elements = (root: Element, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS('*', name));
const text = (root: Element, name: string): string =>
  elements(root, name)[0]?.textContent?.trim() ?? '';

/** Parse acquisition entries, never silently accept a login page or a partial feed. */
export const parseCalibreWebFeed = (xml: string): { books: CalibreBookRecord[]; next?: string } => {
  const doc = new DOMParser().parseFromString(xml.replaceAll('&nbsp;', '&#160;'), 'text/xml');
  const root = doc.documentElement;
  if (root.localName !== 'feed' || doc.getElementsByTagName('parsererror').length) {
    throw new Error(_('Invalid Calibre-Web OPDS feed. Check OPDS access and authentication.'));
  }
  const next =
    Array.from(root.children)
      .find((el) => el.localName === 'link' && el.getAttribute('rel') === 'next')
      ?.getAttribute('href') ?? undefined;
  const books: CalibreBookRecord[] = [];
  for (const entry of elements(root, 'entry')) {
    const links = elements(entry, 'link').filter((link) =>
      (link.getAttribute('rel') ?? '').startsWith('http://opds-spec.org/acquisition'),
    );
    let id: string | undefined;
    const formats: string[] = [];
    for (const link of links) {
      const match = link.getAttribute('href')?.match(/\/opds\/download\/(\d+)\/([^/?#]+)/);
      if (!match) continue;
      id ??= match[1];
      if (id === match[1]) formats.push(match[2]!);
    }
    if (!id) continue;
    const series = text(entry, 'content').match(/SERIES:\s*(.+?)\s*\[([\d.]+)\]/);
    books.push({
      id,
      title: text(entry, 'title') || _('Untitled'),
      authors: elements(entry, 'author')
        .map((author) => text(author, 'name'))
        .filter(Boolean),
      formats: calibreFormats(formats),
      // Calibre-Web Automated also lists custom columns as categories.
      tags: elements(entry, 'category')
        .filter((category) => !category.getAttribute('scheme')?.startsWith('custom_column:'))
        .map((category) => category.getAttribute('term') ?? '')
        .filter(Boolean),
      language: text(entry, 'language') || undefined,
      published: calibreDate(text(entry, 'published')),
      publisher: text(entry, 'publisher') || undefined,
      modified: text(entry, 'updated') || undefined,
      description:
        text(entry, 'summary') ||
        elements(entry, 'p')
          .map((p) => p.textContent)
          .join('\n') ||
        undefined,
      series: series?.[1]?.trim(),
      seriesIndex: series ? Number(series[2]) : undefined,
    });
  }
  return { books, next };
};

/** Server owns metadata only; local files, annotations, groups and tombstones stay local. */
export const reconcileCalibreBooks = (
  library: Book[],
  server: CalibreServer,
  records: CalibreBookRecord[],
  now: number,
): { books: Book[]; added: number; updated: number; removed: number } => {
  const belongs = (book: Book) =>
    book.metadata?.calibreSource?.serverId === server.id &&
    book.metadata.calibreSource.libraryId === server.libraryId;
  const existing = new Map(
    library.filter(belongs).map((book) => [book.metadata!.calibreSource!.bookId, book]),
  );
  const replacements = new Map<string, Book>();
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const record of records) {
    seen.add(record.id);
    const old = existing.get(record.id);
    if (old?.deletedAt || !record.formats.length) continue;
    const metadata = {
      ...old?.metadata,
      title: record.title,
      author: record.authors.join(', '),
      language: record.language ?? '',
      published: record.published,
      publisher: record.publisher,
      description: record.description,
      series: record.series,
      seriesIndex: record.seriesIndex,
      calibreSource: {
        serverId: server.id,
        libraryId: server.libraryId,
        bookId: record.id,
        formats: record.formats,
        modified: record.modified,
      },
    };
    const title = record.title;
    const author = record.authors.join(', ');
    const tags = record.tags;
    if (
      old &&
      old.title === title &&
      old.author === author &&
      JSON.stringify(old.tags) === JSON.stringify(tags) &&
      JSON.stringify(old.metadata) === JSON.stringify(metadata)
    )
      continue;
    const hash =
      old?.hash ?? md5(`calibre:${server.id}/${encodeURIComponent(server.libraryId)}/${record.id}`);
    replacements.set(hash, {
      ...old,
      hash,
      format: old?.format ?? record.formats[0]!,
      title,
      author,
      tags,
      metadata,
      sourceTitle: old?.sourceTitle ?? title,
      primaryLanguage: record.language,
      createdAt: old?.createdAt ?? now,
      // updatedAt is the Date Read sort key; server changes only move the metadata clock.
      updatedAt: old?.updatedAt ?? now,
      metadataUpdatedAt: now,
    });
    if (old) updated++;
    else added++;
  }
  for (const [id, old] of existing) {
    if (seen.has(id) || old.deletedAt || old.metadata?.calibreSource?.missing) continue;
    replacements.set(old.hash, {
      ...old,
      metadataUpdatedAt: now,
      metadata: {
        ...old.metadata!,
        calibreSource: { ...old.metadata!.calibreSource!, missing: true },
      },
    });
    removed++;
  }
  if (!replacements.size) return { books: library, added, updated, removed };
  const books = library.map((book) => replacements.get(book.hash) ?? book);
  for (const book of replacements.values())
    if (!existing.has(book.metadata!.calibreSource!.bookId)) books.push(book);
  return { books, added, updated, removed };
};
