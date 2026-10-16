import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
test.use({ fixtureBam: 'demo' });
async function prepare(page: Page, baseUrl: string, region: { chrom: string; start: number; end: number }) {
  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1800, height: 1050 });
  await page.goto(`${baseUrl}/?chrom=${region.chrom}&start=${region.start}&end=${region.end}`);
  await page.waitForFunction(() => !!window.__FIBERBROWSER_STORE__?.getState().datasets.length);
  await page.evaluate(({ region }) => {
    const store = window.__FIBERBROWSER_STORE__!;
    const midpoint = Math.floor((region.start + region.end) / 2);
    const rule = { ...store.getState().peakRules[0], id: 'test', enabled: true, name: 'test', color: '#167dcd' };
    store.setState({ clusterPreparationCount: 10000, clusterMethod: 'kmeans', clusterK: 2,
      downsampleCount: 50, spanningOnly: false, minFootprints: 0, minFootprintsAuto: false,
      clusterPeakMode: 'accessibility', selectedPeaks: new Set([0]),
      peakRules: [rule], peaksByRule: { test: [{ start: midpoint - 25, end: midpoint + 25, index: 0, layer: 0 }] }, peaksLocked: true });
    store.getState().setViewport(region.chrom, region.start, region.end);
  }, { region });
  await page.waitForFunction(() => Object.values(window.__FIBERBROWSER_STORE__!.getState().activeReadIds).some(ids => ids.length > 10 && ids.length <= 50));
}
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
test('displayed preview refines the original full scope; full-only rerun agrees', async ({ page, server }) => {
  test.setTimeout(45_000);
  await prepare(page, server.baseUrl, server.defaultRegion!);
  const held = gate(); const bodies: any[] = [];
  await page.route('**/api/cluster_all?*', async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 2) await held.promise;
    await route.continue();
  });
  await page.getByTestId('cluster-run-button').click();
  await expect(page.getByTestId('analysis-progress')).toContainText('Preview shown');
  await expect.poll(() => bodies.length).toBe(2);
  const preview = await page.evaluate(() => {
    const s = window.__FIBERBROWSER_STORE__!.getState();
    return { counts: Object.values(s.clusterAssignments).map(a => Object.keys(a).length), samples: s.clusterPreparationSamples,
      branch: s.activeClusterTreeNodeId, nodes: Object.keys(s.clusterTreeNodes) };
  });
  expect(Object.values(preview.samples).every((s: any) => s.method === 'displayed_reads_v1')).toBe(true);
  expect(bodies[0].viewports.every((v: any) => v.read_ids.length <= 50)).toBe(true);
  expect(bodies[1].read_ids).toBeUndefined(); expect(bodies[1].viewports).toBeUndefined();
  const fullResponse = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok());
  held.release(); await fullResponse;
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0);
  const full = await page.evaluate(() => {
    const s = window.__FIBERBROWSER_STORE__!.getState();
    return { assignments: s.clusterAssignments, samples: s.clusterPreparationSamples, branch: s.activeClusterTreeNodeId, nodes: Object.keys(s.clusterTreeNodes) };
  });
  expect(Object.keys(full.samples)).toHaveLength(0);
  expect(full.branch).toBe(preview.branch); expect(full.nodes).toEqual(preview.nodes);
  expect(Object.values(full.assignments).reduce((n, a) => n + Object.keys(a).length, 0)).toBeGreaterThan(preview.counts.reduce((a, b) => a + b, 0));
  await page.evaluate(() => window.__FIBERBROWSER_STORE__!.setState({ clusterPreparationCount: null }));
  const rerun = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok());
  await page.getByTestId('cluster-run-button').click(); await rerun;
  await expect.poll(() => page.evaluate(() => window.__FIBERBROWSER_STORE__!.getState().clusterAssignments)).toEqual(full.assignments);
});
test('sort previews displayed IDs, refines the full scope, and navigation cancels refinement', async ({ page, server }) => {
  test.setTimeout(45_000);
  await prepare(page, server.baseUrl, server.defaultRegion!);
  const held = gate(); const bodies: any[] = [];
  await page.route('**/api/sort_reads?*', async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 2) await held.promise;
    await route.continue().catch(() => {});
  });
  await page.getByTestId('sort-run-button').click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(Object.values(bodies[0].read_ids).every((ids: any) => ids.length <= 50)).toBe(true);
  expect(bodies[1].read_ids).toBeUndefined();
  await expect(page.getByTestId('analysis-progress')).toContainText('Preview shown');
  const fullResponse = page.waitForResponse(r => r.url().includes('/api/sort_reads') && r.ok());
  held.release(); await fullResponse;
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Math.max(...Object.values(window.__FIBERBROWSER_STORE__!.getState().readSortOrder).map(ids => ids.length)))).toBeGreaterThan(50);
  const heldAgain = gate(); let fullSent = false;
  await page.unroute('**/api/sort_reads?*');
  await page.route('**/api/sort_reads?*', async route => {
    if (!route.request().postDataJSON().read_ids) { fullSent = true; await heldAgain.promise; }
    await route.continue().catch(() => {});
  });
  await page.getByTestId('sort-run-button').click(); await expect.poll(() => fullSent).toBe(true);
  const failed = page.waitForEvent('requestfailed', r => r.url().includes('/api/sort_reads'));
  await page.evaluate(() => { const s = window.__FIBERBROWSER_STORE__!.getState(); s.setViewport(s.chrom, s.start + 10000, s.end + 10000); });
  heldAgain.release(); await failed;
  await expect(page.getByTestId('analysis-progress')).toContainText('stopped');
});
test('subcluster refinement keeps the same child, full original membership, and hidden complement', async ({ page, server }) => {
  test.setTimeout(45_000);
  await prepare(page, server.baseUrl, server.defaultRegion!);
  await page.evaluate(() => window.__FIBERBROWSER_STORE__!.setState({ clusterPreparationCount: null }));
  const rootResponse = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok());
  await page.getByTestId('cluster-run-button').click(); await rootResponse;
  await page.waitForFunction(() => !!window.__FIBERBROWSER_STORE__!.getState().activeClusterTreeNodeId);
  const parent = await page.evaluate(() => {
    const store = window.__FIBERBROWSER_STORE__!; const s = store.getState();
    const key = Object.keys(s.clusterAssignments)[0]; const assignments = s.clusterAssignments[key];
    const cluster = assignments[Object.keys(assignments)[0]];
    store.setState({ clusterPreparationCount: 10000, selectedClusters: { [key]: new Set([cluster]) } });
    return { key, cluster, assignments, id: s.activeClusterTreeNodeId, count: Object.keys(s.clusterTreeNodes).length };
  });
  const held = gate(); const bodies: any[] = [];
  await page.route('**/api/cluster_all?*', async route => {
    bodies.push(route.request().postDataJSON()); if (bodies.length === 2) await held.promise;
    await route.continue();
  });
  await page.getByTestId('cluster-run-button').click();
  await expect.poll(() => bodies.length).toBe(2);
  const child = await page.evaluate(() => window.__FIBERBROWSER_STORE__!.getState().activeClusterTreeNodeId);
  expect(child).not.toBe(parent.id);
  const requested = bodies[1].read_ids[Object.keys(bodies[1].read_ids)[0]];
  expect(new Set(requested)).toEqual(new Set(Object.keys(parent.assignments).filter(id => parent.assignments[id] === parent.cluster)));
  const response = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok());
  held.release(); await response;
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0);
  const after = await page.evaluate(({ parent, child }) => {
    const s = window.__FIBERBROWSER_STORE__!.getState();
    return { parent: s.clusterTreeNodes[parent.id!].assignments[parent.key], id: s.activeClusterTreeNodeId,
      count: Object.keys(s.clusterTreeNodes).length, assignments: s.clusterAssignments[parent.key],
      saved: s.clusterTreeNodes[child!].assignments[parent.key] };
  }, { parent, child });
  expect(after.id).toBe(child); expect(after.count).toBe(parent.count + 1);
  expect(after.parent).toEqual(parent.assignments); expect(after.saved).toEqual(after.assignments);
  expect(Object.keys(after.assignments).sort()).toEqual(Object.keys(parent.assignments).sort());
  for (const [id, cluster] of Object.entries(parent.assignments)) if (cluster !== parent.cluster) expect(after.assignments[id]).toBe(-1);
});
