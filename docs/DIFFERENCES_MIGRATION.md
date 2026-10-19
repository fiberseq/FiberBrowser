# Differences migration and shared work

The Differences workspace keeps the native read-only SV adapter independent of
assemblies. The `sv` row name, native SV routes and live-lift import paths remain
compatibility adapters. Source lanes render from `features/differences`; the old
strip module re-exports that implementation. Projected analyses use their
separately gated Differences routes. Legacy projected SV/Variants routes still
refuse requests whose evidence contract they cannot support.

Sessions restore both `svSplits` and `differenceSplit` as frozen geometry
targets. Historical missing putative/conflict settings retain confirmed-only
and disabled-conflict semantics. `expandedInsertions` and `liveLiftExpansions`
restore saved columns without requiring lift activation. Duplicate `sv`,
`difference` and `differences` rows become one row, preserving hidden choices
and explicit heights. Original definitions, map IDs, phase settings and source
snapshots remain in the reversible session capsule. Current selections save
their complete target, revision and policy. A removed source leaves the cached
selection unresolved; another active dataset never substitutes for it.

Saved differences offers two explicit recovery actions:

- Relink previews identities established by trustworthy producer, folding and
  record membership metadata. It never decodes punctuation. Unknown pipe names,
  ambiguous provenance and conflicting assignments remain `unresolved_import`.
  Apply updates selections, assignments, evidence, filters and ordering in one
  transaction. Original snapshots, counts and policies remain available through
  export, crash recovery and undo/redo. A stale preview cannot apply.
  An explicit reopened-source binding can connect an old scope to a new runtime
  dataset/panel key only with matching declared libraries. Lifted historical
  row identities require a lifted source. Missing or changed provenance makes
  that binding unresolved while retaining its cached membership and origin.
- Recompute previews native geometry counts and added, removed and changed
  membership using the saved target, region, duplicate and evidence/conflict
  policy. Applying freezes the new membership and retains the historical
  snapshot. Missing sources and unsupported legacy projected adapters cannot
  recompute. The shared inspector can preview a deliberately selected new
  target/policy, including exact targets, before replacing an active split.

Retired one-to-many identities retain their frozen target and show descendant
choices. Neither a descendant nor the union of its carriers is selected on
hydration. Full sequence/biological identity is never inferred from an old
coordinate target or a cached preview.

## Native evidence reuse

`services/sv_evidence.py` provides sequence-free raw evidence to splits,
Variants discovery, SV combinations and linkage. The fixed 10-base extraction
floor is independent of display cutoffs. The cache retains all signal-eligible
records including duplicates; request cohort/duplicate filters run afterwards,
with rejected-primary suppression applied per file before legacy name folding.
Calls, full diagnostic sequence, annotations and reconstruction remain separate.

Keys include producer/normalization versions, native analysis scope, dataset
generation, file/reference revisions, contig reconciliation, signal eligibility,
provenance configuration and extraction limits. File locators/stamps invalidate
cache entries; they do not become permanent observation or allele identities.

Tiles own the exact requested region with a zero halo and a loaded-cohort
scope. A primary in a larger view can change supplementary eligibility, so
arbitrary crop/extension reuse is unsafe. Two consumers share an extraction
only when those raw scopes agree. Different selections can safely filter the
same unselected superset. No discovery-completeness or whole-genome claim
follows from a cache hit. Broader halo/tile reconciliation remains a possible
optimization with its own eligibility proof.

The byte LRU retains only complete results. Native extraction additionally
reserves 256 MiB against the shared process budget and defaults to a 2 Mb view,
100,000 compact records, 128 MiB retained compact data and a 30-second deadline.
Molecule spooling retains its independent limits. Refusal/cancellation publishes
no partial tile. Legacy routes return an explicit resource error so clients keep
their previous inspection instead of treating failure as an empty cohort.

Numerical workers retain their memory reservation while idle. A parent-side
60-second timer reaps expired workers and releases that reservation; allocation
pressure can reclaim an idle worker sooner. Reuse cancels the idle timer before
the next job. Active/queued cancellation, work, byte and deadline limits remain
in force. These limits are implementation defaults, not biological calibration
or a performance acceptance claim.

## Browser and held-out validation

From `browser/frontend`, run
`node scripts/check-differences-browser.mjs <external-vite-output> <evidence-dir>`.
It builds the application and a synthetic browser oracle with Vite into the
external output, then intercepts every Playwright resource request. It starts
no HTTP server and does not write the worktree's frontend dist. The oracle
checks actual Chromium reference/body/alternate pixels and inverse gestures
against independently authored numeric coordinates for 4-to-792 replacements,
both orientations, reversal and collapse. On constrained macOS hosts it uses
Chromium's single-process launch mode.

Public seeded BAM/count fixtures separately test consumer order, cache eviction,
selection, duplication and sequence-unresolved geometry. They provide engineering
oracles. Biological sensitivity, noisy-read thresholds and genotype accuracy
still require an independent truth cohort and source/reference sequences.
