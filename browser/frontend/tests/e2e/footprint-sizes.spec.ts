/**
 * Footprint size enrichment without clustering: right-click the reads → "Footprint size enrichment here" opens
 * Clusters › Footprint sizes in the Size enrichment view, plotting the dataset from all its reads (group_by 'all');
 * one click switches to the V-plot; Export TSV saves the matrices with their settings. ⌘K finds it by name.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { readFileSync } from 'node:fs';
import { test, expect, DEMO_FIXTURE } from './fixtures/server';
import type { Page } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

const REGION = DEMO_FIXTURE.region;

async function openDemo(page: Page, baseUrl: string) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate((r: typeof REGION) => {
    (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end);
  }, REGION);
  const reads = page.locator('canvas[data-copilot-track="reads"]').first();
  await expect(reads).toBeVisible();
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  return reads;
}

const sizesRequest = (page: Page, match: (body: Record<string, unknown>) => boolean) =>
  page.waitForResponse(res => res.url().includes('/api/cluster/vplot') && match(JSON.parse(res.request().postData() || '{}')), { timeout: 90_000 });

test('right-click → Footprint size enrichment here, no clustering; switch to V-plot; export TSV', async ({ server, page }) => {
  test.setTimeout(180_000);
  const reads = await openDemo(page, server.baseUrl);
  expect(await page.evaluate(() => Object.keys((window as any).__FIBERBROWSER_STORE__.getState().clusterAssignments ?? {}).length)).toBe(0);

  const box = (await reads.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + 64, { button: 'right' });
  const menu = page.getByTestId('read-context-menu');
  await expect(menu).toBeVisible();
  const item = menu.locator('[data-action="footprint-size-enrichment"]');
  await expect(item).toContainText('Footprint size enrichment here');
  const first = sizesRequest(page, b => b.group_by === 'all');
  await item.click();
  const answer = await first;
  const req = JSON.parse(answer.request().postData() || '{}');
  expect(req).toMatchObject({ group_by: 'all', mode: 'span', normalization: 'row', raw_values: true, row_min_footprints: 20 });
  expect(req.sigma_size_bp).toBeGreaterThan(0);
  expect(req.sigma_pos_bp).toBeGreaterThan(0);
  const data = (await answer.json()).data as Record<string, Record<string, { n_reads: number; matrix: unknown[][] }>>;
  const all = Object.values(data).map(d => d['-1']);
  expect(all.length).toBe(1);
  expect(all[0].n_reads).toBeGreaterThan(0);

  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  const sizes = panel.getByTestId('footprint-sizes');
  await expect(sizes).toHaveAttribute('data-view', 'enrichment');
  await expect(sizes).toHaveAttribute('data-group', 'datasets');
  await expect(panel).toContainText('no clustering needed');
  await expect(sizes.getByTestId('footprint-sizes-plot').locator('canvas')).toHaveCount(1, { timeout: 60_000 });

  // One click to the classic V-plot (midpoints, counts on a sequential scale).
  const mid = sizesRequest(page, b => b.mode === 'midpoint' && b.normalization === 'raw');
  await sizes.getByTestId('footprint-sizes-view-vplot').click();
  await mid;
  await expect(sizes).toHaveAttribute('data-view', 'vplot');
  await expect(panel.getByTestId('vplot-caption')).toContainText('Midpoint');

  // Back to Size enrichment, then export the matrix with its settings.
  const back = sizesRequest(page, b => b.mode === 'span' && b.normalization === 'row');
  await sizes.getByTestId('footprint-sizes-view-enrichment').click();
  await back;
  await expect(sizes.getByTestId('footprint-sizes-plot').locator('canvas')).toHaveCount(1, { timeout: 60_000 });
  const download = page.waitForEvent('download');
  await sizes.getByTestId('footprint-sizes-export-tsv').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^footprint_size_enrichment_chr19_\d+-\d+\.tsv$/);
  const text = readFileSync((await file.path())!, 'utf8');
  expect(text).toMatch(/# view: size enrichment/);
  expect(text).toMatch(/# normalization: row/);
  expect(text).toMatch(/# gaussian_sigma_size_bp: \d+/);
  expect(text).toMatch(/# gaussian_sigma_position_bp: \d+/);
  expect(text).toMatch(/\nsize_bp\t\d+/);
});

test('⌘K finds Footprint size enrichment by name', async ({ server, page }) => {
  test.setTimeout(120_000);
  await openDemo(page, server.baseUrl);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('command-palette-input').fill('size enrichment');
  const option = page.getByTestId('command-palette').locator('[role="option"][data-palette-item="cmd:footprint-size-enrichment"]');
  await expect(option).toBeVisible();
  const first = sizesRequest(page, b => b.group_by === 'all');
  await option.click();
  await first;
  await expect(page.locator('[data-panel-content-type="cluster-detail"]').getByTestId('footprint-sizes')).toHaveAttribute('data-view', 'enrichment');
});
