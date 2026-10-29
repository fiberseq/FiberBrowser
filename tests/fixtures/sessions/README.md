# M1 session corpus

All six files are synthetic format `2.0` sessions. They contain no biological records or machine-specific paths.

The existing `browser/frontend/tests/e2e/fixtures/session-3.0.x.json` was the only complete saved-session JSON fixture found. Its display-default schema was inspected, then reduced to the analysis state needed here. The release schema was checked with `git show` against **24c7a5c58** (FiberBrowser 3.0.1), including `api/session.ts`, `stores/historySlice.ts`, `types/index.ts`, the built-in panel registrations and the NFR cart schema. The later graph/Differences entry uses the pre-M1 schema at **13f19f21f**.

| File | Coverage |
| --- | --- |
| `301-core-panels.json` | Dataset and all 16 core analysis/view panel kinds, plus the lab Synchronise panel |
| `301-variants.json` | Variants, saved SNP call/selection, SV insertion selection, insertion lens |
| `301-carts.json` | Find classes and Accessibility panels, class cart, NFR cart, both legacy feature refs |
| `301-peaks-history.json` | Rule/custom peaks, selections, per-peak modes, peak lock, cluster tree, saved clustering and an undo snapshot |
| `301-feature-split.json` | A dataset split defined by legacy class features |
| `30x-graph-differences.json` | Graph and Differences panels from the later pre-M1 build |

That covers 21 fixed panel kinds present in the 3.0.1 core/lab registrations, and the two later panel kinds. Arbitrary external Python-plugin panels are not enumerated.

`tests/test_hub_migration.py` also builds two sessions at test time: a real synthetic lattice-recaller result exported through the release endpoint, and a frozen NFR result with a deliberately empty scoring population. These exercise the compressed `consensus_runs` and `accessibility_runs` blocks in both directions. Existing class-run and Accessibility session tests cover populated scoring membership, source validation, filters and run restoration.

Frontend tests use `src/api/__fixtures__/session301.ts`, a test-only copy of the actual release importer with relative imports adjusted. They compare restored panel objects and peak controls, then restore new-build exports through that importer. Supporting modules are supplied by the current test harness; this does not substitute for testing the released application. Backend tests load the frozen release endpoint source in `session_endpoint_301.py` in memory (so shallow clones also work) and compare its restore result with the new endpoint.

The corpus is also ready for the coordinator's browser restore checks. No e2e or port-bound tests were run for M1.

For browser tests, bind `/data/sample.bam` to an isolated synthetic BAM with a `chrT` header (at least 10,000 bp); an empty BAM is sufficient for panel/state restore checks. The runtime class/NFR corpus cases build their own sources and compressed run payloads. The later graph/Differences fixture is tested against its pre-M1 panel schema, not as a promise that those later panels exist in 3.0.1.
