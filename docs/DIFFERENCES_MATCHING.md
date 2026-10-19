# Differences normalization and allele evidence

Phase 2 operates on the shared `assembly`/`reads` model. Native geometry
discovery, inspection and splits remain independent of maps. Lifted SV analysis
retains its capability refusals; map markers supply no read votes. Consumer
convergence remains a separate integration step.

## Normalization and matching

`services/differences/matching.py` accepts immutable `Edit` observations in one
target reference, with independent ref/alt lengths, phase, compatible path and
hypothesis IDs. `edit_from_difference` adapts the shared payload. Its preview
never becomes a full alternate; a lazy producer explicitly supplies full,
target-oriented sequence.

`match_edits` normalizes before indexed candidate search. Its `window_provider`
returns a bounded full `ReferenceWindow` including halo. Common-flank trimming
handles residual replacements, and pure indels rotate through proven repeat
anchors. Repeats reaching unavailable halo edges cannot acquire global exact
IDs. Full reconstructed-string equality still proves the explicitly compared
local link. Source records/observation IDs survive. Canonical identities use
`allele:norm:haplotype:v2`, independent of padding, display kind and compound
versus replacement encoding.

`MatchingPolicy` exposes these defaults:

| Test | Default |
| --- | --- |
| Narrow tolerance, both ends | max(20 bp, 5% larger span) |
| Independent ref/alt span allowances | max(20 bp, 20% respective larger span) |
| Near-pure replacement | net, larger and smaller span differences each <= max(20 bp, 20% larger span) |
| Wider approximate **search**, both ends | max(50 bp, 20% larger span) |
| Ordered compound | 32 adjacent members, 10 kb reference window |
| Reconstructed sequence per side | 100 kb |
| Observations / representations / pairs / links | 4,096 / 4,096 / 16,384 / 4,096 |
| Deadline / response | 30 s / 16 MiB |

Input sequence also obeys the shared 2-million-base limit. Caps, unavailable
sequence, unsupported topology and insufficient halo stay explicit. There is
no all-subset search. Measurement uncertainty is not proven repeat equivalence.

Compounds retain ordered adjacent edits on one explicit path, hypothesis and
phase occurrence, including reference bridges. Overlapping edits remain
unassessed; coincident insertions require raw operation order. Two 50-base
deletions around a 15-base bridge equal a 115-to-15 replacement only when its
alternate is the actual bridge. Local inversions can reconstruct the same
haplotype as replacements. Nonlocal breakends/bubbles remain unassessed.

Typed `EquivalenceLink` results contain endpoint sets, member roles, recipe,
window, versions, phase relation and reasons. Many clusters can link to many
occurrences. Tolerance earns `candidate`, never exact identity or read votes.
Exact links require complete reconstructed-string equality. No approximate
sequence-support threshold is enabled without calibration; wider candidate
search alone cannot label an allele “assembly-supported (approximate)”. The
legacy map adapter uses the same rules and an anchor index, adding typed
candidate links; legacy cluster aliases remain explicitly scoped/temporary.

## DAF-aware competition and resources

`likelihood.py` compares full observations with all competitors and reference
before display filtering. Its engineering profile uses global indel-aware
likelihood scores, quality-dependent emissions, CT/GA conversion channels, a
100:1 minimum score margin and an absolute nonconversion-noise guard. Scores
are not posterior probabilities or genotype fractions.

Chemistry/provenance, conversion/noise parameters and orientation are explicit.
Reverse complementation complements the matrix once without renaming chemistry.
The native adapter slices BAM SEQ directly in its existing reference orientation.
Converted donor versus true converted-base alleles remain ambiguous until
sufficient informative diagnostics distinguish them. Unknown chemistry, missing
competitors, partial/ambiguous bases and low score margins remain unresolved.
Low-quality equality cannot bypass the margin test.

There is **no biologically calibrated ONT/DAF profile** bundled here. Noisy/DAF
calls stay putative with `uncalibrated_likelihood_profile`. A producer may inject
an independently validated profile with its calibration identity. Complete
undeaminated string matches use a separate `exact_sequence` method, subject to
geometry tiers and competition. Expected assembly strings provide no read votes.

DP preflights all competitors and charges one shared request before allocation.
Rolling rows reserve bytes through the phase-1 process resource manager. Extra
conservative limits are 2 million cells/pair and 10 million/request. Deadline
and cancellation checks occur each row and every 256 columns. Refusal returns
unknown with resource parameters, never a partially scored winner.

## Lazy native API

The default `/api/sv/split` remains sequence-free. `payload_version: 2` retains
its frozen geometry target/counts. Explicit `allele_target` requests add a
separate `differences.enrichment`, for example:

```json
{
  "target_id": "saved-target",
  "revision": 1,
  "reference": "",
  "candidates": {"saved-target": "ACGT", "other-target": "TGCA"},
  "competition_complete": true,
  "chemistry_by_name": {
    "synthetic-molecule": {"chemistry": "none", "provenance": "synthetic-library"}
  }
}
```

Sequences are full target-oriented alleles, never previews. Null sequence is
unavailable; empty deletion alternate is valid. Chemistry defaults to unknown.
The snapshot is an explicitly provisional sequence target: a caller label is
not a canonical allele ID. Normalization separately supplies verified IDs.

Optional `diagnostic_start`/`diagnostic_end` contain the geometry span and allow
common windows covering displaced raw edits. Candidate/reference strings then
span that window. A narrow window missing a known geometry carrier's operation
returns `diagnostic_window_misses_geometry`, never a reference vote.

The adapter fetches the target neighborhood and requested cohort, walks CIGAR,
requires observed adjacent flanks/continuity, and preserves original query and
record-content witnesses. N skips and missing/hard-clipped diagnostics remain
unknown. Record count, bases and response bytes are bounded. No map or chromatin
decode is requested. Row previews are <=60 bases with full observed lengths;
full internal observations drive calls. Duplicate policy, existing geometry
conflicts and qualified molecule membership survive. Historical merged-file
provenance remains an explicit compatibility assumption.

Counts are separate by assignment and evidence tier. Result revisions include
target, competition, policy, cohort and actual record-content witnesses. The
route propagates client disconnect cancellation. No result is installed in the
light scan or frozen geometry split. Frontend `fanOutEnrichedCalls` requires the
explicit enrichment revision before applying its one molecule call to rows.

## Whole-compound carriers, phase and novelty

`carriers.py` requires every component and diagnostic bridge/outer-flank evidence
on one compatible query-collinear path. A frozen recipe can validate the required
component set. Name intersections across incompatible hypotheses cannot form a
path. Complete equivalent whole representations can union; partial members
cannot. Hypotheses and independent representations reconcile before one molecule
vote. Phase occurrence union adds no inferred phase; incompatible target alleles
cannot merge into one exact carrier.

`novelty` needs explicit compared assemblies/haplotypes plus complete discovery,
correspondence, sequence, representation search and bubble resolution. Missing
gates or unresolved candidates yield `unassessed(reason)`; no assembly yields
`reads_only`. Assembly-relative novelty never suppresses discovery or implies
population novelty. Sessions save matching/likelihood options independently of
lift, while retaining historical versions, frozen targets and memberships.

Independent tests author edited strings and molecule counts without production
extraction as the oracle. Held-out seeded controls include 30 repeat positives,
30 distinct-string geometry negatives and 24 additional noisy competitions.
These are engineering controls, not biological sensitivity estimates. Source
assembly FASTA and independent biological truth are still needed to calibrate
noisy-read confirmation and approximate sequence support.
