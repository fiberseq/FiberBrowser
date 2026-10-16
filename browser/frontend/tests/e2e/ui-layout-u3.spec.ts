/**
 * Usability round 3, layout (fb-u3-layout):
 * - B1: "Dock beside the reads" on one pinned panel docks only that panel; the row keeps 480/420/420/420 and scrolls.
 * - R1: a scrolling row's edge chips sit in a band of their own, over no panel content.
 * - R2: panels opened together land as one opening (B8: a set inserted left of the view shows whole); the chip on the
 *   side where the working panel went pulses.
 * - B3: Skip to panels with no side panel open goes to the panel launchers.
 * - B4: dismissing the Welcome card on first launch puts focus on the toolbar's Open, not <body>.
 * - R11: toolbar Save says which file it downloaded.
 * - R12: the reads area with no dataset: "Open a BAM or choose one in the Library", with an Open button.
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Locator, Page } from '@playwright/test';

async function openApp(page: Page, baseUrl: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!sessionStorage.getItem('ui-layout-u3')) {
      localStorage.clear();
      sessionStorage.setItem('ui-layout-u3', '1');
      localStorage.setItem('fiberbrowser_panel_rail_coach_seen', '1');
    }
  });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
}

const width = async (el: Locator) => Math.round((await el.boundingBox())!.width);
const sideWidths = (page: Page, ids: string[]) =>
  Promise.all(ids.map(id => width(page.locator(`[data-panel-content-type="${id}"]`).first())));
const docks = (page: Page) => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels
  .filter((p: any) => p.contentType !== 'dataset').map((p: any) => p.dock ?? null));

/** Whether the element is wholly inside the scroller's visible box (2 px slack). */
async function wholeInRow(el: Locator, scroller: Locator): Promise<boolean> {
  const [a, b] = [(await el.boundingBox())!, (await scroller.boundingBox())!];
  return a.x >= b.x - 2 && a.x + a.width <= b.x + b.width + 2;
}

const SIDE = ['cluster-detail', 'footprint-analysis', 'co-accessibility'];

test('B1: docking one pinned panel back keeps the row at its comfortable widths, scrolling; R1: chips over no panel', async ({ server, page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page, server.baseUrl);
  for (const id of SIDE) {
    await panelButton(page, id).click();
    await expect(page.locator(`[data-panel-content-type="${id}"]`).first()).toBeVisible();
  }
  const scroller = page.getByTestId('panel-row-scroll');
  await expect(scroller).toHaveCount(1);
  const reads = page.locator('[data-panel-id]').first();
  expect(await width(reads)).toBe(480);
  expect(await sideWidths(page, SIDE)).toEqual([420, 420, 420]);

  // R1: the chip sits in its band, above every panel (it covers none of them).
  const chip = page.locator('[data-testid^="panel-row-more-"]').first();
  await expect(chip).toBeVisible();
  const band = (await page.getByTestId('panel-row-cue-band').boundingBox())!;
  const c = (await chip.boundingBox())!;
  expect(c.y).toBeGreaterThanOrEqual(band.y - 1);
  expect(c.y + c.height).toBeLessThanOrEqual(band.y + band.height + 1);
  const panelTop = Math.min(...await page.locator('[data-panel-id], [data-analysis-panel-id]').evaluateAll(
    els => els.map(e => e.getBoundingClientRect()).filter(r => r.width > 0).map(r => r.top)));
  expect(c.y + c.height).toBeLessThanOrEqual(panelTop + 1);

  // The crosshair's label sits under the ruler of the scrolling row (the band pushes the panels down).
  await scroller.evaluate(e => { e.scrollLeft = 0; });
  const ruler = page.locator('[data-panel-id] canvas.cursor-crosshair, [data-panel-id] canvas.cursor-cell').first();
  const rb = (await ruler.boundingBox())!;
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  const label = page.getByTestId('ruler-crosshair-label');
  await expect(label).toBeVisible();
  expect((await label.boundingBox())!.y).toBeGreaterThanOrEqual(rb.y + rb.height - 1);
  await page.mouse.move(5, 300);

  // Pin Co-accessibility to the side, then dock it back from the drawer.
  await page.locator('[data-testid="panel-dock-toggle-co-accessibility"]:visible').first().click();
  const drawerDock = page.locator('[data-testid="analysis-overlay"] [data-testid="panel-dock-toggle-co-accessibility"]:visible');
  await expect(drawerDock).toHaveAttribute('aria-label', 'Dock beside the reads');
  await drawerDock.click();
  await expect(page.getByTestId('analysis-overlay')).toHaveCount(0);
  // Only it moved, and nothing is squeezed: 480/420/420/420, the row scrolls (was 400/320/320/320, all docked).
  expect(await docks(page)).toEqual([null, null, null]);
  await expect(scroller).toHaveCount(1);
  expect(await width(reads)).toBe(480);
  expect(await sideWidths(page, SIDE)).toEqual([420, 420, 420]);

  // Closed and reopened: the same widths.
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    s.closeAnalysisPanel(s.panels.find((p: any) => p.contentType === 'co-accessibility').id);
  });
  await panelButton(page, 'co-accessibility').click();
  await expect(page.locator('[data-panel-content-type="co-accessibility"]').first()).toBeVisible();
  expect(await sideWidths(page, SIDE)).toEqual([420, 420, 420]);
  expect(await width(reads)).toBe(480);
});

/** Drag a panel by its header's grip to a point, the HTML5 way (mouse down, moves, up), checking mid-drag. */
async function dragGrip(page: Page, grip: Locator, to: { x: number; y: number }, during?: () => Promise<void>) {
  await grip.hover();                                   // waits for it to be stable (the drawer slides in)
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  // the browser sends dragover as the pointer moves: a few small moves settle the drop target there
  for (let k = 1; k <= 4; k++) { await page.mouse.move(to.x + k, to.y + k, { steps: 2 }); await page.waitForTimeout(100); }
  if (during) await during();
  await page.mouse.up();
}

// Owner: "if you attempt to drag a window from the sliding panel onto the main set of panels it fails". A drawer
// panel dropped on the row leaves the drawer at the drop (as "Dock beside the reads", there), the drop target shown
// while dragging; the row keeps 480/420/420/420 and scrolls. The reverse: a row panel dropped on the drawer is pinned.
test('drag between the drawer and the row: out of the drawer at the drop, and into it', async ({ server, page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page, server.baseUrl);
  for (const id of SIDE) {
    await panelButton(page, id).click();
    await expect(page.locator(`[data-panel-content-type="${id}"]`).first()).toBeVisible();
  }
  const order = () => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels
    .filter((p: any) => p.contentType !== 'dataset').map((p: any) => p.contentType));
  await page.locator('[data-testid="panel-dock-toggle-co-accessibility"]:visible').first().click();
  const drawer = page.getByTestId('analysis-overlay');
  await expect(drawer).toHaveCount(1);
  expect(await docks(page)).toEqual([null, null, 'side']);

  // Drawer -> row: drop on the left half of Cluster detail (before it).
  const grip = drawer.locator('[data-testid="analysis-panel-header-co-accessibility"] [title="Drag panel"]');
  const target = (await page.locator('[data-panel-content-type="cluster-detail"]').first().boundingBox())!;
  await dragGrip(page, grip, { x: target.x + 30, y: target.y + 200 }, async () => {
    const line = page.getByTestId('panel-drop-indicator');
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-label', 'Dock here');
    await expect(line).toContainText('Dock here');
    await expect(page.getByTestId('analysis-overlay-drop')).toHaveCount(0);
  });
  await expect(drawer).toHaveCount(0);
  expect(await docks(page)).toEqual([null, null, null]);
  expect(await order()).toEqual(['co-accessibility', 'cluster-detail', 'footprint-analysis']);
  const reads = page.locator('[data-panel-id]').first();
  await expect(page.getByTestId('panel-row-scroll')).toHaveCount(1);
  expect(await width(reads)).toBe(480);
  expect(await sideWidths(page, SIDE)).toEqual([420, 420, 420]);
  // one undo step puts it back in the drawer
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().undo());
  await expect(drawer).toHaveCount(1);
  expect(await docks(page)).toEqual([null, null, 'side']);

  // Row -> drawer: Cluster detail dropped on the drawer is pinned there too (a second tab).
  if (await page.getByTestId('panel-row-scroll').count()) await page.getByTestId('panel-row-scroll').evaluate(e => { e.scrollLeft = 0; });
  const fpGrip = page.locator('[data-testid="analysis-panel-header-cluster-detail"] [title="Drag panel"]').first();
  await drawer.hover({ trial: true });                   // stable: the drawer has slid in
  const d = (await drawer.boundingBox())!;
  await dragGrip(page, fpGrip, { x: d.x + d.width / 2, y: d.y + 120 }, async () => {
    await expect(page.getByTestId('analysis-overlay-drop')).toHaveCount(1);
    await expect(page.getByTestId('panel-drop-indicator')).toHaveCount(0);
  });
  await expect(page.getByTestId('analysis-overlay-tabs')).toBeVisible();
  expect((await docks(page)).filter(x => x === 'side')).toHaveLength(2);
});

test('R2: a set inserted left of the view lands whole (B8); the chip where the working panel went pulses', async ({ server, page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1024, height: 760 });
  await openApp(page, server.baseUrl);
  await panelButton(page, 'cluster-detail').click();
  const clusters = page.locator('[data-panel-content-type="cluster-detail"]');
  await expect(clusters).toBeVisible();
  // Work in the reads, then open another side panel: it shows, the reads go past the left edge and that chip pulses.
  await page.locator('[data-panel-id]').first().click({ position: { x: 200, y: 160 } });
  await panelButton(page, 'footprint-analysis').click();
  const footprints = page.locator('[data-panel-content-type="footprint-analysis"]');
  const scroller = page.getByTestId('panel-row-scroll');
  await expect.poll(() => wholeInRow(footprints, scroller), { timeout: 5_000 }).toBe(true);
  await expect(page.getByTestId('panel-row-more-left')).toHaveAttribute('data-pulse', 'true');

  // Work in Footprints, then two read panels arrive together at the row's left (a split's set): both show.
  await footprints.click({ position: { x: 200, y: 160 } });
  const ids = await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const s = store.getState();
    const src = s.panels.find((p: any) => p.contentType === 'dataset');
    const copies = [1, 2].map(n => ({ ...src, id: `u3-set-${n}`, stateKey: `u3-set-${n}`, subTracks: src.subTracks.map((t: any) => ({ ...t })), linkGroup: null }));
    store.setState({ panels: [...copies, ...s.panels] });
    return copies.map(c => c.id);
  });
  for (const id of ids) {
    await expect.poll(() => wholeInRow(page.locator(`[data-panel-id="${id}"]`), scroller), { timeout: 5_000 }).toBe(true);
  }
  // Footprints could not stay beside them: its chip, on the right, pulses.
  await expect(page.getByTestId('panel-row-more-right')).toHaveAttribute('data-pulse', 'true');
});

test('B3: Skip to panels with no side panel open goes to the panel launchers', async ({ server, page }) => {
  test.setTimeout(90_000);
  await openApp(page, server.baseUrl);
  const toPanels = page.getByTestId('skip-to-panels');
  await toPanels.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="panel-rail-launchers"], [data-testid="analysis-strip"]'))).toBe(true);
});

test('R11: toolbar Save names the session file it downloaded', async ({ server, page }) => {
  test.setTimeout(90_000);
  await openApp(page, server.baseUrl);
  const status = page.getByTestId('save-session-status');
  await expect(status).toHaveAttribute('role', 'status');
  const download = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const file = (await download).suggestedFilename();
  await expect(status).toHaveText(`Session downloaded: ${file}`);
  expect(file).toMatch(/\.json$/);
});

test('B4 + R12: Welcome Escape on first launch focuses Open; the reads area says how to open data', async ({ server, page }) => {
  test.setTimeout(90_000);
  await openApp(page, server.baseUrl);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    for (const d of [...s.datasets]) s.removeDataset(d.id);
  });
  const welcome = page.getByRole('dialog', { name: 'Welcome to FiberBrowser' });
  await expect(welcome).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('welcome-card')).toHaveCount(0);
  await expect(page.getByTestId('load-file-button')).toBeFocused();
  const prompt = page.getByTestId('empty-reads-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Open a BAM or choose one in the Library');
  await expect(prompt.getByTestId('empty-reads-open')).toHaveText('Open');
});
