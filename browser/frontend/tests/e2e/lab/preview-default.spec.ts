/**
 * The release shows Preview features by default (owner decision, 6 Oct 2026; lab/fiberbrowser-pack.ts): a fresh
 * page has the switch on (the palette's toggle says so) and no preview call-to-action; turning them off is kept as the
 * user's choice. The Variants panel is supported: its tile is there either way.
 */
import { test, expect, panelButton } from '../fixtures/server';
import type { Page } from '@playwright/test';

/** Settings → Show preview features as the command palette's toggle reports it ("now on" / "now off"). */
async function previewSwitch(page: Page): Promise<string> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.getByTestId('command-palette-input').fill('preview features');
  const toggle = palette.locator('[role="option"][data-palette-item="toggle:view.preview-features"]');
  await expect(toggle).toBeVisible();
  const text = (await toggle.textContent()) ?? '';
  await page.keyboard.press('Escape');
  return /now on/.test(text) ? 'on' : /now off/.test(text) ? 'off' : text;
}

test.use({ fixtureBam: 'demo' });

test('release: Preview features are on for a fresh page, and off stays off once chosen', async ({ page, server }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!window.sessionStorage.getItem('fb-e2e-kept')) {
      window.localStorage.clear();
      window.sessionStorage.setItem('fb-e2e-kept', '1');
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await expect(panelButton(page, 'variants')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('preview-rail-hint')).toHaveCount(0);
  expect(await previewSwitch(page)).toBe('on');

  // The user turns them off: kept over the release default after a reload.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__ && localStorage.setItem('fiberbrowser_show_preview_features', 'false'));
  await page.reload();
  await page.waitForLoadState('networkidle');
  expect(await previewSwitch(page)).toBe('off');
  await expect(panelButton(page, 'variants')).toBeVisible();
  await expect(panelButton(page, 'accessibility')).toBeVisible();
  await expect(panelButton(page, 'sync-regions')).toBeVisible();
});
