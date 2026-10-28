/**
 * Feature hub A2 (native/feature_hub/DESIGN.md §7, §13): a live scan, then association runs from the hub's Associate
 * tab: M1 (footprint classes × NFRs, by dataset: per-group odds ratios and the interaction), M4 (the distance curve),
 * a run cancelled from its job status, and the runs restored from a saved session in a fresh page.
 *
 * Needs FiberHMM with fiberhmm.scan and fiberhmm.assoc on the server's PYTHONPATH (skipped otherwise). The data are
 * FiberHMM's synthetic DAF locus copied to three offsets of chr3, in two datasets (as feature-hub.spec.ts).
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
const DIR = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-assoc-'));
process.env.FIBERBROWSER_SCAN_CACHE_DIR = path.join(DIR, 'scan_cache');

function makeData(): string[] | null {
  const script = `
import sys
sys.path.insert(0, sys.argv[1])
import fiberhmm.assoc  # noqa: F401  (skip when FiberHMM has no association module)
from scan_fixtures import multi_locus_daf_bam
base, out = int(sys.argv[2]), sys.argv[3]
for name, seed in (('assoc_a.bam', 3), ('assoc_b.bam', 11)):
    multi_locus_daf_bam(f'{out}/{name}', seed=seed, contig='chr3', length=198295559,
                        offsets=(base + 3000, base + 22000, base + 47500))
`;
  try {
    execFileSync(PYTHON, ['-c', script, path.resolve(HERE, '../../../../tests'), String(BASE), DIR], { stdio: 'pipe' });
    return [path.join(DIR, 'assoc_a.bam'), path.join(DIR, 'assoc_b.bam')];
  } catch {
    return null;
  }
}

const bams = makeData();
test.use({ fixtureBam: bams?.[0] ?? 'demo' });

const store = <T,>(page: import('@playwright/test').Page, fn: (s: any) => T) =>
  page.evaluate(src => (new Function('s', `return (${src})(s)`))((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function pick(page: import('@playwright/test').Page, testId: string, text: RegExp) {
  const options = await page.getByTestId(testId).locator('option').evaluateAll(els => els.map(e => ({ v: (e as HTMLOptionElement).value, t: e.textContent ?? '',
    d: (e as HTMLOptionElement).disabled })));
  const o = options.find(x => text.test(x.t) && !x.d && x.v);
  expect(o, `${testId}: ${options.map(x => x.t).join(' | ')}`).toBeTruthy();
  await page.getByTestId(testId).selectOption(o!.v);
}

async function settings(page: import('@playwright/test').Page, perm: string, boot: string) {
  const builder = page.getByTestId('assoc-builder');
  if (!(await builder.getByText('Permutations').isVisible())) await builder.locator('summary').click();
  await builder.locator('label', { hasText: 'Permutations' }).locator('input').fill(perm);
  await builder.locator('label', { hasText: 'Bootstrap' }).locator('input').fill(boot);
}

test('feature hub association: builder, job, results, cancel, session restore', async ({ page, server }, info) => {
  test.skip(!bams, 'needs FiberHMM with fiberhmm.scan and fiberhmm.assoc (synthetic data could not be written)');
  test.setTimeout(600_000);
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
  await page.evaluate(([lo, hi]) => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.setViewport('chr3', lo, hi);
    s.openAnalysisPanel('feature-hub');
  }, [BASE + 1_000, BASE + 52_000]);
  await expect(page.getByTestId('hub-panel')).toBeVisible();

  // A live scan of the view (fp, nfr), quick settings.
  await page.getByTestId('hub-scan').click();
  const dialog = page.getByTestId('hub-scan-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('hub-scan-module-fp')).toBeChecked();
  await dialog.locator('summary').click();
  await page.getByTestId('hub-scan-params').fill('{"nfr": {"nfr": {"bootstrap": 0, "kmax": 3, "splits": 2}}}');
  await page.getByTestId('hub-scan-workers').fill('2');
  await expect(page.getByTestId('hub-scan-cli')).toContainText('fiberhmm-scan --bam', { timeout: 30_000 });
  await page.getByTestId('hub-scan-submit').click();
  await expect(page.getByTestId('hub-job')).toHaveAttribute('data-state', 'complete', { timeout: 360_000 });
  await expect(page.locator('[data-testid=hub-set-row][data-type="fp.class"]').first()).toBeVisible();

  // The Associate tab: presets name what each question needs; the unit follows the mode.
  await page.locator('button[data-analysis-tab=assoc]').filter({ hasText: 'Associate' }).first().click();
  await expect(page.getByTestId('assoc-tab')).toBeVisible();
  await expect(page.getByTestId('assoc-preset-q1')).toContainText('nucleosome scan');
  await page.getByTestId('assoc-mode').selectOption('M1');
  await expect(page.getByTestId('assoc-unit')).toContainText('pair of hits');
  await pick(page, 'assoc-a', /Footprint classes/);
  await pick(page, 'assoc-b', /NFR/);
  await page.getByTestId('assoc-group').selectOption('dataset');
  await settings(page, '200', '200');
  await page.getByTestId('assoc-run').click();
  await expect(page.getByTestId('assoc-job')).toHaveAttribute('data-state', 'complete', { timeout: 240_000 });
  const result = page.getByTestId('assoc-result');
  await expect(result).toHaveAttribute('data-mode', 'M1');
  await expect(page.getByTestId('assoc-effect-row').first()).toBeVisible();
  const m1 = await store(page, s => s.featureHub.assocRuns.at(-1));
  expect(m1.definition.group).toEqual({ kind: 'dataset' });
  expect(['ok', 'empty']).toContain(m1.result.status);
  if (m1.result.status === 'ok') {
    // Per dataset, and the interaction between them.
    const groups = m1.result.effects.filter((e: any) => e.key.startsWith('group:')).map((e: any) => e.label);
    expect(groups).toHaveLength(2);
    expect(groups).toContain('Dataset B');
    await expect(page.getByTestId('assoc-interaction')).toBeVisible();
  } else {
    await expect(page.getByTestId('assoc-limits')).toBeVisible();
  }
  // A row navigates.
  if (await page.getByTestId('assoc-row').count()) {
    const before = await store(page, s => [s.start, s.end]);
    await page.getByTestId('assoc-row').first().click();
    await expect.poll(() => store(page, s => [s.start, s.end])).not.toEqual(before);
  }

  // M4: the distance curve (or what the data can't answer).
  await page.getByTestId('assoc-mode').selectOption('M4');
  await pick(page, 'assoc-a', /Footprint classes/);
  await pick(page, 'assoc-b', /NFR/);
  await page.getByTestId('assoc-group').selectOption('none');
  await settings(page, '200', '0');
  await page.getByTestId('assoc-run').click();
  await expect(page.getByTestId('assoc-result')).toHaveAttribute('data-mode', 'M4', { timeout: 240_000 });
  const m4 = await store(page, s => s.featureHub.assocRuns.at(-1));
  if (m4.result.curve?.['A->B']?.rows?.length) await expect(page.getByTestId('assoc-curve')).toBeVisible();
  else await expect(page.getByTestId('assoc-limits')).toBeVisible();

  // Cancel: a long run (10,000 bootstrap draws) stopped from its job status; no result is kept.
  const runsBefore = await store(page, s => s.featureHub.assocRuns.length);
  await page.getByTestId('assoc-mode').selectOption('M1');
  await pick(page, 'assoc-a', /Footprint classes/);
  await pick(page, 'assoc-b', /NFR/);
  await settings(page, '1000', '10000');
  await page.getByTestId('assoc-run').click();
  await page.getByTestId('assoc-job-cancel').click();
  await expect(page.getByTestId('assoc-job')).toHaveAttribute('data-state', 'cancelled', { timeout: 240_000 });
  expect(await store(page, s => s.featureHub.assocRuns.length)).toBe(runsBefore);

  // The runs are kept with the session and come back in a fresh page.
  const download = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const sessionPath = info.outputPath('session.json');
  await (await download).saveAs(sessionPath);
  const saved = JSON.parse(readFileSync(sessionPath, 'utf8')).frontend.featureHub;
  expect(saved.assocRuns.map((r: any) => r.definition.mode)).toEqual(['M1', 'M4']);
  const fresh = await page.context().newPage();
  fresh.on('pageerror', e => errors.push(e.message));
  await fresh.route('**/api/pick_*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"cancelled":true}' }));
  await fresh.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
  });
  await fresh.goto(server.baseUrl);
  await fresh.waitForFunction(() => (window as any).__FIBERBROWSER_STORE__?.getState().datasets.length >= 2, null, { timeout: 60_000 });
  await fresh.getByTestId('settings-rail-file').click();
  const imported = fresh.waitForResponse(r => r.url().includes('/api/session/import') && r.request().method() === 'POST');
  await fresh.getByTestId('restore-session-file-input').setInputFiles(sessionPath);
  expect((await (await imported).json()).success).toBe(true);
  await fresh.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().openAnalysisPanel('feature-hub'));
  await expect(fresh.getByTestId('assoc-tab')).toBeVisible({ timeout: 30_000 });     // the tab is saved too
  await expect(fresh.getByTestId('assoc-run-item')).toHaveCount(2);
  await expect(fresh.getByTestId('assoc-result')).toHaveAttribute('data-mode', 'M4');
  await fresh.getByTestId('assoc-run-item').nth(1).click();
  await expect(fresh.getByTestId('assoc-result')).toHaveAttribute('data-mode', 'M1');
  expect(errors).toEqual([]);
});
