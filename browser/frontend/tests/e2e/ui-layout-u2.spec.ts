/**
 * Usability round 2, layout (fb-u2-layout):
 * - N4: a row that scrolls sideways says what is past each edge ("◂ 1 panel" / "2 panels ▸"), a click brings the
 *   nearest hidden panel into view; opening a panel scrolls only as far as needed and keeps the panel the user works
 *   in when both fit.
 * - N12: the Welcome card is a dialog; Escape closes it (not while the Library is over it).
 * - N13: skip links to the reads and the side panels, first in the tab order.
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Locator, Page } from '@playwright/test';

async function openApp(page: Page, baseUrl: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!sessionStorage.getItem('ui-layout-u2')) {
      localStorage.clear();
      sessionStorage.setItem('ui-layout-u2', '1');
      localStorage.setItem('fiberbrowser_panel_rail_coach_seen', '1');
    }
  });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
}

/** Whether the element is wholly inside the scroller's visible box (2 px slack). */
async function wholeInRow(el: Locator, scroller: Locator): Promise<boolean> {
  const [a, b] = [(await el.boundingBox())!, (await scroller.boundingBox())!];
  return a.x >= b.x - 2 && a.x + a.width <= b.x + b.width + 2;
}

test('N4: edge cues count the panels past each edge; opening a panel keeps the working one in view', async ({ server, page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1024, height: 760 });
  await openApp(page, server.baseUrl);
  // Reads + one side panel fit at 1024: no scrolling, no cues.
  await panelButton(page, 'cluster-detail').click();
  const clusters = page.locator('[data-panel-content-type="cluster-detail"]');
  await expect(clusters).toBeVisible();
  await expect(page.getByTestId('panel-row-more-left')).toHaveCount(0);
  await expect(page.getByTestId('panel-row-more-right')).toHaveCount(0);

  // Work in the side panel, then open another: the row scrolls just enough, and both side panels stay in view.
  await clusters.click({ position: { x: 200, y: 120 } });
  await panelButton(page, 'footprint-analysis').click();
  const footprints = page.locator('[data-panel-content-type="footprint-analysis"]');
  await expect(footprints).toBeVisible();
  const scroller = page.getByTestId('panel-row-scroll');
  await expect(scroller).toHaveCount(1);
  await expect.poll(() => wholeInRow(footprints, scroller), { timeout: 5_000 }).toBe(true);
  expect(await wholeInRow(clusters, scroller), 'the panel worked in stays in view').toBe(true);
  // The reads went past the left edge: the cue says so and names them; nothing past the right.
  const left = page.getByTestId('panel-row-more-left');
  await expect(left).toBeVisible();
  await expect(left).toHaveAttribute('data-count', '1');
  await expect(left).toContainText('1 panel');
  await expect(page.getByTestId('panel-row-fade-left')).toHaveCount(1);
  await expect(page.getByTestId('panel-row-more-right')).toHaveCount(0);

  // A click on the cue brings the reads back; the cue moves to the right edge.
  await left.click();
  const reads = page.locator('[data-panel-id]').first();
  await expect.poll(() => wholeInRow(reads, scroller), { timeout: 5_000 }).toBe(true);
  const right = page.getByTestId('panel-row-more-right');
  await expect(right).toBeVisible();
  await expect(right).toHaveAttribute('title', /Off-screen to the right:\n• .*Footprints/);
  await expect(page.getByTestId('panel-row-more-left')).toHaveCount(0);
  await right.click();
  await expect.poll(() => wholeInRow(footprints, scroller), { timeout: 5_000 }).toBe(true);
  // Its tile again, with it in view: it closes (asking for a visible panel never scrolls instead).
  await panelButton(page, 'footprint-analysis').click();
  await expect(footprints).toHaveCount(0);
});

test('N12: the Welcome card is a dialog that Escape closes, not while the Library is over it', async ({ server, page }) => {
  test.setTimeout(90_000);
  await openApp(page, server.baseUrl);
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    for (const d of [...s.datasets]) s.removeDataset(d.id);
  });
  const welcome = page.getByRole('dialog', { name: 'Welcome to FiberBrowser' });
  await expect(welcome).toBeVisible();
  await expect(welcome).toHaveAttribute('aria-modal', 'true');
  await expect(welcome).toBeFocused();
  // The Library over it takes the first Escape.
  await welcome.getByTestId('welcome-library-cta').click();
  await expect(page.getByTestId('library-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('library-dialog')).toBeHidden();
  await expect(welcome).toBeVisible();
  // Then Escape closes the Welcome card.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('welcome-card')).toHaveCount(0);
});

test('N13: skip links first in the tab order jump to the reads and to the side panels', async ({ server, page }) => {
  test.setTimeout(90_000);
  await openApp(page, server.baseUrl);
  // The first Tab of a fresh page.
  await page.keyboard.press('Tab');
  const toReads = page.getByTestId('skip-to-reads');
  await expect(toReads).toBeFocused();
  expect((await toReads.boundingBox())!.width).toBeGreaterThan(40);
  await page.keyboard.press('Enter');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeFocused();
  // The second one goes to the side panels.
  await panelButton(page, 'cluster-detail').click();
  await expect(page.locator('[data-panel-content-type="cluster-detail"]')).toBeVisible();
  const toPanels = page.getByTestId('skip-to-panels');
  await toPanels.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(toReads).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(toPanels).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-analysis-panel-id]'))).toBe(true);
});
