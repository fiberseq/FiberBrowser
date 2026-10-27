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
