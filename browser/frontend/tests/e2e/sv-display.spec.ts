/**
 * Structural variants (fb-n9-sv) on an explicitly synthetic Fiber-seq BAM
 * (tests/sv_fixtures.py: a 1.5 kb deletion carried by 10 reads by CIGAR and
 * 3 split reads, 8 reference reads, 3 reads that stop short, a 400 bp
 * insertion), generated per test into a temp dir. Loads the locus, sees the
 * SV summary track, splits the reads by the deletion's allele and sees the
 * groups (carriers, reference, not informative) with their names.
 */
import { test, expect } from './fixtures/server';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VIEW = { chrom: 'chrSV', start: 8_000, end: 16_000 };

test.use({
  fixtureBam: async ({}, use) => {
    const bam = path.join(mkdtempSync(path.join(tmpdir(), 'fiberbrowser-sv-')), 'sv_demo.bam');
    execFileSync(process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python',
      [path.join(REPO_ROOT, 'tests', 'make_sv_demo_bam.py'), bam], { stdio: 'inherit' });
    await use(bam);
  },
});

/** Pixels of the SV track (its own row above the reads, fb-n11-tracks) that are the deletion red. */
async function redBandPixels(page: any): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-testid^="sv-track-canvas-"]') as HTMLCanvasElement | null;
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) red += 1;
    return red;
  });
}

test('SV summary track, then split the reads by the deletion allele', async ({ page, server }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  // The first load can send the same request more than once (a superseded one is aborted, and Chromium may drop the
  // body of an early one): keep the bodies that can be read and use the last.
  const bodies: any[] = [];
  page.on('response', async r => {
    if (!r.url().includes('/api/reads/compact') || !r.url().includes('chrSV') || !r.ok()) return;
    try { bodies.push(await r.json()); } catch { /* superseded */ }
  });
  await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
  await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const payload = bodies[bodies.length - 1];
  const data = payload.datasets ? Object.values(payload.datasets)[0] as any : payload;
  // The server's summary counts every read in view.
  expect(data.sv_summary.clusters.map((c: any) => [c.t, c.support, c.informative])).toEqual([['D', 13, 21], ['I', 9, 19]]);
  expect(data.reads.some((r: any) => (r.sv ?? []).some((e: any) => e.t === 'D' && e.len >= 1500))).toBe(true);

  const reads = page.locator('canvas[data-copilot-track="reads"]');
  await expect(reads).toHaveCount(1);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  // The band draws the deletion arc in red.
  await expect.poll(() => redBandPixels(page), { timeout: 15_000 }).toBeGreaterThan(20);

  // The support gate changes the rendered/hit-tested summary without a BAM reload.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setSvMinSupport(14));
  await expect.poll(() => redBandPixels(page)).toBe(0);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setSvMinSupport(3));
  await expect.poll(() => redBandPixels(page)).toBeGreaterThan(20);

  // Hover over the arc: its cluster tooltip.
  const svTrack = page.locator('canvas[data-testid^="sv-track-canvas-"]');
  const box = (await svTrack.boundingBox())!;
  const sidebar = Number(await reads.getAttribute('data-track-sidebar')) || 0;
  const xAt = (pos: number) => box.x + sidebar + ((pos - VIEW.start) / (VIEW.end - VIEW.start)) * (box.width - sidebar);
  await page.mouse.move(xAt(10_750), box.y + box.height / 2);
  await expect(page.getByTestId('sv-cluster-tooltip')).toContainText('DEL 1.5 kb');
  // Geometry support is now labelled by evidence tier; weaker calls have their own counts.
  await expect(page.getByTestId('sv-cluster-tooltip')).toContainText('13 confirmed of 21 informative');
  await expect(page.getByTestId('sv-cluster-tooltip')).toContainText('0 putative · 0 conflicting');

  // Right-click the arc: split the reads by this SV (the SV track's menu; the common track items under Track options).
  await page.mouse.click(xAt(10_750), box.y + box.height / 2, { button: 'right' });
  const menu = page.getByTestId('track-context-menu');
  await expect(menu).toBeVisible();
  // The hover card hides under the menu.
  await expect(page.getByTestId('sv-cluster-tooltip')).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Tracks in this panel…' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Track options' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Tracks in this panel…' })).toBeVisible();
  const split = page.waitForResponse(r => r.url().endsWith('/api/sv/split') && r.request().method() === 'POST');
  await menu.getByRole('menuitem', { name: 'Group in this panel by this SV' }).click();
  const splitJson = await (await split).json();
  expect(splitJson.counts).toEqual([13, 8, 3]);

  const state = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    const key = Object.keys(s.svSplits)[0];
    const groups = Object.values(s.clusterAssignments[key] ?? {}) as number[];
    return { key, label: s.svSplits[key]?.label, order: s.clusterOrder[key], sizes: [0, 1, 2].map(g => groups.filter(x => x === g).length) };
  });
  expect(state.label).toMatch(/^DEL 1\.5 kb @ chrSV:10,0/);
  expect(state.order).toEqual([0, 1, 2]);
  expect(state.sizes).toEqual([13, 8, 3]);
  await expect(page.getByTestId('read-action-notice')).toContainText('13 carriers, 8 reference, 3 not informative');

  // The groups are the panel's clusters: the cluster panel names them.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().openAnalysisPanel('cluster-detail'));
  await expect(page.getByText('Confirmed (13) + putative (0)', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Reference', { exact: true }).first()).toBeVisible();

  // A pan within the locus keeps the groups.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chrSV', 8_500, 16_500));
  await expect.poll(() => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return Object.keys(s.svSplits).length === 1 && Object.keys(Object.values(s.clusterAssignments)[0] as object).length;
  })).toBeGreaterThanOrEqual(24);
  expect(errors).toEqual([]);
});
