# Lattice-aware footprint families in FiberBrowser

The staged Monte Carlo engine (`staged_native_families`) is deprecated; the
Footprints panel defaults to the lattice recaller (see
[LATTICE_CONSENSUS.md](LATTICE_CONSENSUS.md)). When **Staged Monte Carlo
(deprecated)** is chosen as the engine, the workflow shows
**automatic mode → consolidation**, enabled by default at **±10 bp**, with a
**±5 bp** preset for finer grouping. Mode follows metadata for the selected
datasets: CR for one pooled source, SR for a DAF source, XCR for multiple pooled
sources, and SR/XCR when multiple datasets include DAF strands. The current
staged caller pools both PacBio and ONT Hia5 directions; the UI reports this.
Missing metadata greys out the mode and disables running, with a link to
**Open dataset setup**. Advanced settings remain under an accordion.

Dataset setup can save the selection for this session or optionally write the
existing **FIBERHMM-CHEMISTRY:v1** `@CO` declaration into local source BAMs using
FiberHMM's canonical header writer. No alternative metadata format is used.
BAMs and replacement BAI/CSI indexes are prepared before installation; existing
compatible declarations are preserved, conflicts are rejected, and installation
failures restore original files. DAF sequencing platform comes from existing
header metadata or an explicit selection. Reopening uses the normal BAM-header
metadata reader. Restart the Browser backend and reload the page after updating.

The input is existing LLR-called TF footprints. Each call keeps its original
coordinates and source identity. Per-read MSP/nucleosome segmentation determines
inference eligibility; boundary-crossing and other ineligible calls remain in the
ledger. This workflow does not discover new footprints or subdivide calls.

## Stages and controls

| Stage | What it does | User controls |
| --- | --- | --- |
| Native input | Use existing calls, or explicitly rerun the upstream decoder | Replay switch; chemistry-specific LLR; MAPQ; MSP/opportunity criteria; legacy tag frame; DddA mCG conditioning |
| Native family fits | Propose shared native-edge-cell cohorts of actually overlapping calls, then fit and score on native lattices | Initial proposal allowance (default ±2 bp) |
| Shared-family fits | Fit common physical geometry across nominated original hypotheses | Physical edge variation (default ±10 bp; ±5 bp is finer); Automatic metadata-derived scope |
| Consolidated hypotheses | Reuse direct native evidence to consolidate common explanations | Inspect this stage or stop here; no extra radius or refit |
| Final families | Resolve redundant selected representatives and exact fit aliases | Inspect final catalog; no recursive fuzzy merging or extra simulations |

CR keeps different measurement strands separate. SR combines them within each
dataset. XCR combines the selected datasets using each observation's own lattice
and emission probabilities. HiA5 alignment directions are pooled in every mode.

The reference numerical policy is fixed and recorded: 4,095 predictive draws,
10 physical-molecule-excluded scoring folds, a 99.9% compatibility reference,
100 fitting iterations with a 500-iteration retry, and a 2-bp initial scoring
floor. Shared-parent fits have **zero additional matching floor**. These are not
the legacy panel's membership-odds, GMM, rescue, or boundary-normalization controls;
those controls are hidden in the staged interface. CPU count, matrix memory, and
maximum locus span are explicit computational budgets, not read or family caps.
Switching to the staged preset resets obsolete hidden settings. Unsupported
nondefault legacy controls are rejected rather than silently ignored. The receipt
records bounded initial scoring at 2 bp explicitly, separately from the physical
parent allowance.

Turn consolidation off to stop after shared-family fitting, or on to include
consolidation and final representative resolution. Completed stages remain
inspectable in the collapsed stage panel. Only the final CR read layer is enabled
by default. Saved-list population is explicit through the selected-family or all-family
buttons. The Browser reuses exact checkpoints within the session; a compute
cache directory keeps them reusable across server restarts.

| Change | Work repeated |
| --- | --- |
| Inspect another completed stage; manual merge/split | No fitting or simulation |
| Continue from parents to consolidation/final resolution | Cached fits and scores; only annotation, resolution and view assembly |
| Change shared physical edge variation | Shared parent fits/scores; native fits and foreign-child scoring reused |
| Change CR/SR/XCR grouping | Native source fits reused; changed comparison scopes evaluated |
| Change initial proposal allowance, LLR calls, observations, probabilities or locus | Changed native sources and dependent comparisons recomputed |
| Change worker count/memory budget | Existing exact scores reused; execution scheduling only |

Checkpoints include complete native-source fits/scores, each cross-source scoring
block, and each individual shared-parent fit with all its recipient scores.
Dependencies cover source content, geometry controls, implementation hashes and
numerical-library identity. Integrity is checked before reuse. There is no
geometry-only score reuse and no reduced draw count. Successful work from cancelled
jobs remains cached; partial task files are not accepted. The completed-stage view
reports reused blocks and new work. Cancellation retains the previously installed
layers. Native-source checkpointing completes at a channel boundary; its underlying
fit cache may also preserve fits from an interrupted channel.

Shared-parent tasks and foreign-source scoring blocks run in bounded independent
worker processes with single-threaded BLAS. Seeds, excluded-molecule folds, reference
kernels and final ordering are unchanged. Structured progress counts completed tasks
and stays cancellable while a shared fit is running. Live progress is work completed,
not an estimated percentage of total runtime. Memory budgets limit simultaneous
matrix work; they do not thin observations or hypotheses and are not a total-server
RSS limit.

## Reading and editing the map

The hypothesis bar shows fitted mean edges. Pale boxes show conditional 95% edge
uncertainty; dashed boxes show the allowed physical edge ranges. Read bars retain
the original LLR spans. Multiple colors indicate multiple compatible hypotheses,
not fractional abundance. Selecting any compatible hypothesis highlights the call.
Gray means no active assignment, not absence of an original footprint.
Track counts use all compatible original calls, including ambiguous memberships.
The retained native primary label (or deterministic fallback) is display-only,
not an exclusive abundance assignment. Shared XCR links identify a common fitted
hypothesis; they do not assert equal detection power or quantitative comparability.

Ctrl/Command-click hypotheses or select their checkboxes, then merge, split,
ignore or unignore. Splits partition original-call memberships by length, start,
end, or explicit call IDs; they never cut a physical footprint. Unselected
compatible alternatives remain available. Redundant manually replaced hypotheses
are hidden from the curated track, with automatic calls and evidence retained.
Undo, redo and reset operate on revisioned manual history.
Independent manual groups can also share calls. Ignoring one family leaves other
compatible labels intact; only calls with no remaining displayed label turn gray.

For staged XCR, manual edits operate on shared class IDs across all datasets as
one edit. Each dataset displays only its own original-call members. Earlier stages
are read-only: return to the final computed stage before editing.

“Download frozen result + provenance” includes all completed stage views and the
manual history, including the redo branch. Import checks the original source
fingerprints and catalog identity, then validates edits by replay before installing
them. The original automatic result file is not rewritten by curation.
Repeated stage-evidence subtrees are stored once in a content-addressed pool and
expanded on demand, with hash checks and explicit expansion limits. This is
lossless storage, not evidence pruning. Full native arrays remain in the local
evidence/source artifacts rather than being copied into every stage view.

## Implementation and validation

The runtime is `fiberhmm.inference.consensus.harmonized_families` in
FiberHMM. It has no runtime dependency outside FiberHMM. Sixteen reference
modules were extracted at symbol level from the accepted native fitting,
density-cell nomination, bounded parent, cached consolidation and representative
resolution code. `reference/SOURCE_MANIFEST.json` records the extraction. The
maintainer tools `promote_harmonized_reference.py --check` and
`check_staged_reference.py` verify the port and run the original regression tests
against the extracted functions.

Fresh-locus initialization uses the explicitly versioned common-native-cell
proposal adapter. It does not load the historical
NAPA/UBA1 seed catalogs. The reference kernel regression tests establish that the
fitting/consolidation code was preserved, not that a different initial catalog
must reproduce every historical family count. Fresh full-locus validation is
tracked separately from Browser interaction tests.

Regression coverage includes unchanged calls, real MC execution, empty inputs,
HiA5 pooling, duplicate-molecule rejection, CR/SR/XCR transport, stage selection,
ambiguous curation memberships, shared-dataset edits, history replay and rendering.
The `staged-families.spec.ts` end-to-end test uses an explicitly synthetic BAM and
a real Browser server: it runs inference from the panel, inspects stages and edge
ranges, merges/splits/undoes, and exports. It is not a biological benchmark.
