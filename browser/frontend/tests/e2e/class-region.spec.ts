/**
 * Which region Find classes analyses (fb-n5-classregion), on the demo BAM:
 *
 * - with a peak selected and "Selected peaks" chosen, the card's line names the
 *   peak's coordinates and the peak is outlined (dashed) on the panel's ruler
 *   and reads; the run request is exactly the peak;
 * - "This view" makes the request the view.
 *
 * The run requests are answered here (no inference): only what the UI sends is checked.
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

const VIEW = { chrom: 'chr19', start: 47_514_000, end: 47_518_000 };
const SHOTS = process.env.FIBERBROWSER_E2E_SHOTS;

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

test('Find classes names and outlines the region it analyses; the choice sets the request', async ({ page, server }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const requests: any[] = [];
  await page.route('**/api/footprint/consensus/jobs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: 'e2e: request captured' }) });
  });

  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('location-search-input').fill(`${VIEW.chrom}:${VIEW.start}-${VIEW.end}`);
  await page.getByTestId('location-search-submit').click();
  await expect.poll(() => store(page, s => `${s.start}-${s.end}`), { timeout: 20_000 }).toBe(`${VIEW.start}-${VIEW.end}`);

  // One peak, selected as a click on the Peaks track does.
  await expect.poll(() => store(page, s => s.getAllPeaks().filter((p: any) => p.start >= 47_514_000 && p.end <= 47_518_000).length),
    { timeout: 45_000 }).toBeGreaterThanOrEqual(1);
  const peak = await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    const p = st.getAllPeaks().filter((q: any) => q.start >= 47_514_000 && q.end <= 47_518_000)[0];
    st.replacePeakSelection([p.index], 'accessibility');
    return { start: p.start as number, end: p.end as number };
  });

  await panelButton(page, 'footprint-analysis').click();
  const card = page.getByTestId('consensus-tools');
  await expect(card.getByTestId('automatic-family-mode')).toHaveText('Find footprint classes');
  // The default (This view) is said plainly.
  await expect(card.getByTestId('class-region-line')).toHaveText('Analyses: chr19:47,514,000–47,518,000 · 4,000 bp · this view');

  // Selected peaks: the line names the peak, and the peak is outlined on the panel.
  await card.getByTestId('class-region-peaks').click();
  const fmt = (n: number) => n.toLocaleString('en-US');
  await expect(card.getByTestId('class-region-line'))
    .toHaveText(`Analyses: chr19:${fmt(peak.start)}–${fmt(peak.end)} · ${fmt(peak.end - peak.start)} bp · the selected peak`);
  const outline = page.locator('[data-testid="class-region-outline"]');
  await expect(outline.first()).toBeVisible();
  await expect(outline.first()).toHaveAttribute('data-region', `chr19:${peak.start}-${peak.end}`);
  // On the ruler too (a full dashed box, labelled).
  await expect(page.locator('[data-testid="class-region-outline"][title="Find classes"]').first()).toBeVisible();
  if (peak.end - peak.start < 700) await expect(card.getByTestId('class-region-short')).toBeVisible();
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/class_region_peak.png` });
    await card.screenshot({ path: `${SHOTS}/class_region_card_peak.png` });
  }

  await card.getByTestId('run-lattice-consensus').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ chrom: 'chr19', start: peak.start, end: peak.end, region_source: 'peaks', region_label: 'the selected peak' });

  // This view: the request is the view.
  await card.getByTestId('class-region-view').click();
  await expect(card.getByTestId('class-region-line')).toHaveText('Analyses: chr19:47,514,000–47,518,000 · 4,000 bp · this view');
  await expect(outline.first()).toHaveAttribute('data-region', `chr19:${VIEW.start}-${VIEW.end}`);
  await expect(card.getByTestId('class-region-short')).toHaveCount(0);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/class_region_card_view.png` });
  await card.getByTestId('run-lattice-consensus').click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ ...VIEW, region_source: 'view' });

  // The choice is an undo step; closing the card clears the outline.
  expect(await store(page, s => s.classRegionMode)).toBe('view');
  await panelButton(page, 'footprint-analysis').click();
  await expect(outline).toHaveCount(0);
  expect(errors).toEqual([]);
});
