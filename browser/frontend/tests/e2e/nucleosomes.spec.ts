/**
 * Nucleosome panel: open it (its Auto-Analyse analyses the view), read each series' scores and the shared geometries
 * (Geometries tab), the charts and detail tables (Charts tab), hide and show a column (Settings), and find the
 * nucsz / nucseg layers on the reads.
 *
 * Needs FiberHMM with the nuc scan module on the server's PYTHONPATH: skipped when it is missing, failed instead under FIBERBROWSER_E2E_REQUIRE_FIBERHMM=1 (CI); a data-script error always fails (fixtures/syntheticData.ts). The data are synthetic Hia5
 * molecules (tests/nuc_fixtures.py) on chr3, in two datasets.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/server';
import { makeSyntheticData } from './fixtures/syntheticData';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 128_602_000;
const DIR = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-nuc-'));
process.env.FIBERBROWSER_SCAN_CACHE_DIR = path.join(DIR, 'scan_cache');

const data = makeSyntheticData({
  modules: ['fiberhmm.scan.modules.nuc'],
  script: `
import sys
sys.path.insert(0, sys.argv[1])
from nuc_fixtures import chromatin_bam
base, out = int(sys.argv[2]), sys.argv[3]
for name, seed in (('nuc_a.bam', 21), ('nuc_b.bam', 22)):
    chromatin_bam(f'{out}/{name}', contig='chr3', length=198295559, offset=base, span=60000, step=700, seed=seed)
`,
  args: [path.resolve(HERE, '../../../../tests'), String(BASE), DIR],
  outputs: [path.join(DIR, 'nuc_a.bam'), path.join(DIR, 'nuc_b.bam')],
});
const bams = data.paths;
test.use({ fixtureBam: bams?.[0] ?? 'demo' });

test('nucleosome panel: auto-analyse, geometries, charts, a column per panel, layers on the reads', async ({ page, server }, info) => {
  test.skip(!bams, data.skipReason);
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/pick_file**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"cancelled":true}' }));
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  const added = await (await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: bams![1], label: 'Dataset B' } })).json();
  expect(added.success).toBe(true);
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => (window as any).__FIBERBROWSER_STORE__?.getState().datasets.length >= 2, null, { timeout: 60_000 });
  const [lo, hi] = [BASE + 20_000, BASE + 32_000];
  await page.evaluate(([a, b]) => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.setViewport('chr3', a, b);
    s.openAnalysisPanel('nucleosomes');
  }, [lo, hi]);
  await expect(page.getByTestId('nuc-panel')).toBeVisible();
  const tab = async (name: string) => {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) await button.click();
    else { await page.getByTestId('analysis-tab-more').click(); await page.getByRole('menuitem', { name, exact: true }).click(); }
  };
  // Auto-Analyse ('first open', the default; under Settings) starts Analyse by itself on a view with no nucleosome
  // calls: the panel no longer waits for a click.
  await expect(page.getByTestId('nuc-regularity')).toBeVisible();
  await page.getByTestId('nuc-settings-toggle').click();
  await expect(page.getByTestId('nuc-reg-auto')).toHaveValue('first');
  await page.getByTestId('nuc-settings-toggle').click();
  await expect(page.getByTestId('nuc-settings')).toHaveCount(0);
  await expect(page.getByTestId('nuc-job')).toHaveAttribute('data-state', 'complete', { timeout: 300_000 });
  // one Analyse button: the header's
  await expect(page.getByRole('button', { name: 'Analyse this view', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'About the nucleosome panel', exact: true }).click();
  await expect(page.getByTestId('nuc-calibration').first()).toHaveAttribute('data-source', /computed|cache/, { timeout: 30_000 });
  await expect(page.getByTestId('nuc-calibration')).toHaveCount(2);
  await page.getByRole('dialog', { name: 'About the nucleosome panel', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();

  // Geometries (the default tab): a summary row per dataset with its molecules, then the shared-geometries card
  // listing geometries found in both datasets; the patch layer is on for the reads.
  const summary = page.getByTestId('nuc-reg-summary-row');
  await expect(summary).toHaveCount(2, { timeout: 120_000 });
  for (const i of [0, 1]) await expect(summary.nth(i).locator('td').nth(1)).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByTestId('nuc-geo-card')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('nuc-geo-classes')).toBeVisible();
  const geoRows = page.getByTestId('nuc-geo-row');
  await expect.poll(() => geoRows.count(), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('nuc-geo-series-line').first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().enabledModTypes.nucpatch)).toBe(true);
  await info.attach('nucleosome-geometries', { body: await page.getByTestId('nuc-panel').screenshot(), contentType: 'image/png' });

  // Charts: a scored row per dataset, the score chart and each dataset's random-packing reference.
  await tab('Charts');
  await page.getByTestId('nuc-tables').locator('summary').click();      // the detail tables (collapsed)
  const regRows = page.getByTestId('nuc-reg-row');
  await expect(regRows).toHaveCount(2, { timeout: 120_000 });
  for (const i of [0, 1]) await expect(regRows.nth(i).locator('td').nth(1)).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByTestId('nuc-reg-scores-chart')).toBeVisible();
  await expect(page.getByTestId('nuc-reg-reference')).toHaveCount(2);
  await expect(page.getByTestId('nuc-reg-reference').first()).toContainText(/random packing median [\d.]+/);
  await expect(page.getByTestId('nuc-reg-reference').first()).toHaveAttribute('title', /[\d,]+ windows from \d+ molecules/);
  await expect(page.getByTestId('nuc-patch-summary-row').first()).toBeVisible();
  await info.attach('nucleosome-charts', { body: await page.getByTestId('nuc-panel').screenshot(), contentType: 'image/png' });

  // The rows carry the layers, and the layers are switched on.
  const layers = await page.evaluate(async ([a, b]) => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const ds = s.datasets[0];
    const r = await fetch(`/api/reads/compact?dataset_id=${encodeURIComponent(ds.id)}&chrom=chr3&start=${a}&end=${b}&include_layers=true&max_reads=500`).then(x => x.json());
    const reads = r.reads || [];
    return { available: Object.keys(ds.available_layers || {}).filter((k: string) => k.startsWith('nuc')), on: [s.enabledModTypes.nucsz, s.enabledModTypes.nucseg],
      reads: reads.length, withNucsz: reads.filter((x: any) => x.layers?.nucsz?.intervals?.length).length,
      names: (reads.find((x: any) => x.layers?.nucsz) || {}).layers?.nucsz?.quality_names };
  }, [lo, hi]);
  expect(layers.available).toEqual(expect.arrayContaining(['nucsz', 'nucseg']));
  expect(layers.on).toEqual([true, true]);
  expect(layers.withNucsz).toBeGreaterThan(5);
  // No named-class byte: named classes were removed (owner, 20 Nov 2026).
  expect(layers.names).toEqual(['coarse', 'posterior', 'z']);

  // Hiding a column under Settings, then showing it again.
  await tab('Geometries');
  await page.getByTestId('nuc-settings-toggle').click();
  await page.getByTestId('nuc-column-toggle').nth(1).uncheck();
  await expect(page.getByTestId('nuc-reg-summary-row')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('nuc-show-hidden').click();
  await expect(page.getByTestId('nuc-reg-summary-row')).toHaveCount(2, { timeout: 60_000 });
  await page.getByTestId('nuc-settings-toggle').click();
  await info.attach('nucleosome-panel', { body: await page.getByTestId('nuc-panel').screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});
