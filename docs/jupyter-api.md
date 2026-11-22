# Jupyter / Python API

[← Docs index](index.md) · [← README](../README.md)

`browser_client.py` is a Python client for a running FiberBrowser. It works in
both directions: a notebook can navigate the live browser, pull reads and
analysis results, push filters, highlights, peaks, rules and settings, and
render figures; the browser keeps its viewport, selected reads, read order,
peaks, clusters, rules and settings synced back so Python can read them. The
methods call the same HTTP API as the UI, so notebook and browser results match.

For longer worked examples see [JUPYTER_INTEGRATION.md](../JUPYTER_INTEGRATION.md).
The HTTP endpoints themselves are covered in the
[Browser API guide](browser_api_guide.md).

## Connect

```python
import sys
sys.path.append("/path/to/FiberBrowser")      # the folder that holds browser_client.py

from browser_client import BrowserClient, connect

client = BrowserClient("http://localhost:8000")   # or: client = connect()
print(client.get_region())
```

`BrowserClient(url)` checks `/api/status` and raises `ConnectionError` if no
server answers.

## Quick example

```python
client.goto_gene("NAPA")
reads = client.get_reads()                     # DataFrame: id, intervals, n_footprints, ...

# Reproducible settings in the live browser
client.set_reproducibility(seed="paper-v1", analysis_cap=20000, display_cap=600, spanning=True)
client.set_visible_layers(tf=True, nuc=True, fire=False)
client.set_display_settings(fill_read_height=True, show_coverage_histogram=True)

# Highlight reads with many footprints
busy = reads[reads["n_footprints"] > 10]["id"].tolist()
client.highlight_reads(busy, color="#ff0000", label="many footprints")

# Export read statistics in the order shown in the browser
dataset_id = client.get_default_dataset_id()
order = client.get_browser_read_order(dataset_id)
client.save_read_stats_tsv("read_stats.tsv", {dataset_id: order})
```

## Headless server

`BrowserClient.headless(...)` starts a server in a subprocess, waits for it, and
returns a connected client. Use it as a context manager so the server stops at
the end. The Copilot is off by default in headless mode.

```python
with BrowserClient.headless(bam="footprints.bam", gtf="genes.gtf", fasta="genome.fa") as client:
    client.goto("chr19", 47_514_000, 47_518_000)
    peaks = client.scan_peaks()
    client.save_figure("region.png")
```

Without `with`, call `client.close()` to stop the server.

With no browser tab open, the settings you push from Python still reach
figures. The server keeps every `set_*` setting that changes a figure: read
filters, layers, metaprofile sources, layer colours, the read filter and
order, seed and caps. A figure drawn from the defaults starts from them, as an
open tab would have applied them. Options you pass to `figure()` still win. A
figure of an open tab's view, or of a session, is drawn exactly as that view
or session is.

```python
with BrowserClient.headless(bam="footprints.bam") as client:
    client.set_read_filters(all_reads=True, show_qc_fail=True)   # Min footprints: all reads, including uncalled
    client.set_layer_colors(nuc="#4b5563", tf="#dc2626")
    client.set_metaprofile_layers(fire=False)
    client.save_view("region.pdf", "chr19:47,514,000-47,518,000")
```

## Figures

| Call | Output |
|------|--------|
| `figure(region=None, *, format='png', scale=2.0, session=None, ...)` | Bytes of a PNG, SVG or PDF of the browser's view (the **Export** button). By default the open tab's current view; pass `region="chr1:1-2000"` for another region with the same setup, or `session=` (path or dict) to render a saved session. |
| `save_view(filepath, region=None, **kwargs)` | `figure()` written to a file; format from the extension. |
| `render_view(region=None, **kwargs)` | `figure()` as a PIL image, for display in Jupyter. |
| `render(chrom=None, start=None, end=None, ...)` | A PIL image drawn on the server from the tab's state (or defaults). |
| `save_figure(filepath, **render_kwargs)` | `render()` written to a file. |

```python
client.save_view("fig1a.pdf")                                   # what the browser shows
client.save_view("fig1b.png", "chr19:47,514,000-47,518,000", scale=4)
client.save_view("fig1c.svg", session="figure1.json")
```

`figure()` uses `engine="headless"` (drawn in Python on the server) by default.
`engine="browser"` drives the real app in headless Chromium and needs Node and
Playwright.

## Scripted figures (headless)

Re-render single-molecule panels from a saved session by script, with no browser, Node or
Playwright. Nothing below changes a figure unless you ask for it: a session renders exactly
as before (a regression test compares every PDF stream with a render made before these
options existed).

### Options of `figure()` (headless engine)

| Option | Effect |
|--------|--------|
| `spanning_only=True/False` | Only reads spanning the region, or all overlapping reads (else the session's setting). |
| `sample_seed="S"` | Which reads a panel draws when it has more reads than it shows (else the session's seed). The same seed draws the same reads. |
| `max_reads=N` or `{"ds1": 200, "Sample B": 150}` | Reads per panel; a dict sets them per dataset (dataset id, panel id or label). |
| `hide_tracks=["sv"]` | Leave rows out of every panel: `sv` (the "SV · in loaded reads" strip, also in sessions saved before it was its own row), `sv_marks` (all SV display, strip and per-read marks), `coverage`, `axis`, `gene`, `header`, `fire`, `sequence`, `consensus`, `composite`, `annotation`, `composite-<id>`. |
| `annotations={...}` | BED overlay, opening-width classes, side statistics (below). |
| `page_size="180x120mm"`, `page_fit="contain"` | Physical page size (`mm`, `cm`, `in`, `pt`; `"180mm"` keeps the aspect ratio) and fit: `contain` (uniform scale, top-left), `width` (fill the width, height follows), `height`, `stretch` (fill both; distorts). |
| `min_font_pt=6` | Raise every text label below 6 pt *on the final page* to 6 pt. |
| `raster_dpi=600` | Read rasters at 600 px per inch of the final page (PDF/SVG; default 2 px per CSS px). For PNG, the image resolution (300 dpi with a `page_size` and no `raster_dpi`). |
| `pdf_fonts="truetype"` | Embed TrueType fonts (matplotlib's `pdf.fonttype 42`): text stays text, editable in Illustrator. Arial or Liberation Sans (Helvetica metrics) are preferred, else DejaVu Sans; `FIBERBROWSER_FIGURE_FONT` (and `_BOLD`, `_ITALIC`, `_BOLDITALIC`, `_MONO`) name a `.ttf`. The default `standard` keeps the base-14 Helvetica. Reads are always an embedded raster. |
| `return_manifest=True` | Return `(bytes, manifest)`: per panel, reads drawn and loaded, cluster sizes, annotation statistics; `manifest_read_ids=True` adds the drawn read ids in row order. |

A session can carry the same options in a `headless_figure` block; the call's own
arguments win. The browser ignores the block (and drops it if it saves the session again).

```json
"headless_figure": {"sample_seed": "fig2", "spanning_only": true, "max_reads": {"ds1": 200},
                    "hide_tracks": ["sv"], "page_size": "180x120mm", "min_font_pt": 6,
                    "raster_dpi": 600, "pdf_fonts": "truetype"}
```

```python
with BrowserClient.headless(gtf="genes.gtf", fasta="genome.fa") as client:
    pdf, manifest = client.figure(session="fig.json", load_session=True, format="pdf",
                                  sample_seed="fig2", spanning_only=True, hide_tracks=["sv"],
                                  page_size="180x120mm", min_font_pt=6, raster_dpi=600,
                                  pdf_fonts="truetype", return_manifest=True)
```

### Re-clustering on new data

Cluster assignments in a session are keyed by read name, so they do not survive re-called or
deduplicated data. `recluster_session()` clusters the region again with a fixed method, k
and seed through the browser's joint region clustering with `balance_windows` (one pooled
fit; each panel contributes the same number of reads to a k-means/minibatch fit), then
stores the assignments in a copy of the session:

```python
reply = client.recluster_session("fig.json", method="kmeans", k=6, seed="fig2",
                                 features=[(1_200, 1_500)],   # default: the whole region
                                 out_session="fig.reclustered.json", out_tsv="fig.clusters.tsv")
client.save_view("fig.pdf", session=reply["session"], load_session=True)
```

- The same seed, data and options give the same assignments. Labels are canonical: 0 is the
  cluster with the most reads over all panels (ties: the smallest read id).
- Only reads covering every feature are clustered, and a clustered panel shows only those.
- The session's saved quality and signal filters apply. Its read order, cluster focus, read
  filter, selection and cluster tree for those panels are cleared;
  `session["headless_cluster"]` records the parameters and counts.
- `out_tsv` writes `panel, dataset_id, dataset_label, read_id, cluster` and
  `<name>.counts.tsv` (`panel, dataset_id, dataset_label, cluster, reads, fraction`).

### Annotation overlays

```python
annotations = {
    "bed": "regions.bed",            # or "intervals": [["chr2L", 100, 400, "CRM 1"], ...]
    "draw": "both",                  # "track" (labelled row above the reads), "through" (boxes over the reads), "none"
    "target": "CRM 1",               # interval for classes and stats: BED name, index in view, or [start, end]
    "patch_layer": "msp",            # the read layer that counts as the accessible patch
    "classes": True,                 # or {"thresholds": [175, 300, 500], "names": [...], "colors": [...]}
    "stats": True,                   # or {"per": "panel" | "cluster" | "both", "position": "right", "size": 9}
}
```

- **Accessible patch.** An interval of the read's `patch_layer` layer: by default `msp`, the
  methylation-sensitive patches (the `as`/`al` tags, the `msp` MA layer, or an `_msp` bigBed).
  If no drawn read carries that layer in the view, the figure fails rather than reporting 100%
  "no opening".
- **Opening width and class.** Among the patches overlapping the target (half-open: patch start
  < target end and patch end > target start), the widest counts, and its width is the whole
  patch length, not the overlap (patches are read over the target ± `patch_window` bp, default
  5000, so one running past the view keeps its length). Class *i* holds widths in [threshold *i*−1, threshold *i*).
  The defaults are < 175 bp, 175–300 bp ("potentiated"), 300–500 bp ("merged") and ≥ 500 bp
  ("actuated"); names, thresholds and colours are parameters. The patch is painted over the read
  in its class colour.
- **No opening.** Among reads spanning the target (one aligned block covers the whole target),
  those with no patch overlapping it. The side label shows `n` (spanning reads) and the
  percentage with no opening, per panel and per cluster; drawn reads that do not span the target
  are counted as `not_spanning` and left out of both. A cluster too short for its label keeps
  its numbers in the manifest only.

### `fiberbrowser render`

```
python -m fiberbrowser render SESSION.json --out panel.pdf \
    [--gtf genes.gtf --fasta genome.fa --remap /old/prefix/=/new/prefix/] \
    [--seed S --spanning-only --max-reads 200 | --max-reads ds1=200] \
    [--size 180x120mm --fit contain --hide sv --dpi 600 --min-font 6 --fonts truetype] \
    [--recluster kmeans:6 --cluster-features crm.bed --cluster-tsv clusters.tsv] \
    [--bed crm.bed --target "CRM 1" --classes --stats] [--hash fast]
```

(`fiberbrowser render ...` once installed; from a source snapshot run it from the snapshot's
folder.) The format follows the extension. With no options the file is byte-identical to
`figure(session=..., load_session=True)`. `--remap` rewrites path prefixes (repeatable; the
longest wins), then every file the session opens (and each BAM index) is checked: a missing
file or a cloud placeholder stops the run with a list (exit 2). Placeholders are found from
`stat` data only, so checking never starts a download: a zero-size file, the macOS
`SF_DATALESS` flag (File Provider online-only files, as Dropbox and Google Drive under
`~/Library/CloudStorage` use), a non-empty file with no allocated blocks, the Windows
`OFFLINE`/`RECALL_ON_OPEN`/`RECALL_ON_DATA_ACCESS` attributes, and the same attributes through
`powershell.exe` for `/mnt/<drive>/` paths on WSL. From Python:
`fiberbrowser.scripted.remap_session(session, {old: new})` and
`fiberbrowser.scripted.render_session(session, "panel.pdf", gtf=..., fasta=..., **figure options)`.

Each render writes `<out>.receipt.json`: the FiberBrowser version and git commit (from git,
from the stamp a `git archive` snapshot carries, or `$FIBERBROWSER_GIT`), the session file's
sha256 and the sha256 of the session as rendered, every input file (path, size, mtime, and
sha256, or with `--hash fast` a hash of the size and first and last MiB), the seed, the options,
the re-clustering parameters, and per-panel read counts (`--read-ids` adds the drawn read ids).

Figures draw the read view: axis, peaks, reads, genes, sequence and composite
tracks such as the metaprofile. Charts the browser draws itself are not
figures, with either engine:

- Plots and Gallery cards
- the Quantify card
- the Clusters panel's profiles and legends
- other analysis panels

Export those from the browser with their own Save buttons. A render request
that names one (`tracks=["plots"]`, `"quantify"`, `"gallery"`, `"panels"`) gets
an error that says so. You can still script them in the open browser:
`open_plot` and `keep_plot` (Plots), `set_window_quant` (Quantify). The browser
leaves the Quantify window band and its relative-axis strip out of the main
track's exports, and headless figures match that.

## Pooled loci (meta-locus) from Python and the command line

A meta-locus pools a BED file's sites into one virtual locus: each site's reads are
aligned on its anchor (the start, centre or end, strand-aware: the start of a
minus-strand site is its right end), minus-strand sites are flipped, and the axis runs
−flank…+flank. Each read–site pair is one observation, as in the browser: a read that
overlaps two sites' windows is a row in each (its id then ends in `#site<N>`).

Everything below runs headless, with no browser tab, and gives what the browser shows
for the same pool, seed and count:

- **Figures** draw the browser's working set (the same read ids), aligned on the anchor,
  with the metaprofile.
- **Re-clustering** clusters that working set.
- **Quantify** gives the Quantify card's table.
- **The metaprofile export** gives the curves the read track draws.

The open browser's own view of a pool is never changed by a script.

### The pool: a spec, a pool id or a saved session

| Field | Meaning (default) |
|-------|-------------------|
| `bed` | The sites BED (path on the server). |
| `anchor` | `"start"` (TSS), `"centre"` or `"end"`, strand-aware (`"centre"`). |
| `flank_bp` | bp each side of the anchor (10000; at most 50000). |
| `datasets` | Dataset ids to pool (every loaded BAM). |
| `seed`, `count` | The working set: the browser's seed and size (1, 2000). |
| `window` | Figures: draw only `[from, to]` bp from the anchor (the whole window). |
| `extra_entries` | Reads Find more / Keep workspace full added (`[[dataset, read name, site], ...]`). |
| `policy`, `count_unit`, `anchor_mark`, `wait_s` | Pool rule (`per_site`), the receipt's unit word, the axis anchor mark (on), how long to wait for a build (900 s). |

Instead of a spec, pass a pool id (`start_meta_locus_pool`) or a session saved on a
meta-locus view. A session rebuilds or reuses its pool from the saved spec. If its BED
has moved, the call fails and names the remap helper: use
`fiberbrowser.scripted.remap_session` or `--remap OLD=NEW`. The pool id depends on the
files' paths and dates, so a session from another computer gets a new contig, and every
place the session names the old one is renamed.

What a figure leaves out, as the browser does on a meta-locus: reference sequence,
genes, primers, Micro-C, the SV row, capture, and external and annotation tracks. These
need a real genome position. Metaprofiles stay.

### Figures

```python
with BrowserClient.headless(dataset=["data.bam:sample"]) as client:
    spec = {"bed": "sites.bed", "anchor": "start", "flank_bp": 2000, "seed": 1, "count": 2000}
    pdf, manifest = client.figure(meta_locus=spec, format="pdf", page_size="180x120mm",
                                  min_font_pt=6, raster_dpi=600, pdf_fonts="truetype",
                                  hide_tracks=["coverage"], return_manifest=True)
    manifest["meta_locus"]   # BED sha256, anchor, flank, datasets, sites, read-site pairs, seed, count, spec hash
```

- **What each panel draws.** Its dataset's whole share of the working set; `max_reads`
  caps it. The metaprofile is computed from the reads the browser uses for it.
- **Options.** Print sizing, minimum font, DPI, real text, `hide_tracks` and the layer
  colours (a session's own colours too) work as in other figures.
- **The axis.** It shows the pool's label, the anchor word at 0 (TSS, centre or end) and
  a small anchor mark.

### Re-clustering a pool

```python
reply = client.recluster_session(None, meta_locus=spec, method="kmeans", k=4, seed="fig",
                                 features_relative=[(-300, 100)],   # default: the anchor ± anchor_window (500 bp)
                                 out_session="pool.clusters.json", out_tsv="pool.clusters.tsv")
```

- **Determinism.** The same seed, data and options always give the same assignments.
  Labels are canonical: 0 is the largest cluster.
- **The TSV.** Its rows are read–site pairs, with columns `read_site_key`, `read_name`,
  `site`, `site_name`, `site_chrom` and `site_strand` after the usual ones. Per-cluster
  counts go to `<name>.counts.tsv`.
- **The session.** The returned session sits on the pool's contig with its seed, count
  and added reads, in the form the browser saves a meta-locus session, and holds the
  clusters. Figures and Quantify read them.

### Numbers: Quantify a window and the metaprofile

```python
q = client.quantify_window(bounds={"meta_locus": spec, "window": [-200, 50]},
                           measures=["layer:nuc", "layer:tf", "size:band"],
                           comparison="clusters", seed=1, out_tsv="window.tsv")
prof = client.get_meta_locus_profile(spec, seed=1, count=2000, channels=["nuc", "tf"],
                                     out_tsv="profile.tsv")
q2 = client.quantify_window(bounds={"session": "pool.clusters.json", "window": [-200, 50]},
                            measures=["layer:nuc"], value="enrichment", compare="diff")
```

**`quantify_window`** gives the Quantify card's table. It uses the card's own engine,
ported to Python and pinned to the browser's by a golden file both test suites compute
(`tests/test_window_quant_twin.py`, `pythonTwinGolden.test.ts`):

- **Rows.** Measures × groups, with n reads, value, 95% interval, enrichment, comparison
  with a reference group, and the equal-shares test with BH.
- **Intervals.** Wilson for shares of reads; otherwise the seeded Poisson bootstrap over
  read–site pairs, with the same seeds as the browser.
- **Which reads.** The same rules as the card. Layers use curve units, from each panel's
  profile reads. Where the browser draws the server's metaprofile (one dataset,
  unclustered), they use a fresh seeded sample in exact bp.
- **Comparisons.** `clusters` (datasets when nothing is clustered), `datasets`,
  `clusters-datasets` or `pools`.
- **Other settings.** Every QuantSpec field is a keyword: `value`, `baseline`, `form`,
  `compare`, `reference`, `stat`, `ci`, `resamples`, `boot_seed`, `layer_units`,
  `read_source`, `size_from`/`size_to`. The QuantSpec's own `bounds` (`"window"`,
  `"region"` or `"sites"`) goes in `spec={"bounds": "sites"}`, because the `bounds`
  argument names the place.
- **Which panels.** The panels the card reads: the selected panels and their link groups,
  or every dataset panel, at the active view. Panels at another locus or on another
  reference are left out, as in the browser. Collapsed panels are not drawn headlessly, so
  they are left out too, and the answer (`left_out`) and the TSV header name them.
  Live-lifted datasets aren't quantified yet, as in the browser's card and Plots: the
  answer lists them in `lifted_left_out`, and the TSV header says so. A
  session gives its saved selection. It does not save per-panel navigation history, so
  the first visible panel is the active one, as after a reload; the open tab's live view
  carries it. The session's saved quality and signal filters apply.
- **Browser-side measures.** Footprint and NFR families, geometries and the regularity
  score need runs in the browser. Asking for one is an error that says so.

**`get_meta_locus_profile`** gives per-bin values per channel and group: `all`,
`dataset:<id>` and `cluster:<c>`. Each bin has its position in bp from the anchor and the
reads covering it. The values equal the curve the figure draws. Where the browser draws
the server's metaprofile (one dataset, unclustered), the export is that profile, with
`reads_covering` given as `NA`. With a session, `seed` and `count` set another working set
of the session's own pool.

### Command line

```
fiberbrowser render --bed sites.bed --anchor start --flank 2000 --seed 1 --count 2000 \
    --bam data.bam:sample --out pool.pdf [--size 180x120mm --min-font 6 --dpi 600 --fonts truetype] \
    [--recluster kmeans:4 --cluster-window -300,100 --cluster-tsv clusters.tsv --save-session pool.json]
fiberbrowser render pool.json --out pool.pdf          # a session saved on a meta-locus view
fiberbrowser quantify pool.json --out window.tsv --window -200,50 \
    --measures layer:nuc,layer:tf --value enrichment --profile profile.tsv
fiberbrowser quantify --bed sites.bed --anchor start --flank 2000 --bam data.bam --out window.tsv \
    --window -200,50 --comparison datasets
```

- **What turns pooled loci on.** Any of `--anchor`, `--flank`, `--count` or `--sites`.
  Then `--bed` names the sites and `--seed` is the working set's (an integer). BED
  overlays are not available on a meta-locus.
- **Datasets.** Without a session, `--bam PATH[:LABEL]` (repeatable) loads them.
- **Receipts.** Each output gets `<out>.receipt.json`:
  - the BED's sha256, the anchor, flank and datasets;
  - the pool's size (sites, read–site pairs), the seed and count;
  - the pool spec's hash (portable: it does not depend on paths or file dates);
  - every input file's sha256;
  - for `quantify`, the bounds, the read source and the table.

## Panels

`open_panel(panel_type)` and `close_panel(panel_type)` accept a panel id or an
alias. `known_panel_types()` lists the ids:

| Panel on screen | Id | Some aliases |
|-----------------|----|--------------|
| Clusters | `cluster-detail` | `clusters`, `cluster` |
| Rules | `cluster-features` | `rules`, `analysis-rules` |
| Co-accessibility (opens Plots on a co-accessibility plot since 3.1) | `co-accessibility` | `coacc` |
| Footprints | `footprint-analysis` | `footprints` |
| Peak Detection | `peak-detection` | `peaks` |
| Transcription | `transcription-state` | `transcription` |
| Labeling | `colormap` | `labeling`, `quality` |
| Read Stats | `read-stats` | `stats`, `reads` |
| Tracks | `track-browser` | `tracks` |
| Annotations | `annotations` | `annotation` |
| Contacts | `contact-map` | `contact`, `dafc`, `microc` |
| Primers | `primer-design` | `primers` |
| Capture Regions | `capture` | |
| Tutorial | `history` | |
| Regions | `circular-genome` | `plasmid`, `navigator`, `circular` |
| Layout | `dataset-layout` | `layout` |
| Nucleosomes | `nucleosomes` | `nuc`, `nucleosome` |
| Find sequence | `sequence-search` | `find-sequence`, `sequence` |
| Variants | `variants` | `snps` |
| Insertion lens | `insertion-lens` | `insertion` |
| Graph view | `graph-view` | `graph` |
| Feature hub | `feature-hub` | `hub` |

Plots and the feature hub's workspace cover the reads instead of opening in the
strip. They are workspaces, not panels: use `set_workspace("plots")`, `"hub"`
or `"browser"`, or `open_plot(...)`. The hub workspace is experimental and
off by default (Settings › Read Display › Experimental).

## Method reference

All methods are on `BrowserClient`. Region arguments (`chrom`, `start`, `end`)
default to the browser's current view when omitted. Most analysis methods take
`dataset_id` / `dataset_ids` (default: the first loaded dataset), `spanning`
(only reads covering the whole region), and `sample_seed` (reproducible
sampling). Long signatures are shortened with `…`; use `help(client.method)` for
the full argument list and docstring.

### Connection and status

| Method | Description |
|--------|-------------|
| `headless(bam=None, gtf=None, fasta=None, fire=None, dataset=None, port=None, timeout=30, quiet=True, …, **kwargs)` *(class method)* | Start a FiberBrowser server as a subprocess and connect to it. |
| `close()` | Close the HTTP session and shut down the headless server subprocess (if any). |
| `get_status()` | Get browser status info. |
| `get_region()` | Get the current viewport region. |
| `get_live_view()` | What the open browser tab shows (region, track-area size, age). |
| `refresh()` | Force browser to refresh the current view. |
| `clear_all()` | Clear all Jupyter-controlled state (highlights, ordering, markers, etc.). |
| `clear_cache()` | Clear all server-side read caches to force fresh data loading. |
| `get_cache_status()` | Get cache directory and per-genome cache status. |

### Navigation

| Method | Description |
|--------|-------------|
| `goto(chrom, start, end)` | Navigate the browser to a specific region. |
| `goto_gene(gene_name, padding=2000)` | Navigate to a gene by name. |
| `autozoom(distance=1000, chrom=None, start=None, end=None, spanning=False, **kwargs)` | Find the optimal window that maximizes spanning reads. |
| `queue_browser_actions(actions, label='Python')` | Queue UI-equivalent actions for the active browser frontend to execute. |
| `drive_browser(*, session=None, seed=None, analysis_cap=None, display_cap=None, spanning=None, peaks=None, …)` | Apply a reproducible browser state bundle from a notebook. |

### Datasets, files and sessions

| Method | Description |
|--------|-------------|
| `get_datasets()` | Get list of loaded datasets. |
| `get_default_dataset_id()` | Return the first loaded dataset ID, or None when no dataset is loaded. |
| `resolve_dataset_id(dataset_id=None)` | Resolve omitted or legacy `primary` aliases to the first loaded dataset. |
| `add_dataset(path=None, paths=None, url=None, label=None)` | Add a new dataset (BAM, BigBed file(s), or remote URL). |
| `add_dataset_url(url, label=None)` | Add a remote BAM/BigBed dataset via the URL convenience endpoint. |
| `remove_dataset(dataset_id)` | Remove a dataset. |
| `refresh_dataset_capabilities(dataset_id=None)` | Re-detect a loaded dataset's available layers and clear stale read caches. |
| `merge_datasets(dataset_ids, merged_label=None)` | Merge multiple datasets into one combined view. |
| `unmerge_datasets(dataset_id)` | Unmerge a previously merged dataset. |
| `diagnose_bam(bam_path=None, dataset_idx=None, chrom=None, limit=10)` | Diagnose BAM file tags and capabilities. |
| `load_folder(path)` | Load a folder dataset via the same endpoint used by the UI. |
| `pick_folder()` | Open the backend folder picker. |
| `pick_file(file_type='gtf')` | Open the backend file picker for a specific file type. |
| `pick_dataset()` | Pick one or more dataset files. |
| `pick_any_file()` | Pick one or more supported data files. |
| `pick_overlay_file(overlay_type=None)` | Pick an overlay file, optionally constrained by overlay type. |
| `pick_annotation_file()` | Pick an annotation BigBed file. |
| `pick_file_primer(file_type)` | Pick primer-design support files (`fasta` or `blast`). |
| `upload_file(file_path)` | Upload a local file to the browser process. |
| `save_session(filepath, chrom=None, start=None, end=None, include_frontend_state=True)` | Export the current browser session to a JSON file. |
| `load_session(filepath, path_mapping=None, search_root=None)` | Import a browser session from a JSON file. |
| `check_session_files(filepath, search_root=None, mapping=None)` | List a session's input files and whether each exists on this computer. |
| `get_session_manifest()` | Return the latest browser-synced reproducibility/session manifest. |
| `save_session_manifest(filepath, text=False)` | Save the latest session manifest as JSON or a simple text report. |
| `format_session_manifest(manifest)` *(static)* | Format a browser session manifest for lab notes or methods sections. |

### Reference genome, genes and sequence

| Method | Description |
|--------|-------------|
| `get_genomes()` | Get list of available online genomes. |
| `load_genome(genome_id, confirm_large=False)` | Load an online genome (remote FASTA + cached GTF). A download over the warning size answers `needs_confirmation` until `confirm_large=True`. |
| `get_annotation_status()` | Whether the reference has a gene annotation, and what can load one: `downloadable` (the catalog annotation; load it with `reset_annotation(target["genome_id"])`) or `can_upload_gtf` (a local FASTA: give one with `load_gtf`). The browser's "No genes loaded" prompt decides the same way. |
| `reset_annotation(genome_id, confirm_large=False)` | Use the registry genome's own annotation in place of the loaded one ("Reset to dm6 genes"); the FASTA stays. |
| `attach_panel_genome(dataset_ids, genome_id=None, fasta_path=None, gtf_path=None, contigs=False, span=10000, confirm_large=False)` | Give datasets a reference of their own beside the main genome. A registry download over the warning size answers `needs_confirmation` until `confirm_large=True` (its annotation: the sequence is attached without genes meanwhile). |
| `detach_panel_genome(dataset_ids)` | These datasets use the main genome again. |
| `get_recent_genomes(limit=None)` | Pinned genomes (in pin order) and recent ones, each with a `key`. Local work only. |
| `open_recent_genome(key, confirm_large=False)` | Load a pinned or recent genome in one step (a registry genome with its annotation, or a local FASTA with its paired annotation). |
| `pin_genome(key, pinned=True)` / `unpin_genome(key)` | Pin or unpin a recent genome. |
| `reorder_pinned_genomes(keys)` | Put the pinned genomes in this order. |
| `remove_recent_genome(key)` / `clear_recent_genomes()` | Forget one recent genome, or every unpinned one. |
| `load_fasta(path)` | Load a reference FASTA file at runtime. |
| `set_fasta(fasta_path)` | Set reference genome FASTA file for sequence extraction. |
| `load_gtf(path)` | Load a GTF or GFF3 annotation file. |
| `remove_gtf()` | Remove loaded GTF annotations. |
| `get_chroms()` | Get list of chromosomes with sizes. |
| `get_genes(chrom=None, start=None, end=None)` | Get gene annotations in a region. |
| `search_gene(query)` | Search for a gene by name. |
| `get_sequence(chrom, start, end)` | Get reference DNA sequence for a region (max 10kb). |
| `load_plasmid(path)` | Load a native plasmid/genome map as a supplemental chromosome. |
| `load_plasmids(paths)` | Load multiple native plasmid/genome maps as supplemental chromosomes. |
| `set_circular_chrom(chrom, circular=True)` | Mark or unmark a loaded chromosome/reference as circular. |

### Reads

The read track hides duplicate (0x400) and QC-fail (0x200) reads unless their
toggles show them. It also hides reads without footprint calls at every Min
footprints threshold, unless Min footprints is "All reads, including uncalled"
(`-1`). The client's read methods apply the same rules:

- `get_compact_reads`, `get_all_reads`, `get_all_reads_response`,
  `get_read_stats` and `get_coverage` take `include_duplicates`,
  `include_qcfail` and `hide_uncalled`.
- `get_reads` and `cluster` take `hide_uncalled` (the working set always
  hides duplicates and QC-fail reads).
- `set_read_policy` sets a default for all of them. A value passed to one call
  wins over the policy.

```python
client.set_read_policy(include_qcfail=True, hide_uncalled=False)
reads = client.get_compact_reads()             # QC-fail and uncalled reads included
stats = client.get_read_stats([r["id"] for r in reads])   # Read Stats with the same rules
client.set_read_policy(reset=True)             # back to the browser's defaults
```

| Method | Description |
|--------|-------------|
| `get_reads(dataset_id=None, spanning=True, min_footprints=0, as_dataframe=True, sample_seed=None, hide_uncalled=None)` | Get reads from the browser's WORKING SET (same reads used for analysis). `min_footprints=-1` is "All reads, including uncalled". |
| `get_jupyter_reads(dataset_id, chrom=None, start=None, end=None, sample_seed=None)` | Frontend-name wrapper for `/api/jupyter/reads`. |
| `get_compact_reads(chrom=None, start=None, end=None, dataset_id=None, spanning=True, …)` | Get compact read data with intervals and per-type modification marks. |
| `get_all_reads(chrom=None, start=None, end=None, dataset_id=None, spanning=True, …)` | Get all compact reads for one dataset. |
| `get_all_reads_response(chrom=None, start=None, end=None, dataset_id=None, spanning=True, …)` | Get the raw compact-all response, including per-dataset count metadata. |
| `get_reads_with_clusters(dataset_id=None, spanning=True)` | Get reads with cluster assignments merged in. |
| `get_working_set_info(chrom=None, start=None, end=None, dataset_id=None, spanning=False, sample_seed=None)` | Get info about the working set for a region. |
| `get_read_info(chrom=None, start=None, end=None, spanning=False)` | Get read count for a region. |
| `get_coverage(chrom=None, start=None, end=None, dataset_id=None, bins=500, include_duplicates=None, include_qcfail=None, hide_uncalled=None)` | Get per-bin read coverage for a region. |
| `set_read_policy(include_duplicates=None, include_qcfail=None, hide_uncalled=None, min_fp_quality=None, reset=False, sync_browser=False)` | The read policy this client's read methods send by default (see below). |
| `get_read_policy()` | The client's read policy (empty: the server's defaults). |
| `get_reads_image(chrom=None, start=None, end=None, dataset_id=None, width=2000, height=None, spanning=True)` | Get reads rendered as a PNG image (server-side). |
| `get_custom_reads(dataset_id)` | Get reads previously pushed from Python/Jupyter for a custom dataset. |
| `push_reads(matrix=None, index_df=None, reads_df=None, label='Jupyter')` | Push custom reads to display in browser. |
| `clear_pushed_reads()` | Clear all pushed custom reads. |
| `to_matrix(reads_df, region_width=None)` *(static)* | Convert interval-based reads DataFrame to position matrix. |
| `from_matrix(matrix, index_df=None)` *(static)* | Convert position matrix back to interval-based DataFrame. |
| `reorder_reads(reads_df, new_order)` *(static)* | Reorder reads DataFrame by row indices. |

### Modifications, deamination and layer quality

| Method | Description |
|--------|-------------|
| `get_available_mods(dataset_id=None)` | Report which modification layers the backend has detected. |
| `get_modifications(mod_type='m6a', chrom=None, start=None, end=None, dataset_id=None, spanning=True, …)` | Return per-read modification positions for the current viewport. |
| `get_deam_by_strand(strand, chrom=None, start=None, end=None, dataset_id=None, spanning=True, **kwargs)` | Deamination positions filtered to a single strand flavor. |
| `count_modifications(mod_type='m6a', chrom=None, start=None, end=None, dataset_id=None, spanning=True, …, **kwargs)` | Per-read mark count for the given modification type. |
| `scan_mod_peaks(mod_type='m6a', chrom=None, start=None, end=None, dataset_id=None, spanning=True, **kwargs)` | Peak-call on per-base modification density. |
| `cluster_by_mod(mod_type='m6a', k=5, method='kmeans', chrom=None, start=None, end=None, spanning=False, …, **kwargs)` | Scan peaks on modification density, then cluster reads by them. |
| `get_interval_qualities(layer, quality_name=None, chrom=None, start=None, end=None, dataset_id=None, …)` | Pull per-interval quality arrays for one layer. |
| `filter_reads_by_quality(layer, quality_name, min=None, max=None, mode='any', chrom=None, start=None, …)` | Return read IDs whose layer intervals pass a quality gate. |
| `get_quality_filters()` | Return active backend interval-quality filters. |
| `set_quality_filters(filters)` | Set backend quality filters used by working sets and analyses. |
| `add_quality_filter(layer, quality_name, min_value, replace=False)` | Append one backend quality filter, optionally replacing all existing filters. |
| `clear_quality_filters()` | Disable all backend interval-quality filters. |
| `get_quality_impact(chrom=None, start=None, end=None, filters=None, dataset_ids=None)` | What each quality filter keeps in a region, and which scores the data carries. |
| `set_class_support(min_value, layers=None, chrom=None, start=None, end=None)` | Filter footprint-class calls by class support (q0, 0-255); `None` turns it off. |
| `get_overlays()` | Get list of loaded modification overlays. |
| `add_overlay(path, overlay_type=None)` | Add a modification overlay from a bigBed file. |
| `remove_overlay(overlay_id)` | Remove a modification overlay. |
| `get_overlay_marks(overlay_id, chrom=None, start=None, end=None)` | Get modification marks from an overlay for a region. |

### Metaprofiles and FIRE

| Method | Description |
|--------|-------------|
| `get_meta(chrom=None, start=None, end=None, dataset_id=None, read_ids=None)` | Get meta profile (nucleosome and small-footprint occupancy) for a region. |
| `get_meta_all(chrom=None, start=None, end=None, dataset_ids=None, spanning=False)` | Get metaprofiles for all datasets at once. |
| `get_fire(chrom=None, start=None, end=None)` | Get FIRE peaks and signal for a region. |

### Peaks

| Method | Description |
|--------|-------------|
| `scan_peaks(chrom=None, start=None, end=None, dataset_id=None, dataset_ids=None, spanning=False, …, **kwargs)` | Scan for peaks using multi-threshold detection. |
| `detect_peaks(chrom=None, start=None, end=None, signal_source='accessibility', threshold_strong=0.5, …)` | Auto-detect peaks from signal tracks. |
| `detect_signal_peaks(signal, chrom, start, end, label='', min_distance=100, min_width=80, …)` | Detect peaks from an arbitrary numeric signal array. |
| `make_peaks(regions, mode='accessibility')` *(static)* | Create peak region dicts for clustering from simple coordinate tuples. |
| `get_peaks(selected_only=False, as_dataframe=True)` | Get peak coordinates from browser. |
| `set_peaks(peaks, chrom=None, label=None, lock=True, select=True, replace_existing=True)` | Push a peak set into the live browser and optionally lock it. |
| `get_peak_state()` | Return browser-synced peak rules, locked peaks, and selected peaks. |
| `set_peak_rules(rules, lock=None, clear_peaks=True, rescan=False)` | Push exact peak-rule settings into the live browser. |
| `set_peak_lock(locked=True)` | Set the live browser peak-lock state without changing peak rules. |
| `lock_peaks()` | Lock current browser peaks so autoscan cannot move them. |
| `unlock_peaks()` | Unlock current browser peaks so peak rules can rescan. |
| `load_peak_rules_json(filepath, lock=None, clear_peaks=True, rescan=False)` | Load a Peak Rules JSON export into the live browser. |
| `format_peak_bed(peaks)` *(class method)* | Format peaks as FiberBrowser BED6+ text. |
| `get_peaks_bed(selected_only=False)` | Return current browser peaks as FiberBrowser BED6+ text. |
| `save_peaks_bed(filepath, selected_only=False)` | Write current browser peaks as FiberBrowser BED6+ and return the path. |
| `parse_peak_bed(text)` *(static)* | Parse BED3/BED6 or FiberBrowser BED6+ peak text into peak dicts. |
| `load_peak_bed(filepath, as_dataframe=True)` *(class method)* | Load BED3/BED6 or FiberBrowser BED6+ peaks from disk. |
| `peak_bed_regions(filepath, mode='accessibility')` *(class method)* | Load a BED file as `cluster_all(peak_regions=...)` region dicts. |
| `import_peaks_bed(filepath, chrom=None, label=None, lock=True, select=True, replace_existing=True, …)` | Load a BED3/BED6/FiberBrowser BED6+ peak file into the live browser. |
| `get_peak_sequences(peaks=None, extend=0, strand='+', as_dataframe=True)` | Extract DNA sequences for peaks. |
| `get_selected_peak_sequences(extend=0, strand='+')` | Convenience method: get sequences for selected peaks only. |

### Clustering

| Method | Description |
|--------|-------------|
| `cluster(peak_indices, k=5, chrom=None, start=None, end=None, spanning=False, dataset_id=None, …)` | Cluster reads for a single dataset using k-means. |
| `scan_and_cluster(k=5, method='kmeans', signal_source='accessibility', min_layer=0, max_layer=None, …, **kwargs)` | Convenience: scan peaks + cluster in one call. |
| `cluster_all(peak_regions=None, k=5, method='combinatorial', dataset_ids=None, chrom=None, start=None, …, **kwargs)` | Cluster reads across multiple datasets. |
| `cluster_all_reads(chrom, start, end, peak_regions, k, spanning, dataset_ids, method='kmeans', …)` | Alias matching the frontend `clusterAllReads` helper. |
| `cluster_synced_peaks(chrom=None, start=None, end=None, dataset_ids=None, method=None, k=None, …)` | Run `cluster_all` using the browser-synced locked/selected peaks. |
| `cluster_selected_peaks_in_browser(label='Python')` | Ask the live browser to run its normal Cluster button workflow. |
| `cluster_peak_at_gene_tss_in_browser(gene_name, padding=5000, tolerance_bp=500, label='Python')` | Ask the live browser to cluster on the peak overlapping a gene TSS. |
| `cluster_by_feature_rule(rule, chrom=None, start=None, end=None, spanning=False, dataset_ids=None, …, **kwargs)` | Cluster reads using a Rules > Cluster feature rule. |
| `cluster_by_annotations(annotation_types, peak_regions=None, method='combinatorial', k=5, chrom=None, …)` | Cluster reads based on annotation overlap patterns. |
| `cluster_by_footprints(groups=None, chrom=None, start=None, end=None, dataset_ids=None)` | Cluster reads by which footprint definitions they carry, without the browser. |
| `cluster_by_saved_footprints_in_browser(label='Python')` | Ask the live browser to cluster reads by which saved footprints they carry. |
| `get_clusters(dataset_id=None)` | Get cluster assignments (if clustering was performed in browser). |
| `get_cluster_state()` | Return browser-synced cluster assignments, cluster order, and read order. |
| `get_clusters_tsv(dataset_ids=None, include_patterns=True, include_provenance=False, provenance=None)` | Export cluster assignments as the same ordered TSV schema used by the UI. |
| `save_clusters_tsv(filepath, dataset_ids=None, include_patterns=True, include_provenance=False, …)` | Write `get_clusters_tsv()` output to `filepath` and return the path. |
| `get_element_info(dataset_id=None)` | Get element/peak information from combinatorial clustering. |
| `decode_cluster(cluster_id, dataset_id=None)` | Decode a cluster ID to show which elements are accessible. |
| `get_reads_for_element(element_idx, dataset_id=None)` | Get read IDs where a specific element is accessible. |
| `auto_cull_clusters(chrom=None, start=None, end=None, assignments=None, peak_regions=None, …)` | Auto-cull low-abundance and similar clusters. |
| `dissolve_cluster(cluster_id, assignments, peak_regions, dataset_ids=None, chrom=None, start=None, …, **kwargs)` | Dissolve a cluster by reassigning its reads to the nearest remaining clusters. |
| `assign_to_clusters(cluster_patterns, peak_regions, dataset_ids=None, chrom=None, start=None, end=None, …, **kwargs)` | Assign reads to existing cluster patterns (for dynamic clustering). |
| `expand_cluster(cluster_ids, chrom=None, start=None, end=None, spanning=False, max_reads=500, …)` | Expand clusters to get reads from all datasets matching the pattern. |
| `get_cluster_vplot(chrom=None, start=None, end=None, spanning=False, size_bin=10, pos_bin=10, size_min=10, …)` | Get V-plot data (footprint size vs. |
| `get_footprint_size_enrichment(chrom=None, start=None, end=None, group_by='all', normalization='row', mode='span', …)` | Footprint size enrichment matrices, no clustering needed: all footprints by default, Gaussian sigma per axis in bp, raw values with reads and footprints per matrix. |
| `get_cluster_projection(peak_regions, dataset_ids=None, chrom=None, start=None, end=None, spanning=False, …)` | Project clustered reads into PCA/UMAP/t-SNE coordinates. |
| `get_projection_table(method='tsne', dataset_ids=None, chrom=None, start=None, end=None, …, path=None)` | The per-read projection table the Projection tab exports (x/y columns named after the method), optionally written to `path`. |
| `sort_by_projection(dataset_ids=None, chrom=None, start=None, end=None, …)` | Read order along the t-SNE map (Sort > By projection). |

### Analysis rules, sorting and filtering

| Method | Description |
|--------|-------------|
| `get_analysis_rules()` | Return browser-synced Rules panel definitions. |
| `set_analysis_rules(cluster_feature_rules=None, analysis_sort_rules=None, analysis_filter_rules=None)` | Replace Rules panel definitions from Python/Jupyter. |
| `set_cluster_feature_rules(rules)` | Replace Cluster tab feature rules in the Rules panel. |
| `set_analysis_sort_rules(rules)` | Replace Sort tab rules in the Rules panel. |
| `set_analysis_filter_rules(rules)` | Replace Filter tab rules in the Rules panel. |
| `save_analysis_rules_json(filepath)` | Save browser-synced cluster/sort/filter analysis rules as JSON. |
| `load_analysis_rules_json(filepath)` | Load a JSON file written by `save_analysis_rules_json` or the UI. |
| `resolve_analysis_rule_windows(rule, chrom=None, start=None, end=None, peaks=None, selected_peaks=None, …)` | Resolve a Rules scope to absolute genomic windows. |
| `resolve_cluster_feature_rule_regions(rule, chrom=None, start=None, end=None, peaks=None, …)` | Resolve a Cluster Analysis Rule to `cluster_all` peak regions. |
| `sort_reads(sort_by='fp_count', chrom=None, start=None, end=None, spanning=False, **kwargs)` | Sort reads/clusters by a metric. |
| `sort_by_analysis_rule(rule, chrom=None, start=None, end=None, spanning=False, dataset_ids=None, …)` | Run the same backend sort used by a Rules > Sort entry. |
| `sort_by_transcription_state(gene_ids, state_kind='elongating', chrom=None, start=None, end=None, …)` | Sort reads by a Pol II state metric using Transcription-panel definitions. |
| `filter_by_analysis_rule(rule=None, chrom=None, start=None, end=None, spanning=False, dataset_ids=None, …)` | Filter reads with the Rules backend endpoint. |
| `pin_analysis_filter_result(result)` | Pin a `filter_by_analysis_rule` response as the browser's active per-dataset read filter (one /api/jupyter/filter POST per dataset). |
| `filter_reads_by_ids(read_ids, dataset_id=None)` | Pin a specific set of read IDs as the browser's display filter. |
| `filter_by_peaks(peak_regions=None, peak_indices=None, filter_mode='either', dataset_id=None, chrom=None, …)` | Filter reads by peak region overlap. |
| `filter_by_annotations(annotation_types, filter_mode='has_any', chrom=None, start=None, end=None, …)` | Filter reads by annotation overlap. |

### Filtering, selection, order and highlights in the live browser

| Method | Description |
|--------|-------------|
| `filter_reads(read_ids, dataset_id=None)` | Filter browser view to show only specified reads. |
| `get_read_filter(dataset_id=None)` | Get the active Jupyter-controlled read filter for a dataset. |
| `clear_filter(dataset_id=None)` | Clear read filter, show all reads. |
| `get_selection(dataset_id=None)` | Get read IDs selected by user/browser or Python selection commands. |
| `set_jupyter_selection(read_ids, dataset_id=None)` | Set the read IDs selected in the live browser from Python/Jupyter. |
| `get_jupyter_state()` | Get full Jupyter integration state (for debugging). |
| `set_read_order(read_ids, dataset_id=None)` | Set custom read ordering. |
| `get_read_order(dataset_id=None)` | Get current custom read ordering. |
| `get_browser_read_order(dataset_id=None)` | Get the latest top-to-bottom read order reported by the browser. |
| `clear_read_order(dataset_id=None)` | Reset to default read ordering. |
| `highlight_reads(read_ids, color='#ff0000', label=None, dataset_id=None)` | Highlight specific reads with a color. |
| `highlight_footprints(footprints, color='#ff0000', label=None, dataset_id=None)` | Highlight specific footprints. |
| `get_highlights()` | Get all current highlights. |
| `remove_highlight(highlight_id)` | Remove a specific highlight by ID. |
| `clear_highlights(group=None)` | Clear read highlights. |
| `color_footprints(footprint_colors, group='default')` | Color specific footprints on specific reads. |
| `get_footprint_colors()` | Get all current Jupyter-controlled footprint color groups. |
| `remove_footprint_colors(color_id)` | Remove a specific footprint color group by ID. |
| `clear_footprint_colors(group=None)` | Clear footprint colorings. |
| `add_markers(positions, group='default')` | Add position markers (vertical lines) to the view. |
| `get_markers()` | Get all current Jupyter-controlled marker groups. |
| `remove_marker(marker_id)` | Remove a specific marker group by ID. |
| `clear_markers(group=None)` | Clear position markers. |

### Transcription state

| Method | Description |
|--------|-------------|
| `get_transcription_state_selection()` | Return selected genes and filter settings synced from the browser. |
| `set_selected_genes(genes)` | Replace the live browser's selected genes used by Pol II analyses. |
| `set_transcription_state_filters(filters)` | Replace the Transcription panel filter settings. |
| `filter_by_transcription_state(gene_ids, filters=None, chrom=None, start=None, end=None, spanning=False, …)` | Filter reads by transcription state criteria relative to gene(s). |
| `get_transcription_state_counts(gene_ids, chrom=None, start=None, end=None, spanning=False, …)` | Fetch the same state-count summary used when the browser panel opens. |
| `get_pol2_com(gene_ids, dataset_ids=None, fp_size_min=35, fp_size_max=65, n_bins=100, chrom=None, …)` | Pol II center-of-mass heatmap data sorted by COM position. |

### Footprints

| Method | Description |
|--------|-------------|
| `analyze_footprints(chrom=None, start=None, end=None, dataset_id=None, read_ids=None, footprints=None, …)` | Run footprint analysis on explicit footprint regions. |
| `format_footprint_cooccurrence_tsv(result, groups, datasets=None)` *(class method)* | Format Footprints co-occupancy output as TSV. |
| `save_footprint_cooccurrence_tsv(filepath, result, groups, datasets=None)` | Write Footprints co-occupancy output to a TSV file. |
| `get_footprint_rules()` | Return browser-synced saved footprint list (Footprints > Saved) rules. |
| `get_footprint_rule_summary()` | Return the session-manifest summary of saved footprint list (Footprints > Saved) rules. |
| `set_footprint_rules(groups)` | Replace the live browser saved footprint list (Footprints > Saved) from Python. |
| `save_footprint_rules(output_dir, groups=None, chrom=None, start=None, end=None, dataset_id=None, …)` | Save saved footprint list (Footprints > Saved) definitions as portable rule JSON. |
| `load_footprint_rules(path, apply=True, append=False)` | Load portable saved footprint list (Footprints > Saved) rules from JSON. |
| `save_derived_layers(output_dir, groups=None, chrom=None, start=None, end=None, dataset_id=None, …)` | Save footprint cart definitions as materialized `.fiberlayers` bundles. |
| `load_derived_layers(path, dataset_id=None, dataset_ids=None)` | Load a saved `.fiberlayers` bundle into matching loaded datasets. |

### Read statistics

| Method | Description |
|--------|-------------|
| `get_read_stats(read_ids_by_dataset, chrom=None, start=None, end=None, spanning=False, as_dataframe=True, …)` | Get per-read alignment and footprint statistics. Read Stats applies the read track's filters, each optional (default: the read policy): `include_duplicates`, `include_qcfail`, `hide_uncalled`, `min_fp_quality`, `min_footprints` (-1: all reads), plus the active quality filters. The summary counts the reads hidden in the region by reason. |
| `get_read_stats_tsv(read_ids_by_dataset, chrom=None, start=None, end=None, spanning=False, …)` | Return selected read stats as TSV in browser/table viewer order. |
| `save_read_stats_tsv(filepath, read_ids_by_dataset, chrom=None, start=None, end=None, spanning=False, …)` | Write `get_read_stats_tsv()` output to `filepath` and return the path. |

### Browser settings, labeling and panels

| Method | Description |
|--------|-------------|
| `set_reproducibility(seed=None, analysis_cap=None, display_cap=None, spanning=None, display_mode=None, …)` | Push global browser reproducibility/display controls from a notebook. |
| `set_cluster_settings(method=None, k=None, small_footprint_threshold_bp=None, …)` | Push browser clustering controls from a notebook. |
| `set_display_settings(enabled_mod_types=None, enabled_meta_profiles=None, cached_layer_types=None, …)` | Push browser display/layer controls from a notebook. |
| `set_legacy_layer_inference(enabled=True, nuc_min_size=90)` | Configure inferred TF/nuc/FIRE layers for legacy footprint-only files. |
| `set_visible_layers(layers=None, **layer_states)` | Toggle read-level layer visibility from Python/Jupyter. |
| `set_metaprofile_layers(layers=None, follow_active_layers=None, **layer_states)` | Show or hide the default metaprofile's sources; a change switches it from following the active layers to manual. `follow_active_layers=True` makes it follow again. |
| `set_metaprofile_follow(follow=True)` | The default metaprofile follows the Tracks layer toggles (True) or keeps its own sources (False). |
| `get_metaprofile_layers()` | What the default metaprofile shows: `{"layers": {...}, "follow_active_layers": bool}`. |
| `set_layer_cache(layers=None, **layer_states)` | Toggle which optional layers are prefetched into read-window caches. |
| `set_browser_settings(**kwargs)` | Push browser settings using either aliases or raw snapshot keys. |
| `get_browser_settings()` | Return the latest browser-synced reproducibility/peak settings. |
| `apply_browser_settings(settings, apply_peak_rules=True, clear_peaks=True, rescan=False)` | Apply a settings snapshot captured with `get_browser_settings`. |
| `sync_jupyter_browser_settings(settings)` | Store a browser settings snapshot using the same endpoint as the UI. |
| `save_browser_settings_json(filepath)` | Save current browser settings snapshot as JSON and return filepath. |
| `load_browser_settings_json(filepath, **kwargs)` | Load and apply a JSON settings snapshot saved from the browser. |
| `get_analysis_state()` | Return browser-synced peaks, filters, capture regions, and track cart. |
| `get_active_filters()` | Return active Labeling preset and analysis quality filters. |
| `set_labeling_preset(colormap, apply_quality_filters=True)` | Push the active Labeling preset into the live browser. |
| `get_labeling_preset()` | Return a copy of the currently synced Labeling preset. |
| `load_labeling_json(filepath, apply_quality_filters=True)` | Load a Labeling JSON export into the live browser. |
| `save_labeling_json(filepath)` | Save the currently synced browser Labeling preset as JSON. |
| `set_labeling_display(*, read_background=None, no_read_background=None, smoothing_enabled=None, …)` | Update Labeling display controls from Python/Jupyter. |
| `set_layer_opacity(layer, opacity, apply_quality_filters=True)` | Set one Labeling layer opacity from Python/Jupyter. |
| `add_labeling_rule(name, color='#888888', size_min=1, size_max=None, target_layers=None, conditions=None, …)` | Append one labeling rule to the live browser preset. |
| `add_pol2_gene_exclusion_rule(gene_name=None, gene_id=None, name=None, color='#ff69b4', size_min=35, …)` | Append a Pol II-sized footprint rule excluding one gene. |
| `normalize_panel_type(panel_type)` *(class method)* | Return the canonical browser panel id for a user-facing alias. |
| `known_panel_types()` *(class method)* | Return canonical built-in panel ids accepted by the browser strip. |
| `get_panel_state()` | Return active panels, hidden strip panels, and known built-in ids. |
| `open_panel(panel_type)` | Open an analysis panel in the live browser from Python/Jupyter. |
| `close_panel(panel_type)` | Close an analysis panel in the live browser from Python/Jupyter. |
| `set_hidden_panels(panel_types)` | Replace analysis-strip hidden panel settings. |
| `show_strip_panels(panel_types=())` | Unhide selected strip panels, or show all panels when omitted. |
| `hide_strip_panels(panel_types)` | Hide selected panels from the analysis strip without closing them. |

### Read filters, layer colours and the view (3.1)

These set the open browser's controls. With no tab open, figures from the
defaults follow them too (see [Headless server](#headless-server)).

| Method | Description |
|--------|-------------|
| `set_read_filters(min_footprints=None, min_fp_quality=None, show_duplicates=None, show_qc_fail=None, all_reads=None)` | The Reads toolbar's filters. `min_footprints=-1` (or `all_reads=True`) is "All reads, including uncalled"; `all_reads=False` goes back to a threshold (`min_footprints`, default 5). |
| `get_read_filters()` | The browser's `min_footprints`, `min_fp_quality`, `show_duplicate_reads`, `show_qc_fail_reads`. |
| `set_reverse_view(reversed=True)` | Reverse the view. "Flip to gene direction" turns this on for a minus-strand gene, so reads and metaprofiles flip together. |
| `set_layer_colors(colors=None, replace=False, **layer_colors)` | The session's layer colours (Labels → Layer colours), `#rrggbb`; `None` resets a layer; `replace=True` drops the others. Aliases share a colour (msp = fire, mod = m6a, footprint = nuc). |
| `reset_layer_colors(layers=None, include_saved_defaults=False)` | Reset the named layers (default: all) to the saved default or, with `include_saved_defaults`, the built-in colour. |
| `get_layer_colors()` | `{"session", "saved_defaults", "effective"}`: the session's colours win over the saved defaults, which win over the built-in colours. |
| `set_default_layer_colors(colors=None, **layer_colors)` | Save default colours on this computer ("Save as my default colours"; `None` forgets one). Refused on a public server and in a tour tab. |
| `get_default_layer_colors()` | The saved default colours. |
| `save_layer_colors_as_default()` | The colours shown now become the saved defaults. |

```python
client.set_read_filters(all_reads=True, show_qc_fail=True)
client.set_layer_colors(nuc="#4b5563", tf="#dc2626")       # this session
client.set_default_layer_colors(fire="#f59e0b")             # every new session on this computer
client.set_metaprofile_layers(tf=False)                     # the default metaprofile is now manual
client.set_metaprofile_follow(True)                         # ...and follows the layer toggles again
```

Sources of the default metaprofile that follow a layer take that layer's
colour, as in the browser. A source you recoloured keeps its own colour.

Named nucleosome classes (small, hexasome, octasome, chromatosome) were removed
in 3.1. Rules and presets sent from Python lose any `nucNamed` condition, with
a warning, as the browser drops them from saved rules. Coarse classes, z and
posterior remain.

### Quantify a window

Quantify a window measures each layer inside a window of the metaprofiles, per
dataset or cluster, with intervals. The browser computes the numbers; from
Python you set what it measures and read its state back.

| Method | Description |
|--------|-------------|
| `set_window_quant(window=…, spec=None, axis=None, open_in=…)` | Set any of the window, the spec, the axis and where the card shows (fields left out are unchanged). |
| `set_quant_window(chrom=None, start=None, end=None, relative=False)` | The window in genome bp, or with `relative=True` as distances from the axis anchor; no arguments clear it. |
| `set_quant_spec(**spec)` | Measures × bounds × comparison and the statistics. Fields: `measures` (empty: the active layers), `bounds` (`window`, `region`, `sites`), `comparison` (`clusters`, `datasets`, `clusters-datasets`, `pools`), `value` (`raw`, `enrichment`), `baseline`, `stat` (`mean`, `area`), `compare` (`off`, `diff`, `log2ratio`), `ci`, `resamples`, `seed`, `min_reads`, `read_cap`, `layer_units` (`curve`, `exact`), `read_source` (`panel`, `fetch`), `size_from`/`size_to`. Snake case or the browser's camelCase. |
| `set_metaprofile_axis(mode='relative', anchor='tss', gene=None, position=None)` | The metaprofiles' x-axis: `genome`, or `relative` to a gene's `tss` or `gene-end`, the view `centre`, a `position`, or the meta-locus `site`. `gene=None`: the gene nearest the view centre. |
| `open_quantify(where='track')` | Show the card on the metaprofile track (`track`) or in the cluster profiles (`cluster`); `None` closes it. |
| `get_window_quant()` | `window`, `spec`, `axis`, `openIn` as the browser holds them (saved with the session as `frontend.windowQuant`). |

```python
client.set_metaprofile_axis("relative", anchor="tss")
client.set_quant_window(start=-200, end=200, relative=True)       # TSS ± 200 bp
client.set_quant_spec(measures=["nuc", "tf"], comparison="clusters", value="enrichment")
client.open_quantify("cluster")
```

A plot never flips on its own. Relative distances are signed by the anchor's
strand, upstream negative. To read a minus-strand gene left to right, reverse
the view (`set_reverse_view(True)`); reads and plots then flip together.

### Plots

Plots is a workspace. It covers the reads, builds one plot at a time from a
PlotSpec, and keeps the plots you keep in its Gallery. The browser draws the
plots. From Python you open a plot, keep it, and read the builder and the
Gallery back. Figures don't draw Plots (see [Figures](#figures)); export a plot
with Save in Plots or on its Gallery card.

| Method | Description |
|--------|-------------|
| `open_plot(spec=None, **fields)` | Open Plots with a new plot in the builder. `spec` is a PlotSpec as Plots saves it (`get_plot_spec()`, a Gallery card's plot, a session's `plotsWorkspace.current`); `fields` override it: `type`, `source` or `sources` (several layers in one plot), `where`, `group_by`, `compare`, `summary`, `sampling`, `axis`, ... Unknown values fall back to the defaults, as in the browser. |
| `keep_plot(name=None)` | Keep the builder's plot in the Gallery (Keep). The plot must have been drawn. |
| `get_plots_state()` | `workspace`, `builder` (the plot being edited, the BED sets loaded) and `gallery` (each card's id, name, status: working or kept). |
| `get_plot_spec()` | The PlotSpec in the builder; `open_plot(spec)` reopens it. |
| `set_workspace(view='browser')` / `close_plots()` | Which workspace covers the reads: `browser`, `plots` or `hub`. The hub workspace is experimental: with its setting off (Settings › Read Display › Experimental, the default), `hub` leaves the browser showing. |
| `load_bed_regions(path)` | Read a BED as Plots does for Where = BED region sets (regions, skipped lines, name). |

```python
client.open_plot(type="metaprofile", sources=["nuc", "tf"], group_by="cluster")
# ...after the plot has drawn in the browser:
client.keep_plot("Figure 2b")
spec = client.get_plot_spec()                   # reproducible: open_plot(spec) redraws it
client.close_plots()
```

### Meta-locus (Preview)

A meta-locus pools a BED file's sites (for example all TSSs ± 10 kb) into one
virtual locus. Minus-strand sites are flipped, and a seeded working set of
reads is drawn from the pool, which you browse, cluster and plot like any
locus. It is a Preview feature in the browser. The pool calls work on any
local or lab server; the live calls drive the open tab.

| Method | Description |
|--------|-------------|
| `start_meta_locus_pool(bed_path=None, regions=None, name=None, dataset_ids=None, anchor='centre', flank_bp=10000, wait=False, timeout=600, …)` | Build (or reuse) the pool in the background; `wait=True` polls until it is ready. |
| `wait_meta_locus_pool(pool_id, timeout=600)` | Poll a pool until ready, failed or cancelled. |
| `probe_meta_locus_pool(bed_path=None, regions=None, anchor='centre', flank_bp=10000)` | Is this pool built already (`cached`)? |
| `list_meta_locus_pools()` / `get_meta_locus_pool(pool_id)` | Pools and their status and progress. |
| `cancel_meta_locus_pool(pool_id)` / `delete_meta_locus_pool(pool_id)` | Stop a build; drop a pool. |
| `get_meta_locus_reads(pool_id, seed=1, count=2000, cursor=None, **filters)` | A seeded working set; More reads (pass the previous `cursor`); Resample (another `seed`). Reads are in window coordinates with their site in `meta`. Filters: `include_duplicates`, `min_footprints`, `min_fp_quality`, terminal-gap options; QC-fail reads are not part of a pool's working set (an unknown filter is an error). |
| `get_meta_locus_view(pool_id)` / `set_meta_locus_view(pool_id, seed=None, count=None, more=None, resample=False, clear_extra=False)` | What the virtual contig shows. |
| `find_more_meta_locus(pool_id, read_ids_by_dataset, k=200)` | Find more like these reads in the pool (Wilson 95% frequency). |
| `refill_meta_locus(pool_id, assignments, target_per_cluster=None)` | Keep the workspace full: top up each cluster from the pool. |
| `open_meta_locus(bed_path, anchor='centre', flank_bp=10000, dataset_ids=None, count=None, seed=None, enable_preview=False)` | Open a BED as a meta-locus in the browser. `enable_preview=True` turns Preview features on if they are off. |
| `meta_locus_more_reads(count=1000)` / `meta_locus_resample(seed=None)` / `meta_locus_find_more(k=200, read_ids_by_dataset=None)` / `meta_locus_clear_extra()` | More reads, Resample, Find more like this, take out the added reads. |
| `meta_locus_back()` / `meta_locus_return()` | Back to the real locus; back to the meta-locus. |
| `get_meta_locus_state()` | The open meta-locus (BED, anchor, flank, seed, count, added reads, pool id), or None. |
| `get_meta_locus_profile(pool=None, seed=None, count=None, channels=None, *, session=None, bins=None, out_tsv=None, out_json=None, load_session=False)` | Headless: the metaprofile per bin, channel and group (all, per dataset, per cluster) of a pool or a session on a meta-locus view; see "Pooled loci (meta-locus) from Python and the command line". |
| `quantify_window(bounds=None, measures=None, comparison=None, seed=None, *, spec=None, out_tsv=None, load_session=False, **spec_fields)` | Headless: the Quantify card's table (Wilson and bootstrap intervals, the same seeds) for a window of a pool (`bounds={"meta_locus": ..., "window": [-200, 50]}`) or a session's view. |

```python
pool = client.start_meta_locus_pool("tss.bed", flank_bp=2000, wait=True)
ws = client.get_meta_locus_reads(pool["pool_id"], seed=1, count=1000)
client.open_meta_locus("tss.bed", flank_bp=2000, count=1000, seed=1, enable_preview=True)
```

### Find sequence

| Method | Description |
|--------|-------------|
| `get_sequence_search_status()` | Whether the loaded genome is searchable, whether BLAST is ready, and the defaults. |
| `find_sequence(sequence, mode=None, max_mismatches=None, evalue=None, max_hits=None, min_length=None, …, wait=True, timeout=600)` | Find a pasted sequence (FASTA, spaces and numbers allowed) in the genome; returns the finished job, its hits in `job["result"]["hits"]` (or the job to poll with `wait=False`). Options left `None` take the defaults. |
| `get_sequence_search_job(job_id)` / `cancel_sequence_search(job_id)` | Poll or cancel a search. |
| `add_sequence_search_track(job_id, label=None)` | A finished search's hits as a temporary annotation track. |

Not on a public server. On a lab server the request carries only the sequence
and numbers, never a path.

### FiberHMM runs

Thin wrappers over the Run wizard's routes. They are local or lab-server only,
with the server's own limits.

| Method | Description |
|--------|-------------|
| `scan_run_inputs(paths, input_kind='reads')` | The samples found in files, folders and zips. |
| `validate_fiberhmm_run(samples, reference, enzyme='dddb', output_root='', regions=None, cores=0, options=None, min_mapq=None, …)` | Check a run (no job starts): errors, warnings and each job's command. |
| `run_fiberhmm(samples, reference, …, min_mapq=None, …, nuc_recall_policy=None)` | Start one job per sample. Every new run passes `--min-mapq` explicitly (default 0). `nuc_recall_policy="topology"` (Hia5 and DddB) keeps fragment structure in nucleosome recall; the default is conservative. |
| `get_pipeline_jobs()` / `get_pipeline_job(job_id)` / `get_pipeline_job_log(job_id)` / `cancel_pipeline_job(job_id)` | Follow or stop runs. |
| `recall_library_entry(entry_id, dry_run=True, plan_id=None, cores=None, outdir=None, input=None, keep_old=None)` | Re-call a library dataset with the current FiberHMM, keeping its run's settings, recorded MAPQ included. `dry_run` returns the plan and its `plan_id`; start exactly that plan with `dry_run=False, plan_id=...`. |

### Co-accessibility

| Method | Description |
|--------|-------------|
| `get_coacc_matrix(chrom=None, start=None, end=None, normalization='oe', bin_size=0, min_coverage=20, …)` | Get co-accessibility matrix as numpy array or pandas DataFrame. |
| `get_coacc_matrix_data(chrom, start, end, bin_size=None, dataset_ids=None, normalization=None, …)` | Frontend-name wrapper returning the raw co-accessibility response. |
| `get_coacc_slice(position, chrom=None, start=None, end=None, normalization='oe', bin_size=0, …)` | Get 1D co-accessibility profile from a viewpoint position (virtual 4C). |
| `get_coacc_arcs(chrom=None, start=None, end=None, threshold=1.5, normalization='oe', bin_size=0, …)` | Get top co-accessible pairs as arcs. |
| `get_coacc_metadata(chrom=None, start=None, end=None, bin_size=0, normalization='oe', min_coverage=20, …)` | Get co-accessibility metadata (n_reads, bins, coverage stats). |
| `get_coacc_image(chrom=None, start=None, end=None, normalization='oe', scaling='linear', colormap='fall', …)` | Get co-accessibility matrix as a PIL Image (heatmap). |
| `get_coacc_matrix_png(chrom=None, start=None, end=None, dataset_id=None, dataset_ids=None, …)` | Return the co-accessibility matrix PNG used by the browser panel. |
| `save_coacc_matrix_png(filepath, **kwargs)` | Save the co-accessibility matrix PNG and return `filepath`. |
| `get_coacc_strip(chrom=None, start=None, end=None, width=800, height=120, normalization='oe', …)` | Get co-accessibility triangular strip as PIL Image. |
| `get_coacc_strip_png(chrom=None, start=None, end=None, width=800, height=120, dataset_id=None, …)` | Return the compact triangular co-accessibility strip PNG used by the track. |
| `save_coacc_strip_png(filepath, **kwargs)` | Save the co-accessibility track strip PNG and return `filepath`. |
| `get_coacc_settings()` | Return browser-synced co-accessibility panel/track settings. |
| `set_coacc_settings(track_mode=None, signal_type=None, layer=None, normalization=None, scaling=None, …, **raw_settings)` | Push co-accessibility panel/track settings from Python/Jupyter. |

### Tracks and motifs

| Method | Description |
|--------|-------------|
| `get_tracks()` | Get list of loaded orthogonal tracks (bigWig, bigBed, etc.). |
| `get_tracks_batch(track_indices, chrom=None, start=None, end=None, bins=500, annotation_filters=None)` | Fetch multiple signal/annotation track payloads in one request. |
| `add_track(path, label=None, render_mode=None, track_type=None, ucsc_genome=None, ucsc_track=None, …)` | Add an orthogonal track (bigWig, bigBed, BED, or UCSC API track). |
| `remove_track(track_idx)` | Remove an orthogonal track by index. |
| `reorder_tracks(from_index, to_index)` | Move one orthogonal track from `from_index` to `to_index`. |
| `filter_track(track_idx, filter_names=None)` | Filter track annotations by one or more names; pass None/empty to clear. |
| `get_track_signal(track_idx, chrom=None, start=None, end=None, bins=500)` | Get signal values from an orthogonal track (BigWig, BED, etc.). |
| `get_track_data(track_idx, chrom=None, start=None, end=None, bins=None)` | Frontend-name wrapper returning the full track data response. |
| `get_track_annotations(track_idx, chrom=None, start=None, end=None, filter_names=None)` | Get annotation intervals from a track (BigBed, BED, motif). |
| `export_track(track_idx, chrom, start, end, format='bedgraph', bins=2000, output_path=None)` | Export one track region as bytes; optionally write to `output_path`. |
| `export_tracks_multi(track_indices, labels, chrom, start, end, bins=2000, output_path=None)` | Export multiple tracks as TSV bytes; optionally write to `output_path`. |
| `get_track_cart()` | Return browser-synced track catalog/cart/saved-presets state. |
| `set_track_cart(catalog=None, composite_tracks=None, saved_tracks=None)` | Replace browser track catalog/cart pieces from Python. |
| `get_bigbed_names(url, genome=None, sample_size=None)` | Get unique names from a BigBed-backed motif/annotation source. |
| `add_motif_track(name, sequence, threshold=0.8, render_mode=None)` | Add a motif track by DNA sequence (scans reference for matches). |
| `add_motif_pwm_track(name, counts, label=None, threshold=0.85)` | Add a motif track from a raw A/C/G/T PWM or count dictionary. |
| `add_motif_track_file(file_path, format=None, threshold=0.8)` | Add motif tracks from a file (JASPAR, MEME, PFM, HOMER). |
| `search_jaspar(query, limit=20, genome=None)` | Search JASPAR CORE by TF name or matrix ID (e.g. |
| `add_jaspar_motifs(names_or_ids, threshold=0.85)` | Add JASPAR motifs as scanned tracks, by matrix ID or TF name. |
| `list_motifs(species=None, tax_group=None, tf_family=None, name_contains=None, as_dataframe=True)` | List available JASPAR motifs with optional filtering. |
| `search_motifs(peaks=None, motifs=None, motif_ids=None, threshold=0.8, extend=0, both_strands=True, …)` | Search for TF motifs in peak sequences. |
| `load_custom_motif(name, pwm)` | Load a custom PWM for motif searching. |
| `load_custom_motifs(file_path, format='auto')` | Load motifs from a file. |
| `list_custom_motifs(as_dataframe=True)` | List all registered custom motifs. |
| `clear_custom_motifs(name=None)` | Remove custom motifs. |
| `delete_custom_motif(name)` | Remove a specific custom motif. |

### External track sources and S3

| Method | Description |
|--------|-------------|
| `get_ucsc_curated(genome)` | Get curated UCSC tracks for a genome. |
| `search_ucsc_tracks(genome, query)` | Search UCSC tracks for a genome. |
| `browse_ucsc_tracks(genome)` | Browse UCSC tracks grouped by category for a genome. |
| `get_encode_facets(genome)` | Get ENCODE search facets for a genome. |
| `search_encode(genome, assay=None, target=None, biosample=None, query=None, limit=25)` | Search ENCODE bigWig tracks. |
| `get_chipatlas_status()` | Get ChIP-Atlas metadata loading status. |
| `get_chipatlas_facets(genome)` | Get ChIP-Atlas facets for a genome. |
| `search_chipatlas(genome, antigen_class=None, antigen=None, cell_type_class=None, cell_type=None, limit=25)` | Search ChIP-Atlas tracks. |
| `get_s3_status()` | Get S3 support/configuration status. |
| `configure_s3(profile=None, region=None, endpoint_url=None)` | Configure S3 or S3-compatible storage access for this server. |
| `test_s3_access(url)` | Test access to an S3 URL such as `s3://bucket/key`. |
| `list_s3_bucket(bucket, prefix='', max_keys=100)` | List objects in an S3 bucket/prefix. |
| `get_presigned_url(url, expiration=3600)` | Generate a temporary presigned URL for an S3 object. |

### Dataset catalog

| Method | Description |
|--------|-------------|
| `get_catalog()` | Get the configured dataset catalog, if the server was launched with one. |
| `catalog_load(group_index)` | Load a catalog dataset group into the current browser session. |
| `catalog_unload(group_index)` | Unload a catalog dataset group from the current browser session. |
| `catalog_track_load(track_index)` | Load a catalog orthogonal track into the current browser session. |
| `catalog_track_unload(track_index)` | Unload a catalog orthogonal track from the current browser session. |

### Per-read annotations

| Method | Description |
|--------|-------------|
| `list_annotations()` | List loaded annotation files. |
| `add_annotation(path, label=None, dataset_ids=None)` | Add an annotation file (BED, BigBed, etc.). |
| `activate_annotation(file_id)` | Activate an annotation file for display. |
| `deactivate_annotation(file_id)` | Deactivate an annotation file from display. |
| `delete_annotation(file_id)` | Remove an annotation file. |
| `browse_annotations(directory)` | Browse annotation BigBed files in a local directory. |
| `get_annotations(chrom=None, start=None, end=None, dataset_ids=None, file_ids=None, as_dataframe=True, …)` | Get per-read annotations (e.g., FiberCNN/factorCNN predictions) in a region. |
| `get_annotation_profile(chrom=None, start=None, end=None, file_id=None, dataset_id=None, …)` | Get annotation density profile for a region. |
| `set_annotation_threshold(type_name, threshold)` | Set display threshold for an annotation type. |

### Multi-region compilation

| Method | Description |
|--------|-------------|
| `compile_regions(regions, dataset_id=None, spanning=True, max_reads_per_region=200, anchor='center', …)` | Compile reads from multiple genomic regions into a single normalized view. |
| `render_compiled(regions, width=2000, row_height=3, max_reads=500, show_mods=False, show_fire=False, …)` | Compile reads from multiple regions and render as a single PIL Image. |

### Contact maps (Micro-C / DAF-C)

| Method | Description |
|--------|-------------|
| `load_dafc(cool_file=None, bigbed_file=None)` | Load a .cool/.mcool or DAF-C BigBed file for contact analysis. |
| `get_dafc_status()` | Get DAF-C / Micro-C loading status. |
| `get_dafc_image(chrom=None, start=None, end=None, resolution=None, normalization='none', scaling='log', …)` | Get DAF-C/Micro-C contact matrix as PIL Image. |
| `select_dafc_region(chrom, x_start, x_end, y_start, y_end)` | Query a DAF-C/Micro-C selected contact region for contacts and linked reads. |
| `get_microc_matrix(chrom=None, start=None, end=None, normalization='none', resolution=None)` | Get Micro-C contact matrix data. |
| `get_microc_arcs(chrom=None, start=None, end=None, threshold=0.1, max_arcs=100, min_distance=5000, …)` | Get top Micro-C contact pairs as arcs. |
| `get_microc_virtual4c(viewpoint_start=None, viewpoint_end=None, profile_start=None, profile_end=None, …)` | Get Micro-C virtual 4C profile from a viewpoint position. |
| `get_microc_strip(chrom=None, start=None, end=None, width=800, height=120, normalization='none', …)` | Get Micro-C triangular strip as PIL Image. |
| `get_microc_apa(peaks=None, window=10000, resolution=None, chrom=None, normalization='oe', anchors=None)` | Aggregate Peak Analysis (APA) for Micro-C data. |
| `precompute_microc_expected(chrom=None, resolution=None)` | Precompute a chromosome's expected contacts for global O/E. |
| `get_microc_expected_status()` | Check status of expected value computation. |
| `create_linked_session()` | Create a linked split-view session for DAF-C or Micro-C regions. |
| `get_linked_sessions()` | List active linked split-view sessions. |
| `get_linked_session(session_id)` | Get linked split-view session state. |
| `send_to_linked_session(session_id, regions=None, read_ids=None, contact_mode=None, split_view_mode=None, …)` | Send a DAF-C/Micro-C region pair to a linked split-view session. |
| `get_linked_reads_data(session_id)` | Get raw linked read data for a split-view session. |
| `get_linked_reads_compact(session_id, region, max_reads=500, sort_by='x', hide_terminal_gaps=True, …)` | Get linked reads in compact ReadTrack format for region `'x'` or `'y'`. |
| `get_linked_reads_image(session_id, region, max_width=2000, row_height=3)` | Render linked reads for region `'x'` or `'y'` as a PIL image. |
| `delete_linked_session(session_id)` | Delete a linked split-view session. |

### Primers and capture regions

| Method | Description |
|--------|-------------|
| `get_primer_config()` | Get current primer design configuration (FASTA, BLAST DB). |
| `set_primer_config(fasta_path=None, blast_db_path=None)` | Configure primer design tool. |
| `build_primer_blast_db(force=False, output_dir=None)` | Build/select a local primer BLAST DB from the browser's loaded FASTA. |
| `design_primers(chrom=None, start=None, end=None, min_product=5000, max_product=50000, min_tm=55.0, …, **kwargs)` | Design PCR primers for a genomic region. |
| `design_dafc_primers(chrom, x_start, x_end, y_start, y_end, y_chrom=None, min_product=5000, …, **kwargs)` | Design DAF-C/3C primer pairs for two loci. |
| `design_4c_primers(chrom=None, start=None, end=None, min_spacing=50, max_spacing=500, min_tm=55.0, …, **kwargs)` | Design outward-facing 4C primers inside a viewpoint interval. |
| `get_primers()` | Get currently designed primers. |
| `get_primer_results()` | Get the raw latest primer-design result payload. |
| `get_primer_progress()` | Get progress for the active primer design job. |
| `abort_primer_design()` | Abort the active primer design job. |
| `clear_primers()` | Clear all designed primers. |
| `format_primer_order(primers=None, format='idt')` | Format primers for IDT, Azenta/GENEWIZ, Eurofins, Sigma, generic CSV, or FASTA. |
| `save_primer_order(filepath, primers=None, format='idt')` | Write a vendor primer-order file and return `filepath`. |
| `get_primer_cart()` | Return browser-synced primer cart state from the Primers panel. |
| `set_primer_cart(saved_primers=None, mode=None, cart_track_display=None)` | Replace Primer Design cart state in the live browser. |
| `get_capture_regions()` | Return browser-synced capture cart regions. |
| `set_capture_regions(regions, padding=None)` | Replace the browser capture cart from Python. |

### Copilot

| Method | Description |
|--------|-------------|
| `get_copilot_capabilities()` | Return Copilot-safe API routes, backend status, and model metadata. |
| `plan_natural_language_command(text, context=None, model=None, previous_turns=None)` | Plan a browser workflow from natural language without executing it. |
| `stream_natural_language_command(text, context=None, model=None, previous_turns=None, timeout=120)` | Yield NDJSON Copilot planning events from `/api/nl/stream`. |
| `get_copilot_agent_tools()` | Return the tool schema used by the experimental Copilot agent loop. |
| `copilot_agent_step(messages=None, text=None, context=None, model=None, previous_turns=None)` | Run one backend Copilot agent iteration. |
| `setup_copilot(model_id=None)` | Install/start the configured local Copilot model backend. |
| `probe_copilot_backends()` | Report whether MLX and Ollama Copilot backends are reachable. |
| `set_copilot_backend(backend)` | Switch the active Copilot backend to `'mlx'` or `'ollama'`. |
| `log_copilot_session(session_id=None, started_at=None, snapshots=None, command_history=None, …)` | Persist a browser session log for Copilot evaluation/training. |
| `get_copilot_share_status()` | Return local shared-usage file status. |
| `clear_copilot_shared_usage()` | Clear the local shared-usage file. |
| `reveal_copilot_shared_usage()` | Open the local shared-usage file/folder from the backend process. |
| `get_copilot_share_upload_status()` | Return whether a usage upload receiver is configured. |
| `send_copilot_shared_usage()` | Upload the local shared-usage file to the configured receiver. |

### Rendering and figures

| Method | Description |
|--------|-------------|
| `figure(region=None, *, chrom=None, start=None, end=None, session=None, load_session=False, format='png', …, meta_locus=None)` | Render a figure of the browser's view (Export button equivalent); `meta_locus` draws a pool aligned on its anchor. |
| `render_view(region=None, **kwargs)` | `figure()` as a PIL image (PNG), e.g. |
| `save_view(filepath, region=None, **kwargs)` | Save `figure()` to a file; the format follows the extension (`.png`, `.svg`, `.pdf`). |
| `render(chrom=None, start=None, end=None, dataset_id=None, dataset_ids=None, tracks=None, width=None, …, **kwargs)` | Render the browser's view of a region as a PIL Image, headlessly. |
| `save_figure(filepath, **render_kwargs)` | Render the browser's view headlessly (see `render()`) and save it. |
| `recluster_session(session, *, method='kmeans', k=5, seed=…, features=None, …, meta_locus=None, features_relative=None, anchor_window=None)` | Re-cluster a saved session's panels reproducibly (balanced joint fit) and return the updated session and assignments; `meta_locus` re-clusters a pool's working set (session may be None). |
| `write_cluster_tsv(results, path)` | Write `recluster_session()` assignments and per-cluster counts as TSV. |

### Aliases

These names call the method shown, or wrap the same endpoint with the frontend's name.

| Alias | Description |
|-------|-------------|
| `save_cluster_assignments_tsv` | Alias for `save_clusters_tsv`. |
| `set_read_filter` | Explicit alias for `filter_reads` used by notebook workflows. |
| `clear_read_filter` | Explicit alias for `clear_filter`. |
| `plan_copilot_command` | Alias for `plan_natural_language_command`. |
| `stream_copilot_command` | Alias for `stream_natural_language_command`. |
| `remove_footprint_color` | Alias for `remove_footprint_colors`. |
| `get_browser_order` | Alias for `get_browser_read_order`. |
| `sync_browser_settings` | Alias for `sync_jupyter_browser_settings`. |
| `set_colormap` | Backward-compatible alias for `set_labeling_preset`. |
| `load_colormap_json` | Backward-compatible alias for `load_labeling_json`. |
| `save_colormap_json` | Backward-compatible alias for `save_labeling_json`. |
| `reload_peak_rules_json` | Alias for `load_peak_rules_json`. |
| `import_peak_rules_json` | Alias for `load_peak_rules_json`. |
| `mark_circular_chrom` | Convenience wrapper for set_circular_chrom(chrom, True). |
| `mark_linear_chrom` | Convenience wrapper for set_circular_chrom(chrom, False). |
| `cluster_reads` | Alias matching the frontend `clusterReads` helper. |
| `fetch_pol2_com` | Alias matching the frontend `fetchPol2COM` helper. |
| `fetch_cluster_vplot` | Alias matching the frontend `fetchClusterVPlot` helper. |
| `fetch_cluster_v_plot` | Acronym-preserving alias for `fetch_cluster_vplot`. |
| `fetch_cluster_projection` | Alias matching the frontend `fetchClusterProjection` helper. |
| `fetch_read_stats` | Alias matching the frontend `fetchReadStats` helper. |
| `get_annotations_for_region` | Alias matching the frontend API name for per-read annotations. |
| `import_peak_bed` | Alias for `import_peaks_bed`. |
| `reload_peaks_bed` | Alias for `import_peaks_bed`. |
| `reload_footprint_rules` | Alias for `load_footprint_rules`. |
| `import_footprint_rules` | Alias for `load_footprint_rules`. |
| `save_fiberlayer_rules` | Alias for portable rule JSON; prefer over materialized layer bundles. |
| `load_fiberlayer_rules` | Alias for portable saved-footprint rule JSON loading. |
| `reload_fiberlayer_rules` | Alias for portable saved-footprint rule JSON loading. |
| `get_annotation_files` | Alias matching the frontend API name for loaded annotation files. |
| `add_annotation_file` | Alias matching the frontend API name for adding annotation files. |
| `activate_annotation_file` | Alias matching the frontend API name for activating annotations. |
| `get_chromosomes` | Frontend-name wrapper returning the full `/api/chroms` response. |
| `get_big_bed_names` | Acronym-preserving alias for `get_bigbed_names`. |
| `add_motif_sequence_track` | Alias matching the frontend `addMotifSequenceTrack` helper. |
| `add_motif_file_tracks` | Alias matching the frontend `addMotifFileTracks` helper. |
| `update_track_filter` | Alias matching the frontend `updateTrackFilter` helper. |
| `cluster_expand` | Alias matching the frontend `clusterExpand` helper. |
| `deactivate_annotation_file` | Alias matching the frontend API name for deactivating annotations. |
| `remove_annotation_file` | Alias matching the frontend API name for removing annotations. |
| `browse_annotation_files` | Alias matching the frontend API name for browsing annotation files. |
| `list_linked_sessions` | Alias for `get_linked_sessions`. |
| `design4c_primers` | Alias matching the frontend `design4cPrimers` helper. |
| `unmerge_dataset` | Alias matching the frontend API name for unmerging one dataset. |
| `get_chip_atlas_status` | Acronym-preserving alias for `get_chipatlas_status`. |
| `get_chip_atlas_facets` | Acronym-preserving alias for `get_chipatlas_facets`. |
| `search_chip_atlas` | Acronym-preserving alias for `search_chipatlas`. |
| `set_coaccessibility_settings` | Alias for `set_coacc_settings`. |
| `get_coacc_matrix_image` | Alias for `get_coacc_matrix_png`. |
| `get_coacc_strip_image` | Alias for `get_coacc_strip_png`. |
| `save_primers_order` | Alias for `save_primer_order`. |
