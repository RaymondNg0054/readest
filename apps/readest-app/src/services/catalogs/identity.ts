import { md5 } from '@/utils/md5';
import type { CatalogUploadProtocol } from '@/types/catalogUpload';
import type { OPDSCatalog } from '@/types/opds';
import { stubTranslation as _ } from '@/utils/misc';

export const catalogUploadTargetId = (
  protocol: CatalogUploadProtocol,
  url: string,
  username = '',
) => md5(`catalog-upload:${protocol}:${new URL(url).href.replace(/\/+$/, '')}:${username}`);

export const calibreWebBaseUrl = (feedUrl: string): string => {
  const url = new URL(feedUrl);
  const match = url.pathname.match(/^(.*)\/opds(?:\/|$)/);
  if (!match || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error(_('Invalid Calibre-Web OPDS URL'));
  return `${url.origin}${match[1]}`;
};

export const opdsCatalogOperationId = (catalog: Pick<OPDSCatalog, 'id' | 'url' | 'username'>) => {
  try {
    const url = new URL(catalog.url);
    const username = catalog.username || decodeURIComponent(url.username);
    url.username = '';
    url.password = '';
    return catalogUploadTargetId('calibre-web', calibreWebBaseUrl(url.href), username);
  } catch {
    return `opds:${catalog.id}`;
  }
};
