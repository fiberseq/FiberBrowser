/**
 * Y scaling of the cluster metaprofiles: the Overview cards start on their own y (each showing its max) and line up
 * on one range with Shared y; the Profiles tab switches to % enrichment over the region baseline and log2, its axis
 * labels and maxima following. The choice is a cluster view setting (saved with the session).
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Locator, Page } from '@playwright/test';
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

const maxima = async (charts: Locator) => (await charts.evaluateAll(els => els.map(e => e.getAttribute('data-y-max') ?? '')));

test('cluster metaprofiles: own y, shared y, % enrichment and log2, labelled', async ({ server, page }) => {
  test.setTimeout(200_000);
  await openAt(page, server);
  await cluster(page);
  // Presence profiles are shares of covering reads: within [0, 1] for every cluster and the dataset (mark channels,
  // per read per bin, aside). Before the bin fix a cluster's Nuc profile reached 1.33 here.
  const MARKS = ['m6a', 'm5c', 'deam', 'mod'];
  await expect.poll(() => getState(page, s => Object.keys(s.clusterProfiles).length), { timeout: 30_000 }).toBeGreaterThan(0);
  const extremes = await page.evaluate(marks => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    let max = 0, min = 0, n = 0;
    const scan = (key: string, arr: number[]) => {
      if (marks.includes(key) || !Array.isArray(arr)) return;
      for (const v of arr) if (Number.isFinite(v)) { n++; if (v > max) max = v; if (v < min) min = v; }
    };
    for (const byCluster of Object.values(s.clusterProfiles as Record<string, Record<string, Record<string, number[]>>>)) {
      for (const byKey of Object.values(byCluster)) for (const [k, arr] of Object.entries(byKey)) scan(k, arr);
    }
    for (const dp of Object.values(s.datasetProfiles as Record<string, any>)) {
      scan('fire', dp.fire);
      for (const [k, arr] of Object.entries(dp.layers ?? {})) scan(k, arr as number[]);
      for (const [k, arr] of Object.entries(dp.rules ?? {})) scan(k, arr as number[]);
    }
    return { max, min, n };
  }, MARKS);
  expect(extremes.n).toBeGreaterThan(0);
  expect(extremes.max).toBeLessThanOrEqual(1 + 1e-6);
  expect(extremes.min).toBeGreaterThanOrEqual(0);
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.getByRole('button', { name: 'Overview', exact: true }).click();
  await panel.getByTestId('cluster-overview-mode').getByRole('button', { name: 'Profiles', exact: true }).click();

  // Overview: own y per card by default (today's look), each card with its own max.
  const control = panel.getByTestId('cluster-overview-yscale');
  await expect(control).toHaveAttribute('data-y-mode', 'perPlot');
  await expect(control.getByTestId('cluster-overview-yscale-summary')).toHaveText('Own y per plot · fraction');
  const cards = panel.locator('[data-copilot-anchor^="cluster-row-"] [data-y-max]');
  await expect.poll(() => cards.count(), { timeout: 30_000 }).toBeGreaterThan(1);
  const own = await maxima(cards);
  expect(await cards.evaluateAll(els => els.every(e => e.getAttribute('data-y-fixed') === 'false'))).toBe(true);
  if (SHOTS) await page.waitForTimeout(400);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/overview_own_y.png` });

  // Shared y: one range on every card, between the smallest and largest own maxima.
  await control.getByRole('button', { name: 'Shared y', exact: true }).click();
  await expect(control).toHaveAttribute('data-y-mode', 'shared');
  await expect(control.getByTestId('cluster-overview-yscale-summary')).toContainText('Shared y');
  await expect.poll(async () => new Set(await maxima(cards)).size).toBe(1);
  expect(await cards.evaluateAll(els => els.every(e => e.getAttribute('data-y-fixed') === 'true'))).toBe(true);
  const shared = Number((await maxima(cards))[0]);
  const ownNums = own.map(Number);
  expect(shared).toBeGreaterThanOrEqual(Math.min(...ownNums));
  expect(shared).toBeLessThanOrEqual(Math.max(...ownNums) + 1e-9);
  if (new Set(own).size > 1) expect(own.some(v => Number(v) !== shared)).toBe(true);
  if (SHOTS) await page.waitForTimeout(400);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/overview_shared_y.png` });
  expect(await getState(page, s => s.clusterViewSettings.yScale.mode)).toBe('shared');

  // Profiles tab: raw fraction labelled by the layer; % enrichment relabels it and moves the maxima.
  await panel.getByRole('button', { name: 'Charts', exact: true }).click();
  await panel.getByRole('group', { name: 'Chart', exact: true }).locator('[data-analysis-tab="profiles"]').click();
  const pcontrol = panel.getByTestId('cluster-profiles-yscale');
  await expect(pcontrol).toHaveAttribute('data-y-mode', 'shared');
  await pcontrol.getByRole('button', { name: 'Own y', exact: true }).click();
  const charts = panel.locator('[data-testid="cluster-profile-chart"] [data-y-label]');
  await expect(charts.first()).toBeVisible({ timeout: 30_000 });
  const rawLabels = await charts.evaluateAll(els => els.map(e => e.getAttribute('data-y-label')));
  const rawMax = await maxima(charts);
  expect(rawLabels.every(l => l && !l.includes('baseline'))).toBe(true);
  await expect(pcontrol).toHaveAttribute('data-y-mode', 'perPlot');
  expect(await charts.evaluateAll(els => els.every(e => e.getAttribute('data-y-fixed') === 'false'))).toBe(true);
  if (SHOTS) await page.waitForTimeout(400);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/profiles_raw.png` });

  await pcontrol.getByRole('button', { name: '% enrichment', exact: true }).click();
  await expect(pcontrol).toHaveAttribute('data-y-value', 'enrichment');
  await expect(pcontrol.getByTestId('cluster-profiles-yscale-summary')).toHaveText('Own y per plot · % of region baseline');
  await expect.poll(async () => (await charts.evaluateAll(els => els.map(e => e.getAttribute('data-y-label')))).every(l => l === '% of region baseline')).toBe(true);
  const pctMax = await maxima(charts);
  // 100% is the baseline: every enriched chart's range holds its reference line.
  expect(pctMax.every(v => Number(v) >= 100)).toBe(true);
  expect(pctMax).not.toEqual(rawMax);
  if (SHOTS) await page.waitForTimeout(400);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/profiles_pct_region.png` });

  await pcontrol.getByTestId('cluster-profiles-yscale-options').locator('summary').click();
  await pcontrol.getByTestId('cluster-profiles-yscale-form').selectOption('log2');
  await expect.poll(async () => (await charts.evaluateAll(els => els.map(e => e.getAttribute('data-y-label')))).every(l => l === 'log2 vs region baseline')).toBe(true);
  const log2Max = await maxima(charts);
  expect(log2Max).not.toEqual(pctMax);
  expect(log2Max.every(v => Number(v.replace('−', '-')) < 100)).toBe(true);
  await pcontrol.getByTestId('cluster-profiles-yscale-baseline').selectOption('flank');
  await expect(pcontrol.getByTestId('cluster-profiles-yscale-summary')).toHaveText('Own y per plot · log2 vs own flank mean');
  if (SHOTS) await page.waitForTimeout(400);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/profiles_log2_flank.png` });
  expect(await getState(page, s => s.clusterViewSettings.yScale)).toMatchObject({ mode: 'perPlot', value: 'enrichment', form: 'log2', baseline: 'flank' });
});
