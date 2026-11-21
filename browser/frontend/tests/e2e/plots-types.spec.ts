/**
 * Plots, Phase 2 types (one step each, demo BAM): Metaprofile from compact reads, a line per group, its settings in
 * the request; Compare with one dataset explains itself; Group by None pools; the result lands in the Gallery and
 * redraws from it; Follow recomputes for the new locus.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { writeFileSync } from 'node:fs';
import { test, expect, DEMO_FIXTURE } from './fixtures/server';
import type { Page, Request } from '@playwright/test';

test.use({ fixtureBam: 'demo' });
const REGION = DEMO_FIXTURE.region;

async function openPlots(page: Page, baseUrl: string) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
  });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate((r: typeof REGION) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end), REGION);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  await page.keyboard.press('p');
  await expect(page.getByTestId('plots-workspace')).toBeVisible();
}

const compactFor = (r: Request) => r.url().includes('/api/reads/compact') && new URL(r.url()).searchParams.get('include_layers') === 'true'
  && new URL(r.url()).searchParams.has('layer_names');

test('Metaprofile: lines per group, Compare explains one dataset, None pools, Gallery, Follow', async ({ server, page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');

  const req = page.waitForRequest(compactFor, { timeout: 60_000 });
  await ws.getByTestId('plots-type-metaprofile').click();
  const params = new URL((await req).url()).searchParams;
  expect(params.get('layer_names')).toBe('nuc,tf');
  expect(params.get('max_reads')).toBe('2000');
  const plot = ws.getByTestId('plots-profile-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(plot).toHaveAttribute('data-groups', '1');
  await expect(ws.getByTestId('plots-profile-chart')).toHaveCount(1);
  await expect(ws.getByTestId('plots-title-text')).toHaveText('Metaprofile · All footprints · current view · by dataset');

  // Source: Accessibility reads the msp layer.
  const fire = page.waitForRequest(r => compactFor(r) && new URL(r.url()).searchParams.get('layer_names') === 'msp,fire', { timeout: 60_000 });
  await ws.getByTestId('plots-source-fire').click();
  await fire;
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });

  // Compare sits next to Group by (not under More options); with one dataset its A − B / log2 are disabled and say why.
  await expect(ws.getByTestId('plots-more')).toHaveCount(0);
  await expect(ws.getByTestId('plots-compare-diff')).toBeDisabled();
  await expect(ws.getByTestId('plots-compare-diff')).toHaveAttribute('title', /one dataset/);
  await expect(ws.getByTestId('plots-compare-log2ratio')).toBeDisabled();
  await expect(ws.getByTestId('plots-compare-off')).toBeEnabled();
  await ws.getByTestId('plots-more-options').click();

  // Group by None (pooled).
  await ws.getByTestId('plots-group-none').click();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(ws.getByTestId('plots-title-text')).toContainText('Metaprofile · Accessibility · current view');

  // In the Gallery's Current row, as a profile card (not kept); Follow recomputes for a new locus (the card updates).
  await ws.getByTestId('plots-tab-gallery').click();
  const live = ws.getByTestId('gallery-view').locator('[data-testid="gallery-card"][data-status="working"]');
  await expect(live).toHaveCount(1);
  await expect(live.getByTestId('gallery-meta')).toContainText('Metaprofile');
  await ws.getByTestId('plots-tab-plot').click();
  await ws.getByTestId('plots-caption').click();
  await page.keyboard.press('ArrowRight');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  const v = await page.evaluate(() => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); return [Math.round(s.start), Math.round(s.end)]; });
  await expect(plot).toHaveAttribute('data-computed-for', `chr19:${(v[0] + 1).toLocaleString('en-US')}–${v[1].toLocaleString('en-US')}`);
  expect(errors).toEqual([]);
});

test('Heatmap: per region (no reads × position), the profile on top, sorted by mean / centre / clusters, Gallery', async ({ server, page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');

  // Rows are regions: Heatmap starts on the selected features, and Current view is not offered.
  await page.evaluate(() => { if ((window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().length < 3) (window as any).fiberbrowserCommand?.('scan-peaks'); });
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().length), { timeout: 60_000 }).toBeGreaterThan(2);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().replacePeakSelection([0, 1, 2]));
  await ws.getByTestId('plots-type-heatmap').click();
  const plot = ws.getByTestId('plots-heatmap-plot');
  await expect(plot).toHaveAttribute('data-rows', 'features');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(plot).toHaveAttribute('data-row-count', '3');
  // More options opens by itself (Where is not the view).
  if ((await ws.getByTestId('plots-more-options').getAttribute('aria-expanded')) !== 'true') await ws.getByTestId('plots-more-options').click();
  await expect(ws.getByTestId('plots-where-view')).toBeDisabled();
  await expect(ws.getByTestId('plots-heatmap-measures')).toContainText('per region, 3 selected features ±500 bp, sorted by mean; seed 1');
  await expect(ws.getByTestId('plots-heatmap-chart')).toBeVisible();
  await expect(ws.getByTestId('plots-card')).toHaveAttribute('data-follow', 'pin');
  // Sorts are display only (no new request): centre, then k-means clusters with their row blocks and Save as BED set.
  const display = ws.getByTestId('plots-heatmap-display');
  await display.getByRole('combobox').first().selectOption('centre');
  await expect(ws.getByTestId('plots-heatmap-measures')).toContainText('sorted by the signal at the centre');
  await display.getByRole('combobox').first().selectOption('cluster');
  await ws.getByTestId('plots-heatmap-k').fill('2');
  await ws.getByTestId('plots-heatmap-k').press('Enter');
  await expect(ws.getByTestId('plots-heatmap-measures')).toContainText('k-means clusters (k = 2)');
  await expect(ws.getByTestId('plots-heatmap-clusters')).toBeVisible();
  await ws.getByTestId('plots-heatmap-chart').screenshot({ path: info.outputPath('heatmap-clusters.png') });
  await ws.getByTestId('plots-heatmap-save-all').click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().plotsWorkspace.regionSets.map((s: { name: string; regions: unknown[] }) => s.regions.length).reduce((a: number, b: number) => a + b, 0))).toBe(3);
  await expect(plot).toHaveAttribute('data-state', 'current');

  // The same features, pooled: Metaprofile with Where = Selected features.
  await ws.getByTestId('plots-type-metaprofile').click();
  const pooled = ws.getByTestId('plots-profile-plot');
  await expect(pooled).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(ws.getByTestId('plots-title-text')).toContainText('Metaprofile · All footprints · selected features');
  await ws.getByTestId('plots-type-heatmap').click();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });

  // One working card, now the heatmap (the metaprofile in between updated it, it added no card); nothing kept.
  await ws.getByTestId('plots-tab-gallery').click();
  await expect(ws.getByTestId('gallery-view').getByTestId('gallery-meta').filter({ hasText: 'Heatmap' })).toHaveCount(1);
  await expect(ws.getByTestId('gallery-view').getByTestId('gallery-meta').filter({ hasText: 'Metaprofile · All footprints · selected features' })).toHaveCount(0);
  await expect(ws.getByTestId('gallery-grid').getByTestId('gallery-card')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Group by: None pools size plots on the server; read groups and classes say what they need', async ({ server, page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  const plot = ws.getByTestId('plots-size-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });

  const pooled = page.waitForRequest(r => r.url().includes('/api/cluster/vplot') && JSON.parse(r.postData() || '{}').group_by === 'pooled', { timeout: 60_000 });
  await ws.getByTestId('plots-group-none').click();
  await pooled;
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(ws.getByTestId('plots-size-panel')).toHaveCount(1);
  await expect(ws.getByTestId('plots-count')).toContainText('All datasets');

  await ws.getByTestId('plots-group-read-groups').click();
  await expect(ws.getByTestId('plots-groups-blocker')).toContainText('split a dataset');
  await ws.getByTestId('plots-group-classes').click();
  await expect(ws.getByTestId('plots-groups-blocker')).toContainText('No classes selected');
  expect(errors).toEqual([]);
});

test('Size histogram: footprint sizes per group, its settings, the Gallery', async ({ server, page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  await ws.getByTestId('plots-type-size-histogram').click();
  const plot = ws.getByTestId('plots-histogram-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(plot).toHaveAttribute('data-groups', '1');
  await expect(ws.getByTestId('plots-profile-chart')).toHaveCount(1);
  await expect(ws.getByTestId('plots-title-text')).toHaveText('Size histogram · All footprints · current view · by dataset');
  // A setting (counts) re-finishes; a range change recomputes.
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-histogram-display').getByRole('combobox').first().selectOption('count');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await ws.getByTestId('plots-tab-gallery').click();
  await expect(ws.getByTestId('gallery-view').getByTestId('gallery-card').first().getByTestId('gallery-meta')).toContainText('Size histogram');
  expect(errors).toEqual([]);
});

test('BED region sets: two BEDs by path as groups, anchors, occlusion with the excluded group, counts, heatmap rows', async ({ server, page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // Synthetic, public-safe regions over the demo locus (chr19:47514000-47518000).
  const a = info.outputPath('synthetic_promoters.bed');
  const b = info.outputPath('synthetic_enhancers.bed');
  writeFileSync(a, ['track name=synthetic', ...[0, 1, 2, 3, 4].map(i => `chr19\t${47514600 + i * 600}\t${47514800 + i * 600}\tp${i}\t0\t${i % 2 ? '-' : '+'}`)].join('\n') + '\n');
  writeFileSync(b, [0, 1, 2, 3].map(i => `chr19\t${47514900 + i * 700}\t${47515000 + i * 700}\te${i}`).join('\n') + '\n');
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  await ws.getByTestId('plots-type-metaprofile').click();
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-where-bed').click();
  for (const path of [a, b]) {
    await ws.getByTestId('plots-bed-path').fill(path);
    await ws.getByTestId('plots-bed-add').click();
    await expect(ws.getByTestId('plots-bed-note')).toContainText('regions');
  }
  await expect(ws.getByTestId('plots-bed-set')).toHaveCount(2);
  const plot = ws.getByTestId('plots-bed-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(plot).toHaveAttribute('data-sets', '2');
  await expect(plot).toHaveAttribute('data-groups', '2');
  await expect(ws.getByTestId('plots-bed-counts')).toContainText('synthetic_promoters: 5 of 5 regions');
  await expect(ws.getByTestId('plots-bed-counts')).toContainText('synthetic_enhancers: 4 of 4 regions');
  await expect(ws.getByTestId('plots-card')).toHaveAttribute('data-follow', 'pin');

  // Occlusion per read (nucleosome over the centre), excluded shown as its own group: no new reads requested.
  await ws.getByTestId('plots-bed-occlusion-read').getByRole('combobox').selectOption('centre');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await ws.getByTestId('plots-bed-show-excluded').check();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(ws.getByTestId('plots-bed-counts')).toContainText('excluded by occlusion');
  expect(Number(await plot.getAttribute('data-groups'))).toBeGreaterThan(2);

  // Heatmap: a row per region, in blocks per set, the profile on top; the header says what it measures; BED order and
  // the BED score column sort without reading again.
  await ws.getByTestId('plots-type-heatmap').click();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  expect(Number(await plot.getAttribute('data-rows'))).toBeGreaterThanOrEqual(9);
  await expect(ws.getByTestId('plots-heatmap-measures')).toContainText('BED regions ±');
  const readsAsked: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/plots/region_reads')) readsAsked.push(r.url()); });
  await ws.getByTestId('plots-heatmap-display').getByRole('combobox').first().selectOption('bed');
  await expect(ws.getByTestId('plots-heatmap-measures')).toContainText('in BED order');
  await ws.getByTestId('plots-heatmap-display').getByRole('combobox').first().selectOption('score');
  await expect(ws.getByTestId('plots-heatmap-measures')).toContainText('sorted by BED column 5');
  await ws.getByTestId('plots-heatmap-display').getByRole('combobox').first().selectOption('mean');
  await expect(plot).toHaveAttribute('data-state', 'current');
  expect(readsAsked).toEqual([]);

  // Open the BED card from the Gallery: drawn from its stored data, no region reads requested.
  const asked: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/plots/region_reads')) asked.push(r.url()); });
  await ws.getByTestId('plots-tab-gallery').click();
  await ws.getByTestId('gallery-view').getByTestId('gallery-card').first().getByTestId('gallery-open').click();
  await expect(plot).toHaveAttribute('data-seeded', 'true', { timeout: 30_000 });
  expect(asked).toEqual([]);

  // The sets travel with the session.
  const sets = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().plotsWorkspace.regionSets.map((s: { name: string; regions: unknown[] }) => [s.name, s.regions.length]));
  expect(sets).toEqual([['synthetic_promoters', 5], ['synthetic_enhancers', 4]]);

  // Row clusters (k-means, seeded) saved as BED sets: new region sets, usable as groups by other plots.
  await ws.getByTestId('plots-tab-plot').click();
  await ws.getByTestId('plots-heatmap-display').getByRole('combobox').first().selectOption('cluster');
  await expect(ws.getByTestId('plots-heatmap-clusters')).toBeVisible({ timeout: 30_000 });
  await ws.getByTestId('plots-heatmap-save-all').click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().plotsWorkspace.regionSets.length)).toBeGreaterThan(2);
  const saved = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().plotsWorkspace.regionSets.slice(2).map((s: { name: string; regions: unknown[] }) => s.regions.length));
  // Every region once (5 promoters + 4 enhancers), whatever the groups it is drawn in.
  expect(saved.reduce((a: number, b: number) => a + b, 0)).toBe(9);
  expect(errors).toEqual([]);
});

test('BED region sets: a large set reads in chunks with regions done / total, elapsed time and Cancel', async ({ server, page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // 900 synthetic, public-safe regions over the demo locus; every one read (subsample: all).
  const big = info.outputPath('synthetic_many.bed');
  writeFileSync(big, Array.from({ length: 900 }, (_, i) => `chr19\t${47514300 + (i * 5) % 4200}\t${47514400 + (i * 5) % 4200}\tr${i}`).join('\n') + '\n');
  // Each chunk answers a little late, so the counter can be seen advancing.
  const chunks: number[] = [];
  await page.route('**/api/plots/region_reads', async route => {
    chunks.push(JSON.parse(route.request().postData() || '{}').job_offset ?? -1);
    await new Promise(r => setTimeout(r, 1200));
    await route.continue().catch(() => {});
  });
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  await ws.getByTestId('plots-type-metaprofile').click();
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setPlotsWorkspace((w: any) => ({ ...w, current: { ...w.current, bed: { ...w.current.bed, subsample: 'all', maxRegions: 5000 } } })));
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-where-bed').click();
  await ws.getByTestId('plots-bed-path').fill(big);
  await ws.getByTestId('plots-bed-add').click();
  const progress = ws.getByTestId('plots-bed-progress');
  await expect(progress).toHaveAttribute('data-total', '900', { timeout: 60_000 });
  await expect(progress).toHaveAttribute('data-done', '250');
  await expect(progress).toContainText('Reading regions 250 / 900');
  await expect(progress).toContainText(' s');
  // Cancel: stops (no further chunks), says where it stopped, and offers to read again.
  await ws.getByTestId('plots-bed-cancel').click();
  await expect(ws.getByTestId('plots-bed-cancelled')).toContainText('Cancelled after');
  const asked = chunks.length;
  await page.waitForTimeout(3000);
  expect(chunks.length).toBe(asked);
  // Read again: every chunk, then the plot.
  await ws.getByTestId('plots-bed-retry').click();
  const plot = ws.getByTestId('plots-bed-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(ws.getByTestId('plots-bed-counts')).toContainText('synthetic_many: 900 of 900 regions');
  expect(chunks.slice(asked)).toEqual([0, 250, 500, 750]);
  expect(errors).toEqual([]);
});

test('Differential features: peaks between two clusters, volcano / MA / table, swap, go to a feature, Hub, Gallery', async ({ server, page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    // Selected → Hub needs the experimental full-window hub.
    localStorage.setItem('fiberbrowser_experimental_hub_workspace', 'true');
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate((r: typeof REGION) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end), REGION);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  // Peaks here, then two clusters on one peak's accessibility: that peak differs between the clusters by construction.
  await page.evaluate(() => { if ((window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().length < 2) (window as any).fiberbrowserCommand?.('scan-peaks'); });
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().length), { timeout: 60_000 }).toBeGreaterThan(1);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__;
    // Open / closed at one medium peak (binary): the reads split by that peak, so it must come out differential.
    const peaks = st.getState().getAllPeaks();
    const medium = peaks.find((p: { layer?: number }) => p.layer === 1) ?? peaks[0];
    st.setState({ clusterMethod: 'binary', clusterK: 2, clusterPeakMode: 'accessibility', clusterPreparationCount: null });
    st.getState().replacePeakSelection([medium.index]);
  });
  const clustered = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok(), { timeout: 90_000 });
  await page.getByTestId('cluster-run-button').click();
  await clustered;
  await expect.poll(() => page.evaluate(() => Object.values((window as any).__FIBERBROWSER_STORE__.getState().clusterAssignments as Record<string, object>)
    .reduce((n: number, a) => n + Object.keys(a).length, 0)), { timeout: 60_000 }).toBeGreaterThan(10);
  await page.keyboard.press('p');
  const ws = page.getByTestId('plots-workspace');
  await expect(ws).toBeVisible();

  const asked: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/plots/differential')) asked.push(r.postData() || ''); });
  await ws.getByTestId('plots-type-differential').click();
  await expect(ws.getByTestId('plots-diff-features-peaks')).toHaveAttribute('aria-pressed', 'true');
  // One dataset: by dataset says what it needs; by cluster compares the two clusters.
  await expect(ws.getByTestId('plots-diff-blocker')).toContainText('two datasets');
  await ws.getByTestId('plots-group-cluster').click();
  const plot = ws.getByTestId('plots-diff-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  const body = JSON.parse(asked[asked.length - 1]);
  expect(body.groups.A.reads && body.groups.B.reads).toBeTruthy();
  expect(body.features.length).toBeGreaterThan(1);
  expect(body.features[0].refs[0].hub_hit.stateSpec).toEqual({ kind: 'open' });
  expect(Number(await plot.getAttribute('data-tested'))).toBeGreaterThan(0);
  const up = Number(await plot.getAttribute('data-up')), down = Number(await plot.getAttribute('data-down'));
  expect(up + down).toBeGreaterThan(0);  // at least the clustering peak
  await expect(ws.getByTestId('plots-diff-volcano')).toBeVisible();
  await expect(ws.getByTestId('plots-diff-ma')).toBeVisible();
  await expect(ws.getByTestId('plots-diff-row')).toHaveCount(body.features.length);
  // Sort by Δ, then swap A and B: the calls swap sides.
  await ws.getByTestId('plots-diff-sort-delta').click();
  await ws.getByTestId('plots-diff-swap').click();
  await expect(plot).toHaveAttribute('data-up', String(down), { timeout: 120_000 });
  await expect(plot).toHaveAttribute('data-down', String(up));
  await expect(plot).toHaveAttribute('data-state', 'current');

  // Go to a feature: the browser moves; the plot (pinned to the clustered locus) stays current, no new request.
  const before = asked.length;
  await ws.getByTestId('plots-diff-goto').last().click();
  await page.waitForTimeout(1500);
  await expect(plot).toHaveAttribute('data-state', 'current');
  expect(asked.length).toBe(before);

  // A volcano point: the browser goes to that feature; the pinned plot stays current.
  const top = (await ws.getByTestId('plots-diff-volcano').getAttribute('data-top')) ?? '';
  const [tx, ty] = top.split(',').map(Number);
  expect(Number.isFinite(tx) && Number.isFinite(ty)).toBe(true);
  const viewBefore = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start);
  await ws.getByTestId('plots-diff-volcano').click({ position: { x: tx, y: ty } });
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start)).not.toBe(viewBefore);
  await expect(plot).toHaveAttribute('data-state', 'current');
  expect(asked.length).toBe(before);

  // Called features → the Feature hub, selected there.
  await ws.getByTestId('plots-diff-select-called').click();
  await ws.getByTestId('plots-diff-to-hub').click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().featureHub.selected.length)).toBe(up + down);
  await page.keyboard.press('p');
  await expect(ws).toBeVisible();

  // The Gallery card redraws from its stored table: no new request.
  await ws.getByTestId('plots-tab-gallery').click();
  const card = ws.getByTestId('gallery-view').getByTestId('gallery-card').filter({ has: page.getByTestId('gallery-meta').filter({ hasText: 'Differential features' }) }).last();
  await expect(card).toBeVisible();
  const n = asked.length;
  await card.getByTestId('gallery-open').click();
  await expect(plot).toHaveAttribute('data-seeded', 'true', { timeout: 30_000 });
  await page.waitForTimeout(1000);
  expect(asked.length).toBe(n);

  // Called features → Filter (the reads open at any of them), then → Cluster (on them): each goes back to the reads.
  await ws.getByTestId('plots-tab-plot').click();
  await ws.getByTestId('plots-diff-select-called').click();
  await ws.getByTestId('plots-diff-to-filter').click();
  await expect(ws).toHaveCount(0, { timeout: 60_000 });
  await page.keyboard.press('p');
  await ws.getByTestId('plots-diff-select-called').click();
  const reclustered = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok(), { timeout: 90_000 });
  await ws.getByTestId('plots-diff-to-cluster').click();
  await expect(ws).toHaveCount(0, { timeout: 60_000 });
  await reclustered;
  expect(errors).toEqual([]);
});

test('Co-accessibility: the panel\'s matrix endpoint, signed on RdBu, A − B needs two datasets, the Gallery redraws it', async ({ server, page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  const asked: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/coacc/matrix/data')) asked.push(r.url()); });
  await ws.getByTestId('plots-type-co-accessibility').click();
  const plot = ws.getByTestId('plots-coacc-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  const params = new URL(asked[0]).searchParams;
  expect([params.get('normalization'), params.get('min_coverage'), params.get('chrom')]).toEqual(['correlation', '20', REGION.chrom]);
  await expect(plot).toHaveAttribute('data-signed', 'true');
  await expect(plot).toHaveAttribute('data-blocks', '1');
  await expect(ws.getByTestId('plots-coacc-chart')).toBeVisible();
  // Raw co-accessibility: not signed (magma).
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-coacc-norm-raw').click();
  await expect(plot).toHaveAttribute('data-signed', 'false', { timeout: 120_000 });
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(ws.getByTestId('plots-coacc-colormap')).toHaveValue('magma');
  // A − B with one dataset is disabled and says what it needs.
  await expect(ws.getByTestId('plots-compare-diff')).toBeDisabled();
  await expect(ws.getByTestId('plots-compare-diff')).toHaveAttribute('title', /one dataset/);
  // The Gallery card draws from its cells.
  await ws.getByTestId('plots-tab-gallery').click();
  const card = ws.getByTestId('gallery-view').getByTestId('gallery-card').filter({ has: page.getByTestId('gallery-meta').filter({ hasText: 'Co-accessibility' }) }).last();
  const n = asked.length;
  await card.getByTestId('gallery-open').click();
  await expect(plot).toHaveAttribute('data-seeded', 'true', { timeout: 30_000 });
  await page.waitForTimeout(1000);
  expect(asked.length).toBe(n);
  expect(errors).toEqual([]);
});

test('Size histogram over a BED set: count / bp covered, midpoint / clipped, the header says what it measures, Gallery', async ({ server, page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const bed = info.outputPath('synthetic_sites.bed');
  writeFileSync(bed, [0, 1, 2, 3, 4].map(i => `chr19\t${47514600 + i * 600}\t${47514800 + i * 600}\ts${i}`).join('\n') + '\n');
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  await ws.getByTestId('plots-type-size-histogram').click();
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-where-bed').click();
  await ws.getByTestId('plots-bed-path').fill(bed);
  await ws.getByTestId('plots-bed-add').click();
  const plot = ws.getByTestId('plots-bed-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(ws.getByTestId('plots-hist-measures')).toContainText('All footprints, midpoint in 5 regions');
  await expect(ws.getByTestId('plots-hist-measures')).toContainText('count, fraction; 0–400 bp in 5 bp bins');
  await expect(ws.getByTestId('plots-bed-counts')).toContainText('synthetic_sites: 5 of 5 regions');
  const asked: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/plots/region_reads')) asked.push(r.url()); });
  // bp covered, clipped: recomputed from the same reads (no new region reads).
  await ws.getByTestId('plots-hist-weighting').selectOption('bp');
  await ws.getByTestId('plots-hist-inclusion').selectOption('clipped');
  await expect(ws.getByTestId('plots-hist-measures')).toContainText('clipped to 5 regions', { timeout: 30_000 });
  await expect(ws.getByTestId('plots-hist-measures')).toContainText('bp covered, fraction');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  expect(asked).toEqual([]);
  // Guides on.
  await ws.getByTestId('plots-hist-guides').check();
  await expect(plot).toHaveAttribute('data-state', 'current');
  // The Gallery card redraws from its stored data.
  await ws.getByTestId('plots-tab-gallery').click();
  await ws.getByTestId('gallery-view').getByTestId('gallery-card').filter({ has: page.getByTestId('gallery-meta').filter({ hasText: 'Size histogram' }) }).first().getByTestId('gallery-open').click();
  await expect(plot).toHaveAttribute('data-seeded', 'true', { timeout: 30_000 });
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
});

test('Size histogram of random reads of the whole file: seeded, N per dataset, progress, header with the seed, New seed', async ({ server, page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  const bodies: any[] = [];
  page.on('request', r => { if (r.url().includes('/api/plots/random_reads')) bodies.push(JSON.parse(r.postData() || '{}')); });
  await ws.getByTestId('plots-type-size-histogram').click();
  await ws.getByTestId('plots-sampling-random').click();
  await ws.getByTestId('plots-sampling-n').fill('200');
  await ws.getByTestId('plots-sampling-n').press('Enter');
  await ws.getByTestId('plots-more-options').click();
  // Anchored types can't use it (tooltip says why).
  await ws.getByTestId('plots-where-random').click();
  const plot = ws.getByTestId('plots-random-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(ws.getByTestId('plots-hist-measures')).toContainText('200 random reads per dataset (whole file), seed 1');
  expect(bodies.some(b => b.phase === 'scan' && b.n === 200 && b.seed === 1)).toBe(true);
  expect(bodies.some(b => b.phase === 'reads')).toBe(true);
  await expect(ws.getByTestId('plots-sampling-counts')).toContainText('seed 1');
  // New seed: another sample, the seed in the header.
  await ws.getByTestId('plots-sampling-new-seed').click();
  await expect(ws.getByTestId('plots-hist-measures')).toContainText('seed 2');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  expect(bodies.some(b => b.seed === 2)).toBe(true);
  await ws.getByTestId('plots-type-metaprofile').click();
  await expect(ws.getByTestId('plots-where-random')).toBeDisabled();
  expect(await ws.getByTestId('plots-where-random').getAttribute('title')).toContain('no common position');
  expect(errors).toEqual([]);
});

test('Size enrichment and V-plot over BED anchors: pooled per set, the header says what it measures, Compare between sets, Gallery', async ({ server, page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const a = info.outputPath('synthetic_plus.bed'), b = info.outputPath('synthetic_minus.bed');
  writeFileSync(a, [0, 1, 2, 3, 4].map(i => `chr19\t${47514600 + i * 600}\t${47514700 + i * 600}\tp${i}\t0\t+`).join('\n') + '\n');
  writeFileSync(b, [0, 1, 2, 3].map(i => `chr19\t${47514900 + i * 700}\t${47515000 + i * 700}\tm${i}\t0\t-`).join('\n') + '\n');
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  await ws.getByTestId('plots-type-vplot').click();
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-where-bed').click();
  for (const p of [a, b]) {
    await ws.getByTestId('plots-bed-path').fill(p);
    await ws.getByTestId('plots-bed-add').click();
    await expect(ws.getByTestId('plots-bed-note')).toContainText('regions');
  }
  const plot = ws.getByTestId('plots-bed-size-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(plot).toHaveAttribute('data-plots', '2');
  await expect(ws.getByTestId('plots-size-measures')).toContainText('V-plot pooled over 9 BED regions');
  await expect(ws.getByTestId('plots-size-measures')).toContainText('seed 1');
  await expect(ws.getByTestId('plots-size-panel')).toHaveCount(2);
  // Size enrichment, then Compare (log2 between the two sets): one RdBu panel.
  await ws.getByTestId('plots-type-size-enrichment').click();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await ws.getByTestId('plots-compare-log2ratio').click();
  await expect(ws.getByTestId('plots-size-compare')).toHaveCount(1, { timeout: 120_000 });
  await ws.getByTestId('plots-compare-off').click();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  const asked: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/plots/bed_sizes')) asked.push(r.url()); });
  await ws.getByTestId('plots-tab-gallery').click();
  await ws.getByTestId('gallery-view').getByTestId('gallery-card').filter({ has: page.getByTestId('gallery-meta').filter({ hasText: 'Size enrichment' }) }).first().getByTestId('gallery-open').click();
  await expect(plot).toHaveAttribute('data-seeded', 'true', { timeout: 30_000 });
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
});

test('Size-band metaprofile: one line per band, conditioned on the state at the anchor, the header says what it measures', async ({ server, page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  await ws.getByTestId('plots-type-metaprofile').click();
  const plot = ws.getByTestId('plots-profile-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-profile-band').selectOption('each');
  await expect(plot).toHaveAttribute('data-groups', '3', { timeout: 120_000 });
  await expect(ws.getByTestId('plots-profile-measures')).toContainText('one line per size band (< 90 bp, 90–200 bp, ≥ 200 bp)');
  await ws.getByTestId('plots-profile-band').selectOption('0');
  await expect(plot).toHaveAttribute('data-groups', '1', { timeout: 120_000 });
  await expect(ws.getByTestId('plots-profile-measures')).toContainText('footprints < 90 bp');
  await ws.getByTestId('plots-profile-condition').check();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  expect(Number(await plot.getAttribute('data-groups'))).toBeGreaterThanOrEqual(2);
  await expect(ws.getByTestId('plots-profile-measures')).toContainText('state at the anchor ± 10 bp');
  await expect(ws.getByTestId('plots-profile-measures')).toContainText('seed 1');
  expect(errors).toEqual([]);
});

test('Summary across groups: a size band share per BED set as bars with Wilson intervals, in panel order', async ({ server, page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const a = info.outputPath('sum_a.bed'), b = info.outputPath('sum_b.bed');
  writeFileSync(a, [0, 1, 2].map(i => `chr19\t${47514600 + i * 600}\t${47514800 + i * 600}\ta${i}`).join('\n') + '\n');
  writeFileSync(b, [0, 1, 2].map(i => `chr19\t${47514900 + i * 700}\t${47515100 + i * 700}\tb${i}`).join('\n') + '\n');
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  await ws.getByTestId('plots-type-size-histogram').click();
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-where-bed').click();
  for (const p of [a, b]) {
    await ws.getByTestId('plots-bed-path').fill(p);
    await ws.getByTestId('plots-bed-add').click();
    await expect(ws.getByTestId('plots-bed-note')).toContainText('regions');
  }
  await expect(ws.getByTestId('plots-bed-plot')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await ws.getByTestId('plots-summary-on').check();
  const summary = ws.getByTestId('plots-summary');
  await expect(summary).toHaveAttribute('data-groups', '2', { timeout: 30_000 });
  await expect(ws.getByTestId('plots-summary-measures')).toContainText('Share of 0–90 bp per group, groups in panel order; Wilson 95%');
  const values = JSON.parse((await summary.getAttribute('data-values')) ?? '[]');
  expect(values.every((v: number | null) => v != null && v >= 0 && v <= 1)).toBe(true);
  await ws.getByTestId('plots-summary-chart-kind').selectOption('line');
  await expect(summary).toHaveAttribute('data-groups', '2');
  expect(errors).toEqual([]);
});

test('BED summaries: a seeded bootstrap over regions (default) or reads, the same for the same seed; the box mean too; per-band lines and the state at the anchor', async ({ server, page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const a = info.outputPath('boot_a.bed'), b = info.outputPath('boot_b.bed');
  writeFileSync(a, [0, 1, 2, 3].map(i => `chr19\t${47514600 + i * 600}\t${47514800 + i * 600}\ta${i}`).join('\n') + '\n');
  writeFileSync(b, [0, 1, 2].map(i => `chr19\t${47514900 + i * 700}\t${47515100 + i * 700}\tb${i}`).join('\n') + '\n');
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  await ws.getByTestId('plots-type-metaprofile').click();
  if ((await ws.getByTestId('plots-more-options').getAttribute('aria-expanded')) !== 'true') await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-where-bed').click();
  for (const p of [a, b]) {
    await ws.getByTestId('plots-bed-path').fill(p);
    await ws.getByTestId('plots-bed-add').click();
    await expect(ws.getByTestId('plots-bed-note')).toContainText('regions');
  }
  const plot = ws.getByTestId('plots-bed-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  // Window mean, bootstrap by default, over regions (BED's independent unit).
  await ws.getByTestId('plots-summary-on').check();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  const measures = ws.getByTestId('plots-summary-measures');
  await expect(measures).toContainText('bootstrap 95% (1,000 Poisson resamples of regions, seed 1)', { timeout: 30_000 });
  const summary = ws.getByTestId('plots-summary');
  const regionsIv = await summary.getAttribute('data-intervals');
  expect(JSON.parse(regionsIv ?? '[]').every((x: unknown) => Array.isArray(x))).toBe(true);
  // Reads as the option; back to regions: the same intervals (seeded).
  await ws.getByTestId('plots-summary-unit').selectOption('reads');
  await expect(measures).toContainText('Poisson resamples of reads', { timeout: 60_000 });
  await ws.getByTestId('plots-summary-unit').selectOption('regions');
  await expect(measures).toContainText('Poisson resamples of regions', { timeout: 60_000 });
  await expect(summary).toHaveAttribute('data-intervals', regionsIv ?? '', { timeout: 60_000 });
  // Per-band lines and the state at the anchor, as for the view: groups split (2 sets × 3 bands, then × 3 states).
  await ws.getByTestId('plots-profile-band').selectOption('each');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(plot).toHaveAttribute('data-groups', '6', { timeout: 60_000 });
  await ws.getByTestId('plots-profile-band').selectOption('off');
  await ws.getByTestId('plots-profile-condition').check();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  expect(Number(await plot.getAttribute('data-groups'))).toBeGreaterThan(2);
  await ws.getByTestId('plots-profile-condition').uncheck();
  // The box mean of a BED V-plot: the server's bootstrap over regions.
  await ws.getByTestId('plots-type-vplot').click();
  const sizes = ws.getByTestId('plots-bed-size-plot');
  await expect(sizes).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(measures).toContainText('bootstrap 95% (1,000 Poisson resamples of regions, seed 1)', { timeout: 120_000 });
  expect(JSON.parse((await summary.getAttribute('data-intervals')) ?? '[]').some((x: unknown) => Array.isArray(x))).toBe(true);
  // A V-plot draws log1p counts: the summary is on that scale, over the whole axis (counts are not normalised).
  await expect(measures).toContainText('Mean (log1p counts)');
  // Size enrichment (each size row over its mean, drawn as log2): the default box is the centre (anchor ± 100 bp), on log2.
  await ws.getByTestId('plots-type-size-enrichment').click();
  await expect(sizes).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(measures).toContainText('Mean (log2 enrichment, 0 = average) of 0–90 bp × -100 to 100 (the default centre window)', { timeout: 60_000 });
  // The whole axis is constant by construction: a note instead of bars.
  await ws.getByTestId('plots-summary-from').fill('-5000');
  await ws.getByTestId('plots-summary-from').blur();
  await ws.getByTestId('plots-summary-to').fill('5000');
  await ws.getByTestId('plots-summary-to').blur();
  await expect(ws.getByTestId('plots-summary-note')).toContainText('by construction; pick a window');
  await expect(ws.getByTestId('plots-summary-chart')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('From panels: the panel-defined plots listed in Plots open their panel; ⌘K finds them', async ({ server, page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  await ws.getByTestId('plots-from-panels-toggle').click();
  await expect(ws.getByTestId('plots-from-panel')).not.toHaveCount(0);
  const entry = ws.locator('[data-testid="plots-from-panel"][data-plot="read-stats"]');
  await expect(entry.getByTestId('plots-from-panel-card')).toBeDisabled();
  await entry.getByTestId('plots-from-panel-open').click();
  await expect(page.getByTestId('plots-workspace')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.some((p: any) => JSON.stringify(p).includes('read-stats')))).toBe(true);
  // ⌘K
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.keyboard.type('Local repeat length');
  await expect(page.getByText('Local repeat length (Nucleosomes panel)')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Empty states run their step: no selected features → Scan and select peaks → the features appear and the plot runs', async ({ server, page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  // No peaks yet: a metaprofile over the selected features has nothing to pool.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().replacePeakSelection([]));
  await ws.getByTestId('plots-type-metaprofile').click();
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-where-features').click();
  const step = ws.getByTestId('plots-prereq-select-peaks');
  await expect(step).toBeVisible({ timeout: 30_000 });
  await expect(ws.getByText(/first/)).toHaveCount(0);
  await step.getByTestId('plots-prereq-run-select-peaks').click();
  // The scan runs behind Plots (the workspace stays), the peaks in view are selected, and the plot picks them up.
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().selectedPeaks.size), { timeout: 90_000 }).toBeGreaterThan(0);
  await expect(ws).toBeVisible();
  const plot = ws.getByTestId('plots-profile-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(ws.getByTestId('plots-profile-chart')).toHaveCount(1);
  await expect(step).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Uncalled reads: Plots leave them out by default and ask for them only with All reads, including uncalled', async ({ server, page }) => {
  test.setTimeout(180_000);
  await openPlots(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');
  const urls: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/reads/compact') || r.url().includes('/api/cluster/vplot')) urls.push(r.url()); });
  await ws.getByTestId('plots-type-metaprofile').click();
  await expect(ws.getByTestId('plots-profile-plot')).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  // Default (Min footprints a threshold): the server's rule hides uncalled reads; nothing asks for them.
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.some(u => u.includes('hide_uncalled=false'))).toBe(false);
  // All reads, including uncalled (-1): every Plots request asks for them; the size plots too.
  urls.length = 0;
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ minFootprints: -1 }));
  await ws.getByTestId('plots-type-size-enrichment').click();
  await expect(ws.getByTestId('plots-size-plot')).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await ws.getByTestId('plots-type-metaprofile').click();
  await expect(ws.getByTestId('plots-profile-plot')).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  expect(urls.filter(u => u.includes('/api/cluster/vplot')).every(u => u.includes('hide_uncalled=false'))).toBe(true);
  expect(urls.some(u => u.includes('/api/reads/compact') && u.includes('hide_uncalled=false'))).toBe(true);
});
