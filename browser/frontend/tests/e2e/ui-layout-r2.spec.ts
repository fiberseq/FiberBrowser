/**
 * Layout and toolbar fixes the owner asked for after testing 3.0 (1 Oct):
 * - datasets (and linked copies) open side by side, not stacked;
 * - side panels in the drawer all come back beside the reads together; a window too
 *   narrow for them scrolls the row sideways (usability round 1: no automatic drawer);
 * - Scan, Cluster, Sort and Filter each have their own colour;
 * - toolbar groups expand in the row and stay open (remembered) until folded.
 */
import { test, expect, panelButton } from './fixtures/server';
import { clickPanelAction } from './fixtures/panelActions';
import type { Page } from '@playwright/test';

async function openApp(page: Page, baseUrl: string, opts: { dark?: boolean; keepStorage?: boolean } = {}) {
  await page.addInitScript(({ dark, keepStorage }) => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!keepStorage && !sessionStorage.getItem('ui-layout-r2')) {
      localStorage.clear();
      sessionStorage.setItem('ui-layout-r2', '1');
      localStorage.setItem('fiberhmm_darkmode', String(Boolean(dark)));
    }
  }, { dark: Boolean(opts.dark), keepStorage: Boolean(opts.keepStorage) });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
}

const sidePanels = (page: Page) => page.evaluate(() => {
  const s = (window as any).__FIBERBROWSER_STORE__.getState();
  return s.panels.filter((p: any) => p.contentType !== 'dataset').map((p: any) => ({ type: p.contentType, pinned: p.dock === 'side' }));
});
const inDrawer = (page: Page) => page.locator('[data-testid="analysis-overlay"] [data-panel-content-type]');
const SIDE = ['cluster-detail', 'footprint-analysis'];

test('a linked copy opens side by side with its source', async ({ server, page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openApp(page, server.baseUrl);
  const headers = page.locator('[data-testid^="dataset-header-"]');
  await expect(headers).toHaveCount(1);
  await clickPanelAction(page, 'panel-add-copy');
  const panels = page.locator('[data-panel-id]');
  await expect(panels).toHaveCount(2);
  const [a, b] = [(await panels.nth(0).boundingBox())!, (await panels.nth(1).boundingBox())!];
  expect(Math.abs(a.y - b.y), 'same row').toBeLessThan(2);
  expect(b.x, 'beside it').toBeGreaterThan(a.x + 200);
});

test('side panels in the drawer all dock beside the reads together', async ({ server, page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1700, height: 900 });
  await openApp(page, server.baseUrl);
  for (const id of SIDE) await panelButton(page, id).click();
  // Pin both to the side: one drawer, two tabs.
  for (const id of SIDE) {
    if (!(await page.locator(`[data-testid="panel-dock-toggle-${id}"]:visible`).count())) {
      await page.getByTestId(`analysis-overlay-tab-${id}`).click();
    }
    await page.locator(`[data-testid="panel-dock-toggle-${id}"]:visible`).click();
  }
  await expect(page.getByTestId('analysis-overlay-tabs')).toBeVisible();
  expect(await sidePanels(page)).toEqual(SIDE.map(type => ({ type, pinned: true })));
  await page.screenshot({ path: testInfo.outputPath('drawer-two-tabs-pinned.png') });

  // Dock from the tab on show: both come out.
  const dock = page.locator('[data-testid="analysis-overlay"] [data-testid^="panel-dock-toggle-"]:visible');
  await expect(dock).toHaveAttribute('aria-label', 'Dock the side panels beside the reads');
  await dock.click();
  await expect(page.getByTestId('analysis-overlay')).toHaveCount(0);
  expect(await sidePanels(page)).toEqual(SIDE.map(type => ({ type, pinned: false })));
  for (const id of SIDE) await expect(page.locator(`[data-panel-content-type="${id}"]`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('drawer-docked-both.png') });
  // Undo puts both back in the drawer.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(inDrawer(page)).toHaveCount(2);

  // Full view of one and back: the drawer comes back with both.
  await page.locator('[data-testid="analysis-overlay"] [aria-label="Expand to full view"]:visible').click();
  await expect(page.getByTestId('analysis-overlay')).toHaveCount(0);
  await page.locator('[aria-label="Restore all panels"]:visible').click();
  await expect(inDrawer(page)).toHaveCount(2);
});

test('a window too narrow for the side panels: they stay beside the reads and the row scrolls (no drawer)', async ({ server, page }, testInfo) => {
  test.setTimeout(120_000);
  // Usability round 1 (docking policy): nothing goes to the drawer by itself any more. Three side panels at 1100 px
  // don't fit even at the docked minimums: every panel keeps its floor and the row scrolls sideways.
  const SIDE3 = [...SIDE, 'read-stats'];
  await page.setViewportSize({ width: 1100, height: 800 });
  await openApp(page, server.baseUrl);
  for (const id of SIDE3) await panelButton(page, id).click();
  await expect(page.getByTestId('analysis-overlay')).toHaveCount(0);
  expect(await sidePanels(page)).toEqual(SIDE3.map(type => ({ type, pinned: false })));
  const scroller = page.getByTestId('panel-row-scroll');
  await expect(scroller).toHaveCount(1);
  expect(await scroller.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  for (const id of SIDE3) {
    const panel = page.locator(`[data-panel-content-type="${id}"]`);
    expect((await panel.boundingBox())!.width).toBeGreaterThanOrEqual(320);
  }
  await scroller.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(page.locator(`[data-panel-content-type="${SIDE3[SIDE3.length - 1]}"]`)).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('narrow-row-scrolls.png') });

  await page.setViewportSize({ width: 2200, height: 900 });
  await expect(page.getByTestId('panel-row-scroll')).toHaveCount(0);
  for (const id of SIDE3) await expect(page.locator(`[data-panel-content-type="${id}"]`)).toBeVisible();
});

for (const dark of [false, true]) {
  test(`Scan, Cluster, Sort and Filter each have their own colour (${dark ? 'dark' : 'light'})`, async ({ server, page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    await openApp(page, server.baseUrl, { dark });
    const ids = ['peak-scan-button', 'cluster-run-button', 'sort-run-button', 'filter-run-button'];
    const tones = await page.evaluate((ids) => ids.map(id => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? getComputedStyle(el).getPropertyValue('--tone').trim() : null;
    }), ids);
    expect(tones.every(Boolean), `tones ${tones}`).toBe(true);
    expect(new Set(tones).size, `tones ${tones}`).toBe(4);
    // At rest (Sort is never blocked) the ink is the tone, not Scan's.
    const ink = await page.evaluate(() => ['peak-scan-button', 'sort-run-button']
      .map(id => getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!).color));
    expect(ink[0]).not.toBe(ink[1]);
    await page.getByTestId('operations-toolbar').screenshot({ path: testInfo.outputPath(`toolbar-colours-${dark ? 'dark' : 'light'}.png`) });
  });
}

test('a toolbar group opens in the row and stays open, across clicks elsewhere and reloads, until folded', async ({ server, page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1024, height: 700 });
  await openApp(page, server.baseUrl);
  await page.screenshot({ path: testInfo.outputPath('toolbar-1024-first-load.png') });
  // Layers starts open, its checkboxes in the row.
  await expect(page.getByTestId('toolbar-group-toggle-layers')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('toolbar-group-toggle-cluster').click();
  await expect(page.getByTestId('cluster-k-input')).toBeVisible();
  // Not a dropdown over the reads: in the toolbar.
  const toolbar = (await page.getByTestId('operations-toolbar').boundingBox())!;
  const k = (await page.getByTestId('cluster-k-input').boundingBox())!;
  expect(k.y + k.height).toBeLessThanOrEqual(toolbar.y + toolbar.height);
  // Clicking the reads and Escape leave it open.
  await page.locator('canvas[data-copilot-track="reads"]').first().click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cluster-k-input')).toBeVisible();
  await page.getByTestId('toolbar-group-toggle-sort').click();
  await page.getByTestId('toolbar-group-toggle-reads').click();
  await page.screenshot({ path: testInfo.outputPath('toolbar-1024-three-open.png') });
  // Remembered across a reload (and folding is remembered too).
  await page.getByTestId('toolbar-group-toggle-reads').click();
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('toolbar-group-toggle-cluster')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('toolbar-group-toggle-sort')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('toolbar-group-toggle-reads')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('cluster-k-input')).toBeVisible();
});
