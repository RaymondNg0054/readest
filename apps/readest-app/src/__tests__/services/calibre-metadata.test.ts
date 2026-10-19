import { describe, expect, it } from 'vitest';
import { parseCalibreWebFeed, reconcileCalibreBooks } from '@/services/calibre/metadata';
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
