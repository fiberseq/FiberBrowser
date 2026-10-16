/**
 * Settings → Show preview features (src/utils/previewFeatures.ts), on the synthetic insertion BAM
 * (tests/insertion_fixtures.py):
 * - off (the user's saved choice): the insertion lens and the Variants panel (both supported) are there, with no
 *   Preview mark; the Preview feature is not ("Open carriers with the insert expanded");
 * - on (the palette's toggle): it appears with its Preview badge, and the choice is kept by the server
 *   (analysis preferences: every port and build);
 * - a state that uses a Preview feature (an insert-expanded panel) with previews turned off: nothing is dropped, one
 *   line offers to turn previews on.
 */
import { test, expect, panelButton, type ServerFixture } from './fixtures/server';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VIEW = { chrom: 'chrT', start: 11_000, end: 19_000 };

test.use({
  fixtureBam: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fiberbrowser-preview-'));
    execFileSync(process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python',
      [path.join(REPO_ROOT, 'tests', 'insertion_fixtures.py'), dir], { stdio: 'inherit' });
    await use(path.join(dir, 'insertion.bam'));
  },
});

async function open(page: Page, server: ServerFixture) {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    if (!window.sessionStorage.getItem('fb-e2e-kept')) {
      window.localStorage.clear();
      // Off as the user's own choice: preserved across builds (the default is on: lab/preview-default.spec.ts).
      window.localStorage.setItem('fiberbrowser_show_preview_features', 'false');
      window.sessionStorage.setItem('fb-e2e-kept', '1');
    }
  });
  const firstReads = page.waitForResponse(r => r.url().includes('/api/reads/compact') && r.url().includes('chrT') && r.ok());
  await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
  await firstReads;
  await expect(page.locator('canvas[data-copilot-track="reads"]')).toHaveCount(1);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
}

/** The SV row's menu on its insertion (the one with the most support). */
async function svMenu(page: Page) {
  const svTrack = page.locator('canvas[data-testid^="sv-track-canvas-"]');
  await expect(svTrack).toHaveCount(1, { timeout: 15_000 });
  const reads = page.locator('canvas[data-copilot-track="reads"]');
  const box = (await svTrack.boundingBox())!;
  const sidebar = Number(await reads.getAttribute('data-track-sidebar')) || 0;
  const x = box.x + sidebar + ((15_000 - VIEW.start) / (VIEW.end - VIEW.start)) * (box.width - sidebar);
  await page.mouse.click(x, box.y + box.height / 2, { button: 'right' });
  const menu = page.getByTestId('track-context-menu');
  await expect(menu).toBeVisible();
  return menu;
}

async function togglePreviews(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.getByTestId('command-palette-input').fill('preview features');
  const toggle = palette.locator('[role="option"][data-palette-item="toggle:view.preview-features"]');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.keyboard.press('Escape');
}

test('Show preview features: off hides the Preview entry points, on shows them with badges, and the server keeps it', async ({ page, server }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page, server);

  // Off: the lens and Variants (supported, no Preview mark), not the Preview feature.
  await expect(panelButton(page, 'insertion-lens')).toBeVisible();
  await expect(panelButton(page, 'variants')).toBeVisible();
  await expect(panelButton(page, 'variants').getByTestId('panel-rail-preview-badge')).toHaveCount(0);
  let menu = await svMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Open this insertion in the lens' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Open carriers with the insert expanded/ })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: /^Variants/ })).toBeVisible();
  await expect(menu.getByTestId('preview-badge')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // On: the SV row's Preview item with its badge; Variants still without one.
  const saved = page.waitForResponse(r => r.url().endsWith('/api/preferences/analysis') && r.request().method() === 'PUT' && r.ok()
    && JSON.parse(r.request().postData() ?? '{}').show_preview_features === true);
  await togglePreviews(page);
  const put = await saved;
  expect(JSON.parse(put.request().postData() ?? '{}')).toMatchObject({ show_preview_features: true });
  const kept = await (await page.request.get(`${server.baseUrl}/api/preferences/analysis`)).json();
  expect(kept.show_preview_features).toBe(true);
  await expect(panelButton(page, 'variants').getByTestId('panel-rail-preview-badge')).toHaveCount(0);

  menu = await svMenu(page);
  await expect(menu.getByRole('menuitem', { name: /Open carriers with the insert expanded/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Variants/ })).toBeVisible();
  await expect(menu.getByTestId('preview-badge')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // The Variants panel: no Preview mark, its known limitations (local patterns, not phasing).
  await panelButton(page, 'variants').click();
  await expect(page.getByTestId('variants-panel')).toBeVisible();
  await expect(page.getByTestId('analysis-panel-header-variants').getByTestId('preview-badge')).toHaveCount(0);
  const limits = page.getByTestId('variants-limitations');
  await expect(limits).toBeVisible();
  await limits.getByText('Known limitations').click();
  await expect(limits).toContainText('local read-supported patterns');
  expect(errors).toEqual([]);
});

test('a state that uses a Preview feature, with previews turned off: kept, with one line to turn them on', async ({ page, server }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page, server);
  await togglePreviews(page);
  const panelId = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.contentType === 'dataset').id);
  // An insert-expanded panel (the panel's menu: Show insert expanded).
  const opened = page.waitForResponse(r => r.url().includes('/api/alt_allele/open') && r.ok());
  await page.getByTestId(`panel-actions-${panelId}`).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show insert expanded (carriers only)' }).click();
  await opened;
  await expect(page.getByTestId('alt-allele-chip')).toBeVisible();

  await togglePreviews(page);
  const prompt = page.getByTestId('preview-session-prompt');
  await expect(prompt).toContainText('Insert-expanded panels');
  // Nothing dropped: the panel is still insert-expanded.
  const alt = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.contentType === 'dataset')?.altAllele ?? null);
  expect(alt).not.toBeNull();

  await page.getByTestId('preview-session-enable').click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId('alt-allele-chip')).toBeVisible();
  expect(errors).toEqual([]);
});
