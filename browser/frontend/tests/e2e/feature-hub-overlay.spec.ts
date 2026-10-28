/**
 * Feature hub V1 (native/feature_hub/DESIGN.md §8, §13): the overlaid patch view. Nucleosome outputs for two
 * datasets (Compute in view), then the hub's Overlay tab over an anchor set: regular arrays aligned at the anchor,
 * one profile per dataset with its denominators (molecules measured at each position), facets, the pile, TSV export;
 * then the Nucleosomes panel's patch list hands its patches over (when the scan finds any).
 *
 * Needs FiberHMM with the nuc scan module on the server's PYTHONPATH (skipped otherwise). The data are synthetic Hia5
 * molecules (tests/nuc_fixtures.py) on chr3, in two datasets (as nucleosomes.spec.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const BASE = 128_602_000;
const DIR = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-overlay-'));
process.env.FIBERBROWSER_SCAN_CACHE_DIR = path.join(DIR, 'scan_cache');

function makeData(): string[] | null {
  const script = `
import sys
sys.path.insert(0, sys.argv[1])
import fiberhmm.scan.modules.nuc  # noqa: F401  (skip when FiberHMM has no nuc module)
from nuc_fixtures import chromatin_bam
base, out = int(sys.argv[2]), sys.argv[3]
for name, seed in (('ov_a.bam', 21), ('ov_b.bam', 22)):
    chromatin_bam(f'{out}/{name}', contig='chr3', length=198295559, offset=base, span=60000, step=700, seed=seed)
`;
  try {
    execFileSync(PYTHON, ['-c', script, path.resolve(HERE, '../../../../tests'), String(BASE), DIR], { stdio: 'pipe' });
    return [path.join(DIR, 'ov_a.bam'), path.join(DIR, 'ov_b.bam')];
  } catch {
    return null;
  }
}

const bams = makeData();
test.use({ fixtureBam: bams?.[0] ?? 'demo' });

const store = <T,>(page: import('@playwright/test').Page, fn: (s: any) => T) =>
  page.evaluate(src => (new Function('s', `return (${src})(s)`))((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

test('feature hub overlay: two datasets with denominators, facets, pile, export, patch hand-off', async ({ page, server }, info) => {
  test.skip(!bams, 'needs FiberHMM with the nuc scan module (synthetic data could not be written)');
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
  await expect(page.getByTestId('nuc-row')).toHaveCount(2, { timeout: 30_000 });
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__;
    st.setState((s: any) => ({ panels: s.panels.map((p: any) => p.contentType === 'nucleosomes'
      ? { ...p, nucleosomes: { parameters: { calibration: 'self', calibration_population: 300 } } } : p) }));
  });
  await page.getByTestId('nuc-compute').click();
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

  // The patch list hands its patches to the overlay (when the view's nuc scan finds any).
  // (the Nucleosomes panel opened above is still docked: no second one)
  await expect(page.getByTestId('nuc-panel')).toHaveCount(1);
  await page.getByTestId('nuc-find-patches').click();
  await expect(page.getByTestId('nuc-find-patches')).toHaveText('Find patches in view', { timeout: 300_000 });
  await expect(page.getByTestId('nuc-patch-row').first().or(page.getByTestId('nuc-no-patches'))).toBeVisible({ timeout: 60_000 });
  if (await page.getByTestId('nuc-patch-row').count()) {
    await page.getByTestId('nuc-overlay-patches').click();
    await expect(page.getByTestId('overlay-tab')).toBeVisible();
    await expect(page.getByTestId('overlay-loci')).toHaveValue('patches');
    await page.getByTestId('overlay-run').click();
    await expect.poll(() => store(page, s => s.featureHub.overlay.result?.loci ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
  } else {
    await expect(page.getByTestId('nuc-overlay-patches')).toBeDisabled();
  }
  expect(errors).toEqual([]);
});
