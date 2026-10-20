# Differences e2e expectation fixes

Starting revision: `37f893b5b`, branch `feat/differences`.

The four supplied error contexts stop at expectations superseded by deliberate
product changes. The application retains the carrier groups and read data.
The specifications now follow the documented contracts rather than reverting
the evidence policy, assembly labels or deferred read loading. No production
behavior was changed for these failures.

## Root causes and fixes

| Failing test | Root cause in the application path | Fix and retained behavior |
| --- | --- | --- |
| `live-lift.spec.ts:23` | `features/differences/selectionStore.ts`, `expandDifference`, labels shared columns with their assembly source and both ref/alt spans: `Assembly MAT · 0→2,353 bp`. The spec still required the former sample-specific `+length` label. Its later SNV action also assumed a single click opened inspection and eagerly decoded reads; `DifferenceLanes` now selects on click and inspects on double click, while `AssemblyInspection` waits for an explicit observations request. | Assert the assembly/span label; check that a single click only selects, then double click and request observed bases/chromatin. Keep MAT/PAT payload, insertion-call, Identify, navigation and co-clustering assertions. |
| `split-sv-carriers.spec.ts:113` | `utils/svAlleleSplit.ts`, `evidenceGroupLabels`, replaces the unqualified `Carriers` label with the selected evidence tiers and their counts. The artifact contains `Confirmed (9) + putative (0)` and the expected expanded-insertion note; the group was present. | Assert the evidence label in the dialog, expansion note and resulting panel title. Keep expansion, clustering, off-locus banners, Go back, close and Library reopening checks. |
| `sv-display.spec.ts:43` | `read-track/svDrawing.ts`, `describeSvCluster`, inserts `confirmed` into the support description and lists weaker tiers separately. The spec's contiguous `13 of 21 informative` text therefore no longer matched. The later cluster-name assertion used the old carrier label too. | Assert `13 confirmed of 21 informative`, separate putative/conflicting counts and the evidence-labelled group. Keep the independently expected summary and split counts `[13, 8, 3]`, canvas support gate and pan checks. |
| `insertion-lens.spec.ts:31` (also fails on the SV base) | `services/sv_events.py`, `classify_allele_evidence`, classifies clips compatible with multiple seeded alleles as ambiguous. This fixture has a 2 kb allele and a competing 300 bp allele. All three clips are ambiguous, not confirmed carriers. `support`/`clip_support` count confirmed support; `informative` is confirmed plus reference. The lens preserves all evidence rows but draws/splits only selected tiers. | Expect 24 confirmed, 16 reference and 3 ambiguous; confirmed fraction is `24/40 (60%)`. Check the default confirmed+putative policy with conflicting/ambiguous excluded and exact split membership `[24, 16, 5]`. Explicitly opt into ambiguous evidence to inspect the hard clip and obtain `[27, 16, 2]`; verify that confirmed counts stay unchanged and the opt-in survives reopening. |

These policies are described in [read-derived SV evidence](reference/sv-evidence.md)
and [the Differences workspace](DIFFERENCES_WORKSPACE.md). Historical split
policies continue to retain their saved semantics.

## Added regression coverage

- `differences.render.test.tsx`: single click, double click and explicit read
  loading; shared assembly labels across three panels, per-parent lengths and
  the clicked parent's Identify target.
- `svAlleleSplit.test.ts`: evidence labels, exact read memberships and per-read
  tiers survive the split-panel preview and panel creation.
- `InsertionLensPanel.identity.test.tsx`: actual rows passed to the renderer
  change from 24 to 27 only on ambiguous opt-in; confirmed counts remain stable,
  the split receives the selected policy and the lens is not refetched.
- `test_insertion_lens.py`: the actual synthetic BAM's summary, lens and splits
  are checked against authored fixture memberships, including default exclusion
  and explicit ambiguous inclusion.

## Validation

Validation logs are external driver artifacts under `scratch/e2e-fix`.

- Related Python suites: **90 passed** (`test_insertion_lens.py`,
  `test_sv_evidence_levels.py`, `test_sv_shared_evidence.py`).
- Production TypeScript: `npx tsc --noEmit` passed. All four e2e specs also
  transpile with esbuild. An additional standalone e2e type-check attempt could
  not run because this dependency installation lacks `@types/node`; it did not
  change dependencies.
- Vite production build passed with the requested external `frontend-dist`
  output and `--emptyOutDir`. Existing chunk-size/import warnings remain.
- Playwright was not run and no server was started. The updated e2e flows still
  require the orchestrator's browser rerun.

The initial full Vitest run passed 3,951 tests and skipped one, with one failure
in the unchanged `ReopenLastSession.test.tsx` autosave startup-window check.
That complete 29-test file passed in isolation. Its check depends on the
module's 15-second startup window, which can expire under concurrent suite
load. Final reduced-concurrency results are recorded below.

Final full run: `npx vitest run --maxWorkers=4` passed **all 564 files,
3,952 tests**, with **one existing skipped test** (`vitest-final.log`). The
configuration override only relocates the Vite/Vitest cache into driver
scratch. `git diff --check` and the added-text audit for private local paths
passed; there are no tracked worktree frontend `dist` changes.
