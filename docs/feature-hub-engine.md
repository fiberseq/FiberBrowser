# Browser scan engine consolidation

New native BAM lattice-recaller classes and NFR jobs execute through
`fiberhmm.scan.run_units`, using adapters derived from `FpModule` and `NfrModule`.
Their scan tables live in `execution-scan` beside the original result artifacts.
The job routes, ids, exports, session blocks, activation, display filters, scoring
populations and curation still use the original result shape.

`services/scan/legacy_execution.py` is the shared execution adapter. The browser
loads evidence once, including signal predicates, machine caps and any reused
class evidence. The adapter passes that population and the original parameters
through the module's inference workflow and table converter. It does not invoke
the module's BAM loader a second time. Fresh capped payloads retain FiberHMM's
stateful top-up hook; a copied hook cannot serve as an independent parity run.
Tests therefore load each comparison's BAM population independently.

This also preserves supplied NFR regions and class co-accessibility inputs, which
the stock automatic-detection scan entry point refuses. Prepared NFR execution
publishes hit-bound states but does not add whole-record scalar rows from the
unfiltered source BAM. Population digests, parameters and loader receipts enter
the scan's module settings. These browser scans describe browser selection;
they do not promise identical scan ids to unrestricted CLI scans.

Molecule peak scoring for `accessibility` and `tf_density` uses `PeaksModule`'s
stitcher through `run_units`. The browser still selects the cohort, applies read
and strand filters, joint deduplication and sampling, and supplies its exact
per-base counts. Cached counts and directly loaded rows use the same stitcher.
The short-lived scan directory is removed after the endpoint response is built;
the existing per-rule peak cache remains the display source.

The default Rare tier is the owner's local rule: 8% with `min_reads` covering
each base, without the window read-count threshold. The request's
`tier_rule: "window"` preserves the old rule for one release, and
`execution_engine: "legacy"` selects the entire old peak scoring path. Both are
also optional `PeakDetectionSettings` fields in the frontend API. A legacy-engine
request uses the window rule. View/BED cohorts retain the browser's row policy;
grid scans retain the package's owner-approved `records` default, including
primary and supplementary records.

The migration facade still projects the currently curated view and resolves
states through the job's original scoring population. Its manifest links to a
new job's execution scan, and its frontend provenance identifies scan execution.
It keeps stable legacy feature identities so manual groups, ignored classes,
selections, carts and session dual-write are unaffected. Restoring a frozen run
does not reconstruct or require its execution directory.

## Backend parity gates

`tests/test_scan_engine_consolidation.py` compares:

- Capped and uncapped footprint results, class/molecule exports and browser
  indexes on planted evidence, synthetic called BAMs and the bundled demo BAM.
- Capped and uncapped NFR results and all five data exports, with detected and
  supplied regions; real BAM results also pass through the migration facade.
- Exact peak scores, smoothed signals, tiers, broad calls and layer summaries
  with the window compatibility rule, plus local-rule equivalence to FiberHMM.
- The local Rare change and its minimum local coverage; the grid record policy
  versus the legacy view policy on supplementary records.
- Filtered endpoint cohorts, bundled demo peaks, actual job submission through
  the scan runner, and curated/ignored/manual class facade mappings.

Result comparisons exclude only elapsed `seconds` fields. Data exports are
compared after decompression; compression headers and execution times are not
biological output. Session and curation regressions remain covered by the
existing backend suites. No new biological difference is accepted beyond the
owner's local Rare and grid record rules.

## Paths retained and upstream needs

- Staged/native-distribution/harmonization class engines: `FpModule` only
  supports the lattice recaller. FiberHMM would need corresponding module
  settings, result conversion and feature/state declarations to migrate these.
- Oriented pooled class windows: the module assumes a single genomic scan unit;
  the browser retains its oriented evidence, window provenance and curation.
  FiberHMM would need an oriented pooled-unit contract to represent these.
- BigBed, live lifted, remote and aliased or circular inputs retain their browser
  execution paths. This adapter requires native local BAMs with identical
  reference headers and exact coordinates. Circular peak wrapping is not
  implemented by `PeaksModule`.
- FIRE, modification-density, arbitrary layer and external-track peaks retain
  browser scoring. The package peaks module supports only accessibility and TF
  density. Additional loaders/counting sources require FiberHMM work; arbitrary
  signal peaks are intentionally browser-owned under D13.
- Prepared evidence without corresponding BAM records and explicitly injected
  analysis runners retain compatibility execution. The scan runner's survey
  skips empty source units. Frozen session imports are never rescored.

No FiberHMM files were changed. No servers or e2e tests were run. Coordinator
checks: `release-consensus.spec.ts`, `lab/nfr-preview.spec.ts`,
`feature-hub.spec.ts`, `session-reopen.spec.ts`, `reproducibility.spec.ts`,
`workflow.spec.ts`, and `staged-families.spec.ts` under the frontend e2e directory.

## Final validation

| Check | Result |
| --- | --- |
| Backend consensus, Accessibility, peaks, scan, migration and session regressions | 372 passed; 6 integration/slow cases deselected |
| New backend parity cases (included above) | 25 passed |
| Existing browser/CLI scan matrix (included above) | 15 passed |
| TypeScript, local compiler with no emit | Passed |
| Full Vitest suite, two workers | 661 files passed; 4,883 tests passed; 1 skipped |
| Diff whitespace and added-text privacy checks | Passed |

The frontend skip is the existing fresh-projection fixture comparison in
`src/api/readRegionProfiles.test.ts`: `FIBERBROWSER_PROJECTION_FIXTURES` was not
configured. Python caches were confined to scratch directories. Changes remain
uncommitted on the supplied baseline.
