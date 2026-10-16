# Workflow: haplotype comparison

[← Docs index](../index.md) · [← README](../../README.md)

A haplotype comparison shows the same coordinates on two chromosomes side by
side, for example the maternal and paternal copies of a locus in a phased
assembly (`chr1_mat` / `chr1_pat`). You can then cluster the reads of the two
views separately, or co-cluster them on matched features so that each state
means the same thing in both views and its share can be compared.

## 1. Open a comparison

The form is in two places:

- the **Regions** panel, tab **Compare haplotypes** (always in the rail);
- the **Contacts** panel, tab **Compare haplotypes** (in the rail once a
  contact map is loaded).

The reference must have at least two chromosomes. To load two haplotype
references at once (with distinct chromosome names that match the BAMs), use
**Reference Files → Multiple FASTA / annotation pairs** in the sidebar's genome
section; see also [Genome windows](../GENOME_WINDOWS.md).

1. Pick the two chromosomes. **Detected pairs:** lists chromosome pairs whose
   names differ only by a haplotype suffix (`_hap1`/`_hap2`, `_h1`/`_h2`,
   `_mat`/`_pat`, `_maternal`/`_paternal`); click one to fill both.
2. Optionally type a gene or `chr:start-end` in **Gene or region (optional)**.
   A gene opens with 5 kb on each side; without a region the first 20 kb open.
3. With two or more datasets loaded, choose what each view shows under
   **View 1 datasets** and **View 2 datasets** (by default every dataset is on
   both views). Use this to put one sample on each haplotype, or several samples
   stacked on each side.
4. Click **Compare Haplotypes**.

View 1 (the first chromosome) opens on the left, View 2 on the right. Your
other dataset panels are hidden while the comparison is open. Comparison panels
are locked sites: panning or zooming one moves the others (and the main view)
by the same amount; the lock button in a panel's location bar unlocks it.
**Close comparison** (or the × in a comparison panel's location bar) removes the
comparison panels and brings your panels back.

## 2. Pick the features to compare

Peaks are scanned in each view as usual (see
[Clustering](clustering-and-transcription-states.md)). Click peaks in the
**Peaks** track of each view to select them, or draw your own. The
**Comparison clustering** box (under **Haplotype comparison active**) lists each
view's selected peaks as F1, F2, …

Feature 1 of View 1 is matched with feature 1 of View 2, feature 2 with
feature 2, and so on, left to right. Both views need the same number of
selected peaks. Matched features may differ in width: each feature is
resampled to the same number of columns before clustering, so position and
width inside the view do not matter.

**Reverse View 2** is for a locus that is inverted in View 2. View 2's features
are then matched right to left (its rightmost feature is F1), and each feature
is also read in reverse, so both views are read in the same direction.

## 3. Cluster

The method and **K** come from the toolbar's **Cluster** group.
**Combinatorial**, **K-means (exact)** and **K-means (fast)** can be used here.

- **Cluster each view separately** fits one model per view. Each view gets its
  own states, numbered apart (View 2's states follow View 1's), so the same
  colour never suggests the same state in both views.
- **Co-cluster matched domains** fits one model to both views. The states are
  shared, so the table can compare their shares.

**Balance views** (on by default) fits the model on the same number of reads
from every panel of the comparison, then assigns every read. Without it, a
deeper view or dataset defines the states on its own.

With **Combinatorial**, each read's open/closed pattern is called on its own,
so both buttons give the same states; the table then compares patterns
(`O` = open, `C` = closed, one letter per feature).

Both results are kept: the buttons change to **Show separate result** and
**Show co-clustered result** and switch between them. Changing the peaks, the
views, the method or K clears them. The states are applied to the comparison
panels like any clustering (cluster bars, **Clusters** panel, sorting). They
are not reassigned as you pan; cluster again after moving.

## 4. Read the table

For each state the table gives its share of each view's reads (and the read
count). After co-clustering, **Shift** is View 2's share minus View 1's, in
percentage points.

Above the table, co-clustering reports how many reads the model was fitted on
and two separation scores (normalized mutual information, 0 to 1): how well the
states tell the two views apart, and how well they tell the individual panels
(datasets) apart. Real haplotype differences give a view separation above 0,
but when either score is high the box warns that the states may reflect a
technical difference between the samples (depth, chemistry, read quality).
Check that before reading a shift as biology.

## From Python or the API

`POST /api/cluster_matched_views` runs the same clustering. The request has two
`views`, each with `id`, `chrom`, `start`, `end`, `panels`
(`[{dataset_id, result_key, read_ids?, strand?}]`), `peak_regions` in genomic
order and `reverse`; plus `mode` (`joint` or `separate`), `method`, `k`,
`bins_per_feature` (default 20), `balance_views`, `max_reads` and
`sample_seed`. The response has per-`result_key` assignments, `label_space`
(`shared` or `per_view`), `cluster_patterns` (combinatorial),
`balanced_fit_reads`, `total_reads`, `view_separation_nmi` and
`dataset_separation_nmi`.
