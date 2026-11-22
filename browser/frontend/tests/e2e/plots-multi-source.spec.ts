/**
 * Several sources in one Plots metaprofile, on the tracked NAPA demo BAM: Nuc + TF + one footprint class found by
 * Find classes run from the Source chips' step button (the families group is greyed with that button until then).
 * Grouped by the state at the anchor (three groups of the one dataset), the plot draws a panel per group with three
 * lines (one per source, each in its layer colour) and a legend of the three sources in every panel; Summary across
 * groups draws grouped bars (three per group, each with whiskers), the line form one line per source; Compare A − B
 * runs per source (a line per source per comparison; one summary bar per source); Keep records the sources and Open
 * brings them back. The builder and the canvases' text fit at 1280, 1440 and 1920 wide; screenshots go to
 * FIBERBROWSER_E2E_SHOTS when set.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

// A short window: Find classes runs on the view.
const REGION = { chrom: 'chr19', start: 47_514_900, end: 47_515_500 };
const SHOTS = process.env.FIBERBROWSER_E2E_SHOTS?.trim() || '';
const SIZES: Array<[number, number]> = [[1280, 800], [1440, 900], [1920, 1080]];

async function open(page: Page, baseUrl: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await page.keyboard.press('p');
  await expect(page.getByTestId('plots-workspace')).toBeVisible();
}

/** Builder elements that stick out of the pane sideways or clip their own text (as plots-fit checks). */
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

/** The plot card's figures stay inside the card (no sideways overflow). */
async function cardOverflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const card = document.querySelector('[data-testid="plots-card"]') as HTMLElement | null;
    if (!card) return ['no card'];
    const box = card.getBoundingClientRect();
    return Array.from(card.querySelectorAll<HTMLElement>('canvas')).filter(c => c.getBoundingClientRect().right > box.right + 1)
      .map(c => `canvas of ${c.closest('[data-testid]')?.getAttribute('data-testid')} outside the card`);
  });
}

async function shoot(page: Page, name: string, w: number, h: number) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const ws = page.getByTestId('plots-workspace');
  await page.setViewportSize({ width: w, height: 2400 });
  await page.waitForTimeout(500);
  await ws.getByTestId('plots-builder-pane').screenshot({ path: path.join(SHOTS, `${w}_${name}_builder.png`) });
  await ws.getByTestId('plots-card').screenshot({ path: path.join(SHOTS, `${w}_${name}_card.png`) });
  await page.setViewportSize({ width: w, height: h });
  await page.screenshot({ path: path.join(SHOTS, `${w}_${name}_window.png`) });
}

const json = async <T,>(loc: ReturnType<Page['getByTestId']>, attr: string): Promise<T> => JSON.parse((await loc.getAttribute(attr)) || 'null') as T;

test('a metaprofile of Nuc + TF + a footprint class: three lines per group, the legend, grouped summary bars, Compare per source, Keep', async ({ server, page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page, server.baseUrl);
  const ws = page.getByTestId('plots-workspace');

  await ws.getByTestId('plots-type-metaprofile').click();
  const source = ws.getByTestId('plots-source');
  // Nuc and TF on, All footprints off (several sources: each chip adds or removes).
  await ws.getByTestId('plots-source-nuc').click();
  await ws.getByTestId('plots-source-tf').click();
  await ws.getByTestId('plots-source-all_footprints').click();
  await expect(source).toContainText('2 selected');
  await expect(ws.getByTestId('plots-source-nuc')).toHaveAttribute('aria-pressed', 'true');
  await expect(ws.getByTestId('plots-source-tf')).toHaveAttribute('aria-pressed', 'true');

  // No classes here yet: the families group is greyed, with the step button.
  await expect(ws.getByTestId('plots-source-family-empty-fp-families')).toBeDisabled();
  await expect(ws.getByTestId('plots-source-family-empty-nfr-families')).toBeDisabled();
  await expect(ws.getByTestId('plots-source-family-step-nfr-families')).toBeVisible();
  await ws.getByTestId('plots-source-family-fp-families').getByTestId('plots-prereq-run-classes').click();
  // Find classes runs behind Plots; the classes appear as chips.
  const chips = ws.getByTestId('plots-source-family-chip');
  await expect.poll(() => chips.count(), { timeout: 420_000 }).toBeGreaterThan(0);
  if (!(await ws.isVisible())) await page.keyboard.press('p');
  await chips.first().click();
  await expect(source).toContainText('3 selected');
  const className = ((await chips.first().textContent()) || '').trim();

  // Three groups: the reads' state at the anchor (More options › Display).
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-profile-condition').check();
  await expect(ws.getByTestId('plots-profile-multi-layout')).toBeVisible();

  const plot = ws.getByTestId('plots-profile-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 180_000 });
  await expect.poll(async () => (await json<string[]>(plot, 'data-sources'))?.length, { timeout: 60_000 }).toBe(3);
  const panels = Number(await plot.getAttribute('data-panels'));
  expect(panels).toBe(Number(await plot.getAttribute('data-groups')));
  expect(panels).toBeGreaterThanOrEqual(2);
  // Three lines per group, every legend lists the three sources, three colours.
  expect(await json<number[]>(plot, 'data-series-per-panel')).toEqual(new Array(panels).fill(3));
  const legends = await json<string[][]>(plot, 'data-legend');
  for (const l of legends) expect(l).toEqual(['Nuc', 'TF', className]);
  expect((await json<string[]>(plot, 'data-line-colors')).length).toBe(3);
  await expect(ws.getByTestId('plots-profile-chart')).toHaveCount(panels);
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    expect(await builderOverflows(page), `builder at ${w}`).toEqual([]);
    expect(await cardOverflows(page), `card at ${w}`).toEqual([]);
    await shoot(page, 'multisource_panels', w, h);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // The relative x-axis (3.1.1): every source panel is labelled by distance from the anchor (the view centre here).
  await ws.getByTestId('plots-axis-mode').selectOption('centre');
  await expect.poll(async () => ws.getByTestId('plots-profile-chart').evaluateAll(els => els.map(e => e.getAttribute('data-x-label'))), { timeout: 60_000 })
    .toEqual(new Array(panels).fill('Distance from the view centre (bp)'));
  await shoot(page, 'multisource_relative_axis', 1440, 900);
  await ws.getByTestId('plots-axis-mode').selectOption('genome');
  await expect.poll(async () => ws.getByTestId('plots-profile-chart').evaluateAll(els => els.every(e => e.getAttribute('data-x-label') !== 'Distance from the view centre (bp)'))).toBe(true);

  // Summary across groups: grouped bars, three per group, each with whiskers.
  await ws.getByTestId('plots-summary-on').check();
  const summary = ws.getByTestId('plots-summary');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(summary).toHaveAttribute('data-grouped', 'true');
  await expect(summary).toHaveAttribute('data-series', '3');
  await expect(summary).toHaveAttribute('data-clusters', String(panels));
  expect(await json<string[]>(summary, 'data-series-labels')).toEqual(['Nuc', 'TF', className]);
  await expect.poll(async () => (await json<Array<[number, number] | null>>(summary, 'data-intervals')).filter(Boolean).length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(2 * panels);
  expect((await json<unknown[]>(summary, 'data-values')).length).toBe(3 * panels);
  for (const [w, h] of SIZES) { await page.setViewportSize({ width: w, height: h }); await shoot(page, 'multisource_summary_bars', w, h); }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The line form: one line per source across the groups.
  await ws.getByTestId('plots-summary-chart-kind').selectOption('line');
  await expect(summary).toHaveAttribute('data-series', '3');
  await shoot(page, 'multisource_summary_line', 1440, 900);
  await ws.getByTestId('plots-summary-chart-kind').selectOption('bar');

  // Compare A − B, per source: a panel per comparison with a line per source; one summary bar per source.
  await ws.getByTestId('plots-compare-diff').click();
  await expect(plot).toHaveAttribute('data-comparing', /.+/, { timeout: 60_000 });
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  const cmpPanels = Number(await plot.getAttribute('data-panels'));
  expect(cmpPanels).toBeGreaterThanOrEqual(1);
  expect(await json<number[]>(plot, 'data-series-per-panel')).toEqual(new Array(cmpPanels).fill(3));
  await expect(ws.getByTestId('plots-profile-compare')).toHaveCount(cmpPanels);
  await expect(summary).toHaveAttribute('data-series', '3', { timeout: 60_000 });
  await expect(summary).toHaveAttribute('data-clusters', String(cmpPanels));
  await expect(ws.getByTestId('plots-summary-measures')).toContainText("A − B of the curve's mean");
  await shoot(page, 'multisource_compare', 1440, 900);
  await ws.getByTestId('plots-compare-off').click();
  await expect(plot).toHaveAttribute('data-comparing', '', { timeout: 60_000 });

  // Keep records the sources; Open brings them back.
  await expect(ws.getByTestId('plots-keep')).toBeEnabled({ timeout: 60_000 });
  await ws.getByTestId('plots-keep').click();
  await ws.getByTestId('plots-type-size-histogram').click();
  await expect(source).not.toContainText('selected');
  await expect(ws.getByTestId('plots-source-nuc')).toHaveAttribute('aria-pressed', 'true');
  await expect(ws.getByTestId('plots-source-tf')).toHaveAttribute('aria-pressed', 'false');
  await ws.getByTestId('plots-tab-gallery').click();
  const card = ws.locator('[data-testid="gallery-card"]').first();
  await expect(card).toBeVisible();
  await card.getByTestId('gallery-open').click();
  await expect(ws.getByTestId('plots-type-metaprofile')).toHaveAttribute('aria-pressed', 'true');
  await expect(source).toContainText('3 selected');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect.poll(async () => (await json<string[]>(plot, 'data-sources'))?.length).toBe(3);
  expect(errors).toEqual([]);
});
