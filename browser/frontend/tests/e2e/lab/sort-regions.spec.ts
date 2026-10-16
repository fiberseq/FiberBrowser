import { test, expect } from '../fixtures/server';

test('Sort with matched rows and Open as panels, including a reversed window', async ({ page, server }, info) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  const region = server.defaultRegion!;
  await page.goto(`${server.baseUrl}/?chr=${region.chrom}&start=${region.start}&end=${region.end}`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(r => {
    const st = (window as any).__FIBERBROWSER_STORE__;
    const s = st.getState(), p = s.panels.find((p: any) => p.contentType === 'dataset');
    s.upsertMatchedGroup({ id: 'matched-sort', name: 'Sort regions', regions: [0,1].map(i => {
      const start = r.start + 700 + i * 1200, end = start + 400;
      return { index: 100 + i, chrom: r.chrom, start, end, match: { groupId: 'matched-sort', label: `W${i+1}`, length: 400,
        template: i === 0, reversed: i === 1, datasetId: p.datasetId, panelId: p.id,
        blocks: [{ frame: [0,400], genomic: [start,end] }] } };
    }) });
    st.getState().selectMatchedGroup('matched-sort');
  }, region);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const responses: any[] = [];
  page.on('response', async r => { if (r.url().includes('/api/sort_reads')) responses.push({ request: r.request().postDataJSON(), query: r.url(), status: r.status() }); });
  await page.getByTestId('sort-run-button').click();
  await expect(page.getByTestId('sort-run-button')).not.toHaveAttribute('aria-busy', 'true', { timeout: 90_000 });
  expect(responses).toHaveLength(1);
  expect(responses[0].request.selected_peak_windows).toHaveLength(2);
  await page.getByTestId('matched-group-open-panels-matched-sort').first().click({ force: true });
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 90_000 }).toBe(0);
  const before = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return { ids: s.activeReadIds, panels: s.panels.filter((p: any) => p.regionPanelGroup) };
  });
  expect(before.panels).toHaveLength(2);
  expect(before.panels[1].reversed).toBe(true);
  responses.length = 0;
  await page.getByTestId('sort-run-button').click();
  await expect(page.getByTestId('sort-run-button')).not.toHaveAttribute('aria-busy', 'true', { timeout: 90_000 });
  expect(responses).toHaveLength(2);
  expect(responses.every(r => r.request.selected_peak_windows.length === 1 && r.status === 200)).toBe(true);
  for (const p of before.panels) {
    expect(responses.some(r => Number(new URL(r.query).searchParams.get('start')) === p.viewportOverride.start)).toBe(true);
  }
  await expect.poll(() => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return s.panels.filter((p: any) => p.regionPanelGroup).every((p: any) => s.readSortOrder[p.stateKey]?.length > 0);
  })).toBe(true);
  await info.attach('matched-sort-requests', { body: JSON.stringify(responses, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]);
});
