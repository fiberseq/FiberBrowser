/**
 * Cluster charts (fb-n5-charts): with one dataset loaded Composition shows the
 * bar chart (and Pie); "Footprint sizes → Plots" opens Plots on Size enrichment per
 * cluster (pinned to the clustered locus), which switches to the V-plot; there is no
 * Footprint sizes tab; picking a cluster by its name filters Profiles, and the pick is
 * the app's cluster selection.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';
import type { ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const SHOTS = process.env.FIBERBROWSER_E2E_SHOTS;

async function openAt(page: Page, server: ServerFixture) {
  await page.setViewportSize({ width: 1600, height: 1000 });
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

const getState = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); return new Function('s', `return (${f})(s)`)(s); }, fn.toString()) as Promise<T>;

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

async function openChart(page: Page, tab: string) {
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.getByRole('button', { name: 'Charts', exact: true }).click();
  await panel.getByRole('group', { name: 'Chart', exact: true }).locator(`[data-analysis-tab="${tab}"]`).click();
  return panel;
}

test('Profiles deep-link target stays separate from the Overview map target', async ({ server, page }) => {
  test.setTimeout(180_000);
  await openAt(page, server);
  await cluster(page);
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await expect(panel.getByTestId('cluster-detail-run-note')).toBeVisible();
  // Exercise browser hit testing: adjacent hidden targets must not cover each other.
  await panel.locator('[data-analysis-tab="profiles"]').click();
  await expect(panel.getByTestId('cluster-profile-chart').first()).toBeVisible();
  await panel.locator('[data-analysis-tab="projection"]').click();
  await expect(panel.getByTestId('projection-map')).toBeVisible();
});

test('one dataset: Composition shows the bar chart, and Pie; Line needs two datasets', async ({ server, page }) => {
  test.setTimeout(180_000);
  await openAt(page, server);
  expect(await getState(page, s => s.datasets.length)).toBe(1);
  await cluster(page);
  const panel = await openChart(page, 'composition');
  const composition = panel.getByTestId('cluster-composition');
  await expect(composition).toHaveAttribute('data-composition-mode', 'bar');
  await expect(composition.getByTestId('composition-bar').locator('canvas')).toBeVisible();
  await expect(composition.getByRole('button', { name: 'Line', exact: true })).toBeDisabled();
  await composition.getByRole('button', { name: 'Pie', exact: true }).click();
  await expect(composition).toHaveAttribute('data-composition-mode', 'pie');
  await expect(composition.getByTestId('composition-pie').locator('canvas').first()).toBeVisible();
});

test('Footprint sizes → Plots: Size enrichment per cluster, V-plot in one click; no Footprint sizes tab', async ({ server, page }) => {
  test.setTimeout(180_000);
  await openAt(page, server);
  await cluster(page);
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.getByRole('button', { name: 'Charts', exact: true }).click();
  await expect(panel.getByRole('group', { name: 'Chart', exact: true }).locator('[data-analysis-tab="vplot"]')).toHaveCount(0);
  await expect(panel.getByTestId('cluster-detail-plot-clusters')).toHaveCount(0);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/cluster-charts-tabs.png` });

  const first = page.waitForResponse(res => res.url().includes('/api/cluster/vplot'), { timeout: 90_000 });
  await panel.getByTestId('cluster-detail-sizes-in-plots').click();
  const req = JSON.parse((await first).request().postData() || '{}');
  expect(req).toMatchObject({ mode: 'span', normalization: 'row', group_by: 'cluster', raw_values: true });
  const ws = page.getByTestId('plots-workspace');
  await expect(ws.getByTestId('plots-type-size-enrichment')).toHaveAttribute('aria-pressed', 'true');
  await expect(ws.getByTestId('plots-group-cluster')).toHaveAttribute('aria-pressed', 'true');
  await expect(ws.getByTestId('plots-cluster-pin-note')).toBeVisible();
  const plot = ws.getByTestId('plots-size-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  expect(await plot.getByTestId('plots-size-panel').count()).toBeGreaterThan(1);

  const mid = page.waitForResponse(res => res.url().includes('/api/cluster/vplot')
    && JSON.parse(res.request().postData() || '{}').mode === 'midpoint', { timeout: 90_000 });
  await ws.getByTestId('plots-type-vplot').click();
  const answer = await mid;
  expect(JSON.parse(answer.request().postData() || '{}')).toMatchObject({ normalization: 'raw', group_by: 'cluster' });
  const body = await answer.json();
  const matrices = Object.values(body.data as Record<string, Record<string, { mode: string; matrix: number[][] }>>)
    .flatMap(byCluster => Object.values(byCluster));
  expect(matrices.length).toBeGreaterThan(0);
  expect(matrices.every(m => m.mode === 'midpoint')).toBe(true);
  await expect(ws.getByTestId('plots-caption')).toContainText('Midpoint');
});

test('picking a cluster by its name filters Profiles and selects it in the app', async ({ server, page }) => {
  test.setTimeout(180_000);
  await openAt(page, server);
  await cluster(page);
  const panel = await openChart(page, 'profiles');
  const chart = panel.getByTestId('cluster-profile-chart').first();
  await expect(chart).toBeVisible({ timeout: 30_000 });
  const all = (await chart.getAttribute('data-series'))!.split(',');
  expect(all.length).toBeGreaterThan(1);
  const target = all[1];
  const chip = panel.getByTestId('profiles-picks').getByRole('button', { name: target, exact: true });
  const clusterId = Number((await chip.getAttribute('data-testid'))!.replace('profiles-picks-chip-', ''));
  await chip.click();
  await expect(chart).toHaveAttribute('data-series', target);
  const picked = await getState(page, s => Object.values(s.selectedClusters).map((set: any) => [...set]));
  expect(picked.every(ids => ids.length === 1 && ids[0] === clusterId)).toBe(true);
  // All shows every cluster again.
  await panel.getByTestId('profiles-picks-all').click();
  await expect(chart).toHaveAttribute('data-series', all.join(','));
});

test('metaprofile cards draw the full legend: a layer one cluster lacks keeps every plot the same width', async ({ server, page }) => {
  test.setTimeout(240_000);
  await openAt(page, server);
  // A second channel on the default metaprofile (a secondary layer the demo BAM carries), so the cards have a legend.
  const candidates = await getState(page, s => {
    const track = s.compositeTracks.find((c: any) => c.id === '__default_metaprofile__');
    return (track?.sources ?? []).filter((x: any) => !x.visible).map((x: any) => x.ref.ruleId);
  });
  const layer = ['fire', 'm6a', 'deam'].find(k => candidates.includes(k));
  expect(layer, `a secondary layer among ${candidates.join(',')}`).toBeTruthy();
  await page.getByTestId(`layer-checkbox-${layer}`).setChecked(true);
  await cluster(page);
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.locator('[data-analysis-tab="overview"]').click();
  const cards = panel.getByTestId('cluster-overview-profile');
  await expect.poll(() => panel.locator('canvas').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

  // Fixture: one cluster loses the layer (as when none of its reads carry it).
  const dropped = await page.evaluate(key => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const profiles = store.getState().clusterProfiles as Record<string, Record<number, Record<string, number[]>>>;
    const next: typeof profiles = {};
    let target: number | null = null;
    for (const [sk, byCluster] of Object.entries(profiles)) {
      const ids = Object.keys(byCluster).map(Number).filter(c => (byCluster[c]?.[key]?.length ?? 0) > 0).sort((a, b) => a - b);
      if (target == null) target = ids[0] ?? null;
      next[sk] = Object.fromEntries(Object.entries(byCluster).map(([c, ch]) => {
        if (Number(c) !== target) return [c, ch];
        const rest = { ...ch }; delete rest[key]; return [c, rest];
      }));
    }
    store.setState({ clusterProfiles: next });
    return target;
  }, layer!);
  expect(dropped).not.toBeNull();
  await page.waitForTimeout(800);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/overview_cards.png` });
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const lacking = panel.locator(`[data-testid="cluster-overview-profile"][data-cluster="${dropped}"]`);
  await expect(lacking.getByTestId('plot-legend-missing')).toHaveCount(1, { timeout: 15_000 });
  await expect(lacking.getByTestId('plot-legend-missing')).toHaveAttribute('title', /^no .+ in this cluster$/);

  // Every card: the same legend (labels, order) and the plot at the same left edge and width.
  const geometry = async (loc: ReturnType<Page['locator']>) => loc.evaluateAll(els => els.map(el => {
    const chart = el.querySelector('[data-plot-left]') as HTMLElement | null;
    return chart ? { legend: chart.dataset.legend, left: chart.dataset.plotLeft, width: chart.dataset.plotWidth } : null;
  }));
  const overview = await geometry(cards);
  expect(overview.every(g => g != null)).toBe(true);
  expect(new Set(overview.map(g => g!.legend)).size).toBe(1);
  expect(overview[0]!.legend!.split('|').length).toBeGreaterThanOrEqual(2);
  expect(new Set(overview.map(g => `${g!.left}:${g!.width}`)).size).toBe(1);
  // The drawn canvases line up on screen too.
  const boxes = await cards.evaluateAll(els => els.map(el => { const r = el.querySelector('canvas')!.getBoundingClientRect(); return `${Math.round(r.left)}:${Math.round(r.width)}`; }));
  expect(new Set(boxes).size).toBe(1);

  // Profiles: one chart per channel; the layer's chart lacks a cluster but keeps every cluster in its legend.
  await panel.locator('[data-analysis-tab="profiles"]').click();
  const charts = panel.getByTestId('cluster-profile-chart');
  await expect.poll(() => charts.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const layerChart = panel.locator(`[data-testid="cluster-profile-chart"][data-layer="${layer}"]`);
  await expect(layerChart.getByTestId('plot-legend-missing')).toHaveCount(1);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/profiles_tab.png` });
  const profiles = await geometry(charts);
  expect(profiles.every(g => g != null)).toBe(true);
  expect(new Set(profiles.map(g => g!.legend)).size).toBe(1);
  expect(new Set(profiles.map(g => `${g!.left}:${g!.width}`)).size).toBe(1);
});
