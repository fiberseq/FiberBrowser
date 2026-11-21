/**
 * The meta-locus, end to end (owner: "everything identical to the standard browser, just diff coordinates"): a BED
 * of sites tiled over the shipped demo BAM's region, opened from ⌘K; the build strip; the virtual locus with its
 * reads; the contig's ends (pans stop there); cluster; Keep workspace full; Find more like this on a selection (the
 * honest frequency, as a compact chip that keeps the top bar on one line at 1280 px); Open this site and the normal
 * Back (navigation history) to the same working set; Back to the real locus; a reload restores the meta-locus from the
 * address; save the session and restore it.
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

test.use({ fixtureBam: 'demo' });

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function open(page: Page, baseUrl: string) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
  });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await expect.poll(() => store(page, s => s.datasets.length), { timeout: 30_000 }).toBeGreaterThan(0);
}

/** A BED of sites tiled over the demo region (both strands), written next to the test's output. */
function demoBed(path: string, region: { chrom: string; start: number; end: number }): void {
  const lines: string[] = [];
  for (let i = 0, x = region.start + 600; x < region.end - 600; i++, x += 250) {
    lines.push(`${region.chrom}\t${x}\t${x + 1}\tsite${i}\t0\t${i % 2 ? '-' : '+'}`);
  }
  // One site far from the reads at a random place: a new BED each run, so the pool is built (not served from the
  // server's cache) and the build strip shows.
  const far = 1_000_000 + Math.floor(Math.random() * 1_000_000);
  lines.push(`${region.chrom}\t${region.end + far}\t${region.end + far + 1}\tfar\t0\t+`);
  writeFileSync(path, `${lines.join('\n')}\n`);
}

const readsCanvas = (page: Page) => page.locator('canvas[data-copilot-track="reads"]').first();
const metaReads = (page: Page) => page.waitForResponse(r => r.url().includes('/api/reads/compact') && decodeURIComponent(r.url()).includes('chrom=meta:'), { timeout: 60_000 });

test('open a BED as meta-locus, browse, cluster, refill, find more, open a site, go back, save and restore', async ({ server, page }, info) => {
  test.setTimeout(300_000);
  await open(page, server.baseUrl);
  const region = server.defaultRegion!;
  const bed = info.outputPath('demo_sites.bed');
  demoBed(bed, region);
  const realLocus = await store(page, s => ({ chrom: s.chrom as string, start: s.start as number, end: s.end as number }));

  // Hold the first progress answer back so the build strip is seen (the demo pool builds in a blink).
  let held = false;
  await page.route(/\/api\/meta_locus\/pools\/[^/]+$/, async route => {
    if (!held && route.request().method() === 'GET') {
      held = true;
      await new Promise(r => setTimeout(r, 1500));
    }
    await route.continue();
  });

  // ⌘K → Open BED as meta-locus…
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('command-palette-input').fill('meta-locus');
  await page.locator('[role="option"][data-palette-item="cmd:open-meta-locus"]').click();
  const dialog = page.getByTestId('meta-locus-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('meta-locus-flank')).toHaveValue('10000');
  await page.getByTestId('meta-locus-bed').fill(bed);
  await page.getByTestId('meta-locus-flank').fill('1500');
  await page.getByTestId('meta-locus-count').fill('400');
  const firstReads = metaReads(page);
  await page.getByTestId('meta-locus-open').click();
  await expect(page.getByTestId('meta-locus-progress')).toBeVisible();
  await expect(page.getByTestId('meta-locus-cancel')).toBeVisible();
  // On Open the view is on the meta-locus at once; the panels say the pool builds (no silent wait on the old locus).
  await expect(page.getByTestId('meta-locus-dialog')).toBeHidden();
  expect(await store(page, s => String(s.chrom))).toMatch(/^meta:/);
  await expect(page.getByTestId('meta-reads-pending').first()).toBeVisible();
  const strip = await page.getByTestId('meta-locus-progress').boundingBox();
  expect(strip!.height).toBeGreaterThanOrEqual(28);
  expect(strip!.width).toBeGreaterThan(1000);

  // The virtual locus: its name in the locus box, its reads in the ordinary track.
  await expect.poll(() => store(page, s => s.chrom as string), { timeout: 60_000 }).toMatch(/^meta:/);
  await expect(page.getByTestId('meta-locus-progress')).toHaveCount(0);
  await expect(page.getByTestId('location-search-input')).toHaveValue('demo_sites · TSS ± 1.5 kb');
  expect((await firstReads).ok()).toBe(true);
  await expect(readsCanvas(page)).toBeVisible();
  await expect(page.getByTestId('meta-locus-count')).toContainText(/ of [\d,]+/);
  // Rows that need a real genome position are not drawn (no banner either).
  await expect(page.getByTestId('coverage-map-toggle')).toHaveCount(0);
  const chrom = await store(page, s => s.chrom as string);
  const width = await store(page, s => s.end as number);
  expect(width).toBe(3000);

  // The contig has ends: a view past them is clamped, and pans stop there.
  await page.evaluate(c => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(c, 2500, 4000), chrom);
  await expect.poll(() => store(page, s => [s.start, s.end])).toEqual([1500, 3000]);
  await page.getByTestId('pan-right-button').click();
  await expect.poll(() => store(page, s => s.end as number)).toBe(3000);
  await page.evaluate(c => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(c, -800, 900), chrom);
  await expect.poll(() => store(page, s => [s.start, s.end])).toEqual([0, 1700]);
  await page.evaluate(([c, w]) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(c, 0, w), [chrom, width] as const);
  await expect.poll(() => store(page, s => [s.start, s.end])).toEqual([0, width]);

  // More reads: the next reads of the sampling order.
  const moreReads = metaReads(page);
  await page.getByTestId('meta-locus-more').click();
  expect((await moreReads).ok()).toBe(true);

  // Cluster, exactly as anywhere: two peaks in the window, k-means.
  await page.evaluate((w: number) => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.addCustomPeak(Math.round(w * 0.35), Math.round(w * 0.45));
    st.addCustomPeak(Math.round(w * 0.55), Math.round(w * 0.65));
  }, width);
  await expect.poll(() => store(page, s => s.getAllPeaks().length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.replacePeakSelection(st.getAllPeaks().slice(-2).map((p: { index: number }) => p.index));
    st.setClusterMethod('kmeans');
  });
  const clustered = page.waitForResponse(r => r.url().includes('/api/cluster_all'), { timeout: 60_000 });
  await page.getByTestId('cluster-run-button').click();
  expect((await clustered).ok()).toBe(true);
  await expect.poll(() => store(page, s => Object.values(s.clusterAssignments).reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0)), { timeout: 60_000 }).toBeGreaterThan(0);

  // Keep workspace full: each cluster topped up from the pool; the display is enriched.
  const refill = page.waitForResponse(r => r.url().includes('/refill'), { timeout: 60_000 });
  await page.getByTestId('meta-locus-keep-full-checkbox').check();
  expect((await refill).ok()).toBe(true);
  await expect(page.getByTestId('meta-locus-enriched')).toContainText('enriched');

  // Find more like this on a selection: the honest frequency, as a chip (the top bar stays on one line at 1280 px).
  await page.setViewportSize({ width: 1280, height: 1000 });
  const datasetId = await store(page, s => s.datasets[0].id as string);
  const listed = await page.request.get(`${server.baseUrl}/api/reads/compact?chrom=${encodeURIComponent(chrom)}&start=0&end=${width}&dataset_id=${datasetId}`);
  const ids: string[] = ((await listed.json()).reads ?? []).slice(0, 3).map((r: { id: string }) => r.id);
  expect(ids.length).toBeGreaterThan(0);
  await page.evaluate(([ds, list]) => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    for (const id of list as string[]) st.toggleReadSelection(ds, id);
  }, [datasetId, ids] as const);
  const box = (await readsCanvas(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 6, { button: 'right' });
  const findMore = page.waitForResponse(r => r.url().includes('/find_more'), { timeout: 60_000 });
  await page.locator('[role="menuitem"][data-action="ext:meta-locus:find-more"]').click();
  expect((await findMore).ok()).toBe(true);
  const chip = page.getByTestId('meta-locus-enriched');
  await expect(chip).toHaveText(/^enriched · [\d.]+%$/);
  const chipBox = (await chip.boundingBox())!;
  const moreBox = (await page.getByTestId('meta-locus-more').boundingBox())!;
  expect(Math.abs((chipBox.y + chipBox.height / 2) - (moreBox.y + moreBox.height / 2))).toBeLessThan(6);  // one row
  expect(chipBox.height).toBeLessThan(28);
  expect((await page.getByTestId('meta-locus-controls').boundingBox())!.height).toBeLessThan(40);
  // ... on the same row as the zoom controls (the navigation row did not wrap).
  const zoomBox = (await page.getByTestId('zoom-in-button').boundingBox())!;
  expect(Math.abs((chipBox.y + chipBox.height / 2) - (zoomBox.y + zoomBox.height / 2))).toBeLessThan(8);
  await chip.click();
  await expect(page.getByTestId('meta-locus-find-more')).toContainText(/found [\d,]+ of [\d,]+ read-site observations scanned · freq [\d.]+% \(Wilson 95% [\d.]+%–[\d.]+%\)/);
  await chip.click();
  await expect(page.getByTestId('meta-locus-find-more-popover')).toHaveCount(0);
  const shownBefore = await page.getByTestId('meta-locus-count').textContent();

  // Open this site (the read's real locus), then back into the meta-locus.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().clearReadSelection?.());
  await page.keyboard.press('Escape');
  // The toolbar may have grown a line (the frequency): the reads moved.
  const box2 = (await readsCanvas(page).boundingBox())!;
  await page.mouse.click(box2.x + box2.width / 2, box2.y + 30, { button: 'right' });
  await page.locator('[role="menuitem"][data-action="ext:meta-locus:open-site"]').click();
  await expect.poll(() => store(page, s => s.chrom as string)).toBe(region.chrom);
  const siteLocus = await store(page, s => ({ chrom: s.chrom as string, start: s.start as number, end: s.end as number }));
  // The normal Back (navigation history, Alt+←) returns to the meta-locus with the same working set.
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => store(page, s => s.chrom as string)).toBe(chrom);
  await expect(page.getByTestId('meta-locus-count')).toHaveText(shownBefore!);
  await expect(page.getByTestId('meta-locus-enriched')).toBeVisible();

  // Back to the last real locus (the site just visited; before it, the locus the meta-locus was opened from).
  expect(siteLocus).not.toEqual(realLocus);
  await page.getByTestId('meta-locus-back').click();
  await expect.poll(() => store(page, s => ({ chrom: s.chrom, start: s.start, end: s.end }))).toEqual(siteLocus);
  await page.getByTestId('meta-locus-return').click();
  await expect.poll(() => store(page, s => s.chrom as string)).toBe(chrom);

  // Save the session: the pool spec, seed, working-set size and refilled reads.
  const download = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const sessionPath = info.outputPath('meta-locus-session.json');
  await (await download).saveAs(sessionPath);
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  expect(session.frontend.metaLocus).toMatchObject({ bed_path: bed, anchor: 'start', flank_bp: 1500, count: 1400 });
  expect(session.frontend.metaLocus.extra_entries.length).toBeGreaterThan(0);
  expect(session.viewport?.chrom ?? session.frontend.chrom).toBe(chrom);

  // A reload restores the meta-locus from the address (pool spec, BED hash, seed, working-set size).
  const address = new URL(page.url());
  expect(address.searchParams.get('ml_bed')).toBe(bed);
  expect(address.searchParams.get('ml_sha')).toMatch(/^[0-9a-f]{64}$/);
  expect(address.searchParams.get('ml_count')).toBe('1400');
  await page.unroute(/\/api\/meta_locus\/pools\/[^/]+$/);
  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).__FIBERBROWSER_STORE__?.getState().datasets.length));
  await expect.poll(() => store(page, s => s.chrom as string), { timeout: 60_000 }).toBe(chrom);
  await expect(page.getByTestId('location-search-input')).toHaveValue('demo_sites · TSS ± 1.5 kb');
  await expect(page.getByTestId('meta-locus-count')).toContainText(/ of [\d,]+/);
  await expect(page.getByTestId('meta-locus-notice')).toHaveCount(0);

  // Restore the session in this page: the same meta-locus, its working set (with its refilled reads) and its reads.
  await page.route(/\/api\/pick_file(?:\?|$)/, route => route.fulfill({ json: { success: true, path: sessionPath, paths: [sessionPath] } }));
  const restoredReads = metaReads(page);
  const [imported] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/import' && r.request().method() === 'POST', { timeout: 60_000 }),
    page.getByTestId('load-file-button').click(),
  ]);
  expect(imported.ok()).toBe(true);
  await expect.poll(() => store(page, s => s.chrom as string), { timeout: 60_000 }).toBe(chrom);
  expect((await restoredReads).ok()).toBe(true);
  await expect(page.getByTestId('location-search-input')).toHaveValue('demo_sites · TSS ± 1.5 kb');
  await expect(page.getByTestId('meta-locus-enriched')).toBeVisible();
});

test('the Open dialog: a file chosen in the browser, a typed path, and errors shown in the dialog', async ({ server, page }, info) => {
  test.setTimeout(180_000);
  await open(page, server.baseUrl);
  const region = server.defaultRegion!;
  const bed = info.outputPath('chosen_sites.bed');
  demoBed(bed, region);
  const openDialog = async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('command-palette-input').fill('meta-locus');
    await page.locator('[role="option"][data-palette-item="cmd:open-meta-locus"]').click();
    await expect(page.getByTestId('meta-locus-dialog')).toBeVisible();
  };
  await openDialog();
  // Errors stay in the dialog: no BED, a path the server has not got, a file that is not a BED.
  await page.getByTestId('meta-locus-open').click();
  await expect(page.getByTestId('meta-locus-dialog-error')).toContainText('Choose a BED file');
  await page.getByTestId('meta-locus-bed').fill('/no/such/dir/sites.bed');
  await page.getByTestId('meta-locus-open').click();
  await expect(page.getByTestId('meta-locus-dialog-error')).toContainText('No BED file at /no/such/dir/sites.bed');
  await expect(page.getByTestId('meta-locus-dialog')).toBeVisible();
  const junk = info.outputPath('junk.bed');
  writeFileSync(junk, 'this is not a BED\nchr1\tx\ty\n');
  await page.getByTestId('meta-locus-file').setInputFiles(junk);
  await page.getByTestId('meta-locus-open').click();
  await expect(page.getByTestId('meta-locus-dialog-error')).toContainText('No BED regions in junk.bed');
  // A file chosen in the browser (Playwright's file chooser API; no native dialog): sent as text, opens the meta-locus.
  await page.getByTestId('meta-locus-file').setInputFiles(bed);
  await expect(page.getByTestId('meta-locus-upload')).toContainText('chosen_sites.bed');
  await page.getByTestId('meta-locus-flank').fill('1500');
  await page.getByTestId('meta-locus-open').click();
  await expect(page.getByTestId('meta-locus-dialog')).toBeHidden();
  await expect.poll(() => store(page, s => String(s.chrom)), { timeout: 60_000 }).toMatch(/^meta:/);
  await expect(page.getByRole('button', { name: 'More reads' }).first()).toBeVisible();
});
