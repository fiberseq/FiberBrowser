/**
 * The analysis panel launchers in the sidebar rail, the default (Settings ›
 * Reads & Display › Analysis panels: Sidebar rail, or Strip (classic)).
 *
 * At 1280x800 and 1024x700 the reads are taller than with the strip, the rail
 * never runs off the window (its launchers scroll), a launcher's name shows
 * on hover inside the window, and Clusters opens from the rail (in the drawer
 * at the rail's edge when the reads are narrow). The setting is found in the
 * settings and the palette and is remembered for the viewer.
 *
 * FIBERBROWSER_RAIL_SCREENSHOTS=<dir> also saves strip-vs-rail screenshots
 * (1280x800, 1728x1080, 1024x700; light and dark).
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';

const SHOTS = process.env.FIBERBROWSER_RAIL_SCREENSHOTS?.trim();

async function openApp(page: Page, url: string, opts: { dark?: boolean; mode?: 'strip' | 'rail'; coach?: boolean } = {}) {
  await page.addInitScript(({ dark, mode, coach }) => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!sessionStorage.getItem('panel-rail-spec')) {
      localStorage.clear();
      sessionStorage.setItem('panel-rail-spec', '1');
      localStorage.setItem('fiberhmm_darkmode', String(Boolean(dark)));
      if (mode) localStorage.setItem('fiberbrowser_panel_launcher', mode);
      if (!coach) localStorage.setItem('fiberbrowser_panel_rail_coach_seen', '1');
    }
  }, { dark: opts.dark ?? false, mode: opts.mode ?? null, coach: opts.coach ?? false });
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
}

/** The first read track's height (Fit mode fills the panel). */
const readsHeight = (page: Page) => page.locator('[data-read-track-state-key]').first()
  .evaluate(el => Math.round(el.getBoundingClientRect().height));

/** Rail pieces drawn outside the window (or the page scrolling sideways). */
async function railOffscreen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page scrollWidth ${document.documentElement.scrollWidth}`);
    const rail = document.querySelector('[data-testid="sidebar-rail"]');
    if (!rail) return ['no rail'];
    const list = rail.querySelector('[data-testid="panel-rail-launchers"]') as HTMLElement | null;
    const lr = list?.getBoundingClientRect();
    for (const el of [rail, ...rail.querySelectorAll('button')] as HTMLElement[]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Scrolled out of the launcher list: fine (it scrolls), as long as the list itself is on screen.
      if (list && list.contains(el) && lr && (r.bottom > lr.bottom + 1 || r.top < lr.top - 1)) continue;
      if (r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1 || r.left < -1 || r.top < -1) {
        out.push(`${el.getAttribute('data-testid') ?? el.getAttribute('aria-label')} ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`);
      }
    }
    return out;
  });
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

for (const size of [{ width: 1280, height: 800 }, { width: 1024, height: 700 }]) {
  test(`rail mode at ${size.width}x${size.height}: taller reads, rail on screen, Clusters opens from the rail`, async ({ server, page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(size);
    await openApp(page, server.baseUrl, { mode: 'strip' });
    await expect(page.getByTestId('analysis-strip')).toBeVisible();
    await expect(page.getByTestId('panel-rail')).toHaveCount(0);
    await page.waitForTimeout(500);
    const stripReads = await readsHeight(page);

    // ?panels=rail switches (and is remembered).
    await page.goto(`${server.baseUrl}/?panels=rail`);
    await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('panel-rail')).toBeVisible();
    await expect(page.getByTestId('analysis-strip')).toHaveCount(0);
    await expect(page.getByTestId('analysis-strip-collapsed')).toHaveCount(0);
    await page.waitForTimeout(500);
    const railReads = await readsHeight(page);
    expect(railReads, `reads ${stripReads} px with the strip, ${railReads} px with the rail`).toBeGreaterThan(stripReads + 20);
    expect(await page.evaluate(() => localStorage.getItem('fiberbrowser_panel_launcher'))).toBe('rail');

    // Same width as before (40 px), nothing off the window; in the small window the launchers scroll.
    expect(await page.getByTestId('sidebar-rail').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(40);
    expect(await railOffscreen(page)).toEqual([]);
    const list = page.getByTestId('panel-rail-launchers');
    const { scrollable } = await list.evaluate(el => ({ scrollable: el.scrollHeight > el.clientHeight + 1 }));
    if (size.height <= 700) expect(scrollable, 'launchers scroll in a 700 px window').toBe(true);
    if (scrollable) await expect(page.getByTestId('panel-rail-fade-bottom')).toBeVisible();
    // The last launcher can be reached and named (its tooltip inside the window).
    const tiles = page.locator('[data-testid="panel-rail-launchers"] [data-rail-tile]');
    const last = tiles.last();
    await last.scrollIntoViewIfNeeded();
    await last.hover();
    const tip = page.getByTestId('panel-rail-tooltip');
    await expect(tip).toBeVisible();
    const box = (await tip.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width - 40);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    await page.mouse.move(size.width / 2, size.height / 2);
    await expect(tip).toHaveCount(0);

    // Library sits right after Tracks.
    const order = await tiles.evaluateAll(els => els.map(el => el.getAttribute('data-panel-launcher')));
    expect(order[order.indexOf('track-browser') + 1]).toBe('library');

    // Clusters opens from the rail (beside the reads while they keep 480 px).
    const clusters = page.getByTestId('panel-rail-cluster-detail');
    await clusters.scrollIntoViewIfNeeded();
    await clusters.click();
    await expect(page.locator('[data-panel-content-type="cluster-detail"]').first()).toBeVisible();
    await expect(clusters).toHaveAttribute('aria-pressed', 'true');
    // Footprints too: both stay beside the reads (usability round 1: nothing goes to the drawer by itself); the row
    // scrolls sideways when they don't fit, and the new panel is scrolled into view.
    await page.getByTestId('panel-rail-footprint-analysis').click();
    await expect(page.locator('[data-panel-content-type="footprint-analysis"]').first()).toBeVisible();
    await expect(page.getByTestId('analysis-overlay')).toHaveCount(0);
    await expect(page.locator('[data-panel-content-type="footprint-analysis"]').first()).toBeInViewport();
    // Clusters, scrolled out of view or not, comes into view from the rail; a click when in view closes it.
    if (!(await page.locator('[data-panel-content-type="cluster-detail"]').first().evaluate(el => {
      const a = el.getBoundingClientRect(), row = el.closest('[data-testid="panel-row-scroll"]')?.getBoundingClientRect();
      return !row || (a.left >= row.left - 1 && a.right <= row.right + 1);
    }))) {
      await clusters.click();
      await expect(page.locator('[data-panel-content-type="cluster-detail"]').first()).toBeInViewport({ ratio: 0.95 });
      await page.waitForTimeout(600);
    }
    await clusters.click();
    await expect(page.locator('[data-panel-content-type="cluster-detail"]')).toHaveCount(0);
    await expect(clusters).toHaveAttribute('aria-pressed', 'false');
    expect(await railOffscreen(page)).toEqual([]);
  });
}

test('the setting: found by search and the palette, switches live, kept for the viewer, rail beside the open sidebar', async ({ server, page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, server.baseUrl, { mode: 'strip' });
  // ⌘K finds it.
  await page.getByTestId('command-palette-button').click();
  await page.getByTestId('command-palette-input').fill('analysis panels rail');
  await expect(page.getByTestId('command-palette').locator('[data-palette-item="setting:view.panel-launcher"]')).toBeVisible();
  await page.keyboard.press('Escape');
  // In Settings › Reads & Display.
  await page.getByTestId('settings-rail-view').click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', { detail: { sectionId: 'view', subsectionId: 'view.display' } })));
  const railChoice = page.getByTestId('panel-launcher-rail');
  await railChoice.scrollIntoViewIfNeeded();
  await railChoice.click();
  await expect(page.getByTestId('analysis-strip')).toHaveCount(0);
  // The settings stay open, with the rail (and its launchers) beside them.
  await expect(page.getByTestId('settings-sidebar')).toBeVisible();
  await expect(page.getByTestId('panel-rail')).toBeVisible();
  await expect(page.getByTestId('settings-rail-view')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('panel-rail-history').click();
  await expect(page.locator('[data-panel-content-type="history"]').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('panel-rail')).toBeVisible();
  await expect(page.getByTestId('analysis-strip')).toHaveCount(0);
  // Back to the strip from the palette's toggle.
  await page.getByTestId('command-palette-button').click();
  await page.getByTestId('command-palette-input').fill('analysis panels in the sidebar rail');
  await page.getByTestId('command-palette').locator('[data-palette-item="toggle:view.panel-launcher"]').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('analysis-strip')).toBeVisible();
  await expect(page.getByTestId('panel-rail')).toHaveCount(0);
});

test('rail mode: keyboard reaches and names the launchers; dark mode and UI size 150% stay tidy; coach mark once', async ({ server, page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1024, height: 700 });
  await openApp(page, server.baseUrl, { mode: 'rail', dark: true, coach: true });
  const coach = page.getByTestId('panel-rail-coach');
  await expect(coach).toBeVisible();
  await page.getByTestId('panel-rail-coach-dismiss').click();
  await expect(coach).toHaveCount(0);
  await page.reload();
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('panel-rail')).toBeVisible();
  await expect(coach).toHaveCount(0);

  // Keyboard: Tab onto the first launcher shows its name at once; arrows move along the rail.
  const tiles = page.locator('[data-testid="panel-rail-launchers"] [data-rail-tile]');
  await tiles.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(tiles.nth(1)).toBeFocused();
  await expect(page.getByTestId('panel-rail-tooltip')).toBeVisible();
  await page.keyboard.press('Enter');
  const second = await tiles.nth(1).getAttribute('data-panel-launcher');
  await expect(page.locator(`[data-panel-content-type="${second}"]`).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // UI size 150% zooms the reads, not the rail; nothing runs off the window, dark or not.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setUiScale(1.5));
  await page.waitForTimeout(400);
  expect(await railOffscreen(page)).toEqual([]);
  expect(await page.getByTestId('sidebar-rail').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(40);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setUiScale(1));
  // Per panel navigation keeps the rail working.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setNavigationMode('perPanel'));
  await page.getByTestId('panel-rail-cluster-detail').click();
  await expect(page.locator('[data-panel-content-type="cluster-detail"]').first()).toBeVisible();
  expect(await railOffscreen(page)).toEqual([]);
});

test('screenshots: strip vs rail (FIBERBROWSER_RAIL_SCREENSHOTS)', async ({ server, page, context }) => {
  test.skip(!SHOTS, 'set FIBERBROWSER_RAIL_SCREENSHOTS=<dir>');
  test.setTimeout(300_000);
  await openApp(page, server.baseUrl, { mode: 'strip' });
  // A second tab keeps the server up across the many reloads (a local server stops once its last tab closes).
  const keeper = await context.newPage();
  await keeper.goto(server.baseUrl);
  for (const dark of [false, true]) {
    for (const mode of ['strip', 'rail'] as const) {
      await page.evaluate(({ dark, mode }) => {
        localStorage.setItem('fiberbrowser_panel_launcher', mode);
        localStorage.setItem('fiberhmm_darkmode', String(dark));
      }, { dark, mode });
      for (const size of [{ width: 1280, height: 800 }, { width: 1728, height: 1080 }, { width: 1024, height: 700 }]) {
        await page.setViewportSize(size);
        await page.reload();
        await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
        await page.waitForLoadState('networkidle');
        const tag = `${size.width}x${size.height}_${dark ? 'dark' : 'light'}_${mode}`;
        await shot(page, `${tag}.png`);
        // With Clusters open (from the strip chip or the rail tile).
        await page.getByTestId(mode === 'rail' ? 'panel-rail-cluster-detail' : 'analysis-strip-button-cluster-detail').click();
        await expect(page.locator('[data-panel-content-type="cluster-detail"]').first()).toBeVisible();
        if (mode === 'rail') await page.getByTestId('panel-rail-footprint-analysis').hover();
        await page.waitForTimeout(500);
        await shot(page, `${tag}_clusters.png`);
        await page.mouse.move(10, size.height / 2);
        await page.evaluate(() => {
          const s = (window as any).__FIBERBROWSER_STORE__.getState();
          for (const p of s.panels.filter((p: { contentType: string }) => p.contentType !== 'dataset')) s.closeAnalysisPanel(p.id);
        });
      }
    }
  }
});
