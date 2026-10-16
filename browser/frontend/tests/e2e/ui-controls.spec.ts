/**
 * UI controls tests: click the actual browser controls and assert frontend
 * state changes. These complement API-heavy workflow tests and guard against
 * regressions where the backend works but the user-facing controls disconnect.
 */
import { test, expect } from './fixtures/server';
import type { ServerFixture } from './fixtures/server';

async function gotoFresh(page: any, url: string) {
  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.goto(url);
  await page.waitForLoadState('networkidle');
}

async function hasNucReads(request: any, baseUrl: string, region: { chrom: string; start: number; end: number }): Promise<boolean> {
  const res = await request.get(
    `${baseUrl}/api/reads/compact?chrom=${region.chrom}&start=${region.start}&end=${region.end}&dataset_id=primary`
  );
  if (!res.ok()) return false;
  const data = await res.json();
  return (data.reads ?? []).length > 0 && (data.available_layers ?? []).includes('nuc');
}

async function findLayerRegion(request: any, server: ServerFixture): Promise<{ chrom: string; start: number; end: number }> {
  const baseUrl = server.baseUrl;
  if (server.defaultRegion && await hasNucReads(request, baseUrl, server.defaultRegion)) return server.defaultRegion;
  const chromsRes = await request.get(`${baseUrl}/api/chroms`);
  const { chroms } = await chromsRes.json();
  for (const chrom of chroms.slice(0, 20)) {
    const res = await request.get(
      `${baseUrl}/api/reads/compact?chrom=${chrom.name}&start=0&end=500000&dataset_id=primary`
    );
    if (!res.ok()) continue;
    const data = await res.json();
    if ((data.reads ?? []).length > 0 && (data.available_layers ?? []).includes('nuc')) {
      return { chrom: chrom.name, start: 0, end: 500000 };
    }
  }
  throw new Error('No region with nuc-layer reads found for UI layer-toggle test');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('read display toolbar toggles fit/all, sample count, row height, and reset', async ({ server, page }) => {
  await gotoFresh(page, server.baseUrl);

  await expect(page.getByTestId('operations-toolbar')).toBeVisible();
  await page.getByTestId('toolbar-group-toggle-reads').click();
  const fit = page.getByTestId('read-display-fit');
  const all = page.getByTestId('read-display-all');
  const sampleCount = page.getByTestId('read-display-sample-count');
  // Row height is a -/+ stepper showing "<n>px" in the Reads group summary (the
  // numeric <input> it replaced is no longer rendered anywhere).
  const rowHeight = page.getByTestId('read-display-row-height-compact');
  const rowHeightState = () => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().readRowHeight);

  await expect(fit).toHaveAttribute('aria-pressed', 'true');
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(sampleCount).toHaveAttribute('placeholder', 'auto');
  await expect(rowHeight).toContainText('1px');

  await all.click();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(sampleCount).toBeDisabled();
  await expect(sampleCount).toHaveAttribute('placeholder', 'all');

  await fit.click();
  await expect(fit).toHaveAttribute('aria-pressed', 'true');
  await expect(sampleCount).toBeEnabled();
  await sampleCount.fill('750');
  await expect(sampleCount).toHaveValue('750');

  const increase = rowHeight.getByRole('button', { name: 'Increase read row height' });
  for (let i = 0; i < 3; i += 1) await increase.click();
  await expect(rowHeight).toContainText('4px');
  expect(await rowHeightState()).toBe(4);
  await rowHeight.getByRole('button', { name: 'Decrease read row height' }).click();
  await expect(rowHeight).toContainText('3px');

  await page.getByTestId('read-display-reset').click();
  await expect(fit).toHaveAttribute('aria-pressed', 'true');
  await expect(sampleCount).toHaveValue('');
  await expect(sampleCount).toHaveAttribute('placeholder', 'auto');
  await expect(rowHeight).toContainText('1px');
  expect(await rowHeightState()).toBe(1);
});

test('settings pages: a rail icon opens its page, another switches, the same one closes, Cmd/Ctrl+B reopens', async ({ server, page }) => {
  await gotoFresh(page, server.baseUrl);
  const sidebar = page.getByTestId('settings-sidebar');
  const title = page.getByTestId('settings-sidebar-title');
  const icon = (id: string) => page.getByTestId(`settings-rail-${id}`);
  const pressed = () => page.locator('[data-testid^="settings-rail-"][aria-pressed="true"]');

  await expect(sidebar).toHaveCount(0);
  await expect(pressed()).toHaveCount(0);
  await icon('view').click();
  await expect(sidebar).toBeVisible();
  await expect(title).toHaveText('Reads & Display');
  await expect(sidebar.locator('[data-sidebar-section]')).toHaveCount(1);
  await expect(icon('view')).toHaveAttribute('aria-pressed', 'true');
  await expect(pressed()).toHaveCount(1);

  // Another icon switches the page.
  await icon('analysis').click();
  await expect(title).toHaveText('Analysis & Reproducibility');
  await expect(sidebar.locator('[data-sidebar-section="analysis"]')).toBeVisible();
  await expect(sidebar.locator('[data-sidebar-section="view"]')).toHaveCount(0);
  await expect(icon('view')).toHaveAttribute('aria-pressed', 'false');

  // The page's own icon closes; nothing is marked while closed.
  await icon('analysis').click();
  await expect(sidebar).toHaveCount(0);
  await expect(pressed()).toHaveCount(0);

  // Cmd/Ctrl+B reopens on the last page; the X closes and the focus goes to its icon.
  await page.keyboard.press('ControlOrMeta+b');
  await expect(title).toHaveText('Analysis & Reproducibility');
  await page.getByTestId('settings-sidebar-collapse').click();
  await expect(sidebar).toHaveCount(0);
  await expect(icon('analysis')).toBeFocused();

  // The settings search covers every page; clearing it returns to the page.
  await icon('genome').click();
  await page.getByTestId('settings-search-input').fill('terminal gaps');
  await expect(sidebar.locator('[data-sidebar-section="view"]')).toBeVisible();
  await expect(sidebar.locator('[data-sidebar-section="genome"]')).toHaveCount(0);
  await page.getByTestId('settings-search-input').fill('');
  await expect(title).toHaveText('Reference & Tracks');
});

test('location search and navigation buttons update the real viewport controls', async ({ server, page, request }) => {
  await gotoFresh(page, server.baseUrl);

  const input = page.getByTestId('location-search-input');
  await expect(input).toBeVisible();
  const initialValue = String(await input.inputValue());
  const chromName = initialValue.split(':')[0];
  expect(chromName.length).toBeGreaterThan(0);

  await input.fill(`${chromName}:1000-11000`);
  await page.getByTestId('location-search-submit').click();
  await expect(input).toHaveValue(`${chromName}:1,000-11,000`);
  await expect(input).not.toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(input).not.toHaveValue(`${chromName}:1,000-11,000`);

  await input.fill(`${chromName}:1000-11000`);
  await input.press('Enter');
  await expect(input).not.toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(input).not.toHaveValue(`${chromName}:1,000-11,000`);

  const beforePan = await input.inputValue();
  await page.getByTestId('pan-right-button').click();
  await expect(input).not.toHaveValue(beforePan);

  await page.getByTestId('zoom-in-button').click();
  await expect(input).toHaveValue(new RegExp(`^${escapeRegex(chromName)}:`));
});

test('layer toggles use user-facing layer names and remain clickable', async ({ server, page, request }) => {
  const region = await findLayerRegion(request, server);
  await gotoFresh(page, `${server.baseUrl}/?chrom=${region.chrom}&start=${region.start}&end=${region.end}`);

  // Layers starts open.
  await expect(page.getByTestId('toolbar-group-toggle-layers')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('layer-toggle-group')).toBeVisible();
  await expect(page.getByTestId('layer-checkbox-nuc')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('layer-checkbox-msp')).toHaveCount(0);

  const nuc = page.getByTestId('layer-checkbox-nuc');
  const initialNuc = await nuc.isChecked();
  await nuc.setChecked(!initialNuc);
  await expect(nuc).toBeChecked({ checked: !initialNuc });
  await nuc.setChecked(initialNuc);
  await expect(nuc).toBeChecked({ checked: initialNuc });

  const fire = page.getByTestId('layer-checkbox-fire');
  if (await fire.count()) {
    const initialFire = await fire.isChecked();
    await fire.setChecked(!initialFire);
    await expect(fire).toBeChecked({ checked: !initialFire });
    await fire.setChecked(initialFire);
    await expect(fire).toBeChecked({ checked: initialFire });
  }
});

// H4 (UI audit): the default "Min footprints: 5" hid all 4,873 reads of a
// short-read DAF dataset, the panel only said "No reads in this view", and
// "Go to reads" looped back to the same empty view. A filter that hides every
// read in view now says so, with a one-click way to show them.
test('a read filter that hides every read in view says so and shows them on one click', async ({ server, page, request }) => {
  const region = await findLayerRegion(request, server);
  await gotoFresh(page, server.baseUrl);
  await page.evaluate(r => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, Math.min(r.end, r.start + 10_000)), region);
  const firstTrack = page.locator('[data-read-track-dataset-id]').first();
  const rendered = async () => Number((await firstTrack.getAttribute('data-read-track-render-count')) ?? 0);
  await expect.poll(rendered, { timeout: 60_000, intervals: [250] }).toBeGreaterThan(0);

  // A Min footprints no read reaches, as set in Reads & Display → Read Filters.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setMinFootprints(100000));
  const card = page.locator('[data-testid^="min-footprints-hidden-"]').first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText(/hidden by Min footprints ≥ 100000/);
  await expect(page.getByText('No reads in this view')).toHaveCount(0);

  await card.getByRole('button', { name: 'Show all reads' }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().minFootprints)).toBe(0);
  await expect.poll(rendered, { timeout: 60_000, intervals: [250] }).toBeGreaterThan(0);
});

// fb-n10: a view wider than "Show reads up to" fetches no reads and draws coverage; the panel said
// "No reads in this view" over ~24k reads (the owner's numb locus). It now says the view is past
// the read limit, how many reads are there, and zooms in or raises the limit on one click.
test('a view past the read limit says so, counts its reads, and zooms in or loads them on one click', async ({ server, page, request }) => {
  const region = await findLayerRegion(request, server);
  await gotoFresh(page, server.baseUrl);
  const centre = Math.round((region.start + region.end) / 2);
  const wide = { chrom: region.chrom, start: Math.max(0, centre - 75_000), end: Math.max(0, centre - 75_000) + 150_000 };
  await page.evaluate(r => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.setMaxRegionForReads(100_000);
    s.setViewport(r.chrom, r.start, r.end);
  }, wide);
  const card = page.locator('[data-testid^="read-track-zoomed-out-"]').first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  // One slim line under the coverage (fb-n11-tracks); the full sentence is its tooltip.
  await expect(card).toContainText('this 150 kb view is past the 100 kb read limit');
  await expect(card.locator('[data-testid^="read-track-zoomed-out-text-"]')).toHaveAttribute('title', /Zoomed out past the read limit \(100 kb\): this view is 150 kb\./);
  // It sits along the bottom, under the plot: the coverage above it is not covered.
  const cardBox = (await card.boundingBox())!;
  const readsBox = (await page.locator('canvas[data-copilot-track="reads"]').first().boundingBox())!;
  expect(cardBox.height).toBeLessThanOrEqual(30);
  expect(cardBox.y).toBeGreaterThan(readsBox.y + readsBox.height - 40);
  await expect(card).toContainText(/\d[\d,]* reads? here/, { timeout: 60_000 });
  await expect(page.getByText('No reads in this view')).toHaveCount(0);

  await card.getByRole('button', { name: 'Zoom to 100 kb here' }).click();
  const view = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return { start: s.start, end: s.end };
  });
  expect(view.end - view.start).toBe(100_000);
  expect(Math.abs((view.start + view.end) / 2 - (wide.start + wide.end) / 2)).toBeLessThanOrEqual(1);
  await expect(page.locator('[data-testid^="read-track-zoomed-out-"]')).toHaveCount(0);

  await page.evaluate(r => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end), wide);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole('button', { name: 'Load reads (limit 200 kb)' }).click();
  expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().maxRegionForReads)).toBe(200_000);
  await expect(page.locator('[data-testid^="read-track-zoomed-out-"]')).toHaveCount(0);
});
