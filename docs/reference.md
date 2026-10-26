# Reference

[← Docs index](index.md) · [← README](../README.md)

Command-line flags, file formats, BAM tags and layers, the dataset catalog,
the screen layout, the panels, and keyboard shortcuts.

## Command-line options

`fiberbrowser [options]` (pip install and the apps) or `python browser.py
[options]` (a source checkout) take the same options; `--help` lists them all.
With no data flags the browser starts empty; add files with **Open**.

| Flag | Description |
|------|-------------|
| `-b`, `--bam PATH` | Fiber-seq or DAF-seq BAM, or a BigBed file. Comma-separated paths (`-b a.bam,b.bam`) load as one combined dataset. |
| `--dataset PATH[:LABEL]` | Add a dataset (BAM, BigBed file, or BigBed directory) with an optional display label. Repeatable. |
| `-d`, `--bigbed_dir DIR` | Directory of BigBed files. |
| `-g`, `--gtf PATH` | Gene annotations. GTF, GFF/GFF3 and BED (BED12 exon blocks) are accepted, gzipped or not. |
| `-f`, `--fasta PATH` | Reference FASTA (needs a `.fai` index). Enables the sequence track, motif scanning and primer design. |
| `-r`, `--fire DIR` | Directory of FIRE BED files. |
| `-t`, `--tracks FILE` | Text file listing bigWig/bigBed tracks, one path per line. |
| `-c`, `--cool PATH` | `.cool` / `.mcool` contact matrix (needs `cooler`). |
| `--dafc-bigbed PATH` | BigBed of DAF-C footprints, if different from `--bam`. |
| `-p`, `--port N` | Server port (default 8000). If the port is taken, the server uses the next free port up to 99 above it (`FIBERBROWSER_PORT_MIN` / `FIBERBROWSER_PORT_MAX` set the range) and says so; it never stops another process. |
| `--force-port` | Accepted for older launch scripts; does nothing (a busy port is always skipped). |
| `--no-token` | Do not require the per-launch access token (see [Access token and workspaces](#access-token-and-workspaces)). Use it only on a single-user computer; a server listening on the network refuses to start with it. |
| `--host ADDR` | Interface to listen on. Default `127.0.0.1` (this computer only; SSH tunnels to it get the full app). `0.0.0.0` lets other machines connect with the access link, read-only; refused with the token off. `--public` defaults to `0.0.0.0`. See [Remote access and security](deployment/index.md#remote-access-and-security-personal-servers). |
| `--open-browser` | Open the UI in your web browser after startup (the default for local launches). |
| `--no-open-browser`, `--no-open` | Do not open a web browser. |
| `-s`, `--standalone` | Start without data; add files from the UI. |
| `--prefetch N` | Read-cache prefetch multiplier (default 10 = ten viewports). |
| `--max-working-reads N` | Backend-wide working-set cap for low-memory machines. `0` (default) = no cap. For per-analysis downsampling use **Analysis cap** in the sidebar instead. |
| `--plugin DIR` | Load a plugin directory (`fiberbrowser-plugin.json` + `plugin.py`). Repeatable. See [Plugins](plugins.md). |
| `--plugin-dir DIR` | Load every plugin subdirectory of `DIR`. |
| `--catalog JSON` | Dataset catalog: groups of files visitors load on demand from the sidebar. Does not imply `--public`. See [Dataset catalog](#dataset-catalog). |
| `--config TOML` | Server configuration file (`fiberbrowser serve --config ...`): profile `personal`, `public` or `lab`, host/port, root path, data roots, shared state, sign-in, runs, limits. Flags given on the command line win. See [Deploying on a server](deployment/index.md). |
| `--root-path PREFIX` | Serve under a URL prefix behind a reverse proxy (`/fiberbrowser`, Open OnDemand's `/rnode/<host>/<port>`), whether or not the proxy strips it. |
| `--public` | Web-deployment mode. Disables uploads, host file browsing, primer design, session save, shutdown and other mutating endpoints. Each visitor gets an independent browser state. Needs no token: its visitors are anonymous by design. |
| `--public-max-span-bp`, `--public-max-reads`, `--public-consensus-*`, `--public-rate-per-minute`, … | Resource limits for `--public` visitors, also settable as `FIBERBROWSER_PUBLIC_<NAME>` environment variables. Every limit and its default: [A public server](deployment/public-server.md). |
| `--trusted-proxy IP_OR_CIDR` | A reverse proxy whose `X-Forwarded-For` / `X-Forwarded-Proto` headers are believed (repeatable; also `FIBERBROWSER_TRUSTED_PROXIES`). |
| `--copilot {off,auto,mlx,ollama}` | Local Copilot backend (default `auto`). See [Local Copilot](copilot.md). |
| `--copilot-model ID` | Override the automatically chosen Copilot model. |
| `--copilot-port N` | Port for the managed `mlx_lm.server` (default 8080; the next free port is used if it is taken). |
| `--no-copilot` | Leave the Copilot out entirely: nothing is downloaded or started, the page hides it and its routes refuse (FiberBrowser.app runs this way). Same as `FIBERBROWSER_COPILOT=off`. |
| `--copilot-doctor` | Check the install and the Copilot setup, print how to fix each problem, and exit. Add `--offline` to skip the network check. |
| `--app` | Open FiberBrowser in its own app window instead of a browser tab (needs the `app` extra, pywebview). Without `--port` it uses 8756 or the next free port. |
| `--install-shortcut`, `--uninstall-shortcut` | Add FiberBrowser to the Linux application menu or the Windows Start menu (the entry opens the app window), or remove that entry, and exit. |

The `fiberbrowser` command also has subcommands for servers (see
[Deploying on a server](deployment/index.md)): `fiberbrowser serve --config
FILE` starts a server described by a config file, `fiberbrowser check-config
FILE` validates one, and `fiberbrowser users …` and `fiberbrowser audit` manage
a lab server's accounts and audit log. `fiberbrowser --open-link URL` hands a
`fiberbrowser://` link to a running FiberBrowser (see
[Open data from a link](workflows/open-from-links.md)).

### Environment variables

| Variable | Effect |
|----------|--------|
| `FIBERBROWSER_NO_OPEN=1`, `FIBERBROWSER_HEADLESS=1` | Do not open a web browser at startup. |
| `FIBERBROWSER_OPEN_BROWSER=1` | Open a web browser even when another variable would suppress it. |
| `FIBERBROWSER_PYTHON=/path/to/python` | Python used by the double-click launchers and `scripts/install.sh`. |
| `FIBERBROWSER_BAM_DIAGNOSTICS=1` | Log BAM tag parsing and layer detection. |
| `FIBERBROWSER_DAFC_DIAGNOSTICS=1` | Log contact-map loading. |
| `FIBERBROWSER_COPILOT_HOME` | Where Copilot models are stored (default `~/.fiberhmm/copilot_models/`). |
| `FIBERBROWSER_COPILOT=off` | The same as `--no-copilot`. |
| `FIBERBROWSER_TOKEN` | Fix the access token for a launch instead of a random one. |
| `FIBERBROWSER_NO_TOKEN=1` | The same as `--no-token`. |
| `FIBERBROWSER_WORKSPACE_TTL`, `FIBERBROWSER_MAX_WORKSPACES` | How long an unused independent workspace lives (seconds; default 12 hours) and how many one server keeps (default 8). |
| `FIBERBROWSER_PORT_MIN`, `FIBERBROWSER_PORT_MAX` | The range of ports tried when the requested one is busy (default: the port to 99 above it). |
| `FIBERHMM_SOURCE_DIR=/path/to/FiberHMM` | Use a FiberHMM source checkout instead of the installed package (development). The server prints the FiberHMM version and location it uses at startup. |
| `FIBERBROWSER_CONFIG` | A server configuration file, as `--config`. |
| `FIBERBROWSER_SETTINGS` | Use another settings file instead of `~/.fiberhmm/browser_settings.json`. |
| `FIBERBROWSER_NO_UPDATE_CHECK=1`, `FIBERBROWSER_UPDATE_URL` | Turn update checks off, or read the update manifest from another address (see [Updates](updates.md)). |
| `FIBERBROWSER_RECENT_TRACKS_FILE` | Where the Tracks panel keeps its **Recent** list (default `~/.fiberhmm/recent_tracks.json`). |
| `FIBERBROWSER_LIVE_LIFT=0` (or `1`) | Turn live lift off (it is on by default), or on for a lab server, where it is off by default. A public server never offers it. See [Setting up live lift and graph mode](workflows/pangenome-setup.md#live-lift-is-on). |
| `FIBERBROWSER_GRAPH_HELPER=/path/to/fiberbrowser-graph` | Use this graph helper instead of the `fiberbrowser[graph]` companion package or the macOS app's copy. |
| `FIBERBROWSER_GRAPH_PACKAGES=dir[:dir…]` | Register these graph packages at start-up. |
| `FIBERBROWSER_GRAPH_REGISTRY` | Where registered graph packages are remembered (default `~/.fiberhmm/graph_registrations.json`). |
| `FIBERBROWSER_FRONTEND_DIST` | Serve a frontend built outside the checkout (development). |

`~/.fiberhmm/browser_settings.json` holds a few per-computer settings for
source and pip runs: `fiberhmm_source_dir` (as `FIBERHMM_SOURCE_DIR`),
`require_token: false` (as `--no-token`), and the paths of external programs
(`"tools": {"blastn": "/path/to/blastn"}`; see
[Installing FiberBrowser](install.md#pip-or-pipx)). Command-line flags and
environment variables win over it.

### Access token and workspaces

Like Jupyter, a local FiberBrowser only answers its owner. Every launch makes a
random access token, and requests without it get `401`. The launchers (and
`fiberbrowser` / `python browser.py`) open the tokened link for you. The first
request with the token sets an HttpOnly, SameSite=Strict cookie, so the app
then works as usual, and the token is removed from the address bar. Without
the token, another user of a shared machine (a login or compute node, where an
`ssh -L` tunnel also lands) or anyone on the network (`--host 0.0.0.0`) cannot
read your files through the browser, start processes or stop it.

- The link changes at every launch. Your running servers and their links are
  listed in `~/.fiberhmm/browser_runtime.json` (mode 0600).
- Scripts send the `X-FiberBrowser-Token` header (or `?token=`);
  `browser_client.BrowserClient` finds the token by itself (see
  [Jupyter / Python API](jupyter-api.md)).
- Frontend development with Vite (`npm run dev`): open the backend's tokened
  link once in the same browser; the cookie then also covers the dev server's
  proxied requests.
- `--no-token` turns the check off. Use it only on a single-user computer.
- `--public` servers need no token: their visitors are anonymous and the public
  route allowlist applies instead.

**Independent workspaces.** One server can hold several isolated sessions. Open
`http://localhost:8000/?workspace=new` (or **New Independent Workspace** under
**Data & Sessions → Session**) in a browser that has opened the access link.
The new tab gets its own datasets, analyses and settings, starting from the
loaded reference genome, and changes nothing in your other tabs. A workspace
ends when you close it with its banner's button, after 12 hours unused
(`FIBERBROWSER_WORKSPACE_TTL`), or when the server stops.

### Launchers

The source checkout has double-click launchers: `Launch Browser.command`
(macOS) and `Launch Browser.sh` (Linux, or a terminal inside WSL). They use
`./.venv` (made by `scripts/install.sh`) or the first Python 3.10+ that has
FiberBrowser's packages (a native arm64 one first on Apple silicon), and print
which one they chose; `FIBERBROWSER_PYTHON` picks another. `Launch
Browser.bat` needs a Windows Python with FiberBrowser's packages, which pysam
does not allow: on Windows, use the Windows app or a checkout inside WSL.

## Supported file formats

Load any of these with **Open** (top-left), by dragging files onto the
window, with **Load by path** or **Load Remote URL** in the sidebar, or with the
CLI flags above.
The open dialog lists **Supported files** first, then one filter per kind and
**All files**. A BAM chosen together with its index uses that index, and every
file that cannot open is named. Everything you open is listed in the
[Library](workflows/library.md).

| Format | Used for | Notes |
|--------|----------|-------|
| BAM (`.bam` + `.bai` or `.csi`) | Reads and footprints | Fiber-seq (m6A) or DAF-seq (deamination). See [BAM tags and layers](#bam-tags-and-layers). Local paths, `https://` and `s3://` (any S3-compatible store; see [Lab data on S3](workflows/s3-lab-data.md)). An index at another address: `<bam>##idx##<index>`. |
| BigBed (`.bb`) | Reads and footprints | Faster than BAM for display. FiberHMM BigBeds are recognised by their `fiberhmm_*` autoSQL table (`footprint`/`nucleosome`, `msp`, `tf`, `m6a`, `m5c`, `deam`). Companion files for the same sample (e.g. `s_footprint.bb`, `s_tf.bb`, `s_msp.bb`) load as one dataset with all layers. |
| GTF / GFF / GFF3 / BED | Gene annotations | Gzip accepted. BED12 exon blocks are drawn; BED names are searchable. |
| FASTA (`.fa`, `.fasta`, `.fna`) | Reference sequence | Needs a `.fai` index. |
| bigWig (`.bw`) | Signal tracks | ATAC-seq, ChIP-seq, etc. |
| bigBed / BED | Annotation tracks | Added from the **Tracks** panel. |
| `.cool` / `.mcool` | Contact maps | Hi-C, Micro-C, DAF-C. Needs `pip install cooler h5py`. Local or `s3://`. |
| Plasmid maps | Circular references | SnapGene `.dna`, GenBank `.gb`/`.gbk`/`.genbank`, EMBL `.embl`, SBOL. See [Plasmids](workflows/plasmids.md). |
| Motifs | Motif tracks | JASPAR (`.jaspar`, `.pfm`), MEME (`.meme`), HOMER (`.homer`, `.motif`). JASPAR names can also be typed in the **Tracks** panel. |
| FIRE BED (`-r DIR`) | FIRE peaks | BED-format accessibility peak calls, shown as a track. |
| Session JSON (`.json`) | Saved sessions | Written by **Save**; reopened with **Open**. |

To make BigBeds from a FiberHMM BAM (faster to browse than the BAM):

```bash
fiberhmm-extract -i calls.bam -o tracks/ --all      # or choose --nucleosome --msp --tf --m6a --m5c --deam
```

Drop the resulting `*.bb` files into FiberBrowser together: companion files of
one sample are grouped by the `Sample:` tag in their autoSQL description (or by
file-name stem for older files).

### Remote files

- **S3 and S3-compatible stores** (AWS S3, Cloudflare R2, Backblaze B2, MinIO,
  institutional stores): BAMs (with `.bai` or `.csi`), BigBeds, bigWig/bigBed
  tracks and `.cool`/`.mcool` maps open from `s3://` URLs, in **Data &
  Sessions → Load Remote URL** (with an optional AWS profile and endpoint) or
  on the command line (`AWS_PROFILE=lab fiberbrowser -b s3://bucket/sample.bam`).
  Setting up a lab bucket: [Lab data on S3](workflows/s3-lab-data.md).
- **HTTPS**: BAMs need a server that supports byte-range requests and the
  index at the same address (`.bam.bai`, `.bai`, `.bam.csi` or `.csi`), or
  `<bam URL>##idx##<index URL>`. BigBed and bigWig files work over HTTPS too.
- **A cluster over SSH**: **Connect to cluster…** (see
  [Data on a cluster](workflows/remote-cluster-data.md)).

### BAM tags and layers

FiberBrowser reads the layers present in each file and shows one toggle per
layer in the toolbar's **Layers** group.

| Source in the BAM | Layer | Toggle label |
|-------------------|-------|--------------|
| `ns`/`nl` (legacy nucleosome/footprint tags) or `nuc` in `MA` | Nucleosome footprints | **Nuc** (or **FP** when the file has no separate TF layer) |
| `tf` in `MA` | TF-sized footprints | **TF** |
| `as`/`al` (legacy) or `msp` in `MA` | Accessible (FIRE/MSP) intervals | **Accessibility** |
| `MM`/`ML` m6A calls | m6A marks | **m6A** |
| `MM`/`ML` 5mC calls, or a `_m5c.bb` BigBed | 5mC marks | **5mC** |
| `ddda_mcg` in `MA`, or span rows (blockMl 0) of an `m5c` BigBed | Methylated CpG spans inferred from DddA deamination, drawn behind the footprints | **DddA mCG** |
| `deam+` / `deam-` in `MA` (cross-strand consensus reads from `fiberhmm-pair` / `fiberhmm-merge`) | The span each strand covered; where the two overlap, both strands support the molecule | **CT strand**, **GA strand** |
| `MM`/`ML` deamination, IUPAC `R`/`Y` bases, or C→T / G→A mismatches | DAF deamination events | **Deamination** |
| Any other `MA` name | Custom annotation layer | The layer name |

Notes:

- `MA:Z` / `AQ:B:C` follow the fiberseq Molecular-annotation spec. Per-interval
  quality bytes (`AQ`) feed the **Quality** filters; optional `AN:Z` names are
  shown on each interval. Sections of one type written per strand (for example
  `ctcf+Q` and `ctcf-Q`) are one layer; a section whose quality spec differs
  from the type's first section is skipped.
- Any layer can be a peak source in **Rules → Peaks** (the server scans it as
  `layer:<name>`).
- An optional header comment `@CO<TAB>MA-TYPES:v1:nuc,msp,tf,...` declares the
  MA layer names, so rare layers get a toggle without being found by sampling
  reads. Multiple declarations are merged. Files without it are inspected read
  by read, including a sparse-tag pass for DAF files where only a minority of
  reads carry footprint tags.
- Mismatch-based deamination needs an `MD` tag (for example `minimap2 --MD`).
- Legacy footprint-only files (no explicit `tf` layer) can get inferred
  nucleosome, TF and accessibility layers from footprint size. The switch and
  the nucleosome size cutoff are under **Reads & Display → Read Display →
  Advanced: older files and caching** in the sidebar.
- Reads flagged as duplicates (SAM flag `0x400`, or `isDuplicate=1` in a
  BigBed) are hidden unless **Show duplicate reads** is on (**Reads & Display →
  Read Filters**). Unmapped, secondary and supplementary alignments are not shown.
- Footprint-class layers written by FiberHMM's consensus tools are described in
  [LATTICE_CONSENSUS.md](LATTICE_CONSENSUS.md).

## Dataset catalog

A catalog JSON lists groups of datasets and reference tracks that users load on
demand from the **Data & Sessions** sidebar section. Entries take a local `path`
or a remote `url` (`https://` or `s3://`); `url` wins when both are set.

```bash
python browser.py --catalog catalog.json            # local use, all features on
python browser.py --catalog catalog.json --public   # read-only web deployment
```

```jsonc
{
  "name": "Example lab data",
  "genome": "hg38",
  "tracks": [
    { "url": "https://example.org/chip/h3k27ac.bw", "label": "H3K27ac" }
  ],
  "groups": [
    {
      "name": "Fiber-seq replicates (merged)",
      "description": "Two replicates in one panel",
      "merge": true,
      "datasets": [
        { "url": "https://example.org/rep1.bb", "label": "Rep 1" },
        { "url": "https://example.org/rep2.bb", "label": "Rep 2" }
      ]
    },
    {
      "name": "DAF-seq",
      "datasets": [
        { "path": "data/daf_sample.bam", "label": "DAF", "color": "#10b981" }
      ]
    }
  ]
}
```

- `merge: true` loads the group's files into one panel; otherwise each file gets its own panel.
- Local `path` values may use `~`, environment variables, and paths relative to the catalog file.
- Any entry may set `label` and `color`.
- Remote BAMs need a sibling `.bai` or `.csi` (or `<bam>##idx##<index>`) and a server that supports HTTP range requests.
- `s3://` URLs use the reading computer's AWS profile and fall back to anonymous access, so public buckets need no credentials.
- An optional `"s3": {"endpoint_url": "...", "region": "...", "profile": "..."}` block says where the catalog's `s3://` files live (Cloudflare R2, Backblaze B2, MinIO, an institutional store); never put keys in a catalog. See [Lab data on S3](workflows/s3-lab-data.md#7-a-lab-catalog).
- An entry that can't be opened (missing file or index, refused access) is named when its group is loaded; the rest of the group opens.
- The same remote URLs can be opened one at a time from **Data & Sessions → Load Remote URL**, with the same code path.
- The [Library](workflows/library.md) can export a group of datasets as a catalog.

## Screen layout

| Area | What it holds |
|------|---------------|
| Top bar | **Open** (its arrow: Open from Library, Load by path / URL, Connect to cluster, Process raw data, Data quality), **Save**, **Export** (a figure) and **Data** (Export data…); **Undo**, **Redo** and the history ▾; **Linked / Per panel**; chromosome selector, location box and zoom/pan controls; **Contacts** (when a contact map is loaded); the magnifier (command palette, Cmd/Ctrl+K); the **⋮** menu (reset view, analysis details, keyboard shortcuts, quit — quit not shown on `--public`). Settings open from the side rail at the right edge. |
| Operations toolbar | Groups **Reads**, **Layers**, **Peaks** (its button is **Scan**), **Cluster**, **Sort**, **Filter**, **Highlight**, **Quality**; each action has its own colour. Click a group's name, or the arrow beside its button, to open all its controls inline in the row; folded, hover it to see its current values. A group stays open, remembered across reloads, until you click it again (several may be open; they wrap onto a second line when the row is full). **Layers** starts open. Groups that don't fit the window go to **More** at the end of the row. The reads keep at least half the window: while the open groups would leave them less, the least used show folded (still open) until there is room, and at very large UI sizes the top bar and toolbar are drawn smaller (never below 100%); in a narrow window or at a large UI size the File buttons show their icons only. |
| Rail | At the right edge: the four settings icons (each opens one settings page; click it again to close), then one coloured tile per analysis panel in three groups, **Analyze**, **View**, **Tools** (hover a tile for its name; the tiles scroll when the window is short), then minimized datasets. **Settings › Reads & Display › Analysis panels: Strip (classic)** puts the panels in a strip of buttons above the reads instead (panels that don't fit wait under **More**). Each analysis panel can sit beside the reads or be pinned to the side, into a drawer over the reads that can be resized and whose tabs can pop out (see the [guide](guide.md#side-panels-and-the-drawer)). |
| Track area | Axis, metaprofiles, peaks, genes, sequence, one read panel per dataset, and signal/annotation/contact/co-accessibility tracks. |
| Sidebar | Settings, one page per rail icon (below), with a search across all four. |

### Dataset panel header

Each read panel has a header with its dataset name, its read count, a drag
grip (⋮⋮) to move it, and a **⋯** menu: **Expand to full view**, **Add a
copy**, **Stack below …** / **Side by side**, **Compare haplotypes…**,
**Tracks in this panel…**, **Minimize** (to a tile at the bottom of the rail, or a button in the classic strip)
and **Close dataset** (**Close panel** for a copy). New datasets and copies open
side by side. In **Per panel** navigation each panel has its own location
bar, with **Match** to bring the other panels on its genome there. DAF-seq
panels also have a strand chip (**Both strands** ▾) — see
[DAF-seq](workflows/daf-seq.md). The eye button is **Clean view**, on by
default: track labels ("Peaks", "Metaprofile", "Footprint classes", …) show
only while you hover a track. Turn it off to keep a panel's labels drawn over
the data; exported figures follow it (see below). The **Layout** panel links,
merges and unmerges datasets, and **Equal widths** evens out panel widths.

### Sidebar sections

| Section | Contents |
|---------|----------|
| **Data & Sessions** | **Restore Session**, **Library** (**Open Library**), **Load by path** (one path per line), **Load Remote URL** (`s3://` with an optional AWS profile and S3-compatible endpoint, `https://`), catalog groups (when `--catalog` is used), **Loaded Datasets**, **Session** (name, save, copy link, **On launch**: ask to reopen the last session, reopen it, or start fresh; reproducibility summary). |
| **Reference & Tracks** | **Reference Files** (FASTA, gene annotations, plasmid maps; **Multiple FASTA / annotation pairs**), **Online Genome & Tracks**. |
| **Reads & Display** | **Read Display** (fill height, display caps, separators, coverage histogram, hover tooltips, UI size, legacy-layer inference and layer caching), **Navigation** (autozoom), **Read Filters** (**Hide footprints cut off at read ends (< 90 bp)**, on by default; gap filling, terminal gaps, minimum footprints, duplicates, CIGAR display). |
| **Analysis & Reproducibility** | **Reproducibility** (**Seed**, **Analysis cap**) and **Peak Detection** (rules, **Lock current peaks**). |

A **Search settings** field at the top of the sidebar filters its sections
as you type. The display caps limit only what is drawn. Clustering and other analyses use
every eligible read unless you set **Analysis cap** (Read Stats describes the
selected or shown reads).

## Panels

The rail shows these panels (or the classic strip, if chosen). Click a tile to open or close its panel. Panels
can be maximized, minimized, moved and duplicated, and every chart has
PNG/SVG/PDF save buttons.

| Group | Panel | Tabs | Opens with |
|-------|-------|------|------------|
| Analyze | **Clusters** | Overview; Charts (Profiles, Composition — Bar, Pie or Line — V-Plot — Midpoint or Full footprint — Projection — a t-SNE map by default, with **Export table** — and Differences, with rules); click cluster names above a chart to pick clusters; Saved | **Detail** in the **Cluster** group, or click the cluster bar |
| Analyze | **Footprints** | Classes, Saved, Co-occupancy | Cmd/Ctrl+click a footprint |
| Analyze | **Transcription** | Filters, Distribution, Co-occur, Pol II COM | Cmd/Ctrl+click a gene |
| Analyze | **Read Stats** | Summary, Table, Distributions | Shift+click a read |
| Analyze | **Co-accessibility** | Matrix | Its tile in the rail |
| Analyze | **Contacts** | Map, Compare regions, Settings (with a contact map); Compare loci, Compare haplotypes (without one) | In the rail once a `.cool`/`.mcool` is loaded. Haplotype comparison is also in **Regions**. |
| Analyze | **NFRs** | NFRs, NFR pairs | Its tile in the rail. Runs FiberHMM's `fiberhmm-nfr` on the view: NFR variants and their prevalence, which NFRs open together, motifs at each NFR ([Motifs at NFR variants](lab/workflows/nfr-motifs.md)). |
| Analyze | **Synchronise regions** | — | Its tile in the rail: oriented maps of several regions, matched-region groups, pooled scans and co-clustering across them. |
| Analyze | **Insertion lens** | — (with **Identify**) | **Open insertion lens** in the read menu, or **Open this insertion in the lens** on the SV row. The chromatin inside a large insertion; Identify gives candidate TE families and genome copies ([Identify](identify.md)). |
| Analyze | **Variants** | SNPs, Combinations, SVs | Its tile in the rail. SNPs and small indels in view, the reads grouped by their alleles (or HP tags), SVs; split the reads into panels by allele, combination or SV ([guide](guide.md#variants)). |
| View | **Tracks** | — | Add files, JASPAR motifs, sequences; **Browse hubs** (UCSC, ENCODE, ChIP-Atlas); **+ Metaprofile**; **+ Combined track** |
| View | **Library** | — | Your datasets, runs and watched folders ([The Library](workflows/library.md)) |
| View | **Labeling** | Rules, Quality | How footprints are coloured; quality filters |
| View | **Rules** | Peaks, Cluster, Sort, Filter | Reusable peak, cluster, sort and filter rules |
| View | **Layout** | Layout | Dataset merge, link groups, renaming |
| View | **Regions** | Regions, Map, Compare haplotypes | **Regions**: saved regions in categories (**Save view**, **Scan regions**, **Import BED**, **Export BED**, N/P to step through a category). **Map**: whole-chromosome or circular map, **Load plasmid map…**, **Open plasmid dataset…**. [Haplotype comparison](workflows/haplotype-comparison.md) |
| Tools | **Primers** | Design (Standard PCR, 3C, 4C), Order list, Capture | Needs the reference FASTA. **Capture** collects regions for capture-probe design. Hidden on `--public` servers |
| Tools | **Tutorial** | Guided tour, Copilot | See the [User guide](guide.md) and [Copilot](copilot.md) |

Peak-detection rules are in **Rules → Peaks**. Preview features (the
insert-expanded panels) carry a **Preview** badge; see
[What 3.0 includes](release-scope.md). Python plugins add their own panels to
the rail ([Plugins](plugins.md)).

## Online genomes

**Reference & Tracks → Online Genome & Tracks** downloads a reference FASTA
and gene annotation (cached in `~/.fiberhmm/genomes`):

| Genome | Species | Annotation |
|--------|---------|------------|
| hg38 | Human (GRCh38) | GENCODE v46 Basic |
| hg19 | Human (GRCh37) | GENCODE v46 lift37 |
| mm39 | Mouse (GRCm39) | GENCODE vM35 Basic |
| mm10 | Mouse (GRCm38) | GENCODE vM25 Basic |
| dm6 | *D. melanogaster* | Ensembl r113 |
| sacCer3 | *S. cerevisiae* | Ensembl r113 |

## Motifs from a published logo

When a paper shows a motif logo but not its matrix,
`scripts/motif_logo_to_pwm.py` (source checkout) recovers an approximate PWM
from a logo image or PDF page, by colour (`--method color`) or with a local
vision model through Ollama (`--method ollama`), and writes JASPAR or MEME for
the Tracks panel:

```bash
python scripts/motif_logo_to_pwm.py logo.png --method color --positions 12 \
  --crop 120,240,520,140 --name PaperMotif --format jaspar --out PaperMotif.jaspar
```

Prefer the original matrix (a motif database or the paper's supplement)
whenever it exists.

## Keyboard shortcuts

Press **?** (or the **?** button) to show this list in the browser. Shortcuts
are ignored while typing in a text field.

### Command palette and settings search

**Cmd/Ctrl+K**, the magnifier at the right of the top bar, or **View → Search
Commands and Settings…** (the app's menu bar) opens the command palette: one
search over every action of the menu bar and toolbar, every analysis panel,
every setting (by its label, a synonym, or its section), and the keyboard
shortcuts (shown beside each result). Coordinates or a gene name offer **Go
to**. Arrows move, **Enter** chooses, **Esc** closes, recent picks come first.
A setting opens where it lives and is highlighted; on/off settings can be
switched in the list (**Turn on / Turn off**, or **Cmd/Ctrl+Enter**). No other
shortcut acts while the palette is open. The **Search settings** field at the
top of the settings sidebar filters its sections and settings the same way;
when nothing matches it offers the palette. The keyboard-shortcuts dialog links
to the palette too.

| Key | Action |
|-----|--------|
| ← / → | Pan left / right |
| ↑ / ↓, + / − | Zoom in / out |
| Alt+← / Alt+→ | Back / forward in navigation history |
| R | Reset view: clear clustering, filters, excluded reads and selections |
| N / P | Next / previous saved region of the current category (Regions) |
| Shift+drag a ruler | Highlight a region (with **Highlight** on, a plain drag does too) |
| Cmd/Ctrl+B | Show / hide the settings sidebar |
| 1–9 | Focus cluster by number |
| 0 | Clear cluster focus |
| Escape | Clear peak selection and cluster focus |
| S | Scan for accessibility peaks |
| [ / ] | Decrease / increase read row height |
| Cmd/Ctrl+scroll over reads | Change read row height |
| G | Toggle genome overview |
| ? | Show keyboard shortcuts |
| Cmd/Ctrl+K | Search commands and settings (the command palette) |
| Cmd/Ctrl+Shift+E | Export data… |
| Cmd/Ctrl+Z | Undo |
| Cmd/Ctrl+Shift+Z | Redo |

### Mouse

| Action | Result |
|--------|--------|
| Click or drag the reads | Pan (there are no click modes) |
| Right-click a read (Ctrl+click on a Mac) | The read menu: select, open in Read Stats, copy its name or locus, highlight it in all panels, zoom to it; copy names of, keep only or exclude the selected reads. On empty space: go to a read by name, zoom, copy the locus |
| Shift+click a read | Select it (outlined) and open **Read Stats**; Shift+click again to deselect |
| Cmd/Ctrl+click a footprint | Analyse that spot in **Footprints**; Cmd/Ctrl+click more to add them |
| Click a peak | Select it for clustering; Cmd/Ctrl+click adds more |
| Drag on the Custom row of the Peaks track | Draw your own peak |
| Click a gene | Select it for **Transcription**; Shift+click adds or removes genes; Cmd/Ctrl+click selects it and opens **Transcription** |
| Click a colour in the cluster bar beside the reads | Select that cluster and open **Clusters**; Shift or Cmd/Ctrl+click adds or removes clusters |
| Paste a read name in a location box | Go to the read and highlight it (several names: comma separated) |
