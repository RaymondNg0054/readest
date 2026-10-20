import type { Book, BookFormat } from '@/types/book';
import type { CalibreBookRecord, CalibreServer } from '@/types/calibre';
import { md5 } from '@/utils/md5';
import { stubTranslation as _ } from '@/utils/misc';
import { getMetadataHashInfo } from '@/utils/book';
import { isDemoBook } from '@/services/demoBooks';
import { isFeedBook } from '@/services/rss/feedBookUrl';

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
    const uuid = text(entry, 'id').replace(/^urn:uuid:/i, '');
    const series = text(entry, 'content').match(/SERIES:\s*(.+?)\s*\[([\d.]+)\]/);
    books.push({
      id,
      uuid: /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(uuid) ? uuid : undefined,
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

// Calibre's own duplicate test: the same fuzzy title and a shared author.
const fuzzyTitle = (title: string) =>
  title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\s*(a|an|the)\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
// Token order is ignored, so "Carroll, Lewis" matches "Lewis Carroll".
const authorKey = (name: string) =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(' ');
const bookKeys = (title: string, authors: string[]) =>
  fuzzyTitle(title)
    ? authors
        .map(authorKey)
        .filter(Boolean)
        .map((author) => `${fuzzyTitle(title)}|${author}`)
    : [];
const localKeys = (book: Book) => {
  const info = book.metadata ? getMetadataHashInfo(book.metadata) : undefined;
  return bookKeys(info?.title || book.title, info?.authors.length ? info.authors : [book.author]);
};

/** A row that only mirrors a server book: no file on this device or in the cloud. */
export const isStub = (book: Book) => !book.downloadedAt && !book.uploadedAt;

/** A Readest ebook file that is not linked to a Calibre server. */
const isLocalEbook = (book: Book) =>
  !book.deletedAt &&
  !book.metadata?.calibreSource &&
  FORMAT_ORDER.includes(book.format) &&
  !isFeedBook(book) &&
  !isDemoBook(book);

/** The server record for a book Calibre refused as a duplicate. */
export const findCalibreRecord = (
  records: CalibreBookRecord[],
  title: string,
  authors: string[],
): CalibreBookRecord | undefined => {
  const keys = new Set(bookKeys(title, authors));
  return records.find((record) => bookKeys(record.title, record.authors).some((k) => keys.has(k)));
};

/** Local files that are neither on the server nor already sent to a Calibre server. */
export const calibreUploadCandidates = (library: Book[], records: CalibreBookRecord[]): Book[] => {
  const listed = new Set(records.flatMap((record) => bookKeys(record.title, record.authors)));
  return library.filter(
    (book) =>
      isLocalEbook(book) &&
      !!book.downloadedAt &&
      !book.metadata?.calibreSentTo &&
      !localKeys(book).some((key) => listed.has(key)),
  );
};

/**
 * Server owns metadata only; local files, annotations, groups and tombstones stay local.
 * A book already in Readest is linked to its server record instead of getting a second row.
 */
export const reconcileCalibreBooks = (
  library: Book[],
  server: CalibreServer,
  records: CalibreBookRecord[],
  now: number,
): { books: Book[]; added: number; updated: number; removed: number } => {
  const belongs = (book: Book) =>
    book.metadata?.calibreSource?.serverId === server.id &&
    book.metadata.calibreSource.libraryId === server.libraryId;
  const replacements = new Map<string, Book>();
  // Library saves never drop rows, so a stub replaced by a local copy is tombstoned.
  const tombstone = (book: Book) => replacements.set(book.hash, { ...book, deletedAt: now });
  // One row per server book: a file beats a stub, and a live row beats a tombstone.
  // Another device can sync in a linked copy of a book that is a stub here.
  const rank = (book: Book) => (book.deletedAt ? 0 : isStub(book) ? 1 : 2);
  const existing = new Map<string, Book>();
  for (const book of library.filter(belongs)) {
    const id = book.metadata!.calibreSource!.bookId;
    const old = existing.get(id);
    const [keep, drop] = old && rank(old) >= rank(book) ? [old, book] : [book, old];
    if (drop && rank(drop) === 1 && rank(keep) === 2) tombstone(drop);
    existing.set(id, keep);
  }
  const local = new Map<string, Book>();
  for (const book of library.filter(isLocalEbook))
    for (const key of localKeys(book)) if (!local.has(key)) local.set(key, book);
  const claimed = new Set<string>();
  const takeLocal = (record: CalibreBookRecord) => {
    for (const key of bookKeys(record.title, record.authors)) {
      const book = local.get(key);
      if (book && !claimed.has(book.hash)) {
        claimed.add(book.hash);
        return book;
      }
    }
    return undefined;
  };
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const record of records) {
    seen.add(record.id);
    let old = existing.get(record.id);
    if (!record.formats.length) continue;
    // A local copy replaces a row that only mirrors the server.
    if (!old || old.deletedAt || isStub(old)) {
      const match = takeLocal(record);
      if (match && old && !old.deletedAt) tombstone(old);
      old = match ?? old;
    }
    if (old?.deletedAt) continue;
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
        ...(record.uuid ? { uuid: record.uuid } : {}),
        formats: record.formats,
        modified: record.modified,
      },
      calibreSentTo: undefined,
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
      // The managed filename is derived from sourceTitle, else title.
      sourceTitle: old?.sourceTitle || old?.title || title,
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
  const known = new Set(library.map((book) => book.hash));
  const books = library.map((book) => replacements.get(book.hash) ?? book);
  for (const book of replacements.values()) if (!known.has(book.hash)) books.push(book);
  return { books, added, updated, removed };
};
