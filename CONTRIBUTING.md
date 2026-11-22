# Contributing to FiberBrowser

This repository is the source for every FiberBrowser release. All analysis features,
tests and documentation ship together; there is one public build and update channel.

## Feature modules

NFRs and Synchronise regions register through `browser/lab/pack.py` and
`browser/frontend/src/lab/fiberbrowser-pack.ts`. The `lab` paths, pack name and
session keys remain stable so existing sessions, undo history and saved analyses
restore without migration. They no longer define a separate build.

Use the extension points in [ARCHITECTURE.md](ARCHITECTURE.md) for panels, tracks,
feature kinds, session state and analysis preferences. Keep feature-specific tests
beside their source, in `tests/lab_tests/`, or in `browser/frontend/tests/e2e/lab/`.
All of these tests run in the normal release suite.

## Python client and headless support for every feature

Every user-facing feature ships with Python client and headless support, or with an explicit, tested refusal
that says what to do instead. The drift tests enforce this:

- `browser/frontend/src/hooks/useLiveFigureState.parity.test.ts`: every frontend field the headless figure engine
  reads is saved and pushed live, and every saved session field is drawn by the engine or listed as not drawn, with a
  reason.
- `browser/frontend/src/features/metaLocus/headlessCoverage.test.ts` and `tests/test_headless_meta_locus_drift.py`:
  every meta-locus and Quantify setting the browser saves is handled by the headless path (figures, re-clustering,
  `quantify_window`) or listed as not drawn, with a reason. The rows hidden on a meta-locus match the browser's.
- `browser/frontend/src/features/windowQuant/pythonTwinGolden.test.ts` and `tests/test_window_quant_twin.py`: the
  Quantify engine and its Python twin compute the same golden table.
- `tests/test_notebook_figure_settings.py`: every notebook setting reaches a figure or says why it does not.
- `tests/test_jupyter_api_docs.py`: every public `BrowserClient` method is documented in `docs/jupyter-api.md`.

When you add a setting, a panel or a number, extend the Python side in the same change, or list the field in the
matching table with its reason. A chart that only the browser draws refuses headless requests with a message
(`BROWSER_ONLY_TRACKS` in `browser/services/figure/api.py`), and a test checks that refusal.

## Validation

From `browser/frontend`, run `npm run build`, `npm run test:run` and
`npm run test:e2e:release`. From the repository root, run
`python -m pytest tests -m "not integration" -q -p no:cacheprovider`.

Before a release, run every e2e spec with
`FIBERBROWSER_TEST_FASTA=/path/to/hg38.fa npm run e2e:full` (an indexed hg38,
two test ports, a scratch HOME and its own build; see
`browser/frontend/tests/e2e/README.md`).

The old public-tree exporter and held-back-word check are retired. Build directly
from this checkout. Both packaging smoke checks require the NFR and Synchronise
modules. Use a fresh output folder for each app build.

The shared lab-server profile and read-only public-server profile still control
access to host files, processes and analysis jobs. Classify routes and preserve
those authorization checks when adding features.
