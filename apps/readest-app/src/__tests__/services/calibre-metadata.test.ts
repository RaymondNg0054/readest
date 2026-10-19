import { describe, expect, it } from 'vitest';
import {
  calibreUploadCandidates,
  parseCalibreWebFeed,
  reconcileCalibreBooks,
} from '@/services/calibre/metadata';
import type { Book } from '@/types/book';
import type { CalibreBookRecord, CalibreServer } from '@/types/calibre';
import { getBookWithUpdatedMetadata } from '@/utils/book';

const server: CalibreServer = {
  id: 'server',
  name: 'Calibre',
  url: 'https://books.test/calibre',
  kind: 'calibre',
  libraryId: 'My Library',
  enabled: true,
  syncProgress: true,
};
const record: CalibreBookRecord = {
  id: '12',
  title: 'A Book',
  authors: ['An Author'],
  formats: ['EPUB', 'PDF'],
  tags: ['Fiction'],
  published: '2000-01-01',
  series: 'A Series',
  seriesIndex: 2,
};

describe('Calibre library reconciliation', () => {
  it('keeps the reading-date clock when server metadata or availability changes', () => {
    const initial = reconcileCalibreBooks([], server, [record], 100).books;
    const changed = reconcileCalibreBooks(
      initial,
      server,
      [{ ...record, title: 'New title' }],
      200,
    );
    expect(changed.books[0]?.updatedAt).toBe(100);
    expect(changed.books[0]?.metadataUpdatedAt).toBe(200);
    expect(reconcileCalibreBooks(changed.books, server, [], 300).books[0]?.updatedAt).toBe(100);
  });
  it('reports a changed server revision even when display metadata is unchanged', () => {
    const initial = reconcileCalibreBooks(
      [],
      server,
      [{ ...record, modified: '2026-10-01' }],
      100,
    ).books;
    const result = reconcileCalibreBooks(
      initial,
      server,
      [{ ...record, modified: '2026-10-02' }],
      200,
    );
    expect(result.updated).toBe(1);
  });
  it('retains source identity when book details replace the editable metadata', () => {
    const initial = reconcileCalibreBooks([], server, [record], 100).books[0]!;
    const edited = getBookWithUpdatedMetadata(initial, {
      title: 'Edited',
      author: 'Author',
      language: 'en',
    });
    expect(edited.metadata?.calibreSource).toEqual(initial.metadata?.calibreSource);
    const sent = {
      ...initial,
      metadata: { title: 'A Book', author: '', language: '', calibreSentTo: 'web' },
    };
    expect(
      getBookWithUpdatedMetadata(sent, { title: 'Edited', author: '', language: '' }).metadata
        ?.calibreSentTo,
    ).toBe('web');
  });
  it('creates searchable, tag-groupable fileless stubs with publication metadata', () => {
    const result = reconcileCalibreBooks([], server, [record], 100);
    expect(result.added).toBe(1);
    expect(result.books[0]).toMatchObject({
      title: 'A Book',
      author: 'An Author',
      tags: ['Fiction'],
      format: 'EPUB',
      metadata: {
        published: '2000-01-01',
        series: 'A Series',
        seriesIndex: 2,
        calibreSource: { serverId: 'server', bookId: '12' },
      },
    });
    expect(result.books[0]?.downloadedAt).toBeUndefined();
    expect(result.books[0]?.uploadedAt).toBeUndefined();
  });

  it('does not write or change timestamps on an unchanged library', () => {
    const initial = reconcileCalibreBooks([], server, [record], 100).books;
    const result = reconcileCalibreBooks(initial, server, [record], 200);
    expect(result.books).toBe(initial);
    expect(result.updated).toBe(0);
  });

  it('updates metadata without replacing downloaded identity, progress, groups or deletion', () => {
    const initial = reconcileCalibreBooks([], server, [record], 100).books;
    const downloaded = {
      ...initial[0]!,
      downloadedAt: 110,
      format: 'PDF' as const,
      sourceTitle: 'Original filename',
      progress: [10, 100] as [number, number],
      groupName: 'My group',
      coverHash: 'cover',
    };
    const changed = { ...record, title: 'New title', tags: ['History'] };
    const result = reconcileCalibreBooks([downloaded], server, [changed], 200);
    expect(result.books[0]).toMatchObject({
      hash: downloaded.hash,
      format: 'PDF',
      sourceTitle: 'Original filename',
      downloadedAt: 110,
      progress: [10, 100],
      groupName: 'My group',
      coverHash: 'cover',
      title: 'New title',
      tags: ['History'],
    });
    const deleted = { ...downloaded, deletedAt: 150 };
    expect(reconcileCalibreBooks([deleted], server, [changed], 200).books[0]).toBe(deleted);
  });

  it('reports removed server books without deleting local copies and clears the report on return', () => {
    const initial = reconcileCalibreBooks([], server, [record], 100).books;
    const result = reconcileCalibreBooks(initial, server, [], 200);
    expect(result.removed).toBe(1);
    expect(result.books[0]?.metadata?.calibreSource?.missing).toBe(true);
    expect(result.books[0]?.deletedAt).toBeUndefined();
    const restored = reconcileCalibreBooks(result.books, server, [record], 300);
    expect(restored.books[0]?.metadata?.calibreSource?.missing).toBeFalsy();
  });

  it('does not touch other servers or libraries', () => {
    const initial = reconcileCalibreBooks([], server, [record], 100).books;
    expect(reconcileCalibreBooks(initial, { ...server, id: 'other' }, [], 200).books).toBe(initial);
    expect(reconcileCalibreBooks(initial, { ...server, libraryId: 'other' }, [], 200).books).toBe(
      initial,
    );
  });
});

describe('Calibre duplicates', () => {
  const local: Book = {
    hash: 'local',
    format: 'EPUB',
    title: 'A Book',
    author: 'An Author',
    createdAt: 1,
    updatedAt: 1,
    downloadedAt: 1,
    progress: [3, 10],
    metadata: { title: 'A Book', author: 'An Author', language: 'en', identifier: 'isbn' },
  };

  it('links a book already in Readest instead of adding a second row', () => {
    const result = reconcileCalibreBooks([local], server, [record], 100);
    expect(result.books).toHaveLength(1);
    expect(result.added).toBe(0);
    expect(result.books[0]).toMatchObject({
      hash: 'local',
      downloadedAt: 1,
      progress: [3, 10],
      tags: ['Fiction'],
      metadata: { identifier: 'isbn', calibreSource: { serverId: 'server', bookId: '12' } },
    });
  });

  it('matches titles and authors like Calibre: case, punctuation, articles and name order', () => {
    const variant = {
      ...local,
      title: 'The book!',
      author: 'Author, An',
      metadata: { title: 'The book!', author: { name: { en: 'Author, An' } }, language: 'en' },
    };
    expect(reconcileCalibreBooks([variant], server, [record], 100).books).toHaveLength(1);
    const other = { ...local, title: 'Another Book', metadata: undefined };
    expect(reconcileCalibreBooks([other], server, [record], 100).books).toHaveLength(2);
  });

  it('replaces an undownloaded stub once the same book is imported locally', () => {
    const stub = reconcileCalibreBooks([], server, [record], 100).books[0]!;
    const result = reconcileCalibreBooks([stub, local], server, [record], 200);
    // Library saves never drop rows, so the stub must be tombstoned.
    expect(result.books.find((book) => book.hash === stub.hash)?.deletedAt).toBe(200);
    expect(
      result.books.find((book) => book.hash === 'local')?.metadata?.calibreSource?.bookId,
    ).toBe('12');
    const next = reconcileCalibreBooks(result.books, server, [{ ...record, title: 'New' }], 300);
    expect(next.books.find((book) => book.hash === 'local')?.title).toBe('New');
    expect(next.books.filter((book) => !book.deletedAt)).toHaveLength(1);
  });

  it('keeps one row when another device syncs in its linked copy of a stub', () => {
    const stub = reconcileCalibreBooks([], server, [record], 100).books[0]!;
    const peer = { ...local, downloadedAt: undefined, uploadedAt: 50 };
    const linked = reconcileCalibreBooks([peer], server, [record], 100).books[0]!;
    const result = reconcileCalibreBooks([stub, linked], server, [record], 200);
    expect(result.books.filter((book) => !book.deletedAt).map((book) => book.hash)).toEqual([
      'local',
    ]);
  });

  it('links a local copy of a server book whose row the user deleted', () => {
    const stub = { ...reconcileCalibreBooks([], server, [record], 100).books[0]!, deletedAt: 150 };
    const result = reconcileCalibreBooks([stub, local], server, [record], 200);
    expect(
      result.books.find((book) => book.hash === 'local')?.metadata?.calibreSource?.bookId,
    ).toBe('12');
    expect(result.added).toBe(0);
  });

  it('does not link deleted books, audiobooks or books of another Calibre server', () => {
    const deleted = { ...local, deletedAt: 5 };
    const audio = { ...local, hash: 'audio', format: 'OPDSAUDIO' as const };
    const elsewhere = {
      ...local,
      hash: 'elsewhere',
      metadata: {
        ...local.metadata!,
        calibreSource: { serverId: 'other', libraryId: 'l', bookId: '3', formats: [] },
      },
    };
    const result = reconcileCalibreBooks([deleted, audio, elsewhere], server, [record], 100);
    expect(result.books).toHaveLength(4);
    expect(result.added).toBe(1);
  });

  it('links a book sent to Calibre-Web once the server lists it', () => {
    const sent = { ...local, metadata: { ...local.metadata!, calibreSentTo: 'server' } };
    const [linked] = reconcileCalibreBooks([sent], server, [record], 100).books;
    expect(linked?.metadata?.calibreSource?.bookId).toBe('12');
    expect(linked?.metadata?.calibreSentTo).toBeUndefined();
  });

  it('sends only local ebook files the server does not have', () => {
    const fresh = { ...local, hash: 'fresh', title: 'Fresh', metadata: undefined };
    const books: Book[] = [
      local,
      fresh,
      { ...fresh, hash: 'deleted', deletedAt: 1 },
      { ...fresh, hash: 'cloud-only', downloadedAt: undefined, uploadedAt: 1 },
      { ...fresh, hash: 'audio', format: 'OPDSAUDIO' },
      { ...fresh, hash: 'sent', metadata: { ...local.metadata!, calibreSentTo: 'server' } },
      ...reconcileCalibreBooks([], server, [{ ...record, id: '99', title: 'Stub' }], 1).books,
    ];
    expect(calibreUploadCandidates(books, [record]).map((book) => book.hash)).toEqual(['fresh']);
  });
});

describe('Calibre-Web OPDS metadata', () => {
  const feed = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dcterms="http://purl.org/dc/terms/">
    <link rel="next" href="/calibre/opds/books/letter/00?offset=20"/>
    <entry><id>urn:uuid:not-the-book-id</id><title>A Book</title>
      <author><name>An Author</name></author><category term="Fiction"/>
      <updated>2026-10-01</updated><published>2000-01-01</published><dcterms:language>en</dcterms:language>
      <link rel="http://opds-spec.org/acquisition" href="/calibre/opds/download/12/epub/"/>
      <link rel="http://opds-spec.org/acquisition/open-access" href="https://books.test/calibre/opds/download/12/pdf/"/>
      <link rel="http://opds-spec.org/acquisition" href="/calibre/opds/download/12/docx/"/>
    </entry></feed>`;
  it('extracts numeric identity, all supported formats, tags and publication date', () => {
    expect(parseCalibreWebFeed(feed)).toMatchObject({
      next: '/calibre/opds/books/letter/00?offset=20',
      books: [
        {
          id: '12',
          title: 'A Book',
          authors: ['An Author'],
          formats: ['EPUB', 'PDF'],
          tags: ['Fiction'],
          language: 'en',
          published: '2000-01-01',
        },
      ],
    });
  });
  it('reads Calibre-Web Automated summaries and keeps custom columns out of tags', () => {
    const cwa = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>A Book</title>
        <category scheme="http://www.bisg.org/standards/bisac_subject/index.html" term="Fiction" label="Fiction"/>
        <category scheme="custom_column:Read" term="Read" label="true"/>
        <summary>A summary.</summary>
        <link rel="http://opds-spec.org/acquisition" href="/opds/download/7/epub/"/>
      </entry></feed>`;
    expect(parseCalibreWebFeed(cwa).books[0]).toMatchObject({
      tags: ['Fiction'],
      description: 'A summary.',
    });
  });
  it('drops the placeholder date Calibre uses for an unknown publication date', () => {
    const undated = feed.replace('2000-01-01', '0101-01-01T00:00:00+00:00');
    expect(parseCalibreWebFeed(undated).books[0]?.published).toBeUndefined();
  });
  it('rejects login HTML and malformed XML instead of treating it as an empty library', () => {
    expect(() => parseCalibreWebFeed('<html><body>Log in</body></html>')).toThrow();
    expect(() => parseCalibreWebFeed('<feed><entry>broken & comment</entry></feed>')).toThrow();
  });
});
