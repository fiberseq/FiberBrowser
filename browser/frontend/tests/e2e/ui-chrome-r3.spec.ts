/**
 * Toolbar and drawer fixes from the owner's testing (1 Oct, round 3):
 * - "no matter how big the window is, pressing the dock button fails and says to widen":
 *   docking the drawer works at 1280, 1728 and 2560 with one to three side panels;
 * - opening a toolbar group (Cluster's K box, the Reads controls) never changes the
 *   toolbar's height, so the reads never move;
 * - each action button keeps its own colour, matched to its panel, even when it can't run;
 * - the drawer resizes from its edge (remembered, keyboard too) and a tab pops out as a
 *   side panel of its own (and goes back with Pin to the side).
 */
import { test, expect, panelButton } from './fixtures/server';
import { clickPanelAction } from './fixtures/panelActions';
import type { Page } from '@playwright/test';

async function openApp(page: Page, baseUrl: string, opts: { dark?: boolean } = {}) {
  await page.addInitScript(({ dark }) => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!sessionStorage.getItem('ui-chrome-r3')) {
      localStorage.clear();
      sessionStorage.setItem('ui-chrome-r3', '1');
      localStorage.setItem('fiberhmm_darkmode', String(Boolean(dark)));
    }
  }, { dark: Boolean(opts.dark) });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
}

const SIDE = ['cluster-detail', 'footprint-analysis', 'read-stats'];
const overlay = (page: Page) => page.getByTestId('analysis-overlay');
const inDrawer = (page: Page) => page.locator('[data-testid="analysis-overlay"] [data-panel-content-type]');
const drawerDock = (page: Page) => page.locator('[data-testid="analysis-overlay"] [data-testid^="panel-dock-toggle-"]:visible');

/** Open side panels; any that landed beside the reads are pinned, so all are in the drawer. */
async function sidePanelsInDrawer(page: Page, ids: string[]) {
  for (const id of ids) await panelButton(page, id).click();
  for (const id of ids) {
    const outside = page.locator(`[data-panel-content-type="${id}"]:not([data-testid="analysis-overlay"] *) [data-testid="panel-dock-toggle-${id}"]`);
    if (await outside.count()) await outside.click();
  }
  await expect(inDrawer(page)).toHaveCount(ids.length);
  await drawerSettled(page);
}

/**
 * The drawer has finished sliding in. In rail mode it slides in over 200 ms (fb-drawer-slide-in);
 * a box read during the slide is off to the right, so a drag started there misses the edge.
 */
async function drawerSettled(page: Page) {
  await overlay(page).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished))).catch(() => undefined);
}

async function dockedBesideTheReads(page: Page, ids: string[]) {
  await expect(overlay(page)).toHaveCount(0);
  for (const id of ids) await expect(page.locator(`[data-panel-content-type="${id}"]`)).toBeVisible();
  // And they stay there: no flip back into the drawer once the layout settles.
  await page.waitForTimeout(1200);
  await expect(overlay(page)).toHaveCount(0);
  // The reads' right edge: the rightmost dataset header (several datasets sit side by side).
  const readsRight = Math.max(...await page.locator('[data-testid^="dataset-header-"]').evaluateAll(els => els.map(e => e.getBoundingClientRect().right)));
  for (const id of ids) {
    const box = (await page.locator(`[data-panel-content-type="${id}"]`).boundingBox())!;
    expect(box.x, `${id} beside the reads, not over them`).toBeGreaterThanOrEqual(readsRight - 1);
  }
}

const dockCases: Array<{ width: number; n: number; copies?: number; scale?: number }> = [
  { width: 1280, n: 1 }, { width: 1280, n: 2 },
  { width: 1728, n: 1 }, { width: 1728, n: 2 }, { width: 1728, n: 3 },
  { width: 2560, n: 1 }, { width: 2560, n: 2 }, { width: 2560, n: 3 },
  { width: 1728, n: 2, copies: 1 },
  { width: 1728, n: 2, scale: 1.25 },
];
for (const { width, n, copies = 0, scale = 1 } of dockCases) {
  const what = `${width} px${copies ? `, ${copies + 1} datasets` : ''}${scale !== 1 ? `, UI size ${scale}` : ''}, ${n} side panel${n > 1 ? 's' : ''}`;
  test(`docking the drawer brings its panels beside the reads (${what})`, async ({ server, page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await openApp(page, server.baseUrl);
    for (let c = 0; c < copies; c++) {
      await clickPanelAction(page, 'panel-add-copy');
    }
    if (scale !== 1) await page.evaluate(s => (window as any).__FIBERBROWSER_STORE__.getState().setUiScale(s), scale);
    const ids = SIDE.slice(0, n);
    await sidePanelsInDrawer(page, ids);
    await expect(drawerDock(page)).not.toHaveAttribute('aria-disabled', 'true');
    await drawerDock(page).click();
    await dockedBesideTheReads(page, ids);
    await page.screenshot({ path: testInfo.outputPath(`docked-${width}-${n}${copies ? '-copies' : ''}${scale !== 1 ? '-scaled' : ''}.png`) });
  });
}

test('too narrow even at the docked widths: docking still brings them out, and the row scrolls', async ({ server, page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, server.baseUrl);
  await sidePanelsInDrawer(page, SIDE);
  // Usability round 1 (docking policy): docking is never blocked; panels that don't fit make the row scroll.
  await expect(drawerDock(page)).not.toHaveAttribute('aria-disabled', 'true');
  await drawerDock(page).click();
  await expect(overlay(page)).toHaveCount(0);
  await expect(page.getByTestId('panel-row-scroll')).toHaveCount(1);
  for (const id of SIDE) expect((await page.locator(`[data-panel-content-type="${id}"]`).boundingBox())!.width).toBeGreaterThanOrEqual(320);
});

test('opening any toolbar group never changes the toolbar height or moves the reads', async ({ server, page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 2560, height: 1000 });
  await openApp(page, server.baseUrl);
  const groups = await page.locator('[data-testid^="toolbar-group-toggle-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid')!.replace('toolbar-group-toggle-', '')));
  expect(groups).toEqual(expect.arrayContaining(['reads', 'layers', 'peaks', 'cluster', 'sort', 'filter', 'highlight', 'quality']));
  for (const g of groups) {
    const t = page.getByTestId(`toolbar-group-toggle-${g}`);
    if ((await t.getAttribute('aria-expanded')) === 'true') await t.click();
  }
  const measure = () => page.evaluate(() => ({
    row: document.querySelector('[data-testid="toolbar-groups-row"]')!.getBoundingClientRect().height,
    readsTop: document.querySelector('canvas[data-copilot-track="reads"]')!.getBoundingClientRect().top,
    tallest: Math.max(0, ...Array.from(document.querySelectorAll('[data-toolbar-controls] *'))
      .filter(e => (e as HTMLElement).offsetParent && !e.closest('[data-toolbar-peek]'))
      .map(e => e.getBoundingClientRect().height)),
  }));
  const folded = await measure();
  for (const g of groups) {
    await page.getByTestId(`toolbar-group-toggle-${g}`).click();
    await expect(page.getByTestId(`toolbar-group-controls-${g}`)).toBeVisible();
    const open = await measure();
    expect(open.row, `${g} open: toolbar row height`).toBeCloseTo(folded.row, 0);
    expect(open.readsTop, `${g} open: the reads stay put`).toBeCloseTo(folded.readsTop, 0);
    expect(open.tallest, `${g} open: every control fits the row`).toBeLessThanOrEqual(24.5);
    await page.getByTestId('operations-toolbar').screenshot({ path: testInfo.outputPath(`toolbar-${g}-open.png`) });
    await page.getByTestId(`toolbar-group-toggle-${g}`).click();
  }
});

for (const dark of [false, true]) {
  test(`every action keeps its own colour, matched to its panel, even when it can't run (${dark ? 'dark' : 'light'})`, async ({ server, page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1728, height: 900 });
    await openApp(page, server.baseUrl, { dark });
    const actions = ['peak-scan-button', 'cluster-run-button', 'sort-run-button', 'filter-run-button', 'highlight-run-button'];
    const looks = await page.evaluate(ids => ids.map(id => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
      const cs = getComputedStyle(el);
      return { id, tone: cs.getPropertyValue('--tone').trim(), color: cs.color, border: cs.borderColor, opacity: Number(cs.opacity), blocked: el.getAttribute('aria-disabled') === 'true', title: el.title };
    }), actions);
    expect(new Set(looks.map(l => l.tone)).size, JSON.stringify(looks)).toBe(5);
    expect(new Set(looks.map(l => l.color)).size, 'five different inks').toBe(5);
    const grey = (c: string) => {
      const m = c.match(/[\d.]+/g)!.map(Number);
      // rgb() or color(srgb …): a grey has its three channels equal.
      const [r, g, b] = c.startsWith('color(') ? m.slice(0, 3).map(v => v * 255) : m.slice(0, 3);
      return Math.max(r, g, b) - Math.min(r, g, b) < 12;
    };
    // Cluster (no peaks selected) and Filter (no filter rule) can't run on a fresh load.
    const blocked = looks.filter(l => l.blocked);
    expect(blocked.map(l => l.id).sort()).toEqual(['cluster-run-button', 'filter-run-button']);
    for (const l of looks) expect(grey(l.color), `${l.id} ink ${l.color}`).toBe(false);
    for (const l of blocked) {
      expect(l.opacity, `${l.id} faded`).toBeLessThan(1);
      expect(l.title.length, `${l.id} says why`).toBeGreaterThan(0);
    }
    // Matched to the panels they lead to.
    const tones = Object.fromEntries(looks.map(l => [l.id, l.tone.toLowerCase()]));
    expect(tones['peak-scan-button']).toBe('#1d4ed8');   // Peak Detection
    expect(tones['cluster-run-button']).toBe('#0891b2'); // Clusters
    expect(tones['filter-run-button']).toBe('#9333ea');  // Rules
    expect(tones['highlight-run-button']).toBe('#0f766e');  // Regions (fb-r4-regions)
    // Every tone class made it into the built stylesheet.
    const inCss = await page.evaluate(() => {
      const selectors: string[] = [];
      const walk = (rules: CSSRuleList) => { for (const r of Array.from(rules)) { if ((r as CSSStyleRule).selectorText) selectors.push((r as CSSStyleRule).selectorText); if ((r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules); } };
      for (const s of Array.from(document.styleSheets)) { try { walk(s.cssRules); } catch { /* cross-origin */ } }
      return ['peaks', 'cluster', 'sort', 'filter', 'highlight'].map(t => selectors.some(sel => sel.split(',').some(x => x.trim() === `.fb-action-${t}`)));
    });
    expect(inCss).toEqual([true, true, true, true, true]);
    await page.getByTestId('operations-toolbar').screenshot({ path: testInfo.outputPath(`actions-${dark ? 'dark' : 'light'}.png`) });
  });
}

test('the drawer resizes from its edge (drag or keys), and keeps its width across a reload', async ({ server, page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1728, height: 900 });
  await openApp(page, server.baseUrl);
  await sidePanelsInDrawer(page, SIDE.slice(0, 2));
  const width = async () => (await overlay(page).boundingBox())!.width;
  const before = await width();
  const handle = page.getByTestId('analysis-overlay-resize');
  await expect(handle).toHaveAttribute('role', 'separator');
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 100, h.y + h.height / 2, { steps: 4 });
  await page.mouse.move(h.x + h.width / 2 - 200, h.y + h.height / 2, { steps: 4 });
  await page.mouse.up();
  expect(await width()).toBeCloseTo(before + 200, -1);
  await page.waitForTimeout(400);  // the tuck tab follows the edge with a short slide
  await page.screenshot({ path: testInfo.outputPath('drawer-resized.png') });
  // Keyboard: focus the edge, Left widens.
  await handle.focus();
  const dragged = await width();
  await page.keyboard.press('ArrowLeft');
  expect(await width()).toBeCloseTo(dragged + 16, 0);
  const saved = Number(await page.evaluate(() => localStorage.getItem('fiberbrowser_drawer_width')));
  expect(saved).toBeCloseTo(dragged + 16, 0);
  // Remembered: after a reload the panels (remembered as pinned) open in a drawer of that width.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
  if (!(await inDrawer(page).count())) for (const id of SIDE.slice(0, 2)) await panelButton(page, id).click();
  await expect(inDrawer(page)).toHaveCount(2);
  await drawerSettled(page);
  expect(await width()).toBeCloseTo(saved, 0);
  // Double-click: the default width again.
  await page.getByTestId('analysis-overlay-resize').dblclick();
  expect(await width()).toBeCloseTo(before, 0);
});

test('a drawer tab pops out as a side panel of its own, and Pin to the side puts it back', async ({ server, page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, server.baseUrl);
  const [a, b] = SIDE;
  // Usability round 1: nothing goes to the drawer by itself; pinned, both are in it (two tabs).
  await sidePanelsInDrawer(page, [a, b]);
  await page.getByTestId(`analysis-overlay-tab-${b}`).click();
  await page.getByTestId(`analysis-overlay-popout-${b}`).click();
  // b beside the reads, a still in the drawer (pinned).
  await expect(inDrawer(page)).toHaveCount(1);
  await expect(page.locator(`[data-testid="analysis-overlay"] [data-panel-content-type="${a}"]`)).toHaveCount(1);
  const popped = page.locator(`[data-panel-content-type="${b}"]`);
  await expect(popped).toBeVisible();
  expect(await page.locator(`[data-testid="analysis-overlay"] [data-panel-content-type="${b}"]`).count()).toBe(0);
  await page.waitForTimeout(1000);
  await expect(inDrawer(page)).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('popped-out.png') });
  // Back into the drawer.
  const pin = popped.getByTestId(`panel-dock-toggle-${b}`);
  await expect(pin).toHaveAttribute('aria-label', 'Pin to the side');
  await pin.click();
  await expect(page.locator(`[data-testid="analysis-overlay"] [data-panel-content-type="${b}"]`)).toHaveCount(1);
  await expect(inDrawer(page)).toHaveCount(2);
});
