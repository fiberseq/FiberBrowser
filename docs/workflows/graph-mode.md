# Workflow: graph mode

[← Docs index](../index.md) · [← README](../../README.md)

Graph mode draws a dataset panel on a pangenome graph instead of one linear
reference. Each haplotype (or assembly) in the graph is a lane, and the reads
are drawn along the lane they come from. Insertions, deletions and
rearrangements that a linear reference hides are drawn where they are.

Graph mode is a way of viewing a panel, not a separate workspace. A panel in
graph mode keeps its name, colour, filters, selections and clusters, and you
can switch it back to linear at any time. The other haplotypes of the dataset
are panels of their own: they are folded into the graph, and you can pop any of
them out to see it side by side, with all the usual read tools.

![A lifted dataset in graph mode: the reference and two haplotype lanes, with each haplotype's reads under its own lane](../images/graph/graph-mode-host.png)

## What you need

Setting up is described in
[Setting up live lift and graph mode](pangenome-setup.md). In short:

- **The graph helper.** The macOS app includes it; with pip, install
  `fiberbrowser[graph]`, or build `fiberbrowser-graph` from
  [graphlift](https://github.com/mtcicero26/graphlift)
  ([details](pangenome-setup.md#installing-the-graph-helper)).
- **A graph package.** This is a prepared pangenome graph (for example an HPRC
  release cut to the contigs you work on), made with `fiberbrowser-graph
  prepare` from [graphlift](https://github.com/mtcicero26/graphlift).
  Packages are registered once, with **Open ▾ → Register graph package…** or
  in **Settings › Reads & Display › Graph mode** (**Graph packages**: enter the
  folder, **Register**; **Remove** forgets one), and are remembered
  ([details](pangenome-setup.md#registering-a-graph-package)). Neither needs
  preview features.
- **Reads that the graph knows.** Either of these works:
  - a **lifted dataset**: reads aligned to a sample's own assembly and viewed on
    the reference through a lift map (**Open → Add live lift…**; see
    [Live lift](live-lift.md)). Each haplotype's reads are drawn on that
    haplotype's lane;
  - a **native dataset**: reads aligned to the reference the graph is built on.
    Its reads are drawn on the reference lane.

FiberBrowser checks that a dataset really belongs to a graph path by the path's
identity (sample, haplotype and contig, with its size), not by its name. A
dataset that does not match is never drawn on the graph, and the menu item says
why.

## Opening a dataset in graph mode

- **New lifted datasets open in graph mode** when a registered package binds
  them. In **Add live lift…**, **Open as** is set to **Graph**; choose
  **One panel per haplotype** or **Pooled** to open it the old way. The first
  haplotype's panel shows the graph; the other haplotypes are folded into it.
  **Open as** starts from **Settings › Reads & Display › Graph mode › Open
  lifted datasets as** (**Graph (default)**, **Split panels**, **Pooled
  panel**).
- **A dataset with one haplotype** (a strain against its reference, for
  example) opens in graph mode on its one panel.
- **Any bound panel** can be switched with the **Linear ⇄ Graph** pill in its
  header, or with **View as graph** / **View as linear** in its **…** menu. The
  switch is one undo step.
- **Native BAMs open linear** unless you tick **Open in graph mode** in **Load
  by path**, or turn on **Open native BAMs in graph mode** in Settings (Open
  file, drag and drop and Load by path then follow it). A BAM whose contig no
  package binds stays linear. Switch any panel later, or add it to a graph
  (below).
- **A restored session** keeps its split panels as saved. When graph is your
  default view, the first panel shows *A graph package binds this dataset; its
  haplotype panels can be viewed together on its paths.* with **View as graph**
  and **×**. The same bar appears when a package binds a dataset after you have
  changed its panels. Once you use or dismiss it, it doesn't come back until
  the next session restore.

## Reading the view

- **Lanes.** The top lane is the reference; the others are haplotypes, in the
  package's colours. Sequence a haplotype carries that the reference lacks is
  drawn as a branch with its size (for example **+2,350 bp** for an insertion).
- **Bands.** Under each lane there is one band per panel drawn there. A band is
  labelled with its panel's name and its read count, with that panel's colour
  down the left edge. A dataset with one haplotype is labelled by its path name
  (header **Graph · strainA#0**, band *strainA#0*).
- **Rows.** The bands share the panel's height ("Rows fill the panel height" in
  the panel's **Reads** menu, the default). Choose **At most 20 / 40 / 100 rows
  per band** to fix the count instead.
- **When not every read fits.** A band that draws fewer reads than it has gets
  a density strip above its rows: coverage (grey), then the share of reads that
  are accessible and the share that have a nucleosome, at each position. Its
  label says how many molecules are drawn out of how many, and whether they were
  sampled, for example *PAT · 140 of 1,240 molecules · sampled 1/8 by name · 38
  rows*.

![Bands at a fixed row count: each band's density strip and its count of molecules drawn](../images/graph/graph-mode-strips.png)

- **The status line** under the graph says what was drawn and what was left
  out (rows past the limit, reads sampled out, reads off the shown paths).

## Comparing panels side by side

The graph is a set of panels drawn together. Every band is a real panel, and
you can take any of them out to look at it on its own.

- **Pop out** a haplotype: in the header's **…** menu, **Pop out PAT** (one
  item per haplotype folded into the graph). When more than one path can pop
  out, the menu also has **Pop out all haplotypes in view** and **Pop out
  paths…** (a checklist: **Pop out N** pops out the ticked paths in one undo
  step). The haplotype opens as its
  own panel next to the graph, with its own read tracks and tools. It keeps the
  state it had in the graph (filters, selections, clusters).
- **Pop out as: lifted panel** (the default), **source view** or **lifted and
  source** chooses what a pop-out opens: the lifted haplotype panel, its
  [source view](linked-panels.md) on the sample's own assembly, or both. Native
  panels always pop out as panels. The choice is saved with the panel.
- **Fold it back** with **Fold into graph** in its menu. Its state is kept.
- **Add another panel** to the graph with **Add ‹dataset› to this graph** in
  the **…** menu (or **Add panels to this graph…** in the graph's right-click
  menu); from the other panel, **Join ‹dataset› graph**. For example the same
  sample aligned to the reference, or a second sample. Its reads are drawn in
  their own band on the lanes they belong to. **Remove from graph** takes it
  out again.

![The header menu of a panel in graph mode, with a native panel of the same sample beside it](../images/graph/graph-mode-menu.png)

![The native panel added to the graph: its reads on the reference lane, the haplotypes' reads on theirs](../images/graph/graph-mode-joined.png)

![A haplotype popped out beside the graph, as an ordinary panel](../images/graph/graph-mode-popout.png)

Selections are shared: a read you Shift-click in the graph is selected in its
panel, and a read you select in a popped-out panel is outlined in the graph.
Hovering a read outlines the same molecule everywhere it is drawn.

## Read tools in graph mode

On every band: **Select** (Shift-click), **Highlight**, the read menu
(right-click: **Keep only selected**, **Exclude selected**, **Copy name**,
**Pop out**), and the panel's own filters, orders and clusters, which each band
applies as its panel does. DAF-seq panels that show one strand (CT or GA) show
only that strand's reads in their band too. Soft-clipped read ends are marked
as in the read tracks (a bar with a tick toward the clipped sequence), with the
same **SV display** switch and minimum length. Rows with no sort or clusters
are ordered **By first carried column** (the first graph position each read
covers); **Rows without a sort or clusters** in the graph's right-click menu
switches to **Longest first**.

The toolbar's **Sort** and **Filter** run on every panel in view, lifted or
native, including the haplotypes folded into a graph: each band takes its
panel's order or filter, and a popped-out haplotype shows the same one. They
are worked out on the reference's coordinates, so sequence that only a
haplotype carries (an insertion) does not count towards a footprint or
accessibility rule. A haplotype panel (MAT or PAT) is sorted on its own reads.

For a site on the graph, right-click a read and choose **Sort by this graph
column** (footprint size or accessibility), or **Sort by rule at this column**.
This uses the reads on the paths that carry that node column, including inserted
sequence. Rules that need reference annotations are disabled here. Uncovered
sites sort after measured values. A site shared with the target keeps its order
in linear view. A carrier-only site uses cluster order in linear view, with a
notice; returning to the graph restores its site order.

![A read's graph-column sort menu, including sites in inserted sequence](../images/graph/graph-mode-site-sort.png)

The toolbar's **Layers** switches also control scan state groups such as classes
and NFR variants, custom annotation layers, 5mC and deamination marks on graph
rows. Calls keep their original sizes, annotation names and quality bytes when
split across nodes or coverage holes. Native scan-table layers refresh when the
bound scan changes.

### Clustering

With a panel drawing its graph, **Cluster** clusters on the graph itself.
The toolbar button says so ("Cluster at 4 regions on graph columns").

1. Choose the regions: select peaks as usual, or draw one directly on the graph
   with **Alt/Option-drag**. With a panel drawing its graph, **Scan** finds
   peaks on the graph itself: each haplotype's reads count on their own path,
   pooled where the haplotypes share the graph, so a peak is one peak for every
   band. A peak inside sequence the reference lacks (an insertion) is listed as
   a region around the insertion, named in the peak list; clustering there uses
   the inserted sequence.
2. Click **Cluster**.

Each haplotype (and each native dataset) is fitted once, so every band of the
same haplotype gets the same labels, and popping a haplotype out or folding it
back never changes them. Bands are grouped by cluster, and each band's label
lists its counts per cluster (*C0 24 · C1 3*).

![Clustered on graph columns: bands grouped by cluster, with counts per cluster](../images/graph/graph-mode-cluster.png)

Sequence that only some haplotypes carry (an insertion, for example) is used to
split clusters further among the haplotypes that carry it. Those clusters are
named **C0.1**, **C1.0** and so on; the other reads keep their labels. When
the regions hold only such sequence (no part every haplotype shares), the
haplotypes that carry its first part are clustered. The reads of a haplotype
that carries none of it are labelled **Not a carrier**, in a colour of their
own, but only when that is certain: the haplotype's sequence there is not
repeated or unresolved, it carries no smaller part that was too short to
cluster, and the read covers every region on its own path. Otherwise the
haplotype is left out, and the run details say why. A haplotype that carries
only another part is left out too: choose its region alone to cluster it. A
haplotype that lacks every region (a plain deletion on its path) is not
clustered there: its reads that span every deletion are labelled **Not a
carrier**. A molecule clustered on another path keeps that label, and reads
labelled as you pan can replace **Not a carrier**. The **Clusters** panel
lists what was used and what was left out (*Not a carrier (shown, not
fitted)*).

![A deletion on one haplotype: PAT lacks 89 bp of the reference, so its reads are labelled Not a carrier and MAT's are clustered](../images/graph/graph-mode-not-a-carrier.png)

An open source view of a haplotype in the run takes the run's labels by read
name (its own strand), follows selections and gets labels for new reads as you
pan. Each visible source view also has its own column in the cluster charts;
opening one does not add an observation to the fit.

The graph menu's **Graph run options** chooses **Exclude repeat columns**
(default) or **Repeat columns by occurrence**, and **Refine within carriers**
(default) or **Drop carrier-only features**. Occurrence mode distinguishes each
visit by its stable graph identity; it does not pair copies on different paths
by their order. These options are saved with the host and snapshotted in each
run. After clustering, **Graph regions and carriers…** lists the run's parts,
their carriers and any dropped parts.

A cluster run stays while you pan and zoom on the same chromosome: new reads
that come into view are given labels from the same run.

### Exports and Read Stats

- **Read names** (Export data → Reads) are written as plain read names for
  every band.
- **BAM subset** writes the reads' records with every tag. For a lifted
  dataset, the records come from the sample's own assembly (the BAM you
  opened), on its contigs; the export says which.
- **Read Stats** and the **read table** describe lifted reads too. Footprints,
  accessibility and modifications are counted on the reference, as the reads
  are drawn; MAPQ, NM, length and CIGAR come from each read's own record, and
  its start and end are on the sample's own assembly (the read table's
  `ref_contig` column names that contig).

## Zooming out

The graph is drawn up to 50 kb wide. Past that the panel switches to its linear
tracks, and the folded haplotypes open beside it, so you still see them side by
side. A bar under the header says *Linear · graph resumes below 40.0 kb*. Zoom
back in to 40 kb or less and the graph returns, with the haplotypes folded
again (unless you moved one of them yourself). **Scan** works on the linear tracks too:
a lifted dataset's peaks are found on the reference, every haplotype's reads
pooled, as the graph scan pools them where the haplotypes share the reference.

The panel also switches to linear when more than half of the window has no
resolved place in the graph (for example a region the graph could not build at
this width), and comes back when less than 30% is unresolved. The bar then says
*Linear · most of this window is unresolved in the graph*.

If the helper or registered package is unavailable, a dataset host also shows
linear tracks with an explanation. It returns to graph mode when the helper
and package are available again.

![Past 50 kb: the panel is linear and the haplotypes are beside it](../images/graph/graph-mode-handoff.png)

- **Stay linear** (on the bar, or in the graph's right-click menu) keeps the
  panel linear until **Resume graph** (the bar then says *Linear · graph mode
  paused*).
- **Linear above …** in the graph's menu sets the widths (**Above 50.0 kb
  (graph again at 40.0 kb)**, **Above 30.0 kb**, **Above 20.0 kb**) and **Also
  where most of the window is unresolved**. **Settings › Reads & Display ›
  Graph mode** takes any pair from 10 to 50 kb (**Linear when wider than**,
  **Graph again at or below**) and **Complexity hand-off**. These apply in this
  browser, to every panel.
- **Linear view of a host** in the same settings chooses **Reveal members**
  (default) or **Host only**. Host only keeps folded members hidden during the
  hand-off and when choosing **View as linear**. Panels you popped out stay visible.
- Switching between graph and linear fades over 150 ms (not with reduced
  motion). After a graph run, a panel drawn linear lists the inserted sequence
  the run used as *Not drawn in linear view: …*.

## Speed and memory

How many reads are drawn follows the **Performance mode** setting (Settings):

| Profile | Molecules per view | Decoded reads in memory |
|---|---|---|
| Low memory | 1,000 | 8 MB |
| Standard and High performance | 4,000 | 32 MB |

The molecules are shared between the bands (at least 50 each). When a view
holds more, each band is sampled by read name, so the same reads are drawn every
time you come back; the band's label and the status line say so. With long
fiber-seq reads the memory limit usually applies first: a band then shows a few
hundred molecules and its density strip.

For native BAM caching, performance profiles and navigation history, see
[Navigation and speed](navigation-speed.md).

## Sessions

Graph mode, the folded and popped-out panels, **Stay linear**, the pop-out
kind and the cluster run are saved with sessions and the undo history. The
hand-off widths and host-only preference are kept in this browser, not in
sessions. Graph run options and graph-site sort provenance travel with the
panels. A dataset host restored without its graph package falls back to linear.

## Troubleshooting

| Symptom | What to check |
|---|---|
| **View as graph** is greyed out | Its tooltip says why: no package is registered, or no package path matches the dataset (sample, haplotype, contig and size). |
| A band is missing | The panel is not on this graph's paths, or it was removed from the graph. Check **Add ‹dataset› to this graph**. |
| A native BAM opened linear | **Open native BAMs in graph mode** is off, or no package binds its contig; switch it with **Linear ⇄ Graph**. |
| The panel keeps showing linear | The view is wider than the hand-off width, **Stay linear** is on, or most of the window is unresolved; the bar under the header says which. |
| Sort or Filter does nothing on a band | Toolbar rules count reference positions. For an inserted site, right-click a read and use **Sort by this graph column** or **Sort by rule at this column**. |
| Fewer reads than in the linear view | The band is sampled or past its rows: its label and the status line give the counts. Choose a higher **Performance mode**, or fix a row count in the **Reads** menu. |

See also [Haplotype comparison](haplotype-comparison.md) for comparing two
haplotypes of a phased reference without a graph, and
[Clustering](clustering-and-transcription-states.md) for peaks and cluster
runs.
