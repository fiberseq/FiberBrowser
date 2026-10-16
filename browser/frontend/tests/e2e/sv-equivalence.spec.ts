import { test, expect, enablePreviews } from './fixtures/server';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.FIBERBROWSER_TEST_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
test.use({ fixtureBam: async ({}, use) => {
  const bam = path.join(mkdtempSync(path.join(tmpdir(), 'fb-equivalence-')), 'sv_demo.bam');
  execFileSync(process.env.FIBERBROWSER_TEST_PYTHON || 'python', [path.join(root, 'tests/make_sv_demo_bam.py'), bam]);
  const fasta = bam.replace(/\.bam$/, '.fa');
  execFileSync(process.env.FIBERBROWSER_TEST_PYTHON || 'python', ['-c',
    'import sys,pathlib,pysam; sys.path.insert(0,sys.argv[1]); from sv_fixtures import reference_sequence; pathlib.Path(sys.argv[2]).write_text(">chrSV\\n"+reference_sequence()+"\\n"); pysam.faidx(sys.argv[2])', path.join(root, 'tests'), fasta]);
  const previous = process.env.FIBERBROWSER_TEST_FASTA;
  process.env.FIBERBROWSER_TEST_FASTA = fasta;
  try { await use(bam); } finally { process.env.FIBERBROWSER_TEST_FASTA = previous; }
} });

test('SV split pools flank peaks and clusters on the alternate and reference panels', async ({ page, server }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await enablePreviews(page);
  await page.goto(`${server.baseUrl}/?chr=chrSV&start=8000&end=16000`);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count()).toBe(0);
  const sv = page.locator('canvas[data-testid^="sv-track-canvas-"]').first();
  await expect(sv).toBeVisible();
  const box = (await sv.boundingBox())!;
  const sidebar = Number(await page.locator('canvas[data-copilot-track="reads"]').first().getAttribute('data-track-sidebar')) || 0;
  await page.mouse.click(box.x + sidebar + 0.75 * (box.width-sidebar), box.y+box.height/2, { button: 'right' });
  await page.getByTestId('track-context-menu').getByRole('menuitem', { name: 'Split into panels by this SV' }).click();
  const dialog = page.getByTestId('split-panels-dialog');
  await expect(dialog.getByTestId('split-panels-row').first()).toBeVisible();
  await dialog.getByTestId('split-panels-open').click();
  await expect(page.getByTestId('alt-allele-chip')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('split-flanks-matched').first()).toBeVisible();
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__, s = store.getState();
    s.addCustomPeak(13_000, 13_200, 'chrSV');
    const peak = s.getAllPeaks().find((p: any) => p.isCustom && p.start === 13_000);
    s.replacePeakSelection([peak.index]);
    s.setClusterMethod('kmeans'); s.setClusterK(2);
    store.setState({ analysisSampleCount: 0, selectedDatasets: new Set() });
  });
  const projected = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return s.getAllPeaks().filter((p: any) => p.isCustom).map((p: any) => ({ chrom: p.chrom, selected: s.selectedPeaks.has(p.index), shared: !!p.match?.correspondenceId }));
  });
  expect(new Set(projected.map((p: any) => p.chrom)).size).toBe(2);
  expect(projected.every((p: any) => p.selected && p.shared)).toBe(true);
  const clustered = page.waitForResponse(r => r.url().endsWith('/api/cluster-regions') && r.request().method() === 'POST', { timeout: 30_000 });
  await page.getByTestId('cluster-run-button').click();
  const response = await clustered;
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(Object.values(result.results).filter((r: any) => Object.keys(r.assignments).length > 0).length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().clusterMatchedRun?.windows.length)).toBeGreaterThanOrEqual(2);
  const scan = page.waitForResponse(r => r.url().endsWith('/api/scan-correspondence') && r.request().method() === 'POST', { timeout: 30_000 });
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.replacePeakSelection([]);
    s.clearPeaksByRule('default-accessibility');
    s.setCorrespondenceScans('default-accessibility', {});
    s.updatePeakRule('default-accessibility', { minReads: 1, minPeakWidth: 20, smoothWidth: 20 });
    window.dispatchEvent(new CustomEvent('fiberhmm:rescan-rule', { detail: { ruleId: 'default-accessibility' } }));
  });
  const scanned = await scan;
  expect(scanned.ok()).toBe(true);
  const pooled = await scanned.json();
  expect(Object.keys(pooled.members).length).toBeGreaterThanOrEqual(2);
  expect(pooled.n_reads).toBeGreaterThan(0);
  expect(pooled.peaks.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks()
    .filter((p: any) => p.ruleId === 'default-accessibility' && p.match?.correspondenceId).length)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const peaks = s.getAllPeaks().filter((p: any) => p.ruleId === 'default-accessibility' && p.match?.correspondenceId);
    s.replacePeakSelection([peaks[0].index]);
  });
  const pooledCluster = page.waitForResponse(r => r.url().endsWith('/api/cluster-regions') && r.request().method() === 'POST', { timeout: 30_000 });
  await page.getByTestId('cluster-run-button').click();
  const pooledResult = await (await pooledCluster).json();
  expect(Object.values(pooledResult.results).filter((r: any) => Object.keys(r.assignments).length).length).toBeGreaterThanOrEqual(2);
  const reads = page.locator('canvas[data-copilot-track="reads"]');
  await reads.first().click({ position: { x: 10, y: 80 } });
  await expect.poll(() => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const picks = s.clusterMatchedRun.windows.map((w: any) => [...(s.selectedClusters[w.stateKey] ?? [])]);
    return picks.length >= 2 && picks[0].length > 0 && picks.every((p: number[]) => JSON.stringify(p) === JSON.stringify(picks[0]));
  })).toBe(true);
  await page.getByTestId('split-group-strip-close').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().peakRules.filter((r: any) => r.matchGroup?.origin === 'sv').length)).toBe(0);
  expect(errors).toEqual([]);
});
