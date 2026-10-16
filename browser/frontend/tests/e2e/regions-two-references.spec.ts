/**
 * Regions with two references (fb-n2-regions, the 3.0 audit's H3, H4, M15-M18):
 * the hg38 demo and a dm6 DddB amplicon BAM opened in their own panel.
 * - The demo's amplicon is named NAPA (it was "Metazoa_SRP").
 * - The dm6 dataset isn't scanned on hg38 before it has its own reference; its
 *   amplicons are listed under dm6, named after dm6 genes.
 * - A dm6 BED imported with the hg38 catalog shown offers dm6.
 * - N steps the catalog the Regions panel shows.
 * - Export BED with a filter writes what the filter shows; Delete asks in the
 *   panel and can be undone.
 *
 * Needs a dm6 DddB amplicon BAM (FIBERBROWSER_TEST_DM6_BAM)
 * and hg38 + dm6 in ~/.fiberhmm/genomes (never downloaded here).
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

test.use({ fixtureBam: 'demo' });

const DM6_BAM = process.env.FIBERBROWSER_TEST_DM6_BAM?.trim() || '';
// Its dataset label (the file name without .bam): the amplicon category is named after it.
const DM6_STEM = path.basename(DM6_BAM).replace(/\.bam$/i, '');
const DM6_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'dm6.fa.fai'));
const HG38_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'hg38.fa.fai'));
const SHOTS = process.env.FB_REGIONS_SHOTS?.trim();

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

const categoryNames = (page: Page) => page.getByTestId('region-category-name').allTextContents();
const entryLabels = (page: Page) => page.getByTestId('region-entry-label').allTextContents();

test('regions on two references: names, BED reference check, N / P context, filtered export, undo', async ({ page, server }) => {
  test.skip(!DM6_BAM || !existsSync(DM6_BAM), 'needs a dm6 BAM (FIBERBROWSER_TEST_DM6_BAM)');
  test.skip(!DM6_CACHED, 'needs dm6 in ~/.fiberhmm/genomes (not downloaded by tests)');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { errors.push(`native dialog: ${d.message()}`); void d.dismiss(); });

  const status = await (await page.request.get(`${server.baseUrl}/api/status`)).json();
  if (status.current_genome !== 'hg38') {
    test.skip(!HG38_CACHED, 'needs hg38 in ~/.fiberhmm/genomes (not downloaded by tests)');
    expect((await (await page.request.post(`${server.baseUrl}/api/load_genome?genome_id=hg38`)).json()).success).toBe(true);
  }
  const fly = (await (await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: DM6_BAM } })).json()).dataset.id as string;

  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!window.sessionStorage.getItem('fb-e2e-kept')) {
      window.localStorage.clear();
      window.sessionStorage.setItem('fb-e2e-kept', '1');
    }
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().openAnalysisPanel('circular-genome'));
  await expect(page.getByTestId('region-catalog')).toBeVisible();

  // H3: the demo's amplicon is NAPA. M16: the dm6 dataset is not scanned on hg38.
  await expect(page.locator('[data-testid="region-category"][data-category-name^="Amplicons · napa"]')).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(() => entryLabels(page)).toContain('NAPA');
  expect(await categoryNames(page)).not.toContainEqual(expect.stringContaining(DM6_STEM));
  await shot(page, 'n2_regions_hg38_napa.png');

  // The dm6 dataset in its own panel: its amplicons are listed under dm6.
  await page.getByTestId('genome-mismatch-own-genome').click();
  await expect(page.getByTestId('genome-mismatch-banner')).toHaveCount(0, { timeout: 60_000 });
  const select = page.getByTestId('region-genome-select');
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveText(['hg38 (main genome)', 'dm6']);
  // The dm6 panel just opened at its own locus is the panel being worked in
  // (panelScope's active panel, as search and the cluster charts use: fb-n4-integ,
  // Codex integ 7), so Regions open on dm6; the hg38 catalog is one choice away.
  await expect(select).toHaveValue('dm6');
  await select.selectOption('hg38');
  await expect(select).toHaveValue('hg38');
  expect(await categoryNames(page)).not.toContainEqual(expect.stringContaining(DM6_STEM));

  // H4: a dm6 BED with the hg38 catalog shown.
  const bedPath = path.join(tmpdir(), `fly_enhancers_${Date.now()}.bed`);
  writeFileSync(bedPath, 'track name="DV enhancers"\nchr2R\t9974318\t9975000\teve_stripe2\nchr2R\t9980000\t9981000\teve_stripe37\nchr3R\t6758000\t6760000\tftz_zebra\n');
  await page.getByTestId('region-import-input').setInputFiles(bedPath);
  await expect(page.getByTestId('region-prompt')).toContainText('looks like dm6 regions: chr2R, chr3R are not on hg38');
  await shot(page, 'n2_regions_import_prompt.png');
  await page.getByTestId('region-import-elsewhere').click();
  await expect(page.getByTestId('region-status')).toContainText('(into dm6): 3 regions');
  expect(await categoryNames(page)).not.toContain('DV enhancers');

  // The dm6 catalog: the dm6 BAM's amplicons by dm6 gene, and the imported BED.
  await select.selectOption('dm6');
  await expect(page.getByTestId('region-status')).toHaveCount(0);
  await expect(page.locator(`[data-testid="region-category"][data-category-name^="Amplicons · ${DM6_STEM}"]`)).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(() => entryLabels(page)).toEqual(expect.arrayContaining(['CG9500', 'numb', 'near Gdi (4.0 kb)', 'eve_stripe2', 'ftz_zebra']));
  await shot(page, 'n2_regions_dm6.png');

  // M15: with the dm6 catalog shown, N steps dm6 (the fly panel), not the hg38 view.
  const mainBefore = await store(page, s => [s.chrom, s.start, s.end]);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('n');
  await expect.poll(() => page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.datasetId === id)?.viewportOverride?.chrom, fly)).toMatch(/chr2[LR]|chr3R/);
  expect(await page.getByTestId('region-step-label').textContent()).toMatch(/^1 \/ \d+ in /);
  expect(await store(page, s => [s.chrom, s.start, s.end])).toEqual(mainBefore);

  // M17: Export BED with a filter writes what the filter shows.
  await page.getByTestId('region-filter').fill('eve');
  await expect.poll(() => entryLabels(page)).toEqual(['eve_stripe2', 'eve_stripe37']);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('region-export-bed').click()]);
  const text = readFileSync(await download.path(), 'utf8');
  expect(text).toContain('eve_stripe2');
  expect(text).not.toContain('ftz_zebra');
  await page.getByTestId('region-filter').fill('');

  // M18: Delete asks in the panel; Undo brings the category back.
  const dv = page.locator('[data-testid="region-category"][data-category-name="DV enhancers"]');
  await dv.getByTestId('region-category-menu').click();
  await page.getByTestId('region-category-delete').click();
  await expect(page.getByTestId('region-prompt')).toContainText('Delete DV enhancers and its 3 regions?');
  await page.getByTestId('region-confirm-delete').click();
  await expect(dv).toHaveCount(0);
  await page.getByTestId('region-undo').click();
  await expect(dv).toHaveCount(1);
  await expect.poll(() => entryLabels(page)).toEqual(expect.arrayContaining(['eve_stripe2', 'eve_stripe37', 'ftz_zebra']));

  // L13: at 1024 px with the panel in the drawer, a region's name stays visible.
  await page.setViewportSize({ width: 1024, height: 700 });
  await expect(page.getByTestId('region-genome-select')).toHaveValue('dm6');
  const firstLabel = page.getByTestId('region-entry-label').first();
  expect((await firstLabel.boundingBox())!.width).toBeGreaterThan(30);
  await shot(page, 'n2_regions_1024.png');

  expect(errors).toEqual([]);
});
