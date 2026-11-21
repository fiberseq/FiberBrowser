/**
 * Feature hub V1 (native/feature_hub/DESIGN.md §8, §13): the overlaid patch view. Nucleosome outputs for two
 * datasets (Analyse this view), then the hub's Overlay tab over an anchor set: regular arrays aligned at the anchor,
 * one profile per dataset with its denominators (molecules measured at each position), facets, the pile, TSV export.
 *
 * Needs FiberHMM with the nuc scan module on the server's PYTHONPATH: skipped when it is missing, failed instead under FIBERBROWSER_E2E_REQUIRE_FIBERHMM=1 (CI); a data-script error always fails (fixtures/syntheticData.ts). The data are synthetic Hia5
 * molecules (tests/nuc_fixtures.py) on chr3, in two datasets (as nucleosomes.spec.ts).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/server';
import { makeSyntheticData } from './fixtures/syntheticData';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 128_602_000;
const DIR = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-overlay-'));
process.env.FIBERBROWSER_SCAN_CACHE_DIR = path.join(DIR, 'scan_cache');

const data = makeSyntheticData({
  modules: ['fiberhmm.scan.modules.nuc'],
  script: `
import sys
sys.path.insert(0, sys.argv[1])
from nuc_fixtures import chromatin_bam
base, out = int(sys.argv[2]), sys.argv[3]
for name, seed in (('ov_a.bam', 21), ('ov_b.bam', 22)):
    chromatin_bam(f'{out}/{name}', contig='chr3', length=198295559, offset=base, span=60000, step=700, seed=seed)
`,
  args: [path.resolve(HERE, '../../../../tests'), String(BASE), DIR],
  outputs: [path.join(DIR, 'ov_a.bam'), path.join(DIR, 'ov_b.bam')],
});
const bams = data.paths;
test.use({ fixtureBam: bams?.[0] ?? 'demo' });

const store = <T,>(page: import('@playwright/test').Page, fn: (s: any) => T) =>
  page.evaluate(src => (new Function('s', `return (${src})(s)`))((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

test('feature hub overlay: two datasets with denominators, facets, pile, export', async ({ page, server }, info) => {
  test.skip(!bams, data.skipReason);
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/pick_*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"cancelled":true}' }));
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1500, height: 1100 });
  const added = await (await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: bams![1], label: 'Dataset B' } })).json();
  expect(added.success).toBe(true);
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => (window as any).__FIBERBROWSER_STORE__?.getState().datasets.length >= 2, null, { timeout: 60_000 });
  const lo = BASE + 10_000, hi = BASE + 50_000;
  await page.evaluate(([a, b]) => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.setViewport('chr3', a, b);
    s.openAnalysisPanel('nucleosomes');
  }, [lo, hi]);
  await expect(page.getByTestId('nuc-panel')).toBeVisible();
  // The panel opens on its geometries; its Auto-Analyse (default 'first open') analyses the view by itself.
  await expect(page.getByTestId('nuc-regularity')).toBeVisible();
  await expect(page.getByTestId('nuc-job')).toHaveAttribute('data-state', 'complete', { timeout: 300_000 });

  // An anchor set of eight positions across the view (saved in the hub, as "Use as anchors" saves one).
  await page.evaluate(([a, b]) => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const anchors = Array.from({ length: 8 }, (_v, i) => ({ chrom: 'chr3', pos: a + 2000 + i * Math.floor((b - a - 4000) / 8) }));
    s.setFeatureHub((h: any) => ({ anchors: [...h.anchors, { id: 'e2e-anchors', label: 'eight anchors', sources: [], createdAt: '', anchors }] }));
    s.openAnalysisPanel('feature-hub');
  }, [lo, hi]);
  await expect(page.getByTestId('hub-panel')).toBeVisible();
  await page.locator('button[data-analysis-tab=overlay]').filter({ hasText: 'Overlay' }).first().click();
  await expect(page.getByTestId('overlay-tab')).toBeVisible();
  await page.getByTestId('overlay-loci').selectOption('anchors');
  await page.getByTestId('overlay-tab').getByLabel('Anchor set').selectOption('e2e-anchors');
  await expect(page.getByTestId('overlay-loci-count')).toHaveText('8 loci');
  await page.getByTestId('overlay-layer').selectOption('regular');
  await page.getByTestId('overlay-align').selectOption('anchor');
  await page.getByTestId('overlay-flank').fill('1500');
  await expect(page.getByTestId('overlay-observations')).toContainText('Dataset B');
  await page.getByTestId('overlay-run').click();
  await expect(page.getByTestId('overlay-result')).toBeVisible({ timeout: 120_000 });

  // One profile per dataset, each with its denominators; never more marked molecules than measured ones.
  const result = await store(page, s => s.featureHub.overlay.result);
  expect(result.series).toHaveLength(2);
  for (const s of result.series) {
    expect(s.error).toBeUndefined();
    expect(s.molecules).toBeGreaterThan(0);
    expect(Math.max(...s.den)).toBeGreaterThan(0);
    expect(s.num.every((n: number, i: number) => n <= s.den[i] + 1e-6)).toBe(true);
  }
  expect(result.xLabel).toBe('bp from the anchor');
  await expect(page.getByTestId('overlay-legend-item')).toHaveCount(2);
  await expect(page.getByTestId('overlay-legend-item').nth(1)).toContainText(/measured per position/);
  await page.getByTestId('overlay-view-facets').click();
  await expect(page.getByTestId('overlay-facets').locator('svg')).toHaveCount(2);
  await page.getByTestId('overlay-view-pile').click();
  await expect(page.getByTestId('overlay-pile')).toBeVisible();
  expect(result.pile.length).toBeGreaterThan(0);
  expect(result.pile.length).toBeLessThanOrEqual(400);
  const download = page.waitForEvent('download');
  await page.getByTestId('overlay-export-tsv').click();
  const tsv = info.outputPath('overlay.tsv');
  await (await download).saveAs(tsv);
  const lines = readFileSync(tsv, 'utf8').trim().split('\n');
  expect(lines[1].split('\t').length).toBe(1 + 3 * 2);       // x + (marked, measured, density) per dataset
  expect(lines.length).toBe(2 + result.series[0].x.length);

  // The result is kept with the session state (the hub's overlay settings and last result).
  expect(await store(page, s => [s.featureHub.overlay.align, s.featureHub.overlay.layer])).toEqual(['anchor', 'regular']);

  // (The patch list's "Overlay…" hand-off was tested here; the patch list and its hand-off were removed.)
  await expect(page.getByTestId('nuc-panel')).toHaveCount(1);
  expect(errors).toEqual([]);
});
