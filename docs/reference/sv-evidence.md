# Read-derived SV evidence

Live-lift datasets remain refused for read-evidence SV analyses, including
carrier splits, Variants and the insertion lens. Their display rows discard
source-frame `sv_evidence`, `aligned_blocks`, `sv_segments`, `sv_alignments`
and `sequence_span`; projected display glyphs and assembly insertion badges do
not establish a target-coordinate molecule evidence bundle. Enabling these
analyses requires authoritative projection and source-aware reconciliation.
Native BAM evidence remains usable without an assembly or a lift map.

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
- **Conflicting (putative — elsewhere):** another alignment segment explains
  at least **500 bp and 50% of the particular supporting clip**, with **MAPQ
  >=20**, on another chromosome or **more than 100,000 bp** from the target
  interval. Distance includes the target's equivalent placements. This is a
  warning about competing alignment evidence, not a proven noncarrier genotype.
  Explained bases count the union of **M/=/X query blocks** intersecting that
  clip; internal I bases do not count. D/N operations add no query bases. Each
  clip retains its originating alignment's reference/query geometry and strand,
  so pooled alignments sharing an endpoint cannot lend it a different clip frame.
  Clips at the other end of a molecule do not trigger it. Query intervals must
  have equal full-molecule lengths, include hard clips, and are reflected when
  the segment strands differ. Fetched segments and SA descriptions use the
  existing deduplication rule. Distance uses the full replaced reference span
  (`end`/`ref_len`) and equivalent placements in both classifiers. Missing
  aligned-query blocks never creates a conflict; legacy clips without an origin
  require a unique matching endpoint, clip length and query frame.
  A local inversion or short repeat hit alone is insufficient. Confirmed CIGAR
  or junction evidence remains authoritative. Conflict classification precedes
  nearby-allele ambiguity; it has its own opt-in, independent of ambiguity.
- **Ambiguous:** clip evidence compatible with multiple nearby seeded alleles.
  Competition tests the particular supporting clip across insertion and deletion
  targets, including 50 bp seeds hidden by a higher display cutoff. Opposite-end
  clips do not compete with each other.
  Ambiguous evidence stays outside the default carrier group and has a separate
  explicit opt-in.

Summary `support`/`confirmed` and `informative` count confirmed molecules and
confirmed plus reference molecules respectively. `putative`, `conflicting` and `ambiguous` are
separate counts. Variants, summary tooltips and lens show those levels. Default
carrier sets include **confirmed + putative** in highlighting, single and combined
splits, Variants/linkage and lens rows, profiles and insert exports. Confirmed
only is an option; conflicting and ambiguous each require a separate explicit opt-in. Putative lens
rows are hatched, and weaker read highlights/group rows have pale dashed
evidence markers. Labels count confirmed, putative, conflicting and ambiguous separately.
Read and lens tooltips retain the conflict's destination, explained bases,
clip fraction and MAPQ. Variants, split labels/dialogs and insertion lists explain
that conflicting clips align elsewhere. Highlighting offers a conflicting-only
action. Explicitly included conflicting lens rows remain hatched and their
profiles/insert exports follow the selected cohort.
Soft-clipped putative, conflicting and ambiguous lens rows are hatched even
when the cohort contains no hard clips. Single-SV panel splits retain each
group's evidence levels, including after saving and reopening a session.
Browser and figure SV bands apply their support gate to confirmed + putative;
conflicting and ambiguous counts do not make a band visible by default.
Summary `support` and `informative` retain the evidence-statistic definitions
above, rather than presenting an inclusive carrier fraction as a genotype.
Insertion lists use confirmed + putative carrier totals with separate counts.
Split choices and rendering tiers persist through panel/session/snapshot state;
refresh uses the saved policy. Legacy saved splits lacking a policy field retain
their original confirmed-only choice. New unsaved actions use the inclusive
default. Splits saved before conflict filtering retain their earlier cohort on
refresh (conflict detection disabled for that saved definition). New splits save
their conflict thresholds and explicit inclusion choice; changing the global
defaults does not rewrite a saved split. The lens returns all four evidence cohorts, with `evidence_total`
describing its capped row pool.
The lens target and Variants panel also save their three carrier-tier checkbox
choices in panel/session/snapshot state. Missing fields use the new-action
defaults: putative included, conflicting and ambiguous excluded. These panel
preferences are separate from a previously saved split's historical policy.

Advanced View settings expose an enable switch, maximum local distance,
minimum elsewhere MAPQ, minimum explained bases and minimum clip fraction.
Defaults are 100 kb / 20 / 500 bp / 0.5, respectively. Sessions, snapshots and
crash recovery preserve these settings. Reads use `sv_conflict_options` (JSON
query parameter); split/Variants bodies and lens/list queries use
`conflict_options` with `enabled`, `max_distance`, `min_mapq`, `min_overlap`,
`min_clip_fraction`. `include_conflicting` defaults to false. The options travel
with summary responses and all affected request/cache identities.

The rule was explored on **an HG002 Fiber-seq sample**, including an AluY
insertion, MHC paralog alignments and a wider chr1 interval. It keeps 35/35
assembly-supported AluY putatives while flagging 65/65 focal MHC paralog
putatives. The wider chr1 check flags one low-confidence split/chimeric molecule;
its assembly truth remains unresolved. This retrospective check is not a
general sensitivity/specificity estimate and the defaults must not be treated
as validated across loci or samples. Standalone low anchor MAPQ, high NM
(which includes genuine indels), both-end clipping and small noncollinear SA
fragments do not exclude a molecule. No whole-reference sequence search or
assembly-specific carrier list is used at runtime.
Long homologous TE inserts, true rearrangements and chimeric molecules can
still receive the competing-alignment warning. The AluY check does not validate
other repeat families or independent samples; the 100 kb locality choice is
uncalibrated. The evaluation uses the same molecules/loci that informed these
provisional thresholds, and calls across nearby targets can reuse a molecule.
Regional assembly BAMs can omit elsewhere or low-quality alignments. Neither a
missing compatible assembly gap nor a high-MAPQ alignment somewhere on the same
chromosome proves noncarriage: an explicit allele and coverage check is needed.
Unresolved calls stay separate from positives and negatives; approximate
assembly-gap overlap is not a test of exact allele identity.
Retrospective deletion-junction checks must use alignment continuity across
small indels, as reference evidence does, rather than requiring a single raw
CIGAR match block. A small sequencing indel must not turn adequate flank
coverage into unresolved truth.

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
conflicting, ambiguous, reference, then unknown; CIGAR precedes junction and clip within a
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
spools selected alignments to temporary binary BAM storage, preserving exact
tag values (SAM text can round floating-point tags). Only one molecule's raw records
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
Minimized and older raw event sizes both locate merged inserts; the returned
length counts the original inserted bases, which can differ from the canonical
allele size. A size difference never falls back to a bridge-spanning query slice.
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
