/**
 * Nucleosome panel (native/nucleosome_panel/DESIGN.md §6, P-B0/P-F): open the panel, compute in view, read the
 * per-observation summaries, and find the nucsz / nucseg layers on the reads.
 *
 * Needs FiberHMM with the nuc scan module on the server's PYTHONPATH (skipped otherwise). The data are synthetic Hia5
 * molecules (tests/nuc_fixtures.py) on chr3, in two datasets.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const BASE = 128_602_000;
const DIR = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-nuc-'));
process.env.FIBERBROWSER_SCAN_CACHE_DIR = path.join(DIR, 'scan_cache');

function makeData(): string[] | null {
  const script = `
import sys
sys.path.insert(0, sys.argv[1])
import fiberhmm.scan.modules.nuc  # noqa: F401  (skip when FiberHMM has no nuc module)
from nuc_fixtures import chromatin_bam
base, out = int(sys.argv[2]), sys.argv[3]
for name, seed in (('nuc_a.bam', 21), ('nuc_b.bam', 22)):
    chromatin_bam(f'{out}/{name}', contig='chr3', length=198295559, offset=base, span=60000, step=700, seed=seed)
`;
  try {
    execFileSync(PYTHON, ['-c', script, path.resolve(HERE, '../../../../tests'), String(BASE), DIR], { stdio: 'pipe' });
    return [path.join(DIR, 'nuc_a.bam'), path.join(DIR, 'nuc_b.bam')];
  } catch {
    return null;
  }
}

const bams = makeData();
test.use({ fixtureBam: bams?.[0] ?? 'demo' });

test('nucleosome panel: compute in view, a column per panel, layers on the reads', async ({ page, server }, info) => {
  test.skip(!bams, 'needs FiberHMM with the nuc scan module (synthetic data could not be written)');
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
  // One column per dataset panel, nothing computed yet.
  await expect(page.getByTestId('nuc-row')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('nuc-not-computed')).toBeVisible({ timeout: 30_000 });
  // A quick self calibration for the synthetic data, saved on the panel (panels[].nucleosomes).
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    store.setState((s: any) => ({ panels: s.panels.map((p: any) => p.contentType === 'nucleosomes'
      ? { ...p, nucleosomes: { parameters: { calibration: 'self', calibration_population: 300 } } } : p) }));
  });
  await page.getByTestId('nuc-compute').click();
  await expect(page.getByTestId('nuc-job')).toHaveAttribute('data-state', 'complete', { timeout: 300_000 });
  await expect(page.getByTestId('nuc-calibration').first()).toHaveAttribute('data-source', /computed|cache/, { timeout: 30_000 });
  const molecules = page.getByTestId('nuc-molecules');
  await expect(molecules.first()).toHaveText(/^[1-9]\d* \/ \d+/, { timeout: 30_000 });
  await expect(molecules.nth(1)).toHaveText(/^[1-9]\d* \/ \d+/);
  await expect(page.getByTestId('nuc-nrl').first()).toHaveText(/\d+ \[\d+–\d+\]/);
  await expect(page.getByTestId('nuc-coarse-bar').first()).toBeVisible();
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
  expect(layers.names).toEqual(['coarse', 'named', 'posterior', 'z']);
  // Selection: an NRL bin highlights its molecules in the read tracks.
  await page.getByTestId('nuc-nrl-hist-bin').first().click();
  await expect(page.getByTestId('nuc-selection')).toContainText(/Highlighting [1-9]\d* molecule/, { timeout: 30_000 });
  // Window mode: the view as the window, then an anchor at its centre (phasing in both frames).
  await page.getByTestId('nuc-mode-window').click();
  await expect(page.getByTestId('nuc-window-row')).toHaveCount(2);
  await expect(page.getByTestId('nuc-window-molecules').first()).toHaveText(/^[1-9]\d*/, { timeout: 60_000 });
  await expect(page.getByTestId('nuc-window-nrl').first()).toHaveText(/\d+ \[\d+–\d+\]/);
  await page.getByTestId('nuc-anchor').selectOption('centre');
  await expect(page.getByTestId('nuc-window-state').first()).toHaveText(/^\d+ \/ \d+ \/ \d+$/, { timeout: 60_000 });
  await expect(page.getByTestId('nuc-phasing-anchor').first()).toBeVisible();
  await info.attach('nucleosome-window-mode', { body: await page.getByTestId('nuc-panel').screenshot(), contentType: 'image/png' });
  await page.getByTestId('nuc-mode-segments').click();
  // Hiding a column, then showing it again.
  await page.getByRole('button', { name: /^Hide / }).first().click();
  await expect(page.getByTestId('nuc-row')).toHaveCount(1);
  await page.getByTestId('nuc-show-hidden').click();
  await expect(page.getByTestId('nuc-row')).toHaveCount(2);
  await info.attach('nucleosome-panel', { body: await page.getByTestId('nuc-panel').screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});
