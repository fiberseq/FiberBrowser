/**
 * Feature hub gate (H2, native/feature_hub/DESIGN.md §13): scan → hub list → filter by prevalence → use as cluster
 * regions → Cluster runs; the anchors are saved in the session.
 *
 * Needs FiberHMM with fiberhmm.scan on the server's PYTHONPATH (skipped otherwise). The data are FiberHMM's synthetic
 * DAF locus (fiberhmm.scan.testing) copied to three offsets of chr3, in two datasets.
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
const DIR = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-hub-'));
process.env.FIBERBROWSER_SCAN_CACHE_DIR = path.join(DIR, 'scan_cache');

function makeData(): string[] | null {
  const script = `
import sys
sys.path.insert(0, sys.argv[1])
from scan_fixtures import multi_locus_daf_bam
base, out = int(sys.argv[2]), sys.argv[3]
for name, seed in (('hub_a.bam', 3), ('hub_b.bam', 11)):
    multi_locus_daf_bam(f'{out}/{name}', seed=seed, contig='chr3', length=198295559,
                        offsets=(base + 3000, base + 22000, base + 47500))
`;
  try {
    execFileSync(PYTHON, ['-c', script, path.resolve(HERE, '../../../../tests'), String(BASE), DIR], { stdio: 'pipe' });
    return [path.join(DIR, 'hub_a.bam'), path.join(DIR, 'hub_b.bam')];
  } catch {
    return null;
  }
}

const bams = makeData();
test.use({ fixtureBam: bams?.[0] ?? 'demo' });

const store = <T,>(page: import('@playwright/test').Page, fn: (s: any) => T) =>
  page.evaluate(src => (new Function('s', `return (${src})(s)`))((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

test('feature hub: scan, list, filter by prevalence, cluster regions, anchors in the session', async ({ page, server }, info) => {
  test.skip(!bams, 'needs FiberHMM with fiberhmm.scan (synthetic data could not be written)');
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
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
  await page.evaluate(([lo, hi]) => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.setViewport('chr3', lo, hi);
    s.openAnalysisPanel('feature-hub');
  }, [BASE + 21_000, BASE + 30_000]);
  await expect(page.getByTestId('hub-panel')).toBeVisible();

  // Scan: the dialog shows the units, what is computed already, and the command line.
  await page.getByTestId('hub-scan').click();
  const dialog = page.getByTestId('hub-scan-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('hub-scan-module-fp')).toBeChecked();
  await expect(page.getByTestId('hub-scan-module-nfr')).toBeChecked();
  await dialog.locator('summary').click();
  await page.getByTestId('hub-scan-params').fill('{"nfr": {"nfr": {"bootstrap": 0, "kmax": 3, "splits": 2}}}');
  await page.getByTestId('hub-scan-workers').fill('2');
  await expect(page.getByTestId('hub-scan-cli')).toContainText('fiberhmm-scan --bam', { timeout: 30_000 });
  await expect(page.getByTestId('hub-scan-cli')).toContainText('--genome --contigs chr3');
  await expect(page.getByTestId('hub-scan-cli')).toContainText('--parameters scan_parameters.json');
  await expect(page.getByTestId('hub-scan-coverage-fp')).toContainText('to compute');
  await page.getByTestId('hub-scan-submit').click();
  await expect(page.getByTestId('hub-job')).toHaveAttribute('data-state', 'complete', { timeout: 360_000 });

  // The hub lists the scan's sets with hits in view, a column per dataset.
  await expect(page.locator('[data-testid=hub-set-row][data-type="fp.class"]').first()).toBeVisible();
  await expect(page.locator('[data-testid=hub-row]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid=hub-col]')).toContainText(['All', 'Dataset B']);
  const allRows = await page.locator('[data-testid=hub-row]').count();

  // Filter by prevalence: rows without a prevalence of at least 0.2 in some column go.
  await page.getByTestId('hub-min-prevalence').fill('0.2');
  await expect.poll(() => page.locator('[data-testid=hub-row]').count()).toBeLessThanOrEqual(allRows);
  const kept = await page.locator('[data-testid=hub-row]').count();
  expect(kept).toBeGreaterThan(0);
  const types = await page.locator('[data-testid=hub-row]').evaluateAll(rows => rows.map(r => r.getAttribute('data-type')));
  expect(types.every(t => t === 'fp.class' || t === 'nfr.variant')).toBe(true);

  // Use as cluster regions: Cluster runs on them.
  await page.getByTestId('hub-select-shown').click();
  await expect(page.getByTestId('hub-selected-count')).toHaveText(`${kept} selected`);
  await page.getByTestId('hub-use-cluster').click();
  await expect.poll(() => store(page, s => Object.values(s.clusterAssignments ?? {}).reduce((n: number, m: any) => n + Object.keys(m ?? {}).length, 0)),
    { timeout: 120_000 }).toBeGreaterThan(0);
  expect(await store(page, s => s.selectedPeaks.size)).toBe(kept);

  // Use as anchors: saved with the session.
  await page.getByTestId('hub-use-anchors').click();
  await expect(page.getByTestId('hub-anchor-set')).toHaveCount(1);
  const download = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const sessionPath = info.outputPath('session.json');
  await (await download).saveAs(sessionPath);
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  const hub = session.frontend.featureHub;
  expect(hub.anchors).toHaveLength(1);
  expect(hub.anchors[0].anchors).toHaveLength(kept);
  expect(hub.scans.map((s: any) => s.source)).toEqual(['cache', 'cache']);
  // Hub refs stay out of the legacy selection (3.0.x reads it).
  expect(session.frontend.selectedFeatures ?? []).toEqual([]);
  expect(errors).toEqual([]);
});
