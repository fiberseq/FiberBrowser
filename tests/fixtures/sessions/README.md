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

`browser/frontend/tests/e2e/session-migration.spec.ts` supplies the current-build browser gate for all six files. It clicks the toolbar Open button with `/api/pick_file` answered by Playwright, leaving session reading, file checks, import and export on the real backend. Every other native picker is blocked by the shared test fixture. It checks panel ids, kinds and rendered titles, peak selections/modes/lock, the absence of the error banner and uncaught page errors, and the downloaded session's legacy panels, carts, feature refs, split rules, SNP scan, peak controls and historical state. For the cart fixture it also opens the hub and checks one class row and one NFR row, each with a visible Pinned badge.

For browser tests, bind `/data/sample.bam` to an isolated synthetic BAM with a `chrT` header (at least 10,000 bp); an empty BAM is sufficient for panel/state restore checks. The runtime class/NFR corpus cases build their own sources and compressed run payloads. The later graph/Differences fixture is tested against its pre-M1 panel schema, not as a promise that those later panels exist in 3.0.1.

The frozen `30x` fixture's `differences` content kind is not registered as a standalone panel in the cited pre-M1 revision or the current build. Its browser assertion therefore checks the preserved generic `differences` header; the export assertion checks the original `differencesSession` under the migration bridge's `legacySnapshot`. This covers preservation of that synthetic entry, not rendering of a functional Differences panel. The registered `graph-view` panel is checked by its `Graph view` title.

## Coordinator browser commands

These browser checks have been added but have not been run in this worktree. The coordinator runs the commands below. Use a Python interpreter with the application's dependencies and `pysam`; replace `python` if necessary. Run from the repository root:

```sh
cd browser/frontend
export FIBERBROWSER_TEST_PYTHON=python
./node_modules/.bin/tsc --noEmit -p .
npm run build
./node_modules/.bin/playwright test tests/e2e/session-migration.spec.ts --project=chromium --workers=1
cd ../..
```

The spec starts one isolated backend per test using `fixtures/server.ts` and the configured test-port pool. It needs no external datasets. Setup creates and indexes an empty 10,000 bp `chrT` BAM with `pysam`, and replaces only the fixture's `/data/sample.bam` path in the session supplied to Open. It saves the UI downloads **before** opening any extra hub panel to `browser/frontend/test-results/session-exports/<fixture-name>.json`. Per-test screenshots and attached exports are in the normal Playwright output. The synthetic BAM and its index stay in `/tmp/fiberbrowser-session-migration-*/` so the release replay can use the same files; remove those directories after replay. Do not remove them between these steps or move the exports to a host that cannot access their BAM paths.

With an actual **3.0.1** application (revision `24c7a5c58`, including its release frontend and analysis panels) already running on the same host, use its URL below. The replay script never starts or stops a server and uses Chromium from the current worktree's `@playwright/test` dependency. It opens a fresh browser context, answers `/api/pick_file`, clicks Open, waits for import and rendered panels, writes the screenshot even when a gate fails, and prints JSON with `panelKinds`, panel ids/titles, `errorBanners` and import diagnostics. It exits nonzero for restore failures, panel mismatches, an error banner, or uncaught page errors. All other native pickers are cancelled. The server must be local and able to read the session JSON and the retained BAM. Supply any access token in the URL when needed.

One fixture, from the repository root:

```sh
export SESSION_REPLAY_URL=http://localhost:8887
node scripts/session_replay_301.mjs \
  --base-url "$SESSION_REPLAY_URL" \
  --session browser/frontend/test-results/session-exports/301-carts.json \
  --expect-panels dataset,footprint-analysis,accessibility \
  --out browser/frontend/test-results/session-replay-301/301-carts.png
```

All five 3.0.1 fixtures, checking the complete kind multiset (including repeated dataset panels):

```sh
for session in browser/frontend/test-results/session-exports/301-*.json; do
  kinds=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const s = JSON.parse(readFileSync(process.argv[1], "utf8")); console.log(s.frontend.panels.filter(p => !p.collapsed).map(p => p.contentType).join(","));' "$session")
  node scripts/session_replay_301.mjs \
    --base-url "$SESSION_REPLAY_URL" \
    --session "$session" \
    --expect-panels "$kinds" \
    --out "browser/frontend/test-results/session-replay-301/$(basename "$session" .json).png" || exit 1
done
```

Do not include `30x-graph-differences.json` in the 3.0.1 loop: that entry targets the later schema. To replay that export, point the script at an already running build with the pre-M1 graph support (the `differences` entry retains the generic header described above):

```sh
node scripts/session_replay_301.mjs \
  --base-url "$SESSION_REPLAY_30X_URL" \
  --session browser/frontend/test-results/session-exports/30x-graph-differences.json \
  --expect-panels dataset,graph-view,differences \
  --out browser/frontend/test-results/session-replay-30x/30x-graph-differences.png
```

`--out` defaults to `test-results/session-replay-301/<session-stem>.png` relative to the invoking directory. `FIBERBROWSER_PLAYWRIGHT_EXECUTABLE` can select an installed Chromium executable for either runner. The release replay reports render/error evidence; the e2e spec additionally verifies saved legacy state. Keep the replay reports/screenshots with the exported JSON when recording the final released-application M1 gate result.
