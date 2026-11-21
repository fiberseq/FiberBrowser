/**
 * fb-n13, end to end on synthetic BAMs:
 * - an SV's right-click menu splits the reads straight into panels;
 * - away from the split's locus each split panel says why it is empty; Go back returns; Show all reads
 *   here is labelled; closing the split shows the panel it came from again;
 * - a dataset closed after all that reopens from the Library (its placeholder panel at once);
 * - Regions › Scan regions finds the two regions of a targeted BAM from its index, with a status line.
 */
import { test, expect } from './fixtures/server';
import type { Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const VIEW = { chrom: 'chrSV', start: 8_000, end: 16_000 };
const INS_POS = 14_000;

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function groupControls(page: Page, id: string): Promise<Locator> {
  const controls = page.getByTestId(`toolbar-group-controls-${id}`);
  if (!(await controls.isVisible().catch(() => false))) {
    const toggle = page.getByTestId(`toolbar-group-toggle-${id}`).first();
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    else {
      await page.getByTestId('toolbar-groups-more').click();
      await page.getByTestId('toolbar-groups-more-menu').getByTestId(`toolbar-group-toggle-${id}`).click();
    }
  }
  await expect(controls.first()).toBeVisible();
  return controls.first();
}

async function open(page: Page, url: string) {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    if (!window.sessionStorage.getItem('fb-e2e-kept')) {
      window.localStorage.clear();
      window.sessionStorage.setItem('fb-e2e-kept', '1');
    }
  });
  await page.goto(url);
  await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
}

/** The rail's first-run hint covers the panel headers' right end. */
async function dismissCoach(page: Page) {
  const coach = page.getByTestId('panel-rail-coach-dismiss');
  if (await coach.isVisible().catch(() => false)) await coach.click();
}

test.describe('an SV split into panels, away from its locus, and the Library after it', () => {
  test.use({
    fixtureBam: async ({}, use) => {
      const bam = path.join(mkdtempSync(path.join(tmpdir(), 'fiberbrowser-n13-sv-')), 'sv_demo.bam');
      execFileSync(PYTHON, [path.join(REPO_ROOT, 'tests', 'make_sv_demo_bam.py'), bam], { stdio: 'inherit' });
      await use(bam);
    },
  });

  test('Split into panels from the SV row; banner off-locus; Go back; close; the Library reopens it', async ({ page, server }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const firstReads = page.waitForResponse(r => r.url().includes('/api/reads/compact') && r.url().includes('chrSV') && r.ok());
    await open(page, `${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
    await firstReads;
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);

    // 1. Right-click the insertion in the SV row: straight into panels.
    const svTrack = page.locator('canvas[data-testid^="sv-track-canvas-"]');
    await expect(svTrack).toHaveCount(1);
    const box = (await svTrack.boundingBox())!;
    const sidebar = Number(await page.locator('canvas[data-copilot-track="reads"]').first().getAttribute('data-track-sidebar')) || 0;
    const xAt = (pos: number) => box.x + sidebar + ((pos - VIEW.start) / (VIEW.end - VIEW.start)) * (box.width - sidebar);
    await page.mouse.click(xAt(INS_POS), box.y + box.height / 2, { button: 'right' });
    const menu = page.getByTestId('track-context-menu');
    await expect(menu.getByRole('menuitem', { name: 'Group in this panel by this SV' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Split into panels by this SV' }).click();
    const dialog = page.getByTestId('split-panels-dialog');
    await expect(dialog.getByTestId('split-panels-row').first()).toBeVisible({ timeout: 30_000 });
    // The carriers group is named by its evidence tiers (split panel titles keep the tier counts).
    await expect(dialog.getByTestId('split-panels-row').filter({ hasText: 'Confirmed (9) + putative (0)' })).toHaveCount(1);
    await dialog.getByTestId('split-panels-open').click();
    await expect.poll(() => store(page, s => s.panels.filter((p: any) => p.readSubset).length)).toBe(2);

    // 3. Away from the split's locus: the split panels say why they are empty.
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chrSV', 24_000, 29_000));
    const banner = page.getByTestId('split-away-banner');
    await expect(banner.first()).toBeVisible({ timeout: 20_000 });
    await expect(banner.first().getByTestId('split-away-text')).toContainText('This split is for INS');
    await expect(banner.first().getByTestId('split-away-text')).toContainText('the reads here aren');
    await banner.first().getByTestId('split-away-go-back').click();
    await expect.poll(() => store(page, s => [s.chrom, s.start <= 14_000 && s.end >= 14_000])).toEqual(['chrSV', true]);
    await expect(banner).toHaveCount(0);
    // Show all reads here: labelled in the header, unfiltered.
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chrSV', 24_000, 29_000));
    await expect(banner.first()).toBeVisible();
    await banner.first().getByTestId('split-away-show-all').click();
    await expect(page.getByTestId('split-panel-all-reads').first()).toBeVisible();
    await expect(banner).toHaveCount(0);
    await page.evaluate(v => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(v.chrom, v.start, v.end), VIEW);

    // 4. Close the split: the source shows again.
    await page.getByTestId('split-panel-close-all').first().click();
    await expect.poll(() => store(page, s => s.panels.filter((p: any) => p.readSubset).length), { timeout: 30_000 }).toBe(0);
    const source = await store(page, s => s.panels.find((p: any) => p.contentType === 'dataset' && p.datasetId));
    expect(source.collapsed).toBe(false);
    expect(source.collapsedBySplitGroup).toBeUndefined();

    // 5. Close the dataset, then Library > Open reopens it (a placeholder panel first).
    const bamPath = await store(page, s => s.datasets[0].path);
    await dismissCoach(page);
    await page.getByTestId(`panel-close-${source.id}`).click();
    await expect.poll(() => store(page, s => s.datasets.length)).toBe(0);
    expect((await page.request.post(`${server.baseUrl}/api/library/entries`, { data: { paths: [bamPath] } })).ok()).toBeTruthy();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'file', subsectionId: 'file.library' },
    })));
    await page.getByTestId('library-open-panel').click();
    const library = page.getByTestId('library-dialog');
    await library.getByTestId('library-row').filter({ hasText: 'sv_demo' }).click();
    const clicked = Date.now();
    await library.getByTestId('library-open').click();
    await expect(page.getByTestId('opening-panel').or(page.locator('[data-panel-id]').filter({ has: page.locator('canvas[data-copilot-track="reads"]') })).first())
      .toBeVisible({ timeout: 2_000 });
    expect(Date.now() - clicked).toBeLessThan(2_000);
    await expect.poll(() => store(page, s => s.datasets.length), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => store(page, s => s.panels.some((p: any) => p.contentType === 'dataset' && p.datasetId && !p.collapsed))).toBe(true);
    await expect(page.getByTestId('opening-panel')).toHaveCount(0);

    // 6. Open again while it is open: the Library shows it (never a silent no-op).
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setPanelCollapsed(
      (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.contentType === 'dataset' && p.datasetId).id, true));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'file', subsectionId: 'file.library' },
    })));
    await page.getByTestId('library-open-panel').click();
    await library.getByTestId('library-row').filter({ hasText: 'sv_demo' }).click();
    await library.getByTestId('library-open').click();
    await expect.poll(() => store(page, s => s.panels.some((p: any) => p.contentType === 'dataset' && p.datasetId && !p.collapsed))).toBe(true);
    await expect.poll(() => store(page, s => s.datasets.length)).toBe(1);
    expect(errors).toEqual([]);
  });
});

test.describe('Regions scan on a targeted BAM', () => {
  test.use({
    fixtureBam: async ({}, use) => {
      const bam = path.join(mkdtempSync(path.join(tmpdir(), 'fiberbrowser-n13-regions-')), 'two_region.bam');
      execFileSync(PYTHON, [path.join(REPO_ROOT, 'tests', 'make_two_region_bam.py'), bam], { stdio: 'inherit' });
      await use(bam);
    },
  });

  test('Scan regions: two regions from the index, a status line per open dataset', async ({ page, server }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await open(page, `${server.baseUrl}/?chr=chr21&start=30000000&end=30100000`);
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().openAnalysisPanel('circular-genome'));
    await expect(page.getByTestId('region-catalog')).toBeVisible();
    const row = page.getByTestId('region-scan-row');
    await expect(row).toHaveCount(1);
    // Scanned on opening already; Scan regions scans every open dataset again.
    await page.getByTestId('region-find').click();
    await expect(row.getByTestId('region-scan-status')).toHaveText('scanned: 2 regions (from the BAM index)', { timeout: 30_000 });
    await expect(page.getByTestId('region-status')).toContainText('scanned: 2 regions');
    await expect(page.locator('[data-testid="region-category"][data-category-name^="Regions · "]')).toHaveCount(1);
    await expect(page.getByTestId('region-entry-label')).toHaveCount(2);
    expect(errors).toEqual([]);
  });
});
