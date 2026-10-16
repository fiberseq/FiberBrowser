/**
 * The chrome never takes the reads' room (FiberBrowser 3.0 final-RC audit, fb-n1-audit):
 * - H5: at UI size 150% the top bar and the open toolbar groups filled a 1024x700
 *   window (no reads at all) and left about 240 px at 1280x800. At 1024x700 and
 *   1280x800, UI size 100/125/150%, light and dark, with every toolbar group folded
 *   and with every group open (remembered), the reads' region keeps half the window
 *   (at least 300 px) and nothing in the chrome runs off the window. At UI size 200% and
 *   300% the top bar and toolbar are drawn smaller (never below 100%) to keep that.
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';

const SIZES = [
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
];
const SCALES = [1, 1.25, 1.5];
const GROUPS = ['reads', 'layers', 'peaks', 'cluster', 'sort', 'filter', 'highlight', 'quality'];
/** Mirrors readsMinHeight (utils/toolbarFit.ts). */
const readsMin = (h: number) => Math.max(300, Math.round(h * 0.5));

async function openApp(page: Page, baseUrl: string, dark: boolean) {
  await page.addInitScript((dark) => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!sessionStorage.getItem('ui-chrome-budget')) {
      localStorage.clear();
      sessionStorage.setItem('ui-chrome-budget', '1');
      localStorage.setItem('fiberhmm_darkmode', String(dark));
    }
  }, dark);
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
}

/** Reload with every toolbar group remembered open (or folded), at a UI size. */
async function reloadWith(page: Page, open: boolean, scale: number) {
  await page.evaluate(([open, groups]) => {
    for (const id of groups as string[]) localStorage.setItem(`fiberbrowser_toolbar_group_v2_${id}`, open ? 'open' : 'closed');
  }, [open, GROUPS] as const);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(s => (window as any).__FIBERBROWSER_STORE__.getState().setUiScale(s), scale);
  await page.waitForTimeout(400);
}

/** The reads' region on screen (px): from the toolbar's bottom to the window's. */
const readsHeight = (page: Page) => page.getByTestId('tracks-region').evaluate(el => {
  const r = el.getBoundingClientRect();
  return Math.round(Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
});

/** Visible chrome elements that stick out of the window (as in ui-chrome-small). */
async function offscreen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page scrollWidth ${document.documentElement.scrollWidth}`);
    const roots = document.querySelectorAll('[data-testid="top-nav"], [data-testid="operations-toolbar"], [data-testid="analysis-strip"]');
    for (const root of roots) {
      for (const el of [root, ...root.querySelectorAll('*')] as HTMLElement[]) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        let clipped = false;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
          const b = a.getBoundingClientRect();
          if (r.right > b.right + 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.top < b.top - 1) { clipped = true; break; }
        }
        if (clipped) continue;
        if (r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1 || r.left < -1 || r.top < -1) {
          out.push(`${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? ''}] "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`);
        }
      }
    }
    return out.slice(0, 10);
  });
}

for (const dark of [false, true]) {
  test(`the reads keep half the window at every UI size, groups folded or open (${dark ? 'dark' : 'light'})`, async ({ server, page }, testInfo) => {
    test.setTimeout(300_000);
    await page.setViewportSize(SIZES[0]);
    await openApp(page, server.baseUrl, dark);
    const short: string[] = [];
    const off: string[] = [];
    for (const size of SIZES) {
      await page.setViewportSize(size);
      for (const scale of SCALES) {
        for (const open of [false, true]) {
          await reloadWith(page, open, scale);
          const where = `${size.width}x${size.height} UI ${scale * 100}% ${open ? 'all groups open' : 'folded'} ${dark ? 'dark' : 'light'}`;
          await page.screenshot({ path: testInfo.outputPath(`${size.width}x${size.height}-${scale * 100}-${open ? 'open' : 'folded'}.png`) });
          const h = await readsHeight(page);
          if (h < readsMin(size.height)) short.push(`${where}: reads ${h} px < ${readsMin(size.height)}`);
          for (const o of await offscreen(page)) off.push(`${where}: ${o}`);
        }
      }
    }
    expect(short, 'the reads keep half the window').toEqual([]);
    expect(off, 'nothing in the chrome off screen').toEqual([]);

    // A group folded for room comes back when the user asks for it (another folds instead),
    // and the reads keep their height. A roomier window gives every open group its room again.
    await page.setViewportSize(SIZES[0]);
    await reloadWith(page, true, 1.5);
    const roomFolded = page.locator('[data-testid^="toolbar-group-"][data-folded-for-room="true"]');
    expect(await roomFolded.count()).toBeGreaterThan(0);
    const id = (await roomFolded.first().getAttribute('data-testid'))!.replace('toolbar-group-', '');
    await page.getByTestId(`toolbar-group-toggle-${id}`).click();
    await expect(page.getByTestId(`toolbar-group-controls-${id}`)).toBeVisible();
    expect(await readsHeight(page), `1024x700 UI 150%: ${id} shown`).toBeGreaterThanOrEqual(readsMin(700));
    await page.screenshot({ path: testInfo.outputPath(`1024x700-150-${id}-shown.png`) });
    await page.setViewportSize({ width: 2560, height: 1600 });
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setUiScale(1));
    await expect(roomFolded).toHaveCount(0);

    // UI sizes beyond 150%: folding is not enough, so the top bar and toolbar are drawn smaller
    // than the UI size (never below 100%), and get it back in a window with room for it.
    const chromeZoom = () => page.getByTestId('scaled-main-controls').evaluate(el => Number(getComputedStyle(el).zoom));
    for (const scale of [2, 3]) {
      await page.setViewportSize(SIZES[0]);
      await reloadWith(page, true, scale);
      const h = await readsHeight(page);
      await page.screenshot({ path: testInfo.outputPath(`1024x700-${scale * 100}-open.png`) });
      expect(h, `1024x700 UI ${scale * 100}%: reads`).toBeGreaterThanOrEqual(readsMin(700));
      const z = await chromeZoom();
      expect(z, `1024x700 UI ${scale * 100}%: chrome zoom`).toBeLessThan(scale);
      expect(z).toBeGreaterThanOrEqual(1);
      expect(await offscreen(page), `1024x700 UI ${scale * 100}%: chrome off screen`).toEqual([]);
      await page.setViewportSize({ width: 2560, height: 1600 });
      await expect.poll(chromeZoom, { message: `2560x1600 UI ${scale * 100}%: the full UI size again` }).toBe(scale);
    }
  });
}

/**
 * M14: with four dataset panels the headers lost their dataset names ("312/3,173 visible"
 * only, "nap…", "n") and the per-panel location boxes were 0-60 px ("chr3R:6", "c").
 * Four panels in Per panel navigation (each with its own location box), at 1280x800 with
 * nothing open and with the settings sidebar open, and at 1728x1080 with two side panels:
 * every header shows its name (at least 56 px of it), the read count only while the name
 * has room, and every location box keeps an input of at least 140 px.
 */
test('four panels: every header keeps its dataset name and a readable location box', async ({ server, page }, testInfo) => {
  test.setTimeout(240_000);
  const names = ['flyamp_DddB.called', 'stage_d_recalled', 'mutant_b_recalled'];
  for (const label of names) {
    const added = await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: server.bamPath, label } });
    expect(added.ok(), await added.text()).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, server.baseUrl, false);
  const headers = page.locator('[data-testid^="dataset-header-"]');
  await expect(headers).toHaveCount(4, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setNavigationMode('perPanel'));
  await expect(page.locator('[data-testid="panel-location-input"]')).toHaveCount(4);

  const check = async (where: string) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: testInfo.outputPath(`four-panels-${where.replace(/[^\w]+/g, '-')}.png`) });
    const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid^="dataset-header-"]')].map(h => {
      // (The name's test id is new: before it, the header's first bold span.)
      const name = h.querySelector<HTMLElement>('[data-testid="panel-header-name"]') ?? h.querySelector<HTMLElement>('span.font-semibold');
      const panel = h.closest('[data-panel-id]')!;
      const input = panel.querySelector<HTMLElement>('[data-testid="panel-location-input"]');
      const status = h.querySelector<HTMLElement>('[data-testid="panel-read-status"]');
      const hb = h.getBoundingClientRect();
      // Header controls drawn outside the header bar (cut off).
      const spill = [...h.querySelectorAll<HTMLElement>('button')].filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && (r.right > hb.right + 1 || r.left < hb.left - 1);
      }).length;
      return {
        panel: Math.round(panel.getBoundingClientRect().width),
        name: name ? Math.round(name.getBoundingClientRect().width) : 0,
        text: name?.textContent ?? '',
        status: status?.textContent ?? null,
        input: input ? Math.round(input.getBoundingClientRect().width) : 0,
        spill,
      };
    }));
    console.log(where, JSON.stringify(rows));
    for (const r of rows) {
      expect(r.text.length, `${where}: header name`).toBeGreaterThan(0);
      expect(r.name, `${where}: ${r.text} name width (panel ${r.panel} px)`).toBeGreaterThanOrEqual(56);
      expect(r.input, `${where}: ${r.text} location box (panel ${r.panel} px)`).toBeGreaterThanOrEqual(140);
      expect(r.spill, `${where}: ${r.text} header controls cut off`).toBe(0);
    }
  };

  await check('1280x800');
  await page.getByTestId('settings-rail-file').click();
  await expect(page.getByTestId('settings-sidebar')).toBeVisible();
  await check('1280x800 sidebar open');
  await page.getByTestId('settings-sidebar-collapse').click();

  await page.setViewportSize({ width: 1728, height: 1080 });
  for (const id of ['cluster-detail', 'footprint-analysis']) await panelButton(page, id).click();
  await check('1728x1080 two side panels');

  // The pan/zoom buttons that went to ⋯ still work there.
  const more = page.locator('[data-testid="panel-site-more"]').first();
  if (await more.count()) {
    const panel = page.locator('[data-panel-id]').filter({ has: more });
    const id = await panel.first().getAttribute('data-panel-id');
    const before = await page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.id === id).viewportOverride, id);
    await more.click();
    await page.getByTestId('panel-site-menu').getByRole('menuitem', { name: 'Zoom out' }).click();
    await expect(page.getByTestId('panel-site-menu')).toHaveCount(0);
    const after = await page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.id === id).viewportOverride, id);
    expect(after.end - after.start).toBeGreaterThan(before.end - before.start);
  }
});

/**
 * Usability round 1: renaming the toolbar's Save to "Save session" wrapped the top bar to a second row
 * between about 1600 and 1660 px (36 px of reads lost). The visible label stays "Save"; the tooltip and
 * the accessible name say "Save session". From 1600 px up the top bar's sets are on one row.
 */
test('top bar: one row from 1600 px; Save is named Save session', async ({ server, page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openApp(page, server.baseUrl, false);
  const save = page.getByTestId('save-session-button');
  const lab = await save.count() > 0;   // the public flavour has no Save
  if (lab) {
    await expect(save).toHaveText('Save');
    await expect(save).toHaveAttribute('aria-label', /^Save session/);
    await expect(save).toHaveAttribute('title', /^Save session/);
  }
  for (const width of [1600, 1630, 1660, 1728]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(300);
    // The vertical centres of the top bar's items (File, History, Navigation, App): one row when they agree.
    const centres = await page.getByTestId('top-nav').evaluate(nav =>
      [...nav.children].map(el => el.getBoundingClientRect())
        .filter(r => r.width > 0 && r.height > 0)
        .map(r => Math.round(r.top + r.height / 2)));
    expect(centres.length, `${width} px: top bar items`).toBeGreaterThan(2);
    expect(Math.max(...centres) - Math.min(...centres), `${width} px: the top bar on one row (${centres.join(', ')})`).toBeLessThan(4);
  }
});
