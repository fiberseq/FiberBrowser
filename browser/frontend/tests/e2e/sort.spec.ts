import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';

const state = <T,>(page: Page, fn: (s: any, store: any) => T) => page.evaluate(f => {
  const store = (window as any).__FIBERBROWSER_STORE__;
  return new Function('s', 'store', `return (${f})(s, store)`)(store.getState(), store);
}, fn.toString()) as Promise<T>;

async function settled(page: Page) {
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 90_000 }).toBe(0);
  await page.waitForTimeout(350);
}
async function open(page: Page, server: any) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const r = server.defaultRegion!;
  await page.getByTestId('location-search-input').fill(`${r.chrom}:${r.start}-${r.end}`);
  await page.getByTestId('location-search-submit').click();
  await expect.poll(() => state(page, s => s.start)).toBe(r.start);
  await settled(page);
}
/** Sort shows a preview of the displayed reads first, then refines the full active subset (the button is free
 * again during the refinement; the progress line offers Stop refinement): wait for both. */
async function sortDone(page: Page) {
  await expect(page.getByTestId('sort-run-button')).not.toHaveAttribute('aria-busy', 'true', { timeout: 90_000 });
  await expect(page.getByTestId('analysis-progress').getByRole('button', { name: 'Stop refinement' })).toHaveCount(0, { timeout: 90_000 });
}
async function choose(page: Page, value: string) {
  if (!await page.locator('[data-testid="toolbar-group-sort"] select').isVisible()) {
    await page.getByTestId('toolbar-group-toggle-sort').click();
  }
  await page.locator('[data-testid="toolbar-group-sort"] select').selectOption(value);
}
const snapshot = (page: Page) => state(page, s => ({
  visible: s.activeReadIds, orders: s.readSortOrder, clusters: s.clusterOrder,
  panels: s.panels.filter((p: any) => p.contentType === 'dataset').map((p: any) => ({ id: p.id, key: p.stateKey ?? p.datasetId })),
}));

// Also runs with FIBERBROWSER_TEST_BAM / REGION for an indexed local dataset.
test('Sort case matrix: reads, panels, clusters, filters, sampling and navigation', async ({ page, server }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await open(page, server);
  const rows: any[] = [];
  const run = async (name: string) => {
    const before = await snapshot(page);
    // The preview's response, then the full sort's: the last one is the result.
    const responses: any[] = [];
    const onResponse = (r: any) => { if (r.url().includes('/api/sort_reads') && r.request().method() === 'POST') responses.push(r); };
    page.on('response', onResponse);
    await page.getByTestId('sort-run-button').click();
    await expect.poll(() => responses.length, { timeout: 90_000 }).toBeGreaterThan(0);
    await sortDone(page);
    page.off('response', onResponse);
    const r = responses.at(-1);
    const body = await r.json();
    await settled(page);
    const after = await snapshot(page);
    const keys = after.panels.map(p => p.key);
    const row = { name, status: r.status(), changed: keys.filter(k => JSON.stringify(before.visible[k]) !== JSON.stringify(after.visible[k])),
      visible: keys.map(k => after.visible[k]?.length ?? 0), ordered: keys.map(k => after.orders[k]?.length ?? 0),
      request: (() => { const q = r.request().postDataJSON(); return { ...q, read_ids: q.read_ids && Object.fromEntries(Object.entries(q.read_ids).map(([k,v]: any) => [k, v.length])), cluster_assignments: q.cluster_assignments && Object.fromEntries(Object.entries(q.cluster_assignments).map(([k,v]: any) => [k, Object.keys(v).length])) }; })(), result: Object.fromEntries(Object.entries(body.results ?? {}).map(([k,v]: any) => [k, { reads: v.read_sort_order?.length, clusters: v.cluster_order }])),
      feedback: await page.getByTestId('run-result-sort-text').allTextContents() };
    rows.push(row); console.log('SORT_CASE', JSON.stringify(row));
    expect(r.ok()).toBe(true);
    if (name === 'Load all') await info.attach('sorted-reads', { body: await page.locator('canvas[data-copilot-track="reads"]').first().screenshot(), contentType: 'image/png' });
    return { before, after, body, row };
  };
  await run('one panel, no selected peaks, display sample');
  await state(page, (s, st) => st.setState({ readSortOrder: {}, readDisplayMode: 'all', allReadsDisplayCap: 50000, loadAllReads: Object.fromEntries(s.datasets.map((d: any) => [d.id, true])), backgroundReadCap: null }));
  await settled(page);
  await run('Load all');
  await state(page, s => { s.addCustomPeak(s.start + 700, s.start + 1000, s.chrom); const p = s.getAllPeaks().filter((p: any) => p.isCustom).at(-1); s.replacePeakSelection([p.index]); });
  await run('selected peak');
  await state(page, s => { s.setClusterMethod('kmeans'); s.setClusterK(3); });
  const clustered = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.request().method() === 'POST', { timeout: 90_000 });
  await page.getByTestId('cluster-run-button').click(); await clustered; await settled(page);
  await run('after clustering');
  await state(page, (s, st) => { const k = s.panels.find((p: any) => p.contentType === 'dataset').stateKey ?? s.datasets[0].id; st.setState({ selectedClusters: { [k]: new Set([s.clusterOrder[k][1]]) } }); });
  const selected = await run('cluster selected');
  expect(Object.values(selected.after.clusters)[0]).toEqual(Object.values(selected.before.clusters)[0]);
  await state(page, (s, st) => { const k = s.panels.find((p: any) => p.contentType === 'dataset').stateKey ?? s.datasets[0].id; st.setState({ selectedClusters: {}, clusterFocus: { [k]: new Set([s.clusterOrder[k][0]]) } }); });
  await settled(page); await run('cluster focused');
  await state(page, (s, st) => { const k = s.panels.find((p: any) => p.contentType === 'dataset').stateKey ?? s.datasets[0].id; st.setState({ clusterFocus: {}, filteredReadIds: { [k]: new Set(s.activeReadIds[k].slice(0,30)) } }); });
  await settled(page); await run('read filter');
  await state(page, (s, st) => { const k = s.panels.find((p: any) => p.contentType === 'dataset').stateKey ?? s.datasets[0].id; st.setState({ filteredReadIds: {}, clusterAssignments: {}, clusterOrder: {}, readSortOrder: {}, selectedPeaks: new Set(), activeClusterTreeNodeId: null, dynamicClustering: false }); });
  const cleared = await run('clusters cleared in browser');
  expect(Object.values(cleared.body.results).every((r: any) => r.cluster_order.length === 0)).toBe(true);
  for (const p of cleared.after.panels) {
    const order: string[] = Object.values(cleared.body.results).flatMap((r: any) => r.read_sort_order);
    const visible = new Set(cleared.after.visible[p.key]);
    expect(cleared.after.visible[p.key]).toEqual(order.filter(id => visible.has(id)));
  }
  const beforePan = await snapshot(page);
  await state(page, s => s.setViewport(s.chrom, s.start + 10, s.end - 10)); await settled(page);
  rows.push({ name: 'linked pan/zoom retains order', retained: JSON.stringify(beforePan.orders) === JSON.stringify((await snapshot(page)).orders) });
  await state(page, s => s.duplicatePanel(s.panels.find((p: any) => p.contentType === 'dataset').id)); await settled(page);
  await run('several linked panels');
  await page.getByTestId('nav-mode-perPanel').click();
  await state(page, s => { const p = s.panels.filter((p: any) => p.contentType === 'dataset')[1]; s.navigatePanel(p.id, s.chrom, s.start + 100, s.end - 100); });
  await settled(page); await run('several Per panel views');
  await state(page, (s, st) => st.setState({ selectedDatasets: new Set([s.panels.find((p: any) => p.contentType === 'dataset').id]) }));
  await run('selected panel');
  await state(page, (s, st) => st.setState({ panels: s.panels.map((p: any) => ({ ...p, reversed: true })), readSortOrder: {} }));
  await run('reversed panel');
  console.log('SORT_MATRIX', JSON.stringify(rows));
  await info.attach('sort-case-matrix', { body: JSON.stringify({ rows, errors }, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]);
  expect(rows.find(r => r.name === 'linked pan/zoom retains order').retained).toBe(true);
});


test('Sort during a display load; stale responses, empty targets and no-op explanations', async ({ page, server }) => {
  test.setTimeout(240_000);
  await open(page, server);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  let release!: () => void;
  let seen!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const sent = new Promise<void>(r => { seen = r; });
  await page.route('**/api/reads/compact*', async route => { seen(); await held; await route.continue(); }, { times: 1 });
  await state(page, s => s.setViewport(s.chrom, s.start + 20, s.end - 20));
  await sent;
  const sorted = page.waitForResponse(r => r.url().includes('/api/sort_reads'));
  await page.getByTestId('sort-run-button').click(); await sorted;
  await sortDone(page);
  const saved = await state(page, s => s.readSortOrder);
  expect(Object.values(saved).some((ids: any) => ids.length > 0)).toBe(true);
  release(); await settled(page);
  expect(await state(page, s => s.readSortOrder)).toEqual(saved);
  const response = page.waitForResponse(r => r.url().includes('/api/sort_reads'));
  await page.getByTestId('sort-run-button').click(); await response;
  await expect(page.getByTestId('run-result-sort-text')).toContainText('already in this order');

  // An imported order previously took priority over every toolbar sort.
  await state(page, (s, st) => st.setState({ jupyterReadOrder: Object.fromEntries(Object.entries(s.activeReadIds).map(([k, ids]: any) => [k, [...ids].reverse()])) }));
  const imported = page.waitForResponse(r => r.url().includes('/api/sort_reads'));
  await page.getByTestId('sort-run-button').click(); await imported;
  await expect.poll(() => state(page, s => Object.values(s.jupyterReadOrder).every((ids: any) => ids.length === 0))).toBe(true);

  // A read filter changes while the server is sorting: the late response must not win.
  let releaseSort!: () => void;
  let sortSeen!: () => void;
  const sortGate = new Promise<void>(r => { releaseSort = r; });
  const sortSent = new Promise<void>(r => { sortSeen = r; });
  await page.route('**/api/sort_reads*', async route => { sortSeen(); await sortGate; await route.continue().catch(() => {}); }, { times: 1 });
  await page.getByTestId('sort-run-button').click(); await sortSent;
  await expect(page.getByTestId('sort-run-button')).toHaveAttribute('aria-busy', 'true');
  await state(page, (s, st) => { const k = Object.keys(s.activeReadIds)[0]; st.setState({ filteredReadIds: { [k]: new Set(s.activeReadIds[k].slice(0,20)) } }); });
  // The run stops at once (its request is cancelled) and says why; nothing is applied.
  releaseSort();
  await expect(page.getByTestId('analysis-progress')).toContainText('changed before it finished');
  await expect(page.getByTestId('sort-run-button')).not.toHaveAttribute('aria-busy', 'true');
  expect(await state(page, s => s.readSortOrder)).toEqual(saved);
  await state(page, (s, st) => st.setState({ filteredReadIds: {}, analysisSortRules: [{ id: 'empty', name: 'No matching footprints', enabled: true,
    metric: 'count', descending: true, scope: { kind: 'currentWindow' }, terms: [{ source: 'layer', layer: 'nuc', sizeMin: 100000, sizeMax: null }] }] }));
  await choose(page, 'analysis_sort_rule:empty');
  const tied = page.waitForResponse(r => r.url().includes('/api/sort_reads'));
  await page.getByTestId('sort-run-button').click(); await tied;
  await expect(page.getByTestId('run-result-sort-text')).toContainText('same value');
  expect(await state(page, s => s.readSortOrder)).toEqual(saved);
  await state(page, (s, st) => { const k = Object.keys(s.activeReadIds)[0]; st.setState({ filteredReadIds: { [k]: new Set() } }); });
  await expect(page.getByTestId('sort-run-button')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('sort-run-button')).toHaveAttribute('title', /No reads pass/);
  await state(page, (s, st) => st.setState({ selectedDatasets: new Set(['missing-panel']), filteredReadIds: {} }));
  await expect(page.getByTestId('sort-run-button')).toHaveAttribute('title', /choose a read panel/);
  await state(page, (s, st) => st.setState({ selectedDatasets: new Set(), sortSelection: 'projection', clusterAssignments: {} }));
  await expect(page.getByTestId('sort-run-button')).toHaveAttribute('title', /Cluster the target panels first/);
  expect(errors).toEqual([]);
});

test('Sort targets independent split cohorts and haplotype views', async ({ page, server }) => {
  test.setTimeout(240_000);
  await open(page, server);
  const requests: any[] = [];
  page.on('request', r => { if (r.url().includes('/api/sort_reads')) requests.push({ url: r.url(), body: r.postDataJSON() }); });
  await state(page, (s, st) => {
    const p = s.panels.find((p: any) => p.contentType === 'dataset');
    const ids = s.activeReadIds[p.stateKey ?? p.datasetId];
    st.setState({ panels: [0,1].map(i => ({ ...p, id: `split-${i}`, stateKey: `split-${i}`, linkGroup: null,
      readSubset: { groupId: 'sort-split', sourcePanelId: p.id, label: `Group ${i}`, colour: '#64748b', count: 80,
        locus: { chrom: s.chrom, start: s.start, end: s.end, label: 'Split' },
        rule: { kind: 'frozen', datasetId: p.datasetId, groupKeys: [String(i)], readIds: ids.slice(i * 80, (i + 1) * 80) } } })) });
  });
  await settled(page);
  await expect.poll(() => state(page, s => s.activeReadIds['split-0']?.length ?? 0)).toBeGreaterThan(1);
  await page.getByTestId('sort-run-button').click();
  await sortDone(page);
  expect(requests).toHaveLength(2);
  expect(requests.every(r => Object.values(r.body.read_ids).every((ids: any) => ids.length === 80))).toBe(true);
  const split = await snapshot(page);
  for (const p of split.panels) {
    const ranked = split.orders[p.key];
    const visible = new Set(split.visible[p.key]);
    expect(split.visible[p.key]).toEqual(ranked.filter(id => visible.has(id)));
  }
  await state(page, (s, st) => { st.setState({ panels: s.panels.map((p: any) => ({ ...p, readSubset: undefined })) });
    st.getState().openHaplotypeComparison({ chrom1: s.chrom, chrom2: s.chrom, start: s.start, end: s.end }); });
  await settled(page);
  requests.length = 0;
  await page.getByTestId('sort-run-button').click();
  await sortDone(page);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests.every(r => Object.values(r.body.cluster_assignments).every((a: any) => Object.keys(a).length === 0))).toBe(true);
});

test('Sort after splitting a visible SV into panels uses only each allele cohort', async ({ page, server }, info) => {
  test.setTimeout(240_000);
  await open(page, server);
  const sv = page.locator('[data-copilot-track="sv"][data-sv-clusters]').first();
  const count = Number(await sv.getAttribute('data-sv-clusters'));
  test.skip(!count, 'This dataset has no SV in the test window.');
  await sv.focus(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+F10');
  await page.getByTestId('track-context-menu').getByRole('menuitem', { name: 'Split into panels by this SV', exact: true }).click();
  const dialog = page.getByTestId('split-panels-dialog');
  await expect(dialog.getByTestId('split-panels-row').first()).toBeVisible({ timeout: 90_000 });
  await dialog.getByTestId('split-panels-open').click();
  await expect.poll(() => state(page, s => s.panels.filter((p: any) => p.readSubset).length)).toBeGreaterThan(0);
  await settled(page);
  await state(page, (s, st) => st.setState({ selectedDatasets: new Set() }));
  const cohorts = await state(page, s => s.panels.filter((p: any) => p.readSubset).map((p: any) => ({ key: p.stateKey, ids: p.readSubset.rule.readIds })));
  const requests: any[] = [];
  page.on('request', r => { if (r.url().includes('/api/sort_reads')) requests.push(r.postDataJSON()); });
  await page.getByTestId('sort-run-button').click();
  await expect(page.getByTestId('sort-run-button')).not.toHaveAttribute('aria-busy', 'true', { timeout: 90_000 });
  expect(requests).toHaveLength(cohorts.length);
  const sent = requests.flatMap(r => Object.values(r.read_ids ?? {})) as string[][];
  for (const cohort of cohorts) expect(sent.some(ids => JSON.stringify([...ids].sort()) === JSON.stringify([...cohort.ids].sort()))).toBe(true);
  await info.attach('sv-sort-cohorts', { body: JSON.stringify({ panels: cohorts.map(c => ({ key: c.key, count: c.ids.length })), requests: requests.length }), contentType: 'application/json' });
});

test('Moving one of two same-view panels stops the sort (one run over both); Sort again sorts both', async ({ page, server }) => {
  // Since the 3.0.0 audit (MED-1, panel-runs.spec) a Sort is one run over all its target panels: a panel that moves
  // while it runs stops it, and no panel gets an order computed for a view it no longer shows.
  test.setTimeout(180_000);
  await open(page, server);
  await state(page, s => { s.duplicatePanel(s.panels.find((p: any) => p.contentType === 'dataset').id); s.setNavigationMode('perPanel'); });
  await settled(page);
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const sent = new Promise<void>(r => { seen = r; });
  await page.route('**/api/sort_reads*', async route => { seen(); await gate; await route.continue().catch(() => {}); }, { times: 1 });
  await page.getByTestId('sort-run-button').click(); await sent;
  const keys = await state(page, s => {
    const [move, stay] = s.panels.filter((p: any) => p.contentType === 'dataset');
    s.navigatePanel(move.id, s.chrom, s.start + 100000, s.end + 100000);
    return [move.stateKey ?? move.datasetId, stay.stateKey ?? stay.datasetId];
  });
  await expect(page.getByTestId('analysis-progress')).toContainText('Sort: Stopped: the locus changed');
  release();
  await sortDone(page);
  await page.waitForTimeout(1_000);
  expect(await state(page, s => Object.keys(s.readSortOrder).filter(k => s.readSortOrder[k]?.length))).toEqual([]);
  // Sort again: each panel at the view it shows now (the moved one is past the demo's reads: nothing to order there).
  await page.getByTestId('sort-run-button').click();
  await sortDone(page);
  const withReads = await state(page, s => Object.keys(s.activeReadIds).filter(k => (s.activeReadIds[k]?.length ?? 0) > 1));
  expect(withReads).toContain(keys[1]);
  await expect.poll(() => state(page, s => Object.keys(s.readSortOrder).filter(k => s.readSortOrder[k]?.length).sort()))
    .toEqual(keys.filter(k => withReads.includes(k)).sort());
});

test('Feature membership sorting shows progress, respects panel targets and refuses a moved view', async ({ page, server }) => {
  test.setTimeout(120_000);
  await open(page, server);
  const target = await state(page, (s, st) => {
    const source = s.panels.find((p: any) => p.contentType === 'dataset');
    const ids = s.activeReadIds[source.stateKey ?? source.datasetId].slice(0, 20);
    s.duplicatePanel(source.id);
    const copy = st.getState().panels.filter((p: any) => p.contentType === 'dataset').at(-1);
    const key = copy.stateKey ?? copy.datasetId;
    st.setState({ panels: st.getState().panels.map((p: any) => ({ ...p, collapsed: p.id === source.id })),
      selectedDatasets: new Set(), filteredReadIds: { [key]: new Set(ids) },
      selectedFeatures: [{ kind: 'fp-class', source: 'sort-fixture', id: 'class_1', datasetId: source.datasetId,
        chrom: s.chrom, start: s.start, end: s.end, label: 'Class 1' }] });
    return { key, datasetId: source.datasetId, panelId: copy.id, ids };
  });
  await settled(page);
  await choose(page, 'features');
  // Controlled feature states isolate toolbar sorting from the upstream class-finding job.
  const ordered = [...target.ids.slice(10).sort(), ...target.ids.slice(0, 10).sort()];
  const body = { features: [], by_dataset: { [target.datasetId]: Object.fromEntries(target.ids.map((id: string, i: number) => [id, i < 10 ? '0' : '1'])) } };
  let release!: () => void;
  let gate = new Promise<void>(r => { release = r; });
  await page.route('**/api/features/states', async route => {
    await gate;
    await route.fulfill({ json: body });
  });
  await page.getByTestId('sort-run-button').click();
  await expect(page.getByTestId('sort-run-button')).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(page.getByTestId('sort-run-button')).not.toHaveAttribute('aria-busy', 'true');
  expect(await state(page, s => s.readSortOrder)).toEqual({ [target.key]: ordered });
  await settled(page);
  expect(await state(page, s => s.activeReadIds)).toMatchObject({ [target.key]: ordered });

  gate = new Promise<void>(r => { release = r; });
  await page.getByTestId('sort-run-button').click();
  await expect(page.getByTestId('sort-run-button')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(id => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.navigatePanel(id, s.chrom, s.start + 10, s.end - 10);
  }, target.panelId);
  const afterNavigation = await state(page, s => s.readSortOrder);
  release();
  await expect(page.getByTestId('run-result-sort-text')).toContainText('not applied');
  expect(await state(page, s => s.readSortOrder)).toEqual(afterNavigation);
});
