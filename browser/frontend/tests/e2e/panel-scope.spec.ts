/**
 * Panel scope and history (fb-n2-scope), on the demo BAM:
 *
 * - audit M8: with peak auto-scan, a panel step followed by a re-scan took
 *   two Undos (the first only reverted the re-scanned peaks, "Undo: earlier
 *   changes (before …)");
 * - audit M1: in "Each panel navigates" Highlight › View used the stale main
 *   locus instead of the panel's own;
 * - audit L8: the ruler's hover crosshair ran past the panels to the window's
 *   bottom edge.
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function open(page: Page, baseUrl: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
}

async function goMain(page: Page, locus: string) {
  await page.getByTestId('location-search-input').fill(locus);
  await page.getByTestId('location-search-submit').click();
}

const panelLocus = (page: Page) => store(page, s => {
  const p = s.panels.find((q: any) => q.contentType === 'dataset');
  return p?.viewportOverride ? `${p.viewportOverride.chrom}:${p.viewportOverride.start}-${p.viewportOverride.end}` : 'main';
});
const peakKey = (page: Page) => store(page, s => JSON.stringify(Object.values(s.peaksByRule ?? {}).flat().map((p: any) => [p.chrom ?? s.chrom, p.start, p.end])));

async function movePanel(page: Page, locus: string) {
  const bar = page.getByTestId('panel-site-bar').first();
  await bar.getByTestId('panel-location-input').fill(locus);
  await bar.getByTestId('panel-location-submit').click();
}

test('Per panel: one Undo per panel step although peaks are re-scanned; View highlights the panel; the crosshair stays in the panels', async ({ page, server }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page, server.baseUrl);
  await goMain(page, 'chr19:47514000-47518000');
  await expect.poll(() => store(page, s => s.start), { timeout: 20_000 }).toBe(47_514_000);
  // The main view's undo step is pushed once it settles (500 ms).
  await page.waitForTimeout(1_200);

  await page.getByTestId('nav-mode-perPanel').click();
  await expect.poll(() => panelLocus(page)).toBe('chr19:47514000-47518000');

  // Step 1: the panel moves; the auto-scan re-scans peaks for it.
  let peaks = await peakKey(page);
  await movePanel(page, 'chr19:47514500-47517500');
  await expect.poll(() => panelLocus(page), { timeout: 20_000 }).toBe('chr19:47514500-47517500');
  await expect.poll(() => peakKey(page), { timeout: 45_000 }).not.toBe(peaks);
  await page.waitForLoadState('networkidle');

  // Step 2: it moves again.
  peaks = await peakKey(page);
  await movePanel(page, 'chr19:47515000-47518000');
  await expect.poll(() => panelLocus(page), { timeout: 20_000 }).toBe('chr19:47515000-47518000');
  // No checkpoint of the re-scanned peaks alone between the two steps.
  const labels = await store(page, s => s._historyStack.map((x: any) => x.label));
  expect(labels.at(-2)).toMatch(/Panel to chr19:47,514,500/);

  // One Undo takes the panel back to step 1 (not "earlier changes" first).
  const undo = page.getByTestId('quick-undo-button');
  await expect(undo).toHaveAttribute('title', /^Undo: (Navigate panel|Panel) to chr19:47,515,000/);
  await undo.click();
  await expect.poll(() => panelLocus(page)).toBe('chr19:47514500-47517500');
  await expect(undo).toHaveAttribute('title', /^Undo: (Navigate panel|Panel) to chr19:47,514,500/);
  await page.getByTestId('quick-redo-button').click();
  await expect.poll(() => panelLocus(page)).toBe('chr19:47515000-47518000');

  // Highlight › View: the panel's own view, not the stale main locus.
  if (!(await page.getByTestId('highlight-view-button').isVisible())) await page.getByTestId('toolbar-group-toggle-highlight').click();
  await page.getByTestId('highlight-view-button').click();
  await expect.poll(() => store(page, s => s.highlights.map((h: any) => `${h.chrom}:${h.start}-${h.end}`))).toEqual(['chr19:47515000-47518000']);

  // The ruler's crosshair ends with the panel.
  const ruler = page.locator('[data-panel-id] canvas.cursor-crosshair, [data-panel-id] canvas.cursor-cell').first();
  const box = (await ruler.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const line = page.getByTestId('ruler-crosshair');
  await expect(line).toBeVisible();
  const lineBox = (await line.boundingBox())!;
  const panelBox = (await page.locator('[data-panel-id]').first().boundingBox())!;
  expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
  expect(lineBox.height).toBeGreaterThan(50);

  expect(errors).toEqual([]);
});
