# Footprint classes (lattice recaller)

**Footprints → Classes → Find footprint classes** finds the recurrent footprint
classes in a region and measures how often each one is occupied, per dataset and
per DAF strand. The default engine is FiberHMM's **lattice recaller**
(`fiberhmm.inference.consensus.lattice_recaller`). FiberBrowser loads the
region's reads, submits an asynchronous job, and displays the frozen result; it
does not run a browser-only caller. Source BAM/BigBed layers are never changed.

## How the lattice recaller works

1. **Native calls.** The native TF caller is replayed on every read in the
   region (actual query coordinates, fixed MSPs). Confident calls (LLR at or
   above the discovery LLR, at most 100 bp by default) are the discovery input.
2. **Class discovery.** In overlapping tiles (350 bp, step 250 bp), k-means
   clusters the calls' edges into class geometries. The number of classes is the
   largest k whose split-half prediction strength reaches the **Class discovery
   stringency**. Overlapping candidates that one geometry explains as well as two
   (held-out identity test) are merged. Each class has a span (median call edges)
   and a left and right edge box.
3. **Scoring.** Every molecule that spans a class's scoring window (its edge
   boxes plus a 25 bp flank) is scored against the class on its own
   modification lattice: every observed opportunity, marked or not. The
   alternatives are the class, wider protection over it (e.g. a nucleosome),
   another shape, and accessible DNA. EM gives the **prevalence** of each class
   on each channel.
4. **Per-molecule calls.** Each scored molecule is a member, a non-member or
   abstains (Bayes factor threshold 3). Members are drawn at their own edges.

A **channel** is one dataset on one DAF strand (`dataset::CT`, `dataset::GA`)
or, for Hia5, one dataset with both alignment directions pooled
(`dataset::pooled`). Classes are shared by construction across all selected
datasets and strands; there are no cross-dataset links to resolve.

For each class and channel the run reports:

| Value | Meaning |
| --- | --- |
| Prevalence (strict) | EM share of the molecules spanning the class window that carry the class with both edges in its edge boxes |
| + edge | Adds molecules whose likelier explanation is wider protection with one edge lined up with a class edge (a clean core under it) |
| + overlap | Also adds molecules with a clean core under other protection up to 100 bp over the class |
| Lower bound | Wilson lower bound of the strict prevalence |
| Supported | Including the class raises held-out likelihood on this channel by at least 5 nats and its lower bound is at least 2% |
| Resolved | The channel's lattice carries enough evidence per molecule over the class (5 nats); otherwise the fraction is reported but flagged unresolved |
| Broader / other shape / accessible | The other EM shares for the class's overlap group |

Classes that no channel supports are left out of the catalog and call labels
(they remain in the CLI's `classes.tsv`).

## Running

1. Open the datasets, then **Footprints**. Each dataset needs its assay type
   (DddA, DddB, Hia5 PacBio, Hia5 ONT); FiberBrowser reads it from the BAM's
   FiberHMM chemistry header or asks for it (**Open dataset setup**). Types are
   never guessed.
2. **Find footprint classes** analyses one region of the selected datasets. The
   card says which before it runs (**Analyses: chr19:47,518,060–47,518,500 ·
   440 bp · the selected peak**), outlines it (dashed) on the ruler and reads of
   the targeted panels, and offers **Selected peaks** (first to last selected
   peak), **This view** (the default: what the targeted panels show) or **Saved
   region** (when Regions has one at this locus). The choice is kept in the
   session and can be undone; the region is sent as is, without padding. A
   region shorter than two discovery tiles (`recaller.tile_bp`, 2 × 350 bp) gets
   a note: classes near its edges may be missed. The results, saved classes and
   exported class tables (a `# analysed: …` first line) name the region the run
   analysed. To analyse fixed coordinates, open **Advanced → Algorithm, region,
   and display settings** and set the chromosome and 0-based, end-exclusive
   bounds, and pick datasets under **Datasets and native models**. Every read in
   the region enters inference, regardless of how many are displayed.
3. **Engine** chooses **Lattice recaller (default)** or **Staged Monte Carlo
   (deprecated)** (see *Deprecated engine* below).
4. **Class discovery stringency** (0.5–0.95, default 0.90) is the k-means
   prediction strength. Lower (**Finer**) finds more and finer classes (dense
   data, composite footprints) at the cost of near-duplicates; higher
   (**Coarser**) finds fewer. If a class you can see in the reads is missing,
   try **Finer (0.80)**; the hint under the slider sets it. In a partly closed
   region the default can lump a footprint with its neighbours, and 0.80
   separates them, at the cost of some near-duplicates. The other recaller
   settings (edge-box quantiles, scoring flank, linker rule, learned internal
   spots, support and resolution thresholds, tiling, …) are under **Advanced →
   Algorithm, region, and display settings**, each with inline help.
   `fiberhmm-consensus --schema` lists the same parameters.
5. **Check robustness to read order (slower, ~3×)** is off by default. The
   same reads and settings always give the same classes (on any computer and
   from any folder), but a class close to the detection threshold can depend
   on the order the reads are processed in. With the option on, class discovery
   is repeated with the reads in two other orders, and the class list marks
   each class **robust** (found in every order) or **varies**, with a summary
   such as "12 of 19 classes are robust to read order". The classes and their
   numbers are always those of the normal order. The run takes about three
   times as long. It is FiberHMM's `recaller.order_replicates` (2 here;
   `fiberhmm-consensus --robust N`); the number of extra orders and the share
   of orders a robust class needs (`order_robust_fraction`) are under
   **Advanced**. Saved sessions keep the setting with the run.
6. Progress and **Cancel** are shown in the panel. Earlier results stay visible
   while a new run computes; a failed or cancelled run never replaces them.
   **Find again** reruns with the current settings.

The lattice recaller replays the native caller, which needs BAM input. For a
BigBed dataset, use its BAM, or choose the staged engine with native replay
turned off (it then uses the BigBed's existing TF calls).

## The class list

After a run, **Classes** lists every class with its size and one prevalence bar
per channel: solid for strict, lighter to + edge and + overlap, gray where the
channel does not support the class. An amber dot flags a strand or assay
discrepancy. After a run with **Check robustness to read order**, each class
also reads **robust** or **varies** (hover for how many read orders found it). Click a class to highlight it on the reads (Cmd/Ctrl-click adds).
**Save** makes it a saved class (below).

Reads gain a **Footprint classes** layer (`tf_rc`) and each dataset panel an
overhead class track (solid bar: class span; pale boxes: edge boxes). On the
reads:

- A member the native caller also called is drawn at the native call's edges.
- A member the native caller did not call is drawn at the recaller's edges with
  a thin dark outline. The **Edges** control (Quality toolbar) draws its sure
  inner span (Strict), the widest span its marks allow (Loose), or both (Soft).
- A molecule counted only under + edge or + overlap is drawn with a dashed
  outline.

**Class calls at** switches between these call edges and the class's
consensus edges. Unsaved classes are drawn strict; a saved class is drawn as
its saved definitions count it.

## Compare strands and datasets

**Compare strands and datasets** (below the class list) is the class × channel
table:

- one row per class and one column per channel, each cell showing the
  prevalence with its strict · + edge · + overlap breakdown;
- channel chips hide or show channels;
- **Separate** shows each channel; **Pooled** combines the shown channels,
  weighted **by molecules** or **channels equally**;
- **CT−GA** (per DAF dataset) and **Δ assay** (largest difference between
  datasets) columns, and flags: *one strand* (supported on CT or GA only),
  *CT ≠ GA* (both supported but more than 2-fold and 10 points apart), *assay
  gap* (datasets 20 or more points apart), *unresolved*;
- sort by genomic order or largest discrepancy, and **flagged only**;
- **Export TSV** writes the shown rows and channels with all three prevalence
  tiers, lower bound, support, resolution and flags;
- **Plot** shows the prevalence plot (strict to + overlap per channel), with its
  own image and data export.

Gray (unsupported) cells show only strict prevalence; italics mark unresolved
channels.

## Saved classes

**Save** in the class list creates a saved class **S1**, **S2**, … in the
**Saved** tab. Each saved class is its own definition, tied to the run it came
from: a later run's `class_001` never takes over S1, and saving a class twice
(or the copy button) gives two independent definitions. A saved class card has:

- one row per channel the class was quantified on; click a row to count or
  leave out that channel (by default the supported channels are counted);
- **Counts**: strict, edge, overlap. This decides which molecules are drawn,
  filtered, clustered and counted in co-occupancy. A strict definition stays
  strict even if a copy of the same class counts + edge;
- **run estimate**: the picked channels' prevalence pooled by molecules, at the
  chosen tiers, and the strand/assay flags. It is the run's estimate: each
  molecule spanning the class counts by its probability of carrying it, and
  duplicate reads of one molecule count once. Co-occupancy's with/without
  instead counts the reads in view, each read once, with a confident call as
  "with" and uncertain calls as "without", so its percentage can differ;
- **Filter reads** shows only the reads it counts, on its channels; the
  checkbox colors matching reads and includes it in Co-occupancy; the color
  swatch recolors it without changing the filter;
- expanding the card renames it and shows the class position, sequence, motif
  matches and V-plot.

Above the cards, **Export TSV** and **Plot** cover every saved class (the
*Saved class prevalence* plot). The numbers are those of each class's own run.

Saved classes are saved with the session together with the runs they refer
to, so a reopened session keeps their filters and co-occupancy. A saved class
whose run is no longer available is marked as such and left out of
co-occupancy; the rest of the analysis is unaffected. **Rules (JSON)** export
and load keep the full saved-class definition.

## Co-occupancy

Enabled saved classes and size rules appear in **Co-occupancy**: per-group
occupancy and pairwise odds ratios with Fisher's exact tests on the same reads.
A read counts toward a site only if it covers it: for a size rule, the read's
alignment spans the site; for a saved class, the molecule was scored for that
class in its run. A pair uses only reads that cover both sites. Class
membership is the saved definition's (tiers and channels), not interval
overlap.

## Runs, export and import

- **Completed runs** reactivates an earlier run of this session without
  recomputing.
- **Download frozen result + provenance** saves the run as a `.json.gz`;
  **Import frozen result** reinstalls it when the same source files are open
  (paths, sizes and timestamps must match).
- **Save tagged BAMs** (under Advanced) writes the class assignments into new
  BAMs as `tf_consensus` MA/AQ/AN layers (`tf_cross_consensus` for a
  multi-dataset run) with CSI indexes, for the analysed
  regions or the full source BAMs, one BAM per dataset or per source file.
  Source BAMs are never modified.

### Importing FiberHMM CLI / transfer results

Results from `fiberhmm-consensus` (single-region runs) and from
`fiberhmm-transfer` can be loaded with **Import frozen result** (select the
run's `result.json.gz`). Open the same BAM files first: the run's datasets are
matched to the open datasets by BAM path, size and modification time. A
transfer result shows its frozen classes like any other run. Only runs in
genomic coordinates can be displayed: a transfer keeps genomic coordinates when
its BED window is the source run's own region on the `+` strand (the same locus
in other BAMs). Runs over pooled or other oriented BED windows (region
`oriented_BED`) are in window coordinates and cannot be imported.

For command-line use of the same engine:

```sh
fiberhmm-consensus --bam sample.bam --region chr1:1000000-1004000 --output run1
fiberhmm-transfer --freeze-run run1 --output frozen
# windows.bed: BED6 windows as wide as the source region, e.g. chr1 1000000 1004000 w1 0 +
fiberhmm-transfer --models frozen --bam other.bam --bed windows.bed --output transfer1
```

`fiberhmm-consensus` writes `result.json.gz`, `classes.tsv` (one row per class ×
channel), `molecules.tsv.gz` (one row per scored molecule) and a report.

## Native opportunity lattice

The native opportunity lattice (enabled from the main Layers bar; options in
**Advanced → Algorithm, region, and display settings**) marks each read's usable
observation positions: CT teal, GA amber, Hia5 purple, as edge ticks or hollow
dots, optionally with black model-threshold hits. An opportunity without a hit
is an observed miss; no mark is **not** a miss. It decodes the actual BAM query
through the native encoder and needs BAM access; zoom to 50 kb or less.

## Curation

Merging, splitting and ignoring classes (the curation toolbar under
**Advanced**) applies to staged Monte Carlo runs. It is not available for
lattice-recaller runs; to change what a recaller class counts, save it and set
its channels and tiers.

## Deprecated engine: staged Monte Carlo

**Staged Monte Carlo (deprecated)** is FiberHMM's `staged_native_families` engine:
native class fits, shared-class fits across strands and datasets,
consolidation, and Monte Carlo reference scoring, with an **Assignment
stringency** slider that re-assigns calls live from saved scores. It remains
selectable for reproducing earlier analyses and for BigBed input with native
replay off, but it is deprecated; new analyses should use the lattice
recaller. See [STAGED_FAMILIES.md](STAGED_FAMILIES.md).

## Developer entry points

- FiberHMM engine: `fiberhmm/inference/consensus/lattice_recaller/`
  (`discovery.py`, `model.py`, `workflow.py`, `frozen.py`).
- Adapter: `browser/services/consensus_workflow.py`; saved-class membership and
  co-occupancy eligibility: `browser/services/consensus_occupancy.py`.
- HTTP: `browser/routers/footprint.py`, under `/api/footprint/consensus`.
- Panel: `ConsensusTools.tsx`, `RecallerClassTable.tsx` (class list and compare
  table), `SavedClassCard.tsx`, `ConsensusComparison.tsx`; table helpers in
  `utils/recallerTable.ts`, saved classes in `utils/savedClasses.ts`.
- Drawing: `ReadTrackCanvas.ts`, `ConsensusFamilyTrack.tsx`; headless figures in
  `browser/services/figure/`.
