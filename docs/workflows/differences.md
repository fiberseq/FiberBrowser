# Workflow: the Differences row and inspector

[← Docs index](../index.md) · [← README](../../README.md)

The **Differences** row sits above a panel's reads. It marks where the reads,
or the sample's assembly, differ from the genome you are browsing: insertions,
deletions, substitutions and rearrangements. From the row you can open an
insertion in place, highlight the reads that carry a difference, and inspect
it read by read.

What the row shows depends on the panel:

- **A BAM aligned to this genome:** the structural variants found in the reads
  (insertions and deletions of 50 bp or more), as in FiberBrowser 3.0's SV row.
  See [Structural variants](structural-variants.md) for how carriers are
  counted.
- **A lifted dataset** ([live lift](live-lift.md)): where each haplotype of
  the sample's assembly differs from this genome, read from the lift map, and,
  if you turn them on, the edits the reads themselves support.

![The Differences row of a pooled lifted panel: one lane per haplotype](../images/pangenome/differences-row.png)

## Reading the row on a lifted panel

- **Lanes.** A panel split by haplotype has one lane, its own. A pooled panel
  has one lane per haplotype (**MAT**, **PAT**), and a **Reads** lane when
  **Read-supported edits** is on. Marks are drawn in the lane's colour.
- **Marks.** An insertion is a wedge, a deletion a bracket, and other
  differences (substitutions, inversions, stretches with no counterpart) a
  block. Zoomed out, the row shows density bars instead; its status says
  *Density; zoom for individual differences*.
- **◀ ▶** jump to the previous or next difference outside the view, on the
  same chromosome.
- **Hover** a mark for what it is: the haplotype, kind and size, its position
  on this genome and on the sample's assembly, the bases on each, and the
  reason (for example *an indel between the assemblies*).

## Clicking

The same clicks work on the Differences row, on a lifted read's insertion tick
(when **Insertions on reads** shows them), and on the row of a BAM aligned to
this genome.

| Action | What it does |
|---|---|
| **Click** an insertion | Expands it in place (see below). Click it again to collapse it. |
| **Click** any other difference | Highlights the reads that carry it: on a lifted dataset, its haplotype's carriers in that dataset's panels. |
| **Shift-click** | Selects the difference: an amber dashed guide line runs through every panel at it. |
| **⌘-click** (Ctrl-click on Windows and Linux) | Opens the inspector. |
| **Right-click** | Opens the row's menu; its first item is **Inspect…**. |

On the keyboard, Tab to a mark of a lifted panel's row and press Enter to
inspect it. On a native BAM's row the arrow keys move between variants, Enter
highlights the reads and `i` inspects. Escape closes the inspector.

## Expanding an insertion

A plain click on an insertion of 50 bp to 50 kb opens a column at that position
holding the inserted bases. Each read of the panel you clicked in that carries
the insertion shows its inserted sequence there, with its m6A, accessibility
and footprints, at the same scale as the rest of the view. Reads that don't
carry it show a gap.

![An insertion expanded in place: MAT and PAT carriers share one column](../images/pangenome/differences-expanded.png)

- **Every panel shares the column**, so a native panel and the MAT and PAT
  panels stay aligned. The genome coordinates on either side don't change; the
  ruler shades the column and labels it.
- **Native panels.** An insertion expanded from a lifted panel opens the
  column in a native panel too, but its reads' inserted bases are not filled
  in until you click **Associate native layout** on the column's bar (and
  **Unlink native layout** to undo it). Until then the native reads show a
  gap whether or not they carry the insertion. Associating matches the native
  reads' insertions to this column by position and length only; it does not
  prove they are the same allele.
- **Matching insertions share one column.** When MAT and PAT both carry an
  insertion at the same place with lengths within 10% (or 3 bp) of each other,
  one column holds both, as wide as the longer one. The label gives both sizes
  (*MAT +2.4 kb · PAT +2.3 kb*). A carrier of the shorter allele ends with a
  dashed grey tail: its calls are never stretched to fit.
- **An insertion only one haplotype carries** opens on that haplotype's reads;
  the other haplotype's reads show a gap.
- **The bar at the top of the column** has **×** (collapse), **Associate
  native layout** (above), **Identify** (what the inserted sequence is) and,
  for an assembly insertion, **Open in HG002 view** (named after the sample in
  the lift map; *Open in source assembly view* when the map names no single
  sample): a panel of the sample's own assembly anchored at the insertion. That panel follows the main view only
  near the insertion and has no ribbon; for a fully linked view use **Open MAT
  source view** (see [Linked panels](linked-panels.md)).

Insertions shorter than 50 bp or longer than 50 kb can't be expanded; the row
says why. They can still be inspected.

## The right-click menu

Right-click a mark for its actions, then the row's own options.

**On a difference** (headed with its haplotype, kind and size):

| Item | What it does |
|---|---|
| **Inspect…** | Opens the inspector. |
| **Expand insertion** / **Collapse insertion** | As a plain click, on insertions. |
| **Highlight carrier reads** | As a plain click, on other differences. |
| **Split by carrier…** | Opens the inspector, where the reads are split into carriers and non-carriers. |
| **Show in the source view** | Moves the linked source view to this difference. Without one, it opens a panel of the sample's assembly anchored at the difference (no ribbon, no linked navigation). |
| **Copy sequence** | Copies the inserted or alternative bases. |

**The row's options** (under **Differences row**):

| Item | What it does |
|---|---|
| **Assembly differences (the map)** | The haplotype lanes (on by default). |
| **Read-supported edits** | The **Reads** lane: insertions, deletions and replacements found in the loaded reads, compared with the assembly (off by default; see [Assembly comparison](#assembly-comparison)). |
| **Minimum size** | All sizes, ≥10 bp, ≥50 bp or ≥1000 bp. |
| **Show the table** / **Hide the table** | The difference table, below. |
| **Insertions on reads** | Off (the default), Ticks or Ticks with size: marks on the reads themselves (also the **Insertions** control in the toolbar's Layers row). |
| **Live-lift settings…** | The dataset's settings. |

![The Differences row's right-click menu](../images/pangenome/differences-menu.png)

On a BAM aligned to this genome the menu also has the structural-variant
actions: group or split the reads by the SV, highlight carriers by evidence
level, and open the insertion in the lens. See
[Structural variants](structural-variants.md#the-differences-row-on-a-native-bam).

## The table

**Show the table** lists the differences in view below the row: where each
comes from (haplotype or reads), its interval on this genome, the change
(reference → alternative size), its sequence or support, its **Assembly
comparison** (below), and an **Inspect** button. It opens just below the row,
over the reads, and scrolls; **×** or **Hide the table** closes it.

![The difference table under the row](../images/pangenome/differences-table.png)

## The inspector

The inspector opens beside the reads (⌘-click, or **Inspect…**). For a
difference on a lifted panel it shows:

- **The difference:** its haplotype, kind and size, its place on both
  assemblies, and the bases on each.
- **Buttons:** **Expand insertion** (or **Expand alternate**), **Identify** and
  **Open in HG002 view**.
- **Assembly comparison:** the difference's label and links (see
  [Assembly comparison](#assembly-comparison)).
- **Molecule calls:** click **Load molecule calls** to sort the reads into
  carriers, reference and not informative. Tick **putative**, **conflicting**,
  **ambiguous** or **duplicates** to count those reads as carriers too (only
  putative is ticked at first; see
  [Structural variants](structural-variants.md#evidence-levels)). **Lifted
  reads** uses the lifted panel's reads; **Combined representations** adds an
  open native dataset of the same molecules. **Allele target** chooses what a
  carrier must carry: **Geometry (any sequence)**, or, for an assembly allele
  up to about 1 kb, **Exact assembly allele** (the reads' bases must match the
  assembly's). Then **Highlight carriers**, **Split by carrier**, **Compare
  consensus with assembly**, or **Open detailed workspace** (the insertion
  lens, below).
- **Per haplotype:** how many reads of each haplotype carry the sample's
  allele and how many the reference allele. Reads of a haplotype that show the
  reference allele are flagged as possible mis-phasing or mismapping.
- **The read table:** each read's name, haplotype and strand, its allele, its
  own bases next to the two assemblies' bases (the columns are named after the
  map's sample and reference, for example *HG002* and *GRCh38*), and the
  chromatin nearby. Hover a row to highlight that read.

The read table loads by itself when the panel has up to 2,000 reads in view.
With more, the inspector says so and offers **Load observed bases and
chromatin**.

![The inspector for an insertion, with molecule calls and the read table](../images/pangenome/differences-inspector.png)

For a structural variant on a BAM aligned to this genome, the inspector
(*Inspect difference*) shows each read's observed bases, coverage and
chromatin, with **Expand alternate**, **Load full observed sequence** and
**Identify observed alternate**. When a lifted dataset on this genome is open,
it also compares the variant with that dataset's assembly (below); without one
it says **Reads only (no assembly)**.

## Assembly comparison

When the reads and a sample's assembly both have a difference, FiberBrowser
says whether they agree. A read difference (from **Read-supported edits**, or
a structural variant on a native BAM) gets one of these labels:

| Label | Meaning |
|---|---|
| ✓ **Confirmed by assembly** | The assembly has exactly the same change: the changed haplotypes are equal. |
| ≈ **assembly-supported (approximate)** | The reads' allele and the assembly's align with at least 90% identity. |
| ? **Assembly candidate (geometry only)** | The assembly has a difference of the same shape there, but the sequences were not compared. |
| **Not in the compared assembly haplotypes** | The assembly has no such difference. |
| **Assembly comparison unassessed** | It could not be decided (for example, sequence is missing). |

Differences under 10 bp are not assessed. A read deletion can be confirmed
from its span alone; a read insertion needs its sequence: click **Compare
consensus with assembly** in the inspector (after **Load molecule calls**),
which builds the reads' consensus and compares it. An assembly insertion's own
sequence needs the **Source assembly FASTA** given when the lifted dataset was
added.

The label shows as a mark (✓, ≈, ?) beside the read difference in the
**Reads** lane, in its tooltip, in the table's **Assembly comparison** column
and at the top of the inspector, with each haplotype's link (for example
*MAT: exact (full changed haplotypes equal)* or *PAT: approximate · identity
99.5%*). The newest comparison is used everywhere.

![Read-supported edits: the Reads lane under the haplotype lanes, and the table's Assembly comparison column](../images/pangenome/differences-comparison.png)

![A read-supported insertion compared with the assembly through the reads' consensus: assembly-supported (approximate)](../images/pangenome/differences-comparison-inspector.png)

![The native BAM's inspector for the same insertion, compared with the open lifted dataset's assembly: Confirmed by assembly](../images/pangenome/differences-native-inspector.png)

## The insertion lens

The insertion lens draws the carriers of one insertion in the insertion's own
coordinates (left flank, insert, right flank), with group profiles and the
insert's consensus. Open it with:

- **Open detailed workspace** in the inspector, after loading molecule calls;
- **Open this insertion in the lens** in the right-click menu of an insertion
  on a native BAM's row;
- **Open insertion lens** in the read menu.

Its tabs are **Lens**, **Identify** and **Insertions in view**. Reads that are
not confirmed carriers are hatched; **Include putative**, **Include
conflicting** and **Include ambiguous** choose which ones are drawn.

![The insertion lens](../images/pangenome/differences-lens.png)

## Settings

On a lifted panel, **Live-lift settings… → Differences row** holds the row's
options (they are also in its right-click menu):

| Setting | Default |
|---|---|
| Assembly differences (the map) | on |
| Read-supported edits | off |
| Minimum size | All sizes |
| Insertions on reads | Off |
| Read analysis MAPQ ≥ | 0 (no MAPQ filter) |

**Save** applies them to every panel of the dataset. **Insertions on reads**
and **Read analysis MAPQ ≥** apply to the whole session.
