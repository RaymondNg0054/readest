import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { catalogFingerprintsMatch, fingerprintCatalogFile } from '@/services/catalogs/fingerprint';

const bytes = readFileSync('src/__tests__/fixtures/data/sample-alice.epub');
const original = () => new File([bytes], 'alice.epub', { type: 'application/epub+zip' });

describe('catalog upload file identity', () => {
  it('recognizes a repackaged EPUB without depending on its ZIP bytes or package identifiers', async () => {
    const entries = unzipSync(bytes);
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('.opf')) {
        entries[name] = strToU8(
          strFromU8(data).replace(
            /(<dc:identifier\b[^>]*>)[^<]*/g,
            '$1urn:uuid:server-replaced-identifier',
          ),
        );
      } else if (/<html\b/.test(strFromU8(data))) {
        entries[name] = strToU8(strFromU8(data).replace(/>\s*</g, '>\n  <'));
      }
    }
    const repacked = new File([zipSync(entries)], 'converted.epub');
    const [local, remote] = await Promise.all([
      fingerprintCatalogFile(original()),
      fingerprintCatalogFile(repacked),
    ]);
    expect(local.sha256).not.toBe(remote.sha256);
    expect(local.textSha256).toBeTruthy();
    expect(remote.textSha256).toBe(local.textSha256);
    expect(catalogFingerprintsMatch(local, remote)).toBe(true);
  });

  it('does not match another book merely because its title and author are the same', async () => {
    const entries = unzipSync(bytes);
    for (const [name, data] of Object.entries(entries)) {
      if (/<html\b/.test(strFromU8(data))) {
        entries[name] = strToU8(strFromU8(data).replace(/Alice/g, 'NotAlice'));
      }
    }
    const [local, remote] = await Promise.all([
      fingerprintCatalogFile(original()),
      fingerprintCatalogFile(new File([zipSync(entries)], 'different.epub')),
    ]);
    expect(local.textSha256).toBeTruthy();
    expect(remote.textSha256).not.toBe(local.textSha256);
    expect(catalogFingerprintsMatch(local, remote)).toBe(false);
  });

  it('matches unchanged binary files without parsing or requiring a title', async () => {
    const [local, remote] = await Promise.all([
      fingerprintCatalogFile(new File(['binary book'], 'local.pdf')),
      fingerprintCatalogFile(new File(['binary book'], 'remote.pdf')),
    ]);
    expect(local.textSha256).toBeUndefined();
    expect(catalogFingerprintsMatch(local, remote)).toBe(true);
  });

  it('does not treat two empty or unreadable text bodies as a content match', async () => {
    const [local, remote] = await Promise.all([
      fingerprintCatalogFile(new File(['one'], 'one.epub')),
      fingerprintCatalogFile(new File(['two'], 'two.epub')),
    ]);
    expect(local.textSha256).toBeUndefined();
    expect(remote.textSha256).toBeUndefined();
    expect(catalogFingerprintsMatch(local, remote)).toBe(false);
  });
});
