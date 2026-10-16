/**
 * Small windows (1024x700, 1280x800), light and dark: nothing in the chrome
 * runs off the window, the folded operations toolbar is one row, groups open in
 * the row and stay open, hovering never moves the reads, the Export dialog's actions stay on screen, two side
 * panels leave the reads a usable width, and the read canvas is one light
 * ground in dark mode. (FiberBrowser 3.0 UI audit: H2, M1-M3, M7, M19, M23, M29.)
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';

const SIZES = [
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
];

async function openApp(page: Page, baseUrl: string, dark: boolean) {
  await page.addInitScript((dark) => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!sessionStorage.getItem('ui-chrome-small')) {
      localStorage.clear();
      sessionStorage.setItem('ui-chrome-small', '1');
      localStorage.setItem('fiberhmm_darkmode', String(dark));
    }
  }, dark);
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
}

/** Visible chrome elements that stick out of the window (or wrap the page sideways). */
async function offscreen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page scrollWidth ${document.documentElement.scrollWidth}`);
    const roots = document.querySelectorAll('[data-testid="top-nav"], [data-testid="operations-toolbar"], [data-testid="analysis-strip"], [data-testid^="dataset-header-"], [data-export-modal], [data-testid="toolbar-groups-more-menu"]');
    for (const root of roots) {
      for (const el of [root, ...root.querySelectorAll('*')] as HTMLElement[]) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        // Clipped or scrolled away inside a box that clips or scrolls: fine (it's not drawn there).
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

const tracksTop = (page: Page) => page.getByTestId('tracks-region').evaluate(el => Math.round(el.getBoundingClientRect().top));

for (const dark of [false, true]) {
  test(`small windows stay tidy (${dark ? 'dark' : 'light'})`, async ({ server, page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(SIZES[0]);
    await openApp(page, server.baseUrl, dark);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.waitForTimeout(400);
      const where = `${size.width}x${size.height} ${dark ? 'dark' : 'light'}`;
      expect(await offscreen(page), `${where}: chrome off screen`).toEqual([]);

      // Folded, the groups fit one row; hovering a group (its value card) never moves the reads.
      const row = page.getByTestId('toolbar-groups-row');
      for (const toggle of await page.locator('[data-testid^="toolbar-group-toggle-"][aria-expanded="true"]').all()) await toggle.click();
      const centres = await row.evaluate(el => [...el.children].map(c => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; }));
      expect(Math.max(...centres) - Math.min(...centres), `${where}: folded toolbar groups on one row`).toBeLessThan(4);
      expect(await page.getByTestId('operations-toolbar').evaluate(el => el.getBoundingClientRect().height), `${where}: toolbar height`).toBeLessThan(50);
      const top = await tracksTop(page);
      for (const group of ['reads', 'peaks', 'quality']) {
        if (!(await page.getByTestId(`toolbar-group-${group}`).count())) continue;
        await page.getByTestId(`toolbar-group-${group}`).hover();
        expect(await tracksTop(page), `${where}: reads stay put while hovering ${group}`).toBe(top);
      }
      await page.mouse.move(size.width / 2, size.height - 20);
      // Owner (1 Oct): a group opens in the row and stays open until folded (several at once);
      // the toolbar may wrap, but nothing runs off the window.
      const opened: string[] = [];
      for (const group of ['reads', 'peaks', 'cluster', 'sort', 'filter', 'quality']) {
        const toggle = page.getByTestId(`toolbar-group-toggle-${group}`);
        if (!(await toggle.count())) continue; // in the More menu at this size
        await toggle.click();
        opened.push(group);
        await expect(page.getByTestId(`toolbar-group-controls-${group}`)).toBeVisible();
        expect(await offscreen(page), `${where}: ${group} open`).toEqual([]);
      }
      // A click elsewhere and Escape leave them open.
      await page.mouse.click(size.width / 2, size.height - 20);
      await page.keyboard.press('Escape');
      for (const group of opened) await expect(page.getByTestId(`toolbar-group-controls-${group}`), `${where}: ${group} stays open`).toBeVisible();
      expect(await page.locator('[data-testid^="toolbar-group-peek-"]:visible').count(), `${where}: no hover card left open`).toBe(0);
      for (const group of opened) await page.getByTestId(`toolbar-group-toggle-${group}`).click();
      await expect(page.locator('[data-testid^="toolbar-group-controls-"]')).toHaveCount(0);

      // H2 / M28: the Export dialog fits, its actions are on screen, Escape closes it.
      await page.getByTestId('export-screenshot-button').click();
      for (const name of ['Cancel', 'Export PNG']) {
        const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
        expect(box.y + box.height, `${where}: ${name} on screen`).toBeLessThanOrEqual(size.height);
        expect(box.y).toBeGreaterThanOrEqual(0);
      }
      expect(await offscreen(page), `${where}: export dialog on screen`).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-export-modal]')).toHaveCount(0);

      // M29: the read canvas is one light ground in both themes.
      const ground = await page.locator('[data-panel-id]').first().evaluate(el => getComputedStyle(el).backgroundColor);
      expect(ground, `${where}: dataset panel ground`).toBe('rgb(255, 255, 255)');
    }

    // M7: two side panels never leave the reads less than 480 px; below that the row scrolls (usability round 1).
    for (const size of SIZES) {
      await page.setViewportSize(size);
      for (const id of ['cluster-detail', 'footprint-analysis']) {
        if (!(await page.locator(`[data-panel-content-type="${id}"]`).count())) await panelButton(page, id).click();
      }
      await page.waitForTimeout(500);
      const reads = (await page.locator('canvas[data-copilot-track="reads"]').first().boundingBox())!;
      expect(reads.width, `${size.width}: reads width with two side panels`).toBeGreaterThanOrEqual(480);
      const drawer = page.getByTestId('analysis-overlay');
      if (await drawer.count()) {
        await expect(drawer.getByTestId('analysis-overlay-tabs')).toBeVisible();
        expect(await drawer.locator('[data-panel-content-type]:visible').count()).toBe(1);
      }
      expect(await offscreen(page), `${size.width}: chrome with two side panels`).toEqual([]);
    }
  });
}

/** Header controls (Tracks, Clean view, close, ⋯ Panel actions) of every dataset panel that something else covers. */
async function coveredHeaderControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid^="panel-clean-view-"], [data-testid^="panel-actions-"], [data-testid^="panel-tracks-"], [data-testid^="panel-close-"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) { out.push(`${el.dataset.testid}: not drawn`); continue; }
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !el.contains(hit)) {
        out.push(`${el.dataset.testid} at ${Math.round(x)},${Math.round(y)} under ${hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? hit?.tagName}`);
      }
    }
    return out;
  });
}

// Codex integration review (fb24): with datasets stacked (panel menu: Stack below), in a narrow window the
// side-panel drawer covered the lower panel's header controls (M2); Edit filters… left a
// tucked Labeling drawer offscreen (M1); a dialog in an inactive drawer tab stopped
// Escape (M3).
test('stacked datasets with the side-panel drawer: every header reachable, Edit filters shows Labeling, Escape works', async ({ server, page }, testInfo) => {
  test.setTimeout(180_000);
  const added = await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: server.bamPath, label: 'Second copy' } });
  expect(added.ok(), await added.text()).toBe(true);
  await page.setViewportSize(SIZES[0]);
  await openApp(page, server.baseUrl, false);
  const headers = page.locator('[data-testid^="dataset-header-"]');
  await expect(headers).toHaveCount(2, { timeout: 30_000 });
  // Datasets open side by side: stack them (as the panel menu's Stack below does).
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const ids = store.getState().panels.filter((p: any) => p.contentType === 'dataset').map((p: any) => p.id);
    store.getState().arrangePanel(ids[1], 'stack');
  });
  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const id of ['colormap', 'cluster-detail']) {
      if (!(await page.locator(`[data-panel-content-type="${id}"]`).count())) await panelButton(page, id).click();
    }
    // Usability round 1: only a pinned side panel is a drawer over the reads; pin both (this checks the drawer).
    await page.evaluate(() => {
      const store = (window as any).__FIBERBROWSER_STORE__;
      for (const p of store.getState().panels) if (p.contentType !== 'dataset' && p.dock !== 'side') store.getState().setPanelDock(p.id, 'side');
    });
    const drawer = page.getByTestId('analysis-overlay');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-tucked', 'false');
    await page.waitForTimeout(500);
    // Stacked: one above the other.
    const [a, b] = [(await headers.nth(0).boundingBox())!, (await headers.nth(1).boundingBox())!];
    expect(Math.abs(a.x - b.x), `${size.width}: datasets stacked`).toBeLessThan(2);
    expect(b.y).toBeGreaterThan(a.y + 100);
    await page.screenshot({ path: testInfo.outputPath(`stacked-drawer-${size.width}x${size.height}.png`) });
    expect(await coveredHeaderControls(page), `${size.width}x${size.height}: header controls under the drawer`).toEqual([]);
    expect(await offscreen(page), `${size.width}: chrome with the drawer`).toEqual([]);
  }

  // M1: Labeling is the drawer's tab; tuck the drawer; Quality → Edit filters… brings it back.
  await page.setViewportSize(SIZES[0]);
  await page.locator('[data-testid="analysis-overlay-tab-colormap"]').click();
  await page.getByTestId('analysis-overlay-toggle').click();
  await expect(page.getByTestId('analysis-overlay')).toHaveAttribute('data-tucked', 'true');
  if (await page.getByTestId('toolbar-group-toggle-quality').count()) await page.getByTestId('toolbar-group-toggle-quality').click();
  else await page.getByTestId('toolbar-groups-more').click();
  await page.getByTestId('quality-edit-link').click();
  await expect(page.getByTestId('analysis-overlay')).toHaveAttribute('data-tucked', 'false');
  await expect(page.locator('[data-panel-content-type="colormap"]')).toBeVisible();

  // (Escape first closes the More menu, if Edit filters… was in it.)
  if (await page.locator('[data-testid="toolbar-groups-more-menu"]').count()) await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="toolbar-groups-more-menu"]')).toHaveCount(0);

  // M3: the other tab's content is hidden for real, and a dialog in it does not stop Escape.
  const inactive = page.locator('[data-drawer-hidden="true"]');
  await expect(inactive).toHaveCount(1);
  await expect(inactive).toHaveAttribute('hidden', '');
  await inactive.evaluate(el => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.textContent = 'stand-in for Find subclasses';
    el.querySelector('[data-panel-content-type]')!.appendChild(dialog);
  });
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const ds = store.getState().datasets[0].id;
    store.setState({ clusterFocus: { [ds]: new Set([0]) } });
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => {
    const focus = (window as any).__FIBERBROWSER_STORE__.getState().clusterFocus ?? {};
    return Object.values(focus).filter(Boolean).length;
  })).toBe(0);
});

// Codex review of the M2 fix: two dataset columns, the right one a stack. The drawer covers
// nearly all of the right column, so moving its lower header's controls left cannot clear
// them: that header bar is drawn over the drawer instead.
test('two dataset columns with a stack on the right: the lower header stays reachable beside the drawer', async ({ server, page }, testInfo) => {
  test.setTimeout(120_000);
  for (const label of ['Second copy', 'Third copy']) {
    const added = await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: server.bamPath, label } });
    expect(added.ok(), await added.text()).toBe(true);
  }
  await page.setViewportSize(SIZES[0]);
  await openApp(page, server.baseUrl, false);
  const headers = page.locator('[data-testid^="dataset-header-"]');
  await expect(headers).toHaveCount(3, { timeout: 30_000 });
  // They open side by side: stack the third below the second.
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const ids = store.getState().panels.filter((p: any) => p.contentType === 'dataset').map((p: any) => p.id);
    store.getState().arrangePanel(ids[2], 'stack');
  });
  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const id of ['colormap', 'cluster-detail']) {
      if (!(await page.locator(`[data-panel-content-type="${id}"]`).count())) await panelButton(page, id).click();
    }
    // Usability round 1: only a pinned side panel is a drawer over the reads; pin both (this checks the drawer).
    await page.evaluate(() => {
      const store = (window as any).__FIBERBROWSER_STORE__;
      for (const p of store.getState().panels) if (p.contentType !== 'dataset' && p.dock !== 'side') store.getState().setPanelDock(p.id, 'side');
    });
    await expect(page.getByTestId('analysis-overlay')).toHaveAttribute('data-tucked', 'false');
    await page.waitForTimeout(500);
    const xs = await headers.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().x)));
    expect(new Set(xs).size, `${size.width}: two dataset columns`).toBe(2);
    await page.screenshot({ path: testInfo.outputPath(`columns-drawer-${size.width}x${size.height}.png`) });
    expect(await coveredHeaderControls(page), `${size.width}x${size.height}: header controls under the drawer`).toEqual([]);
  }
});
