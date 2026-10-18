import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogUploadTarget } from '@/types/catalogUpload';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: transport.fetch }));
vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isTauriAppPlatform: () => true,
}));
import { createCalibreWebUploadAdapter } from '@/services/catalogs/calibreWebUpload';

const target: CatalogUploadTarget = {
  id: 'target',
  name: 'CWA',
  protocol: 'calibre-web',
  url: 'https://books.test/prefix',
  username: 'reader',
  password: 'secret',
  catalogIds: [],
};
const login = () =>
  new Response(
    '<form><input name="csrf_token" value="login-token"><input name="username"></form>',
    { headers: { 'Set-Cookie': 'session=prelogin; Path=/prefix; HttpOnly; Secure' } },
  );
const signedIn = () =>
  new Response(
    '<form id="form-upload"><input name="csrf_token" value="upload-token"><input type="file" name="btn-upload"></form>',
  );
const authenticate = () =>
  transport.fetch
    .mockResolvedValueOnce(login())
    .mockResolvedValueOnce(
      new Response('', {
        status: 302,
        headers: {
          Location: '/prefix/',
          'Set-Cookie': 'session=signed-in; Path=/prefix; HttpOnly; Secure',
        },
      }),
    )
    .mockResolvedValueOnce(signedIn());

beforeEach(() => {
  transport.fetch.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('Calibre-Web upload protocol', () => {
  it('downloads a verification copy directly with the configured account and no borrowed session', async () => {
    transport.fetch.mockResolvedValueOnce(new Response('ebook'));
    const file = await createCalibreWebUploadAdapter({
      ...target,
      id: 'verification-copy',
    }).getBookFile('12', 'EPUB');
    expect(await file.text()).toBe('ebook');
    const [url, options] = transport.fetch.mock.calls[0]!;
    expect(url).toBe('https://books.test/prefix/opds/download/12/epub/');
    expect(options.credentials).toBe('omit');
    expect(new Headers(options.headers).get('Cookie')).toBe('');
    expect(new Headers(options.headers).get('Authorization')).toMatch(/^Basic /);
    expect(options.maxRedirections).toBe(0);
    expect(options.danger).toBeUndefined();
  });

  it('keeps a stable publication identifier in the source mapping when formats change', async () => {
    transport.fetch.mockResolvedValueOnce(
      new Response(
        '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:uuid:stable</id><title>Book</title><link rel="http://opds-spec.org/acquisition" href="/prefix/opds/download/12/epub/"/></entry></feed>',
      ),
    );
    const books = await createCalibreWebUploadAdapter({ ...target, id: 'listing' }).listBooks();
    expect(books[0]?.sourceUrls).toContain('urn:uuid:stable');
  });
  it('uses session cookies and CSRF tokens, then submits exactly one multipart upload to CWA', async () => {
    authenticate().mockResolvedValueOnce(Response.json({ location: '/prefix/tasks' }));
    const onSend = vi.fn();
    expect(
      await createCalibreWebUploadAdapter(target).upload(new File(['ebook'], 'book.epub'), onSend),
    ).toEqual({});
    expect(transport.fetch).toHaveBeenCalledTimes(4);
    const calls = transport.fetch.mock.calls;
    expect(calls[0]?.[0]).toBe('https://books.test/prefix/login');
    expect(new Headers(calls[0]?.[1].headers).get('Cookie')).toBe('');
    const loginOptions = calls[1]?.[1];
    expect(new Headers(loginOptions.headers).get('Cookie')).toBe('session=prelogin');
    expect(new URLSearchParams(loginOptions.body).get('csrf_token')).toBe('login-token');
    expect(new URLSearchParams(loginOptions.body).get('password')).toBe('secret');
    const options = calls[3]?.[1];
    expect(calls[3]?.[0]).toBe('https://books.test/prefix/upload');
    expect(new Headers(options.headers).get('Cookie')).toBe('session=signed-in');
    expect(new Headers(options.headers).get('Content-Type')).toBeNull();
    expect(options.body).toBeInstanceOf(FormData);
    expect((options.body as FormData).get('csrf_token')).toBe('upload-token');
    expect(((options.body as FormData).get('btn-upload') as File).name).toBe('book.epub');
    expect(options.danger).toBeUndefined();
    expect(options.redirect).toBe('manual');
    expect(options.maxRedirections).toBe(0);
    expect(onSend).toHaveBeenCalledTimes(1);
  });
  it('returns the explicit book ID from standard Calibre-Web instead of guessing from metadata', async () => {
    authenticate().mockResolvedValueOnce(Response.json({ location: '/prefix/admin/book/42' }));
    expect(
      await createCalibreWebUploadAdapter({ ...target, id: 'standard' }).upload(
        new File(['ebook'], 'book.epub'),
        () => {},
      ),
    ).toEqual({ bookId: '42' });
  });
  it('does not send a file when credentials or the server upload permission are rejected', async () => {
    transport.fetch
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(new Response('Denied', { status: 401 }));
    const onSend = vi.fn();
    await expect(
      createCalibreWebUploadAdapter({ ...target, id: 'bad-auth' }).upload(
        new File(['ebook'], 'book.epub'),
        onSend,
      ),
    ).rejects.toThrow();
    expect(onSend).not.toHaveBeenCalled();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    transport.fetch.mockReset();
    transport.fetch
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { Location: '/prefix/', 'Set-Cookie': 'session=limited; Path=/prefix; Secure' },
        }),
      )
      .mockResolvedValueOnce(new Response('<input name="csrf_token" value="token">'));
    await expect(
      createCalibreWebUploadAdapter({ ...target, id: 'limited' }).upload(
        new File(['ebook'], 'book.epub'),
        onSend,
      ),
    ).rejects.toThrow('upload');
    expect(onSend).not.toHaveBeenCalled();
  });
  it('never follows a foreign login redirect or accepts a foreign upload result', async () => {
    transport.fetch
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(
        new Response('', { status: 302, headers: { Location: 'https://evil.test/' } }),
      );
    await expect(
      createCalibreWebUploadAdapter({ ...target, id: 'redirect' }).upload(
        new File(['ebook'], 'book.epub'),
        () => {},
      ),
    ).rejects.toThrow();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    transport.fetch.mockReset();
    authenticate().mockResolvedValueOnce(Response.json({ location: 'https://evil.test/book/42' }));
    await expect(
      createCalibreWebUploadAdapter({ ...target, id: 'response' }).upload(
        new File(['ebook'], 'book.epub'),
        () => {},
      ),
    ).rejects.toThrow();
    expect(transport.fetch).toHaveBeenCalledTimes(4);
  });
  it('does not retry a non-idempotent upload on HTTP 400, 401 or a lost response', async () => {
    for (const status of [400, 401, 500]) {
      transport.fetch.mockReset();
      authenticate().mockResolvedValueOnce(new Response('Failed', { status }));
      await expect(
        createCalibreWebUploadAdapter({ ...target, id: `status-${status}` }).upload(
          new File(['ebook'], 'book.epub'),
          () => {},
        ),
      ).rejects.toThrow();
      expect(transport.fetch).toHaveBeenCalledTimes(4);
    }
  });
});
