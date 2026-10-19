# Live-lift differences and insertion expansion

All coordinates are zero based, half open. All endpoints require
`FIBERBROWSER_LIVE_LIFT=1` and are unavailable in public mode. `dataset_id`
must identify a `bam_livelift` dataset. `lift_hap` optionally selects a
configured haplotype key or its case-insensitive label (`MAT`, `PAT`). The
dataset capability is `differences`.

## Assembly strip

`GET /api/lift/differences?dataset_id=...&chrom=chr3&start=128650000&end=128670000&lift_hap=MAT&min_bp=0&detail_bp=250000`

```ts
type Difference = {
  id: string;
  hap: string;
  hap_label: string;
  kind: 'snv' | 'mnv' | 'aligned_bubble' | 'insertion' | 'deletion'
      | 'replacement' | 'inversion' | 'no_correspondence';
  reason: string;
  source: 'assembly';
  t_start: number;
  t_end: number;
  ref_bp: number;
  alt_bp: number;
  chain: number | null;
  strand: '+' | '-' | null;
  src: {contig: string | null; start: number | null; end: number | null};
  grch38: string | null;
  alt: string | null;
  aliases?: string[];
  ref_truncated?: boolean; alt_truncated?: boolean;
  ref_sequence_status?: 'available' | 'partial' | 'unavailable';
  alt_sequence_status?: 'available' | 'partial' | 'unavailable';
  // Present only for insertion/deletion; native SV schema.
  t?: 'I' | 'D';
  ref?: number;
  len?: number;
  read_support?: {cluster: number; carriers: number};
  read_candidates?: {cluster: number; carriers: number; relation: 'candidate'; method: 'geometry_only';
    sequence_comparison: 'unassessed'; assembly_span: EditSpan; read_span: EditSpan; uncertainty: [number, number]}[];
};
type EditSpan = {start: number; end: number; ref_bp: number; alt_bp: number};
type DifferenceBin = {
  start: number; end: number;
  hap: string; hap_label: string; kind: Difference['kind'];
  count: number; bp: number; ref_bp: number; alt_bp: number;
};
type DifferencesResponse = {
  dataset_id: string; lift_key: string;
  chrom: string; start: number; end: number;
  mode: 'items' | 'bins';
  items: Difference[];
  bin_bp: number | null;
  bins: DifferenceBin[];
  novel: ReadCluster[];
  native_summary?: {
    dataset_id: string;
    min_len: number; scope: string;
    clusters: ReadCluster[];
    // Existing display SV summary fields when available:
    margin?: number; n_reads?: number;
    clips?: {side: 'L' | 'R'; ref: number; n: number}[];
  };
};
type ReadCluster = {
  id?: string; t: 'I' | 'D'; ref: number; len: number; end: number;
  source: 'reads'; support?: number; informative?: number;
  sa_support?: number; clip_support?: number;
  novelty?: 'unassessed'; novelty_reasons?: string[];
};
```

`id` is `<hap_label>:<source contig>:<source start>-<source end>:<kind>`.
Source coordinates are forward even for inversions; allele strings are in
target display orientation. Insertions have `t_start == t_end`; deletions
have `alt_bp == 0`; replacements have both lengths positive. `reason` retains
the manifest gap reason. An `aligned_bubble` is approximate correspondence,
not a list of called variants. `no_correspondence` describes target sequence
outside the primary net coverage; it has null
source fields and uses target chromosome/start/end in its ID. Inversions
span the primary minus-strand net region.

Raw gaps also belong to the exact two primary net boundaries when both
flanks have the same winning chain and no intervening claim exists. Such
gaps retain their deletion/replacement kind, both spans and original reason;
their target span counts as correspondence. Other holes remain unresolved.
Recovered gaps expose the old target-coordinate hole ID in `aliases`;
inspection and sequence endpoints accept either ID.

`grch38` previews at most 60 target FASTA bases for SNVs, MNVs, deletions and
replacements; `ref_truncated` marks longer reference spans. It is empty for
insertions and null without the reference. `alt` uses the optional
`source_fasta`, otherwise null, except that a deletion's alternate is always
the known empty string. Alternate previews contain at most 60 bases in
target orientation; `alt_truncated` marks longer alleles. Per-side sequence
statuses describe these previews, and `sequence_status` is available only
when both sides are fully available; a known empty side cannot resolve a
missing sequence on the other side.
`GET /api/lift/difference_sequence` takes `dataset_id`, `chrom`, a position
inside the event (`pos`), `item_id`, `offset` (default 0), `limit` (1–50,000)
and `allele` (`alternate`, the default, or `reference`).
It returns `sequence`, `total` and `next_offset`; follow pages to retrieve the
full allele without unbounded reads or responses. Reference pages use the
loaded target FASTA in forward orientation; alternate pages use the source
FASTA in target orientation. An empty
allele is `""`, distinct from unknown/null. The strip never reads BAM records.
Its bounded geometry cache includes `lift_key`, chromosome, 1 Mb bin and hap.

Inspection resolves primary metadata independently of annotation caches, using
at most 32 SA point fetches; unsuccessful lookups are never globally cached.
`hg002` and `ins_id` describe the molecule's own parent. `alignment_hg002` and
`alignment_ins_id` retain the alignment-contig evidence. `carries_insertion`
reports observed carriage even on a cross-parent supplementary; this alone
does not establish the own-parent allele or qualify a carrier for Identify.
Read-only insertion inspection may omit `item_id`; returned rows carry resolved
IDs, and sequence selection prefers `lift_hap`. Full read sequence remains opt-in.

`min_bp` filters by `max(ref_bp, alt_bp)`. Views wider than `detail_bp`
return bins plus individual events of at least 1 kb. A bin counts each event
once at its leftmost visible position, on a chromosome-aligned `bin_bp`
grid; `bp` sums `max(ref_bp, alt_bp)`, and the other bp totals sum their
respective full event sizes. Large events occur in both bins and items.
Items retain full event extents/IDs when the viewport crosses their edges.

Optional `native_dataset_id` uses that native BAM dataset's existing display
SV summary for the same view, at a 50 bp floor. `native_summary` retains its
scope (including any display cohort cap). `read_support.cluster` is the
zero-based index into `native_summary.clusters`; `carriers` is its support
count. This legacy pointer names the first candidate. `read_candidates` keeps
all compatible clusters for every phased occurrence, preserving both spans
and anchor uncertainty. These are geometry candidates with unassessed
sequence comparison; their counts are not combined. Matching checks both
ends and independent lengths, including replacements. It considers events
hidden by binning or `min_bp` too. The legacy `novel` array contains unmatched
events with `novelty: 'unassessed'` and reasons such as `no_correspondence`,
`aligned_bubble` and `incomplete_assembly_comparison`. No assembly-relative
novelty is established by this matcher.

## Read inspection

`GET /api/lift/difference_reads?dataset_id=...&chrom=chr3&pos=...&end=...&lift_hap=MAT`

`end` defaults to `pos+1`. Explicit `end=pos` inspects all assembly insertions
at that boundary. Ordinary inspection spans and source insertion blocks are
limited to 50 kb (oversized query: 422; oversized insertion: 413).
Optional `item_id` identifies the canonical strip item. It, or `lift_hap`,
prioritises that haplotype's records; both parents are inspected against their
own source intervals so the other parent's agreement is summarised separately.

```ts
type Inspection = {
  id: string; molecule: string; hap_label: string; record: string;
  supplementary: boolean; strand: string | null;
  source_pos: {contig: string; start: number; end: number};
  read_bases: string; alignment_hg002?: string | null; hg002: string | null; grch38: string | null;
  allele: 'hg002' | 'same_as_grch38' | 'grch38' | 'other' | 'deleted' | 'no_coverage'
      | 'partial' | 'no_insertion' | 'unknown';
  chromatin: {
    state: 'nucleosome' | 'footprint' | 'accessible' | 'none';
    layer: string | null;
    nearest_m6a_bp: number | null;
    orientation: '+' | '-';
  };
  // Present for insertion inspection only:
  ins_id?: string; alignment_ins_id?: string; carries_insertion?: boolean; mol_bp?: number;
  identity?: number | null; read_bases_length?: number;
};
type DifferenceReadsResponse = {
  dataset_id: string; lift_key: string;
  chrom: string; pos: number; end: number;
  rows: Inspection[];
  summary: Record<string, Partial<Record<Inspection['allele'], number>>>;
  preferred_hap: string | null;
  capped: boolean;
  max_records: 500;
  hap_status: Record<string, string>;
  sequence: null | {sequence: string; read_id: string; record: string;
    ins_id: string; orientation: string; source: "reads"};
};
```

`read_bases` contains the record's actual aligned SEQ (including CIGAR
insertions inside the inspected source interval); `""` represents a deletion.
`hg002` comes from source FASTA when configured, otherwise SEQ/MD, including
MD reference bases at mismatches and deletions. Without either it is null.
All strings follow target display orientation. `hg002` allele means the read
matches its own haplotype's HG002 base and that base differs from GRCh38.
`same_as_grch38` means this haplotype has no difference and the read agrees.
`grch38` flags a read carrying the target allele when its own haplotype differs;
`unknown` means the haplotype allele could not be established; `other` is a known comparison that matches neither allele. Cross-parent supplementary alignments retain `alignment_hg002` separately; `hg002` follows the molecule’s haplotype.
`no_coverage` includes skipped source sequence rather than a CIGAR deletion.

`strand` is molecular `st`; it does not flip on a minus piece. Without `st` it
is null and the popover shows only the haplotype chip.
`chromatin.orientation` describes the display flip. Chromatin comes from
display rows, reusing only completely annotated caches and decoding the bounded cohort when records are missing; nearest m6A is an unsigned
distance at most 50 bp, otherwise null. Insertion inspection reports the
hidden block's state at its first covered display base. `carries_insertion`
requires the source alignment to span the full map gap with `mol_bp` within
10% or 50 bp of its length. The allele is `hg002` when this carriage matches
the molecule's own parent; cross-parent carriage stays `other` unless its bases
match that parent's inserted allele. `partial` describes alignments ending
inside the insertion, `deleted` a deletion across it, and `no_insertion` an
empty read span when the own-parent allele is also empty. Other lengths/bases
are `other`. A read-only CIGAR insertion can carry sequence at a zero-width
source boundary, independent of a map insertion. `mol_bp` measures
actual SEQ bases there. Insertion `read_bases` is truncated to 60 bases with
the full length in `read_bases_length`; `identity` is a best-effort percentage
against the assembly using aligned CIGAR positions and indels, independent
of carriage. A record projected through
several primary chains can contribute several inspection rows. Each parent independently resolves aligned, deleted or no-correspondence status. Deletion carriers must span their zero-width source boundary.

Deletion/replacement selection inspects the complete edit, even from an
interior point or old hole ID. Replacement alternates are inspected through
their actual source span, independently of reference length. Gap rows retain
`item_id`, `ref_bp`, `alt_bp`, `full_span`, `mol_bp` and bounded
`read_bases_length`; reads missing either flank are partial. Both inspected
spans are limited to 50 kb. This inspection does not enable SV analysis.

`include_sequence=true` with the selected `item_id` returns one full, oriented carrier in `sequence`, at most 50 kb. It selects the full carrier closest to the assembly length, allowing read indels; ordinary inspections keep only previews. No complete eligible carrier returns null.

At most 500 distinct source records are fetched across BAMs and windows.
`capped` is true if another eligible record was encountered. Fallback display
composition uses these same in-memory records; it cannot fetch another cohort.

Labelled badge clicks expand payload-backed insertions directly; right-click
the badge or use the strip to inspect. Overlapping labelled boxes resolve by
nearest notch centre, then greater molecular length; thin ticks can be hit only
outside labelled boxes. Badge selection reuses a canonical strip item by ID,
or fetches a small map window if absent. Only unmatched events use synthetic
read-only evidence. The loaded-item cache includes dataset, lift_key and chrom.

## Expand-in-place row payload

Each lifted row gains the following fields inside its existing `live_lift`:

```ts
type InsertionBlock = {
  pos: number; hap_label: string;
  src: [string, number, number]; // full forward source map gap
  length: number;              // full source bp, shared across reads
  mol_bp: number;              // this record's molecular bp in the gap
  orientation: '+' | '-';
  covered: [number, number];   // this alignment's insertion-local extent
  intervals: [number, number, number][];
  qualities?: number[];       // parallel to positive top-level calls
  layers?: Record<string, {
    intervals: [number, number, number][];
    qualities?: number[][] | null;
    quality_names?: string[];
    // Existing layer metadata is preserved, including source/family spans.
    [key: string]: unknown;
  }>;
  fire?: number[][];
  methyl_m6a?: number[]; methyl_m5c?: number[];
  deam?: [number, ...unknown[]][];
  possible_deam_ct?: number[]; possible_deam_ga?: number[];
};
type InsertionGeometry = {
  badge_ids: (string | null)[]; // exactly parallel to live_lift.badges
  insertions: Record<string, InsertionBlock | {length: number; too_large: true}>;
};
```

Blocks exist for source spans of at least 50 bp. Over 50 kb, only `length`
and `too_large: true` are emitted. Smaller badges have a null ID. The key is
the strip's insertion ID, shared across records and panels. Partial terminal
badges use the full map gap's ID and block width. A badge for source sequence
without a matching source-only map gap has a null ID and no insertion payload or assembly insertion SV.

`pos` is viewport-relative, like the badge. All other coordinates are
insertion-local in left-to-right target display order. Minus blocks mirror
span boundaries with `x -> length-x` and bases with `x -> length-1-x`: a source offset 10 base in a 100 bp insertion appears at 89. Base marks render at their centers. Qualities swap left/right on minus rows.
Footprint gaps, MSP inference, deletion cuts and explicit layers follow the
ordinary composer. Crops retain matching badge IDs/blocks and shift only
`pos`. Hidden content never enters the row's target intervals, layers or
marks, so target coverage, analyses and footprint counts remain unchanged.

All owned map gap shapes with `max(ref_bp, alt_bp) >= 10` retain
`live_lift.gap_observations`, independently of the display cutoff. Each has
the canonical map ID, reason, both absolute target/source spans,
`method: 'assembly_projection'`, `display_only: true` and source coverage
(covered interval, aligned/molecular bp, both observed flanks and completeness).
Read deviations and sequence comparison remain unassessed. Spanned deletions
and replacements also add display SV markers; partial insertions retain their
observed molecular length. For example:

```json
{"t":"D","ref":1100,"ref_end":2833,"len":1733,"ref_len":1733,"alt_len":1,"source":"assembly","method":"assembly_projection","display_only":true,"kind":"replacement","difference_id":"MAT:chrS_MATERNAL:200-201:replacement"}
```

`ref` is absolute target position; `ref_end`, `ref_len` and `alt_len` retain
independent edit spans. Insertions also keep `ins_id`. Source CIGAR glyphs
carry `source: "reads"`, `method: "display_projection"` and
`display_only: true`, omitting unprojected query offsets, clip origins and
normalized/raw source geometry. These events are display geometry; read-evidence SV
analyses (including carrier splits and the insertion lens) remain refused for
`bam_livelift`. Source-frame `sv_evidence`, `aligned_blocks`, `sv_segments`,
`sv_alignments` and `sequence_span` are discarded during composition. A future
unified model must project authoritative evidence and preserve its source
through clustering before enabling those analyses. Native classification and
clustering ignore lifted rows, including nested source alignment bundles.
`read_deletion_cuts` itself is a pysam helper; the composer cuts compact row
geometry only at projected source deletions before adding map display markers.

## Mismatch detail on compact reads

Only `include_cigar=true` and `include_mismatches=true` requests with a loaded target FASTA emit view-local
events of this shape (no mismatches are inferred without target bases):

```json
{"type":"X","pos":10,"base":"C","ref":"A","source":"assembly","len":1,"seq":"C"}
```

`source: "assembly"` means SEQ matches the HG002 allele inside a substitution
fill or aligned bubble. Read-specific mismatches use `source: "reads"`.
A read carrying the GRCh38 allele at a substitution also gets an X marker
with `allele: "grch38"`, even though its base matches the target. `len` and
`seq` preserve native renderer field names. The current canvas dispatches
native mismatch type `M`; the frontend must accept type `X` too. Existing
I/D CIGAR events keep their native shape plus `source: "reads"`.

The frontend explicitly requests mismatches only for the mismatch layer. Target reference and inferred-run masks are shared per requested window; gap lookup uses the source index. If chromosome size is unknown, no unbounded trailing no-correspondence item is invented at a cache-bin edge.
