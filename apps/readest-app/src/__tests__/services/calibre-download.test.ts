import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalibreClient, CalibreHttpError } from '@/services/calibre/client';
import { CalibreFilesMissingError, downloadCalibreBook } from '@/services/calibre/download';
import { reconcileCalibreBooks } from '@/services/calibre/metadata';
import { useSettingsStore } from '@/store/settingsStore';
import type { CalibreServer } from '@/types/calibre';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';

const server: CalibreServer = {
  id: 'download',
  name: 'Test',
  url: 'https://books.test/mount',
  kind: 'calibre',
  libraryId: 'Library',
  enabled: true,
  syncProgress: false,
};
const book = () =>
  reconcileCalibreBooks(
    [],
    server,
    [{ id: '1', title: 'Book', authors: ['Author'], formats: ['EPUB', 'PDF'], tags: [] }],
    100,
  ).books[0]!;
const fs = {
  exists: vi.fn(),
  writeFile: vi.fn(),
  createDir: vi.fn(),
  copyFile: vi.fn(),
  deleteFile: vi.fn(),
};
const service = fs as unknown as AppService;
beforeEach(() => {
  useSettingsStore.setState({ settings: { calibreServers: [server] } as SystemSettings });
  fs.exists.mockResolvedValue(false);
  fs.writeFile.mockResolvedValue(undefined);
  fs.createDir.mockResolvedValue(undefined);
  fs.copyFile.mockResolvedValue(undefined);
  fs.deleteFile.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Calibre downloads', () => {
  it('tries the chosen format first then falls back only on HTTP 404, without mutating the row', async () => {
    const request = vi
      .spyOn(CalibreClient.prototype, 'request')
      .mockRejectedValueOnce(new CalibreHttpError(404))
      .mockResolvedValueOnce(new Response('ebook'));
    const stub = book();
    const snapshot = structuredClone(stub);
    const progress = vi.fn();
    expect(await downloadCalibreBook(service, stub, 'PDF', progress)).toMatchObject({
      format: 'EPUB',
    });
    expect(request.mock.calls[0]?.[0]).toContain('/get/pdf/1/Library');
    expect(request.mock.calls[1]?.[0]).toContain('/get/epub/1/Library');
    expect(stub).toEqual(snapshot);
    expect(fs.copyFile.mock.calls[0]?.[2]).toMatch(/\.epub$/);
    expect(progress).toHaveBeenCalled();
    expect(fs.deleteFile).toHaveBeenCalled();
  });
  it('distinguishes missing server files from authentication, network and disk failures', async () => {
    const request = vi
      .spyOn(CalibreClient.prototype, 'request')
      .mockRejectedValue(new CalibreHttpError(404));
    await expect(downloadCalibreBook(service, book())).rejects.toBeInstanceOf(
      CalibreFilesMissingError,
    );
    expect(request).toHaveBeenCalledTimes(2);
    request.mockClear().mockRejectedValue(new CalibreHttpError(403));
    await expect(downloadCalibreBook(service, book())).rejects.toBeInstanceOf(CalibreHttpError);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear().mockRejectedValue(new TypeError('Network failed'));
    await expect(downloadCalibreBook(service, book())).rejects.toThrow('Network failed');
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear().mockImplementation(async () => new Response('ebook'));
    fs.copyFile.mockRejectedValue(new Error('Disk full'));
    await expect(downloadCalibreBook(service, book())).rejects.toThrow('Disk full');
    expect(request).toHaveBeenCalledTimes(1);
    expect(fs.deleteFile).toHaveBeenCalled();
  });
  it('rejects login HTML and empty responses before writing a file', async () => {
    const request = vi
      .spyOn(CalibreClient.prototype, 'request')
      .mockResolvedValue(
        new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }),
      );
    await expect(downloadCalibreBook(service, book())).rejects.toThrow('login page');
    request.mockResolvedValue(new Response(''));
    await expect(downloadCalibreBook(service, book())).rejects.toThrow('empty');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
  it('keeps a downloaded file usable after its server is disconnected', async () => {
    fs.exists.mockResolvedValue(true);
    useSettingsStore.setState({ settings: { calibreServers: [] } as unknown as SystemSettings });
    expect(await downloadCalibreBook(service, book())).toMatchObject({ format: 'EPUB' });
  });
});
