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
- Metadata and tags flow **from the server to Readest**, not the other way around.
  A later sync replaces local metadata edits. Local groups, reading progress,
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

Calibre-Web's OPDS API has **no reading-position write endpoint**. Its integration
therefore provides library metadata and downloads only. Kobo sync (#4411) is a
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
5. Opt into EPUB position sync on the official server. Read in both clients, close
   quickly while a pull is pending, and verify no stale opening position is pushed.
6. Check mobile/desktop widths, dark mode, RTL and e-ink. In the browser, test CORS
   refusal and mixed-content refusal as well as a CORS-enabled server.
