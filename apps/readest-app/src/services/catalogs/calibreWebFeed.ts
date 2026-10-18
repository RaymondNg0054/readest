import type { BookFormat } from '@/types/book';
import { stubTranslation as _ } from '@/utils/misc';

export interface CalibreWebBook {
  id: string;
  publicationId?: string;
  title: string;
  authors: string[];
  formats: BookFormat[];
  modified?: string;
}

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

const elements = (root: Element, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS('*', name));
const text = (root: Element, name: string): string =>
  elements(root, name)[0]?.textContent?.trim() ?? '';

export const parseCalibreWebFeed = (xml: string): { books: CalibreWebBook[]; next?: string } => {
  const doc = new DOMParser().parseFromString(xml.replaceAll('&nbsp;', '&#160;'), 'text/xml');
  const root = doc.documentElement;
  if (root.localName !== 'feed' || doc.getElementsByTagName('parsererror').length) {
    throw new Error(_('Invalid Calibre-Web OPDS feed. Check OPDS access and authentication.'));
  }
  const next =
    Array.from(root.children)
      .find((el) => el.localName === 'link' && el.getAttribute('rel') === 'next')
      ?.getAttribute('href') ?? undefined;
  const books: CalibreWebBook[] = [];
  for (const entry of elements(root, 'entry')) {
    const links = elements(entry, 'link').filter((link) =>
      (link.getAttribute('rel') ?? '').startsWith('http://opds-spec.org/acquisition'),
    );
    let id: string | undefined;
    const formats = new Set<string>();
    for (const link of links) {
      const match = link.getAttribute('href')?.match(/\/opds\/download\/(\d+)\/([^/?#]+)/);
      if (!match) continue;
      id ??= match[1];
      if (id === match[1]) formats.add(match[2]!.toUpperCase());
    }
    if (!id) continue;
    books.push({
      id,
      publicationId: text(entry, 'id') || undefined,
      title: text(entry, 'title') || _('Untitled'),
      authors: elements(entry, 'author')
        .map((author) => text(author, 'name'))
        .filter(Boolean),
      formats: FORMAT_ORDER.filter((format) => formats.has(format)),
      modified: text(entry, 'updated') || undefined,
    });
  }
  return { books, next };
};
