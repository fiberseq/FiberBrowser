# Live-inspection scripts

Playwright scripts used to inspect a real consensus run by eye (screenshots,
attached JSON) while the footprint-class UI was developed. They are not
repeatable tests: each needs a running FiberBrowser that already holds a
completed run on lab data, passed as an env var, and skips without it.

| Script | Needs |
|---|---|
| `consensus-progress-inspection` | `CONSENSUS_PROGRESS_UI` (Vite preview) + `CONSENSUS_PROGRESS_API` |
| `harmonization-inspection` | `FIBERBROWSER_HARMONIZATION_INSPECT` |
| `lattice-consensus-inspection`, `lattice-consensus-usability` | `FIBERBROWSER_CONSENSUS_INSPECT` |
| `lattice-consensus-live` | `FIBERBROWSER_CONSENSUS_LIVE` |
| `lattice-consensus-uba1` | `FIBERBROWSER_UBA1_INSPECT` |
| `native-*` | `FIBERBROWSER_NATIVE_CONSENSUS_INSPECT` |

Several were written for engines that are now deprecated (native/harmonized
families, staged Monte Carlo) and may no longer match the UI. The maintained,
self-contained footprint-class tests are
`browser/frontend/tests/e2e/release-consensus.spec.ts` (lattice recaller) and
`staged-families.spec.ts` (deprecated engine), run by `npm run test:e2e:release`.

Run one (from `browser/frontend`, so `@playwright/test` resolves):

```bash
cd browser/frontend
NODE_PATH=$PWD/node_modules FIBERBROWSER_CONSENSUS_INSPECT=http://localhost:8765 \
  npx playwright test -c ../../scripts/inspection/playwright.config.ts lattice-consensus-inspection
```
