# What 3.1 includes: supported and Preview features

[← Documentation](index.md)

FiberBrowser 3.1 has two kinds of features: **supported** ones, and **Preview** ones controlled by the preview setting.
Live lift and graph mode are labelled Preview features: they carry the **Preview** badge but are always on (below).

## Supported

Supported features are on in every build, and their results are meant to be used as they are.

- **Structural variants on reads**: size-aware deletions and insertions, the Differences row, hover cards, and **Split reads by
  this SV** or **Split into panels by this SV** (carriers, reference, not informative).
- **The insertion lens** (its own panel, **Insertion lens** on the rail): the chromatin inside a large insertion, with
  its carrier reads in insertion coordinates, the insert's consensus and per-group profiles. Open it from the reads'
  right-click menu (**Open insertion lens**) or from an insertion on the Differences row (**Open this insertion in the lens**).
- **Identify** (in the lens): candidate TE families and genome copies of the insert, with a to-scale cartoon and
  **Open the reference copies**. The D. melanogaster canonical TE set v10.2 is bundled in every build (CC0); for other
  species Identify downloads Dfam's curated families once. Results are *candidates*: each comes with its identity,
  its coverage of the insert and of the element, and the database and search tool it came from, and Identify can
  answer **Ambiguous** or **No confident match**. The thresholds are in [Identify](identify.md).
- **The Plots workspace** (**P**): metaprofiles, size enrichment, V-plots, size histograms, heatmaps over selected
  features or BED region sets, co-accessibility and summaries across groups, with the Gallery. See
  [Plots](workflows/plots.md). Its **Differential features** type and the full-window Feature hub workspace are
  experimental, behind **Settings › Read Display › Experimental: Feature hub workspace** (off by default).
- **The Nucleosomes panel** and **the Feature hub panel** with its scans. See [Nucleosomes](workflows/nucleosome-panel.md)
  and [Feature hub and scans](workflows/feature-hub.md).
- **The Variants panel** (its own panel, **Variants** on the rail): SNPs in the view (with strand, depth and, on DAF-seq data, deamination checks), the **Combinations** of their alleles,
  SVs, and splits of the reads by an allele, by a combination, by 2 to 4 SVs at once, or by SNPs and SVs together. Its
  combinations are **local read-supported allele patterns**: the reads in view grouped by the alleles they carry at the
  chosen sites. They are not a phasing. When two complementary patterns hold most of the reads, they are labelled
  **H1 / H2**, but these labels are local to these SNPs in this view. They don't name haplotypes shared with any other
  locus.

## Live lift and graph mode: labelled Preview features

Live lift, the Differences row, graph mode and haplotype pop-outs ship in 3.1 as Preview features: they work and are
tested, and their controls and limits may still change. They carry the **Preview** badge where you first meet them
(**Open ▾ → Add live lift…**, the **Add live lift** dialog, a lifted panel's live-lift chip, and the **Linear ⇄ Graph**
toggle of a panel in or near graph mode; hover the badge for the known limitations). They are on by default and
**Show preview features** does not hide them, like the footprint-class section. The standalone **Graph view** panel is a
switchable Preview panel. Graph mode needs the graph helper, built for
Apple silicon Macs for now. See [Setting up live lift and graph mode](workflows/pangenome-setup.md).

## Preview features

A Preview feature works and is tested, but its results need more validation before they can be used without care.
Preview features are **on by default**, and your saved choice is preserved. Control them with **Show preview features** (Settings → Reads & Display → Read Display), or
search for "preview" in the command palette (Cmd/Ctrl+K). The choice is kept on this computer
(`~/.fiberhmm/analysis_preferences.json`), on every port and in every build, but not in sessions.

With previews on, every way into a Preview feature has a small **Preview** badge: its rail tile, its menu items and
its panel. Each Preview feature also has a **Known limitations** note, which says what has to happen before it stops
being a Preview. With previews off, those ways in are hidden. A session that uses a Preview feature still opens
completely, with nothing dropped, and one line at the top offers to turn previews on.

### Insert-expanded (alt-allele) panels

**Open carriers with the insert expanded** (Differences row, lens) or **Show insert expanded** (a panel's ⋯ menu) re-aligns an
insertion's carriers onto its alternate allele: reference flank + insert consensus + reference flank. The reads
inside the insert can then be clustered, sorted, filtered and analysed like any region. The panel's **Preview ⓘ**
pill shows where its reads come from:

- **Which carriers it includes**: the carriers found at the site and how many were placed. Carriers that hold the
  whole insert are counted apart from partial ones: soft-clipped at the breakpoint (they place only the part of the
  insert they hold) and hard-clipped (they place only their flank).
- **Which it leaves out, and why**: sampling above the carrier cap (5,000 by default, taken evenly), reads with
  another insertion at the site, reads that don't span the breakpoint, and duplicates.
- **The coordinates**: which contig positions are the left flank, the insert and the right flank, and the reference
  stretch each flank stands for. Positions inside the insert have no reference coordinates, so the ruler shows them as
  insert positions.

The first build of an insertion re-aligns every carrier and takes about **25–40 s** for thousands of carriers. The
header shows how long it has run so far. The result is cached, so reopening it or restoring a session is quick.

### Footprint classes (Footprints panel)

The **Footprint classes** section of the Footprints panel (**Find classes**, from `fiberhmm-consensus`) carries a
**Preview** badge on its heading: the class discovery method, its parameters and outputs can still change. It is
labelled only: it stays available with previews off. The rest of the Footprints panel (footprints on reads, saved
classes, co-occupancy) is supported.

### Meta-locus

See [Meta-locus](workflows/meta-locus.md) for the workflow.


**Open BED as meta-locus…** (**Open ▾**, or the command palette) pools a BED file's sites, for example every promoter
at TSS ± 10 kb, into one virtual locus. A seeded working set of reads is drawn from the pool and shown on the meta
contig, where you browse, cluster and plot it like any locus. The bar above the reads shows how many reads of the pool
are on show, with **More reads**, **Resample** and the seed. In the cluster panel, **Keep workspace full** refills
clusters from the pool. Right-click a read for **Open this site** (its real locus; Back returns) or **Find more like
this**. Sessions save the pool, seed and refilled reads; links and reloads keep the pool and seed. The dialog, the Open menu item and the bar carry the
**Preview** badge.

Known limitations:

- Rows and panels that need one real genome position are left out on the meta contig: reference sequence, genes,
  motifs and other external tracks, primers, Micro-C, the Differences row and the Variants panel, graph view, the insertion lens
  and the feature hub. Autozoom and **Best-covered window** are too. Metaprofiles, clustering, Plots and Read Stats
  work as on any locus. Exports add each read's real site, strand and span.
- A read that falls in several sites counts once per site (read-site observations) in the view, the pool totals and
  **Find more like this**.
- **Find classes** runs FiberHMM's pooled mode, which analyses each molecule at one site, so a shared read's other rows
  carry no class.
- Links and reloads rebuild the pool from the BED path, so the server must still be able to read that file. Its
  content is checked.

## NFRs and Synchronise regions

Every release includes the **NFRs** panel (variants, pairs, motifs and ChIP-Atlas
overlays) and **Synchronise regions** (oriented maps, matched-region groups,
pooled scans and co-clustering). Both are available independently of the preview
switch. Their saved analyses and session state restore across releases.
See [Motifs at NFR variants](lab/workflows/nfr-motifs.md).
