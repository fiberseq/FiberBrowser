# Tutorial

[← Docs index](index.md) · [← README](../README.md)

This tutorial walks through FiberBrowser on the two demos that ship with it,
in the order of the in-app guided tour (58 steps). Each section
says what to do, what you should see, and why it matters. The
[user guide](guide.md) has a screenshot of every step and more detail; the
step numbers below link to it.

The demos are:

- **NAPA demo (DddA-seq)**: DddA DAF-seq reads at the *NAPA* promoter on
  human chromosome 19 (hg38, `chr19:47,514,000-47,518,000`).
- **H1 insertion demo (Fiber-seq)**: PacBio Fiber-seq reads from H1 cells
  (Hia5, FiberHMM 3.0 calls, HP-tagged) around a heterozygous 7,471-bp
  insertion at `chr1:23,277,272` (hg38).

Everything here works the same way on your own data (see
[Your own data](#12-your-own-data)).

## Contents

1. [Start the tour](#1-start-the-tour) (step 1)
2. [Load data and move around](#2-load-data-and-move-around) (steps 2–6)
3. [Reads and layers](#3-reads-and-layers) (steps 7–12)
4. [Peaks and clustering](#4-peaks-and-clustering) (steps 13–20)
5. [Footprints and footprint classes](#5-footprints-and-footprint-classes) (steps 21–29)
6. [Regions and highlights](#6-regions-and-highlights) (steps 30–32)
7. [Labeling and rules](#7-labeling-and-rules) (steps 33–35)
8. [Tracks, co-accessibility and primers](#8-tracks-co-accessibility-and-primers) (steps 36–39)
9. [Panels and layout](#9-panels-and-layout) (steps 40–43)
10. [Variants: haplotypes, SVs and an insert](#10-variants-haplotypes-svs-and-an-insert) (steps 44–51)
11. [Undo, save and export](#11-undo-save-and-export) (steps 52–58)
12. [Your own data](#12-your-own-data)

## 1. Start the tour

Start FiberBrowser (`fiberbrowser`, `python browser.py`, or the app). With
nothing loaded it shows a welcome card: click **Take the tour**. You can also
open **Tutorial** (its tile in the rail at the right edge) and use **Start
from the beginning**, or click any step to start there; the tour first sets up
what that step needs.

![The welcome screen](images/guide/00_welcome_screen.png)

The tour opens in a **new tab with its own server session**. A banner says
nothing there changes your work, and **Close tab** ends it. That tab hides the
controls that act on your computer (**Open**, **Save**, **Primers**,
**Copilot**); the tour still explains them.

The dark popover gives each step's title, a sentence or two, and in green how
to do it yourself. **Next** moves on, and many steps do the action for you.
**End tour** stops at any time.

**Next** on the first step ([1](guide.md#1-welcome)) loads the NAPA demo and
goes to the *NAPA* promoter.

## 2. Load data and move around

1. **Open** (top left of your own tab) opens BAMs, BigBeds, tracks, a genome
   FASTA, a plasmid map or a saved session; you can also drag files onto the
   window. The arrow beside it has the other ways in: the Library, a path or
   URL, **Connect to cluster…**, **Process raw data** (a new DAF-seq run) and
   **Data quality**. ([2](guide.md#2-loading-data))
2. Type `NAPA` in the location box and press Enter. The box also takes
   coordinates, read names and saved-region names; ← and → step back and
   forward. ([3](guide.md#3-going-somewhere))
3. Zoom with **+** / **−** (or ↑ / ↓) and pan with ← / → or by dragging the
   reads. The crosshair jumps to the best-covered places in the data.
   ([4](guide.md#4-pan-and-zoom))
4. Press **Cmd/Ctrl+K**, type `row height`, and press Enter. The command
   palette finds any command, panel or setting and opens it where it lives;
   on/off settings switch right in the list.
   ([5](guide.md#5-search-commands-and-settings))
5. Hover the coloured tiles in the rail at the right: each opens an analysis
   panel (Clusters, Footprints, Variants, Rules, …) beside the reads. Click a
   tile again to close it. ([6](guide.md#6-analysis-panels))

## 3. Reads and layers

![The reads of the NAPA demo](images/guide/07_reads.png)

1. Each row is one DNA molecule: **green** blocks are nucleosome-sized
   footprints, **magenta** blocks are smaller TF-sized footprints, and the gaps
   are accessible DNA. The **Metaprofile** above sums them over all reads.
   Hover a read for its details. ([7](guide.md#7-reads))
2. A click or drag on the reads always pans. **Right-click** a read (Ctrl+click
   on a Mac) for its menu: copy its name, zoom to it, highlight it in every
   panel, or keep only (or exclude) the selected reads.
   ([8](guide.md#8-acting-on-reads-right-click))
3. **Shift+click** three reads. They are outlined and **Read Stats** opens.
   ([9](guide.md#9-selecting-reads-shiftclick))
4. Read Stats has **Summary**, **Table** and **Distributions** for the
   selected reads; its **Reads** menu switches to every read shown, or one
   cluster. ([10](guide.md#10-read-stats))
5. The toolbar under the top bar is in groups: **Reads**, **Layers**, **Scan**,
   **Cluster**, **Sort**, **Filter**, **Highlight**, **Quality**. Click a
   group's name to open its controls in the row, and again to fold it. Open
   **Reads**: **Fit** or **All** and **−** / **+** set how reads are drawn.
   ([11](guide.md#11-toolbar-groups))
6. In **Layers**, turn **Accessibility** and **Deamination** on and off. Each
   checkbox is one kind of call; its colour is the colour on the reads.
   ([12](guide.md#12-layers))

## 4. Peaks and clustering

1. Peaks are regions accessible in many reads. They are found automatically
   in the **Peaks** track; click **Scan** (or press **S**) to scan again. Drag
   on the **Custom** row of the Peaks track to draw your own.
   ([13](guide.md#13-peaks))
2. Click the two strongest peaks to select them (Cmd/Ctrl+click adds more).
   ([14](guide.md#14-selecting-peaks))
3. Open the **Cluster** group, choose **K-means (exact)** and K = 6, and click
   **Cluster**. The reads are grouped by their footprints at the selected
   peaks, and a coloured bar beside the reads shows each read's cluster.
   ([15](guide.md#15-clustering))
4. In the **Clusters** panel, click **Merge similar clusters**. It joins the
   tiny clusters and pairs that look alike; **Unmerge** switches back, and
   each merged cluster has **Split back**. Choosing K a little high and then
   merging is a good habit. ([16](guide.md#16-merging-similar-clusters))

   ![The Clusters panel after merging](images/guide/17_the_clusters_panel.png)

5. Click a colour in the cluster bar, or press **1**–**9**, to focus one
   cluster; **0** clears the focus. Every analysis panel then uses only the
   focused reads. **Snapshot** keeps the clustering in **Saved** to restore
   later. ([17](guide.md#17-the-clusters-panel))
6. Open **Charts**: **Profiles** overlays the clusters' average profiles,
   **Composition** shows each dataset's share, **V-Plot** plots footprint size
   against position, and **Differences** (once you have labeling rules) shows
   what sets each cluster apart. ([18](guide.md#18-profiles-and-other-views))
7. In **Overview**, choose **Map**: each read is a dot on a t-SNE map,
   coloured by cluster. Neighbours are similar reads; distances between groups
   mean little. Click a dot to focus its cluster, Esc to show all again.
   **Export table** saves each read's place on the map.
   ([19](guide.md#19-the-read-map))
8. **Sort** orders reads within each cluster (accessibility at a peak,
   footprint count, or place on the map); **Filter** keeps only reads that
   match a rule. ([20](guide.md#20-sort-and-filter))

## 5. Footprints and footprint classes

1. Hold **Cmd** (Ctrl on Windows and Linux) and click a footprint inside a
   selected peak. The **Footprints** panel opens with the sizes of the
   footprints at that spot across all reads.
   ([21](guide.md#21-analysing-a-spot-cmdclick))
2. Drag across the size bars (or type a range, or pick **35–80 (TF)**) and
   click **Save**. The saved footprint is a definition, that size range at
   that spot, and is coloured on the reads.
   ([22](guide.md#22-saving-a-footprint))
3. Open it in **Saved**: its sequence with JASPAR motif matches (scored by
   p-value), the key factors you pin, and a V-plot. **Filter reads** shows only
   the reads that carry it. ([23](guide.md#23-saved-footprints))
4. In **Classes**, click **Find footprint classes** (a minute or two for this
   view). FiberHMM's lattice recaller groups footprints that recur at the same
   place, across every read in view, into classes with their own colours.
   This section is a **Preview** feature: the method and its outputs can still
   change. ([24](guide.md#24-footprint-classes))
5. The class table has one row per class with bars for how often it is
   occupied on each strand (**CT** and **GA** for DAF-seq). Click a class name
   to highlight it on the reads. ([25](guide.md#25-the-class-table))
6. Click **Add to Saved** on the first class. It becomes **S1** in **Saved**,
   where it can be counted, filtered, plotted and exported on its own.
   ([26](guide.md#26-saving-a-class),
   [27](guide.md#27-saved-classes-and-their-prevalence))
7. Open **Co-occupancy**. It tests whether the ticked saved footprints and
   classes occur on the same reads more (red) or less (blue) often than chance,
   with Fisher exact tests and Benjamini–Hochberg correction. Every count is a
   button that shows just those reads. ([28](guide.md#28-co-occupancy))

   ![Co-occupancy](images/guide/28_co_occupancy.png)

8. Under the class table, **Compare strands** puts each class's prevalence on
   the C→T and G→A strands side by side and flags where they disagree.
   ([29](guide.md#29-compare-strands))

## 6. Regions and highlights

1. Shift-drag on the ruler above the reads to shade a region in every panel.
   The **Highlight** group also highlights the view or the selected peaks;
   **List** names them and **Clear** removes them. ([30](guide.md#30-highlight))
2. Open **Regions** and click **Save view**. Saved regions live in categories
   (your views, imported BED files, and in your own tab the regions **Scan
   regions** finds in your datasets). Type a region's name in the location box,
   or press **N** and **P** to step through a category.
   ([31](guide.md#31-regions))
3. **Compare haplotypes** opens the same coordinates on two chromosomes side by
   side (for example `chr1_mat` and `chr1_pat`). The demo has one haplotype, so
   the tour only shows the form. ([32](guide.md#32-comparing-haplotypes))

## 7. Labeling and rules

1. **Labeling** colours footprints by rules: a size range, a layer, and where
   the footprint sits (in a gene, a peak, a motif). The first rule that matches
   wins. **Quick add** makes common ones, such as *Pol II footprints NOT in* a
   gene. ([33](guide.md#33-labeling))
2. Its **Quality** tab sets how confident a call must be to count, for the
   colours and the analyses. The toolbar's **Quality** group shows what is in
   effect. ([34](guide.md#34-quality-filters))
3. **Rules** holds reusable definitions (**Peaks**, **Cluster**, **Sort**,
   **Filter**), such as "open at the promoter and bound at the enhancer". A rule
   you add appears in that toolbar group. ([35](guide.md#35-rules))

## 8. Tracks, co-accessibility and primers

1. In **Tracks**, type in the add box: a file path or URL, a JASPAR motif name
   such as `CTCF`, or a sequence. **+ Metaprofile** and **+ Combined track**
   build tracks from your reads or from several sources.
   ([36](guide.md#36-adding-a-track))
2. **Browse hubs…** searches UCSC, ENCODE and ChIP-Atlas for tracks to show
   beside the reads. ([37](guide.md#37-track-hubs))
3. **Co-accessibility** shows which positions are open together on the same
   molecules, as a matrix you can export. ([38](guide.md#38-co-accessibility))
4. **Primers** (your own tab only) designs PCR primers around the selected
   peaks, or for 3C and 4C, and checks them with BLAST; its **Order list**
   exports them for IDT and other vendors. ([39](guide.md#39-primers))

## 9. Panels and layout

1. The **Layout** panel links panels so they share clustering and analysis,
   merges datasets into one panel, and renames them.
   ([40](guide.md#40-linking-and-merging-datasets))
2. **Linked / Per panel** (left of the chromosome selector): Linked moves the
   panels on each genome together; Per panel gives each its own location box,
   with **Match** to bring the others there. A dataset on another genome can
   open in its own panel. ([41](guide.md#41-genomes-and-navigation))
3. A dataset panel's header has its actions: **Tracks** (show, remove, restore
   or reorder the panel's tracks), **+** (a copy), minimize, expand and close;
   the rest are under **⋯**. Right-click any track for its menu.
   ([42](guide.md#42-panel-actions))
4. **Equal widths** evens out the panels and **Reset** puts rows and sizes
   back. A side panel's pin button slides it into a drawer over the reads.
   ([43](guide.md#43-layout))

## 10. Variants: haplotypes, SVs and an insert

This section uses the second demo. The Variants panel is a supported feature
in 3.0; the expanded insert (step 50) is a Preview feature, on by default
(**Settings › Reads & Display › Show preview features**).

1. **Next** on step 44 loads **H1 insertion demo (Fiber-seq)** at
   `chr1:23,273,500-23,281,000` and folds the NAPA panel away. The reads stop
   at the breakpoint where the carriers' alignments are clipped, and the **SV**
   row above the reads flags the insertion.
   ([44](guide.md#44-a-structural-variant-demo))
2. Click the **Variants** tile in the rail (a sequence bar with a substituted
   base and an inserted block). It works on the reads in view of the selected
   dataset, with three tabs: **SNPs**, **Combinations** and **SVs**. Its calls
   come from the reads' own bases and alignments.
   ([45](guide.md#45-the-variants-panel))
3. In **SNPs**, click **Find SNPs in view** (**Auto** scans again as you move).
   Each row is a SNP or small indel with its allele counts, depth and
   minor-allele fraction; they are also ticks in the SNP channel above the
   reads. Here the SNPs pile up near the breakpoint: they come from aligning
   reads that hold the inserted sequence, not from real variants. So split by
   haplotype instead. ([46](guide.md#46-snps-in-view))

   ![The SNP table](images/guide/46_snps_in_view.png)

4. Open **Combinations**, choose **HP tags** (the haplotypes phased upstream),
   then **Split into panels…** and **Open**. Each haplotype gets a read panel
   of its own: every read that holds the whole insertion is on **HP 1**, with
   the **+7.5 kb** insertion mark at the breakpoint, and none is on **HP 2**.
   **Split ×** in a split panel's header closes the split and brings the
   original panel back. On another locus, click a SNP row and use **Split
   into panels…** the same way. ([47](guide.md#47-reads-split-by-haplotype))

   ![One panel per haplotype](images/guide/47_reads_split_by_haplotype.png)

5. Open **SVs**. It lists the deletions and insertions of 50 bp or more in
   view, with their carriers: here **INS 7.5 kb @ chr1:23,277,273**, carried by
   71 of 108 informative reads. Each row can group or split the reads by the
   SV (carriers, reference, not informative), open it in the **Insertion
   lens**, or show which SNP alleles travel with it. Tick two to four SVs to
   split by their combined genotype. ([48](guide.md#48-structural-variants))
6. Hover the insertion's flag in the **SV** row for its carriers, and
   right-click it for the same actions.
   ([49](guide.md#49-insertions-on-the-reads))

   ![The SV row's menu](images/guide/x17_sv_row_menu.png)

7. Right-click the insertion and choose **Open carriers with the insert
   expanded**. The carriers are re-aligned onto the alternate allele (reference
   flank, insert consensus, reference flank), so the reads inside the insert
   can be clustered, sorted and analysed like any region. The ruler counts
   positions inside the insert (**ins 3,800**), and the panel's pill says how
   many carriers it placed. ([50](guide.md#50-the-insert-expanded))
8. The tour shows insert positions 3,300–4,300 with the carriers sorted by
   accessibility over the insert's nucleosome-free region (insert
   ~3,723–3,879). Most carriers are open there, and most of those have a
   footprint at its centre (insert ~3,771–3,804) over a CTCF motif (JASPAR
   MA0139.2, minus strand). The reference genome has no such element: it comes
   with the insertion, on HP1. ([51](guide.md#51-inside-the-insert-a-ctcf-site))

   ![The CTCF footprint inside the insert](images/guide/51_inside_the_insert_a_ctcf_site.png)

To compare carriers with the reads without the insertion, use **Split into
panels…** on the insertion's row in **SVs**: carriers and reference reads open
side by side.

## 11. Undo, save and export

1. **Undo** (Cmd/Ctrl+Z) and **Redo** step through your changes; the ▾ beside
   them opens a timeline to jump back to any step. **Reset view** (R) clears
   clustering, filters and selections in one go. ([52](guide.md#52-undo))
2. **Save** (your own tab) downloads a session file to reopen with **Open**.
   Your work is also kept as you go, and the next launch offers to reopen it.
   ([53](guide.md#53-save))
3. **Export** makes a figure (PNG, SVG or PDF) of what you see, with text as
   large as on screen. ([54](guide.md#54-export-a-figure))
4. **Data** (Cmd/Ctrl+Shift+E) exports read names, tables, BED files and the
   session file, grouped by topic; in your own tab also a BAM of chosen reads.
   ([55](guide.md#55-export-data))
5. **Tutorial** lists every step of the tour; click one to start there.
   ([56](guide.md#56-the-tutorial-panel))
6. Its **Copilot** tab (optional, runs on your computer; not in
   FiberBrowser.app) answers questions such as "how do I cluster the reads?" by
   pointing at the controls, like the tour. See [Local Copilot](copilot.md).
   ([57](guide.md#57-copilot))
7. At the end, **Keep exploring** leaves the tour tab as it is, and **Close
   this tab** ends it. To shut FiberBrowser down, use **⋮ → Quit FiberBrowser**
   in your own tab. ([58](guide.md#58-thats-the-tour))

## 12. Your own data

In your own tab, **Open** a BAM or BigBed with footprint calls from
[FiberHMM](https://github.com/fiberseq/FiberHMM), or start with them:

```bash
fiberbrowser -b sample.bam -g genes.gtf -f genome.fa
```

FiberBrowser picks a reference that matches your data's chromosome names (or
your last one); choose another under **Reference & Tracks**. Then repeat the
steps above: scan peaks, select the ones you care about, cluster, save
footprints, and compare datasets side by side. The display shows a sample of
the reads for speed, while clustering and the analyses use every eligible read
unless you set **Analysis cap** (sidebar → **Analysis & Reproducibility**).

From raw reads, **Process raw data** (the arrow beside **Open**) runs a DAF-seq
or Nanopore POD5 run from the app; see
[A DAF-seq run, from raw reads](workflows/daf-seq-quick-run.md). Files that stay
on a cluster open with **Connect to cluster…**
([Data on a cluster](workflows/remote-cluster-data.md)). For more, see
[Beyond the tour](guide.md#beyond-the-tour) in the guide, the
[reference](reference.md), and the [Jupyter / Python API](jupyter-api.md).
