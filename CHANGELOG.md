# Changelog

## Unreleased

Everything since 3.0.1. Live lift is on by default
(`FIBERBROWSER_LIVE_LIFT=0` turns it off for a server; a lab server keeps it
off unless started with `=1`); graph mode needs the graph helper and a graph
package. See [Setting up live lift and graph mode](docs/workflows/pangenome-setup.md).
Maps, graph packages and the helper are made with
[graphlift](https://github.com/mtcicero26/graphlift).

### Feature hub and scans

- **Feature hub** (panel rail: **Hub**): every feature set in one table, with a
  column per dataset (and per haplotype for Differences): footprint classes,
  NFRs and peaks from fiberhmm-scan, the Find classes run, NFR runs, the SVs in
  view, the peak rules' peaks and live-lift Differences. Filter by type and
  prevalence, sort, compare two datasets (Δ), expand a row for its values and
  provenance, go to hits. **Use as** makes the selected hits an anchor set
  (saved with the session), the Cluster button's regions (then clusters), or a
  read filter (members at any selected hit). See
  [Feature hub and scans](docs/workflows/feature-hub.md).
- **Associate** (the hub's second tab): does feature A go with feature B? Four
  modes, each with a plain question: the same molecules (M1, co-occurrence of
  states), a measure of the molecules by A's state (M2, nucleosome phasing at
  anchors or a per-molecule measure), B's rate inside A on the same molecules
  (M3), and B hits near A hits (M4). Pick A and B from the hub's sets (scans,
  SVs, peaks, anchor sets), a group (datasets, haplotypes with unphased
  molecules apart, or the shown cluster run with its post-selection check) and
  a scope (the view, a BED file, an anchor set, or the scans' territory). Runs
  are jobs with progress and cancel; the statistics are FiberHMM's
  (`fiberhmm.assoc`), with its defaults. Results: what the data can't answer,
  effects with 95% intervals and p, the group difference, the pairs or
  anchors (go to, use as anchors or filter), the distance curve, and the
  inputs. The four example questions are presets. Runs are kept with the
  session. See [Associations](docs/workflows/feature-hub.md#associations).
- **Overlay** (the hub's third tab): a mark layer (regular and disordered
  arrays, undersized runs, missing nucleosomes, nucleosome and TF footprints)
  over many loci, aligned at the anchor, an edge or scaled, one profile per
  panel with the molecules measured at each position, facets and a pile; graph
  paths count only loci they carry. The Nucleosomes panel's patch list sends
  its patches here (**Overlay…**). Exports TSV and SVG. See
  [Overlaid patches](docs/workflows/feature-hub.md#overlaid-patches).
- **Open scan…** opens a fiberhmm-scan output directory. Its datasets bind to
  the loaded BAMs by file contents (bound, stale, or scan of other files); a
  scan of a live-lift dataset's own BAM joins the lifted rows record by record.
  Scan per-read groups (`fpcls`, `nfrvar`, `nfrmol`) in annotated BAMs show as
  layers, also through live lift.
- **Hits of an assembly scan** (a scan of a live-lift dataset's own BAM) are
  lifted onto this genome with graphlift's `liftbed`, keeping their source
  coordinates, with a status: lifted, split, partial, in insertion (placed at
  the junction) or unmapped. With a graph package, each hit knows which paths
  carry it: a column whose path lacks it says **absent**. Hits of one feature in
  two frames match (≡, **Matched only**). Use as works on them, and graph mode
  draws the hub's hits on the graph (Shift-click selects).
- **Scan…** runs fiberhmm-scan's engine on the open BAMs: the view's 50 kb grid
  units (and one more each side), a BED file or genes, with the modules, depth
  caps and settings you choose. It shows what is already computed and the
  equivalent `fiberhmm-scan` command line; units an opened scan or an earlier
  scan computed with the same key are never computed again. Results go to the
  scan cache (`FIBERBROWSER_SCAN_CACHE_DIR`) and give the same rows as the
  command line. Needs FiberHMM with `fiberhmm.scan`; `nuc` (nucleosome arrays)
  appears when the FiberHMM has it. Peak scans use the local Rare rule (8%
  open with at least min reads molecules covering the base, independent of the
  view); the window rule stays a setting for this release.
- Cluster, Sort and Filter by features read hub hits' per-read states; lifted
  datasets get them per record, so split rows of one read keep their own state.

### Live lift

- **Reads from another assembly, drawn on this genome.** **Open ▾ → Add live
  lift…** shows a BAM aligned to a sample's own assembly (for example HG002's
  maternal and paternal haplotypes) on the genome you are browsing, through a
  graphlift map or a plain UCSC chain (`.chain`, `.chain.gz`), without
  realigning. Only the view and a margin are lifted, as
  you browse. By default each haplotype gets its own panel (**MAT**, **PAT**),
  next to the same reads aligned to the reference; **Open as** also offers
  **Graph** and **Pooled**. See [Live lift](docs/workflows/live-lift.md).
- **View on another assembly (live lift)…** in a BAM panel's **…** menu opens
  the same dialog for that BAM, with the maps it found next to the BAM, in its
  folders and in the Library, best match first. On a lab server the search
  stays in its data folders.
- **Source assembly FASTA (optional)** in the dialog: with the sample's own
  assembly, the inspector shows its bases, **Copy sequence** copies assembly
  insertions, insertions can be **Confirmed by assembly**, and a spot check of
  the map's anchors refuses a FASTA that doesn't match.
- Lifted reads are drawn in pieces where the assemblies differ, with dashed
  connectors across gaps. **Hatching** on the coverage track marks stretches
  with no counterpart on the haplotype, so they don't look like stretches with
  no reads.
- **Insertions on reads**: optional ticks where a read has bases the reference
  lacks: **Off** (the default; the Differences row shows the insertions),
  **Ticks** or **Ticks with size**, from the **Insertions** control in the
  toolbar's **Layers** row, the row's right-click menu or the settings. Ticks stay visible at every row height; this fixes insertion badges
  that showed on one haplotype only at some window sizes.
- **Supplementary alignments**: **Own rows** (the default), **On the primary's
  row** or **Hide**.
- **Live-lift settings…** (display, the Differences row and how lifted reads
  enter analyses) are saved with sessions. Haplotypes other than MAT and PAT get
  their own stable colours.
- Lifted panels work with **Sort**, **Filter**, **Read Stats** and clustering.
  Native and lifted panels can share one clustering model, with options for
  supplementaries, alternative placements and molecules shared between
  libraries. **Export data → Reads → BAM subset** writes lifted reads as they
  are on their source assembly.
- Analyses that don't support lifted datasets yet refuse them with a message
  that says what to use instead. Live lift is not available on public servers.

### Linked panels

- **Open MAT source view** (or PAT) on a lifted panel opens the same reads on
  the sample's own assembly, under the lifted panel, without an assembly FASTA.
  See [Linked panels](docs/workflows/linked-panels.md).
- A **ribbon** joins the two panels: which stretches correspond, matches on the
  opposite strand, and wedges where one side has bases the other lacks.
- **Shared hover**: a molecule is outlined in both panels, with a line across
  the ribbon, with tooltips on or off.
- **Shared navigation**: the source view follows the main view through the map,
  and moving the source view moves the main view; in *Each panel navigates*
  the two panels still move each other. Expanding an insertion moves the
  source view to its bases. **Zoom to read** follows a read to another
  chromosome.
- Source views are named after the sample in the lift map (for example *HG002
  MAT source*), not a fixed name.
- Where a view matches several stretches (*N correspondences*), the source
  view's menu chooses which one to follow; a match on the opposite strand opens
  reversed. Links are saved with sessions.

### The Differences row and inspector

- **The SV row is now the Differences row.** On a BAM aligned to this genome it
  shows the structural variants in the reads, as before. On a lifted dataset it
  shows where each haplotype differs from this genome, one lane per haplotype,
  and optionally the edits the reads support. ◀ ▶ jump to the next difference.
  See [Differences](docs/workflows/differences.md).
- **Click an insertion to expand it in place.** Its inserted bases open as a
  column shared by every panel, with each carrier's m6A, accessibility and
  footprints. Matching MAT and PAT insertions share one column. Click a
  different kind of difference to highlight its carriers. The same clicks work
  on read ticks and on the native row.
- **⌘/Ctrl-click, or right-click → Inspect…, opens the inspector**: the
  difference on both assemblies, molecule calls (carriers, reference, not
  informative), per-haplotype counts and each read's own bases and chromatin.
  Observed bases load by themselves for up to 2,000 reads in view.
- The row's right-click menu holds its options (sources, minimum size, the
  difference table, insertion ticks) and each difference's actions (inspect,
  expand, highlight, split by carrier, show in the source view, copy the
  sequence). The same options are under **Live-lift settings… → Differences
  row**.
- **Assembly comparison.** A read difference is compared with the sample's
  assembly and labelled ✓ **Confirmed by assembly** (the same change),
  ≈ **assembly-supported (approximate)** (at least 90% identity) or
  ? **Assembly candidate (geometry only)**, in the **Reads** lane, its tooltip,
  the table's new **Assembly comparison** column and the inspector, with each
  haplotype's link. **Compare consensus with assembly** compares an insertion
  through the reads' consensus. A native BAM's inspector compares with an open
  lifted dataset's assembly. See
  [Differences](docs/workflows/differences.md#assembly-comparison).
- **Exact assembly alleles**: the inspector's **Allele target** calls carriers
  of the assembly's exact allele (up to about 1 kb), not only its shape.
  **Load molecule calls** works on lifted datasets.
- Enter on a focused mark opens the inspector. Carrier highlights stay within
  the lifted dataset and the difference's own haplotype. The inspector's read
  table shows read names, and its columns are named after the map's sample and
  reference.
- **Split by carrier** works on lifted differences, from the inspector. Splits
  can be frozen and saved; sessions with 3.0 SV splits and expanded insertions
  open with them migrated, and a relink step reattaches saved cohorts to moved
  files.

### Structural variants

- **Evidence levels.** Each molecule's evidence for a variant is **confirmed**
  (its alignment holds the event, or is split across it), **putative** (only
  clipped there), **conflicting** (the clip aligns well somewhere else) or
  **ambiguous** (the clip fits more than one variant), with its own count in the
  SVs tab, the Differences row, highlights, the split dialog and the insertion
  lens. See [Structural variants](docs/workflows/structural-variants.md).
- Carriers default to **confirmed + putative**. **Confirmed only**, and adding
  conflicting or ambiguous reads, are options in the SVs tab, the row's menu
  and the lens. Putative and other uncertain carriers are drawn with dashed
  outlines. Saved splits keep the choices they were made with.
- The conflicting-clip rule is set under **Settings › Read Filters ›
  Structural variants › Advanced carrier evidence**.
- Counts follow the same rules everywhere: one molecule per variant, with one
  10 bp evidence floor whatever the display cutoff. Molecules that align near a variant only
  through supplementary alignments are recovered. Replacements are trimmed to
  their real size, and equivalent breakpoints in repeats count as one variant.
- The SVs tab counts read *N confirmed of M informative reads* (was *N carriers
  of M informative reads*), and each row has **Inspect difference**. The
  native row's menu is headed *Differences (SVs and indels in reads)*, and `i`
  inspects from the keyboard.

### Graph mode and the graph view

- **Graph mode**: a dataset panel drawn on a pangenome graph, with the
  reference and each haplotype as lanes and each panel's reads in a band on
  its lane. Switch with the **Linear ⇄ Graph** pill or **View as graph**. New
  lifted datasets open in graph mode when a registered package binds them.
  The other haplotypes fold into the graph and can be popped out as ordinary
  panels and folded back; other panels can be added. See
  [Graph mode](docs/workflows/graph-mode.md).
- Read tools work on every band: selection, highlight, the read menu, filters,
  Sort, Filter and the toolbar layers, DAF-seq strands and soft clips.
  **Cluster** runs on the graph itself (each haplotype fitted once, so every
  band of a haplotype gets the same labels), and **Scan** finds peaks on the
  graph. Runs survive pans, bookmarks and Back/Forward.
- Past 50 kb, or where most of the window is not resolved in the graph, the
  panel switches to linear and returns below 40 kb (**Stay linear**, **Linear
  above…**). Bands fill the panel; a band that can't show every read gets a
  density strip and a count of what is drawn. Read budgets follow
  **Performance mode**.
- **Graph view panel** (preview): a sequence tube map of the graph in view, with
  inversions (a palindromic core drawn as one inversion), repeats and small
  differences, reads along their walks, click to expand an insertion and
  ⌘-click to inspect.
- **Register graph package…** in **Open ▾**, and a **Graph packages** list in
  **Settings › Reads & Display › Graph mode** (register, **Remove**), without
  preview features; on a lab server only its admins manage them.
- **Settings › Reads & Display › Graph mode**: **Open lifted datasets as**,
  **Open native BAMs in graph mode**, the zoom-out hand-off (any 10–50 kb pair)
  and **Complexity hand-off**. **Load by path** has **Open in graph mode**.
- A one-time **View as graph** offer on restored split sessions and when a
  package binds a dataset late.
- **Pop out paths…** pops out a chosen set of haplotypes; **Pop out as: lifted
  panel / source view / lifted and source** chooses what a pop-out opens.
  Source views take a graph run's labels.
- Rows are ordered by their first carried graph column; switching between graph
  and linear fades; a panel drawn linear lists the inserted sequence a run used;
  a single-haplotype dataset is labelled by its path name; **Not a carrier** is
  given only with complete evidence.
- **The graph helper** ships as the `fiberbrowser[graph]` extra (not in
  `[all]`; built for Apple silicon Macs so far) and is included in the macOS
  app. Checked packages are remembered, so the check is not repeated at each
  start.

### BAMs lifted with fiberhmm-lift

- BAMs lifted through a graph show each molecule once: records that the lift
  marks as supplementary or secondary of the source (its `Yf` tag) are hidden.
  A lift that kept no `Yf` tag shows every record, and the BAM check suggests
  repairing it with FiberHMM's `fiberhmm-lift --repair-only`. Native `vg
  giraffe` BAMs are no longer taken for lifts.
- A read's DAF-seq strand (CT or GA) comes from its own `st` tag; a record whose
  strand fiberhmm-lift reversed shows its source `st`, so CT/GA agree across
  native, live-lifted, fiberhmm-lifted and graph rows. The tooltip
  shows a repaired lift's source locus and source MAPQ, and the Library shows
  the lift (source → target, graph).

### Clustering and analysis

- **No MAPQ filter by default.** Read-difference calls, conflicting clips,
  split-read junctions, the SNP scan and consensus evidence no longer drop
  reads below MAPQ 20. A minimum can still be set: **Read analysis MAPQ ≥** (new,
  in Live-lift settings), **MapQ ≥** in the SNPs tab and **Min elsewhere MAPQ**
  for conflicting clips.

- Cluster assignment counts only positions a read covers, breaks ties the same
  way every time, and no longer depends on read order.
- Metaprofile signal and coverage use the same bins.

### Performance

- Lifted panels pan 2–3.5 times faster and open up to twice as fast. In graph
  mode a pan decodes only the new records.
- Large reconstructions stay within their memory budget, can be cancelled, and
  release idle workers.
- Native panning reuses cached reads again.

### Fixed

- Loading could hang (HTTP 499) when two panels read the same BAM.
- DAF-C read and contact views show nucleosomes from FiberHMM 3.0 `MA` and
  fibertools 0.13 `Ma` BAMs, and the BAM check no longer reports "missing
  Fiber-seq tags" for fibertools 0.13 `Ma`/`Aq` BAMs.
- Datasets added to the server after a page opened now appear in it.
- A crash in SV projection, stale split and export requests, DAF consensus for
  circular carriers, and insertion marks on minus-strand reads.
- Lifted rows keep their connectors across 1 bp map holes, keep deleted bases
  cut, and cut calls only at indels of at least the SV minimum, as native rows
  do.

### For developers

- `scripts/unified_demo.py` starts a server with live lift, the graph helper, a
  graph package and preview features on, and loads demo samples with neutral
  labels ([how](docs/workflows/pangenome-setup.md#trying-everything-at-once-the-demo-launcher)).
- `FIBERBROWSER_FRONTEND_DIST` serves a frontend built outside the checkout.

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
