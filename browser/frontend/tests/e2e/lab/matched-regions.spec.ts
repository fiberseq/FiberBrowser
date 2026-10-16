import { test, expect } from '../fixtures/server';

test.use({ fixtureBam: 'demo' });

test('link demo peaks across two loci, select partners and cluster both windows', async ({ page, server }) => {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('fiberbrowser_show_run_summaries', 'true');
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const first = s.panels.find((p: any) => p.contentType === 'dataset');
    const second = s.duplicatePanel(first.id);
    s.setNavigationMode('perPanel');
    s.navigatePanel(first.id, 'chr19', 47517000, 47518500);
    s.navigatePanel(second, 'chr19', 47519000, 47520500);
    s.addCustomPeak(47517600, 47517900, 'chr19');
    s.addCustomPeak(47519600, 47519900, 'chr19');
    const now = (window as any).__FIBERBROWSER_STORE__.getState();
    now.replacePeakSelection(now.getAllPeaks().filter((p: any) => p.isCustom).map((p: any) => p.index));
    now.setClusterMethod('kmeans'); now.setClusterK(2);
  });
  await page.locator('[data-copilot-track="peaks"] canvas').first().click({ button: 'right' });
  // The preview badge is included in the menu item's accessible name.
  await page.getByRole('menuitem', { name: 'Link as matched', exact: true }).click();
  await expect(page.getByTestId('run-result-cluster-text')).toContainText('cropped to 300 bp');
  const partners = page.locator('button[data-testid^="matched-region-matched-"]');
  await expect(partners).toHaveCount(2);
  // Buttons on the canvas also have keyboard-accessible equivalents.
  await partners.first().focus(); await page.keyboard.press('Enter');
  await expect(partners.first()).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(partners.nth(1)).toHaveAttribute('aria-pressed', 'true');
  const response = page.waitForResponse(r => r.url().includes('/api/cluster-regions') && r.request().method() === 'POST');
  await page.evaluate(() => window.dispatchEvent(new Event('fiberhmm:run-cluster')));
  expect((await response).ok()).toBe(true);
  await expect(page.getByTestId('run-result-cluster-text')).toContainText('balanced');
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().clusterMatchedRun?.windows.length)).toBe(2);
  const remove = page.locator('button[data-testid^="matched-group-remove-"]').first();
  await remove.focus();
  await expect(remove).toHaveAccessibleName(/Remove F1 ·/);
  await page.keyboard.press('Enter');
  await expect(partners).toHaveCount(0);
  await expect(page.getByTestId('undo-toast')).toContainText('Removed F1 ·');
  await page.getByTestId('undo-toast-undo').click();
  await expect(partners).toHaveCount(2);
});

test('saved groups share rename, removal and undo with peak rows and the palette', async ({ page, server }) => {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const first = s.panels.find((p: any) => p.contentType === 'dataset');
    const second = s.duplicatePanel(first.id);
    s.saveComparisonFrame({ id: 'saved', name: 'Saved comparison', status: 'accepted', version: 1,
      templatePanelId: first.id, length: 300, alignedOn: ['sequence'], windows: [first.id, second].map((panelId, i) => {
        const start = i ? 47519600 : 47517600;
        return { panelId, datasetId: first.datasetId, label: `W${i + 1}`, genome: first.genome ?? null,
          chrom: 'chr19', start, end: start + 300, strand: '+', blocks: [{ frame: [0, 300], genomic: [start, start + 300] }],
          provenance: { metric: 'sequence', score: 1, scores: { sequence: 1 }, flags: [] } };
      }) });
    s.openAnalysisPanel('sync-regions');
  });
  const group = page.getByTestId('sync-group-matched-saved');
  await expect(group).toContainText('F1 · Saved comparison');
  await expect(group).toContainText('2 regions');
  await page.getByTestId('sync-group-show-matched-saved').click();
  await page.getByTestId('sync-group-rename-matched-saved').click();
  await page.getByTestId('sync-group-name').fill('Renamed comparison');
  await page.getByTestId('sync-group-save-name').click();
  await expect(group).toContainText('F1 · Renamed comparison');
  await page.getByTestId('sync-group-remove-matched-saved').click();
  await expect(group).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return [s.comparisonFrames.length, s.peakRules.filter((r: any) => r.source === 'matched').length];
  })).toEqual([0, 0]);
  await page.getByTestId('undo-toast-undo').click();
  await expect(group).toContainText('F1 · Renamed comparison');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('command-palette-input').fill('Remove all matched regions');
  await page.keyboard.press('Enter');
  await expect(group).toHaveCount(0);
  await expect(page.getByTestId('undo-toast')).toContainText('Removed all matched regions');
  await page.getByTestId('undo-toast-undo').click();
  await expect(group).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().comparisonFrames[0]?.name)).toBe('Renamed comparison');
});
