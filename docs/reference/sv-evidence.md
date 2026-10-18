# Read-derived SV evidence

Read summaries, Variants, splits, highlighting and the insertion lens use a fixed
10 bp evidence floor, independently of the display/seed cutoff. Deletion cuts in
chromatin intervals and direct-load cache keys use the display cutoff. Filtered
payloads retain `sv_evidence`; JSON, FBR1, packed caches and cropped views preserve
alignment metadata. Boundary crops near retained indels require a fresh summary.

Evidence is classified per molecule (QNAME) per target:

- **Confirmed:** a matching CIGAR event, or a same-chromosome, same-strand junction
  with both MAPQs >=20, equal full-query lengths and non-overlapping query
  intervals. A deletion junction has <=20 unaligned query bases; an insertion
  junction has a query gap matching the allele length and sequence available
  across that gap. Query intervals include hard clips in the full-query frame;
  CIGAR event `q` remains in BAM SEQ coordinates, on both strands.
- **Putative:** a compatible terminal clip without definitive sequence/junction
  evidence. Insertion clips retain the 50 bp floor. Mixed soft/hard clips expose
  only their available soft sequence. Hard clips alone never confirm an insert.
- **Ambiguous:** clip evidence compatible with multiple nearby seeded alleles.
  Competition tests the particular supporting clip across insertion and deletion
  targets, including 50 bp seeds hidden by a higher display cutoff. Opposite-end
  clips do not compete with each other.
  Ambiguous evidence stays outside the default carrier group and has a separate
  explicit opt-in.

Summary `support`/`confirmed` and `informative` count confirmed molecules and
confirmed plus reference molecules respectively. `putative` and `ambiguous` are
separate counts. Variants, summary tooltips and lens show those levels. Default
carrier sets include **confirmed + putative** in highlighting, single and combined
splits, Variants/linkage and lens rows, profiles and insert exports. Confirmed
only is an option; ambiguous requires a separate explicit opt-in. Putative lens
rows are hatched, and weaker read highlights/group rows have pale dashed
evidence markers. Labels count confirmed, putative and ambiguous separately.
Summary `support` and `informative` retain the evidence-statistic definitions
above, rather than presenting an inclusive carrier fraction as a genotype.
Insertion lists use confirmed + putative carrier totals with separate counts.
Split choices and rendering tiers persist through panel/session/snapshot state;
refresh uses the saved policy. Legacy saved splits lacking a policy field retain
their original confirmed-only choice. New unsaved actions use the inclusive
default. The lens returns all three evidence cohorts, with `evidence_total`
describing its capped row pool.

Reference requires an aligned block covering both breakpoints, the full interval
of equivalent placements, and 100 bp flanks. Blocks bridge small CIGAR indels
(deletions up to 10 bp); larger deletions and every N skip break support. Outer
alignment bounds cannot establish reference across those gaps. Legacy compact
evidence excludes retained deletions larger than 10 bp crossing the interval.
Compatible CIGARs and clips anywhere in an equivalent-anchor interval are
reconciled first; a different insertion there is uninformative. These are
alignment-evidence denominators, not validated biological genotypes: homologous
sequence in repetitive loci can still align across a site on the wrong haplotype.

Every molecule call retains its complete `evidence_bundle` of compact alignment
records and original items. The representative prefers confirmed, putative,
ambiguous, reference, then unknown; CIGAR precedes junction and clip within a
level. Alternative records remain available independently of grouping. Molecules
count once per target, including merged files; overlapping target tolerances do
not establish exclusive alleles.

Seeds have a total position/type/length/molecule order, deterministic nearest
assignment and one median vote per molecule per cluster. Identical targets
collapse; stranded singleton outliers cannot gain shadow piles through final
reconciliation. Membership reconciliation uses an in-view position index;
summaries skip unused memberships and classify the full evidence instead.

Initial splits capture settings before waiting, retry changed duplicate settings
and reject superseded requests. Refresh preserves historical assignments but
counts only its current region and settings. Lens response identity includes the
dataset, target, duplicates and data revision; stale actions are unavailable.
Insert export controllers abort on replacement, target change and unmount.

The public compact loader propagates `FramePolicyError` with its cause for
unexpected molecular-frame policy/import failures. Missing optional policy
imports retain declared-header geometry on both strands.

All eligible primary and supplementary records fetched in the window contribute
to a molecule bundle. Collection checkpoints cancellation every 256 records,
applies name sampling/selection budgets during collection, and losslessly
spools selected alignments to temporary storage. Only one molecule's raw records
are materialized at a time. A 64 MiB serialized-record budget per molecule and a
250,000-molecule index budget fail explicitly rather than returning partial
evidence. Temporary storage closes on completion, cancellation and budget errors.
Supplementaries can be spooled provisionally until local-primary eligibility is
known; a filtered local primary never reaches the sampler through one. Decode
partitions retain original anchor ordinals and count only their own sampling
extents, so serial/parallel output order, source occurrences and counts agree.
A deterministic primary anchor is preferred; if no primary
is local, a supplementary anchor supplies the row. Distinct primary source
occurrences retain their existing display identities for consensus overlays;
they still contribute once to SV counts and one molecule evidence bundle.
Anchor chromatin retains its existing alignment identity. `sv_alignments` preserves
the other segments' separate CIGAR events, blocks and SEQ availability; evidence
classification pools their segments without multiplying molecule votes. Reciprocal
SA descriptions are deduplicated by reference/query geometry, with fetched records
overriding tag descriptions and conservative MAPQ ties. Secondary, duplicate and
signal filtering apply before local bundling. Nonlocal SA descriptions never
fabricate sequence or chromatin. Both strands use the same full-query frame.
Filtering a local primary cannot rescue that molecule through an unscored
supplementary; recovery applies when no primary is local. Non-SV signal-window
statistics retain their existing primary-record scope.

Split, Variants and lens include supplementary-only local molecules. Lens rows
retain `evidence_bundle`; default alternate-allele construction uses confirmed
molecules, including supplementary-only CIGAR inserts. Consensus requires full
CIGAR insert spans: clipped putative molecules can be true carriers without
covering the complete alternate sequence, so including them in consensus would
require additional assembly/alignment assumptions. The same full-insert rule
applies to lens consensus, independently of its inclusive profile/row default.

## Exact alleles and reference normalization

An event's `len` counts its inserted or deleted CIGAR bases (the larger count
for a mixed replacement), excluding aligned bridges. `ref_len`/`ref_end` describe
the replaced reference interval; `alt_len` and `q_end` describe its alternate
query span. `raw_pieces` retains every original I/D and aligned bridge operation
inside a merged event. Thus `50I10M50I` inserts 100 bp and replaces 10 reference
bp with 110 query bp; `20D10M20D` deletes 40 bp and replaces 50 reference bp with
10 query bp. Thresholds use that indel-base count monotonically. Adding unrelated
indels cannot restore an event above its size threshold.

When a FASTA is available, exact ref/alt strings are minimized and pure indels
are rotated left through repeat-equivalent placements. `ref` is canonical;
`raw_ref`, `raw_ref_end`, original `q`/`q_end` and CIGAR pieces retain source
geometry. `uncertainty` is the inclusive interval of equivalent anchors; complex
non-equivalent replacements retain their exact ref/alt strings without invented
repeat equivalence. Replacements reconstructing reference exactly do not seed
SVs. Minimization recomputes inserted/deleted counts from the trimmed spans and
bridges surviving on both reference and query axes, then reapplies the cutoff, so a replacement reduced to a micro-indel or SNV
cannot retain its original SV size. Missing reference contigs retain raw evidence. Reference changes invalidate
read, split and insertion-tile/lens caches. Worker options carry reference paths,
not open handles.

Clustering uses canonical anchors. Classification, candidate indexing and
highlight competition also carry the equivalent-anchor interval. A raw in-view CIGAR can seed
its canonical cluster even when left normalization moves that anchor outside the
view; raw per-read glyphs remain at their observed positions. Cluster medians
remain tolerance-based summaries, with per-alignment exact alleles retained.
The summary sends `evidence_targets` so highlighting uncertainty uses competing
alleles even when their glyphs are hidden by the display cutoff.

Chromatin cuts use only deleted pieces of the displayed anchor's original CIGAR,
at the display cutoff. Matched bridges survive, and normalization never moves
query marks. Lens rows splice the full replacement query span, including boundary
D operations through `raw_ref_end`. Spliced MD drops those deletions and keeps
matched-bridge mismatches. Alternate-allele right flanks start after the replaced
reference span; reference reads align their replaced query segment against that
allele. Insert-sequence lookup concatenates raw I pieces, excluding matched
bridges, and uses the raw anchor when locating the source record.
Canonical alternate-allele consensus uses normalized allele sequences. DAF
consensus rotates each observation before chemistry-aware alignment, retaining
its original record, query offset and CT/GA strand. Native lens sequences and
knots retain the observed query axes; if minimizing a
complex replacement changes its query span, canonical sequence majority is used
with an explicit fallback reason. The native lens retains observed query axes.

Supplementary-only alignments whose whole-molecule annotation calls lie outside
the local segment retain a neutral evidence row when no footprint quality or
minimum-count gate excludes them. This does not fabricate chromatin calls on
unaligned or hard-clipped bases. Recovered hard-clipped anchors always retain
neutral rows: truncated SEQ cannot prove the whole-molecule annotation frame for
every layer. They expose CIGAR/segment evidence and no chromatin or modification
marks; positive footprint quality/count gates exclude these unsafe rows.
Circular clipping preserves their supplementary status and alignment bundles.
Uncapped exports,
and a persistent cross-window variant catalogue remain outside this change.
