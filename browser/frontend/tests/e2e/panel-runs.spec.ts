/**
 * Clustering and Sort on a panel that navigates on its own (fb-n4-integ,
 * Codex integ 2 and 3), on the demo BAM in "Each panel navigates":
 *
 * - a clustering still running when its panel jumps to another locus is not
 *   applied there (the stale main locus didn't change, so it used to be);
 * - Sort sorts the panel at its own locus (it used to skip it, yet still add
 *   a "Sort by" undo step), and a sort whose panel moved meanwhile changes
 *   nothing and adds no undo step.
 *
 * Since runs are cancellable (d8f4abd6) a move stops the run: its request is
 * aborted (no response comes back) and the progress line says the locus
 * changed (3.0.0 audit MED-1).
 */
import { test, expect } from './fixtures/server';
import type { Page, Request, Route } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

const OWN = { chrom: 'chr19', start: 47_514_500, end: 47_517_500 };
const AWAY = 'chr19:47600000-47604000';

const panelLocus = (page: Page) => store(page, s => {
  const p = s.panels.find((q: any) => q.contentType === 'dataset');
  return p?.viewportOverride ? `${p.viewportOverride.chrom}:${p.viewportOverride.start}-${p.viewportOverride.end}` : 'main';
});
const assigned = (page: Page) => store(page, s => Object.values(s.clusterAssignments).reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0));
const sorted = (page: Page) => store(page, s => Object.values(s.readSortOrder).reduce((n: number, o: any) => n + (o?.length ?? 0), 0));
const undoTitle = (page: Page) => page.getByTestId('quick-undo-button').getAttribute('title');

async function movePanel(page: Page, locus: string) {
  const bar = page.getByTestId('panel-site-bar').first();
  await bar.getByTestId('panel-location-input').fill(locus);
  await bar.getByTestId('panel-location-submit').click();
  await expect.poll(() => panelLocus(page), { timeout: 20_000 }).toBe(locus);
}

/**
 * Hold the next request to `path` until the returned release() is called. `answered` settles once the page has
 * the late answer (or the request was aborted) and has had a frame to act on it: what a "nothing changed" check
 * after release() waits for.
 */
async function hold(page: Page, path: string) {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let seen!: () => void;
  const sent = new Promise<void>(r => { seen = r; });
  let delivered!: () => void;
  const continued = new Promise<void>(r => { delivered = r; });
  // The page may abort the held request meanwhile (a cancelled run): continuing it then fails, which is expected.
  await page.route(`**${path}*`, async (route: Route) => {
    const request = route.request();
    // Listen from the start: the page may abort the request (a stopped run) while it is held.
    const ended = new Promise<void>(resolve => {
      const onEnd = (r: Request) => {
        if (r !== request) return;
        page.off('requestfinished', onEnd); page.off('requestfailed', onEnd); resolve();
      };
      page.on('requestfinished', onEnd); page.on('requestfailed', onEnd);
    });
    seen(); await gate;
    // Continuing an aborted request fails; either way, wait (bounded) until the page has the answer or the abort.
    await route.continue().catch(() => {});
    await Promise.race([ended, new Promise(r => setTimeout(r, 15_000))]);
    delivered();
  }, { times: 1 });
  const answered = async () => {
    await continued;
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))));
  };
  return { sent, release, answered };
}

async function selectPanelPeaks(page: Page) {
  await expect.poll(() => store(page, s => s.getAllPeaks().filter((p: any) => p.start >= 47_514_500 && p.end <= 47_517_500).length),
    { timeout: 45_000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.setError(null);
    const peaks = st.getAllPeaks().filter((p: any) => p.start >= 47_514_500 && p.end <= 47_517_500).slice(0, 2);
    st.replacePeakSelection(peaks.map((p: any) => p.index), 'accessibility');
    st.setClusterMethod('kmeans');
  });
}

async function openPerPanel(page: Page, baseUrl: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('location-search-input').fill('chr19:47514000-47518000');
  await page.getByTestId('location-search-submit').click();
  await expect.poll(() => store(page, s => s.start), { timeout: 20_000 }).toBe(47_514_000);
  // The main view's undo step is pushed once it settles (a 500 ms timer): wait for that step, not a fixed time.
  await expect.poll(() => store(page, s => s._historyStack?.[s._historyPointer]?.label ?? ''), { timeout: 20_000 })
    .toMatch(/^Navigate to chr19:47,514,000-47,518,000/);
  await page.getByTestId('nav-mode-perPanel').click();
  await movePanel(page, `${OWN.chrom}:${OWN.start}-${OWN.end}`);
  await page.waitForLoadState('networkidle');
}

test('Per panel: a clustering answered after its panel moved is not applied there', async ({ page, server }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPerPanel(page, server.baseUrl);

  // --- A clustering answered after its panel jumped elsewhere is dropped ---------------
  await selectPanelPeaks(page);
  const held = await hold(page, '/api/cluster_all');
  await page.getByTestId('cluster-run-button').click();
  await held.sent;
  await movePanel(page, AWAY);
  // The main locus never moved.
  expect(await store(page, s => [s.chrom, s.start, s.end])).toEqual(['chr19', 47_514_000, 47_518_000]);
  // The move stops the run: the progress line under the toolbar says why (not the global error banner).
  await expect(page.getByTestId('analysis-progress')).toContainText('Cluster: Stopped: the locus changed', { timeout: 10_000 });
  held.release();
  await held.answered();
  expect(await assigned(page)).toBe(0);

  // --- Back at its locus it clusters ---------------------------------------------------------
  await movePanel(page, `${OWN.chrom}:${OWN.start}-${OWN.end}`);
  await selectPanelPeaks(page);
  const clustered = page.waitForResponse(r => r.url().includes('/api/cluster_all'), { timeout: 90_000 });
  await page.getByTestId('cluster-run-button').click();
  await clustered;
  await expect.poll(() => assigned(page), { timeout: 45_000 }).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('Per panel: Sort sorts a panel at its own locus; a sort answered after it moved is no undo step', async ({ page, server }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPerPanel(page, server.baseUrl);

  const sortDone = page.waitForResponse(r => r.url().includes('/api/sort_reads') && r.ok(), { timeout: 45_000 });
  await page.getByTestId('sort-run-button').click();
  const sortRequest = (await sortDone).request();
  const q = new URL(sortRequest.url()).searchParams;
  expect([q.get('chrom'), q.get('start'), q.get('end')]).toEqual([OWN.chrom, String(OWN.start), String(OWN.end)]);
  await expect.poll(() => sorted(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => undoTitle(page), { timeout: 10_000 }).toMatch(/^Undo: Sort by /);

  // --- A sort answered after its panel moved changes nothing, and is no undo step ----------
  const heldSort = await hold(page, '/api/sort_reads');
  await page.getByTestId('sort-run-button').click();
  await heldSort.sent;
  await movePanel(page, AWAY);
  await expect.poll(() => undoTitle(page), { timeout: 10_000 }).toMatch(/^Undo: (Navigate panel|Panel) to chr19:47,600,000/);
  await expect(page.getByTestId('analysis-progress')).toContainText('Sort: Stopped: the locus changed', { timeout: 10_000 });
  heldSort.release();
  await heldSort.answered();
  expect(await undoTitle(page)).toMatch(/^Undo: (Navigate panel|Panel) to chr19:47,600,000/);
  expect(await sorted(page)).toBe(0);

  expect(errors).toEqual([]);
});

test('Per panel: a view that moved while another view was being sorted stops the sort; no view gets an order', async ({ page, server }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openPerPanel(page, server.baseUrl);
  // A copy of the panel at another locus: Sort sends one request per view.
  const COPY = { chrom: 'chr19', start: 47_515_000, end: 47_518_000 };
  const copyId = await page.evaluate(c => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    const source = st.panels.find((p: any) => p.contentType === 'dataset');
    const id = st.openPanelAtSite(source.id);
    (window as any).__FIBERBROWSER_STORE__.getState().navigatePanel(id, c.chrom, c.start, c.end);
    return id;
  }, COPY);
  await page.waitForLoadState('networkidle');

  // The first view's request goes through; the second's is held.
  const urls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let secondSeen!: () => void;
  const second = new Promise<void>(r => { secondSeen = r; });
  await page.route('**/api/sort_reads*', async route => {
    urls.push(route.request().url());
    if (urls.length === 2) { secondSeen(); await gate; }
    await route.continue().catch(() => {});  // aborted by the stopped sort
  });
  await page.getByTestId('sort-run-button').click();
  await second;
  // The panel sorted first moves away while the second view is being sorted.
  const first = new URL(urls[0]).searchParams;
  const firstPanel = await store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset')
    .map((p: any) => ({ id: p.id, key: p.stateKey ?? p.datasetId, v: p.viewportOverride })));
  const moved = firstPanel.find(p => p.v && String(p.v.start) === first.get('start'))!;
  const stayed = firstPanel.find(p => p.id !== moved.id)!;
  expect([moved.id, stayed.id].sort()).toEqual([copyId, firstPanel.find(p => p.id !== copyId)!.id].sort());
  await page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().navigatePanel(id, 'chr19', 47_600_000, 47_604_000), moved.id);
  // The sort is one run over both views: the move stops it, and the order computed for the moved view (or the
  // other one) is never applied.
  await expect(page.getByTestId('analysis-progress')).toContainText('Sort: Stopped: the locus changed', { timeout: 10_000 });
  release();
  await page.waitForTimeout(1_500);
  expect(await store(page, s => Object.entries(s.readSortOrder).filter(([, o]: any) => (o?.length ?? 0) > 0).map(([k]) => k))).toEqual([]);
  expect(stayed.key).toBeTruthy();
  await page.unroute('**/api/sort_reads*');
  expect(errors).toEqual([]);
});
