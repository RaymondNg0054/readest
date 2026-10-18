// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AppService } from '@/types/system';
import type { Book, BookFormat } from '@/types/book';
import type { SystemSettings } from '@/types/settings';

const env = vi.hoisted(() => ({ appService: undefined as AppService | undefined }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => env }));
const translate = (key: string) => key;
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => translate }));

const live = await vi.hoisted(async () => {
  const url = process.env['READEST_CWA_TEST_URL'];
  const requests: { path: string; status: number; cookie: boolean }[] = [];
  if (!url) return { url, fetch: globalThis.fetch, dom: undefined, uploads: 0, requests };
  const domPackage = 'jsdom';
  const domModule: unknown = await import(domPackage);
  const { JSDOM } = domModule as {
    JSDOM: new (
      html: string,
      options: { url: string; pretendToBeVisual: boolean },
    ) => {
      window: {
        document: Document;
        navigator: Navigator;
        DOMParser: typeof DOMParser;
        XMLSerializer: typeof XMLSerializer;
        Node: typeof Node;
        NodeFilter: typeof NodeFilter;
        location: Location;
        localStorage: Storage;
        close: () => void;
      };
    };
  };
  const dom = new JSDOM('', { url: 'http://localhost', pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  vi.stubGlobal('XMLSerializer', dom.window.XMLSerializer);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('NodeFilter', dom.window.NodeFilter);
  vi.stubGlobal('location', dom.window.location);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  return { url, fetch: globalThis.fetch, dom, uploads: 0, requests };
});
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: async (url: string, options: RequestInit & { maxRedirections?: number }) => {
    if (url.endsWith('/upload') && options.method === 'POST') live.uploads++;
    const { maxRedirections, ...request } = options;
    const response = await live.fetch(url, {
      ...request,
      redirect: maxRedirections === 0 ? 'manual' : 'follow',
    });
    live.requests.push({
      path: new URL(url).pathname,
      status: response.status,
      cookie: new Headers(options.headers).has('Cookie'),
    });
    return response;
  },
}));
vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isTauriAppPlatform: () => !!live.url,
}));

import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useCatalogUploadStore } from '@/store/catalogUploadStore';
import { catalogUploadTargetId } from '@/services/catalogs/identity';
import { listCatalogUploadBooks } from '@/services/catalogs/upload';
import { useCatalogAutoUpload } from '@/hooks/useCatalogAutoUpload';
import { findBookByOPDSSources } from '@/services/opds/sourceMap';
import { EXTS } from '@/libs/document';

afterEach(() => {
  cleanup();
  env.appService = undefined;
  useCatalogUploadStore.setState({ receipts: {} });
});
afterAll(() => {
  live.dom?.window.close();
  vi.unstubAllGlobals();
});

describe.skipIf(!live.url)('disposable CWA HTTP integration', () => {
  it('uploads a real book and automatically links its processed server copy without confirmation', async () => {
    const url = new URL(live.url!);
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
    const server = {
      url: url.href.replace(/\/+$/, ''),
      username: 'admin',
      password: 'admin123',
    };
    const settings = {
      opdsCatalogs: [
        {
          id: 'live-opds',
          contentId: 'live-opds',
          name: 'Disposable OPDS',
          url: `${server.url}/opds`,
          username: server.username,
          password: server.password,
          uploadProtocol: 'calibre-web',
        },
      ],
    } as unknown as SystemSettings;
    useSettingsStore.setState({ settings });
    useCatalogUploadStore.setState({ receipts: {} });
    const formats: BookFormat[] = [
      'EPUB',
      'PDF',
      'MOBI',
      'AZW',
      'AZW3',
      'FB2',
      'FBZ',
      'CBZ',
      'TXT',
      'MD',
      'HTML',
    ];
    const requestedFormat = process.env['READEST_CWA_TEST_FORMAT'] ?? 'EPUB';
    const format = formats.find((format) => format === requestedFormat);
    if (!format) throw new Error(`Unsupported test format: ${requestedFormat}`);
    if (format === 'PDF') {
      await import('@pdfjs/pdf.min.mjs');
      const pdfjs = (
        globalThis as unknown as {
          pdfjsLib: { GlobalWorkerOptions: { workerSrc: string } };
        }
      ).pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
        resolve('public/vendor/pdfjs/pdf.worker.min.mjs'),
      ).href;
    }
    const targetId = catalogUploadTargetId('calibre-web', server.url, server.username);
    expect(
      await listCatalogUploadBooks(targetId),
      'Use an empty disposable CWA instance, not a personal library',
    ).toHaveLength(0);
    const bytes = await readFile(
      process.env['READEST_CWA_TEST_FILE'] ??
        `src/__tests__/fixtures/data/sample-alice.${EXTS[format]}`,
    );
    const book: Book = {
      hash: 'local-original',
      title: 'Alice upload test',
      author: 'Lewis Carroll',
      format,
      sourceTitle: 'Original local file',
      downloadedAt: 1,
      progress: [4, 20],
      groupName: 'Keep this group',
      createdAt: 1,
      updatedAt: 2,
    };
    useLibraryStore.getState().setLibrary([book]);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE opds_source_mappings (catalog_id TEXT, source_url TEXT, book_hash TEXT, PRIMARY KEY (catalog_id, source_url))',
    );
    const appService = {
      exists: async () => true,
      openFile: async () => new File([bytes], `alice.${format.toLowerCase()}`),
      saveLibraryBooks: vi.fn(async () => {}),
      openDatabase: async () => ({
        execute: async (sql: string, parameters: string[]) => {
          db.prepare(sql).run(...parameters);
        },
        select: async <T>(sql: string, parameters: string[]): Promise<T[]> =>
          db.prepare(sql).all(...parameters) as unknown as T[],
        close: async () => {},
      }),
    } as unknown as AppService;
    try {
      live.uploads = 0;
      env.appService = appService;
      const { unmount } = renderHook(() => useCatalogAutoUpload());
      const deadline = Date.now() + 90_000;
      await act(async () => {
        while (Date.now() < deadline) {
          if (
            useLibraryStore.getState().getBookByHash(book.hash)?.metadata?.catalogSource &&
            !Object.values(useCatalogUploadStore.getState().receipts).length
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      });
      unmount();
      expect(
        useLibraryStore.getState().getBookByHash(book.hash)?.metadata?.catalogSource?.bookId,
        `Disposable CWA request results: ${JSON.stringify(live.requests)}; pending: ${JSON.stringify(Object.values(useCatalogUploadStore.getState().receipts).map((receipt) => ({ state: receipt.state, fingerprint: receipt.fingerprint })))}`,
      ).toBeTruthy();
      const remote = await listCatalogUploadBooks(targetId);
      expect(remote).toHaveLength(1);
      if (format === 'PDF') expect(remote[0]!.formats).toContain('EPUB');
      expect(Object.values(useCatalogUploadStore.getState().receipts)).toHaveLength(0);
      const publicationIds = remote[0]!.sourceUrls.filter((url) => url.startsWith('urn:'));
      expect(publicationIds).toHaveLength(1);
      expect(
        (
          await findBookByOPDSSources(appService, {
            catalogId: 'live-opds',
            sourceUrls: publicationIds,
            library: useLibraryStore.getState().library,
          })
        )?.hash,
      ).toBe(book.hash);
      expect(useLibraryStore.getState().visibleLibrary).toHaveLength(1);
      expect(useLibraryStore.getState().visibleLibrary[0]).toMatchObject({
        hash: book.hash,
        progress: [4, 20],
        groupName: 'Keep this group',
        sourceTitle: 'Original local file',
        format,
      });
      expect(live.uploads).toBe(1);
      console.info(
        'CWA format verification:',
        JSON.stringify({
          input: format,
          stored: remote[0]!.formats,
          uploads: live.uploads,
          linked: true,
        }),
      );
    } finally {
      db.close();
    }
  }, 120_000);
});
