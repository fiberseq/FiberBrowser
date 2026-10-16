import { test, expect } from '../fixtures/server';

test.use({ fixtureBam: 'demo' });
test('a pooled graph shares read-panel picks and additive chart picks', async ({ page, server }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__, s = store.getState();
    const panel = s.panels.find((p: any) => p.contentType === 'dataset');
    const copy = s.duplicatePanel(panel.id);
    s.setNavigationMode('perPanel');
    for (const id of [panel.id, copy]) s.navigatePanel(id, 'chr19', 47514000, 47518000);
    const start = 47515500, end = start + 400;
    const group = s.upsertMatchedGroup({ name: 'Identical windows', regions: [{ index: 0, chrom: 'chr19', start, end,
      match: { groupId: '', label: 'W1', length: 400, reversed: false, blocks: [{ frame: [0, 400], genomic: [start, end] }] } }] });
    s.selectMatchedGroup(group); s.setClusterMethod('graph');
    store.setState({ analysisSampleCount: 0, analysisSampleSeed: '42' });
  });
  const response = page.waitForResponse(r => r.url().includes('/api/cluster-regions') && r.request().method() === 'POST');
  await page.getByTestId('cluster-run-button').click();
  const result = await (await response).json();
  expect(result.window_separation_nmi).toBeCloseTo(0, 10);
  const rows = Object.values(result.results) as any[];
  expect(rows).toHaveLength(2);
  expect(rows[0].assignments).toEqual(rows[1].assignments);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().clusterMatchedRun?.windows.length)).toBe(2);
  await expect(page.getByTestId('run-result-cluster-text')).toHaveCount(0);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().openAnalysisPanel('cluster-detail'));
  await expect(page.getByTestId('cluster-detail-run-note')).toContainText('one neighbourhood graph');
  const canvases = page.locator('canvas[data-copilot-track="reads"]');
  await expect(canvases).toHaveCount(2);
  // Click the colourbar at a read row, as the owner did.
  await canvases.first().click({ position: { x: 10, y: 80 } });
  const picks = () => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return s.clusterMatchedRun.windows.map((w: any) => [...(s.selectedClusters[w.stateKey] ?? [])]);
  });
  await expect.poll(async () => (await picks())[0].length).toBe(1);
  const selected = await picks();
  expect(selected[1]).toEqual(selected[0]);
  // The Overview applies to both state keys: an additive click must toggle only once.
  const card = page.locator('[title="Click to select, Shift/Cmd-click to add or remove from selection, Drag to reorder"]').filter({ has: page.getByText(`C${selected[0][0]}`, { exact: true }) }).first();
  await card.click({ modifiers: ['Shift'] });
  await expect.poll(picks).toEqual([[], []]);
  await canvases.nth(1).click({ position: { x: 10, y: 80 } });
  await expect.poll(async () => (await picks())[1].length).toBe(1);
  const other = await picks();
  expect(other[0]).toEqual(other[1]);
});
