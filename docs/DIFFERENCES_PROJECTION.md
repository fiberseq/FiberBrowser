# Authoritative read/map evidence

`read-map:v1` composes observed read CIGAR walks with selected affine map
pieces and validated raw map cuts. Display projection remains a separate
adapter and keeps stripping source authoritative fields. Native SV browsing
does not request a map or enable lift.

The opt-in POST routes `/api/lift/analysis/summary` and
`/api/lift/analysis/split` require the live-lift flag and independently checked
`difference_summary` / `difference_split` capabilities. They accept
`dataset_id`, `chrom`, `start`, `end`, optional `projection_policy`,
`include_duplicates` and molecule chemistry `contexts`. Summary discovers
geometry at 10 bp independently of display cutoffs. Split requires a frozen
target, for example:

```json
{
  "target_id": "saved-target",
  "revision": 1,
  "target_type": "geometry",
  "ref_start": 1000,
  "ref_end": 1004,
  "alt_bp": 792
}
```

An `exact` target also supplies full `candidates` keyed by target ID,
`reference` and every competitor, plus `competition_complete: true`. Missing
competition or sequence cannot prove an exact assignment. An optional
`diagnostic_start` / `diagnostic_end` selects a bounded common reconstruction
window; candidate strings then include its retained flanks. A displaced
plausible edit outside the diagnostic window cannot prove reference.
Geometry counts remain visible when sequence assignment is unresolved.
Geometry uses configurable narrow defaults (both endpoints: max(20 bp, 5% of
the larger span); each ref/alt span: max(20 bp, 20%)) and compatible net direction.
Zero tolerances request strict geometry. These tolerances never establish an
exact sequence allele or permit a replacement to prove an empty deletion allele.

Read bases always come from BAM SEQ. Expected map sequence never fills missing
or hard-clipped bases. CT/GA chemistry from an actual primary's `st` tag retains
its provenance; explicit contexts keyed by qualified molecule ID can override
it. Raw-name context aliases apply only to a unique library in the requested
scope, with ambiguous aliases counted explicitly. Unknown chemistry remains
unknown, and the shared uncalibrated likelihood profile gives noisy/DAF calls
at most putative. Exact deletion carriage can use a validated, query-collinear
path with both observed flanks and explicit competitor exclusion.

Each segment has explicit target endpoints, source CIGAR/endpoints, target
path, full query length/frame and original BAM `seq_q` mappings. A minus map
reflects query intervals and complements sequence once. The molecule's
canonical physical query identity is distinct from its alignment placement.
Map D/I/replacements can compose with or cancel source operations. Ordered
base blocks, edit cuts and connected components remain separate; a hull,
reference skip or unresolved map hole supplies no junction/reference bridge.
Insertion-only and one-flank observations remain partial.

Classification occurs inside each joint map choice. Actual supplementary
records can form a deletion junction only with compatible path, orientation,
full query frame, quality and nonoverlapping collinear query endpoints.
Reciprocal SA lookup fetches bounded actual records, including off-window
primaries; unfetched/unprojectable tags remain source/query witnesses and
cannot fabricate target-chromosome conflicts. Only an actual compatible,
quality-qualified placement explaining enough supporting query elsewhere can
give a conflicting tier. Secondary map diagnostics do not veto unique complete
primary-net ownership; tied/incomplete ownership uses coequal reconciliation.

Every capped hypothesis/path/transition search retains explicit unexplored
outcomes. Agreement among retained primary/coequal outcomes cannot confirm a
target or reference call. Secondary-only caps preserve complete primary calls
and expose incomplete alternative inspection. Numeric defaults are 64
hypotheses, 4,096 states and 16,384 transitions; all are saved options.

The default `analysis_scope` is `lifted_only`. Explicit `combined` also requires
`native_dataset_id`. Native and lifted representations classify independently
before one molecule call/count. Matching names in different libraries remain
separate; explicit molecule-group provenance establishes sharing. Agreement
counts once at the minimum tier; decisive disagreement or viable unresolved
dissent is ambiguous. Missing/unavailable copies preserve an independent call
with partial combined completeness. No junction or compound uses a flank from
each independently aligned copy.

Responses use `differences:v1`, target snapshots/revisions, per-hypothesis and
per-representation diagnostics, geometry versus sequence counts, loaded-cohort
scope and qualified molecule-to-record/row/analysis memberships. Consumers
select the frozen target/revision/scope before row fan-out. They count at the
molecule level, never at row level. Map observation IDs use verified manifest
and target-payload content; file stamps remain cache revisions.

Defaults bound 512 records, 2 million lazily decoded input bases, 131,072 retained
CIGAR operations, 16,384 generated
runs, 128 summary targets, 16,384 target/molecule calls, 100 kb reconstructed
sequences, 16 MiB response bytes and 30 seconds including queue time. Bounded
molecule spooling (64 MiB raw source/request, 16 MiB/molecule, a server ceiling
of 256 MiB/request), 64 reciprocal SA lookups and existing fetch-window/source-bp
limits apply. Linear storage reserves process-wide memory before I/O; shared
likelihood budgets reserve numerical work separately. Cancellation propagates
from HTTP disconnect through source scans, path search and scoring, releasing
reservations in `finally`. Refused/partial results are never cached as complete.
Ordinary preview fields, including nested edit observations, are at most 60
bases with full lengths.

The legacy SV summary/split routes, Variants and insertion lens retain their
default-deny lifted capabilities. Their old reducers and consensus builders
cannot consume alternative projected alignments. These additive summary/split
routes pass independent coordinate/string/count and membership gates; inspector,
canvas, Variants and lens convergence require their separate consumer gates.
Unsupported noncollinear multi-chain paths stay unresolved rather than being
joined by a hull. No biological calibration or general release-performance
certification follows from synthetic correctness gates.
