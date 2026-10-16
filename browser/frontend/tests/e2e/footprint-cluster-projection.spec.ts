/**
 * Clusters › Charts › Projection after "Cluster reads by N footprints"
 * (fb-n1-bugs 1). Footprint classes have half-base edges (their span is the
 * median of their calls' edges); the membership clustering stored them as its
 * peak regions and the map failed with "API error 422 … peak_regions.0.end:
 * Input should be a valid integer". The saved footprints here are placed on
 * half bases, as found classes are, without running Find footprint classes.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

const VIEW = { chrom: 'chr19', start: 47_515_640, end: 47_517_640 };

const getState = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); return new Function('s', `return (${f})(s)`)(s); }, fn.toString()) as Promise<T>;

test('cluster reads by saved footprints on half bases, then open Projection', async ({ server, page }) => {
  test.setTimeout(180_000);
  const apiErrors: string[] = [];
  page.on('response', res => { if (res.url().includes('/api/') && res.status() === 422) apiErrors.push(res.url()); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const reads = page.waitForResponse(res => res.url().includes('/api/reads/compact'), { timeout: 45_000 }).catch(() => null);
  await page.getByTestId('location-search-input').fill(`${VIEW.chrom}:${VIEW.start}-${VIEW.end}`);
  await page.getByTestId('location-search-submit').click();
  await reads;
  await page.waitForTimeout(1500);

  // Two saved footprints whose edges fall on half bases, as a found class's do.
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    const base = { sourceIndex: -1, referenceChrom: 'chr19', minFpCoverage: 0.5, minTargetCoverage: 0.5, overlapFraction: 0, enabled: true };
    st.addFootprintGroup({ ...base, name: 'Half-base TF', color: '#7c3aed', sizeMin: 10, sizeMax: 80,
      referenceAbsStart: 47515967.5, referenceAbsEnd: 47515997.5 });
    st.addFootprintGroup({ ...base, name: 'Half-base nucleosome', color: '#0e7490', sizeMin: 90, sizeMax: null,
      referenceAbsStart: 47516200.5, referenceAbsEnd: 47516347.5 });
  });

  await panelButton(page, 'footprint-analysis').click();
  await page.getByRole('button', { name: /^Co-occupancy/ }).click();
  const cluster = page.getByTestId('coocc-cluster-button');
  await expect(cluster).toHaveText(/Cluster reads by 2 footprints/, { timeout: 60_000 });
  await expect(cluster).toBeEnabled({ timeout: 60_000 });
  await cluster.click();
  await expect(page.getByTestId('membership-cluster-legend')).toBeVisible({ timeout: 30_000 });
  // The clustering's peak regions are whole bases covering each footprint.
  expect(await getState(page, s => s.clusterPeakRegions.map((r: any) => [r.start, r.end]))).toEqual([
    [47_515_967, 47_515_998],
    [47_516_200, 47_516_348],
  ]);
  await page.waitForTimeout(1200); // the clustering's history step settles

  // Clusters › Charts › Projection draws the map.
  const projection = page.waitForResponse(res => res.url().includes('/api/cluster_projection'), { timeout: 90_000 });
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.locator('[data-analysis-tab="projection"]').first().click({ force: true });
  const response = await projection;
  expect(response.status(), await response.text()).toBe(200);
  const sent = JSON.parse(response.request().postData() || '{}');
  expect(sent.peak_regions.every((r: any) => Number.isInteger(r.start) && Number.isInteger(r.end))).toBe(true);
  await expect(panel.getByTestId('projection-summary')).toContainText('t-SNE', { timeout: 90_000 });
  await expect(panel.getByText(/API error/)).toHaveCount(0);
  expect(apiErrors).toEqual([]);
});
