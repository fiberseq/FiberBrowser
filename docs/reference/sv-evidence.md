# Read-derived SV evidence (P0 audit corrections)

Read summaries, Variants/SV, allele splits and the insertion lens extract evidence
at 10 bp, independently of the requested display/cluster cutoff. The cutoff gates
cluster seeds and glyphs. It must not hide a shorter matching CIGAR event or a
carrier clip. Compact payloads retain `sv_evidence` when filtering `sv` for drawing;
client region projection preserves it too. The frontend carrier helper mirrors
`sv_events.carrier_evidence`, checked against the same sequence-free Alu/MHC fixtures.

Projection also preserves lazy FBR1 evidence using writable data properties and
checks retained evidence at cropped boundaries. Initial splits capture duplicate
settings before requesting, retry changed settings and reject superseded requests.
Insert exports abort on replacement, target changes and unmount.

After running-median clustering, CIGAR memberships are reconciled against the
rounded final targets. Events originally assigned to adjacent seed clusters are
considered, and stale members are removed. Membership is evaluated per target:
a QNAME contributes once to each compatible target, as in an individual split or
lens request. Overlapping target tolerances do not establish exclusive alleles;
confidence and ambiguous clip membership remain later audit work.

Carrier and reference counts both use QNAMEs, including merged BAMs. When records
of one molecule disagree, carrier wins over reference, which wins over
uninformative. CIGAR evidence wins over SA, then clip evidence for carrier
subtotals, regardless of file order. Identical QNAME/position/length seed events
are deduplicated before calculating medians. Summary and Variants `n_reads` also
count molecules; other browser read-count fields retain their existing scopes.

The extraction shortcut no longer rejects joined events by summing only I/D
bases. This fixes the audit's `20D10M20D` 50 bp threshold disappearance without
changing the existing approximate joined-event representation.

Lens responses/actions belong to their dataset, target, duplicate setting and
data revision. Stale responses are unavailable during loading/error/seek/clear;
per-request abort signals prevent reuse of a superseded pending request. A pending
insert export is discarded if its originating response is replaced. Split
refresh keeps historical assignments for returning molecules, while its counts
come only from the latest region/duplicate-setting response.

Unexpected MA molecular-frame header-policy/import failures propagate. Missing
optional policy imports still use the existing declared-header fallback. A
runtime failure cannot silently choose SEQ geometry.

The public compact loader propagates `FramePolicyError` with its original cause.
Direct BAM cache keys and deletion interval cuts use the display cutoff, while
event extraction continues to use the independent 10 bp evidence floor.

Seeds have a total position/type/length/molecule order; nearest-target assignment
uses deterministic ties. Each molecule contributes one median vote per cluster.
A stranded singleton compatible with a stronger final target cannot become a
shadow cluster by reconciliation. Identical targets collapse. Reconciliation is
indexed and restricted to in-view events; summaries skip unused memberships and
classify full molecule evidence against their final targets.

Carrier evidence otherwise keeps the existing rules: matching CIGAR indels,
clips plus same-strand SA endpoints for deletions, and nearby soft/hard clips of
at least 50 bp for insertions. Reference calls still use alignment bounds (or
provided alignment spans). No supplementary consolidation, sequence validation,
normalisation, confidence model, export cap change or server-side lens job
cancellation is introduced here.
