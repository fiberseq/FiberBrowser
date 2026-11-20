/**
 * Metaprofile presence profiles are shares of the reads covering each bin, so they stay within [0, 1]: a read counts
 * at most once per bin per channel, and its coverage spans every interval it adds (utils/metaprofileBins). Before the
 * 3.0.8 fix a cluster's Nuc profile reached 1.33 on this locus, because two calls of one read meeting inside a bin
 * counted the read twice there.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { test, expect } from './fixtures/server';
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

/** Max/min over every presence profile (clusters and datasets); mark channels (per read per bin) aside. */
const extremes = (page: Page) => page.evaluate(() => {
  const marks = ['m6a', 'm5c', 'deam', 'mod'];
  const s = (window as any).__FIBERBROWSER_STORE__.getState();
  let max = 0, min = 0, n = 0, clusterN = 0;
  const scan = (key: string, arr: unknown, cluster = false) => {
    if (marks.includes(key) || !Array.isArray(arr)) return;
    for (const v of arr) if (Number.isFinite(v)) { n++; if (cluster) clusterN++; if (v > max) max = v; if (v < min) min = v; }
  };
  for (const byCluster of Object.values((s.clusterProfiles ?? {}) as Record<string, Record<string, Record<string, number[]>>>)) {
    for (const byKey of Object.values(byCluster ?? {})) for (const [k, arr] of Object.entries(byKey ?? {})) scan(k, arr, true);
  }
  for (const dp of Object.values((s.datasetProfiles ?? {}) as Record<string, any>)) {
    scan('fire', dp?.fire);
    for (const [k, arr] of Object.entries(dp?.layers ?? {})) scan(k, arr);
    for (const [k, arr] of Object.entries(dp?.rules ?? {})) scan(k, arr);
  }
  return { max, min, n, clusterN };
});

test('cluster and dataset metaprofiles on the demo BAM stay within [0, 1]', async ({ server, page }) => {
  test.setTimeout(200_000);
  await openAt(page, server);
  await expect.poll(async () => (await extremes(page)).n, { timeout: 30_000 }).toBeGreaterThan(0);
  const plain = await extremes(page);
  expect(plain.max).toBeLessThanOrEqual(1 + 1e-6);
  expect(plain.min).toBeGreaterThanOrEqual(0);

  await expect.poll(() => getState(page, s => s.getAllPeaks().length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.replacePeakSelection([0, 1]);
    st.setClusterMethod('kmeans');
  });
  const done = page.waitForResponse(res => res.url().includes('/api/cluster_all'), { timeout: 60_000 });
  await page.getByTestId('cluster-run-button').click();
  await done;
  await expect.poll(async () => (await extremes(page)).clusterN, { timeout: 45_000 }).toBeGreaterThan(0);
  const clustered = await extremes(page);
  expect(clustered.max).toBeLessThanOrEqual(1 + 1e-6);
  expect(clustered.min).toBeGreaterThanOrEqual(0);
});
