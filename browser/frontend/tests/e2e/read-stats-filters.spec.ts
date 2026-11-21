/**
 * Read Stats applies the read track's filters (3.1.0): the duplicate and QC-fail toggles and the footprint-quality
 * gate go with its request, the colour-rule quality filters are applied to the calls it counts, and its summary
 * says which filter removed what. Real backend, the tracked NAPA demo BAM.
 */
import { test, expect, DEMO_FIXTURE } from './fixtures/server';
import type { Page, Request } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

const REGION = DEMO_FIXTURE.region;

const statsRequest = (page: Page, match: (body: any) => boolean) => page.waitForRequest((req: Request) => {
  if (!req.url().includes('/api/reads/stats') || req.method() !== 'POST') return false;
  try { return match(JSON.parse(req.postData() || '{}')); } catch { return false; }
}, { timeout: 90_000 });

test('Read Stats sends the read policy and shows what each filter removed', async ({ server, page }) => {
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
  await page.evaluate((r: typeof REGION) => {
    (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end);
  }, REGION);
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 90_000 });

  // Defaults: duplicates and QC-fail reads hidden, no footprint-quality gate.
  const first = statsRequest(page, b => b.include_duplicates === false && b.include_qcfail === false && b.min_fp_quality === 0);
  await page.getByTestId('panel-rail-read-stats').click();
  await first;
  // The demo region's uncalled reads are named under the filter that hid them.
  await expect(page.getByTestId('read-stats-hidden')).toContainText('Min footprints:', { timeout: 60_000 });

  // The toggles fetch again with the new policy, even though the reads shown stay the same here.
  const shown = statsRequest(page, b => b.include_duplicates === true && b.include_qcfail === true);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ showDuplicateReads: true, showQcFailReads: true }));
  const response = await (await shown).response();
  const body = await response!.json();
  expect(body.aggregate.include_duplicates).toBe(true);
  expect(body.aggregate.n_hidden_duplicate).toBe(0);

  // A quality filter on a dimension the nucleosome layer lacks removes those calls on the read track (fail
  // closed); Read Stats counts the same calls and says what the filter removed.
  const filtered = page.waitForResponse(async res => {
    if (!res.url().includes('/api/reads/stats') || res.status() !== 200) return false;
    const json = await res.json().catch(() => null);
    return Boolean(json?.aggregate?.quality_filters?.length);
  }, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setQualityFilters([
    { layer: 'nuc', qualityName: 'zq', minValue: 200, enabled: true }]));
  const filteredBody = await (await filtered).json();
  const [impact] = filteredBody.aggregate.quality_filters;
  expect(impact.label).toBe('zq ≥ 200 (nuc)');
  expect(impact.removed).toBe(impact.calls);
  await expect(page.getByTestId('read-stats-quality')).toContainText('Quality filters applied: zq ≥ 200 (nuc):', { timeout: 30_000 });
  await expect(page.getByTestId('read-stats-quality')).toContainText('calls removed');
});
