/**
 * Quantify a window on the cluster profiles (WINDOW_QUANT.md), on the tracked NAPA demo BAM:
 *
 *   cluster the reads → Find classes on a 300 bp stretch → Clusters › Profiles: drag a window across a profile →
 *   Quantify window → bars with whiskers for the active layers per cluster → footprint families in the picker →
 *   their shares per cluster (Wilson) and the equal-shares test → table with n reads, TSV → a row filters the panel
 *   to its reads (chip, one-click undo) → Keep to the Gallery (the spec, window and sampling in the PlotSpec).
 *
 * Find classes runs for real (FiberHMM, FIBERBROWSER_E2E_CORES cores, ~30 s).
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const SHOTS = process.env.FIBERBROWSER_E2E_SHOTS;
const CORES = Number(process.env.FIBERBROWSER_E2E_CORES ?? 2);
const CLASS_REGION = { chrom: 'chr19', start: 47_515_000, end: 47_515_300 };

const getState = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); return new Function('s', `return (${f})(s)`)(s); }, fn.toString()) as Promise<T>;

async function openAt(page: Page, server: ServerFixture) {
  await page.setViewportSize({ width: 1700, height: 1100 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const r = server.defaultRegion!;
  const reads = page.waitForResponse(res => res.url().includes('/api/reads/compact'), { timeout: 45_000 }).catch(() => null);
  await page.getByTestId('location-search-input').fill(`${r.chrom}:${r.start}-${r.end}`);
  await page.getByTestId('location-search-submit').click();
  await reads;
  await page.waitForTimeout(1500);
}

async function cluster(page: Page) {
  await expect.poll(() => getState(page, s => s.getAllPeaks().length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.replacePeakSelection([0, 1]);
    st.setClusterMethod('kmeans');
  });
  const done = page.waitForResponse(res => res.url().includes('/api/cluster_all'), { timeout: 60_000 });
  await page.getByTestId('cluster-run-button').click();
  await done;
  await expect.poll(() => getState(page, s => Object.values(s.clusterAssignments)
    .reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0)), { timeout: 45_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
}

async function findClasses(page: Page, server: ServerFixture) {
  await page.route('**/api/footprint/consensus/jobs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    body.parameters = { ...(body.parameters ?? {}), compute: { ...(body.parameters?.compute ?? {}), cores: CORES } };
    await route.continue({ postData: JSON.stringify(body) });
  });
  await panelButton(page, 'footprint-analysis').click();
  const panel = page.getByTestId('consensus-tools');
  await expect(panel).toBeVisible();
  await panel.getByText('Advanced: edit classes, export, algorithm settings', { exact: true }).click();
  await panel.getByText('Algorithm, region, and display settings', { exact: true }).click();
  await panel.getByLabel('Consensus chromosome', { exact: true }).fill(CLASS_REGION.chrom);
  await panel.getByLabel('Consensus start (0-based)', { exact: true }).fill(String(CLASS_REGION.start));
  await panel.getByLabel('Consensus end (exclusive)', { exact: true }).fill(String(CLASS_REGION.end));
  const posted = page.waitForResponse(r => r.url().endsWith('/api/footprint/consensus/jobs') && r.request().method() === 'POST');
  await panel.getByTestId('run-lattice-consensus').click();
  const submitted = await posted;
  expect(submitted.ok(), await submitted.text()).toBe(true);
  const { job_id: jobId } = await submitted.json();
  await expect.poll(async () => {
    const job = await (await page.request.get(`${server.baseUrl}/api/footprint/consensus/jobs/${jobId}`)).json();
    if (job.status === 'failed') throw new Error(JSON.stringify(job));
    return job.status;
  }, { timeout: 240_000, intervals: [1000] }).toBe('complete');
  await expect(panel.getByTestId('recaller-class-table')).toBeVisible({ timeout: 30_000 });
}

test('quantify a window on the cluster profiles: layers and footprint families per cluster, table, reads, Keep', async ({ server, page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openAt(page, server);

  // The main metaprofile track: Select window, then a drag sets the window (no zoom); Quantify window opens its card.
  const view0 = await getState(page, s => [s.start, s.end] as [number, number]);
  const select = page.getByTestId('quant-track-select').first();
  await expect(select).toBeVisible({ timeout: 30_000 });
  await select.click();
  const tcap = page.getByTestId('quant-track-band-capture').first();
  const tb = (await tcap.boundingBox())!;
  await page.mouse.move(tb.x + tb.width * 0.4, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width * 0.6, tb.y + tb.height / 2, { steps: 6 });
  await page.mouse.up();
  const tw = await getState(page, s => s.windowQuant.window);
  const span = view0[1] - view0[0];
  expect(Math.abs(tw.from - (view0[0] + 0.4 * span))).toBeLessThan(span * 0.01);
  expect(Math.abs(tw.to - (view0[0] + 0.6 * span))).toBeLessThan(span * 0.01);
  expect(await getState(page, s => [s.start, s.end])).toEqual(view0);
  await page.getByTestId('quant-track-open').first().click();
  const host = page.getByTestId('quant-host-card');
  await expect(host).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(host.getByTestId('quant-measures')).toContainText('per dataset');
  if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/track_window_card.png` }); }
  await host.getByTestId('quant-close').click();
  await page.getByTestId('quant-host-card').waitFor({ state: 'detached' });
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setQuantWindow(null));

  await cluster(page);
  await findClasses(page, server);

  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.getByRole('button', { name: 'Charts', exact: true }).click();
  await panel.getByRole('group', { name: 'Chart', exact: true }).locator('[data-analysis-tab="profiles"]').click();
  const chart = panel.locator('[data-testid="cluster-profile-chart"]').first();
  await expect(chart).toBeVisible({ timeout: 30_000 });

  // No window by default; the Select window button and a first-use hint say how. Drag across the first profile's plot
  // area to make one: the band shows on every profile.
  expect(await getState(page, s => s.windowQuant.window)).toBeNull();
  await expect(panel.getByTestId('quant-select-window')).toBeVisible();
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/select_window_affordance.png` });
  const capture = chart.getByTestId('quant-window-band-capture');
  // The profiles re-render while their reads and classes settle, which can move or replace the capture layer under
  // a drag. Wait for its box to hold still, and redo the drag on a fresh box if a re-render swallowed it.
  const stableBox = async () => {
    let prev = await capture.boundingBox();
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(150);
      const next = await capture.boundingBox();
      if (prev && next && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5
          && Math.abs(prev.width - next.width) < 0.5) return next;
      prev = next;
    }
    return (await capture.boundingBox())!;
  };
  await expect(async () => {
    const box = await stableBox();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => getState(page, s => s.windowQuant.window && s.windowQuant.window.to - s.windowQuant.window.from), { timeout: 3000 }).toBeGreaterThan(100);
  }).toPass({ timeout: 30_000 });
  const shades = panel.getByTestId('quant-window-band-shade');
  expect(await shades.count()).toBe(await panel.locator('[data-testid="cluster-profile-chart"]').count());

  // Typed bounds win: the class stretch (the families overlap it).
  const bar = panel.getByTestId('quant-window-bar');
  await bar.getByTestId('quant-window-from').fill('47515050');
  await bar.getByTestId('quant-window-to').fill('47515250');
  await bar.getByTestId('quant-window-to').press('Enter');
  await expect.poll(() => getState(page, s => s.windowQuant.window)).toEqual({ chrom: 'chr19', from: 47_515_050, to: 47_515_250 });
  await expect(bar.getByTestId('quant-window-text')).toHaveText('200 bp');

  // Quantify: the active layers per cluster, bars with 95% whiskers, the measure and scale on the axis.
  await bar.getByTestId('quant-open').click();
  const card = panel.getByTestId('quant-card');
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  const qchart = card.getByTestId('quant-chart');
  const values = JSON.parse((await qchart.getAttribute('data-values'))!) as Array<number | null>;
  const intervals = JSON.parse((await qchart.getAttribute('data-intervals'))!) as Array<[number, number] | null>;
  const groups = Number(await card.getByTestId('quant-result').getAttribute('data-groups'));
  const nLayers = Number(await card.getByTestId('quant-result').getAttribute('data-measures'));
  expect(groups).toBeGreaterThanOrEqual(2);
  expect(values.length).toBe(groups * nLayers);
  expect(values.filter(v => v != null).every(v => v! >= 0 && v! <= 1)).toBe(true);
  values.forEach((v, i) => { if (v != null && intervals[i]) { expect(intervals[i]![0]).toBeLessThanOrEqual(v + 1e-9); expect(intervals[i]![1]).toBeGreaterThanOrEqual(v - 1e-9); } });
  expect(intervals.filter(Boolean).length).toBeGreaterThan(0);
  await expect(card.getByTestId('quant-measures')).toContainText('Mean over chr19:47,515,050–47,515,250 (200 bp) per cluster');
  await expect(card.getByTestId('quant-measures')).toContainText('bootstrap 95% (1,000 Poisson resamples of reads, seed 1)');
  await expect(card.getByTestId('quant-axis')).toContainText('fraction of covered bp');
  if (SHOTS) { await page.waitForTimeout(300); await panel.screenshot({ path: `${SHOTS}/cluster_profiles_window_layers.png` }); }

  // The card agrees with the curve above it: each cluster's per-read window mean of the first layer against the drawn
  // cluster profile's window mean (500 bins over the view, 'touch' binning; reads sampled the same way when under the cap).
  const cardVsCurve = () => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const w = s.windowQuant.window;
    const el = document.querySelector('[data-testid="quant-card"] [data-testid="quant-chart"]')!;
    const vals = JSON.parse(el.getAttribute('data-values')!) as Array<number | null>;
    const cells = JSON.parse(el.getAttribute('data-cells')!) as string[];
    const ns = JSON.parse(el.getAttribute('data-n')!) as Array<number | null>;
    const rows: Array<{ cell: string; card: number | null; curve: number | null; n: number | null; assigned: number }> = [];
    cells.forEach((cell, i) => {
      const [measure, panelKey, cluster] = cell.split('|');
      const key = measure.replace(/^layer:/, '');
      const arr = s.clusterProfiles[panelKey]?.[Number(cluster)]?.[key === 'footprint' ? 'nuc' : key] as number[] | undefined;
      let curve: number | null = null;
      if (arr) {
        const n = arr.length, bin = (s.end - s.start) / n;
        let sum = 0, ws = 0;
        for (let j = 0; j < n; j++) { const a = s.start + j * bin; const f = Math.max(0, Math.min(a + bin, w.to) - Math.max(a, w.from)) / bin; if (f > 0 && Number.isFinite(arr[j])) { sum += f * arr[j]; ws += f; } }
        curve = ws ? sum / ws : null;
      }
      const assigned = Object.values(s.clusterAssignments[panelKey] ?? {}).filter((c: any) => c === Number(cluster)).length;
      rows.push({ cell, card: vals[i], curve, n: ns[i], assigned });
    });
    return rows;
  });
  // Curve units (the default): the card is the drawn curve's mean over the window's bins, for every layer and cluster.
  const agree = await cardVsCurve();
  console.log('[window-quant] card vs curve (curve units):\n' + agree.map(r => `${r.cell}\tcard=${r.card?.toFixed(4)}\tcurve=${r.curve?.toFixed(4)}\tn=${r.n}\tassigned=${r.assigned}`).join('\n'));
  for (const r of agree) if (r.curve != null && r.card != null) expect(Math.abs(r.card - r.curve)).toBeLessThan(1e-6);
  expect(agree.filter(r => r.card != null && r.curve != null).length).toBeGreaterThan(10);
  await expect(card.getByTestId('quant-measures')).toContainText('layers in curve units');
  await expect(card.getByTestId('quant-measures')).toContainText("reads: the panel's curve reads");
  // The documented alternatives, logged for the record (exact bp on the same reads; exact bp on a fresh sample).
  const update = (patch: Record<string, unknown>) => page.evaluate(p => (window as any).__FIBERBROWSER_STORE__.getState().updateQuantSpec(p), patch);
  const settle = async () => { await page.waitForTimeout(300); await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 60_000 }); };
  await update({ layerUnits: 'exact' }); await settle();
  const exactPool = await cardVsCurve();
  await update({ readSource: 'fetch' }); await settle();
  const exactFetch = await cardVsCurve();
  console.log('[window-quant] exact bp, panel reads / fresh sample:\n' + exactPool.map((r, i) => `${r.cell}\texactPanel=${r.card?.toFixed(4)}\texactFetch=${exactFetch[i]?.card?.toFixed(4)}\tcurve=${r.curve?.toFixed(4)}\tn=${r.n}/${exactFetch[i]?.n}`).join('\n'));
  await update({ layerUnits: 'curve', readSource: 'panel' }); await settle();

  // A layer row in curve units (the default) links back to the group's reads that cover the window (audit 3.1.1: it
  // filtered the panel to nothing); × restores the reads.
  const before = await card.getByTestId('quant-chart').getAttribute('data-values');
  await card.getByTestId('quant-show-table').click();
  await card.getByTestId('quant-row').filter({ has: page.locator('td') }).first().click();
  await expect(card.getByTestId('quant-link-chip')).toBeVisible();
  // The card keeps its numbers while its own filter narrows the panel (it never recomputes from the filtered reads).
  await page.waitForTimeout(1500);
  await card.getByTestId('quant-show-bar').click();
  expect(await card.getByTestId('quant-chart').getAttribute('data-values')).toBe(before);
  await card.getByTestId('quant-show-table').click();
  await expect.poll(() => getState(page, s => Object.values(s.filteredReadIds).reduce((n: number, x: any) => n + (x ? x.size : 0), 0))).toBeGreaterThan(0);
  await card.getByTestId('quant-link-chip').getByTestId('quant-link-undo').click();
  await expect.poll(() => getState(page, s => Object.values(s.filteredReadIds).filter(Boolean).length)).toBe(0);
  await card.getByTestId('quant-show-bar').click();

  // Relative axis (to the view centre): a typed −100..+100 window is stored relative to the anchor; the profiles get a
  // distance axis; the header says the window in both frames.
  await panel.getByTestId('quant-axis-frame-relative').click();
  await panel.getByTestId('quant-axis-frame-anchor').selectOption('centre');
  await expect(panel.getByTestId('quant-axis-frame-label')).toHaveText('Distance from the view centre (bp)');
  await bar.getByTestId('quant-window-from').fill('-100');
  await bar.getByTestId('quant-window-to').fill('100');
  await bar.getByTestId('quant-window-to').press('Enter');
  await expect.poll(() => getState(page, s => s.windowQuant.window)).toEqual({ chrom: 'chr19', from: -100, to: 100, relative: true });
  await expect(panel.getByTestId('quant-axis-strip').first()).toContainText('Distance from the view centre (bp)');
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(card.getByTestId('quant-measures')).toContainText('−100 to +100 bp from the view centre');
  if (SHOTS) { await page.waitForTimeout(300); await panel.screenshot({ path: `${SHOTS}/relative_axis_window.png` }); }
  if (SHOTS) await panel.locator('[data-testid="cluster-profile-chart"]').first().screenshot({ path: `${SHOTS}/relative_axis_profile.png` });
  // Back to genome coordinates and the class stretch.
  await panel.getByTestId('quant-axis-frame-genome').click();
  await bar.getByTestId('quant-window-from').fill('47515050');
  await bar.getByTestId('quant-window-to').fill('47515250');
  await bar.getByTestId('quant-window-to').press('Enter');
  await expect.poll(() => getState(page, s => s.windowQuant.window)).toEqual({ chrom: 'chr19', from: 47_515_050, to: 47_515_250 });

  // The picker: measures grouped by source; footprint families from the Find classes run, available.
  await card.getByTestId('quant-measures-button').click();
  const menu = card.getByTestId('quant-measures-menu');
  await expect(menu.locator('[data-testid="quant-measure-group"][data-source="Layers"]')).toBeVisible();
  const famGroup = menu.locator('[data-testid="quant-measure-group"][data-source="Footprint families"]');
  const famItems = famGroup.locator('[data-testid="quant-measure-item"][data-available="true"]');
  await expect.poll(() => famItems.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect(menu.locator('[data-testid="quant-measure-group"][data-source="Nucleosomes"]')).toBeVisible();
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/measure_picker.png` });
  const famIds = await famItems.evaluateAll(els => els.slice(0, 3).map(e => e.getAttribute('data-measure')!));
  for (const id of famIds) await famGroup.locator(`[data-measure="${id}"] input[type="checkbox"]`).check();
  await menu.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => getState(page, s => s.windowQuant.spec.measures)).toEqual(famIds);

  // Shares of reads per cluster: Wilson intervals, the equal-shares test (one p per family, BH across them).
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(card.getByTestId('quant-measures')).toContainText('Wilson 95% for shares of reads');
  await expect(card.getByTestId('quant-axis')).toContainText('share of reads');
  const famValues = JSON.parse((await card.getByTestId('quant-chart').getAttribute('data-values'))!) as Array<number | null>;
  expect(famValues.length).toBe(groups * famIds.length);
  expect(famValues.filter(v => v != null).every(v => v! >= 0 && v! <= 1)).toBe(true);
  await expect(card.getByTestId('quant-tests')).toContainText('Equal shares across groups');
  if (SHOTS) { await page.waitForTimeout(300); await card.screenshot({ path: `${SHOTS}/families_shares_bars.png` }); }

  // Enrichment over the pooled share (log2), sorted by spread across clusters.
  await card.getByTestId('quant-value').selectOption('enrichment');
  await expect(card.getByTestId('quant-axis')).toContainText('log2 vs the groups shown, pooled');
  await card.getByTestId('quant-sort').selectOption('spread');
  if (SHOTS) { await page.waitForTimeout(300); await card.screenshot({ path: `${SHOTS}/families_enrichment_log2.png` }); }

  // Table: n reads per group; few-read groups greyed, never hidden; TSV.
  await card.getByTestId('quant-show-table').click();
  const rows = card.getByTestId('quant-row');
  await expect(rows).toHaveCount(groups * famIds.length);
  const download = page.waitForEvent('download');
  await card.getByTestId('quant-tsv').click();
  const tsv = await (await download).path();
  const text = readFileSync(tsv!, 'utf8');
  expect(text.split('\n').find(l => l.startsWith('measure\t'))).toContain('n_reads');
  expect(text.split('\n').filter(l => l && !l.startsWith('#')).length).toBe(1 + groups * famIds.length);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/families_table.png` });

  // A row → the panel shows those reads (the read filter), with a chip; × puts every read back.
  const target = rows.filter({ has: page.locator('td') }).first();
  await target.click();
  const chip = card.getByTestId('quant-link-chip');
  await expect(chip).toBeVisible();
  await expect.poll(() => getState(page, s => Object.values(s.readFilterSources ?? {}).some((x: any) => x?.target === 'window-quant'))).toBe(true);
  const filtered = await getState(page, s => Object.values(s.filteredReadIds).reduce((n: number, x: any) => n + (x ? x.size : 0), 0));
  expect(filtered).toBeGreaterThan(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/link_back_filter.png` });
  await chip.getByTestId('quant-link-undo').click();
  await expect(chip).toBeHidden();
  await expect.poll(() => getState(page, s => Object.values(s.filteredReadIds).filter(Boolean).length)).toBe(0);

  // Keep: a kept Gallery card whose PlotSpec records the spec, the window and the sampling.
  await card.getByTestId('quant-keep').click();
  await expect(card.getByTestId('quant-kept')).toBeVisible();
  await card.getByTestId('quant-open-in-plots').click();
  const qplot = page.getByTestId('plots-quant-plot');
  await expect(qplot).toBeVisible({ timeout: 20_000 });
  await expect(qplot).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('plots-quant-builder')).toContainText('chr19:47,515,050–47,515,250 (window)');
  await expect(qplot.getByTestId('quant-result')).toHaveAttribute('data-measures', String(famIds.length));
  // The kept copy is in the Gallery (one card).
  await expect(page.getByTestId('plots-tab-gallery')).toHaveText('Gallery (1)');
  if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/plots_card.png` }); }
  expect(errors).toEqual([]);
});
