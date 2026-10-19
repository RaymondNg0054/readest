# Calibre library source

Feature request: [#6481](https://github.com/readest/readest/issues/6481).

In **Settings → Integrations → Calibre**, choose **Calibre Content Server** or
**Calibre-Web**, enter the server's base URL and optional HTTP credentials, then
connect, choose a library, and save. Include any reverse-proxy mount prefix in
the URL, but not `/opds` or `/ajax`. Connections are configured on each device;
their credentials are not sent through Readest's proxy or settings replica.
Use HTTPS on networks you do not trust. Certificate validation is not disabled.

## Library and downloads

- Sync imports lightweight metadata-only rows. They appear in the normal library,
  including search, Series grouping and Tag grouping. No ebook files are downloaded
  until you open a book or choose Download from its context menu.
- The context menu offers each format that both the server and Readest support.
  The selected format is tried first. Only a server **404** triggers fallback to
  another advertised format. Authentication, network and disk errors do not.
- Metadata and tags flow **from the server to Readest**. Local metadata edits are
  not sent; a later sync replaces them. Book files can be sent (see below). Local groups, reading progress,
  annotations, deleted-book tombstones and downloaded files are preserved.
- A completed sync marks books no longer advertised by the server as unavailable,
  without deleting their files or annotations. Failed, malformed or incomplete
  catalog requests never mark books removed. Missing advertised *files* produce a
  separate download error.
- Sync status, progress and added/updated/removed counts appear on the connection
  in Settings. **Sync Now** performs a full metadata refresh. Automatic checks run
  every five minutes while the library is visible and online.
- Disconnecting retains library rows and downloaded copies. Undownloaded rows need
  the same connection re-added before they can be opened, or can be deleted manually.

## Duplicates and sending local books

A server book that is already in Readest is **linked** to the existing row instead
of getting a second one. Books match like Calibre's own duplicate check: the same
title, ignoring case, punctuation and a leading article, and a shared author,
ignoring name order. The linked row keeps its file, progress, notes and groups;
server metadata and tags apply from then on. A metadata-only row is tombstoned
when a local copy of the same book appears, including one synced from another
device.

**Send Local Books to Calibre** is on by default for connections with a username.
Each sync sends local ebook files the server does not list, and a newly imported
book triggers a sync right away. Deleted books, audiobooks, feed books, demo books
and files that are only in the cloud are not sent. Readest never deletes server
books.

- **Calibre Content Server** uses its `cdb/add-book` API with duplicates refused.
  The new book id is linked at once. If Calibre reports a duplicate that Readest's
  match missed, the book is linked to the server record Calibre matched.
- **Calibre-Web** has no upload API. Readest signs in through its login form and
  posts its upload form with the CSRF token, keeping the session cookie itself.
  This needs the desktop or mobile app: browsers do not let a page send cookies to
  another site. Standard Calibre-Web returns the new book id. Calibre-Web Automated
  queues ingestion without one, so the book is marked as sent and linked when a
  later sync lists it. Calibre-Web Automated does not refuse duplicates itself, so
  a marked book is never sent again, even if ingestion changes its title.

The account needs write or upload permission. A file the server refuses (format,
size) is skipped until the app restarts. Other errors stop sending and show on the
connection.

## Reading positions

**Sync Reading Position** is opt-in. It supports EPUBs on an authenticated,
writable official Calibre Content Server through its last-read-position API.
The latest remote device position is read before any local write; page turns are
debounced, with a flush on the reader's existing manual/close sync event. A failed
pull does not authorize overwriting an unread remote position. Local reading
continues normally and the position can be retried on the next open.

Calibre's viewer writes CFIs as `epubcfi(/12/2/4/...)`: the spine step, then a
path from the document node. Readest uses `epubcfi(/6/12!/4/...)`, so the client
converts in both directions. Calibre's web viewer applies another device's
position when a book is first opened in that browser, or from its **Sync** action.

Calibre-Web's OPDS API has **no reading-position write endpoint**, so Calibre-Web
connections have no position sync. Kobo sync (#4411) is a
separate protocol and is not implemented here. Non-EPUB positions are not synced:
Calibre's converted-format CFIs do not address the same document as Readest's.

## Large libraries and browser access

Official-server IDs are paginated and metadata is fetched in batches of 50 with
category expansion disabled. In-session automatic checks reuse unchanged metadata
and query recently modified books, with an overlapping date window. Calibre-Web
walks its acquisition feed and revalidates cached pages using ETag/Last-Modified
when the server provides them. A cold start does a full walk; no count-only probe
is used, since it would miss edits and remove/add pairs. Covers are fetched with
authentication only as they approach the viewport, not once per catalog entry.

The web app connects **directly** to the configured server, which must allow the
app origin, Authorization and conditional-request headers in its CORS policy.
An HTTPS app cannot connect to a plain-HTTP server. Use the native app for LAN
servers that cannot provide those browser permissions. Native HTTP supports Basic
and Calibre's Digest challenge authentication.

## Verification checklist

Use a disposable library/account, not a production library:

1. Connect to each server type, including an authenticated reverse-proxy subpath.
2. Sync multiple pages, search by title, group by Tag, and open a metadata-only row.
3. Select PDF explicitly; remove that server file and confirm EPUB fallback. Remove
   all advertised files and confirm the distinct missing-files error. A bad password
   must not trigger format fallback.
4. Change tags/title, add and remove books, then sync. Confirm local notes and copies
   survive; interrupt a paginated response and confirm no removals are applied.
5. Import a book the server has and one it lacks, then connect: the first is
   linked, the second is sent once and linked. Import the file of a metadata-only
   row: one row remains. On Calibre-Web Automated, confirm a queued upload is not
   sent again before ingestion finishes.
6. Opt into EPUB position sync on the official server. Read in both clients, close
   quickly while a pull is pending, and verify no stale opening position is pushed.
7. Check mobile/desktop widths, dark mode, RTL and e-ink. In the browser, test CORS
   refusal and mixed-content refusal as well as a CORS-enabled server.
