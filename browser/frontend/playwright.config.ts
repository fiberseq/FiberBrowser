import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for FiberBrowser end-to-end tests.
 *
 * Tests spawn a real FiberBrowser backend (python browser.py) with a test BAM,
 * then drive the UI in a real Chromium instance. Used for:
 * - Smoke tests (app loads, API responds)
 * - Layer-aware behavior (v3 toggles, overlay rendering)
 * - Analysis workflows (scan peaks → cluster → verify)
 * - Visual regression (canvas screenshots)
 *
 * Run: `npm run test:e2e`
 * Run with UI: `npm run test:e2e:ui`
 * Run specific file: `npx playwright test tests/e2e/smoke.spec.ts`
 */

const TEST_SERVER_PORT = Number(process.env.FIBERBROWSER_TEST_PORT ?? 8880);
const CHROMIUM_EXECUTABLE_PATH = process.env.FIBERBROWSER_PLAYWRIGHT_EXECUTABLE?.trim();

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,  // keep serial for local resource usage; each test gets an isolated backend
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${TEST_SERVER_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(CHROMIUM_EXECUTABLE_PATH
          ? { launchOptions: { executablePath: CHROMIUM_EXECUTABLE_PATH } }
          : {}),
      },
    },
  ],
});
