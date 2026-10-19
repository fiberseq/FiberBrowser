# Differences contracts, phase 1

The additive `differences:v1` model describes both `assembly` and `reads`.
Legacy SV geometry discovery, splitting and inspection remain usable without
an assembly. Lifted evidence analyses remain disabled by their existing
capability guards. Map display markers are not authoritative read evidence.

`services/differences/model.py` defines Difference, Observation, LocusGroup,
AlleleTarget, EquivalenceLink and ResultScope. `calls.py` defines qualified
molecule identity, evidence, representations and joint hypotheses. All spans
are absolute, zero-based, half-open; insertions are empty reference boundaries.
Replacements retain independent reference/alternate spans and raw operations.
Sequence availability, full length, bounded preview, digest and locator are
independent fields. An empty deletion alternate is available sequence of
length zero; missing sequence is not an empty allele.

The legacy `/api/sv/split` response is unchanged by default. Request
`payload_version: 2` to add a `differences` envelope with frozen geometry
target, result scope, `calls_by_molecule` and dataset-qualified row/analysis
membership. It retains the legacy merged-dataset QNAME assumption explicitly.
It reports confirmed geometry separately from unresolved exact assignment;
there is no automatic sequence enrichment or map request. Provenance-aware
producers can use MembershipIndex without merging independent libraries.
The frontend `fanOutMoleculeCalls` adapter applies one call to its member rows.
Converged track/split consumers follow in a later phase.

`assembly_difference` adapts map observations into the same Difference and
Observation types using a saved ledger and verified map/reference identities.
It preserves phased occurrences, legacy aliases, unresolved sequence and both
spans without decoding reads or supplying any read votes. The legacy assembly
HTTP response is retained until consumer convergence.

## Identity and reconciliation

IdentityLedger is JSON/session-persistable. It registers immutable observations
against stable provisional IDs and preserves frozen target/member/policy
snapshots. Exact local IDs require full unambiguous canonical strings and a
normalization namespace. Common reconstruction padding is trimmed before
hashing. Repeat/compound canonicalization is not supplied by this phase.
Merge and one-to-many split lineage preserve old IDs; a split never silently
chooses a descendant or refreshes membership. Normalization changes need new
identities and explicit lineage. Missing saved sources stay unresolved.

`digest_file` lazily verifies complete bytes, bounds its digest cache and
rejects files changed during hashing. Paths, inode/stat stamps and mtimes are
cache revisions only. Byte-identical relocation/touch retains content identity.
Large source/reference verification is opt-in; legacy native requests do not
hash whole BAM/FASTA files just to inspect geometry.

Calls are classified within a compatible representation/hypothesis before
reconciliation. The reducer cannot manufacture a junction from witnesses.
Witness IDs describe original molecule/query/record lineage; duplicate rows or
decoding do not add votes. Agreeing representations keep the minimum tier.
Target/reference or other-allele disagreement is ambiguous. Viable unresolved
dissent blocks an unconditional call. Missing/disabled/inadmissible sources
remain unavailable, leaving an independent native call usable with incomplete
combined scope. Display filters are not analysis scope.

Complete independently established primary-net ownership selects primary
hypotheses. Secondary-chain calls remain inspectable diagnostics. Tied/absent
primary ownership uses coequal reconciliation. No allele-dependent placement
selection is allowed.

| Versioned hypothesis policy | Default |
|---|---:|
| hypotheses | 64 |
| path states | 4,096 |
| transitions | 16,384 |
| compound members | 32 |
| compound reference window | 10 kb |
| reconstructed sequence per side | 100 kb |

SearchBudget exposes explored/pruned counts and `unexplored` outcomes. Omitted
coequal/primary outcomes prevent retained agreement from becoming a confirmed
target or reference. Capped secondary-only diagnostics cannot veto a complete
primary result. No exclusion/outcome-equivalence shortcut is implemented.
Phase 3 must supply independently validated composition before enabling any
lifted consumer.

## Allele and DAF contract spike

`alleles.py` provides independent exact-string competition, a CT/GA transition
matrix and structural-proof checks for executable oracles. Unknown chemistry,
partial/absent sequence, noise without calibration and conversion-only allele
ties stay unresolved. Reverse complementation complements the matrix once;
it does not rename the molecule's chemistry. A StructuralProof must attest two
observed flanks, compatible query-collinear path, competitor exclusion and
complete search. Geometry or an expected assembly string alone cannot assign
an exact allele. These helpers are not a calibrated noisy-read caller and are
not wired into production allele counts; phase 2 implements that caller.

## Reconstruction resources

Current consensus, full/partial knot mapping and alternate-panel middle
alignments use `reconstruction_budget.py`. Limits are injectable options with
the following initial defaults. Search bounds and resource limits have
separate versions.

| Resource | Default ceiling |
|---|---:|
| DP cells per pair / request | 25 million / 100 million |
| reserved bytes per alignment job / request | 256 MiB / 512 MiB |
| process-wide active reservations | 1 GiB |
| concurrently large jobs | 1 (all reconstruction jobs conservatively take this slot) |
| queued requests | 8 |
| input entries / bases | 512 / 2 million |
| reconstructed sequence | 100 kb |
| serialized result | 16 MiB |
| request deadline, including queue | 30 seconds |

The estimator uses the actual band, including alternate-panel offset widening
and the external DAF kernel's wider formula. It reserves at least twice the
score/trace matrix bytes, plus linear temporary overhead. Known work is
preflighted; actual changed backbones are rechecked before each allocation.
All rounds/reads charge the same request, and alternate-panel jobs share their
consensus request's remaining work/deadline. Numeric workers run sequential
alignments rather than multiplying matrices through thread pools. Unknown
later-round growth conservatively takes the large-job slot from the outset;
the policy also exposes a 16 MiB threshold for future finer scheduling. Majority
sampling remains at 32 reads; the existing DAF default remains at 200, with
sampling provenance reported. Resource refusal does not silently resample or
substitute a read as consensus.

Workers use spawn and pipes, with no listening service. The parent checks
server cancellation every 20 ms, kills/reaps a running compiled kernel or
compilation, and releases its reservation in `finally`. Queue cancellation and
deadlines use the same checkpoints. The external DAF adapter verifies the
supported banded allocation contract before entering its compiled kernel.
Spawn/compilation overhead is included in the deadline. A worker cannot be
reused after abort and retain an allocation.

Refusal returns `budget_exceeded`, `cancelled` or `unavailable`, with reason,
parameters, resource version and `complete: false`. Lens geometry, previews
and chromatin remain inspectable via `consensus_resource`; Identify and
consensus export stay disabled without a consensus. These incomplete results
are excluded from the lens cache. An alternate-panel build propagates refusal
without installing a partial result. Existing derived caches include the new
resource producer version.

## Sessions

The core store's `differencesSession` capsule persists the identity ledger,
versions, frozen targets, historical memberships and independent saved options.
The same field passes through session export/import, snapshots, undo/redo and
crash recovery. Native `svSplits` and assembly `differenceSplit` parents both
have reversible fixtures; original visibility, expansions, maps/panels,
selections, assignments and policies are retained in `legacySnapshot`.
Old missing putative/conflict settings retain their confirmed-only/disabled
meaning. Legacy imported SV definitions are frozen against automatic refresh.

Historical pre-P2c identities require explicit producer, folding and saved
record/molecule provenance. The adapter verifies the authentic encoding by
re-encoding those known components; it never splits arbitrary pipe strings.
Established selections and assignments hydrate into validated current-format
identities; original IDs remain in the reversible snapshot. Conflicting
historical assignments cannot pick a strongest winner.
Raw QNAME formats stay verbatim. Missing or ambiguous provenance preserves
original IDs and nonempty snapshots with `unresolved_import` membership.
Relocation, missing maps and cache eviction do not guess replacement sources.
Full rendering/session migration and deliberate relink/recompute UI remain
phase-5 work; the legacy adapters have not been retired.
