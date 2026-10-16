import { test, expect } from '../fixtures/server';

test.use({ fixtureBam: 'demo' });

test('Find classes sends both selected windows and outlines their genomic spans', async ({ page, server }) => {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const panel = s.panels.find((p: any) => p.contentType === 'dataset');
    const copy = s.duplicatePanel(panel.id);
    s.setNavigationMode('perPanel');
    s.navigatePanel(panel.id, 'chr19', 47517000, 47518500);
    s.navigatePanel(copy, 'chr19', 47519000, 47520500);
    const regions = [47517600, 47519600].map((start, i) => ({ index:i, chrom:'chr19', start, end:start+300,
      match:{ groupId:'', label:`W${i+1}`, length:300, reversed:i===1, blocks:[{frame:[0,300],genomic:[start,start+300]}] } }));
    const group=s.upsertMatchedGroup({name:'Pair',regions}); s.selectMatchedGroup(group);
    s.setClassRegionMode('matched'); s.openAnalysisPanel('footprint-analysis');
  });
  await expect(page.getByTestId('class-region-matched')).toHaveAttribute('aria-pressed','true');
  await expect(page.getByTestId('class-region-line')).toContainText('Pair');
  const requests: any[] = [];
  await page.route('**/api/lab/region-classes', async route => {
    const request=route.request().postDataJSON(); requests.push(request);
    await route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({detail:'Test stopped before inference'})});
  });
  await page.getByTestId('run-lattice-consensus').click();
  await expect.poll(()=>requests.length).toBe(1);
  expect(requests[0].region_windows.map((w:any)=>[w.start,w.end,w.strand])).toEqual([[47517600,47517900,'+'],[47519600,47519900,'-']]);
  await expect(page.getByTestId('class-matched-region-outline').first()).toBeVisible();
  await page.getByTestId('class-region-clear').click();
  await expect(page.getByTestId('class-region-view')).toHaveAttribute('aria-pressed','true');
});

test('Footprints offers one click from a gapped origin-crossing group to shared rigid windows', async ({ page, server }) => {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const panel = s.panels.find((p: any) => p.contentType === 'dataset');
    const copy = s.duplicatePanel(panel.id);
    s.setNavigationMode('perPanel');
    s.navigatePanel(panel.id, 'chr19', 47517000, 47518500);
    s.navigatePanel(copy, 'chr19', 47519000, 47520500);
    const regions = [47517600, 47519600].map((start, i) => ({ index: i, chrom: 'chr19', start, end: start + 500,
      match: { groupId: '', label: `W${i + 1}`, length: 400, reversed: i === 1, wrapsOrigin: i === 1,
        blocks: [{ frame: [0, 100], genomic: [start, start + 100] }, { frame: [150, 400], genomic: [start + 250, start + 500] }] } }));
    const group = s.upsertMatchedGroup({ name: 'Gapped pair', regions }); s.selectMatchedGroup(group);
    s.setClassRegionMode('matched'); s.openAnalysisPanel('footprint-analysis');
  });
  await expect(page.getByTestId('consensus-reference-problem')).toContainText('gaps or cross the origin');
  await page.getByTestId('consensus-shared-block').click();
  await expect(page.getByTestId('consensus-reference-problem')).toHaveCount(0);
  await expect(page.getByTestId('class-region-line')).toContainText('250 bp');
  const groups = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return s.peakRules.filter((r: any) => r.source === 'matched').map((r: any) => s.peaksByRule[r.id]);
  });
  expect(groups).toHaveLength(2);
  expect(groups[0][0].match.blocks).toHaveLength(2);
  expect(groups[1].map((p: any) => [p.match.length, p.match.reversed, p.match.wrapsOrigin])).toEqual([[250, false, false], [250, true, false]]);
});
