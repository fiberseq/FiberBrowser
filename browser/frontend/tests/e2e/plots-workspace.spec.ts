/**
 * The Plots workspace, end to end: P opens it over the reads; build a size enrichment plot; pan the browser and the
 * Follow plot says "Updating…" then recomputes for the new locus; Pin it and it stays (no new request) while the
 * browser moves on; the plot has one working card (Current), nothing in the Gallery until Keep; name and Keep it;
 * save the session, restore it, and the Gallery comes back; Open goes back to where the plot was made and draws it
 * from its stored data; Re-run makes a new plot on the current view (no new Gallery card); the strip's box edge zooms;
 * H opens the Feature hub full window (experimental flag on). Settings changes and pans never add Gallery cards.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000).
 */
import { readFileSync } from 'node:fs';
import { test, expect, DEMO_FIXTURE } from './fixtures/server';
import type { Page, Request } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

const REGION = DEMO_FIXTURE.region;

async function openDemo(page: Page, baseUrl: string, hubWorkspace = true) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
  });
  // The full-window hub is experimental (off by default): the main test turns it on; the last test checks it off.
  if (hubWorkspace) await page.addInitScript(() => { localStorage.setItem('fiberbrowser_experimental_hub_workspace', 'true'); });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate((r: typeof REGION) => {
    (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end);
  }, REGION);
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible();
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
}

const isSizes = (r: Request) => r.url().includes('/api/cluster/vplot') && r.method() === 'POST';
const sizesBody = (r: Request) => JSON.parse(r.postData() || '{}') as Record<string, unknown>;
/** The window a size request asks for (query parameters). */
const sizesStart = (r: Request) => Number(new URL(r.url()).searchParams.get('region_start'));
const locusText = (chrom: string, start: number, end: number) => `${chrom}:${(start + 1).toLocaleString('en-US')}–${end.toLocaleString('en-US')}`;
const viewport = (page: Page) => page.evaluate(() => {
  const s = (window as any).__FIBERBROWSER_STORE__.getState();
  return { chrom: s.chrom as string, start: Math.round(s.start) as number, end: Math.round(s.end) as number };
});

test('P → build a size plot → pan, it follows → pin, it stays → save and restore the session', async ({ server, page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openDemo(page, server.baseUrl);

  // P opens Plots over the reads (the reads stay mounted underneath).
  await page.keyboard.press('p');
  const ws = page.getByTestId('plots-workspace');
  await expect(ws).toBeVisible();
  await expect(page.locator('[data-browser-root]')).toHaveAttribute('data-workspace', 'plots');
  await expect(page.getByTestId('workspace-plots')).toHaveAttribute('aria-pressed', 'true');

  // Build: Size enrichment · All footprints · current view · by dataset (the defaults, chosen explicitly).
  const first = page.waitForRequest(r => isSizes(r) && sizesBody(r).group_by === 'all', { timeout: 90_000 });
  await ws.getByTestId('plots-type-vplot').click();
  await ws.getByTestId('plots-type-size-enrichment').click();
  await ws.getByTestId('plots-source-all_footprints').click();
  await ws.getByTestId('plots-group-dataset').click();
  // Compare is a main choice next to Group by; Where and Display sit under More options.
  await expect(ws.getByTestId('plots-compare-off')).toBeVisible();
  await expect(ws.getByTestId('plots-where-view')).toHaveCount(0);
  await ws.getByTestId('plots-more-options').click();
  await ws.getByTestId('plots-where-view').click();
  await expect(ws.getByTestId('plots-type-nuc-spacing')).toBeDisabled();
  // Differential features is its own type (Compare keeps A − B and log2 ratio).
  await expect(ws.getByTestId('plots-type-differential')).toBeEnabled();
  expect(sizesBody(await first)).toMatchObject({ group_by: 'all', layer: 'all_footprints', mode: 'span', normalization: 'row' });
  const plot = ws.getByTestId('plots-size-plot');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(plot.getByTestId('plots-size-panel')).toHaveCount(1);
  // One dataset drawn: Compare's A − B is disabled and says why.
  await expect(ws.getByTestId('plots-compare-diff')).toBeDisabled();
  await expect(ws.getByTestId('plots-compare-diff')).toHaveAttribute('title', /one dataset/);
  const v0 = await viewport(page);
  await expect(plot).toHaveAttribute('data-computed-for', locusText(v0.chrom, v0.start, v0.end));
  await expect(ws.getByTestId('plots-title-text')).toHaveText('Size enrichment · All footprints · current view · by dataset');
  await page.screenshot({ path: info.outputPath('1-plot.png') });

  // The Follow delay is a parameter: 2 s here, so "Updating…" is seen before the recompute.
  await ws.getByTestId('plots-follow-delay').fill('2000');
  await ws.getByTestId('plots-follow-delay').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().plotsWorkspace.followDelayMs)).toBe(2000);
  // Keys never act while typing: leave the field before using the arrow keys.
  await ws.getByTestId('plots-caption').click();

  // Pan the browser (→ in Plots): the plot says Updating… at once, then recomputes for the new locus.
  const followed = page.waitForRequest(r => isSizes(r) && sizesStart(r) > v0.start, { timeout: 90_000 });
  await page.keyboard.press('ArrowRight');
  await expect(plot).toHaveAttribute('data-state', 'updating');
  await expect(plot.getByTestId('plots-count').first()).toContainText('— reads');
  const v1 = await viewport(page);
  expect(v1.start).toBeGreaterThan(v0.start);
  await expect(ws.getByTestId('plots-updating')).toContainText(locusText(v1.chrom, v1.start, v1.end));
  expect(sizesStart(await followed)).toBe(v1.start);
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(plot).toHaveAttribute('data-computed-for', locusText(v1.chrom, v1.start, v1.end));

  // Pin: the plot keeps v1 while the browser moves on, and asks for nothing new.
  await ws.getByTestId('plots-pin').click();
  await expect(ws.getByTestId('plots-card')).toHaveAttribute('data-follow', 'pin');
  const after: Request[] = [];
  const listen = (r: Request) => { if (isSizes(r)) after.push(r); };
  page.on('request', listen);
  await ws.getByTestId('plots-pan-right').click();
  await page.keyboard.press('ArrowRight');
  const v2 = await viewport(page);
  expect(v2.start).toBeGreaterThan(v1.start);
  await expect(ws.getByTestId('plots-locus')).toHaveText(locusText(v2.chrom, v2.start, v2.end));
  await page.waitForTimeout(4_000);  // well past the 2 s Follow delay
  page.off('request', listen);
  expect(after).toHaveLength(0);
  await expect(plot).toHaveAttribute('data-state', 'current');
  await expect(plot).toHaveAttribute('data-computed-for', locusText(v1.chrom, v1.start, v1.end));
  await page.screenshot({ path: info.outputPath('2-pinned.png') });

  // Nothing is in the Gallery until kept: one working card (Current) followed the settings and pans.
  await ws.getByTestId('plots-tab-gallery').click();
  await expect(ws.getByTestId('gallery-grid').getByTestId('gallery-card')).toHaveCount(0);
  await expect(ws.getByTestId('gallery-current').getByTestId('gallery-card')).toHaveCount(1);
  await ws.getByTestId('plots-tab-plot').click();
  // Name the pinned plot and Keep it.
  await ws.getByTestId('plots-title').click();
  await ws.getByTestId('plots-name').fill('Demo sizes pinned');
  await ws.getByTestId('plots-name').press('Enter');
  await expect(ws.getByTestId('plots-title-text')).toHaveText('Demo sizes pinned');
  await ws.getByTestId('plots-keep').click();
  await expect(ws.getByTestId('plots-toast')).toContainText('Kept in the Gallery');
  await ws.getByTestId('plots-tab-gallery').click();
  const cards = ws.getByTestId('gallery-grid').getByTestId('gallery-card');
  // Keep added exactly one Gallery card.
  await expect(cards).toHaveCount(1);
  const kept = ws.getByTestId('gallery-grid').locator('[data-testid="gallery-card"][data-status="kept"]');
  await expect(kept).toHaveCount(1);
  await expect(kept.getByTestId('gallery-name')).toHaveText('Demo sizes pinned');
  await expect(kept).toContainText(locusText(v1.chrom, v1.start, v1.end));

  // Esc goes back to the browser with its reads; save the session from the top bar.
  await page.keyboard.press('Escape');
  await expect(ws).toHaveCount(0);
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const sessionPath = info.outputPath('plots-session.json');
  await (await download).saveAs(sessionPath);
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  expect(session.frontend.plotsWorkspace.followDelayMs).toBe(2000);
  const gallery = session.frontend.plotsGallery;
  expect(gallery.version).toBe(2);
  const starred = gallery.entries.filter((e: { status: string }) => e.status === 'kept');
  expect(starred).toHaveLength(1);
  expect(starred[0]).toMatchObject({ name: 'Demo sizes pinned', computedFor: { chrom: v1.chrom, start: v1.start, end: v1.end } });
  expect(starred[0].thumb).toMatch(/^data:image\/jpeg/);
  expect(gallery.states[starred[0].stateId]).toBeTruthy();

  // Forget the Gallery (a reload), then restore the session through Open (the file picker answered by the test).
  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).__FIBERBROWSER_STORE__?.getState().datasets.length));
  await page.route(/\/api\/pick_file(?:\?|$)/, route => route.fulfill({ json: { success: true, path: sessionPath, paths: [sessionPath] } }));
  const [imported] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/import' && r.request().method() === 'POST', { timeout: 60_000 }),
    page.getByTestId('load-file-button').click(),
  ]);
  expect(imported.ok()).toBe(true);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr19', 47500000, 47504000));

  // Open the kept plot: back to where it was made, drawn from its stored data.
  await page.keyboard.press('p');
  await expect(ws).toBeVisible();
  await ws.getByTestId('plots-tab-gallery').click();
  const restored = ws.getByTestId('gallery-grid').locator('[data-testid="gallery-card"][data-status="kept"]');
  await expect(restored.getByTestId('gallery-name')).toHaveText('Demo sizes pinned');
  await restored.getByTestId('gallery-open').click();
  await expect.poll(() => viewport(page)).toEqual(v1);
  await ws.getByTestId('plots-tab-plot').click();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 30_000 });
  await expect(plot).toHaveAttribute('data-computed-for', locusText(v1.chrom, v1.start, v1.end));
  await expect(plot).toHaveAttribute('data-seeded', 'true');
  await page.screenshot({ path: info.outputPath('3-restored.png') });

  // Re-run at current view: the card's settings on the current view, as a new plot (its own working card, no Gallery card), shown on the Plot tab.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr19', 47515500, 47517500));
  await ws.getByTestId('plots-tab-gallery').click();
  const before = await cards.count();
  await ws.getByTestId('gallery-grid').locator('[data-testid="gallery-card"][data-status="kept"]').getByTestId('gallery-remake').click();
  await expect(ws.getByTestId('plots-tab-plot')).toHaveAttribute('aria-selected', 'true');
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  await expect(plot).toHaveAttribute('data-computed-for', locusText('chr19', 47515500, 47517500));
  await ws.getByTestId('plots-tab-gallery').click();
  await expect(cards).toHaveCount(before);
  await expect(ws.getByTestId('gallery-current').getByTestId('gallery-card')).toHaveCount(1);
  await expect(ws.getByTestId('gallery-current').getByTestId('gallery-card')).toContainText(locusText('chr19', 47515500, 47517500));
  await ws.getByTestId('plots-tab-plot').click();

  // The strip's view box: drag its right edge to zoom out (the left edge stays).
  const v3 = await viewport(page);
  const handle = ws.getByTestId('plots-mini-strip-right');
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 120, hb.y + hb.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => viewport(page).then(v => [v.start, v.end > v3.end])).toEqual([v3.start, true]);

  // H: the Feature hub full window, in the same shell; Esc back to the browser.
  await page.keyboard.press('h');
  const hub = page.getByTestId('hub-workspace');
  await expect(hub).toBeVisible();
  await expect(hub.getByTestId('hub-panel')).toBeVisible();
  await expect(hub.getByTestId('hub-band')).toHaveAttribute('data-tone', 'hub');
  await page.keyboard.press('Escape');
  await expect(hub).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the full-window Feature hub is hidden by default: no Hub toggle, no H, no ⌘K entry; the docked panel works as before', async ({ server, page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openDemo(page, server.baseUrl, false);
  await expect(page.getByTestId('workspace-toggle')).toBeVisible();
  await expect(page.getByTestId('workspace-plots')).toBeVisible();
  await expect(page.getByTestId('workspace-hub')).toHaveCount(0);
  await page.keyboard.press('h');
  await page.waitForTimeout(300);
  await expect(page.locator('[data-browser-root]')).toHaveAttribute('data-workspace', 'browser');
  await expect(page.getByTestId('hub-workspace')).toHaveCount(0);
  // ⌘K: no hub workspace entry.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.getByTestId('command-palette-input').fill('Open Feature hub');
  await page.waitForTimeout(400);
  await expect(palette.getByText('Open Feature hub', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The docked Feature hub panel (as before the Plots work): opens beside the reads, no "Open in Hub".
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().openAnalysisPanel('feature-hub'));
  await expect(page.getByTestId('hub-panel')).toBeVisible();
  await expect(page.getByTestId('hub-open-full-window')).toHaveCount(0);
  // Differential features waits for the hub: not offered in Plots.
  await page.keyboard.press('p');
  await expect(page.getByTestId('plots-workspace')).toBeVisible();
  await expect(page.getByTestId('plots-type-metaprofile')).toBeVisible();
  await expect(page.getByTestId('plots-type-differential')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('explicit keeping: 10 settings changes plus pans leave 0 Gallery cards and 1 working card; Keep adds exactly 1', async ({ server, page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openDemo(page, server.baseUrl, false);
  await page.keyboard.press('p');
  const ws = page.getByTestId('plots-workspace');
  await expect(ws).toBeVisible();
  await ws.getByTestId('plots-follow-delay').fill('0');
  await ws.getByTestId('plots-follow-delay').press('Enter');
  const plot = ws.getByTestId('plots-size-plot');
  await ws.getByTestId('plots-type-size-enrichment').click();
  await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
  // Ten settings changes (type and grouping back and forth), each drawn, and pans between them.
  const steps = ['plots-type-vplot', 'plots-type-size-enrichment', 'plots-group-none', 'plots-group-dataset', 'plots-type-vplot',
    'plots-group-none', 'plots-type-size-enrichment', 'plots-group-dataset', 'plots-type-vplot', 'plots-type-size-enrichment'];
  for (const [i, id] of steps.entries()) {
    await ws.getByTestId(id).click();
    await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
    if (i % 3 === 0) {
      await ws.getByTestId('plots-caption').click();
      await page.keyboard.press('ArrowRight');
      await expect(plot).toHaveAttribute('data-state', 'current', { timeout: 90_000 });
    }
  }
  await ws.getByTestId('plots-tab-gallery').click();
  await expect(ws.getByTestId('gallery-grid').getByTestId('gallery-card')).toHaveCount(0);
  await expect(ws.getByTestId('gallery-current').getByTestId('gallery-card')).toHaveCount(1);
  await expect(ws.getByTestId('gallery-empty')).toBeVisible();
  await expect(ws.getByTestId('plots-tab-gallery')).toHaveText('Gallery (0)');
  await ws.getByTestId('plots-tab-plot').click();
  await ws.getByTestId('plots-keep').click();
  await expect(ws.getByTestId('plots-keep')).toHaveAttribute('aria-pressed', 'true');
  await expect(ws.getByTestId('plots-tab-gallery')).toHaveText('Gallery (1)');
  // Keep again on the same plot does nothing more.
  await ws.getByTestId('plots-keep').click();
  await ws.getByTestId('plots-tab-gallery').click();
  await expect(ws.getByTestId('gallery-grid').getByTestId('gallery-card')).toHaveCount(1);
  await expect(ws.getByTestId('gallery-current').getByTestId('gallery-card')).toHaveCount(1);
  expect(errors).toEqual([]);
});
