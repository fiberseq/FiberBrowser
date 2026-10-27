/**
 * Per-panel tracks (fb-n11-tracks), as the owner asked:
 * - the SV track is a standard track: resized (its arcs grow with it), deleted
 *   and restored from "Tracks in this panel";
 * - the panel header shows ×, − and expand (and Tracks) without "…" when there is room;
 * - right-clicking a track with no menu of its own (the metaprofile) opens one
 *   that leads to the relevant panels.
 */
import { test, expect, type ServerFixture } from './fixtures/server';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SV_VIEW = { chrom: 'chrSV', start: 8_000, end: 16_000 };
const SIZES = [{ width: 1024, height: 700 }, { width: 1280, height: 800 }, { width: 1728, height: 1080 }];

async function open(page: Page, url: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    if (!sessionStorage.getItem('panel-tracks')) {
      localStorage.clear();
      sessionStorage.setItem('panel-tracks', '1');
    }
  });
  await page.goto(url);
  await expect(page.locator('canvas[data-copilot-track="reads"]').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
}

/** Rows (px from the canvas top) holding the deletion red in the SV track. */
async function redRows(page: Page): Promise<{ height: number; top: number; bottom: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-testid^="sv-track-canvas-"]') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const ratio = canvas.width / canvas.clientWidth;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let top = Infinity;
    let bottom = -Infinity;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) { top = Math.min(top, y); bottom = Math.max(bottom, y); break; }
      }
    }
    return { height: canvas.clientHeight, top: top / ratio, bottom: bottom / ratio };
  });
}

test.describe('the SV track', () => {
  test.use({
    fixtureBam: async ({}, use) => {
      const bam = path.join(mkdtempSync(path.join(tmpdir(), 'fiberbrowser-sv-')), 'sv_demo.bam');
      execFileSync(process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python',
        [path.join(REPO_ROOT, 'tests', 'make_sv_demo_bam.py'), bam], { stdio: 'inherit' });
      await use(bam);
    },
  } as never);

  test('minimizing tracks shares visibility, keeps picker heights aligned and restores from the menu with the strip off', async ({ page, server }) => {
    await page.setViewportSize({ width: 1728, height: 1080 });
    await open(page, `${(server as ServerFixture).baseUrl}/?chr=${SV_VIEW.chrom}&start=${SV_VIEW.start}&end=${SV_VIEW.end}`);
    await page.evaluate(() => {
      const s = (window as any).__FIBERBROWSER_STORE__.getState();
      s.duplicatePanel(s.panels.find((p: any) => p.contentType === 'dataset').id);
    });
    const rows = page.locator('[data-track-type="sv"]');
    await expect(rows).toHaveCount(2);
    await rows.first().hover();
    await page.getByTestId('track-hide-sv').first().click();
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('hidden-track-restore-sv')).toHaveCount(2);
    await page.getByTestId('hidden-track-restore-sv').first().click();
    await expect(rows).toHaveCount(2);
    await rows.first().hover();
    await page.getByTestId('track-hide-sv').first().click({ modifiers: ['Alt'] });
    await expect(rows).toHaveCount(1);
    const strips = page.locator('[data-testid^="hidden-track-strip-"]');
    await expect(strips).toHaveCount(2);
    expect((await strips.nth(0).boundingBox())!.height).toBe((await strips.nth(1).boundingBox())!.height);
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setShowHiddenTrackStrip(false));
    await expect(strips).toHaveCount(0);
    await page.locator('[data-tour="panel-subtracks"]:visible').first().click();
    // The SV track's label is "Differences" since the Differences tracks were unified.
    await page.getByRole('checkbox', { name: 'Show Differences', exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(rows).toHaveCount(2);
  });

  for (const size of SIZES) {
    test(`resizes (content grows), deletes and restores from "Tracks in this panel" at ${size.width}x${size.height}`, async ({ page, server }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      await open(page, `${(server as ServerFixture).baseUrl}/?chr=${SV_VIEW.chrom}&start=${SV_VIEW.start}&end=${SV_VIEW.end}`);
      const row = page.locator('[data-track-type="sv"]').first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await redRows(page)).bottom, { timeout: 15_000 }).toBeGreaterThan(0);
      const before = await redRows(page);
      const arcBefore = before.bottom - before.top;

      // Drag its bottom edge down 80 px.
      await row.hover();
      const handle = row.locator('[title="Resize Differences"]');  // the SV track's label since the Differences tracks
      const hb = (await handle.boundingBox())!;
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 40, { steps: 4 });
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 80, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => (await redRows(page)).height, { timeout: 10_000 }).toBeGreaterThan(before.height + 60);
      const after = await redRows(page);
      // The arc grows with the row: no fixed-pixel band in a taller box.
      expect(after.bottom - after.top).toBeGreaterThan(arcBefore + 40);
      const saved = await page.evaluate(() => {
        const s = (window as any).__FIBERBROWSER_STORE__.getState();
        return s.panels.find((p: any) => p.contentType === 'dataset').subTracks.find((t: any) => t.type === 'sv').heightOverride;
      });
      expect(saved).toBeGreaterThan(before.height + 60);

      // Delete it from "Tracks in this panel" (the header's Tracks button), then restore it.
      const tracksButton = page.locator('[data-testid^="panel-tracks-"]').first();
      if (await tracksButton.count()) await tracksButton.click();
      else {
        await page.locator('[data-testid^="panel-actions-"]').first().click();
        await page.locator('[role="menu"] [data-tour="panel-subtracks"]').click();
      }
      const menu = page.locator('[data-testid^="panel-tracks-menu-"]');
      await expect(menu).toBeVisible();
      await menu.getByTestId('panel-track-remove-sv').click();
      await expect(page.locator('[data-track-type="sv"]')).toHaveCount(0);
      await menu.getByTestId('panel-track-restore-sv').click();
      await expect(page.locator('[data-track-type="sv"]')).toHaveCount(1);
      // Restored at the height it had.
      await expect.poll(async () => (await redRows(page)).height).toBe(after.height);
    });
  }
});

test.describe('panel header and track menus (demo data)', () => {
  test.use({ fixtureBam: 'demo' });

  test('at 1280 px the header shows close, minimise and expand without "…"', async ({ page, server }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, server.baseUrl);
    const header = page.locator('[data-testid^="dataset-header-"]').first();
    for (const tour of ['panel-close', 'panel-minimize', 'panel-full-view', 'panel-subtracks']) {
      await expect(header.locator(`[data-tour="${tour}"]`), tour).toBeVisible();
    }
    await expect(header.locator('[data-testid^="panel-tracks-"]')).toContainText('Tracks');
    await header.locator('[data-tour="panel-full-view"]').click();
    expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().fullViewPanelId)).toBeTruthy();
    await header.locator('[data-tour="panel-full-view"]').click();
    expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().fullViewPanelId)).toBeNull();
  });

  test('a narrow panel keeps close / minimise / expand and puts the rest in "…"', async ({ page, server }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1024, height: 700 });
    await open(page, server.baseUrl);
    // Two datasets side by side, then a third: narrow headers.
    for (let i = 0; i < 2; i++) {
      const header = page.locator('[data-testid^="dataset-header-"]').first();
      const add = header.locator('[data-tour="panel-add-copy"]');
      if (await add.count()) await add.click();
      else {
        await header.locator('[data-testid^="panel-actions-"]').click();
        await page.locator('[role="menu"] [data-tour="panel-add-copy"]').click();
      }
    }
    await expect(page.locator('[data-testid^="dataset-header-"]')).toHaveCount(3);
    const header = page.locator('[data-testid^="dataset-header-"]').last();
    for (const tour of ['panel-close', 'panel-minimize', 'panel-full-view']) {
      await expect(header.locator(`[data-tour="${tour}"]`), tour).toBeVisible();
    }
    const more = header.locator('[data-testid^="panel-actions-"]');
    if (await more.count()) {
      await more.click();
      await expect(page.locator('[role="menu"] [data-tour="panel-add-copy"]')).toBeVisible();
    }
  });

  test('right-clicking the metaprofile opens its menu, which opens Rules', async ({ page, server }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, server.baseUrl);
    const meta = page.locator('[data-track-type^="composite-"]').first();
    await expect(meta).toBeVisible({ timeout: 15_000 });
    await meta.click({ button: 'right', position: { x: 300, y: 20 } });
    const menu = page.getByTestId('track-context-menu');
    await expect(menu).toBeVisible();
    for (const item of ['Rules', 'Labeling', 'Set height…', 'Tracks in this panel…']) {
      await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
    }
    await menu.getByRole('menuitem', { name: 'Rules', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels
      .some((p: any) => p.contentType === 'cluster-features'))).toBe(true);

    // "Tracks in this panel…" from a track's menu opens the header's list.
    await meta.click({ button: 'right', position: { x: 300, y: 20 } });
    await page.getByTestId('track-context-menu').getByRole('menuitem', { name: 'Tracks in this panel…' }).click();
    await expect(page.locator('[data-testid^="panel-tracks-menu-"]')).toBeVisible();
  });
});
