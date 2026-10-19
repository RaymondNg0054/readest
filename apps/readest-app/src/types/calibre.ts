import type { BookFormat } from './book';

export interface CalibreServer {
  id: string;
  name: string;
  url: string;
  kind: 'calibre' | 'calibre-web';
  username?: string;
  password?: string;
  libraryId: string;
  enabled: boolean;
  syncProgress: boolean;
  /** Send local books the server does not have. On unless set to false. */
  uploadBooks?: boolean;
}

/** No URLs or credentials: this survives downloading the file and metadata sync. */
export interface CalibreSource {
  serverId: string;
  libraryId: string;
  bookId: string;
  formats: BookFormat[];
  modified?: string;
  missing?: boolean;
}

export interface CalibreBookRecord {
  id: string;
  title: string;
  authors: string[];
  formats: BookFormat[];
  tags: string[];
  language?: string;
  published?: string;
  publisher?: string;
  description?: string;
  series?: string;
  seriesIndex?: number;
  modified?: string;
}

export interface CalibrePosition {
  cfi: string;
  pos_frac: number;
  timestamp: number;
}
