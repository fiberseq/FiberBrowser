/** Vite + Chromium regression oracle. All requests are intercepted; no ports bind.
 * Run from browser/frontend with an explicit external build output directory. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { chromium } from '@playwright/test';

const outDir = process.argv[2];
assert(outDir && path.isAbsolute(outDir), 'Supply an absolute external Vite outDir');
assert(!path.resolve(outDir).startsWith(process.cwd()+path.sep), 'Build outside the checkout');
if (!process.argv.includes('--skip-build')) await build({ build: { outDir, emptyOutDir: true, rollupOptions: {
  input: { app: 'index.html', differences: 'tests/offline/differences.html' },
} } });
const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote', '--disable-gpu'] });
const errors = [], requests = [];
try {
  const page = await browser.newPage({ viewport: { width: 1900, height: 1200 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('https://fiberbrowser.invalid/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      const q = route.request().postDataJSON(); requests.push({ path: url.pathname, q });
      let body;
      if (url.pathname === '/api/differences/inspect') body = {
        schema_version: 'differences:v1', analysis_scope: 'native_only', evidence_policy: q,
        scope: { cohort: 'loaded', search_complete: true },
        membership: { rows: { reopened: { 'row-a': 'm', 'row-b': 'm' } }, molecules: { m: { raw_name: 'synthetic' } }, legacy_aliases: {} },
        targets: [{ target: q.target, counts: [1, 0, 0], geometry_counts: [1, 0, 0], sequence_unresolved_count: 1,
          calls_by_molecule: { m: { call: { assignment: 'unknown', level: 'confirmed', method: 'geometry_only', reasons: [], witness_ids: [] },
            geometry_group: 0, geometry_evidence: { assignment: 'target', level: 'confirmed' }, representations: [], complete: true } } }],
      };
      else if (url.pathname === '/api/sv/split') body = { assignments: { reference: 1 }, counts: [0, 1, 0], label: 'Synthetic recompute', margin: 20 };
      else throw Error(`Unexpected API request: ${url.pathname}`);
      return route.fulfill({ json: body });
    }
    const file = path.join(outDir, url.pathname);
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    await route.fulfill({ contentType: type, body: await fs.readFile(file) });
  });
  await page.goto('https://fiberbrowser.invalid/tests/offline/differences.html');
  await page.waitForFunction(() => window.offline && window.probe);
  for (const reversed of [false, true]) for (const expanded of [false, true]) for (const orientation of ['+', '-']) {
    const p = await page.evaluate(args => window.probe(...args), [reversed, expanded, orientation]);
    if (expanded) {
      assert.notDeepEqual(p.hole, p.flank); assert.notDeepEqual(p.alternate, p.hole);
      assert(Math.abs(p.hit-p.expectedHit) < .01);
    } else assert.deepEqual(p.hole, p.flank);
  }
  await page.evaluate(() => window.offline.mountNative());
  const inspector = page.getByRole('dialog', { name: 'Inspect difference', exact: true });
  await inspector.getByTestId('difference-molecule-counts').waitFor();
  assert.match(await inspector.textContent(), /1 carriers · 0 reference/);
  assert.match(await inspector.textContent(), /geometry carrier/);
  await inspector.getByRole('button', { name: 'Expand alternate', exact: true }).click();
  await page.waitForFunction(() => JSON.stringify(window.offline.axis) === '[[504,1296]]');
  await page.getByRole('button', { name: 'Pan viewport', exact: true }).click();
  await page.waitForFunction(() => JSON.stringify(window.offline.axis) === '[[404,1196]]');
  assert.match(await inspector.textContent(), /10500–10504/);
  await inspector.getByRole('button', { name: 'Split by carrier', exact: true }).click();
  assert.deepEqual((await page.evaluate(() => window.offline.snapshot())).clusterAssignments.rows, { 'row-a': 0, 'row-b': 0 });
  for (const lifted of [true, false]) {
    const metadata = await page.evaluate(l => window.offline.mountRecovery(l), lifted);
    await page.getByRole('button', { name: /^Saved differences/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Saved differences', exact: true });
    await dialog.getByText('Relink from trustworthy producer metadata', { exact: true }).click();
    await dialog.getByLabel('Historical membership metadata').fill(JSON.stringify(metadata));
    await dialog.getByLabel('Reopened source scope').selectOption(JSON.stringify({ stateKey: 'rows', datasetId: 'reopened' }));
    await dialog.getByRole('button', { name: 'Preview relink', exact: true }).click();
    assert.match(await dialog.textContent(), /1 resolved · 0 unresolved/);
    let state = await page.evaluate(() => window.offline.snapshot());
    assert.deepEqual(state.clusterAssignments.rows, {});
    await dialog.getByRole('button', { name: 'Apply membership relink', exact: true }).click();
    state = await page.evaluate(() => window.offline.snapshot());
    const expected = lifted ? 'lift-cohort:v1 ["library-a|synthetic","synthetic","record",0,"primary"]' : 'synthetic';
    assert.deepEqual(state.clusterAssignments.rows, { [expected]: 0 });
    for (const field of ['selectedReadIds', 'filteredReadIds', 'readSortOrder']) assert.deepEqual(state[field].rows, [expected]);
    assert.deepEqual(state.svCarrierEvidence.rows, { [expected]: 'confirmed' });
    await page.evaluate(() => window.offline.availability(false));
    state = await page.evaluate(() => window.offline.snapshot());
    assert.equal(state.clusterAssignments.rows, undefined);
    assert.equal(state.svSplits.rows, undefined);
    assert.equal(state.differencesSession.imports.historical[0].status, 'resolved');
    await page.evaluate(() => window.offline.availability(true));
    await dialog.getByLabel('Reopened source scope').selectOption('');
    await dialog.getByLabel('Historical membership metadata').fill('');
    await dialog.getByRole('button', { name: 'Preview relink', exact: true }).click();
    assert.match(await dialog.textContent(), /1 resolved · 0 unresolved/);
    await dialog.getByRole('button', { name: 'Apply membership relink', exact: true }).click();
    assert.deepEqual((await page.evaluate(() => window.offline.snapshot())).clusterAssignments.rows, { [expected]: 0 });
    if (!lifted) {
      await dialog.getByRole('button', { name: 'Preview recompute with saved policy', exact: true }).click();
      await dialog.getByRole('button', { name: 'Apply recomputed membership', exact: true }).waitFor();
      assert.deepEqual((await page.evaluate(() => window.offline.snapshot())).clusterAssignments.rows, { synthetic: 0 });
      await dialog.getByRole('button', { name: 'Apply recomputed membership', exact: true }).click();
      assert.deepEqual((await page.evaluate(() => window.offline.snapshot())).clusterAssignments.rows, { reference: 1 });
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
  assert.equal(requests.filter(r => r.path === '/api/differences/inspect').length, 1);
  assert.equal(requests.find(r => r.path === '/api/differences/inspect').q.analysis_scope, 'native_only');
  assert.equal(requests.find(r => r.path === '/api/sv/split').q.include_putative, false);
  assert.deepEqual(errors, []);
  console.log('Passed: 8 canvas cases; native inspection, row fan-out, expansion and panning; native/lifted recovery, disappearance/return, and native recompute.');
} finally { await browser.close(); }
