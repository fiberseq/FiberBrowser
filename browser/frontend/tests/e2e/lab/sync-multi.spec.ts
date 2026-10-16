import { test, expect } from '../fixtures/server';

test.use({ fixtureBam: 'demo' });

test('three-window map selection accepts several blocks together and Undo restores them', async ({ page, server }, info) => {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(server.baseUrl); await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const first = s.panels.find((p: any) => p.contentType === 'dataset');
    const ids = [first.id, s.duplicatePanel(first.id), s.duplicatePanel(first.id)];
    s.setNavigationMode('perPanel');
    ids.forEach((id: string, i: number) => s.navigatePanel(id, 'chr19', 47510000 + i * 3000, 47512000 + i * 3000));
    s.openAnalysisPanel('sync-regions');
  });
  let result: unknown;
  await page.route('**/api/lab/region-sync/jobs', async route => {
    const { windows } = route.request().postDataJSON();
    const proposals = [200, 1000].flatMap((offset, block) => [1, 2].map(i => ({
      id: `${block}-${i}`, partnerId: windows[i - 1].panelId, panelId: windows[i].panelId,
      template: [windows[i - 1].start + offset, windows[i - 1].start + offset + 400],
      window: [windows[i].start + offset, windows[i].start + offset + 400], strand: '+', rank: 0,
      sources: ['sequence'], metrics: { sequence: { verdict: 'supports', score: 1 } }, status: 'single-metric', confidence: 1, supports: 1, assessed: 1,
    })));
    result = { windows, proposals, metrics: ['sequence'], notes: [], coverage: {} };
    await route.fulfill({ json: { id: 'multi', state: 'queued', message: 'Queued', result: null } });
  });
  await page.route('**/api/lab/region-sync/jobs/multi', route => route.fulfill({ json: { id: 'multi', state: 'complete', message: 'Ready', result } }));
  await page.getByTestId('sync-find').click();
  const inputs = page.locator('[data-testid^="sync-member-"] input');
  await expect(inputs).toHaveCount(6);
  await expect(page.getByTestId('sync-accept-blocks')).toHaveText('Accept selected blocks (2)');
  await page.getByTestId('sync-clear-members').click();
  const bars = page.locator('[data-testid^="sync-map-member-"]');
  await bars.nth(0).click();
  await bars.nth(2).click({ modifiers: ['Shift'] });
  await bars.nth(4).focus(); await page.keyboard.press('Space');
  await expect(page.getByTestId('sync-accept-blocks')).toHaveText('Accept selected blocks (1)');
  await expect.poll(() => inputs.evaluateAll(nodes => nodes.filter(n => (n as HTMLInputElement).checked).length)).toBe(3);
  // Drag over all three lanes selects both blocks; list and map agree.
  await page.keyboard.press('Escape');
  const map = await page.getByTestId('sync-map-svg').boundingBox();
  await page.mouse.move(map!.x + 2, map!.y + 2); await page.mouse.down();
  await page.mouse.move(map!.x + map!.width - 3, map!.y + map!.height - 3, { steps: 10 }); await page.mouse.up();
  await expect.poll(() => inputs.evaluateAll(nodes => nodes.filter(n => (n as HTMLInputElement).checked).length)).toBe(6);
  await page.getByTestId('sync-results').screenshot({ path: info.outputPath('three-window-selection.png') });
  await page.getByTestId('sync-accept-blocks').click();
  const frames = () => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().comparisonFrames);
  expect((await frames()).map((f: any) => f.windows.length)).toEqual([3, 3]);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().undo());
  await expect.poll(async () => (await frames()).length).toBe(0);
});
