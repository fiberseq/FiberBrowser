# FiberBrowser end-to-end tests

Playwright-based tests that drive the full stack: a real Python FiberBrowser
server spawned with a test BAM, and a real Chromium instance driving the UI
and API.

## Running

```bash
cd browser/frontend
npx playwright install chromium   # once

# The maintained release specs (what CI runs nightly), on the tracked demo BAM
npm run test:e2e:release

# Every spec in this folder (the perf benchmarks and the local-BigBed spec skip
# unless configured)
npm run test:e2e

# Both build the frontend first so the Python server serves the current source
# rather than a stale `dist/` bundle.

# Interactive UI runner (great for debugging)
npm run test:e2e:ui

# Watch tests run in a visible browser window
npm run test:e2e:headed

# Run one spec file
npx playwright test smoke.spec.ts

# Run one test by name
npx playwright test -g "quality filters endpoint"
```

## The whole suite, locally: `npm run e2e:full`

```bash
cd browser/frontend
FIBERBROWSER_TEST_FASTA=/path/to/hg38.fa npm run e2e:full            # every spec
FIBERBROWSER_TEST_FASTA=/path/to/hg38.fa npm run e2e:full -- tour    # some specs, any playwright arguments
```

`scripts/e2e-full.sh` is the one documented way to run every spec on a
developer machine. It:

- **needs an indexed hg38 FASTA** in `FIBERBROWSER_TEST_FASTA` (the file and
  its `.fai`; any hg38 with chr19 and chr3, e.g. UCSC's `hg38.fa`). The demo BAM
  is on chr19 and the pangenome specs are on chr3; a chr3-only FASTA puts the
  demo specs on the wrong contig and raises the genome-mismatch banner. Tests
  never download hg38, and the script stops without one;
- uses **two test ports**, `FIBERBROWSER_TEST_PORTS=8880,8881` unless you set
  it. Specs that run two servers at once (`public-server`'s busy-port test,
  `session-links`) call `requireTestPorts(2)` and skip, saying so, when only
  one port is listed;
- **builds the current source into its work folder** and serves that build
  (`FIBERBROWSER_FRONTEND_DIST`), so the tracked `dist/` is never rebuilt and
  there is nothing to restore afterwards;
- gives the servers a **scratch HOME** in the work folder, so they never read
  or write `~/.fiberhmm` (its genome cache included). Playwright's browsers and
  Python's user site stay where they were;
- sources `FIBERBROWSER_E2E_ENV` first when set: a file outside the repository
  for machine-specific data (the graph helper and packages, the pg-lift data,
  dm6 BAMs). Specs whose data is not configured skip with the reason.

`FIBERBROWSER_E2E_WORK` names the work folder (default: a new temporary
folder); results, traces and screenshots are in its `results/`. A full run
takes about 1–1.5 h. Specs that need optional data skip with the reason; the
list is in the table below.

| Skips unless configured | Needs |
|---|---|
| `graph-*`, `live-lift`, `diffmatch-gates` | `FIBERBROWSER_TEST_GRAPH_HELPER`, `FIBERBROWSER_TEST_GRAPH_PACKAGES`, `FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE`, `FIBERBROWSER_TEST_LIFT_{BAM,NATIVE,MAP}` (and `FIBERBROWSER_TEST_GRAPH_GENERALITY_PACKAGES`, `FIBERBROWSER_TEST_GRAPH_LIFT_GENERALITY` for `graph-generality`) |
| dm6 specs (`panel-genomes`, `cluster-panel-genomes`, `export-panel-genomes`, `palette-panels`, `regions`, `regions-two-references`, `startup-mixed-genomes`, `ui-export-figure`'s two-reference test) | `FIBERBROWSER_TEST_DM6_BAM` (and `_2`; they were written against a lab dm6 amplicon BAM that is not public) and dm6 + hg38 cached in `~/.fiberhmm/genomes`, which the scratch HOME never has: they run only from `npm run test:e2e` with your own HOME |
| `export-read-ink` deep BAM, streamed exports | `FIBERBROWSER_TEST_BAM` (a deep BAM; it also becomes the default BAM of unpinned specs) |
| `export-read-ink` BigBed, `bigbed-local` | `FIBERBROWSER_TEST_BIGBED` |
| `s3-remote` | `FIBERBROWSER_TEST_S3_ENDPOINT` (a local S3-compatible server) |
| `signal-filter` | `FIBERBROWSER_SIGNAL_DATA` |
| `performance` | `FIBERBROWSER_RUN_PERF_E2E=1` (benchmarks) |
| `panel-rail` screenshots, `graph-panel` measurement traces | `FIBERBROWSER_RAIL_SCREENSHOTS`, `FIBERBROWSER_GRAPH_MEASURE_OUT` (they only write pictures or measurements) |

**No native file dialogs.** On a desktop, `/api/pick_file`, `/api/pick_folder`
and `/api/pick_file_primer` open a real dialog on your screen. Every browser
context a spec gets answers those requests itself with "cancelled"
(`fixtures/nativeDialogs.ts`), so import `test` from `./fixtures/server` or
`./fixtures/nativeDialogs`, never from `@playwright/test`, and call
`blockNativeDialogs(context)` on a context you make with `browser.newContext()`.
A spec that tests a picker mocks it with `page.route`, which wins.

The spawned servers run `python browser.py --no-token` from the repository
root (set `FIBERBROWSER_TEST_PYTHON` for another interpreter; it needs
FiberHMM importable). They never read `~/.fiberhmm/browser_settings.json`
(the fixture points `FIBERBROWSER_SETTINGS` at a missing file) and list
themselves in a scratch runtime file.

## Test data

By default every spec runs on the demo BAM tracked in the repository,
`browser/data/demo/napa_ddda.bam` (3,202 DddA reads on chr19; default region
`chr19:47514000-47518000`), so a fresh clone needs no other data.

Point `FIBERBROWSER_TEST_DATA_DIR` at a directory with the lab's
`fly_lab_data` layout (or its parent) to use its richer DAF-seq BAM
(`Datasets/DAF-seq/daf_timecourse/fp_update/stage_d_recalled.bam`, region
`chr2R:9929319-10029319`) and Fiber-seq BigBeds instead. `tests/conftest.py`
reads the same variable for the backend integration tier
(`pytest -m integration`).

Specs whose assertions depend on the data pin themselves to the demo BAM with
`test.use({ fixtureBam: 'demo' })` (`release-consensus`, `release-v1-workflows`,
`tour`); `staged-families` generates its own synthetic fixture with
`tests/make_staged_demo_bam.py`. `sv-display` does the same with
`tests/make_sv_demo_bam.py` (a 1.5 kb deletion, a 400 bp insertion, split reads).

`tour.spec.ts` walks the whole guided tour in its sandbox tab (about five
minutes: the tour clusters and finds the footprint classes) and fails when a
step no longer finds its control. `scripts/capture-tutorial-screenshots.mjs`
walks it the same way to make the user guide's screenshots.

`public-server.spec.ts` starts its own `--public` server with the demo catalog
(`deploy/demo/catalog.json`) and checks what an anonymous visitor sees: the page
under the public Content-Security-Policy, the catalog's reads, a motif-only
Tracks panel, and the refusals (API docs, uploads, track URLs, host files).

Override with env vars:

```bash
FIBERBROWSER_TEST_BAM=/path/to/your.bam npm run test:e2e
FIBERBROWSER_TEST_REGION=chr2R:9929319-10029319 npm run test:e2e
FIBERBROWSER_TEST_BIGBED=/path/to/standard_fiber.bb npm run test:e2e
FIBERBROWSER_TEST_BIGBED_DIR=/path/to/standard_fiber_dir npm run test:e2e
FIBERBROWSER_TEST_PORTS=8880,8881 FIBERBROWSER_TEST_PORT=8880 npm run test:e2e   # the ports test servers may use; the preferred one
FIBERBROWSER_E2E_CORES=4 npx playwright test release-consensus   # consensus job cores (default 2)
```

## Structure

- `fixtures/server.ts` — Playwright fixture that spawns an isolated backend
  per test (`python browser.py -b <bam> -p <port> --no-open --no-token`),
  waits for `/api/status`, and tears it down after the test completes.
- `smoke.spec.ts` — server starts, UI loads without console errors (and no
  failed `/api/sequence` requests), basic endpoints return valid responses.
- `layers.spec.ts` — v3 BAM layer discovery (`available_layers` in API),
  quality filter endpoint contract, UI shell + canvas render.
- `workflow.spec.ts` — multi-step pipelines: scan_peaks with FIRE/MSP source,
  cluster_all with FIRE/MSP-compatible mode (regression guard against
  no-data-sentinel + compact-path-routing bugs), quality filter propagation
  to working set.
- `reproducibility.spec.ts` — session/reproducibility controls, peak locks,
  seeded settings, and browser state persistence guards.
- `release-panels.spec.ts` — analysis strip panels open/close, toolbar peak
  scan/lock/rules (Analysis Rules > Peaks), co-accessibility refresh.
- `release-v1-workflows.spec.ts` — 1.0 workflows: Quality group, saved size
  ranges (filter, auto names, undo), membership clustering, + Add source,
  history timeline, too-narrow panels.
- `release-consensus.spec.ts` — footprint classes with the lattice recaller:
  find, class × channel table, TSV and plot, saved classes with tiers and
  Filter reads, co-occupancy, session save/restore, tagged BAM export.
- `staged-families.spec.ts` — the deprecated staged Monte Carlo engine.
- `ui-controls.spec.ts`, `ui-scale.spec.ts`, `ui-export-panels.spec.ts`,
  `ui-export-scale.spec.ts` — real UI clicks for read display, settings,
  navigation and layer toggles; UI scaling; full-UI export.
- `bigbed-local.spec.ts` — optional local standard Fiber-seq BigBed smoke
  test; skips automatically when the configured BigBed fixture is absent.
- `performance.spec.ts` — benchmarks, `npm run test:e2e:perf` only.

One-off live-inspection scripts that need a running browser with a completed
lab-data run live in `scripts/inspection/` (not run by `npm run test:e2e`).

## When to add a test

**Add a spec when a bug bites twice.** The workflow tests today include
explicit regression guards for two bugs we hit during v2 dev:

- "Clustering collapsed to a single mega-cluster" → `cluster_all` test
  asserts `Object.keys(cluster_counts).length > 1`. This catches both the
  no-data sentinel (2.0 leaking into features) and compact-path routing
  regressions.
- "Quality filter doesn't affect analytics" → `quality_filters` test
  asserts `afterTf <= beforeTf`. This catches cases where the filter is
  accepted but not actually applied at working-set construction.
- "Reproducibility/session state drift" → `reproducibility.spec.ts` checks
  that seeded settings and browser state survive the frontend/backend round
  trip instead of only updating visible controls.
- "Toolbar action does not reach the backend" → `release-panels.spec.ts`
  clicks the real Peak Scan control and waits for `/api/scan_peaks`, catching
  handler-wiring bugs before release.

**Prefer API-level assertions over DOM assertions.** The UI is canvas-heavy
and the sidebar has collapsible sections, so `getByText` selectors are
brittle. For confidence in behavior, drive the backend directly via
`request.post(...)` and assert on JSON responses. Use UI tests only for
rendering smoke checks or user-flow coverage.

**Use stable test hooks for real UI flows.** If a user-facing control is worth
testing through Playwright, add a narrow `data-testid` and ARIA state rather
than selecting Tailwind classes or canvas internals.

## Tips

- `trace: 'on-first-retry'` is enabled — failed runs leave a `trace.zip`
  in `test-results/` that you can open with `npx playwright show-trace <path>`.
- Tests run serially (`fullyParallel: false`, `workers: 1`) to avoid competing
  for local CPU/disk while the fixture still gives every test a clean backend.
- The backend logs pipe through to stderr with `[server]` prefix so you
  can see what the server is doing in the Playwright output.
