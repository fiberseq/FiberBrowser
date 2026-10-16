/**
 * The top bar's Open ▾ (owner, 2026-10-02: "is there any way to get to the process dataset menu
 * outside of the welcome? and the library? those are both pretty hidden"): the main part still
 * opens the file dialog; its ▾ opens the Library, the DAF-seq run wizard, Load by path / URL
 * (with the S3 endpoint field), in light and dark, and stays in a compact (1024 px) top bar.
 */
import type { Page } from '@playwright/test';
import { expect, test, type ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const SHOTS = process.env.FIBERBROWSER_OPEN_MENU_SHOTS?.trim();

async function boot(page: Page, server: ServerFixture, dark: boolean) {
  await page.addInitScript((dark) => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    if (!sessionStorage.getItem('open-menu')) {
      localStorage.clear();
      sessionStorage.setItem('open-menu', '1');
      localStorage.setItem('fiberhmm_darkmode', String(dark));
    }
  }, dark);
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
  await page.waitForLoadState('networkidle');
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The open menu's box lies inside the window. */
async function menuOnScreen(page: Page) {
  const box = (await page.getByTestId('open-menu').boundingBox())!;
  const size = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
}

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`Open ▾: the Library and Process raw data from the top bar (${theme})`, async ({ server, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, server, dark);
    await expect(page.getByTestId('load-file-button')).toHaveText('Open');

    // ▾ → Open from Library opens the Library.
    await page.getByTestId('open-menu-button').click();
    const menu = page.getByTestId('open-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([
      /Open file…/, /Open from Library/, /Load by path \/ URL…/, /Connect to cluster…/,
      /Process raw data \(New DAF-seq run\)…/, /Data quality \(QC a dataset\)…/,
    ]);
    await menuOnScreen(page);
    await shot(page, `open-menu-1440-${theme}`);
    await menu.getByTestId('open-menu-library').click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('library-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('library-dialog')).toHaveCount(0);

    // ▾ → Process raw data opens the New DAF-seq run wizard.
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-new-daf-run').click();
    await expect(page.getByTestId('daf-run-dialog')).toBeVisible();
    await expect(page.getByTestId('daf-run-path-input')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('daf-run-dialog')).toHaveCount(0);

    // ▾ → Load by path / URL… shows both in Data & Sessions: the path field focused, the URL form open.
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-load-by-path').click();
    await expect(page.getByTestId('load-by-path-input')).toBeFocused();
    await expect(page.getByTestId('remote-url-s3-endpoint')).toBeVisible();
    await shot(page, `open-menu-load-by-path-${theme}`);
    // Again with the sidebar already there and the URL form open (another field focused): the path field again.
    await page.getByTestId('remote-url-input').focus();
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-load-by-path').click();
    await expect(page.getByTestId('load-by-path-input')).toBeFocused();
    await expect(page.getByTestId('remote-url-s3-endpoint')).toBeVisible();
  });
}

test('Open ▾ in a compact top bar (1024 px): the ▾ stays and works from the keyboard', async ({ server, page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await boot(page, server, false);
  await expect(page.getByTestId('top-nav')).toHaveAttribute('data-chrome-compact', 'true');
  await expect(page.getByTestId('load-file-button')).toHaveAccessibleName('Open file');
  const more = page.getByTestId('open-menu-button');
  await expect(more).toBeVisible();

  // Keyboard: ArrowDown opens at the first item, arrows move, Enter runs, Escape closes.
  await more.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('open-menu')).toBeVisible();
  await expect(page.getByTestId('open-menu-open-file')).toBeFocused();
  await menuOnScreen(page);
  await shot(page, 'open-menu-1024-compact');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('open-menu')).toHaveCount(0);
  await expect(more).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('open-menu-library')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('library-dialog')).toBeVisible();
});
