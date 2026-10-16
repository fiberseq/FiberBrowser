import { defineConfig, devices } from '@playwright/test';

/**
 * One-off live-inspection scripts (not tests): each drives an already-running
 * FiberBrowser that holds a completed consensus run, named by an env var, and
 * skips without it. Run from browser/frontend (for its node_modules):
 *
 *   cd browser/frontend
 *   NODE_PATH=$PWD/node_modules FIBERBROWSER_CONSENSUS_INSPECT=http://localhost:8765 \
 *     npx playwright test -c ../../scripts/inspection/playwright.config.ts lattice-consensus-inspection
 */
export default defineConfig({
  testDir: '.',
  timeout: 240_000,
  workers: 1,
  reporter: 'list',
  use: { screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
