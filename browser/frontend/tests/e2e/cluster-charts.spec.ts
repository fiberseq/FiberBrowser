/**
 * Cluster charts (fb-n5-charts): with one dataset loaded Composition shows the
 * bar chart (and Pie); the V-plot switches between Midpoint and Full
 * footprint; picking a cluster by its name filters Profiles, and the pick is
 * the app's cluster selection.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';
import type { ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

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

test('V-plot toggles between Midpoint and Full footprint', async ({ server, page }) => {
  test.setTimeout(180_000);
  await openAt(page, server);
  await cluster(page);
  const first = page.waitForResponse(res => res.url().includes('/api/cluster/vplot'), { timeout: 90_000 });
  const panel = await openChart(page, 'vplot');
  expect(JSON.parse((await first).request().postData() || '{}').mode).toBe('midpoint');
  const vplot = panel.getByTestId('cluster-vplot');
  await expect(vplot).toHaveAttribute('data-vplot-mode', 'midpoint');
  await expect(vplot.locator('canvas').first()).toBeVisible({ timeout: 60_000 });

  const span = page.waitForResponse(res => res.url().includes('/api/cluster/vplot')
    && JSON.parse(res.request().postData() || '{}').mode === 'span', { timeout: 90_000 });
  await vplot.getByRole('button', { name: 'Full footprint', exact: true }).click();
  const answer = await span;
  expect(JSON.parse(answer.request().postData() || '{}').row_normalize).toBe(false);
  const body = await answer.json();
  const matrices = Object.values(body.data as Record<string, Record<string, { mode: string; matrix: number[][] }>>)
    .flatMap(byCluster => Object.values(byCluster));
  expect(matrices.length).toBeGreaterThan(0);
  expect(matrices.every(m => m.mode === 'span')).toBe(true);
  await expect(vplot).toHaveAttribute('data-vplot-mode', 'span');
  await expect(panel.getByTestId('vplot-caption')).toContainText('Full footprint');
  await expect(vplot.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
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
