/**
 * Quantify a window, the owner's steps (fix/window-quant-ux), on the tracked NAPA demo BAM with two genes in view
 * (answered here: the demo reference has no annotation):
 *
 *   click the metaprofile row → nothing moves or reloads → Select window → drag → the band and a small bar with the
 *   window's start / end and Quantify → x-axis: relative, from the TSS of a chosen gene (the picker lists the genes in
 *   view) → type −100..200 → Quantify → bars → the same window typed in genome bp gives the same numbers.
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
import type { ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const SHOTS = process.env.FIBERBROWSER_E2E_SHOTS;
// GMINUS's TSS is its last base (end − 1 = 47,516,499); GPLUS's its first (47,515,400). GMINUS is nearer the centre.
const GENES = [
  { id: 'GPLUS', name: 'GPLUS', chrom: 'chr19', start: 47_515_400, end: 47_530_000, strand: '+', biotype: 'protein_coding', exons: [] },
  { id: 'GMINUS', name: 'GMINUS', chrom: 'chr19', start: 47_500_000, end: 47_516_500, strand: '-', biotype: 'protein_coding', exons: [] },
];

const getState = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function openAt(page: Page, server: ServerFixture) {
  await page.route('**/api/genes**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ genes: GENES }) }));
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
  await expect.poll(() => getState(page, s => s.genes.length), { timeout: 20_000 }).toBe(2);
  await page.waitForTimeout(1500);
}

const shown = async (page: Page) => JSON.parse((await page.getByTestId('quant-host-card').getByTestId('quant-chart').getAttribute('data-values'))!) as Array<number | null>;

test('the owner\'s steps: click (no reload), Select window, drag, gene anchor, −100..200, Quantify = the genome-bp window', async ({ server, page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openAt(page, server);
  const view0 = await getState(page, s => [s.start, s.end] as [number, number]);
  const canvas = page.locator('[data-testid^="composite-track-canvas-__default_metaprofile__"]').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const box = (await canvas.boundingBox())!;

  // 1. A click on the metaprofile (and a 1 px wobble) moves nothing and asks for no new view.
  const viewRequests: string[] = [];
  page.on('request', q => { const u = q.url(); if (u.includes('/api/reads/compact') && !u.includes('prefetch=true')) viewRequests.push(u); });
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3 + 1, box.y + box.height * 0.6);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  expect(await getState(page, s => [s.start, s.end])).toEqual(view0);
  expect(viewRequests).toEqual([]);

  // 2. Select window: the hint shows; a drag sets the window and never zooms; the mode ends with the drag.
  const tools = page.getByTestId('quant-track-tools').first();
  await expect(tools.getByTestId('quant-track-select')).toHaveText('▭ Select window');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/after_track_tools.png`, clip: { x: 0, y: Math.max(0, box.y - 110), width: 1600, height: box.height + 160 } });
  await tools.getByTestId('quant-track-select').click();
  await expect(page.getByTestId('quant-track-select-hint').first()).toHaveText('Drag across the profile to set a window · Esc to stop');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/after_selecting_hint.png`, clip: { x: 0, y: Math.max(0, box.y - 110), width: 1600, height: box.height + 160 } });
  // Esc leaves the mode; the toggle enters it again.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quant-track-select-hint')).toHaveCount(0);
  await tools.getByTestId('quant-track-select').click();
  const cap = page.getByTestId('quant-track-band-capture').first();
  const cb = (await cap.boundingBox())!;
  await page.mouse.move(cb.x + cb.width * 0.35, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width * 0.55, cb.y + cb.height / 2, { steps: 8 });
  await page.mouse.up();
  const dragged = await getState(page, s => s.windowQuant.window);
  expect(dragged.relative).toBeFalsy();
  expect(dragged.to - dragged.from).toBeGreaterThan(500);
  expect(await getState(page, s => [s.start, s.end])).toEqual(view0);
  expect(await getState(page, s => s.quantSelecting)).toBe(false);
  const bar = page.getByTestId('quant-track-window-bar').first();
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('quant-track-open')).toHaveText('Quantify window');
  await expect(page.getByTestId('quant-track-band-shade').first()).toBeVisible();

  // 3. The x-axis: relative, from the TSS; the picker lists the genes in view (nearest first); choose GMINUS.
  await tools.getByTestId('quant-track-axis-chip').click();
  const pop = page.getByTestId('quant-track-axis-popover').first();
  await pop.getByTestId('quant-track-axis-frame-relative').click();
  const genePick = pop.getByTestId('quant-track-axis-frame-gene');
  await expect(genePick).toBeVisible();
  const options = await genePick.locator('option').allTextContents();
  expect(options[0]).toBe('nearest gene: GMINUS');
  expect(options).toContain('GMINUS (−) · TSS 47,516,499');
  expect(options).toContain('GPLUS (+) · TSS 47,515,400');
  await genePick.selectOption('GMINUS');
  await expect(pop.getByTestId('quant-track-axis-frame-label')).toHaveText('Distance from the TSS of GMINUS (bp, gene on − strand)');
  await expect(pop.getByTestId('quant-track-axis-frame-flip')).toBeVisible();
  await expect(tools.getByTestId('quant-track-axis-chip')).toContainText('x: TSS of GMINUS');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/after_gene_picker.png`, clip: { x: 600, y: Math.max(0, box.y - 20), width: 1000, height: 260 } });
  await pop.getByRole('button', { name: 'Done' }).click();
  // The relative ticks: 0 at the TSS, a whole step.
  const ticks = JSON.parse((await page.getByTestId('quant-track-axis').first().getAttribute('data-ticks'))!) as Array<[number, string]>;
  expect(ticks.map(t => t[1])).toContain('0');

  // 4. Type −100..200 (bp from the TSS) in the row's bar: stored relative.
  await bar.getByTestId('quant-window-from').fill('-100');
  await bar.getByTestId('quant-window-to').fill('200');
  await bar.getByTestId('quant-window-to').press('Enter');
  await expect.poll(() => getState(page, s => s.windowQuant.window)).toEqual({ chrom: 'chr19', from: -100, to: 200, relative: true });
  await expect(bar.getByTestId('quant-window-text')).toHaveText('300 bp · −100 to +200 bp from the TSS of GMINUS');

  // 5. Quantify: non-empty bars.
  await bar.getByTestId('quant-track-open').click();
  const host = page.getByTestId('quant-host-card');
  await expect(host).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  // −100..+200 from a minus-strand TSS at 47,516,499 is genome 47,516,299–47,516,599.
  await expect(host.getByTestId('quant-measures')).toContainText('chr19:47,516,299–47,516,599 (300 bp), −100 to +200 bp from the TSS of GMINUS');
  const rel = await shown(page);
  expect(rel.length).toBeGreaterThan(0);
  expect(rel.some(v => v != null && v > 0)).toBe(true);
  if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/after_quantify_relative.png` }); }

  // 6. The same window in genome bp gives the same numbers.
  await page.getByTestId('quant-host').getByTestId('quant-host-axis-frame-genome').click();
  const fields = page.getByTestId('quant-host-window-bar');
  await fields.getByTestId('quant-window-from').fill('47516299');
  await fields.getByTestId('quant-window-to').fill('47516599');
  await fields.getByTestId('quant-window-to').press('Enter');
  await expect.poll(() => getState(page, s => s.windowQuant.window)).toEqual({ chrom: 'chr19', from: 47_516_299, to: 47_516_599 });
  await expect(host.getByTestId('quant-measures')).not.toContainText('from the TSS', { timeout: 30_000 });
  await expect(host).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  expect(await shown(page)).toEqual(rel);
  expect(errors).toEqual([]);
});
