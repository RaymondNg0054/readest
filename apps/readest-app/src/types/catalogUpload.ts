import type { Book, BookFormat } from './book';

export type CatalogUploadProtocol = 'calibre-web';

export interface CatalogUploadTarget {
  id: string;
  name: string;
  protocol: CatalogUploadProtocol;
  url: string;
  username?: string;
  password?: string;
  customHeaders?: Record<string, string>;
  catalogIds: string[];
}

export interface CatalogBookLink {
  targetId: string;
  bookId: string;
  protocol: CatalogUploadProtocol;
}

export interface CatalogRemoteBook {
  id: string;
  title: string;
  author: string;
  formats: BookFormat[];
  /** Include stable publication IDs as well as acquisition URLs; formats can change. */
  sourceUrls: string[];
  modified?: string;
}

export interface CatalogUploadReceipt {
  targetId: string;
  bookHash: string;
  state: 'sending' | 'queued' | 'uploaded';
  bookId?: string;
  fingerprint?: CatalogUploadFingerprint;
  startedAt?: number;
}

export interface CatalogUploadFingerprint {
  sha256: string;
  textSha256?: string;
  title?: string;
}

export interface CatalogUploadAdapter {
  upload(file: File, onSend: () => void): Promise<{ bookId?: string }>;
  listBooks(): Promise<CatalogRemoteBook[]>;
  getBookId(book: Book): string | undefined;
  getBookFile(bookId: string, format: BookFormat): Promise<File>;
}
