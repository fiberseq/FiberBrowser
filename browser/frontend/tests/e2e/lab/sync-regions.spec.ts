import { test, expect } from '../fixtures/server';

test.use({ fixtureBam: 'demo' });

test('Synchronise regions: map two loci, refine, accept and show a frame', async ({ page, server }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const ids = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const first = s.panels.find((p: any) => p.contentType === 'dataset');
    const second = s.duplicatePanel(first.id);
    s.setNavigationMode('perPanel');
    s.navigatePanel(first.id, 'chr19', 47_510_000, 47_525_000);
    s.navigatePanel(second, 'chr19', 47_511_000, 47_526_000);
    s.openAnalysisPanel('sync-regions');
    return [first.id, second];
  });
  await expect(page.getByTestId('sync-windows')).toBeVisible();
  await expect(page.getByTestId('analysis-panel-header-sync-regions')).not.toContainText('PREVIEW');
  await expect(page.getByTestId(`sync-window-${ids[0]}`)).toContainText('W1');
  await expect(page.getByTestId(`sync-window-${ids[1]}`)).toContainText('W2');
  await page.getByTestId('sync-metric-anchor-input').check();
  for (const id of ids) {
    await page.getByTestId(`sync-window-${id}-input`).check();
    await page.getByTestId(`sync-anchor-position-${id}`).fill(id === ids[0] ? '47517700' : '47518200');
  }
  const sequence = page.getByTestId('sync-metric-sequence-input');
  if (await sequence.isEnabled()) await sequence.uncheck();
  await page.getByTestId('sync-metric-shape-input').uncheck();
  await page.getByTestId('sync-find').click();
  // Known correspondences may precede the searched anchor proposal.
  const row = page.locator('[data-testid^="sync-proposal-"]').filter({ hasText: 'Anchor' }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  const ribbon = page.getByTestId(`sync-ribbon-${await row.getAttribute('data-proposal')}`);
  await expect(ribbon).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(row).toContainText('Anchor');
  await expect(page.getByTestId('sync-why')).toContainText('Feature anchor supports');
  await ribbon.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('sync-refine-start').fill('47517600');
  await page.getByTestId('sync-refine-end').fill('47517900');
  // The comparability checklist folds to one line when nothing is wrong.
  if (!(await page.getByTestId('sync-min-reads').isVisible())) await page.getByTestId('sync-comparable-summary').click();
  await page.getByTestId('sync-min-reads').fill('1');
  await expect(page.getByTestId('sync-checklist')).toContainText('Equal length: 300 frame bp each');
  await expect(page.getByTestId('sync-checklist')).toContainText('reads cover ≥80% (need 1)');
  await page.getByTestId('sync-cluster').locator('summary').click();
  await page.getByTestId('sync-cluster-run').click();
  await expect(page.getByTestId('sync-cluster-result')).toContainText('Mean profiles agree', { timeout: 30_000 });
  await expect(page.getByTestId('sync-accept')).toBeEnabled();
  // Exercise the same body at dock and full-view widths without changing the data panels.
  for (const width of [420, 1400]) {
    await page.getByTestId('sync-header').evaluate((header, width) => {
      const shell = header.parentElement!.parentElement!;
      shell.style.width = `${width}px`;
      shell.style.maxWidth = 'none';
    }, width);
    await expect.poll(async () => page.getByTestId('sync-map').evaluate(map => {
      const svg = map.querySelector('svg')!;
      return Math.abs(svg.viewBox.baseVal.width - map.clientWidth) < 2;
    })).toBe(true);
    expect(await page.getByTestId('sync-header').evaluate(header => {
      const body = header.parentElement!;
      return body.scrollWidth <= body.clientWidth;
    })).toBe(true);
    const input = await page.getByTestId('sync-frame-name').boundingBox();
    const accept = await page.getByTestId('sync-accept').boundingBox();
    expect(accept!.y).toBeGreaterThanOrEqual(input!.y + input!.height);
  }
  await page.getByTestId('sync-header').evaluate(header => {
    const shell = header.parentElement!.parentElement!;
    shell.style.removeProperty('width');
    shell.style.removeProperty('max-width');
  });
  await page.getByTestId('sync-map').screenshot({ path: test.info().outputPath('sync-map.png') });
  await page.getByTestId('sync-refine').screenshot({ path: test.info().outputPath('sync-refine.png') });
  await page.getByTestId('sync-accept').click();
  await expect(page.getByTestId('sync-active-frame')).toContainText('300 bp');
  await page.getByTestId('sync-show-panels').click();
  const frame = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return s.comparisonFrames.find((f: any) => f.id === s.activeComparisonFrameId);
  });
  expect(frame.status).toBe('accepted');
  expect(frame.windows.map((w: any) => w.end - w.start)).toEqual([300, 300]);
  expect(frame.windows.map((w: any) => w.blocks.length)).toEqual([1, 1]);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('sync-export-bed').click()]);
  const bed = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
  expect(bed.trim().split('\n')).toHaveLength(3);
  // Advanced thresholds stay per viewer and reset.
  await page.getByTestId('sync-setup-summary').click();
  await page.getByTestId('sync-advanced-toggle').click();
  await page.getByTestId('sync-knob-maxIndel').fill('500');
  await expect(page.getByTestId('sync-knob-reset-maxIndel')).toBeEnabled();
  await page.getByTestId('sync-knob-reset-maxIndel').click();
  await expect(page.getByTestId('sync-knob-maxIndel')).toHaveValue('2000');
});

test('Synchronise regions: an accepted frame survives opening the NFR panel, closing and reopening and full view; it is marked on its panels', async ({ page, server }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!sessionStorage.getItem('sync-once')) { localStorage.clear(); sessionStorage.setItem('sync-once', '1'); }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const ids = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const first = s.panels.find((p: any) => p.contentType === 'dataset');
    const second = s.duplicatePanel(first.id);
    s.setNavigationMode('perPanel');
    s.navigatePanel(first.id, 'chr19', 47_510_000, 47_525_000);
    s.navigatePanel(second, 'chr19', 47_511_000, 47_526_000);
    return [first.id, second];
  });
  // Opened from the rail, as the owner did.
  await page.getByTestId('panel-rail-sync-regions').click();
  await expect(page.getByTestId('sync-find')).toBeVisible();
  await page.getByTestId('sync-metric-anchor-input').check();
  for (const id of ids) {
    await page.getByTestId(`sync-window-${id}-input`).check();
    await page.getByTestId(`sync-anchor-position-${id}`).fill(id === ids[0] ? '47517700' : '47518200');
  }
  const sequence = page.getByTestId('sync-metric-sequence-input');
  if (await sequence.isEnabled()) await sequence.uncheck();
  await page.getByTestId('sync-metric-shape-input').uncheck();
  await page.getByTestId('sync-find').click();
  await page.locator('[data-testid^="sync-proposal-"]').first().click({ timeout: 60_000 });
  await page.getByTestId('sync-refine-start').fill('47517600');
  await page.getByTestId('sync-refine-end').fill('47517900');
  if (!(await page.getByTestId('sync-min-reads').isVisible())) await page.getByTestId('sync-comparable-summary').click();
  await page.getByTestId('sync-min-reads').fill('1');
  await page.getByTestId('sync-accept').click();
  const frameId = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().activeComparisonFrameId);
  expect(frameId).toBeTruthy();
  const frameState = () => page.evaluate(() => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); return [s.comparisonFrames.length, s.activeComparisonFrameId]; });
  // Both windows cover the same locus: each panel shows each region once.
  const expectPanelRegions = async () => {
    for (const id of ids) {
      const regions = page.locator(`[data-panel-id="${id}"] button[data-testid^="matched-region-matched-"]`);
      await expect(regions).toHaveCount(2);
      const labels = await regions.evaluateAll(buttons => buttons.map(button => button.getAttribute('data-testid')));
      expect(new Set(labels).size).toBe(2);
    }
  };
  await expectPanelRegions();
  // The owner's step: open the NFR panel.
  await page.getByTestId('panel-rail-accessibility').click();
  await expect(page.locator('[data-panel-content-type="accessibility"]')).toBeVisible();
  expect(await frameState()).toEqual([1, frameId]);
  await expectPanelRegions();
  // Close the Synchronise panel and open it again: the frame is still listed and active.
  await page.locator('[data-testid="analysis-panel-header-sync-regions"] [aria-label="Close panel"]').click();
  await page.getByTestId('panel-rail-sync-regions').click();
  await expect(page.getByTestId('sync-active-frame')).toContainText('v1');
  // Full view and back.
  await page.locator('[data-testid="analysis-panel-header-sync-regions"] [aria-label="Expand to full view"]').click();
  await expect(page.getByTestId('sync-active-frame')).toContainText('v1');
  await page.locator('[aria-label="Restore all panels"]').first().click();
  expect(await frameState()).toEqual([1, frameId]);
  // Session save and restore are covered by the lab session extension's unit tests (syncState.test.ts).
  expect(errors).toEqual([]);
});
