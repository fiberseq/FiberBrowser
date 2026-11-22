# Changelog

## 3.1.1 — 2026-11-22

FiberBrowser 3.1.1 requires **FiberHMM 3.2.2 or later**
(`fiberhmm[consensus]>=3.2.2,<4`; 3.1.0 needed 3.2.0). FiberHMM 3.2.2's scans
read MA groups first, as FiberBrowser 3.1.1's read rows do, so scans and the
read panel agree. The apps bundle FiberHMM 3.2.2, and pip installs pull it.

- **Quantify a window.** Drag a window on a cluster profile or on the
  metaprofile track (or type its bounds), then click **Quantify**. The card
  gives one value per measure and group with a 95% interval: read layers,
  footprint size bands, footprint families from Find classes, NFR families,
  nucleosome geometries and the regularity score. Groups can be clusters,
  datasets, both, or meta-locus pools. A layer's value is the mean of the curve
  beside it over the window, from the same reads. Shares of reads use Wilson
  intervals, and everything else a seeded bootstrap over reads. Values can be
  shown as enrichment over a baseline or against a reference group. Click a
  bar to show its reads. **Keep** sends the card to the Plots Gallery.
- **Relative x-axis.** Cluster profiles, the metaprofile track and Plots
  metaprofiles can be labelled by distance from a gene's start or end, the
  view centre, a position or a meta-locus site. Upstream is negative on either
  strand, and **Flip to gene direction** turns the reads and plots together.
  Exports keep the axis.
- **Several sources in one Plots metaprofile.** A metaprofile can draw layers,
  MA-tag groups, single footprint classes and NFR families together, one line
  per source in its layer colour. Summary across groups draws one bar per
  source for each group, and Compare runs per source.
- **Summary bars equal their curves.** A new metaprofile summary is the
  mean of the drawn curve over the window, smoothing and blank bins
  included. **Value → pooled** gives 3.1.0's summed signal over summed
  coverage, and summaries saved with 3.1.0 keep it.
- **Footprint size plots live in Plots only.** The Clusters panel's
  **Footprint sizes** tab and the toolbar's size buttons are gone. One action,
  **Footprint sizes → Plots**, opens Size enrichment per cluster at the
  clustered locus, or per dataset without clusters. The read menu's
  **Footprint size enrichment here** plots the panel it was opened from. In
  Plots, size enrichment and V-plots take any size range, and Compare can
  compare the two plots' enrichment (A vs B) instead of their size shares. Older links and
  tour steps that ask for the retired tab open Overview, and older sessions
  load as before.
- **Scripted figures.** `figure()` and the new `fiberbrowser render` command
  take a seed, spanning reads and read caps, can hide the SV strip, re-cluster
  a session reproducibly (with a TSV of the clusters), overlay BED intervals
  with opening-width classes and statistics, and set the page size, minimum
  font size, DPI and TrueType text. Paths in a session can be remapped, and
  each render writes a receipt of its inputs. A session renders as before
  unless you ask for these.
- **The Python API follows 3.1.** `BrowserClient` and the notebook link cover
  the read policy (Min footprints and uncalled reads, duplicates, QC-fail),
  layer colours, Quantify a window, Plots (open and keep a plot), the
  meta-locus, Find sequence, recent and pinned genomes, and runs. A figure of
  the current view follows every setting it draws, and a figure with no tab
  open follows the notebook's settings.
- **Pooled loci from a script.** `figure(meta_locus=...)` and
  `fiberbrowser render --bed --anchor --flank --seed --count` draw a
  meta-locus pool with no browser tab, from a BED, an existing pool or a
  session saved on a pooled view. A pool can be re-clustered, and
  `quantify_window` (`fiberbrowser quantify` on the command line) and
  `get_meta_locus_profile` give the browser's numbers for the same pool,
  seed and count. The open tab's view of a pool is never changed.
- **Reads written with MA tags only.** FiberHMM 3.2 can write its calls as
  MA/AQ alone, without the older ns/nl and as/al tags. Read rows, the
  dense and DAF-C read paths, Min footprints, read statistics, run summaries
  and the FIRE check now read the MA nucleosome and accessibility calls
  first, so such files draw exactly as files with both. Before, each of their
  reads drew as one blank row. When a record carries both, MA wins; the
  older tags are read only for calls MA does not carry, or on a file that
  fibertools FIRE (0.12 or older) rewrote after FiberHMM.
- **Missing genes are one click away.** When the reference has no gene
  annotation, the Genes track says so, for example "No genes loaded for dm6 ·
  Load dm6 genes", and one click loads it. Your own FASTA gets "Load a GTF…".
- **Nothing is left out silently.** Live-lifted datasets aren't plotted or
  quantified yet. Plots and the Quantify card now name the ones they leave
  out, and the headless numbers list them too.
- **The Mac app's internet features work again.** The Mac apps 3.0.0 to
  3.1.0 looked for HTTPS certificates in a folder that exists only on the
  computer that built them, so on other Macs most internet features failed
  with a certificate error: the app and FiberHMM update checks, genome and
  annotation downloads, remote https:// BAMs, UCSC tracks, ENCODE search,
  track hubs and share links, and Dfam TE downloads. 3.1.1 uses the
  certificate file it ships with. Earlier Mac apps can't offer 3.1.1
  themselves: download it from the releases page.
- **Nucleosome recall: Topology.** The run wizard's advanced options offer
  "Nucleosome recall: Conservative (default) / Topology" for Hia5 and DddB.
  Topology keeps fragment structure in nucleosome recall and works well on
  some Nanopore Hia5 data. A re-call replays it.
- **Window quantification is easier to use.** A small click no longer starts a
  window, "Select window" is a mode, the gene picker matches chromosome
  aliases, and the axis ticks are round numbers.
- **Clearer messages in the Mac app.** The browser-render engine
  (`/api/render/figure`) says to use the headless engine or Export, and
  lifting scan hits onto a live-lifted dataset says it needs liftbed, which
  the app does not include yet. JASPAR names load without httpx.
- **Fixes.** On FastAPI 0.142 the live-lift guard let lifted datasets through
  to routes of included routers; it checks every route again. A graph helper
  killed with an unread reply is reaped at once on Python 3.11 and later (it
  waited 5 s). The remote helper refuses a path the system would not open for
  too many links, on every Python.

## 3.1.0 — 2026-11-20

FiberBrowser 3.1.0 requires **FiberHMM 3.2.0 or later**
(`fiberhmm[consensus]>=3.2.0,<4`): scans, the feature hub, the Nucleosomes
panel and graph mode / live lift use FiberHMM's `scan`, `nuc`, `assoc` and lift
modules, which are new in 3.2.0. The apps bundle FiberHMM 3.2.0, and their
FiberHMM updater refuses older releases. Meta-locus, live lift and graph mode
ship as **Preview** features.

3.1.0 is the next release after 3.0.8 and includes every fix released in
3.0.2–3.0.8 (their entries are kept below). The sections here list what is new
since 3.0.1. See [What's new](docs/whats-new.md) for an illustrated
introduction and [the docs index](docs/index.md) for the workflows.

### Decided before release

- **New runs pass their MAPQ.** The New run wizard has a Minimum MAPQ setting
  (0 by default) and always passes it to FiberHMM as `--min-mapq`, so a
  different FiberHMM default can't change a run silently. The run plan and the
  job card show it ("MAPQ 0"), as a Library re-call shows its recorded MAPQ.
- **One Preview badge per panel.** A lifted panel outside graph mode shows the
  badge on its live-lift chip only, not again on its Linear ⇄ Graph toggle. The
  toggle keeps its badge where it is the panel's only preview marker.
- **Read Stats leaves out reads that fail Min footprints** on BAM datasets, as
  the read track does: they are not listed or counted in the distributions, and the summary
  counts them as hidden, with the reason. Uncalled reads follow "All reads,
  including uncalled" as before. Hidden reads are no longer reported as "not
  found in this view".
- **No named nucleosome classes.** Named classes (small, hexasome, octasome,
  chromatosome) need an absolute control, so they are gone from colour rules,
  hovers and the Nucleosome footprints export (which keeps its other columns).
  Size classes, z and posterior stay. A FiberHMM 3.1 BAM that still carries the
  named byte is read without it. A saved session, preset or labeling file whose
  rules use named classes loads with those conditions dropped (the rest of each
  rule stays) and says how many were dropped.
- **Layer colours you choose.** Labels → Layer colours (or right-click a layer
  toggle → Change colour…) sets the colour of any layer, built-in or an extra
  MA-tag group. The read track, metaprofiles, cluster views, Plots, graph mode,
  the insertion lens and exported figures all use it, and the built-in
  Nucleosome, Accessibility and Subnucleosome rules follow it while they keep
  their stock colours. The colours are saved with the session; "Save as my
  default colours" keeps them for every session, and a session's own colours
  win. A colour very close to another layer's gets a soft warning, also under
  simulated colour-vision deficiency.
- **Plots: Compare in the main row.** Compare sits next to Group by instead
  of under More options, and is disabled, with the reason, when the plot has
  fewer than two groups. With Compare on, "Summary of the comparison" gives one
  value per comparison for metaprofiles and size histograms (A − B or
  log2(A/B) of the two sides' summaries, with a paired bootstrap interval); for
  size enrichment and V-plots the summary is off while comparing and says so.
- **Cluster metaprofile legends are complete.** Every card lists every channel
  on show, and a cluster without a layer shows it hollow ("no … in this
  cluster"), so the cards' plot areas line up.
- **Recent and pinned genomes.** Reference & Tracks lists the genomes you
  loaded (a local FASTA with its annotation, or an online genome), most recent
  first, with pinned ones above them. One click reopens a genome with its
  annotation; a missing file is shown greyed out. When the loaded reference
  does not fit the data, the mismatch banner offers the pinned or recent genome
  that fits it ("Switch to dm6 (matches your data)"), and one click switches;
  nothing switches on its own. On a lab server the list is per
  member and only holds paths inside the member's folders; public servers
  don't have it.

### Fixed before release

A release audit of 3.1.0 fixed these, each with a regression test:

- **Reference at start-up:** a server started with `--fasta` keeps that
  reference; neither a remembered FASTA nor a crash-recovery restore loads
  another genome over it, and the page says in one line when a saved reference
  was not restored. Without `--fasta`, the data's genome wins over a remembered
  FASTA of another assembly. Loading the genome whose sequence is already open
  now loads its missing annotation instead of doing nothing, and an annotation
  from another genome can be reset to the reference's genes (Reference &
  Tracks, or the new "Gene annotation mismatch" banner). Genes are no longer
  served from a 5-minute browser cache after the annotation changes. Opening
  the desktop app with a file no longer reopens the last session over it.
- **Full-UI export:** a read load that fails while the capture is being drawn
  is reported in the Export dialog ("Could not load reads … export again"); the
  image of the placeholders is no longer saved.
- **MA tags are read as FiberHMM 3.2.0 reads them.** A tag FiberHMM rejects
  (a section head without a strand character, `nuc:…` rather than `nuc.:…`, a
  read length that is not a number, or an interval that is not `start-length`)
  carries no calls and draws no layers, and the read counts as uncalled. Beside
  such an `MA`, a valid fibertools `Ma` is used.
- **Plots:** scale-regions profiles no longer hang on fractional bin widths;
  BED Compare uses raw counts; size histograms bin each footprint by its whole
  size, and a footprint cut by the window or the fetch is not counted as having
  its midpoint inside; methylation densities are per bp,
  and Count stays raw marks; Random N applies to selected-feature heatmaps;
  windows near a contig start keep all their bins.
- **Metaprofiles** count a read once per bin per channel, with coverage across
  every call it carries, on the server, in projections of loaded reads, in
  exported figures and in Plots alike (as 3.0.8 does).
- **Meta-locus:** Read Stats resolves meta-locus reads, including sites near a
  contig start; signal filters reach the cached and parallel decodes; sites
  near a contig start sit at the anchor; restoring a session keeps exactly its
  saved reads and seed 0; a missing BED on restore says so and returns to the
  last real locus; Cancel always ends the build; uploaded BEDs reopen on lab
  servers; crash recovery reopens the pool.
- **Sequence search:** every paired reference is searched, each with its own
  BLAST database; long minus-strand BLAST hits show their 5' bases; hits from
  another genome can't be opened or added; Cancel before the search starts
  cancels it; long repetitive scans stop on Cancel; pasted multi-line or FASTA
  sequence is recognised; hits tracks save and load on lab servers.
- **Lab servers:** meta-locus pools, sequence searches and Identify jobs are
  private to each member and workspace; the BED readers open the path the
  confinement check approved; the legacy hub route is local-only.
- **Downloads and updates:** an HTTPS download never follows a redirect to a
  non-HTTPS scheme, and every redirect hop of a FiberHMM update must be HTTPS.
- **Sessions and recovery:** crash recovery keeps Plots (Gallery and builder),
  native molecule provenance and the meta-locus; a session's meta-locus BED is
  checked and can be relinked.
- **Graph mode and Differences** follow the signal filters, the quality
  filters and the workspace read settings, and cache by them.
- **Read paths:** Regions, window fitting and the top-window search follow the
  duplicate and QC-fail toggles and the signal filters; lifted Read Stats
  applies the options it reports; Read Stats counts MA-only calls after the
  quality filters; a large annotation download asks first and then finishes,
  also on the public route and in copies of the reference.
- **Nucleosomes and hub:** regularity and geometry results follow the open
  scans; opening a session cancels nucleosome jobs; hub results are adopted
  however the job reports completion; a FiberHMM without `fiberhmm.scan` gets
  a clear "needs FiberHMM 3.2.0" message.

### Plots workspace

- **Plots** is a full-window workspace beside the browser: **Plots** at the top
  of the icon strip on the right edge, or **P**, opens it; **P**, **Esc** or
  **Back to browser** goes back. ⌘K has **Open Plots** and **New plot from
  current view**. The reads keep their scroll, filters and clusters underneath.
- Each plot is a Type × Source × Where × Group by, with an optional Compare.
  Types: **Metaprofile** (with size bands and a split by state at the anchor),
  **Size enrichment**, **V-plot**, **Size histogram**, **Heatmap** (one row per
  region) and **Co-accessibility**. Where: the current view, selected
  features, BED region sets, or random reads from the whole file (size
  histogram). Group by none, dataset, cluster, selected classes or read
  groups. Compare: A − B or log2 ratio. **Summary across groups** reduces each
  group to one number with a seeded bootstrap or Wilson interval. Every
  random step uses the plot's seed. See [Plots](docs/workflows/plots.md).
- **Follow** plots recompute 300 ms (a setting) after the view stops moving and
  say **Updating…** meanwhile, with the old numbers greyed and blanked;
  **Pin** keeps a locus. Every plot says the locus it was computed for.
- Plots inside Plots: the locus with back / forward, pan and zoom, ← / → keys,
  and a mini read strip (drag to pan, click to jump). Clicking a plot cell
  moves the shared locus there.
- Name and save plots with the session, duplicate them, and export the whole
  plot as PNG, SVG, PDF or TSV.
- **Plot these clusters** in the Clusters panel and **Open in Plots** in
  Footprint sizes, the cluster profiles, peak rules, Read Stats and the
  Footprints panel open the matching plot.
- **Previous saved region** is now **Shift+N** (P opens Plots); **N** still
  steps to the next region.

### Co-accessibility moved into Plots (3.1.0)

- The **Co-accessibility panel** is now the **Co-accessibility** plot type in
  Plots, with everything the panel had: signal and layer, normalisation (raw,
  O/E, O/E by distance, correlation), linear / log / sqrt scaling, the panel's
  colormaps (fall, hot, red, blues) beside the others, bin size, minimum reads,
  per dataset or pooled, the reads of the targeted panels with their cluster
  focus and read filters, the genes along the edge and the panel's orientation,
  the run summary (reads, bins, coverage, masked share, seed), Refresh, and
  **JSON**, **TSV** and **Python** exports. The track under the reads (heatmap
  strip, arcs, virtual 4C) is set from the plot. Matrices stay square.
- Every old entry point opens Plots on a co-accessibility plot of the view:
  ⌘K **Co-accessibility**, the track menu, Footprints › Co-occupancy, Export
  data, links, scripts and `open_panel('co-accessibility')`. A session saved
  with the panel open restores the plot in Plots. `/api/coacc/*` is unchanged.

### Plots heatmap: one row per region

- **Heatmap** is the standard per-region heatmap: one row per region (the
  selected features, or BED regions read in chunks with progress, seeding and
  minus-strand flipping), its signal across the window (anchor ± flank, or
  scaled regions), with the metaprofile drawn on top on the same x axis.
  Compare shows the groups in the profile and the per-region A − B or log2 in
  the heatmap.
- Sort rows by the mean signal in a window (the whole window by default), the
  signal at the centre, **k-means clusters** of the rows (seeded; row blocks
  with a profile per cluster), BED order, or a BED column (score). **Save
  cluster as BED set** turns clusters into BED region sets that other plots
  take as groups. The header says what it measures, e.g. "Accessibility per
  region, 1,000 BED regions ±1 kb, sorted by mean; seed 1".
- The reads × position mode over the view is retired (it redrew the read
  track). Old cards and sessions in that mode open as stored, with a note.

### Plots: steps run from where they are needed

- An empty plot that needs a step offers a button that runs it, behind Plots,
  and the plot picks up the result: **Scan peaks**, **Scan and select peaks**,
  **Find classes** (in this view), **Find geometries** (the Nucleosomes
  analysis), **Cluster reads**. Read groups need a choice and open Footprints
  › Classes, and say so.

### Plots Gallery: keep what you want

- Plots no longer adds a Gallery card for every change. Each open plot has one
  **Current** card, updated in place as you change it or pan. **Keep** (Save
  this plot to the Gallery) freezes a copy with its data, browser state and
  seed; **Duplicate** and choosing a card for **Compare** keep too. Open a kept
  card, change it and **Keep** again for a version under it (**Replace
  original** stays). Closing a plot drops its Current card, with **Undo**.
- Sessions from before keep their starred cards; the other auto-saved cards
  load into a collapsed **Older auto-saved** group with **Clear all**.

### Meta-locus (preview)

- **Open BED as meta-locus…** (Open ▾, ⌘K) pools a BED file's sites (e.g.
  every promoter, TSS ± 10 kb) into one virtual locus with a seeded working set
  of reads: browse, cluster and plot it like any locus. **More reads**,
  **Resample** and the seed set what is on show; **Keep workspace full** refills
  clusters from the pool; **Open this site** and **Find more like this** on a
  read. Sessions and links keep the pool. A Preview feature (on by default;
  **Show preview features** hides it): views that need one real genome position
  are left out on the meta contig, and a read in several sites counts once per
  site. See
  [What 3.1 includes](docs/release-scope.md#meta-locus).

### Feature hub workspace hidden for now

- The full-window Feature hub workspace is behind **Settings › Read Display ›
  Experimental: Feature hub workspace** (off by default) while it is reworked.
  The docked Feature hub panel works as before. The **Differential features**
  plot type waits for it too: hidden with the flag off (a session or card that
  has one shows its stored result, read-only).

### Y scales, read filters and fixes (3.1.0)

- **Own or shared y for sets of small plots.** Cluster Overview cards and
  Profiles, the Hub overlay facets, pooled and member peak profiles, and
  Footprints › Sizes (several selected footprints) take one control: **Own y**
  (default) or **Shared y**, and where it applies **Enrichment** against a
  baseline (all reads in the region, own flank mean or dataset mean) as %,
  ratio or log2. Own-y cards show their max.
- **Metaprofiles stay within 0–1.** A read counts once per bin per layer, rule
  or FIRE, however many of its calls meet in the bin, and its coverage spans
  every call it adds. Cluster profiles could reach 1.33 before. The read track,
  cluster profiles and Plots share one binning.
- **Read Stats applies the read track's filters**: colour-rule quality
  filters, minimum footprint quality and the duplicate and QC-fail toggles. The
  summary says what each filter hid or removed.
- **Reads without footprint calls are hidden on every path** that reads BAM
  records itself (read images, Variants, SV splits, the insertion lens, DAF-C,
  graph mode, Differences, autozoom, random windows), and Plots' random reads.
  The dense loader, DAF-C, autozoom and lift difference reads also follow the
  duplicate and QC-fail toggles.
- **Signal read filters (bg/me) show only for datasets that carry signal
  tags.** A saved signal filter stays in the session and takes effect when a
  tagged dataset loads.
- **Downloads have no size cap and ask first above a warning size** (Settings
  › App, 4 GB by default). HTTPS downloads never follow a redirect to HTTP, and
  a genome download cancelled while indexing never opens the next mirror.
- Peak-scan smoothing gives identical results on x86 and Apple Silicon (float64
  sums; pairs with FiberHMM's matching change).
- Release builds check that the bundled frontend is rebuilt from the current
  sources.

### Fixed (also released in 3.0.4)

- **The FIRE filter applies only to FIRE scores.** FiberHMM's own MSP score
  (`fiberhmm-apply --scores`, written as `aq`) is no longer hidden by the
  default FIRE filter. fibertools 0.13 FIRE files are filtered like older
  ones. FiberBrowser decides per file, from the reads first and the `@PG`
  header only when the reads can't tell.
- **Primer design works on a loaded plasmid map** (SnapGene .dna, GenBank or
  EMBL), with or without a genome open. Primers are checked against the BLAST
  database you choose, where any hit counts as off-target, and against the
  plasmid itself for a single binding site. 3C designs with one locus on the
  genome and one on a plasmid use a database per locus (3.0.4 refuses them).
- **Building a primer BLAST database works in more places:** for a genome
  opened from the online genome picker, and for paths that contain a space.
  When it cannot build, the message says what to do.

### Added (also released in 3.0.4)

- **FIRE on/off and threshold in the toolbar.** The Quality group has a FIRE
  switch, an `aq` slider with its FDR, presets for FDR 5, 10 and 20%, and an
  on/off box for each other filter. Turning FIRE off keeps the threshold.
- **The accessibility layer is called FIRE** in files with FIRE scores, and
  Accessibility otherwise (layer toggles, menus, hover, Footprint sizes).

### Added (also released in 3.0.2)

- **QC-fail reads are hidden by default, like duplicates.** Reads with the SAM
  QC-fail flag (`0x200`) are left out of the read panels and analyses,
  including the DAF strand-swap chimeras FiberHMM 3.0.3+ flags
  (`xc:Z:strand_swap`). **Quality → Show QC-fail reads (incl. FiberHMM
  chimeras)** (toolbar Quality group, and Reads & Display → Read Filters)
  shows them again, with an amber body and a QC or chimera label in the hover
  and Read Stats. The panel header counts hidden QC-fail reads, chimeras
  separately. Sessions save the switch; older sessions open with it off.
  Requires `fiberhmm>=3.0.3`. Nucleosomes, the feature hub (overlays,
  associations), scans and Differences follow the same toggle. Turning QC-fail
  or duplicate reads on or off resets an SV split's groups, so an exported
  cluster-assignment TSV lists only the reads shown.
- **FiberHMM updates between app releases.** Settings > FiberHMM & Updates
  offers **Update FiberHMM to X.Y.Z** when PyPI has a newer FiberHMM 3 than
  the app bundles. FiberBrowser checks the wheel's SHA-256, requirements and
  features, installs it outside the signed app and restarts with your session.
  Running jobs keep the FiberHMM they started with; **Use bundled FiberHMM**
  goes back, and a damaged update falls back to the bundled one at startup.
- **Install and restart fixes:** the macOS install helper's quoting (it
  stopped before replacing the app), relaunch rollback, Windows rollback of the
  app environment; the Mac updater requires FiberBrowser's Team ID. The Mac
  app's loky workers and `fiberhmm-*` commands find the backend again. Library
  re-calls carry the chimera mode once; app and WSL builds drop build paths
  from their package metadata.

### Footprint size enrichment plots

- **Clusters › Charts › V-Plot** is now **Footprint sizes**, with two views
  you switch between in one click. **Size enrichment** is the default: each
  footprint fills the positions it covers, and each size row is divided by its
  mean across the window, coloured by log2 enrichment centred on 0 (1x). **V-plot**
  counts each footprint at its midpoint.
- No clustering needed: without clusters there is one plot per dataset from
  all reads in view, side by side on one scale. With clusters there is one plot
  per cluster, or per dataset.
- Ways in: **Footprint size enrichment here** on the read menu, **Sizes**
  beside **Cluster** in the toolbar, ⌘K (*size enrichment*, *footprint
  sizes*, *V-plot*) and the empty Clusters panel.
- The source is chosen from the layers the Layers toolbar lists, with its
  names and colours (Nuc, TF, Accessibility, footprint classes and other
  interval layers), plus **All footprints**, the default: the Nuc and TF
  layers together, each footprint once. Before, the plot drew the calls
  alone, which in FiberHMM output are only the nucleosome-sized footprints.
- Gaussian smoothing has its own sigma for size and for position, in bp
  (0 = off). Older sessions' single smoothing value, in bins, maps onto it.
- Normalise per size row, per position, by observed / expected, or show
  counts. A minimum-footprints guard leaves rows or positions blank.
- A log2 ratio of two plots, a note when plots rest on very different read
  counts, PNG / SVG / PDF per plot, and **Export TSV** with the settings in
  the header. The settings are saved with the session.
- Colormaps: comparisons (the log2 ratio of two plots) default to the
  diverging RdBu, centred on 0 (blue lower, red higher, white equal); single
  plots to a sequential map, magma for Size enrichment (log2 or linear) and
  viridis, as V-plots have always used, for the V-plot. **Colormap** and
  **Reverse** under More settings (and beside the ratio picker) choose Magma,
  Viridis, Inferno, Plasma, Cividis, Greys or RdBu; Size enrichment, V-plot
  and the ratio each keep their own pick. A diverging colormap keeps 0 at its
  white middle. The colour bar and the PNG, SVG and PDF downloads follow it;
  it is saved with the session.
- `/api/cluster/vplot` gains `group_by`, `dataset_ids`, `normalization`, `layer: all_footprints`,
  `sigma_size_bp`, `sigma_pos_bp` and `raw_values`; requests without them are
  answered as before. The Python client gains
  `get_footprint_size_enrichment()`.

### Live lift and linked source views

- **Open ▾ → Add live lift…** draws a BAM aligned to another assembly on this
  genome, without realigning. It accepts graphlift maps and UCSC chains.
  **View on another assembly (live lift)…** starts from a BAM panel and
  suggests matching maps. A source assembly FASTA is optional.
- **Open as** offers **Graph**, **One panel per haplotype** and **Pooled**.
  Graph is the default when a registered package binds the dataset. Otherwise
  haplotypes open as separate panels. Reads keep their filters, selections,
  clusters and source alignment information.
- **Open MAT source view** (or another haplotype) opens the same molecules on
  their own assembly. A ribbon shows corresponding sequence; hover and
  navigation follow both views, including reversed matches. Links are saved
  with sessions.
- Coverage hatching marks sequence a haplotype lacks. Insertion ticks are
  optional: **Off**, **Ticks** or **Ticks with size**. Supplementaries can
  have their own rows, fold onto the primary row or be hidden. Separate
  settings control how records enter analyses.
- Native and lifted panels can share clustering. **BAM subset** exports the
  source-assembly records with their tags. Unsupported analyses explain which
  input to use. Live lift is enabled locally by default; lab servers must
  enable it, and public servers do not offer it.

### Differences and structural variants

- The **Differences** row replaces the SV row. Lifted panels show assembly
  differences by haplotype and optional read-supported edits. Native panels
  show structural variants in their reads. Arrows jump between differences.
- Click an insertion to expand its sequence across panels. Matching haplotype
  insertions share a column; shorter alleles keep their own length. Native
  reads can join with **Associate native layout**. This matches position and
  length and does not establish allele identity.
- Cmd/Ctrl-click or **Inspect…** opens the inspector. It shows assembly and
  read evidence, carriers, reference molecules and uninformative records.
  With a matching source FASTA, it can compare consensus and assembly,
  confirm an insertion and copy its sequence. **Identify** reports candidate
  sequence matches and their evidence. The insertion lens provides a separate
  view of an insertion's reads.
- Carrier evidence distinguishes confirmed, putative, conflicting and ambiguous
  support. Highlights, filtering, grouping and splits follow that evidence.
  Saved SV splits and expanded insertions from 3.0.x still restore.
- Read-difference analysis, SNP scans, conflicting clips and consensus no longer
  apply MAPQ 20 by default. **Read analysis MAPQ ≥**, **MapQ ≥** and
  **Min elsewhere MAPQ** still let you set a minimum.
- Reconstruction jobs respect memory budgets and cancellation. Failed
  insert-expanded builds offer **Retry**. Inspector comparisons remain stable
  while browsing, and pooled-panel Identify uses the selected carrier.

### Graph mode

- View a dataset on graph lanes, one per haplotype or assembly, with a read
  band per panel. Switch with **Linear ⇄ Graph** or **View as graph**. Native
  BAMs can also open as graphs when a package binds their contig.
- Pop out haplotypes as lifted panels, source views or both. **Pop out paths…**
  chooses several at once. Fold them back, or add other datasets to the graph.
  Selection and cluster labels follow the molecules across these views.
- **Scan** finds peaks on graph columns. **Cluster** uses shared sequence and
  can refine within carriers of inserted sequence. **Not a carrier** requires
  complete evidence; unresolved sequence is left out with a reason.
- Right-click a read for **Sort by this graph column** or **Sort by rule at
  this column**, including inserted sites. Uncovered sites sort last. Rules
  needing reference annotations are disabled there.
- **Graph run options** offers **Exclude repeat columns** or **Repeat columns
  by occurrence**, and **Refine within carriers** or **Drop carrier-only
  features**. **Graph regions and carriers…** reports the parts used.
- Layers on graph rows include scan classes and states, custom annotations,
  nucleosome size and segment layers, 5mC and deamination marks. Split pieces
  retain annotation names, molecular sizes and quality values.
- Wide or unresolved views switch to linear. The default thresholds are 50 kb
  out and 40 kb back. **Stay linear** pauses the return. **Linear view of a
  host → Host only** keeps folded members hidden; popped-out panels stay open.
  Bands show density strips and counts when not every molecule fits.
- Register packages with **Open ▾ → Register graph package…**. Dataset graph
  mode does not need preview features; the standalone **Graph view** panel
  does. The macOS app includes the helper; pip offers `fiberbrowser[graph]`.

### Feature hub and scans

- **Hub** lists classes, NFRs, nucleosome patches, peaks, SNPs, SVs, Differences
  and graph bubbles. Compare dataset and haplotype values, expand provenance,
  filter by prevalence, strength, q or declared scores, and find matched hits.
- Choose a view, BED regions, genes, anchors, a whole scan or genome scan files.
  Results are filtered and sorted before paging. Selection survives page
  changes. **Select shown** replaces it with the current page.
- **Open scan…** binds a scan by file contents. Bound scans join per-record
  states. Stale scans offer **Re-scan…**. Scans of other files remain read-only:
  browse their hits and values without applying their states to loaded reads.
- **Scan…** runs `fp`, `nfr`, `nuc` and `peaks` over view grid units, a BED file
  or genes, with progress, cancellation and a command line equivalent. View
  commands use `--genome --zones`. Matching completed units are reused.
- Live-lift scans can pool complete lifted records in the target frame. They
  refuse truncated, hard-clipped, folded or noncolinear evidence. Source-frame
  scans can still be made from the source BAM and opened here.
- Source-assembly hits lift onto this genome with their source positions and
  lift status retained. Inserted hits attach at their junction. Graph paths
  that lack the sequence say **absent**. Hits draw on carrier graph columns;
  Shift-click selects them. M4 can also lift their callable territory with a
  graphlift sidecar and `liftbed`.
- **Use as** supports anchors, cluster regions, filters, state-pattern splits,
  highlights, saved regions and conditional analysis. BED6 and value exports
  preserve coordinates, counts and provenance.
- **Associate** tests co-occurrence (M1), conditional responses (M2),
  within-molecule rates (M3), and overlap and distance (M4). Four presets fill
  the builder. Results show limits, effects, intervals, group differences,
  pairs or anchors, and exports. M2 supports dataset-specific calibration and
  held-out NFR discovery. M3 can compare state sets from compatible scans.
  M4 group contrasts are conservative and can miss differences; distance
  p-values are descriptive.
- **Overlay** aligns many loci at an anchor, edge or scaled span. Profiles,
  facets and a sampled pile show marked and measured molecules per panel or
  graph path. Missing alleles and unresolved or repeated graph positions stay
  unmeasured. Loaded MA layers and bound scan states are supported. Export TSV
  or SVG, or send patches from Nucleosomes with **Overlay…**.
- Rare peaks now use local openness of at least 8% with minimum local coverage,
  independent of the window's read count. Scan grid units count supplementary
  records. The older window peak rule remains available for BED/region scans.
- Genome-wide footprint-class scans are slow: about 154 hours on four workers
  at 30×. Use region scans for `fp`, or `nuc`, `nfr` and `peaks` genome-wide.
  Staged and oriented class workflows still use the legacy engine.

### Nucleosomes

- The **Nucleosomes** panel scores how regular each molecule's nucleosome
  array is (FiberHMM's spectral regularity score over sliding windows, against
  each dataset's random-packing reference), for every panel, strand split,
  haplotype and graph path side by side. **Analyse this view** computes the
  calls a view lacks; **Auto-Analyse** starts it on first open by default.
- **Geometries** (the default tab): a summary per series and the patch
  geometries the series share (high- and low-regularity patches called per
  molecule). Click a geometry to highlight its molecules, shift-click to use it
  in Cluster, Sort and Filter, star it to save it. **Charts**: score
  distribution, score along the region, local repeat length, score against m6A
  density, m6A autocorrelation, patch lengths. **Near a site** splits molecules
  by the state of an open region or TF site. See
  [Nucleosomes](docs/workflows/nucleosome-panel.md).
- The **Regularity** and **Patches** layers draw on the reads; **Nuc
  regularity** clusters reads on their scores.
- **Size classes** and **Array segments** draw on linear and graph reads.
  Nucleosome conditions and molecule metrics work in colour rules, Filter,
  Sort and Cluster. Read Stats adds columns; **Nucleosome footprints** exports
  per-footprint values. Sizes are coarse calls and density-matched z; there are
  no named classes (hexasome, octasome and so on), which would need an absolute
  control.

### Sessions and updates

- Sessions from 3.0.x retain frozen class and NFR runs, curation, selections,
  peak modes, branches and saved clusterings. Their hits also appear in the
  hub. Saved cart items are marked **Pinned**. Restore does not rerun analyses.
- Sessions keep hub scopes and selection, anchors, association runs and the
  last overlay result. Small browser scans are embedded up to 25 MiB total
  uncompressed; larger scans remain references. Missing scans offer reopening
  or re-scanning. Graph run options and site-sort provenance travel with panels.
- Packaged apps offer **Install and restart** for supported signed updates.
  Downloads and signatures are verified, the session is saved, and a helper
  installs after exit and reopens it. Manual download and pip updates remain
  available. See [Updates](docs/updates.md).

### Navigation and fixes

- **Find sequence in genome.** Paste DNA into the locus box (or open **Tools →
  Find sequence**) to list where it is in the loaded genome: an exact / IUPAC
  scan of both strands for short queries, BLAST with the primer designer's
  genome database for longer ones. Click a hit to go there, highlighted; add
  the hits as a track or export them as BED. See
  [Find a sequence](docs/workflows/sequence-search.md).
- **Variants and structural variants from FiberHMM's extract files** (also in
  3.0.6). A bigBed sample with `fiberhmm-extract`'s `fiberhmm_var` and
  `fiberhmm_sv` files gets the Variants panel's allele grouping, the SV tab and
  SV splits, and allele / SV marks on read rows, without the BAM; they follow
  the read track's read set. Grouping by a SNP and an SV together and SV-SNP
  linkage still need the BAM. Not offered on live-lift datasets, graph-mode
  hosts or linked source-assembly panels.
- **Reads without footprint calls are hidden by default** (also in 3.0.6).
  Min footprints never shows a read the caller skipped, at any threshold
  (0 and its automatic relax included); its last choice, **All reads,
  including uncalled**, shows them. The read track and Read Stats say which
  filter hid how many reads. Nucleosomes and the feature hub apply the same
  rule before FiberHMM's engines see the reads.
- **Read Stats: reads without footprint calls are "not called"** (also in
  3.0.6). A read the caller skipped (no `MA`/`Ma` call group with calls, no
  `ns`/`nl` or `as`/`al` list pair) shows NA / "not called" instead of
  0 footprints and 100% accessible, and is left out of the footprint and
  accessibility means; a called, fully accessible read still counts. Means are
  NA when no read in scope or in a cluster is called. Read tables gain a
  `call_status` column.
- **Read Stats counts calls carried only in `MA`/`Ma` tags** (also in 3.0.7).
  Reads from current FiberHMM or fibertools `Ma` files without `ns`/`nl`
  lists get their footprint counts, sizes and accessibility from the tag.
- **Extra layers get distinct colours** (also in 3.0.7). Layers without a
  curated colour (`tf2`, `nuc_a`, scan products) take colours from a
  twelve-colour palette over the loaded set, the same for the same layers in
  any load order, in the read track, the default metaprofile and headless
  figures. A colour you pick for a default-metaprofile source is kept,
  including in 3.0.7 sessions (`autoColor`).
- **Default metaprofile follow-ups** (also in 3.0.7). Headless figures fetch
  the profiles they draw for the followed sources; a `footprint` source keeps
  following after a `nuc` dataset loads; turning **Follow active layers** back
  on restores a layer source removed by hand and keeps extra ones; colour-rule
  sources are computed for cluster profiles while the metaprofile track is
  hidden; notebook
  `set_track_cart` resubmits keep picked colours.
- ONT reads with Dorado's scalar `ns:i` tag are no longer dropped: a scalar
  `ns` is not a footprint list, so those reads now show in every view
  (also released in 3.0.5). `ns`/`nl` and `as`/`al` count only as list pairs
  everywhere (read loader, FIRE overlay, DAF-C); string-valued tags are
  ignored. Library call counts include reads with fibertools `Ma` or
  `as`/`al` calls and no longer count uncalled Dorado reads.
- Native pans and outward zooms reuse compatible cached interiors and fetch
  newly exposed edges. Live lift and graph mode reuse decoded records. Actual
  speed depends on the window, data, cache and connection.
- **Performance mode** controls memory, workers and sampling. Low memory caps
  analysis working sets at 2,000 reads; Standard and High performance allow
  full sets, subject to a separate Analysis cap.
- Back and Forward follow typed loci, saved regions, Differences jumps and
  **Zoom to read**, including per-panel navigation. Composite split, cluster,
  merge, delete and focus actions use one undo step.
- Graph pop-outs retain labels for folded and supplementary records. Source
  views opened in succession reach their mapped locations. Reload no longer
  adds an empty panel for a source-view BAM.
- Automatic peak scans that stop at the time limit show a retry note beside
  **Scan**. Graph zoom keeps the position under the pointer.
- Fixed concurrent BAM loads that could hang, stale split and export requests,
  SV projection crashes, minus-strand insertion marks and circular DAF
  consensus. Scan layers obey quality filters on sampled and cached paths.
- FiberHMM and fibertools MA annotations display in DAF-C reads and contacts.
  Repaired lifted BAMs retain source strand and provenance. Records marked as
  source supplementaries are hidden rather than counted twice.
- **New run** accepts an aligned, indexed BAM when minimap2 is not installed.
  FiberHMM calls such a BAM in place, so the wizard shows a warning instead of
  refusing the run. FASTQ, unaligned or unindexed BAMs and several BAMs per
  sample still require minimap2.
- Legacy footprint tags on reverse reads of header-stripped files are no
  longer drawn mirrored. When a BAM's `@PG`/`@CO` lines were removed, legacy
  `ns`/`nl`/`as`/`al` tags (fibertools ≤0.12, FiberHMM) were read in the wrong
  frame on reverse reads. The frame now comes from the reads' m6A calls (few
  inside nucleosomes, many inside MSPs), once per file. A header that states
  the frame still decides. Diagnostics show `legacy_frame` and
  `legacy_frame_basis`. `MA` groups with FiberHMM ≤2.13.1 `+`/`-` strands
  still follow the header rule.

## 3.0.8 — 2026-11-20

FiberBrowser 3.0.8 bundles FiberHMM 3.0.4 and requires
`fiberhmm[consensus]>=3.0.3,<4`.

### Fixed

- **Track names in a panel's Tracks menu are readable.** In light mode the
  "Tracks in this panel" menu showed its track names white on white, so only
  the subtitles could be read. The names now use the menu's own text colour,
  in light and dark mode.
- **Library Re-call works in the Mac app again.** Since 3.0.3 the packaged
  Mac app could not plan any re-call ("can't import fiberhmm from the job's
  environment"), even with its bundled FiberHMM.
- **Library Re-call keeps the original run's MAPQ.** A re-call now always
  passes the MAPQ threshold the original run recorded, in its run record or
  in its BAM header. Before, a run made at FiberHMM's old default (MAPQ 20)
  was re-called with no MAPQ setting, so with FiberHMM 3.2 or later
  (default 0) it ran at MAPQ 0 while the plan said it kept the original
  settings. The plan now lists the MAPQ it uses.
- **Reloading the only open tab no longer stops the server.** A check that
  ran between the old page closing and the reloaded page reporting in could
  find no tab open and shut the server down, so the reloaded page showed
  "connection refused".
- **Files with only MA/Ma calls no longer report missing Fiber-seq tags.**
  Opening a BAM written by current fibertools (Ma/Aq tags) or FiberHMM (MA/AQ
  tags) warned "Missing Fiber-seq tags: ns, nl, as, al ...". Nucleosome and
  MSP or FIRE calls in an MA/Ma tag now count for those tags.
- **Derived-layer exports now write their BigBed.** `bedToBigBed` refused
  the bundle's table definition, so every derived-layer export wrote BED and
  JSON only and no BigBed was added to the dataset.
- **Metaprofile layer signal ends at the call's last base.** The server's
  metaprofile, and the one recomputed when you zoom in within loaded reads,
  counted each call one bin past its end. They now bin calls as the read
  track's own metaprofile and exported figures already did.
- **Metaprofile values are no longer over-counted where calls meet within a
  bin.** When two calls on one read met inside the same bin (for example two
  nucleosomes with a short linker), that read counted twice there, so
  metaprofiles read slightly high (up to about 5% per bin on the main track,
  and cluster nucleosome profiles could go above 1). A read now counts at most
  once per bin in each profile, and a call past the read's footprints (such
  as an MSP at the read end) also counts towards the reads covering that
  bin. This applies to the metaprofile track, cluster profiles and exported
  figures.

## 3.0.7 — 2026-11-19

FiberBrowser 3.0.7 bundles FiberHMM 3.0.4 and requires
`fiberhmm[consensus]>=3.0.3,<4`.

### Changed

- **The default metaprofile follows the layers you switch on.** Turning a read
  layer on or off in Tracks (FIRE, m6A, 5mC, deamination, extra MA layers)
  now shows or hides it in the default metaprofile straight away, for new
  datasets and restored sessions too. Cluster profiles, and the layers the
  read track loads for them, follow the default metaprofile, so clustering
  now profiles the layers you have on instead of always nucleosomes and TF.
  Showing or hiding one of its layers by hand switches that track to manual
  and keeps your choice; **Follow active layers** in its settings switches
  following back on. Sessions save the choice; older sessions open following.
  Colour-rule sources in the metaprofile work as before. The separate
  metaprofile setting older sessions carried is no longer used, and is ignored
  when they load. The notebook call `set_metaprofile_layers` now shows or
  hides the default metaprofile's sources, and switches it to manual if that
  changes anything.
- **Extra MA-tag layers get clearly different colours.** Layers without a
  built-in colour (for example `tf2`, `tf3`, `nuc_a`) used to get colours from
  their names, so similar names came out in near-identical shades. They now
  get colours from a 12-colour palette that keeps clear of the built-in layer
  colours and stays distinguishable with common colour-vision deficiencies.
  The same set of loaded layers always gets the same colours, whatever order
  the datasets load in, and older sessions' metaprofiles take them too.
  Colours you have set yourself are kept; past 12 layers the palette repeats a
  shade lighter or darker. Exported figures use the same colours.

### Fixed

- **Read Stats counts footprints carried only in MA tags.** For reads whose
  calls are only in MA tags (what current FiberHMM writes) or fibertools `Ma`
  tags, Read Stats showed called reads as 0 footprints and 100% accessible.
  It now reads their footprints, sizes and accessible fraction from the tag,
  placed as on the read track. Reads with ns/nl tags are unchanged.

## 3.0.6 — 2026-11-19

FiberBrowser 3.0.6 bundles FiberHMM 3.0.4 and requires
`fiberhmm[consensus]>=3.0.3,<4`.

### Changed

- **Reads FiberHMM didn't call are no longer shown.** A read the footprint
  caller skipped (for example under FiberHMM's `--min-read-length`) has no
  call tags. Min footprints now hides such reads at every setting, including
  0 and when it relaxes itself to 0 on sparse data, so 0 means "every called
  read". Called reads that are fully accessible still show. The hidden count
  says how many reads were hidden and why, for example "312 uncalled · 40 with
  < 5 footprints hidden". Min footprints › **All reads, including uncalled**
  brings them back; leaving it returns to the threshold you had. Sessions
  saved with 0 open as "every called read". The same rule applies to Read
  Stats, clustering, cluster charts, footprint sizes, peak scans and exports.
  With "Show QC-fail reads" on, QC-fail reads (FiberHMM chimeras) still show.

### Added

- **Variants and structural variants from FiberHMM's extract files.** When a
  sample's bigBeds include the `fiberhmm_var` and `fiberhmm_sv` files that
  `fiberhmm-extract` writes, the Variants panel groups reads by allele, the
  SV tab lists deletions and insertions and splits reads by them, and read
  rows can show each read's alleles and SV marks, all without the BAM. These
  files are written by FiberHMM 3.2.0 and later (not yet released when
  3.0.6 came out; FiberHMM 3.1.0 and earlier don't write them). They are read
  only when used, so opening a dataset costs nothing extra. They follow the
  same reads as the read track: uncalled reads and QC-fail reads are left out
  unless you choose to show them. Grouping by a SNP and an SV together, and
  SV–SNP linkage, still need the BAM.

### Fixed

- **Read Stats no longer shows uncalled reads as fully accessible.** When
  they are shown, their footprint count, footprint size and accessibility read
  NA / "not called" instead of 0 footprints and 100% accessible, and they are
  left out of the footprint and accessibility means. A mean with no called
  read behind it shows NA, not 0. The TSV export has a `call_status` column.

## 3.0.5 — 2026-11-19

FiberBrowser 3.0.5 bundles FiberHMM 3.0.4 and requires
`fiberhmm[consensus]>=3.0.3,<4`.

### Fixed

- **Nanopore reads basecalled with Dorado show again.** Dorado writes an `ns`
  tag (the read's signal sample count) on every read. FiberBrowser took it for
  footprint starts, could not read it, and left the read out of the read views
  and analyses, its FiberHMM calls included. These reads now show. `ns`/`nl` and
  `as`/`al` count as footprints or MSPs only when both tags of the pair are
  present as lists.
- **Library call counts are corrected.** Uncalled Dorado reads no longer count
  as called, and reads with fibertools `Ma` or `as`/`al` calls now do.

## 3.0.4 — 2026-11-18

FiberBrowser 3.0.4 bundles FiberHMM 3.0.4 and requires
`fiberhmm[consensus]>=3.0.3,<4`.

### Fixed

- **Primer design works on a loaded plasmid map.** Primers can be designed on
  a SnapGene .dna, GenBank or EMBL map, with or without a genome open. They
  are checked against the BLAST database you choose (for example dm6), where
  any hit counts as off-target, and against the plasmid itself for a single
  binding site (this check can be turned off). Before, design on a plasmid
  always failed. 3C designs with one locus on the genome and one on a plasmid
  are not supported yet: design those loci separately.
- **Building a primer BLAST database works in more places:** for a genome
  opened from the online genome picker, and for files in folders whose path
  contains a space. When it cannot build, the message says what to do.
- **The FIRE filter applies only to FIRE scores.** FiberHMM's own MSP score
  (`fiberhmm-apply --scores`, written as `aq`) is no longer hidden by the
  default FIRE filter, so all FiberHMM MSPs show. fibertools 0.13 FIRE files
  are now filtered like older ones: MSPs that are not FIRE elements are hidden
  by default. Supported: FIRE-only and FiberHMM→FIRE files, with or without
  their header history.
- **Reverse reads of header-stripped files are no longer drawn mirrored.**
  When a BAM's `@PG`/`@CO` lines were removed, legacy `ns`/`nl`/`as`/`al` tags
  (fibertools ≤0.12, FiberHMM) were read in the wrong frame on reverse reads.
  The frame is now read from the reads' m6A calls; a header that states it
  still decides.

### Added

- **FIRE on/off and threshold in the toolbar.** The toolbar's Quality group
  has a FIRE switch, an `aq` slider with its FDR (for example "230 (FDR
  10%)"), presets for FDR 5, 10 and 20%, and an on/off box for each other
  filter. Turning FIRE off keeps the threshold for when you turn it back on.
- **The accessibility layer is called FIRE** in files with FIRE scores, and
  Accessibility otherwise.
- **Footprint size enrichment plots** (Mol Cell 2024 style). Clusters ›
  Charts › V-Plot is now **Footprint sizes**, with **Size enrichment** (the
  default) and **V-plot** views, one plot per dataset or per cluster. Open it
  from **Footprint size enrichment here** on the read menu, **Sizes** in the
  toolbar, or ⌘K. Choose the source from the toolbar's layers or **All
  footprints** (the default). The default plot is log2 enrichment in magma;
  comparative plots (log2 ratio of two plots) use RdBu_r centred on 0, and the
  V-plot view uses viridis, as before. Colormaps can be changed and reversed.
  Plots export as PNG, SVG, PDF and TSV and are saved with the session.

### Known limitations

- Merged FIRE + FiberHMM files follow one per-file rule. Turn the FIRE
  filter off to see all MSPs.
- Header-stripped files whose `MA` tag has FiberHMM ≤2.13.1 `+`/`-`
  footprint groups still follow the header rule for those groups.

## 3.0.3 — 2026-11-11

FiberBrowser 3.0.3 bundles FiberHMM 3.0.4 and requires
`fiberhmm[consensus]>=3.0.3,<4`.

### Fixed

- **New DAF-seq run accepts Hia5 reads.** A PacBio or Nanopore BAM with MM/ML
  m6A calls (aligned or not) can now be run with Hia5 from the run wizard;
  before, Hia5 was offered only for raw Nanopore POD5. The platform is read
  from the reads, and no kinetics are needed. Library re-calls of Hia5 runs
  work too.
- **Download in the run wizard downloads the genome.** Clicking **Download**
  for a genome that was already open from a local FASTA did nothing. That
  FASTA is now used as the run's reference directly. Other downloads show
  progress and can be cancelled; a failed download lists each mirror tried
  and why it failed, with **Retry** and **Use a FASTA file instead**. The
  download no longer replaces the genome open in the browser.
- **An aligned, indexed BAM runs without minimap2.** The wizard refused every
  run when minimap2 was missing, although FiberHMM calls an aligned BAM in
  place. It now shows a warning for such a BAM and runs it. FASTQ and
  unaligned BAMs still need minimap2.
- **Library re-calls keep the chimera mode once.** With FiberHMM 3.0.4 the
  recorded settings of a re-call match the original run exactly.

## 3.0.2 — 2026-11-03

FiberBrowser 3.0.2 bundles FiberHMM 3.0.3 and requires
`fiberhmm[consensus]>=3.0.3,<4`.

### Added

- **QC-fail reads are hidden by default, like duplicates.** Reads with the SAM
  QC-fail flag (`0x200`) are left out of the read panels and analyses. This
  includes the DAF strand-swap chimeras that FiberHMM 3.0.3 now flags
  (`xc:Z:strand_swap`): reads with C-to-T deaminations in one segment and G-to-A
  in another, which earlier versions wrote unmarked so they looked like reads
  without footprints. **Quality → Show QC-fail reads (incl. FiberHMM
  chimeras)** (also under **Reads & Display → Read Filters**) shows them again,
  with an amber marker and a QC or chimera label in the hover and the Read Stats
  inspector. Hidden-read counts list chimeras separately. Sessions save the
  switch; older sessions open with it off. Re-call DAF-seq BAMs with FiberHMM
  3.0.3 to flag their chimeras.
- **Install and restart.** When an update is out, the Mac and Windows apps can
  install it in one step: FiberBrowser downloads and verifies the update, saves
  your session, quits, installs, and reopens with the session. On the Mac the
  update must be signed by FiberBrowser's Team ID and pass Gatekeeper; the old
  app goes to the Trash, and is put back if the new one fails to install or to
  start. On Windows the installer must carry FiberBrowser's Authenticode
  signature; the old application and its WSL distribution are restored if the
  new one fails. **Download** still fetches the DMG or Setup for a manual
  install. This 3.0.2 Windows build is not code-signed, so on Windows updates
  install with **Download** and Setup.
- **FiberHMM updates between app releases.** Settings > FiberHMM & Updates
  offers **Update FiberHMM to X.Y.Z** when PyPI has a newer FiberHMM 3 than the
  app bundles. FiberBrowser checks the wheel's SHA-256, its requirements and its
  features before it switches, installs it outside the signed app, and restarts
  with your session. Running jobs keep the FiberHMM they started with. **Use
  bundled FiberHMM** goes back in one click; a damaged update falls back to the
  bundled FiberHMM at startup and can be reinstalled.
- **FiberBrowser has a preprint to cite.** About, How to cite and the
  citation line on exported figures now cite Tullius et al., bioRxiv 2026,
  doi:10.64898/2026.10.29.762797.

### Fixed

- **Clicks land where the pointer is.** In the Mac app the whole page could
  scroll up under the title bar (for example after a menu opened), cutting off
  the toolbar so clicks landed above the pointer. The page no longer scrolls;
  long dialogs, such as the update notes, scroll inside the window.
- **Library rows stay put.** Selecting files or showing the bulk-action bar no
  longer shifts the rows under the pointer.
- **Re-calls keep one chimera mode.** Re-calling a Library dataset made by
  FiberHMM 3.0.3 carries its chimera mode once; each re-call used to repeat
  it in the recorded settings. The Mac app and the WSL package no longer
  contain local build paths in their package metadata.

## 3.0.1 — 2026-10-16

FiberBrowser 3.0.1 bundles FiberHMM 3.0.2 and requires
`fiberhmm[consensus]>=3.0.2,<4`.

### Fixed

- **The guided tour starts on first launch.** After declining the offer to
  restore a session (or on a first launch with no genome downloaded), the tour
  could stop at its first step with "load a BAM or BigBed with Open". The tour
  tab no longer loads a start-up genome of its own, so it no longer waits for
  the main window's genome download; it opens the demo at once, without a
  reference sequence if the demo's genome is still downloading. If the demo
  cannot be opened, the tour asks again and then says why it can't start.
- **DddA QC grades against a somatic DddA control.** FiberHMM 3.0.2 replaces
  the DddA reference that `fiberhmm-qc` compares samples with: the packaged
  one came from a sperm DAF-seq sample, so normal DddA libraries failed the
  signal-rate and periodicity grades. Re-run **Data quality** (QC) on DddA
  datasets; QC reports made with earlier versions graded DddA against the
  wrong control. Footprint calls, DddB and Hia5 grades are unchanged.

## 3.0.0 — 2026-10-15

FiberBrowser 3.0 is released together with FiberHMM 3.0, the third
generation of the FiberHMM family, and requires it:
`fiberhmm[consensus]>=3.0,<4` (installed with FiberBrowser). Browsing works
without FiberHMM; footprint classes, chemistry detection, consensus BAM
export, DAF-seq runs and re-run advisories need it.

> **Nanopore Hia5 and DddB users: re-call your BAMs.** FiberHMM 3.0 ships new
> Nanopore Hia5 and DddB models. Re-call Nanopore Hia5 and DddB BAMs made with
> FiberHMM 2.x using FiberHMM 3.0 and reload them. The **Library** marks BAMs that need it (**Needs re-run**)
> and can re-call DAF-seq runs made in FiberBrowser. See the
> [FiberHMM 3.0.0 changelog](https://github.com/fiberseq/FiberHMM/blob/main/CHANGELOG.md).

### What 3.0 includes

- **Supported**: SV display and splits, the **insertion lens** and **Identify** (with the bundled fly TE library and
  Dfam downloads), and the **Variants** panel (SNPs, local read-supported allele patterns, SVs, splits by allele or
  haplotype).
- **Preview**, on by default (**Show preview features**, Settings → Reads & Display): **insert-expanded
  (alt-allele) panels**. Each way into them has a Preview badge and a **Known limitations** note that says what
  graduates it. With previews off, a session that uses them keeps everything and offers to turn them on. The
  **Footprint classes** section of the Footprints panel carries a Preview badge but stays available with previews
  off. See [What 3.0 includes](docs/release-scope.md).
- **NFRs** and **Synchronise regions** (its own rail icon) are in every build, independent of the preview switch.
  Sessions and preferences from earlier 3.0 builds open unchanged.
- The **Variants** panel has a sequence-variant icon on the rail.
- The guided tour (58 steps) has a Variants section on a second bundled demo (H1 PacBio Fiber-seq around a
  heterozygous 7,471-bp insertion on chr1 whose insert carries a CTCF-footprinted NFR): SNPs in view, a split by
  haplotype (HP tags), the SVs tab and the insert expanded. The user guide and the tutorial cover it.

### NFR analysis

The NFR panel and its analysis modules are included in the public release.

- **NFRs panel** (fuchsia, the nucleosome-free
  icon on the rail). Runs FiberHMM's `fiberhmm-nfr` on the view: NFR variants
  (opening registers) with per-read prevalence, read groups by configuration
  or by a pair of elements (arcs and matrix; **Split** puts them into the read
  panels like any clustering, and **Clear** puts back what they replaced,
  including an SV allele split), and element co-accessibility with Find
  classes. One list of NFR cards (tabs **NFRs** and **NFR pairs**):
  **Open** expands a card in place with its read controls (group, **Split
  into panels**, split by combination pattern, select as features) and its
  analyses; a star keeps it with the session, **All / Starred** filters the
  list, and starred NFRs of other runs are under **Earlier**. A click on an
  NFR or variant in the NFR channel opens its card. In **NFR pairs** each NFR
  is one element, folded, until ▸ shows its variants; the arcs go to the NFR
  or its variants, and are drawn on the NFR channel over the reads too (no
  separate arcs row: sessions with one drop it). One fold state and one
  selection everywhere: click an element to select it, a second one or an arc
  to inspect their pair. The pairs matrix is square and mirrored, each
  element's open share on its diagonal. **Position correlation** (a mode of
  NFR pairs) shows the Co-accessibility position matrix of the view, or two
  open datasets subtracted (A − B on one position grid, each one's reads). A
  card's sequence is copied or downloaded as FASTA. The ChIP-Atlas choice per
  genome, pinned motifs and custom motifs are kept on this computer
  (`~/.fiberhmm/analysis_preferences.json`), whatever the port or app build.
  The analyses show shape,
  V-plots, phasing, prevalence per read group (clusters, SV alleles, other
  datasets) and **Motifs**, where motif sites are nested evidence (open from
  the NFR shape, footprinted given open from Find classes), scored by p-value
  with the scorer the Footprints panel now uses, with pinned key factors,
  ChIP-Atlas and conservation; motif names match by common name or alias
  whatever the spelling, and an added motif with no site says *0 sites here*.
  NFR variants and footprint classes link across
  the two panels. Outputs and settings may change without notice. See
  [Motifs at NFR variants](docs/lab/workflows/nfr-motifs.md).

### Added

- **Headers without frame evidence.** A BAM whose header has no
  FiberHMM/fibertools provenance (a pipeline stripped `@PG`) while its reads
  carry footprints whose frame depends on it gets FiberHMM 3.0.1's warning:
  on opening, as a **Frame unconfirmed** badge in the Library and in the BAM
  check. Nothing is drawn differently.

**Getting data in**

- **New DAF-seq run.** A three-step dialog runs `fiberhmm-pipeline` without
  a command line: FASTQ, BAM, a folder or a Plasmidsaurus zip (samples named
  from their barcodes); a catalog genome (with optional amplicon regions), a
  FASTA or a plasmid map; DddA or DddB, with calling options that default to
  `fiberhmm-call`'s. Runs go to a background queue (`~/.fiberhmm/jobs`) with
  per-step progress, ETA, cancel, retry, the log and the command; they
  survive a restart. A finished run opens with the right reference and shows
  its QC. See
  [A DAF-seq run, from raw reads](docs/workflows/daf-seq-quick-run.md).
- **Raw Nanopore (POD5) runs** (FiberHMM 3.0's dorado step). **New DAF-seq
  run → Raw Nanopore (POD5)** takes a MinKNOW `pod5/` folder (one sample,
  named after its run) or POD5 files; `fiberhmm-pipeline` basecalls them with
  dorado, then aligns, calls and runs QC. The defaults need no choice: `sup`
  plus the 6mA model for **Hia5 Fiber-seq** (offered for POD5 input), plain
  `sup` for DAF-seq; **Advanced** has the model, modified bases, device and
  batch size (only changes become `--dorado-*` flags). dorado is not bundled:
  the dialog shows the one found (path and version, from PATH, dorado's usual
  install folders, `FIBERHMM_DORADO` or `browser_settings.json` `tools`) or
  FiberHMM's install instructions, with **Check again**; the job is given
  `--dorado` only when the pipeline would not find that same copy. **Runs**
  shows the **Basecalling (dorado)** step (its messages, then the reads
  basecalled), says **dorado was not found** with the instructions, and
  **Resume basecalling** continues an interrupted basecall. See
  [Run everything from the app (POD5)](docs/workflows/daf-seq-quick-run.md#run-everything-from-the-app-pod5).
- **Basecaller provenance.** Every BAM in the **Library** has a
  **Basecaller** line (e.g. `dorado 2.0.1 · sup v5.2.0 · 6mA v1`; hover for
  the full model names and where each came from), from the run's
  `outputs.json` `settings.basecaller` or the header (dorado's `@PG`/`@RG`,
  FiberHMM's `@PG DS` tokens), *unknown* when neither records it. A finished
  run's card shows it too, with **Reads basecalled**. **Re-call** accepts
  FiberHMM 3.0's `basecaller` / `basecaller_override` settings, gives a
  recorded override again (`--basecaller-info` / `--modbase-model`, also
  when only a header's `@PG DS` records it), shows the basecaller in its
  review, and re-calls a POD5 run from its aligned or basecalled BAM: a
  header re-call that would basecall again is refused and asks for the
  basecalled BAM.
- **QC panel** for runs and for any loaded BAM: `fiberhmm-qc` verdicts, the
  per-read deamination CDF against the bundled reference with PASS/WARN
  bands, the phasogram and footprint sizes. With FiberHMM 3.0's state-aware
  QC it leads with **efficiency** (the rate inside MSPs) and **background**
  (the rate outside them) against the reference with their PASS/WARN ranges,
  the MSP share of reads, their ratio, where the states came from (the
  BAM's calls or a light call) and a per-read in-MSP vs outside-MSP CDF; it
  says what the overall verdict is based on and marks the overall rate as
  not in a state-aware verdict. The Library's QC column and run cards use
  the state-aware verdict. Older QC reports display as before. **Run QC** in
  the Library, and **QC a dataset** with no BAM loaded, run `fiberhmm-qc` on
  a file without opening it; the Library keeps the result with the file
  until the file changes.
- **Library.** Every BAM, BigBed and plasmid map you open, finished DAF-seq
  runs and watched folders in one per-user list (`~/.fiberhmm/library.json`,
  shared by all windows): sample, chemistry, FiberHMM version, genome or
  plasmid, read count and QC verdicts from the file headers; search, tags,
  notes and groups; open a file with its genome or map in one click; export
  a group as a `--catalog`; relocate moved files by content. BAMs that
  FiberHMM's advisories say should be called again are marked
  **Needs re-run** (or **May need re-run**), and DAF-seq runs made with
  `fiberhmm-pipeline` can be re-called with their original settings. A BAM
  with no run record is re-called from the `fiberhmm-call` (or
  `fiberhmm-pipeline`) command its header records, re-run with the same tool
  and the current FiberHMM: the review shows the original and the new
  command, every argument it changes (outputs into the new folder, cores, an
  input found on this computer or chosen with **Locate the input…**) and
  each FiberHMM 3.0 default the original predates, with a toggle to keep the
  original behaviour where an option exists. Runs recorded before FiberHMM
  3.0 called supplementary alignments, kept DAF soft clips on linear contigs
  and masked DAF inserted/soft-clipped bases get those defaults with the same
  toggles, whichever record (outputs.json, run record or header) they come
  from; `--phase-nrl` and `--nuc-recall-policy` (retired in FiberHMM 3.0:
  they caused artifacts) are left out of the re-call and listed.
  A suggested experiment's **Open** or **Save as group** scans its folder
  first (watched-folder rules, without watching it) and covers every BAM,
  BigBed and plasmid map found there, after a review. Local
  servers only. See [The Library](docs/workflows/library.md).
- **Open ▾ in the top bar.** Load File is now **Open**, a split button: the
  main part opens the file dialog as before; its arrow lists **Open from
  Library**, **Load by path / URL…**, **Connect to cluster…**, **Process raw
  data (New DAF-seq run)…** and **Data quality (QC a dataset)…**, each with
  its keys and, where it is not available here, the reason. The desktop app's
  File menu and the command palette use the same names.
- **Plasmid maps linked to BAMs by sequence.** A BAM aligned to a renamed or
  origin-rotated copy of a plasmid shows its reads on the map without
  renaming files: contigs are matched by `@SQ M5`, the reference the BAM
  names, or the reads' own bases; a mismatch says what differs.
  **Open plasmid dataset…** opens a map and its BAMs in one step, and
  **Regions** lists what is linked. `fiberhmm-pipeline`'s
  `FIBERHMM-REFERENCE` header line is read. See
  [Plasmids and circular genomes](docs/workflows/plasmids.md).
- **Circular contigs.** BAM contigs declared `TP:circular` are circular on
  load; reads stored across the origin (the SAM circular form) are drawn,
  counted and analysed as one molecule in the wrapped view.
- **Connect to cluster…** opens BAM, BigBed, FASTA and plasmid-map files
  that stay on a cluster, over your own SSH (keys, agent, `~/.ssh/config`;
  password or two-factor sign-in in your terminal). A small read-only helper
  on the cluster serves byte ranges from the folders you choose; FiberBrowser
  never sees a password. S3 buckets open through the same dialog. Sessions
  and the Library keep cluster files by reference and offer to reconnect.
  See [Data on a cluster](docs/workflows/remote-cluster-data.md).
- **S3-compatible storage for lab data.** `s3://` BAMs, BigBeds, bigWig/bigBed
  tracks and `.cool`/`.mcool` maps open from AWS S3, Cloudflare R2, Backblaze
  B2, MinIO or an institutional store. **Load Remote URL** takes an endpoint
  next to the AWS profile; a catalog's optional `"s3"` block names its
  endpoint/region/profile (never keys); `-b s3://...` works on the command
  line. Guide: [Lab data on S3](docs/workflows/s3-lab-data.md) (providers and
  rough costs, bucket layout, read-only keys, a lab catalog, troubleshooting).
- **Open data from a link.** `?session=` (a `fiberbrowser.session-link.v1`
  JSON document), `?hub=` (UCSC-style track hubs) and `fiberbrowser://open`
  links open remote BAM, bigBed, bigWig, BED and plasmid-map files at a
  locus, after the user reviews and confirms what will be opened.
  Pre-signed URLs stay in memory and are masked when shown, saved or logged.
  See [Open data from a link](docs/workflows/open-from-links.md).
- **fibertools and FIRE output.** Per-fiber FIRE bigBeds
  (`fire-fibers.bb`, `fire-fiber-decorators.bb`) open as reads with MSPs,
  FIRE quality and m6A/5mC marks; FIRE peaks and bigWigs open as tracks.
  See [fibertools and FIRE outputs](docs/workflows/fibertools-fire-data.md).
- **Sessions move between computers.** Restoring a session whose files are
  elsewhere opens **Locate session files** (locate one file, paste a path or
  search a folder); sessions record a fingerprint of each file to confirm a
  match. Drag-and-drop uploads are kept in a per-user cache
  (`~/.fiberhmm/uploads`), reused when the same file is dropped again, and
  cleaned after 30 days unused. After a reload, unsaved work can be
  restored.
- **Opening files.** Load File, drag-and-drop and Load by path open files
  the same way: an index (`.bai`, `.csi`) chosen or dropped with its BAM is
  taken as the BAM's, not opened (or refused) as a file of its own, and
  every file that can't open is named with the reason in one message
  ("2 of 5 files could not be opened: …"); a CRAM, SAM, bedGraph, VCF or
  FASTQ says how to convert it. The open dialogs of Load File and Add
  dataset offer **Supported files** (the default), each kind, and **All
  files**. In the Mac app, Load File uses the Mac's own open panel and
  dropped files open where they are instead of being uploaded.
- **Reopen last session.** After a normal quit, the next launch's welcome
  card has **Reopen last session** (its datasets and locus) as its first
  button; **On launch** in the Session settings chooses to offer it, reopen
  without asking or start fresh. After a crash, the recovery banner is as
  before, and the welcome card shows below it.
- **The Library** opens from **Open from Library** on the welcome screen and
  from a **Library** chip beside **Tracks** in the analysis strip (local
  servers; in **More** when the strip is short). **Open** shows the
  dataset's panel at once (a placeholder while it loads; a dataset already
  open but hidden is revealed), and opening a BAM samples its layers at
  index record starts, so large BAMs open quickly.

**Genomes and navigation**

- **A dataset on another assembly in its own panel.** When a BAM doesn't fit
  the main genome, the mismatch banner offers **Open with <genome> in its
  own panel** beside **Switch to <genome>**. That panel has its own
  reference (a catalog genome, a FASTA and annotation, or the BAM's own
  contigs) with its own chromosome list, locus box, genes, sequence, gene
  search and primers; footprint sequences and JASPAR motifs come from it.
  Several datasets on that assembly open together (**Open all <n> …**).
  Sessions keep each dataset's reference. Local servers (not on a public
  server or in the tour tab).
- **Linked / Per panel** beside the main locus box. **Linked**: the panels
  of each genome move together (the main genome's with the main locus box,
  another assembly's with each other). **Per panel**: every dataset panel
  has its own chromosome list and locus box. Going back to Linked takes each
  genome to the panel moved last. Sessions keep the mode.
- **Match** (the icon button beside a panel's find-reads button, "Match
  other panels on <genome> to this location") moves the other panels on the
  same genome to that panel's locus without linking them; one undo step.
- **Read names in the locus box.** Paste one or more read names (PacBio,
  ONT, Illumina, SRA) and press Enter: FiberBrowser looks in the view, then
  the chromosome, then the whole genome (Cancel stops it), goes to the read,
  keeps it drawn when the view shows a sample of the reads, and highlights
  it.
- **Search everything with ⌘K / Ctrl+K** (also the top bar's magnifier, and
  View > Search Commands and Settings… in the app): every action, panel,
  setting and keyboard shortcut, and Go to loci, genes, saved regions and
  read names. Choosing a setting opens the settings sidebar at it;
  Cmd/Ctrl+Enter turns an on/off setting on or off. The settings sidebar has
  its own search field, and the locus boxes use the same search
  (suggestions grouped as Loci, Genes, Regions and Reads).

**Reads**

- **Right-click a read** (Ctrl+click on a Mac) for its menu: select the read
  or the footprint under the pointer, open it in Read Stats, copy its name or
  locus, highlight it in every panel, zoom to it, keep only or exclude the
  selected reads, clear the selection or the read filter. On empty track
  space: find a read by name, zoom, copy the locus or position. A plain
  click or drag on reads always pans; Shift+click selects a read and
  Cmd/Ctrl+click a footprint.
- **Structural variants on reads.** Deletions of 50 bp or more break the read
  (calls stop at the breakpoint and keep their size on each side);
  insertions, clips and split reads are marked at their size. An SV track
  above the reads clusters the SVs in view with arcs and labels (carriers /
  informative reads). Right-click an SV for **Split reads by this SV**:
  carriers, reference and not-informative reads become groups, so the
  metaprofiles and every per-group view compare the alleles. Reads clipped
  at an insertion's breakpoint (the insert in a soft clip, a supplementary
  alignment or a hard clip) count as its carriers.
- **Split into panels by an SV**, from the SV row or the read menu: a panel
  each for carriers, reference and not-informative reads.
  With previews on: an insertion's Carriers panel opens with the insert
  expanded, and Cluster works there (Preview); the **Variants** panel splits by
  2 to 4 SVs at once, or SVs mixed with SNPs in **Combinations**, a panel per
  genotype.
  A split panel moved away from where it was split says its reads there
  aren't classified, with **Go back**, **Show all reads here** and **Close
  split**; closing the last split panel shows the panel it came from again.
- **Insertion lens** (its own panel). Opens a large insertion (a transposable element, for
  example) with its carrier reads in insertion coordinates: the
  nucleosomes, MSPs, footprints and m6A/5mC/deamination marks inside the
  inserted sequence, per-group profiles against reference reads, the
  insert's consensus (copy or FASTA) and every carrier's inserted bases.
  Clipped carriers show the part of the insert their soft clip holds; a
  hard-clipped carrier has no inserted bases in its record and is marked so.
  Its carriers are the reads **Split by this SV** puts in the carrier group.
  For DddA/DddB data the consensus is FiberHMM 3.0's deamination-aware one
  (a column sometimes C, sometimes T on C→T reads is a C), where a majority
  vote calls a heavily deaminated C a T; the panel says which method made it.
  **Identify** (button and tab in the lens) gives candidates for what the
  insertion is: its consensus is searched on your computer against the loaded genome (BLAST+,
  or minimap2 when BLAST+ isn't installed) and a TE library set up by the
  first Identify (the D. melanogaster canonical TE set, bundled; Dfam's
  curated families for other species, downloaded once with progress and
  Stop; both CC0). If the library can't be set up (offline), Identify still
  reports the genome hits. Each candidate comes with its identity, its
  coverage of the insert and of the element, the TE library's name and
  version, the assembly and the search tool, and Identify can answer
  **Ambiguous** (another family within 5% of the best score over the same
  bases) or **No confident match** (under 80% identity or half the insert;
  [Identify](docs/identify.md)). It reports the TE family and class,
  identity, element coverage, full length or truncated, orientation, the
  target-site duplication and poly(A); genome copies, copies near the site
  and gene/exon fragments (spliced copies flagged as retrocopies); and draws
  a to-scale cartoon with the carriers' chromatin along it (SVG/PNG). Genome
  hits are named from UCSC RepeatMasker by default: this sends the hits'
  reference coordinates (never your sequence) to UCSC, and its checkbox
  turns it off. "Search Dfam online" sends the sequence to dfam.org only
  after you confirm it for that sequence. **Open the reference copies**
  shows the identified family's best genome copies as read panels beside
  the carriers. Motif tracks show
  in alt-allele panels, scanned on the insert's own sequence.
- **Show preview features** (Settings → Reads & Display, or the command
  palette): on by default; kept on this computer
  (`~/.fiberhmm/analysis_preferences.json`), for every port and build.
- **Insert-expanded (alt-allele) panels** (Preview): an insertion's carriers
  re-aligned onto reference flank + insert consensus + reference flank, so the
  reads inside the insert cluster, sort, filter and export like any region.
  The panel's **Preview ⓘ** pill says which carriers it shows (whole insert,
  soft- or hard-clipped partial carriers), which it left out and why (the
  5,000-carrier cap, another insertion at the site, not spanning the
  breakpoint, duplicates), and how its contig maps to the reference. The first
  build takes about 25–40 s for thousands of carriers (the header counts the
  seconds); it is cached for later.
- **Variants panel**: SNPs in view (strand, depth and, for DAF-seq,
  deamination checks), the **Combinations** of their alleles (local
  read-supported allele patterns, not a phasing; two complementary patterns are
  labelled H1 / H2, local labels), SVs, and splits of the reads by allele,
  combination, several SVs, or SNPs with SVs; the SNP channel over the reads.
- **How to cite**: `CITATION.cff` (GitHub's *Cite this repository*), the About
  box, **⋮ → How to cite**, and a citation line on exported figures (on by
  default; **Citation line** in the Export panel). See [docs/citing.md](docs/citing.md).
- **Zoomed out past the read limit** ("Show reads up to"), a read panel says
  so, with the number of reads in view, instead of "No reads in this view",
  and zooms to the limit or raises it to show them in one click.

**Regions and highlights**

- **A region catalog** in the Regions panel (its first tab): named regions
  of each reference in categories and subheadings. **Import BED** (track
  lines become categories) and **Save view** add regions; on a local server
  a dataset's amplicons are also listed when it opens (named after the
  nearest gene) and **Scan regions** lists every open BAM's regions
  (amplicons, read clusters, or a targeted run's loci found from its BAM
  index), with a status line per dataset (*scanned: N regions*, or why it
  was skipped). Filter, rename, drag between categories,
  select several to highlight, move, export or remove; **Export BED**;
  **Name from a BED file**; step through a category with ‹ › or N / P. Kept
  in sessions, and per reference in `~/.fiberhmm/regions` on a local
  server; bookmarks and the old saved views are moved in.
- **Highlight** (toolbar group): Shift-drag on a ruler (or any ruler drag
  while Highlight is on) shades a region in every panel on that reference,
  in the genome map and in exported figures. Names, colours, a list and
  **Clear**; undoable and saved in sessions. Regions and the read menu can
  highlight too.

**Footprints**

- **Footprints panel** (formerly Footprint Analysis): **Find footprint
  classes** with FiberHMM's lattice recaller (default engine), a class table
  with per-channel prevalence, support and resolution, three prevalence
  tiers (core, + edge, + overlap) with a prevalence plot and table export,
  the recaller's own per-molecule calls as a layer, class support (`q0`) from
  FiberHMM class layers, and a progress bar for every step. See
  [Footprint classes](docs/LATTICE_CONSENSUS.md).
- **Saved classes** (S1, S2, …) are their own definitions tied to their run,
  with a counting tier, per-strand saving, read filters, pinned JASPAR motifs
  and undoable edits; **Cluster reads by these footprints** groups reads by
  which saved footprints they carry. Size ranges are chosen on the
  histogram.
- **Compare strands** for class runs, and DAF-seq panels that show one
  strand or split into **CT | GA** side by side.
- Per-strand coverage layers for cross-strand DAF consensus reads
  (`deam_ct`, `deam_ga`).
- FiberHMM command-line and `fiberhmm-transfer` results import into the
  panel; sessions keep their footprint-class runs.
- **Check robustness to read order (slower, ~3×)**, off by default: Find
  footprint classes repeats the search with the reads in two other orders
  and marks each class **robust** or **varies**, with a one-line summary
  ("12 of 19 classes are robust to read order"). The classes themselves are
  unchanged. Public servers allow at most this setting. This is FiberHMM's
  `--robust 2`; see [Reproducibility](https://github.com/fiberseq/FiberHMM/blob/main/docs/workflows/consensus.md#reproducibility) in FiberHMM's
  documentation.
- Under the **Stringency** slider, a hint for when a visible class is
  missing: **Try Finer (0.80)** sets it in one click. Finer finds more,
  smaller classes at the cost of near-duplicates.

**Views, clustering and figures**

- **t-SNE read map.** The Projection chart (Clusters › Charts) opens on
  t-SNE (then UMAP and PCA): one reproducible map per set of reads
  (seeded and single-threaded; above 3,000 reads a seeded sample is mapped
  and the rest placed by their nearest neighbours), a "Reading the map" help
  section, and **Export table** (read, dataset, strands, cluster, x/y and
  the map's parameters).
- **Neighbourhoods (t-SNE graph)** clustering (communities of the t-SNE
  neighbour graph of the reads' features, with a Resolution), and **Sort › By projection (t-SNE)**,
  which orders the reads along the map.
- **Export data…** (top bar **Data**, Cmd/Ctrl+Shift+E, File › Export Data…
  in the app): every data export in one place, by topic (Reads, Peaks &
  regions, Classes & footprints, Clusters, Analysis tables, Session &
  working set), each saying why when it doesn't apply. For a chosen set of
  reads (selected, shown, filtered or one cluster): their names, a per-read
  table, or a **BAM subset** of those reads with all their tags (not on
  public servers).
- **Side-panel drawer.** When the reads would be narrower than 480 px, side
  panels go into a drawer over the reads by themselves, one tab per panel in
  its colour. Drag the drawer's edge to resize it (320–1,200 px as room
  allows, remembered); **Pop out** docks that panel's column beside the
  reads, **Dock the side panels beside the
  reads** brings every panel in the drawer out, and **Pin to the side** puts
  one back.
- **Stack below / Side by side** in a dataset panel's ⋯ menu (new panels
  open side by side).
- **Copy a panel to another locus** with its own location box; locked
  copies pan and zoom together, so haplotypes or paralogs stay aligned.
  Panels at different loci cluster together on matched peaks.
- **Compare haplotypes** tab in Regions: matched-domain clustering of two
  views, joint or separate (the matched-domain comparison of the 2.16.0
  release, which 2.17 did not include).
- Peaks can be scanned on any interval layer; custom `MA` layers get their
  own colours; strand-split `MA` sections merge into one layer; DddA mCG
  spans in m5C bigBeds are the `ddda_mcg` layer.
- **Browser-identical figures from the API** (`/api/render/figure`, the
  Jupyter client's `figure()`), and SVG/PDF export with editable vector
  tracks (reads as one high-resolution image).
- **Analyze / View / Tools** strip; **Labeling** is its own panel under
  View; one **Add** box for tracks with recent tracks kept on the server;
  **Export** next to Load File and Save; **Quit** (in the toolbar's More
  menu); an in-page file browser where a native dialog cannot be used; the
  history timeline opens from Undo/Redo; "go to reads" steps through the
  best-covered loci.
- **Undo reopens a closed dataset.** Closing a dataset (⋯ → **Close
  dataset**) is a history step: Undo opens it again from its file, with its
  panel and layout; Redo closes it again.
- **Choose the footprints to cluster by:** Co-occupancy's **Cluster reads by
  N footprints** uses the saved footprints ticked under **Cluster by** (all
  of up to three at first, else the first three; remembered per locus) and
  warns when they could make more than 8 patterns. Copilot's "cluster by
  saved footprints" uses the same choice.

**Help**

- **Guided tour** of the main tools on two bundled demos (DddA DAF-seq at the
  NAPA promoter, then an H1 Fiber-seq insertion): 58 steps of one or two sentences (57 where the Copilot is
  left out), including ⌘K, the read menu, Highlight, Regions, Linked / Per
  panel and Match, the t-SNE map and Export data. It runs in a separate
  sandbox tab on its own server session, on the demo's genome (hg38) when it
  is on this computer, and never changes your work. The
  **Tutorial** panel holds the tour
  (steps by section, start at any step) and the local Copilot, which now
  teaches: walkthroughs anchored to named controls, with
  `--copilot-doctor` for setup problems.
- Documentation hub (`docs/index.md`): an illustrated user guide with
  screenshots of every tour step, a reference, workflow pages and the
  Jupyter/Python API.

**Install and run**

- **pip package** `fiberbrowser` with the `fiberbrowser` command
  (`pipx install "fiberbrowser[app]"`); extras `app`, `copilot`, `primers`,
  `contact-maps`, `s3`, `umap`, `plots`, `pipeline` and `all`.
- **App window** (`fiberbrowser --app`), **FiberBrowser.app** for Apple
  silicon Macs (macOS 14 or later; signed with a Developer ID and notarized
  by Apple), an installable web app (Chrome, Edge), menu shortcuts on
  Linux and Windows (`--install-shortcut`), and a container image. See
  [Installing FiberBrowser](docs/install.md).
- The Copilot is not included in FiberBrowser.app; it remains available in
  the pip install. (The app window, `fiberbrowser --app`, starts its server
  with `--no-copilot`, also available as `FIBERBROWSER_COPILOT=off`: the
  Copilot tab, its tour step and its usage logs are left out, and nothing is
  downloaded or started.)
- **Mac menu bar:** FiberBrowser.app has a native menu bar (FiberBrowser,
  File, Edit, View, Window, Help) with standard shortcuts: Open File ⌘O,
  Save Session ⌘S, Export Figure ⌘E, Settings ⌘, , Go to Locus ⌘L, genome
  zoom ⌘= / ⌘−, Back/Forward ⌘[ / ⌘], sidebar ⌘B, Copy Locus ⇧⌘C, New
  Independent Workspace ⇧⌘N, Quit ⌘Q. Cut, Copy, Paste and Select All now
  work in the app's text fields.
- **Wrong-genome warning:** FiberBrowser recognises a BAM's or BigBed's
  assembly from its contig lengths (hg38, hg19, mm39, mm10, dm6, sacCer3;
  also T2T-CHM13, dm3 and ce11 by name) and says when it doesn't fit the
  loaded genome, with one-click **Load <genome>** when it can download it,
  and **Load FASTA…**, **Load GTF…** and **Load plasmid map…** for your own
  reference. The genome picker suggests the assembly your data points to,
  and at start-up that assembly is loaded rather than the last one used.
- **New app icon** in FiberBrowser's own colours: single-molecule reads with
  nucleosome arrays either side of an accessible column holding TF calls.
- **Independent workspaces:** **New Independent Workspace**
  (`/?workspace=new`) opens a tab with its own datasets and analyses on the
  same server, sharing the loaded reference genome.
- **Per-user settings** in `~/.fiberhmm/browser_settings.json` (or
  `FIBERBROWSER_SETTINGS`): `fiberhmm_source_dir` (pip and source runs) and
  `require_token`.
- **The apps run their bundled FiberHMM.** FiberBrowser.app and the Windows
  app use the FiberHMM they ship with, whatever `browser_settings.json` says;
  `FIBERHMM_SOURCE_DIR` or **Settings > FiberHMM & Updates > FiberHMM:
  Custom path…** choose another. Each build declares the FiberHMM features it
  needs; a custom FiberHMM lacking one is not used (the app falls back to its
  bundled FiberHMM with a one-line notice). Settings and About show the
  FiberHMM in use, its version and folder. See
  [Updates and the FiberHMM FiberBrowser runs](docs/updates.md).
- **Check for Updates…** (app menu, command palette, Settings): a newer
  build of the app's channel with its notes, a one-click download checked
  against its SHA-256, then the DMG or installer opens; the app never replaces
  itself. A quiet check at startup (on by default in the apps, off by default
  in source runs and pip installs; Settings > FiberHMM & Updates) sends
  only a plain request for the channel's update manifest;
  `FIBERBROWSER_NO_UPDATE_CHECK=1` turns every check off. Public releases come
  from fiberseq/FiberBrowser on GitHub; a manifest on a shared drive or web
  server works too (`FIBERBROWSER_UPDATE_URL`). pip installs are told the
  `pip install -U` command. Maintainers: `tools/make_update_manifest.py`,
  `tools/publish_release.py`.
- **Lab channel:** lab builds check a private GitHub releases repository set by the lab
  pack, signing in with the GitHub CLI or a read-only token kept in the OS keychain.
  A lab app's FiberHMM must have the NFR engine and the provenance API.
- **Server profiles.** `fiberbrowser serve --config fiberbrowser-server.toml`
  with `profile = "personal"`, `"public"` or `"lab"`; `--root-path` serves
  under a URL prefix (for example behind a cluster web portal);
  `fiberbrowser check-config`. A generic **Open OnDemand** app, a cluster
  conda environment and Apptainer image, and a deploy kit for a public
  server (Docker Compose or systemd behind Caddy) are in `deploy/`. See
  [Deploying on a server](docs/deployment/index.md).
- **Lab server** (`profile = "lab"`, preview): members sign in (built-in
  accounts, or an authenticating proxy), share the Library, runs and saved
  sessions, and read only under configured data roots.
- **Windows installer:** `FiberBrowser-<version>-Setup.exe` for 64-bit
  Windows 10 (version 2004 or newer) and Windows 11 on Intel or AMD
  processors (not ARM). FiberBrowser runs in a WSL 2 Linux system of its
  own; Setup installs it for the user without administrator rights (only
  installing WSL itself asks for them and may need a restart) and adds
  Start-menu and desktop shortcuts; it opens in an Edge (or Chrome) app
  window, or the default browser when neither is installed. Windows paths, the Windows open dialog and **Reveal in Explorer**
  work. The installer is not code-signed yet: SmartScreen asks you to
  confirm (**More info › Run anyway**); a portable zip is available for PCs
  that block Setup.exe. On Windows the `fiberbrowser` pip command runs
  inside WSL. See [Installing FiberBrowser](docs/install.md#windows).
- **BLAST+ is bundled.** FiberBrowser.app includes
  NCBI BLAST+ 2.17.0 (`blastn` and `makeblastdb` only, NCBI's macOS release
  binaries) and the Windows (WSL) distribution Debian bookworm's BLAST+ 2.12.0
  (`ncbi-blast+`, the same two programs), next to minimap2, so primer checks
  need no BLAST+ install.
  Insertion identification needs none either, and every build bundles the
  D. melanogaster canonical TE sequence set v10.2 (Bergman lab / FlyBase; CC0),
  so Identify finds candidates for fly insertions without a download.
  A BLAST+ you set in
  `~/.fiberhmm/browser_settings.json` is still used first. FiberBrowser runs
  BLAST+ with NCBI's usage reporting off (`BLAST_USAGE_REPORT=false`, unless
  you set it). The app grows by about 47 MB (about 17 MB in the DMG).
  Licences, including those of the libraries NCBI's binaries include:
  `FiberBrowser.app/Contents/Resources/licenses/`; in WSL,
  `/usr/local/share/licenses/` and each Debian package's
  `/usr/share/doc/<package>/copyright` (sources at sources.debian.org).

### Changed

These change numbers relative to 2.17:

- **Motif scoring by p-value.** Saved footprints in the Footprints panel score
  JASPAR (and your own) motifs by a per-matrix p-value (default p ≤ 1e-4, from
  each matrix's exact score distribution against the genome's base
  composition) instead of a relative score, so short and long motifs are held
  to the same false-positive rate. Hits are ranked by p-value and similar
  matrices hitting the same bases are shown as one family. The older relative
  score stays available through the **p-value / relative %** toggle (its
  threshold as before); a session saved before the toggle opens in relative
  mode. Pinned key factors and your own motifs are shared with the other motif
  views, per species. The scoring code (`services/motif_scoring.py`) is shared by
  both panels.

- **Footprints cut off at read ends are hidden** (new default): a read's
  first or last footprint call shorter than 90 bp whose outer edge lies
  less than 30 bp from the read end is dropped when reads load (BAM and
  single-file BigBed datasets), so the reads drawn and FiberBrowser's own
  analyses (footprint sizes, co-occupancy, clustering features, Read Stats,
  peaks, metaprofiles) no longer count the stubs that pile up at amplicon
  ends. Which reads are shown (Min
  footprints, terminal gaps) is unchanged, and Find footprint classes
  (FiberHMM) is not affected. Turn off **Hide footprints cut off at read ends
  (< 90 bp)** (Reads & Display › Read Filters) to count these calls as 2.x
  did (the other changes listed here still apply); sessions keep the
  setting.
- **Peak calls wider than 2 kb are background, not peaks:** on nucleosome
  arrays the linker accessibility (about 35–45%) sits above the Medium
  threshold, and a scan called kilobases-wide plateaus as Medium peaks. Calls
  wider than `max_peak_width` (2,000 bp; 0 = no limit) are left out of the
  peaks (reported as broad). Scans of a track are unchanged.
- **Min footprints turns itself off for short reads:** while it is still the
  default (5), a dataset whose reads in view are all hidden by it (at least
  10, as with amplicons) turns it off once and says so, with a button to
  turn it back on. A value you set is never changed.
- **The read map (Projection) is t-SNE by default** (was PCA); clusterings
  are unchanged.
- **Coverage excludes duplicate-flagged reads** (SAM `0x400`, BigBed
  `isDuplicate`) unless the panel shows duplicates, on linear and circular
  contigs, matching the reads drawn and the `samtools depth`/IGV default
  (on one plasmid run, a bin went from 1,271 to 885). Duplicate reads are
  hidden by default (**Show duplicate reads** under Advanced Read Filters).
- **Co-occupancy counts only reads that cover a site.** A read ending before
  a site used to count as "unoccupied" there (geometric and layer groups);
  class groups count the molecules the class was scored on and report the
  rest as "not evaluated".
- **Circular contigs:** co-occupancy denominators, read counts across the
  origin and coarse coverage bins count each wrapped molecule once.
- **fibertools BAMs:** reverse reads whose `ns/nl` came from `ft predict-m6a`,
  `ft predict`, `ft add` or `ft add-nucleosomes` are drawn in molecular
  frame (they were mirrored); fibertools ≥ 0.13 `Ma` tags are read. The
  frame rule is shared with FiberHMM
  ([footprint-tag frame](docs/reference/footprint-tag-frame.md)).
- The FiberHMM DAF strand tag (`st:Z`) is read, so a DAF read's strand no
  longer falls back to a guess from IUPAC letters.
- A strict saved class counts strict members only (it used to inherit a
  wider tier from the run).

Other changes:

- **A new look** from FiberBrowser's design system: the toolbar runs File ·
  History · Navigation · App with dividers (Reset view, Analysis details,
  Keyboard shortcuts and Quit are in the **More** menu at the right); Scan,
  Cluster, Sort and Filter are one button family in their function colours
  and say why when they can't run; panels and datasets are rounded cards
  with solid coloured headers (one setting, `browser/frontend/src/theme/uiTheme.ts`, switches
  to tinted headers or square panels); analysis-strip chips carry their
  panel colour and icon; FiberBrowser's own icon set replaces emoji; panel
  text is 12 px; the genome-mismatch banner is one line.
- **Toolbar colours:** each action keeps its own colour, matched to its
  panel (Scan blue like Peak Detection, Cluster cyan like Clusters, Sort
  amber, Filter purple like Rules, Highlight teal), and is faded, with the
  reason, when it can't run.
- **Calmer read panels.** Track labels drawn over the data (Peaks,
  Accessibility, Metaprofile, Footprint classes) and empty-row hints appear
  only when you point at that track row (or focus it). The eye in a
  dataset's header (**Clean view**, on by default) turns this off and keeps
  the labels shown. A dataset's header shows its name, read count, strand,
  Clean view and one **⋯** menu (full view, add a copy, stack or
  side by side, tracks, minimize, close).
- **Calmer chrome.** Toolbar groups open in the row and stay open until you
  fold them (remembered); several can be open (the row then wraps), and
  opening one keeps the row's height. A folded group shows just its name (and its button: Scan,
  Cluster, Sort, Filter, Highlight); its values appear on hover. Settings
  open from the side rail at the right edge (no separate cog); the tour
  starts from the **Tutorial** panel or the welcome card (no separate Tour
  button); panel arrangement, including **Equal widths**, is the **Layout**
  panel (no Layout menu).
- **Analysis panels open from the rail.** The coloured tiles in the rail at
  the window's right edge, under the settings icons, are the default place to
  open analysis panels (hover a tile for its name); the reads get the strip's
  height. **Settings › Reads & Display › Analysis panels: Strip (classic)**
  brings back the strip of buttons above the reads, remembered per computer,
  and `VITE_DEFAULT_PANEL_LAUNCHER=strip` builds an app with the strip by
  default.
- **Settings open one page at a time.** Each settings icon in the rail opens
  its section (Data & Sessions, Reference & Tracks, Reads & Display, Analysis
  & Reproducibility) as one page; another icon switches the page, the same
  icon or the × closes it, and Cmd/Ctrl+B reopens the last page. There is no
  open/close arrow and no accordion; **Search settings** still searches all
  four pages.
- **Figures show what the view shows,** at the UI size: **Match UI size**
  (on) in Export figure draws text, labels, rows and lines as large as on
  screen (a 150% UI gives a 150% figure; off: 100%), also from
  `browser_client.figure(match_ui_size=...)`. Labels shown only on hover are
  left out in Clean view, and the footprint-class row is drawn.
- **Quality filters** are edited in one place, Labeling › Quality (the
  toolbar's Quality group shows what they keep, with **Edit filters…**); the
  Peaks, Cluster, Sort and Filter rule tabs share one **Add rule** and one
  **Presets** menu.
- **Escape** closes only the open menu or dialog, and no shortcut acts
  behind a dialog; **Undo** and **Redo** name the step they undo or redo.
- The chromosome list shows the main chromosomes; the others are under
  **Other contigs (N)…**, with a search. The Regions panel's tabs are
  **Regions**, **Map** and **Compare haplotypes**.
- **Nothing gets cut off in a small window.** Tab bars and the panel strip
  put what doesn't fit under **More**; the **Clusters** panel has three tabs
  (Overview, Charts, Saved) with the charts as sub-tabs; the settings
  sidebar is wider (340 px by default, resizable 300–560 px) and its rows
  wrap instead of overlapping.
- **Pin a panel to the side.** Any analysis panel can be pinned in the
  drawer that slides over the reads (they keep the whole width) or docked
  beside them; the choice is remembered per panel.
- Footprint "states" are called **classes** throughout the interface; the
  Footprint Analysis panel is **Footprints**; the lattice recaller replaces
  the Refine / CR / Cross-CR workflow (the staged engine stays selectable as
  deprecated).
- **Span** is now **Full-length only** and off by default (it hid most reads
  in wide views); sessions keep their setting.
- The browser listens on `127.0.0.1` by default (`--host 0.0.0.0` to allow
  other machines; `--public` keeps `0.0.0.0`).
- Every local launch has an access token (see *Security*); the launchers,
  `fiberbrowser`, notebooks and `browser_client` pick it up automatically.
- Closing one tab no longer stops the server; it stops when no tab has
  checked in for 15 s, or with **Quit**.
- Opens on the densest read-covered window instead of a random gene.
- Usage logs are opt-in (`FIBERBROWSER_USAGE_LOG=1` or the share toggle) and
  are written to `~/.fiberhmm/usage_logs`; render logs to
  `~/.fiberhmm/logs`. Nothing is written into the install tree.
- The Contacts panel appears once a contact map is loaded.
- Requires Python 3.10 or newer; FastAPI is capped below 0.143 until newer
  versions are tested.

### Fixed

- Footprint classes no longer depend on where the BAM is opened from or on
  the dataset's name (FiberHMM 3.0): the same files and settings give the
  same classes on every computer. Runs saved before may show a different
  number of classes near the detection threshold. See
  [Reproducibility](https://github.com/fiberseq/FiberHMM/blob/main/docs/workflows/consensus.md#reproducibility) in FiberHMM's documentation.
- Starting FiberBrowser again right after a crash or a quit moved to the
  next port ("Using port N+1 instead", or the app on 8757), so the page lost
  its autosave there: no crash-recovery or "Reopen last session" offer.
  An open tab still connected to the old port, or the closed server's
  connections winding down, no longer count as the port being in use.
- Opening a BAM together with its `.bai` opened nothing and said nothing (or
  "Can't combine BAM and BigBed files"); one failed file in a drop or a
  multiple selection could hide the others' errors.
- Peaks scanned on one dataset were drawn over every panel, including panels
  of another genome with no reads there.
- Docking the drawer said to widen the window even in a full-screen window.
- Reset view (R) also brings back excluded reads and clears read
  highlights; Undo of closing a dataset brings back its class layers.
- "Find reads" (the empty read track's button and the best-covered-locus
  button) searched indefinitely when a dataset's reads didn't map to the
  loaded genome, and could jump past a chromosome's end. It now searches
  only the loaded genome, stops within 20 s with the reason ("No reads from
  X map to the loaded genome (dm6)"), and can be cancelled.
- The app's server log recorded nothing after start-up; it now logs slow,
  stuck and failing requests and crash tracebacks, and a server that dies
  shows its log in the window instead of closing it.
- Reads showed stray TF calls beyond their drawn body near read ends: with
  terminal gaps hidden (the default) a read's body stopped at its first and
  last nucleosome, but FiberHMM ≥ 2.14 keeps TF calls only in `MA`, so TFs
  between the alignment end and the nearest nucleosome had no read behind
  them. The body now spans the read's TF calls too, and every call is drawn
  inside its read's body (browser and figure export). A legacy MSP ending in
  a soft clip no longer runs past the alignment. The in-view metaprofile and
  coverage near read ends change accordingly.
- Co-occupancy tab: pairs that open a 2×2 table show a disclosure arrow and
  count cells that filter reads look and act like buttons; a one-line
  explanation heads the tab. Profile legends sit beside the plot instead of
  under the curves.
- A fresh install's `--public` mode and tour sandbox refused every request
  on FastAPI 0.142.
- Reference sequence could come back wrong while a footprint-class run and
  panning read the FASTA at the same time (one handle shared across
  threads); each thread now has its own.
- Session import no longer deletes the footprint-class results its saved
  classes point to; the Rules JSON round trip keeps saved classes;
  recolouring a saved class keeps its read filter.
- The headless figure renderer draws the recaller's class track and calls
  as the browser does.
- A lattice-recaller run on a BigBed dataset (or with native replay off),
  which could only find nothing, is refused with the alternatives; DddA
  BigBed runs skip the default mCG conditioning with a warning.
- `fiberhmm-extract --both-strand` bigBeds are the `bothstrand` layer; reads
  whose footprints are only in `MA` are kept when a minimum footprint count
  is set; m6A is drawn from typed marks, never from a DAF read's
  deamination positions.
- No `/api/sequence` 404s at start-up without a FASTA.
- `s3://` files: a BAM loaded but showed no contigs and no reads unless it
  was on AWS with keys in the environment (htslib was handed `s3://` and
  never saw boto3's profile or endpoint); s3:// contact maps and tracks never
  opened; a public bucket kept going to AWS after an endpoint was set; a
  profile's region was replaced by us-east-1; `.csi`-only BAMs and an index
  at another address were refused. Readers now open an HTTPS URL made by
  boto3 (pre-signed for private objects), and errors say what failed (wrong
  keys vs not public vs not allowed, object or index missing, endpoint
  unreachable).
- Remote BAM indexes (`https://`, `s3://`) were saved in the server's working
  directory under their file name and reused for any BAM of that name
  (`runB/sample.bam` read with `runA`'s index: no reads, no error), or
  downloaded again on every open where that folder wasn't writable. They are
  now kept in `~/.fiberhmm/remote_cache`, once per file version.
- A remote BAM whose connection dropped showed an empty region (cached) and
  kept failing after the network returned; it now shows the error and
  reconnects. Catalog entries that can't be opened are named instead of
  loading as empty datasets (or failing silently in the sidebar), and a
  footprint-class run on a remote BAM says to use a local copy.
- About 300 smaller fixes from module-by-module reviews of data access,
  clustering and peaks, sessions and figures, footprints and consensus, the
  Copilot and the frontend.

### Removed

- **Click modes** and the **V** key: a plain click or drag on reads pans;
  right-click, Shift+click and Cmd/Ctrl+click do the rest (see *Added ›
  Reads*). Sessions saved with a click mode open as before.
- The figure dialog's **Bookmarks** tab: the dialog is **Export figure**,
  and bookmarks are saved regions in the Regions panel (existing ones are
  moved there). The Regions panel's old **Add View** list and **Open All**
  are **Save view** and **Open side by side** in the catalog.
- The targeted family scanner, site-consensus and TF-refinement workflow
  (its routes and UI); FiberHMM retired `fiberhmm-site-consensus`. Old
  sessions drop its family groups on load.
- The hyperburst transcription state (Pause, PIC and Elongating remain);
  rules using it are dropped from old sessions, and requests for it get a
  422.
- On `--public` servers: visitor-chosen track URLs and the external track
  search (`/api/add_track`, `FIBERBROWSER_PUBLIC_TRACK_HOSTS`); visitors
  see the curated catalog only.
- The unused `/api/datasets/upload` route, and the look-up of FiberHMM in a
  sibling folder (`FIBERHMM_SOURCE_DIR` or `fiberhmm_source_dir` in the
  settings file point at a source tree).
- The recaller's "abutting" option (removed from FiberHMM).
- The generated Copilot seed set from the repository
  (`scripts/build_copilot_dataset.py` rebuilds it).

### Security

- **Local servers:** a per-launch access token, as in Jupyter
  (`~/.fiberhmm/browser_runtime.json`; `--no-token`, `FIBERBROWSER_NO_TOKEN=1`
  or `require_token=false` turn it off on a single-user machine);
  cross-site requests are refused in every mode, and rebound host names on
  loopback servers.
- **Other devices and proxies** (personal servers): only a direct request
  from this computer's loopback to `localhost` is the owner. A device on the
  network, or any request through a reverse proxy on this computer
  (`tailscale serve`, Caddy; proxy headers such as `X-Forwarded-For` or
  `Tailscale-User-Login`, or a non-loopback `Host`), gets a read-only view,
  even with the access link: one central guard refuses files, uploads, jobs,
  SSH, S3, Copilot, Jupyter, plugins, settings and shutdown, and new routes
  are refused until classified. Spoofed headers can only make a request
  remote. The close-tab shutdown beacon, tab heartbeats and Quit answer only
  the owner, so closing a phone's tab can no longer stop the server. A
  personal server refuses to start on a network interface with
  `--no-token`/`FIBERBROWSER_NO_TOKEN`, and `require_token=false` in the
  settings file applies to `127.0.0.1` only. See
  [Remote access and security](docs/deployment/index.md#remote-access-and-security-personal-servers).
- **Public servers** (`--public`): only allowlisted routes; server-issued,
  capped sessions; rate limits and analysis slots per client; request body
  and span limits; server-set compute for visitors' class runs; no uploads,
  no host paths in responses, generic error bodies; a content security
  policy, HSTS over HTTPS and other security headers; a trusted-proxy list
  (`--trusted-proxy`) decides when forwarded client addresses are believed;
  limits settable in the config file.
- **Links:** nothing is fetched (not even a DNS lookup) before the user
  confirms, on any server; public and lab servers open links only from
  hosts in `FIBERBROWSER_LINK_HOSTS` (off by default), and there, and on a
  local server with that list set, the files a link opens are read through
  a relay that checks every address and redirect.
- **Lab servers** (preview): members sign in (the few exceptions are listed
  in [Deploying on a server](docs/deployment/index.md)); HttpOnly cookies,
  CSRF checks, sign-in rate limits and an audit log; forwarded host and
  scheme are believed only from a listed proxy; every file a member names,
  a run reads or writes, a plasmid header points to or a session relink
  finds must lie inside the configured data roots.
  Files are opened by a walk of folder descriptors from `/` that follows no
  symlink, with the data roots pinned (device and inode) at start-up, and
  BAM/FASTA files reach htslib as the checked descriptors; files named in a
  run's `--call-args` (e.g. `-m model.tsv`) are checked too; a refused run
  log answers 404.
- **Connect to cluster:** your own SSH only; the helper is read-only and
  confined to the chosen folders. It listens on a private Unix socket where
  the cluster allows socket forwarding and a safe folder exists, and
  otherwise on a random 127.0.0.1 port of the login node, protected by the
  per-connection token (see
  [Security](docs/workflows/remote-cluster-data.md#security)).
- Private paths and lab data were removed from the repository.

### Upgrading from 2.17

```bash
pipx install "fiberbrowser[app]"        # or: pip install --upgrade "fiberbrowser[app]"
# from a source checkout: git pull && pip install -r requirements.txt
fiberbrowser                            # opens http://localhost:8000/?token=...
```

- `requirements.txt` (and the package) now install FiberHMM 3
  (`fiberhmm[consensus]>=3.0,<4`); FiberBrowser warns at start-up when an
  older FiberHMM is found.
- **Access token.** The launchers open the tokened link for you; the token
  changes at every launch, so an old bookmark to `http://localhost:8000/`
  gets `401` (open the printed link, or see
  `~/.fiberhmm/browser_runtime.json`). Scripts using `browser_client` find
  the token by themselves; other scripts send `X-FiberBrowser-Token`.
- **Other machines.** The server listens on this computer only. Use an SSH
  tunnel to its loopback (`ssh -L 8000:localhost:8000 host`, or `-J login
  NODE` on a cluster) for the full app; `--host 0.0.0.0` (token required)
  gives other devices a read-only view.
- **Re-call FiberHMM output** as the callout above says; reload BAMs called
  with FiberHMM 3.0 to get the corrected Nanopore Hia5 calls and the class
  layers.
- **Old sessions** open. Files that moved can be located; hyperburst rules and
  targeted-family groups are dropped; the Span setting is kept.
- **Numbers that change** are listed at the top of *Changed*. **Hide
  footprints cut off at read ends (< 90 bp)** is the one to turn off to
  count read-end calls as 2.x did.
- Coverage, co-occupancy and circular-contig numbers change as listed under
  *Changed*.

## Earlier versions

Versions up to 2.17.1 have no full entries here. Highlights:

- **2.11**: `python browser.py` opens the UI by itself, with double-click
  launchers for macOS, Windows and Linux. Granular undo/redo with a history
  panel; motif tracks from JASPAR names or custom sequence/IUPAC/PWM motifs;
  a Layout panel for merging, linking and renaming datasets with saved
  arrangements; manual cluster merge, hide and order lock; row-height
  controls (`[` / `]`); label styling (unmatched-baseline opacity, read and
  background colours, gradients).
- **2.8**: the local Copilot (an on-device language model, MLX on Apple
  silicon or Ollama), with a tutorial mode and opt-in anonymized usage
  sharing.
- **2.0**: the layer-aware browser built on the fiberseq
  [Molecular-annotation spec](https://github.com/fiberseq/Molecular-annotation-spec):
  `nuc`, `tf`, FIRE/accessibility and custom layers drive every analysis;
  FiberHMM's `tf` layer from `fiberhmm-recall-tfs` and its BigBed output
  (sibling `*_footprint.bb` / `*_msp.bb` / `*_tf.bb` files merged into one
  dataset); for older footprint-only files, nucleosome, TF and accessibility
  layers inferred from footprint size (90 bp cutoff by default).
- **FiberHMM 2.6–2.8.2 reverse-strand bug.** Those FiberHMM versions shifted
  the HMM input for reverse-strand reads, so their footprints on those reads
  are at the wrong positions. Re-call such BAMs with FiberHMM 3.0 (2.9 or
  later fixed it); FiberBrowser needed no change.
