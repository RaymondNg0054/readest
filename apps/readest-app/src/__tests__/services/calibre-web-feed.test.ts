import { describe, expect, it } from 'vitest';
import { parseCalibreWebFeed } from '@/services/catalogs/calibreWebFeed';

describe('Calibre-Web upload verification feed', () => {
  const feed = `<feed xmlns="http://www.w3.org/2005/Atom">
    <link rel="next" href="/calibre/opds/books/letter/00?offset=20"/>
    <entry><id>urn:uuid:stable-publication-id</id><title>A Book</title>
      <author><name>An Author</name></author><updated>2026-10-01</updated>
      <link rel="http://opds-spec.org/acquisition" href="/calibre/opds/download/12/epub/"/>
      <link rel="http://opds-spec.org/acquisition/open-access" href="https://books.test/calibre/opds/download/12/pdf/"/>
      <link rel="http://opds-spec.org/acquisition" href="/calibre/opds/download/12/docx/"/>
    </entry></feed>`;
  it('extracts numeric identity, stable publication ID, supported formats and modified date', () => {
    expect(parseCalibreWebFeed(feed)).toEqual({
      next: '/calibre/opds/books/letter/00?offset=20',
      books: [
        {
          id: '12',
          publicationId: 'urn:uuid:stable-publication-id',
          title: 'A Book',
          authors: ['An Author'],
          formats: ['EPUB', 'PDF'],
          modified: '2026-10-01',
        },
      ],
    });
  });
  it('rejects login HTML and malformed XML instead of treating it as an empty library', () => {
    expect(() => parseCalibreWebFeed('<html><body>Log in</body></html>')).toThrow();
    expect(() => parseCalibreWebFeed('<feed><entry>broken & comment</entry></feed>')).toThrow();
  });
});
