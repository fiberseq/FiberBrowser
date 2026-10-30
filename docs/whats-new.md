# What's new since 3.0.1

[← Docs index](index.md) · [Changelog](../CHANGELOG.md#unreleased)

These changes are in the upcoming release. Start with your usual BAM and
reference. Live lift needs a lift map; graph mode also needs a graph helper
and a registered package. See [Setting up](workflows/pangenome-setup.md).

![The neutral demo in graph mode beside its reference-aligned reads](images/whats-new/graph-hero.png)

## Live lift and Differences

**Open ▾ → Add live lift…** draws reads aligned to a sample's own assembly on
the genome you are browsing. Choose **Graph**, **One panel per haplotype** or
**Pooled**. Graph is the default when a registered package binds the data.
Open a linked source view to follow the same molecules on their own assembly.

The **Differences** row shows assembly differences and read evidence. Click an
insertion to expand its bases across the panels. Cmd/Ctrl-click, or
right-click → **Inspect…**, opens its evidence. The inspector can compare the
read consensus with a supplied source assembly. **Identify** reports candidate
sequence matches with their support.

Read [Live lift](workflows/live-lift.md), [Linked panels](workflows/linked-panels.md),
[Differences](workflows/differences.md) and [Structural variants](workflows/structural-variants.md).

## Graph mode

View haplotypes on separate graph lanes. Pop them out as lifted panels, source
views or both, then fold them back. Add other datasets as separate read bands.
Scan peaks and cluster on graph columns, including inserted sequence.

Right-click a read to sort at a graph site. Choose how repeats enter a cluster
run. Scan groups, custom layers, 5mC and deamination marks draw on graph rows.
**Linear view of a host → Host only** keeps folded members hidden during the
linear hand-off. Read [Graph mode](workflows/graph-mode.md).

## Feature hub and scans

The **Hub** panel brings classes, NFRs, nucleosome patches, peaks, SNPs, SVs,
Differences and graph bubbles into one list. Compare values by dataset or
haplotype. Browse a region, a whole scan or scan files across the genome with
page controls. Selection stays when you change pages.

**Scan…** runs selected modules on view units, a BED file or genes.
**Open scan…** loads an existing scan. Lifted hits keep their source positions
and show which graph paths carry them. **Use as** turns selected hits into
anchors, cluster regions, filters, splits, highlights or saved regions.

**Associate** tests co-occurrence, conditional responses, within-molecule rates
or overlap and distance. Results say when the data cannot answer the question.
**Overlay** aligns many loci and shows marked and measured molecules per panel
or graph path. Read [Feature hub and scans](workflows/feature-hub.md).

![The hub Overlay tab with one profile and measured counts per observation](images/whats-new/hub-hero.png)

Genome-wide `fp` scans are slow: about 154 hours on four workers at 30×. Use
regions, or `nuc`, `nfr` and `peaks` for genome-wide work. Pooled live-lift
scans need complete records and refuse incomplete evidence. Staged and oriented
class workflows still use the legacy engine. M4 group contrasts are
conservative and can miss differences.

## Nucleosomes

Open **Nuc** and choose **Compute in view**. Compare footprint size classes,
repeat lengths, regularity, array segments and events across panels and graph
paths. **Window** adds anchor phasing and a background-based dephasing readout.
Click bars or bins to highlight their molecules. Use the layers and metrics
in filters, sorts, clustering, Read Stats and exports.

Named size classes need absolute calibration. Without it, the panel reports
coarse classes and density-matched z. Read [Nucleosomes](workflows/nucleosome-panel.md).

## Sessions, updates and navigation

Sessions from 3.0.x keep their saved analyses and curation. Their classes,
NFRs and peaks also appear in the hub. New sessions keep association runs,
overlay results and small embedded browser scans. Read
[Opening sessions from 3.0.x](workflows/session-migration.md).

Packaged apps offer **Install and restart** when a verified update is
available. The app saves the session before restarting. Manual download and
pip updates remain available. Read [Updates](updates.md).

Native and lifted views reuse more decoded reads while panning. Back and
Forward follow locus jumps in linked and per-panel views. Graph pop-outs keep
cluster labels for folded and supplementary records. Split, focus, delete and
merge actions take one undo step. Read [Navigation and speed](workflows/navigation-speed.md).
