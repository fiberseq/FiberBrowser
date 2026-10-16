import { test, expect } from './fixtures/server';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const real = process.env.FIBERBROWSER_POSITION_REAL === '1';
test.use({ fixtureBam: real ? undefined : 'demo' });

test('a footprint picked in an unlinked panel has its own sequence, motifs and V-plot', async ({ page, server }, info) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear(); sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1728, height: 1100 });
  await page.goto(server.baseUrl); await page.waitForLoadState('networkidle');
  const panelId = await page.evaluate(real => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const s = store.getState(), first = s.panels.find((p: any) => p.contentType === 'dataset');
    const second = s.duplicatePanel(first.id); s.setNavigationMode('perPanel');
    s.navigatePanel(first.id, real ? 'chr2L' : 'chr19', real ? 9464500 : 47514500, real ? 9466500 : 47516000);
    s.navigatePanel(second, real ? 'chr2L' : 'chr19', real ? 9485000 : 47516000, real ? 9487000 : 47517700);
    store.setState({ chrom: 'chrX', start: 100000, end: 102000, selectedDatasets: new Set(), footprintGroups: [], selectedFootprints: [],
      customMotifs: [{ name: 'A-rich', counts: { A: [20, 20, 20, 20], C: [0, 0, 0, 0], G: [0, 0, 0, 0], T: [0, 0, 0, 0] } }] });
    return second;
  }, real);
  const canvas = page.locator(`[data-panel-id="${panelId}"] [data-copilot-track="reads"]`).first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => page.evaluate(id => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState(), p = s.panels.find((p: any) => p.id === id);
    return (s.activeReadIds[p.stateKey ?? p.datasetId] ?? []).length;
  }, panelId), { timeout: 60_000 }).toBeGreaterThan(0);
  let picked = false;
  for (const y of [.2, .3, .4, .5]) {
    for (const x of [.2, .4, .55, .7, .8]) {
      const box = (await canvas.boundingBox())!;
      await page.keyboard.down('Meta'); await page.mouse.click(box.x + box.width * x, box.y + box.height * y); await page.keyboard.up('Meta');
      picked = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().selectedFootprints.length > 0);
      if (picked) break;
    }
    if (picked) break;
  }
  expect(picked).toBe(true);
  const pickedFootprint = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().selectedFootprints[0]);
  expect(pickedFootprint.chrom).toBe(real ? 'chr2L' : 'chr19');
  const block = page.getByTestId('footprint-size-block').first();
  await expect(block).toBeVisible({ timeout: 45_000 });
  await block.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('[data-panel-content-type="footprint-analysis"] [data-analysis-tab="saved"]').click();
  const sequence = page.waitForResponse(r => r.url().includes('/api/footprint/analyze') && !!r.request().postDataJSON()?.include_motifs, { timeout: 60_000 });
  await page.getByTestId('saved-row').getByTitle('Details', { exact: true }).click();
  const response = await sequence, payload = await response.json();
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).searchParams.get('chrom')).toBe(pickedFootprint.chrom);
  expect(payload.footprints[0].sequence.length).toBeGreaterThan(0);
  await expect(page.getByTestId('entry-motif-controls')).toBeVisible({ timeout: 60_000 });
  const vplot = page.waitForResponse(r => r.url().includes('/api/footprint/analyze') && !!r.request().postDataJSON()?.include_vplot);
  await page.getByRole('button', { name: 'Show V-plot' }).click();
  expect((await vplot).status()).toBe(200);
  const output = process.env.FIBERBROWSER_POSITION_SHOTS ?? info.outputPath('position'); mkdirSync(output, { recursive: true });
  await page.getByTestId('entry-inspect').screenshot({ path: path.join(output, real ? 'n1-unlinked-footprint.png' : 'demo-unlinked-footprint.png') });
  await info.attach('sequence-result', { body: JSON.stringify({ footprint: pickedFootprint, sequence: payload.footprints[0], species: payload.jaspar_species }), contentType: 'application/json' });
});
