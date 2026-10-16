# Workflow: clustering and transcription states

[← Docs index](../index.md) · [← README](../../README.md)

Group single molecules into states by their footprints at chosen positions,
then quantify and filter molecules by per-molecule transcription state at a
gene. The [user guide](../guide.md#peaks-and-clustering) shows the first half on the demo dataset.
The statistics behind each plot are in
[Analysis methods and statistics](../analysis_methods_and_statistics.md).

## 1. Peaks

Peaks are the positions clustering uses as features.

- **Scan** in the toolbar's **Peaks** group (or press **S**) finds regions
  accessible in many reads in the current view.
- **Draw** lets you define your own peak: drag on the Custom row of the Peaks
  track. **Cancel Draw** leaves drawing mode.
- Click a peak to select it; Cmd/Ctrl+click adds more; **Clear** clears the
  selection. **Escape** also clears it.
- Peak detection rules live in **Rules → Peaks** (the **Rules** button in the
  **Peaks** group opens them). **Lock current peaks** (sidebar → **Analysis &
  Reproducibility → Peak Detection**) keeps the current peaks fixed while you
  navigate.

## 2. Cluster

In the toolbar's **Cluster** group:

1. Choose the feature source for the selected peaks (accessibility, another
   layer, or a cluster rule from **Rules → Cluster**).
2. Choose a method: **K-means (exact)**, **K-means (fast)**, **Hierarchical**,
   **HDBSCAN** or **Combinatorial**. K-means needs **K**; Combinatorial uses an
   openness threshold.
3. Click **Cluster**.

A coloured bar beside the reads shows each read's cluster. **Detail** opens the
**Clusters** panel, as does clicking a colour in the bar. **Clear clusters** removes the clustering,
its branch tree, focus and sort order.

## 3. Refine clusters

In the **Clusters** panel, **Overview** tab:

- Select clusters by clicking them (Shift- or Cmd/Ctrl-click to add). Drag to
  reorder. Click a name to rename it.
- **Merge** merges the selected clusters into the first one selected.
- **Hide** and **Hide others** hide clusters without re-running;
  **Unhide** and **Unhide all** bring them back.
- **Merge similar clusters** merges clusters under a minimum share of reads,
  then the smaller of any two whose average profiles are nearly identical. Its
  settings button sets both thresholds and previews the result in **Charts** →
  **Projection**
  (**Before**, **After merge**, **Side-by-side**). Tip: choose K a little high,
  then merge.
- **Dynamic reassignment** re-assigns reads to the nearest cluster as you
  navigate. **Conservative** requires a read to overlap every clustering peak;
  **Aggressive** uses whichever peaks a read overlaps. Other reads go to an
  Unassigned group.

Other tabs: **Profiles** (average profiles overlaid), **Composition** (each
dataset's share of reads per cluster, as **Bar**, **Pie** or **Line**),
**V-Plot** (footprint size vs position, by **Midpoint** or **Full footprint**),
**Projection** (PCA, UMAP or t-SNE of every read), and **Differences** (when
labeling rules are defined: what sets each cluster apart). Click cluster names
above a chart to show only those clusters; the pick is shared with the read
panel.

### Subclusters and branches

Select or focus one or more clusters and the **Cluster** button becomes
**Subcluster**. Running it splits only those reads. Each split becomes a branch
in the **Cluster branches** map in the **Clusters** panel, where you can name a
branch or delete it with its children.

### Keeping a clustering

**Snapshot** stores the current clustering in the **Saved** tab. From there,
**Restore** (or **Go & Restore** from another locus) brings it back, and
**Export JSON** / **Export TSV** write it out.

## 4. Cluster focus drives the analysis panels

Press **1**–**9** to focus a cluster (**0** clears the focus; **Escape** clears
focus and peak selection). The analysis panels (Footprints, Transcription, Read
Stats, Co-accessibility) then use only the reads in the focused clusters.
Clicking a colour in the cluster bar selects that cluster and opens the
**Clusters** panel.

Sorting follows clusters: **Sort** orders reads within each cluster, for
example by the percentage of a layer at the selected peaks or by a sort rule.
**Filter** keeps only reads that match a filter rule.

## 5. Transcription states

1. Select a gene: click it in the gene track (Shift+click to add more genes).
   Cmd/Ctrl+click selects it and opens **Transcription** directly.
2. The **Filters** tab scores every read at the selected genes:

   | State | Default definition |
   |-------|--------------------|
   | **Pause** | The median TF footprint overlapping TSS +10 to +50 is 35–65 bp |
   | **PIC** | The median TF footprint overlapping TSS −50 to +25 is 20–40 or 60–80 bp |
   | **Elongating** | Number of 35–65 bp TF footprints overlapping the gene body, at least the **Minimum Pol II count** (optional maximum) |

   Exact rules, strand handling and multi-gene logic are in
   [Analysis methods](../analysis_methods_and_statistics.md#transcription-state-analysis).
   The state thresholds can be edited in the panel.
3. Tick one or more states to filter the reads to molecules in those states.
   Several ticked states combine with OR. The panel shows the count for each
   state and a **Per-dataset breakdown**.

Other tabs: **Distribution** (state prevalence and the elongating-count
distribution, mean Pol II per read by cluster), **Co-occur** (how often pairs of
states occur on the same molecule, with Fisher tests), and **Pol II COM** (reads
ordered by the position of their Pol II signal). The panel exports the
per-read state table as TSV and the settings plus results as JSON.

State calls depend on which footprints count: set layers and quality filters in
**Labeling** first.

## Several datasets

- **Link** panels (the **Layout** panel → **Link**)
  so they share clustering and analysis. **Merge** pools datasets into one panel.
- The main **Cluster** button pools reads from the selected windows into one
  joint feature matrix, so cluster numbers mean the same thing in every dataset
  and window. See [Genome windows](../GENOME_WINDOWS.md) and
  [Haplotype comparison](haplotype-comparison.md).
- Per-panel state (clusters, focus, sort order) is kept per panel, so copies of
  a panel can hold independent views of the same dataset.

## Equivalent positions

An accepted **Synchronise regions** match, **Link as matched** group, or SV split
uses one shared coordinate map. Expanding an insertion matches its reference
flanks automatically; the split strip says **flanks matched**. Inserted or deleted
sequence has no counterpart. The map is saved with the session, and automatic
SV maps are removed when their panels close.

Draw or select a peak inside a matched block to select its equivalents in the
other members. **Scan peaks** pools the members' signal and coverage before
calling shared peaks. It scans unaligned stretches separately for each member.
In **Peak Detection**, expand **Pooled and member profiles** to inspect or export
the pooled signal and each member's contribution in shared coordinates.

**Cluster** uses the mapped features in one fit and keeps assignments and counts
per member. Picking a cluster highlights its reads across the participating
panels. The result names the correspondence and reports member-specific features.
Selected features inside an insertion are excluded from numerical fits because
they have no counterpart. Combinatorial clustering measures them on the carrier
member and marks the other members unknown. The result reports this distinction.

For windows at the same reference positions, **Synchronise regions → Use known
correspondence** offers the identity map or the known SV flanks, including gaps.
Sequence matches keep their block orientation and indels.

## Tips

- Analyses use every eligible read, not the displayed sample. Set **Analysis
  cap** (sidebar → **Analysis & Reproducibility → Reproducibility**) only if
  they are slow; the **Seed** makes sampling reproducible.
- From Python: `cluster_all(...)`, `get_clusters_tsv()`,
  `filter_by_transcription_state(...)` and `get_transcription_state_counts(...)`.
  See the [Jupyter / Python API](../jupyter-api.md).
