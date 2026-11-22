/**
 * Compare is a main choice and Summary works with it: a metaprofile grouped by two clusters; Compare A − B from the
 * builder's main row (More options stays shut); Summary of the comparison draws one value with whiskers (the seeded
 * bootstrap) and the state line says what is shown; a size map with Compare on disables its Summary with the reason;
 * Compare off brings the per-group summary back. At 1280, 1440 and 1920 wide the builder row fits (no overflow) and
 * screenshots go to FIBERBROWSER_E2E_SHOTS when set.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect, DEMO_FIXTURE } from './fixtures/server';
import type { Page } from '@playwright/test';

test.use({ fixtureBam: 'demo' });
const REGION = DEMO_FIXTURE.region;
const SHOTS = process.env.FIBERBROWSER_E2E_SHOTS?.trim() || '';
const SIZES: Array<[number, number]> = [[1280, 800], [1440, 900], [1920, 1080]];

async function openClustered(page: Page, baseUrl: string, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
  });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate((r: typeof REGION) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end), REGION);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  // Two clusters of the reads here (peaks first: the clustering reads them).
  await page.evaluate(() => { if ((window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().length < 3) (window as any).fiberbrowserCommand?.('scan-peaks'); });
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().length), { timeout: 60_000 }).toBeGreaterThan(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__;
    const peaks = st.getState().getAllPeaks();
    st.setState({ clusterMethod: 'binary', clusterK: 2, clusterPeakMode: 'accessibility', clusterPreparationCount: null });
    st.getState().replacePeakSelection([(peaks.find((p: { layer?: number }) => p.layer === 1) ?? peaks[0]).index]);
  });
  const clustered = page.waitForResponse(r => r.url().includes('/api/cluster_all') && r.ok(), { timeout: 90_000 });
  await page.getByTestId('cluster-run-button').click();
  await clustered;
  await expect.poll(() => page.evaluate(() => Object.values((window as any).__FIBERBROWSER_STORE__.getState().clusterAssignments as Record<string, object>)
    .reduce((n: number, a) => n + Object.keys(a).length, 0)), { timeout: 90_000 }).toBeGreaterThan(10);
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0, { timeout: 90_000 }).catch(() => undefined);
  await page.keyboard.press('p');
  await expect(page.getByTestId('plots-workspace')).toBeVisible();
}

/** Builder elements that stick out of the pane sideways or clip their own text. */
async function builderOverflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="plots-builder-pane"]') as HTMLElement | null;
    if (!pane) return ['no builder pane'];
    const box = pane.getBoundingClientRect();
    const out: string[] = [];
    for (const el of Array.from(pane.querySelectorAll<HTMLElement>('label, select, input, button, span, p, h3'))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const name = `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || '').trim().slice(0, 40)}"`;
      if (r.right > box.right + 1 || r.left < box.left - 1) out.push(`outside: ${name}`);
      const cs = getComputedStyle(el);
      const clips = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || el.tagName === 'BUTTON';
      if (clips && el.scrollWidth > el.clientWidth + 1 && !el.classList.contains('truncate')) out.push(`clipped: ${name}`);
    }
    return [...new Set(out)];
  });
}

async function shoot(page: Page, name: string, w: number, h: number) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const ws = page.getByTestId('plots-workspace');
  // The panes scroll: a tall window for the picture (same width, so the same layout).
  await page.setViewportSize({ width: w, height: 2000 });
  await page.waitForTimeout(500);
  await ws.getByTestId('plots-builder-pane').screenshot({ path: path.join(SHOTS, `${w}_${name}_builder.png`) });
  await ws.getByTestId('plots-card').screenshot({ path: path.join(SHOTS, `${w}_${name}_card.png`) });
  await page.screenshot({ path: path.join(SHOTS, `${w}_${name}_window.png`) });
  await page.setViewportSize({ width: w, height: h });
}

for (const [w, h] of SIZES) {
  test(`Compare from the main row; Summary of the comparison with whiskers and the state line (${w}×${h})`, async ({ server, page }) => {
    test.setTimeout(420_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await openClustered(page, server.baseUrl, w, h);
    const ws = page.getByTestId('plots-workspace');

    // Metaprofile by cluster: two groups.
    await ws.getByTestId('plots-type-metaprofile').click();
    await ws.getByTestId('plots-group-cluster').click();
    const plot = ws.getByTestId('plots-profile-plot');
    await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
    await expect.poll(async () => Number(await plot.getAttribute('data-groups')), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

    // Compare is in the main row, right after Group by; More options stays shut.
    await expect(ws.getByTestId('plots-more')).toHaveCount(0);
    const compare = ws.getByTestId('plots-compare');
    await expect(compare).toBeVisible();
    const order = await ws.getByTestId('plots-builder').evaluate(b => [...b.querySelectorAll('[data-testid="plots-group"], [data-testid="plots-compare"], [data-testid="plots-sampling"]')].map(e => e.getAttribute('data-testid')));
    expect(order).toEqual(['plots-group', 'plots-compare', 'plots-sampling']);
    await expect(ws.getByTestId('plots-compare-diff')).toBeEnabled();
    await ws.getByTestId('plots-compare-diff').click();
    await expect(plot).toHaveAttribute('data-comparing', /.+/, { timeout: 60_000 });
    // One comparison: A vs B.
    await ws.getByTestId('plots-compare-mode').selectOption('a-vs-b');
    await expect(plot).toHaveAttribute('data-comparing', 'a-vs-b');
    await expect(ws.getByTestId('plots-state-line')).toHaveText(/^Comparing .+ vs .+ · A − B$/);

    // Summary of the comparison: one value with whiskers, and the state line names it.
    await expect(ws.getByTestId('plots-summary-settings')).toContainText('Summary of the comparison');
    await ws.getByTestId('plots-summary-on').check();
    const summary = ws.getByTestId('plots-summary');
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(summary).toHaveAttribute('data-groups', '1');
    await expect.poll(async () => JSON.parse((await summary.getAttribute('data-intervals')) || '[]') as Array<[number, number] | null>, { timeout: 60_000 })
      .toEqual([expect.arrayContaining([expect.any(Number)])]);
    const [value] = JSON.parse((await summary.getAttribute('data-values')) || '[]') as number[];
    const [[lo, hi]] = JSON.parse((await summary.getAttribute('data-intervals')) || '[]') as Array<[number, number]>;
    expect(lo).toBeLessThanOrEqual(hi);
    expect(Number.isFinite(value)).toBe(true);
    await expect(ws.getByTestId('plots-summary-measures')).toContainText("A − B of the curve's mean");
    await expect(ws.getByTestId('plots-summary-measures')).toContainText('A and B resampled together');
    await expect(ws.getByTestId('plots-summary-chart')).toBeVisible();
    await expect(ws.getByTestId('plots-state-line')).toHaveText(/^Comparing .+ vs .+ · A − B · summary of the difference, .+/);
    expect(await builderOverflows(page)).toEqual([]);
    await shoot(page, 'metaprofile_compare_summary', w, h);

    // log2 ratio: the summary follows.
    await ws.getByTestId('plots-compare-log2ratio').click();
    await expect(ws.getByTestId('plots-summary-measures')).toContainText("log2(A / B) of the curve's mean", { timeout: 60_000 });
    await expect(ws.getByTestId('plots-state-line')).toContainText('summary of the log2 ratio');

    // A size map with Compare on: its Summary is disabled, with the reason next to it; the state line says so.
    await ws.getByTestId('plots-type-size-enrichment').click();
    const size = ws.getByTestId('plots-size-plot');
    await expect(size).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
    await expect(ws.getByTestId('plots-summary-on')).toBeDisabled();
    await expect(ws.getByTestId('plots-summary-blocked')).toHaveText('Summary is off while comparing; turn Compare off to summarise each group.');
    await expect(ws.getByTestId('plots-summary')).toHaveCount(0);
    await expect(ws.getByTestId('plots-state-line')).toContainText('summary off while comparing');
    expect(await builderOverflows(page)).toEqual([]);
    await shoot(page, 'size_compare_summary_off', w, h);

    // Compare off: the per-group summary is back (summary.on was kept).
    await ws.getByTestId('plots-compare-off').click();
    await expect(ws.getByTestId('plots-summary-on')).toBeEnabled();
    await expect(ws.getByTestId('plots-summary-on')).toBeChecked();
    await expect(ws.getByTestId('plots-summary')).toBeVisible({ timeout: 120_000 });
    await expect(ws.getByTestId('plots-state-line')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
