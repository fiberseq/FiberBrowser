/**
 * The default metaprofile follows the active read layers, and the cluster
 * panel's Default profile channel follows the default metaprofile.
 *
 * Turn a secondary layer on in the Layers row: the default metaprofile shows
 * it at once (its cart settings say "Follow active layers"), and after
 * clustering the Profiles tab draws it under Default. A hand edit of a source
 * switches the track to manual, and the checkbox brings following back.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';
import type { ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const DEFAULT_ID = '__default_metaprofile__';

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

const shownSources = (page: Page) => getState(page, s => {
  const track = s.compositeTracks.find((c: any) => c.id === '__default_metaprofile__');
  return track ? track.sources.filter((x: any) => x.visible).map((x: any) => x.ref.ruleId).sort() : null;
});

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

test('the default metaprofile and the cluster Default profile follow the layers switched on', async ({ server, page }) => {
  test.setTimeout(180_000);
  await openAt(page, server);

  // A secondary layer the demo BAM carries that starts off.
  const candidates = await getState(page, s => {
    const track = s.compositeTracks.find((c: any) => c.id === '__default_metaprofile__');
    return (track?.sources ?? []).filter((x: any) => !x.visible).map((x: any) => x.ref.ruleId);
  });
  const layer = ['fire', 'm6a', 'deam'].find(k => candidates.includes(k));
  expect(layer, `a secondary layer among ${candidates.join(',')}`).toBeTruthy();
  const before = await shownSources(page);
  expect(before).not.toContain(layer);

  // Turn it on in the Layers row: the default metaprofile shows it.
  const checkbox = page.getByTestId(`layer-checkbox-${layer}`);
  await expect(checkbox).toBeVisible({ timeout: 15_000 });
  await checkbox.setChecked(true);
  await expect.poll(() => shownSources(page)).toContain(layer!);

  // The Tracks cart shows it following.
  await panelButton(page, 'track-browser').click();
  const cart = page.locator('[data-panel-content-type="track-browser"]');
  // The seeded track's row (not the "+ Metaprofile" add button).
  await cart.getByRole('button', { name: /^\s*Metaprofile\s*metaprofile\b/ }).first().click();
  const follow = cart.getByTestId('default-metaprofile-follow-layers');
  await expect(follow).toBeChecked();

  // Cluster: the Profiles tab draws the layer under Default.
  await cluster(page);
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.locator('[data-analysis-tab="profiles"]').click();
  await expect(panel.getByTestId('cluster-profile-channel-default')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator(`[data-testid="cluster-profile-chart"][data-layer="${layer}"]`)).toBeVisible({ timeout: 30_000 });

  // Turning the layer off drops it from both.
  await page.getByTestId(`layer-checkbox-${layer}`).setChecked(false);
  await expect.poll(() => shownSources(page)).not.toContain(layer!);
  await expect(panel.locator(`[data-testid="cluster-profile-chart"][data-layer="${layer}"]`)).toHaveCount(0);

  // A hand edit switches to manual; the checkbox brings following back.
  await page.evaluate(([id, key]) => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    const src = st.compositeTracks.find((c: any) => c.id === id).sources.find((x: any) => x.ref.ruleId === key);
    st.updateSource(id, src.id, { visible: true });
  }, [DEFAULT_ID, layer] as const);
  await expect(follow).not.toBeChecked();
  await expect.poll(() => shownSources(page)).toContain(layer!);
  await follow.setChecked(true);
  await expect.poll(() => shownSources(page)).not.toContain(layer!);
});
