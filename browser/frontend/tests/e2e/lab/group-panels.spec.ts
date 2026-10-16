import { test, expect } from '../fixtures/server';

test.use({ fixtureBam: 'demo' });

test('three regions from one dataset open, reverse and cluster in separate panels, then close', async ({ page, server }) => {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('fiberbrowser_show_run_summaries', 'true');
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const original = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.setViewport('chr19', 47517000, 47520500);
    for (const start of [47517600, 47518000, 47518400]) s.addCustomPeak(start, start + 300, 'chr19');
    const now = (window as any).__FIBERBROWSER_STORE__.getState();
    now.replacePeakSelection(now.getAllPeaks().filter((p: any) => p.isCustom).map((p: any) => p.index));
    now.setClusterMethod('kmeans'); now.setClusterK(2);
    return now.panels.map((p: any) => p.id);
  });
  await page.locator('[data-copilot-track="peaks"] canvas').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Link as matched', exact: true }).click();
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const rule = s.peakRules.find((r: any) => r.source === 'matched');
    s.reverseMatchedRegion(s.peaksByRule[rule.id][2].index);
  });
  const open = page.locator('button[data-testid^="matched-group-open-panels-"]').first();
  await open.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('split-group-strip')).toContainText('3 regions');
  await expect.poll(() => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return s.panels.filter((p: any) => p.regionPanelGroup).map((p: any) => p.reversed);
  })).toEqual([false, false, true]);
  const response = page.waitForResponse(r => r.url().includes('/api/cluster-regions') && r.request().method() === 'POST');
  await page.evaluate(() => window.dispatchEvent(new Event('fiberhmm:run-cluster')));
  expect((await response).ok()).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return s.panels.filter((p: any) => p.regionPanelGroup).map((p: any) => Object.keys(s.clusterAssignments[p.stateKey] ?? {}).length > 0);
  })).toEqual([true, true, true]);
  const assignments = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return s.panels.filter((p: any) => p.regionPanelGroup).map((p: any) => s.clusterAssignments[p.stateKey]);
  });
  // Sessions saved before dataset identity was retained must reopen too.
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const run = store.getState().clusterMatchedRun;
    store.setState({ clusterMatchedRun: { ...run, windows: run.windows.map(({ datasetId, ...window }: any) => window) } });
  });
  await page.getByTestId('split-group-strip-close').click();
  await expect(page.getByTestId('split-group-strip')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.map((p: any) => p.id))).toEqual(original);
  await open.click();
  await expect.poll(() => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return s.panels.filter((p: any) => p.regionPanelGroup).map((p: any) => s.clusterAssignments[p.stateKey]);
  })).toEqual(assignments);
});
