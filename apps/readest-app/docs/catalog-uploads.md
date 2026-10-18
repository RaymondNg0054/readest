# Uploading to a catalog

OPDS defines browsing and acquiring publications, not a universal book-upload
endpoint. Readest therefore uploads through server-specific adapters. The first
adapter supports the web upload protocol
used by **Calibre-Web and Calibre-Web Automated (CWA)**. Other catalogs remain
read-only unless a supported adapter is configured.

## Configure an upload destination

In **Settings → Integrations → OPDS Catalogs**, add or edit your catalog, use its
`/opds` URL (including any reverse-proxy prefix), and select
**Upload protocol → Calibre-Web / Calibre-Web Automated**. Put credentials in
the username/password fields, not in the URL. There is no separate Calibre
content source. Browse Calibre libraries through their OPDS catalogs; the official
Calibre Content Server is not an upload destination for this adapter.

The server must allow regular username/password login, uploads must be enabled,
and the account needs upload permission. OAuth-only/SSO login is not implemented.
Uploads require the **desktop or mobile app**: native HTTP is needed for the web
session and CSRF-protected form. Uploads are disabled in the browser app. Ordinary
OPDS browsing and validation retain their existing proxy behavior and consent
warning; native catalog uploads connect directly to the configured server.

## Automatic uploads

Once the library is loaded, Readest automatically sends existing and newly imported
local books to configured upload destinations. No book selection or Readest Cloud
account is needed. OPDS catalogs opt in by selecting an upload protocol. Set the
catalog's upload protocol to **None** to stop automatic uploads.

Only local ebook files are sent. Deleted books, streaming audio, books already
linked to a catalog, pending uploads, and files acquired from the destination
OPDS catalog are skipped. Checks pause while offline or hidden and retry
periodically. Upload destinations for the same server/account are deduplicated.
A Readest entry can be linked to one catalog; it is not mirrored to every server.

There is no per-book catalog upload action, status popup, or manual linking step.
The worker belongs to the shared app lifecycle, so navigation between the library,
reader and settings does not stop it. Secondary reader windows do not start a
second upload worker.

**Upload to Cloud** still targets Readest Cloud or enabled file mirrors; catalog
uploads run independently.

Standard Calibre-Web normally returns the new book ID immediately. Readest links
that ID to the existing local entry automatically.

### Calibre-Web Automated ingestion

CWA normally queues ingestion and returns a Tasks page rather than a book ID.
Readest checks pending uploads in the background and links a unique verified
server copy automatically. No catalog dialog or book selection is required.

Verification compares SHA-256 fingerprints of the uploaded and downloaded files.
For text books, Readest can also compare the complete normalized reading text,
so EPUB repackaging, metadata changes and whitespace changes do not require a
manual link. Titles only narrow the search; they never prove a match. Recently
modified entries are checked too, even if the server changed their titles.
An exact file hash remains available for binary or unparseable books.

Checks run every five seconds initially, then every five minutes for slow or
unresolved uploads, while the main app is visible and online. Pending receipts
and fingerprints are saved on this device, so checks resume after a restart.
Existing receipts from older versions are also checked without resending files.
New upload receipts wake the completion checks immediately. Completion checks
require the OPDS catalog to remain enabled with its upload protocol configured.
Automatic imports for the same catalog/account stay paused for up to 24 hours
until linking finishes, preventing a second Readest entry for the server copy.

If several server copies have identical content, or server conversion changed
the content so it cannot be verified, Readest keeps the receipt rather than
guessing, resending the file, or asking the user to link it. Verification keeps
retrying internally. Such receipts pause imports from that catalog for up to
24 hours; afterwards imports resume and an unverified server copy may appear
as a visible second entry instead of stalling the catalog silently. Removing
the manual UI does not fix the format-verification limitations listed below.
Entries with files or reading data are never discarded to force a link.

## What linking preserves

Linking keeps the original Readest hash, managed filename, file format, groups,
reading position, and annotation/config keys. It records the remote identity and
OPDS source mappings; a stable publication ID also survives server-side format
conversion. OPDS imports recognize that same local entry instead of importing
the server copy again.

An empty duplicate source stub can be hidden, but an entry with downloaded files,
groups, progress, or annotations is not discarded. Readest does not request server
book deletion or merging. CWA may still convert or auto-merge uploads according to
its own ingestion settings. Local metadata edits and annotations are not written
back to the server.

## Failures and retries

Login/CSRF checks happen before sending the file, and TLS validation stays enabled.
Session cookies are kept in memory and bound to the configured server. Pending
receipts contain no passwords or session cookies.

A file upload is not idempotent. If the response is lost after sending it, Readest
keeps an **unknown result** receipt instead of sending the file again. Background
verification can still find and link the accepted copy without another upload.
Pending receipts remain internal duplicate-upload guards; they are not cleared
just to hide an unfinished operation. Explicit server rejections such as HTTP 403
or 413 allow an automatic retry after the problem is fixed.

## Verification

Unit tests cover automatic uploads on library load and import, OPDS upload settings,
offline/hidden pauses, retry backoff, source-map loop prevention, capabilities,
session/CSRF authentication, permissions, redirects, queue receipts, retry safety,
automatic linking, repackaged EPUB content verification, ambiguous matches,
source mappings, local-state preservation, absence of manual catalog controls,
and the worker's shared app lifecycle across navigation.
Browser tests cover narrow/wide layouts, light/dark mode, RTL, and e-ink.

### Format audit (2026-10-18)

The completion worker handles all eleven local ebook formats, but that does not
mean every CWA conversion can be verified. A disposable-server audit with public
Alice fixtures and the server's default upload allowlist found:

| Input | Observed result |
| --- | --- |
| EPUB | Processing and automatic linking passed |
| PDF, MOBI, AZW, AZW3 | Conversion to EPUB and automatic linking passed |
| FB2, CBZ, TXT, HTML | CWA created an EPUB, but automatic linking remained pending |
| FBZ, MD | Upload rejected by this server's default allowlist |

These are representative sample results, not a guarantee for every file or CWA
configuration. The AZW fixture was an unencrypted MOBI-compatible file. DRM was
not tested. Short converted documents and image-only books can lack a usable
text fingerprint; CWA conversions that change reading text can also prevent a
match. The worker fix alone does not solve those verification gaps.

The optional HTTP integration test requires an **empty disposable CWA instance**
on a loopback address, using the default test account `admin` / `admin123`:

```bash
cd apps/readest-app
READEST_CWA_TEST_URL=http://127.0.0.1:18083 pnpm test --run --maxWorkers=1 src/__tests__/services/catalog-upload-live.test.ts
```

To check CWA's PDF → EPUB conversion and automatic linking, use a fresh empty
instance and also set `READEST_CWA_TEST_FORMAT=PDF`.

Other format checks use `READEST_CWA_TEST_FORMAT` with one of the local ebook
formats and `READEST_CWA_TEST_FILE` pointing to a matching fixture. Use an empty
disposable library for each check so identical editions from earlier cases do
not create ambiguous matches.

It uploads the public-domain Alice fixture through an OPDS-configured target
to the real server and verifies ingestion, automatic linking without a confirmation
action, and source mappings in SQLite.
The native HTTP bridge is replaced with Node HTTP, and the local file/library
persistence adapter is in memory. It does not verify native IPC, device filesystems,
or iOS. Without the environment variable it is skipped. Never point it at a personal
library.
