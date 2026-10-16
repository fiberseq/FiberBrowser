/**
 * The read map in Clusters › Overview (fb-n5-projection): clicking a dot
 * focuses its cluster in the read panel (Escape shows all again), Unmerge /
 * Merge again switch the cluster count back and forth, and a saved session
 * brings the merge state back.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { readFileSync } from 'fs';
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

const clusterCount = (page: Page) => getState(page, s => new Set(
  (Object.values(s.clusterAssignments) as Array<Record<string, number>>).flatMap(a => Object.values(a || {})),
).size);

async function cluster(page: Page) {
  await expect.poll(() => getState(page, s => s.getAllPeaks().length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.replacePeakSelection([0, 1]);
    st.setClusterMethod('kmeans');
    st.setClusterK(5);
  });
  const done = page.waitForResponse(res => res.url().includes('/api/cluster_all'), { timeout: 60_000 });
  await page.getByTestId('cluster-run-button').click();
  await done;
  await expect.poll(() => clusterCount(page), { timeout: 45_000 }).toBeGreaterThan(2);
  await page.waitForTimeout(1200); // the clustering's history step settles
}

/** A pixel of a dot on the map (a saturated colour), in CSS pixels of the canvas. */
async function aDot(page: Page): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId('projection-map-canvas').first();
  const box = (await canvas.boundingBox())!;
  const at = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext('2d')!;
    const { width, height } = el;
    const data = ctx.getImageData(0, 0, width, height).data;
    const dpr = width / el.clientWidth;
    // Scan from the middle out: dots, not the axis labels at the edges.
    for (let r = 0; r < Math.max(width, height) / 2; r += 2) {
      for (let a = 0; a < 64; a++) {
        const x = Math.round(width / 2 + r * Math.cos((a / 64) * Math.PI * 2));
        const y = Math.round(height / 2 + r * Math.sin((a / 64) * Math.PI * 2));
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        const [R, G, B] = [data[i], data[i + 1], data[i + 2]];
        if (Math.max(R, G, B) - Math.min(R, G, B) > 70) return { x: x / dpr, y: y / dpr };
      }
    }
    return null;
  });
  expect(at, 'a coloured dot on the map').not.toBeNull();
  return { x: box.x + at!.x, y: box.y + at!.y };
}

test('clicking a dot focuses its cluster in the read panel; Unmerge toggles; sessions keep it', async ({ server, page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openAt(page, server);
  await cluster(page);

  // Clusters › Overview › Map (Profiles + map side by side in a wide panel).
  const projection = page.waitForResponse(res => res.url().includes('/api/cluster_projection'), { timeout: 90_000 });
  await panelButton(page, 'cluster-detail').click();
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  await panel.getByRole('button', { name: 'Overview', exact: true }).click();
  await panel.getByTestId('cluster-overview-mode').getByRole('button', { name: 'Map', exact: true }).click();
  await projection;
  await expect(panel.getByTestId('projection-summary')).toContainText('t-SNE', { timeout: 90_000 });
  // Not a Charts sub-tab any more.
  await expect(panel.getByRole('button', { name: 'Projection', exact: true })).toHaveCount(0);
  await page.waitForTimeout(500);

  // Hover names the read; a click focuses its cluster everywhere.
  const dot = await aDot(page);
  await page.mouse.move(dot.x, dot.y);
  const tooltip = panel.getByTestId('projection-map-tooltip');
  await expect(tooltip).toBeVisible();
  const label = (await tooltip.textContent()) ?? '';
  const clusterId = Number(/C(\d+)/.exec(label)?.[1]);
  expect(Number.isFinite(clusterId)).toBe(true);
  await page.mouse.click(dot.x, dot.y);
  await expect.poll(() => getState(page, s => Object.values(s.clusterFocus).filter(Boolean).map((f: any) => [...f]))).toContainEqual([clusterId]);
  await expect(panel.getByTestId('projection-focus-status')).toContainText(`C${clusterId} focused`);
  // The read panel shows only that cluster's reads.
  await expect(page.getByTitle('Show all clusters (click to reset)').first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => getState(page, s => Object.entries(s.activeReadIds as Record<string, string[]>).every(([key, ids]) => {
    const a = s.clusterAssignments[key];
    return !a || ids.every(id => !(id in a) || a[id] === s.clusterFocus[key]?.values().next().value);
  })), { timeout: 30_000 }).toBe(true);
  await page.screenshot({ path: info.outputPath('map-focus.png') });

  // Escape (nothing open) shows every cluster again.
  await page.mouse.move(5, 500);
  await page.keyboard.press('Escape');
  await expect.poll(() => getState(page, s => Object.values(s.clusterFocus).some(Boolean))).toBe(false);

  // Merge two clusters, then Unmerge / Merge again: the count goes back and forth.
  const before = await clusterCount(page);
  await panel.getByTestId('cluster-overview-mode').getByRole('button', { name: 'Profiles', exact: true }).click();
  const rows = panel.locator('[data-copilot-anchor^="cluster-row-"]');
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['Shift'] });
  await panel.locator('[data-copilot-anchor="cluster-merge-button"]').click();
  await expect.poll(() => clusterCount(page)).toBe(before - 1);
  const chip = panel.getByTestId('cluster-merge-chip');
  await expect(chip).toContainText(`Merged: ${before} → ${before - 1} clusters`);
  await panel.getByTestId('cluster-merge-toggle').click();
  await expect.poll(() => clusterCount(page)).toBe(before);
  await expect(chip).toHaveAttribute('data-merge-state', 'original');
  await panel.getByTestId('cluster-merge-toggle').click();
  await expect.poll(() => clusterCount(page)).toBe(before - 1);
  await expect(chip).toHaveAttribute('data-merge-state', 'merged');
  // Undo is the switch back.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(() => clusterCount(page)).toBe(before);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  await expect.poll(() => clusterCount(page)).toBe(before - 1);

  // Session: save, restore in a fresh page; Unmerge still works there.
  const sessionDownload = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const sessionPath = info.outputPath('session.json');
  await (await sessionDownload).saveAs(sessionPath);
  const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
  expect(saved.frontend.clusterMergeLog?.steps?.length).toBe(1);
  expect(saved.frontend.mergeStrategy).toBe('cosine');

  const fresh = await page.context().newPage();
  fresh.on('pageerror', e => errors.push(e.message));
  await openAt(fresh, server);
  await fresh.getByTestId('settings-rail-file').click();
  const fileInput = fresh.getByTestId('restore-session-file-input');
  const imported = fresh.waitForResponse(r => r.url().includes('/api/session/import') && r.request().method() === 'POST');
  await fileInput.setInputFiles(sessionPath);
  expect((await (await imported).json()).success).toBe(true);
  await expect.poll(() => clusterCount(fresh), { timeout: 30_000 }).toBe(before - 1);
  const freshPanel = fresh.locator('[data-panel-content-type="cluster-detail"]');
  if (!(await freshPanel.count())) await panelButton(fresh, 'cluster-detail').click();
  await expect(freshPanel.getByTestId('cluster-merge-chip')).toContainText(`Merged: ${before} → ${before - 1} clusters`);
  await freshPanel.getByTestId('cluster-merge-toggle').click();
  await expect.poll(() => clusterCount(fresh)).toBe(before);
  await fresh.close();

  expect(errors).toEqual([]);
});
