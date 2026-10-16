# Workflow: open data from a link (for portal and dashboard authors)

[← Docs index](../index.md) · [← README](../../README.md)

Another web page (a data portal, a sample dashboard, a notebook, an e-mail)
can open a set of remote files in FiberBrowser with one link (a `?session=`
URL, as other web genome browsers offer): the reads, bigWig/bigBed tracks, the
genome and the locus. FiberBrowser shows the user what the link would open
and loads nothing until they press **Open**.

- [1. The link](#1-the-link)
- [2. The session document](#2-the-session-document-fiberbrowsersession-linkv1)
- [3. Track hubs (`?hub=`)](#3-track-hubs-hub)
- [4. Pre-signed URLs](#4-pre-signed-urls)
- [5. The `fiberbrowser://` scheme (Mac app, Linux, Windows)](#5-the-fiberbrowser-scheme)
- [6. Security model](#6-security-model)
- [7. Public servers: allowing link hosts](#7-public-servers-allowing-link-hosts)

## 1. The link

| Form | Use |
| --- | --- |
| `http://localhost:8000/?session=<URL of a session JSON>` | A FiberBrowser running on the user's computer (the port is the one it prints). |
| `http://localhost:8000/?session=data:application/json;base64,<...>` | A short list inline, no file to host (base64 or base64url of the JSON, or `data:application/json,<url-encoded JSON>`; up to 256 KB). |
| `http://localhost:8000/?hub=<URL of hub.txt>&genome=hg38` | A UCSC-style track hub ([section 3](#3-track-hubs-hub)). |
| `fiberbrowser://open?session=<URL>` | The FiberBrowser app, or whichever FiberBrowser the user runs ([section 5](#5-the-fiberbrowser-scheme)). |
| `https://browser.example.org/?session=<URL>` | A public FiberBrowser server whose operator allows your host ([section 7](#7-public-servers-allowing-link-hosts)). |

`?sessionURL=` is accepted as a synonym of `?session=`, and `/open?...` is the
same as `/?...`. URL-encode the value (`encodeURIComponent`). A server
published under a URL prefix (`--root-path`, e.g. behind a cluster's web portal) takes
the same query at its prefix: `https://host/rnode/node7/8000/?session=...`.

What the user sees: the address bar loses the link (it may carry pre-signed
URLs), and a dialog asks **Review a link from data.example.org?** (nothing
has been fetched yet). **Review the link** reads the document, and the dialog
then asks **Open 12 tracks from data.example.org?**, listing
where the document comes from, the genome, the locus and every track (type,
group and sample, size when the document gives it, a mark on pre-signed
links), each with a tick box. Tracks with `"visible": false` are listed
unticked. **Open** loads the ticked tracks; **Cancel** discards the link.

FiberBrowser reads the files itself (the server, not the page), so they need
no CORS headers, but they must allow HTTP range requests (`Accept-Ranges:
bytes`), as for any remote BAM, bigWig or bigBed. BAMs need an index.

## 2. The session document (`fiberbrowser.session-link.v1`)

```json
{
  "schema": "fiberbrowser.session-link.v1",
  "title": "Donor A, chr7 locus",
  "genome": "hg38",
  "locus": "chr7:5,527,000-5,531,000",
  "tracks": [
    {
      "url": "https://data.example.org/donorA/s12.bam",
      "index_url": "https://data.example.org/donorA/s12.bam.bai",
      "type": "bam",
      "name": "Sample 12",
      "sample": "S12",
      "group": "Donor A",
      "color": "#1f77b4",
      "size": 48213772288
    },
    { "url": "https://data.example.org/donorA/s12.fire-peaks.bb", "name": "FIRE peaks" },
    { "url": "https://data.example.org/donorA/s12.coverage.bw", "name": "Coverage", "color": "31,119,180" },
    { "url": "https://data.example.org/donorA/extra.bb", "name": "Extra", "visible": false }
  ]
}
```

Top level:

| Field | Required | Meaning |
| --- | --- | --- |
| `schema` | recommended | `"fiberbrowser.session-link.v1"`. Other values are refused; a missing one is read as v1 with a warning. |
| `title` | no | Shown in the dialog. |
| `genome` | no | A genome FiberBrowser knows by name (`hg38`, `hg19`, `mm39`, `mm10`, `dm6`, `sacCer3`), or `{"fasta": <URL>, "fai": <URL>, "name": <label>}` (local servers only; the FASTA is downloaded to the genome cache). Omitted: the current genome is kept. |
| `locus` | no | `chr:start-end` (commas allowed), `chr:position`, or a gene name (found by the browser's gene search). |
| `tracks` | yes (unless only a genome) | Up to 1000 listed; a server opens at most 100 (public servers 20) at once. |

Each track:

| Field | Meaning |
| --- | --- |
| `url` | `https://` (or `http://`, `s3://` on local servers). Relative URLs resolve against the document's own URL. Local paths and `file:` are never accepted. `ssh://[user@]host/path` files on a cluster are listed, but FiberBrowser never connects to a cluster from a link: the dialog offers **Connect to host…** (the usual [Connect to cluster](remote-cluster-data.md) dialog, which the user completes), and the file can be ticked once connected. |
| `index_url` | The BAM's `.bai`/`.csi`. Required when the BAM URL is pre-signed (its index can't be derived); otherwise `<bam>.bai`, `<stem>.bai` and `<bam>.csi` are tried. |
| `type` | `bam`, `bigbed`, `bigwig`, `bed` or `plasmid` (a GenBank/SnapGene plasmid map). Inferred from the extension (`.bam`, `.bb`/`.bigBed`, `.bw`/`.bigWig`, `.bed`/`.bed.gz`, `.gb`/`.gbk`/`.dna`) when missing. CRAM, VCF and .hic are not supported. |
| `as` | For a bigBed: `reads` (per-molecule records, opened as a dataset) or `annotation` (an annotation track). Default: a bigBed whose autoSql FiberBrowser recognises as per-read FiberHMM layers opens as reads, others as annotation. |
| `name` | Label (default: the file name). |
| `sample`, `group` | Shown in the dialog next to the track. |
| `color` | `#rrggbb`, `#rgb`, `r,g,b` or `rgb(r,g,b)`: the track's colour, or the dataset header's. |
| `size` | Bytes, shown in the dialog before anything is read (FiberBrowser does not contact track hosts before the user confirms). |
| `visible` | `false`: listed but unticked. |

BAMs and per-read bigBeds become datasets (reads); bigWigs signal tracks;
bigBeds and BED files annotation tracks; plasmid maps extra chromosomes.
BED files and plasmid maps are downloaded (up to 20 MB each).

## 3. Track hubs (`?hub=`)

`?hub=<hub.txt URL>` reads the hub the UCSC way: `hub.txt` → `genomes.txt`
(or a `useOneFile on` hub) → the genome's `trackDb.txt`, following `include`
lines. The genome is `&genome=` if given, else the loaded genome if the hub
has it, else the hub's first; it must be one FiberBrowser knows (assembly
hubs with their own `twoBitPath` are refused). `defaultPos` becomes the locus.

Read from `trackDb.txt`: `track`, `bigDataUrl`, `bigDataIndex`, `type`,
`shortLabel` (the name), `longLabel`, `color`, `visibility`, `parent`
(`parent X on|off`), `compositeTrack on`, `superTrack on` (and the older
`superTrack <name> show|hide` child form), `container multiWig`, `view`
subgroups and `decorator.default.bigDataUrl`. Settings are inherited from
parents as in the UCSC browser. A track's group is its outermost composite,
super track or multiWig container. Tracks hidden by `visibility hide` or
`parent X off` are listed unticked.

| trackDb `type` | Opens as |
| --- | --- |
| `bigBed ...`, `bigNarrowPeak`, `bigGenePred`, `bigPsl`, `bigLolly`, `bigBarChart`, ... | bigBed annotation track |
| `bigWig ...` (including multiWig children) | bigWig signal track |
| `bam` | BAM dataset (reads), with `bigDataIndex` as its index |
| `decorator.default.bigDataUrl` | an extra, unticked bigBed "(decorations)" track |
| `vcfTabix`, `hic`, `bigChain`, `bigMaf`, tracks without `bigDataUrl` | skipped (the dialog says how many) |

For fibertools-rs / FIRE hubs see
[fibertools and FIRE data](fibertools-fire-data.md).

## 4. Pre-signed URLs

A pre-signed URL (`...?X-Amz-Signature=...`, `?sig=...`, `?token=...`) is a
credential with an expiry. FiberBrowser treats it that way:

- The full URL is kept only in the server's memory while it runs. Everything
  else sees it without its query string (`https://host/path/file.bam`): the
  page, the dataset and track lists, saved sessions and autosaves, the
  history, the recent-tracks list and the server's output and logs.
- A pre-signed BAM needs its own pre-signed `index_url`.
- When a link's expiry is known (`X-Amz-Date` + `X-Amz-Expires`,
  `X-Goog-Date` + `X-Goog-Expires`, `Expires=`, `se=`), a banner warns 10
  minutes before; when a host refuses a file (401/403, found with a one-byte
  range read), the banner says **Link expired** and names the files: reopen
  the link from its source.
- A session saved with such files (or restored after FiberBrowser restarted)
  holds only the display form; opening it says the link expired and must be
  reopened from the source.

htslib (which reads BAMs) prints the URL of a file it can't open; FiberBrowser
turns htslib's messages off while it opens files from a link, but a later
read error may still show a full URL in the server's terminal.

## 5. The `fiberbrowser://` scheme

`fiberbrowser://open?session=<URL>` (also `?hub=<URL>&genome=<name>`) hands the
link to FiberBrowser without knowing its port:

- **Mac app**: FiberBrowser.app registers the scheme (`CFBundleURLTypes` in
  `packaging/macos/FiberBrowser.spec`). The link starts the app if needed,
  is staged on the app's own server and opens in a new app window, where the
  user confirms.
- **Any install** (pip, conda): `fiberbrowser --open-link '<fiberbrowser://...>'`
  stages the link on the newest FiberBrowser this user is running (found in
  `~/.fiberhmm/browser_runtime.json`, with its access token), or starts one,
  and opens the confirmation page in the web browser.
- **Linux** (optional): register it as the handler with a desktop entry,
  `~/.local/share/applications/fiberbrowser-link.desktop`:

  ```ini
  [Desktop Entry]
  Type=Application
  Name=FiberBrowser link
  Exec=fiberbrowser --open-link %u
  MimeType=x-scheme-handler/fiberbrowser;
  NoDisplay=true
  ```

  then `xdg-mime default fiberbrowser-link.desktop x-scheme-handler/fiberbrowser`.
- **Windows** (optional): a per-user registry entry (save as a `.reg` file,
  with the path of your `fiberbrowser.exe`):

  ```
  Windows Registry Editor Version 5.00

  [HKEY_CURRENT_USER\Software\Classes\fiberbrowser]
  @="URL:FiberBrowser link"
  "URL Protocol"=""

  [HKEY_CURRENT_USER\Software\Classes\fiberbrowser\shell\open\command]
  @="\"C:\\Path\\To\\fiberbrowser.exe\" --open-link \"%1\""
  ```

The handler only stages the link and opens the confirmation page; it never
opens the files itself.

## 6. Security model

A local FiberBrowser can read the user's files and run programs, and any web
page in the user's browser can link to it. The link flow is built so that a
page can put a question in front of the user but can't make FiberBrowser
load anything, and so that the access token stays as strict as before:

1. **Landing (no token).** A link from another site arrives without the
   access cookie (it is `SameSite=Strict`, which browsers don't send on a
   navigation from another site). `/open` (and `/` with `?session=`/`?hub=`,
   which redirects there) is the only page served without the token. It
   stores the link's raw value as a *pending link* — nothing is fetched or
   loaded — under a random 144-bit id valid for 15 minutes, and goes on to
   `/?open_link=<id>`. That navigation starts from FiberBrowser's own page,
   so the browser now sends the cookie. At most 64 links are pending; older
   ones are dropped.
2. **Review (token).** In the signed-in tab the dialog first asks
   **Review a link from data.example.org?**, showing only what the link
   itself says (a session or a hub, and its host). Nothing is contacted
   before the user answers, not even with a DNS lookup, on local and public
   servers alike. **Review the link** fetches and validates the document
   (or the hub's files) and the dialog lists it. An inline document (the list
   is in the link) is listed at once. Track files are never contacted
   before **Open**. A browser without the token gets the usual access
   page (pasting the access link there keeps the pending link).
3. **Open (token, single use).** **Open** consumes the pending id first (a
   replay finds nothing) and loads exactly the document that was reviewed,
   not a new download. Only `https`/`http`/`s3` URLs are opened: never local
   paths or `file:`.

All fetches of link documents and hub files resolve the host once, refuse
link-local, multicast and reserved addresses (and, on public and lab servers,
private and loopback ones), connect to the address that was checked, re-check
every redirect (at most 3), and stop at 1 MB per session document and 2 MB per
hub file (at most 24 hub files). Relative file names in a document or hub file
resolve against the URL it was finally read from (after redirects).

Tour tabs never open links. `FIBERBROWSER_LINKS_DISABLE=1` turns links off.

## 7. Public servers: allowing link hosts

A `--public` server is a curated viewer, and a lab server (the `lab` profile)
is shared by its members: both open no links unless the operator lists the
hosts they may come from, and then follow the rules below.

| Setting | Meaning |
| --- | --- |
| `FIBERBROWSER_LINK_HOSTS=data.example.org,files.example.org` | Hosts (and their subdomains) whose session documents, hubs and track files the server opens. Unset: links are off. Also restricts local servers when set. |
| `FIBERBROWSER_LINK_MAX_TRACKS=20` | Most tracks one link opens (default 20 public, 100 local). |
| `FIBERBROWSER_LINKS_DISABLE=1` | No links at all. |

On a public server links must be `https` to a listed host name (not an IP
address), resolve to public addresses, and name no `s3://` or `ssh://`
files, FASTA references or plasmid maps; the genome stays the server's own. Each visitor's
tracks go into their own session.

The track files themselves (BAMs, bigWigs, bigBeds) are read by htslib and
pyBigWig, which would resolve host names and follow redirects on their own.
On public and lab servers, and on a local server with
`FIBERBROWSER_LINK_HOSTS` set, they are therefore handed a URL of a relay on
127.0.0.1 (a small helper process of the server) instead of the file's URL.
The relay reads the file for them under the same rules as the link
documents: every request resolves the host once, checks every address and
connects to the checked one, and re-checks every redirect (scheme, allowlist,
address). Status probes, BAM indexes, BED files, plasmid maps and a reference
FASTA's download go through the same rules. The relay answers only for the
files a link opened (random per-file tokens) and plain file names next to
them on the same host. Everything shown or saved carries the file's own
address, never the relay's. What is not covered: `s3://` and `ssh://` files
(links on public and lab servers can't name them), and a local server
without `FIBERBROWSER_LINK_HOSTS`, which opens link files directly (its links
may point anywhere, including the local network, by design).
