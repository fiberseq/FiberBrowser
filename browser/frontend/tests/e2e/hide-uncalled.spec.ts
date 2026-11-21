/**
 * Min footprints never shows reads the footprint caller skipped (no call tags), at any threshold:
 * 0 means every called read. Its last choice, "All reads, including uncalled", shows them too.
 * The read track says how many it hid, by reason; choosing the last option adds exactly the
 * uncalled ones to the view.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000), which has 3 reads without calls there.
 */
import { test, expect, DEMO_FIXTURE } from './fixtures/server';
import type { Page, Response } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

const REGION = DEMO_FIXTURE.region;
const UNCALLED = [
  'm84046_240619_124816_s1/75828945/ccs',
  'm84046_240619_124816_s1/61543075/ccs',
  'm84046_240619_124816_s1/81592502/ccs',
];

type ReadsPayload = {
  reads: { id: string }[];
  total_in_scope?: number;
  working_count?: number;
  signal_counts?: { uncalled?: number; uncalled_hidden?: number; min_footprints_hidden?: number };
};

const readsResponse = (page: Page, match: (url: URL) => boolean) => page.waitForResponse((res: Response) => {
  const url = new URL(res.url());
  return url.pathname === '/api/reads/compact' && url.searchParams.get('chrom') === REGION.chrom
    && res.status() === 200 && match(url);
}, { timeout: 90_000 });

const inScope = (p: ReadsPayload) => p.total_in_scope ?? p.working_count ?? p.reads.length;
const idle = (page: Page) => expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);

test('uncalled reads are hidden at every Min footprints; "All reads, including uncalled" shows exactly those', async ({ server, page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');

  // Default Min footprints (5): uncalled and few-footprint reads hidden, said by reason.
  const first = readsResponse(page, url => url.searchParams.get('hide_uncalled') === 'true' && url.searchParams.get('min_footprints') === '5');
  await page.evaluate((r: typeof REGION) => {
    (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end);
  }, REGION);
  const byDefault = await (await first).json() as ReadsPayload;
  const count = byDefault.signal_counts?.uncalled_hidden ?? 0;
  expect(count).toBe(UNCALLED.length);
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible();
  await idle(page);
  const status = page.getByTestId('panel-read-status').first();
  await expect(status).toContainText(`${count} uncalled`, { timeout: 30_000 });

  // Min footprints in Read filters (found with the settings search).
  await page.getByTestId('settings-rail-file').click();
  await page.getByTestId('settings-search-input').fill('min footprints');
  const control = page.getByTestId('settings-sidebar').locator('[data-setting-id="view.min-footprints"]');
  await expect(control).toBeVisible();

  // 0: every called read; the uncalled ones stay hidden.
  const zero = readsResponse(page, url => url.searchParams.get('hide_uncalled') === 'true' && !url.searchParams.has('min_footprints'));
  await control.getByTestId('min-footprints-input').fill('0');
  const before = await (await zero).json() as ReadsPayload;
  expect(before.signal_counts?.uncalled_hidden).toBe(count);
  const ids = new Set(before.reads.map(r => r.id));
  for (const id of UNCALLED) expect(ids.has(id)).toBe(false);
  await idle(page);
  await expect(status).toContainText(`${count} uncalled hidden`, { timeout: 30_000 });

  // The last choice: all reads, including uncalled.
  const all = readsResponse(page, url => url.searchParams.get('hide_uncalled') === 'false');
  const choice = control.getByTestId('min-footprints-all-reads');
  await expect(choice).toHaveText('All reads, including uncalled');
  const box = choice.locator('input[type="checkbox"]');
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
  expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().minFootprints)).toBe(-1);
  const after = await (await all).json() as ReadsPayload;
  expect(after.signal_counts?.uncalled_hidden ?? 0).toBe(0);
  expect(inScope(after) - inScope(before)).toBe(count);
  await idle(page);
  await expect(status).not.toContainText('uncalled', { timeout: 30_000 });
});

test('the paths that read BAM records themselves follow the rule; signal filters stay hidden without bg/me tags', async ({ server, page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => (window as any).__FIBERBROWSER_STORE__?.getState().datasets.length > 0);
  const dataset = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().datasets[0]);
  // The demo BAM carries no signal tags: the dataset says so and no signal filter is offered.
  expect(dataset.signal_tags).toBe(false);
  const view = { chrom: REGION.chrom, start: String(REGION.start), end: String(REGION.end), dataset_id: dataset.id };
  const json = async (path: string, params: Record<string, string>) => {
    const res = await page.request.get(`${server.baseUrl}${path}?${new URLSearchParams(params)}`);
    expect(res.ok(), `${path} ${res.status()}`).toBe(true);
    return res.json();
  };
  // Dense loader (/api/reads/info): the uncalled reads only with hide_uncalled=false.
  const hidden = (await json('/api/reads/info', view)).count;
  const shown = (await json('/api/reads/info', { ...view, hide_uncalled: 'false' })).count;
  expect(shown - hidden).toBe(UNCALLED.length);
  // Region detection answers under both settings.
  for (const hide of [undefined, 'false']) {
    const regions = await json('/api/reads/regions', { ...view, min_reads: '1', ...(hide ? { hide_uncalled: hide } : {}) });
    expect(regions.success).not.toBe(false);
  }
  // The Read Filters section lists no signal filters.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: 'view', subsectionId: 'view.advanced' } })));
  await expect(page.locator('[data-setting-id="view.min-footprints"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('signal-filters')).toHaveCount(0);
  await expect(page.getByTestId('signal-hide-background')).toHaveCount(0);
});
