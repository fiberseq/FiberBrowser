/**
 * The command palette (fb-r4-palette): Cmd/Ctrl+K, a setting found by a word
 * and switched in place, a gene typed and gone to, and the settings sidebar's
 * search filtering live (falling back to the palette).
 *
 * Screenshots go to FB_PALETTE_SHOTS when set.
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SHOTS = process.env.FB_PALETTE_SHOTS?.trim();
const HG38_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'hg38.fa.fai'));

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function open(page: Page, url: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(url);
  await page.waitForLoadState('networkidle');
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

const palette = (page: Page) => page.getByTestId('command-palette');
const paletteInput = (page: Page) => page.getByTestId('command-palette-input');
const option = (page: Page, id: string) => palette(page).locator(`[role="option"][data-palette-item="${id}"]`);

test('Cmd/Ctrl+K: "terminal" finds the setting, switches it, and shows it in the sidebar', async ({ server, page }) => {
  await open(page, server.baseUrl);
  await expect(page.getByTestId('command-palette-button')).toBeVisible();
  // Let the page settle (data loaded, the first history snapshot taken).
  await expect.poll(() => store(page, s => s.datasets.length)).toBeGreaterThan(0);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await expect(palette(page)).toHaveAttribute('role', 'dialog');
  await expect(paletteInput(page)).toBeFocused();

  await paletteInput(page).fill('terminal');
  const setting = option(page, 'setting:view.hide-terminal-gaps');
  const toggle = option(page, 'toggle:view.hide-terminal-gaps');
  await expect(setting).toHaveAttribute('aria-selected', 'true');
  await expect(toggle).toContainText(/Turn (on|off): Hide terminal gaps/);
  const turnOn = (await toggle.textContent())!.includes('Turn on');
  await shot(page, 'palette_terminal.png');

  // The Turn on/off item: the setting flips and the palette stays open, saying so. (The pointer is then left over the
  // toggle row: the arrow keys below must keep their choice when the row's words change under it.)
  await toggle.click();
  await expect.poll(() => store(page, s => s.hideTerminalGaps)).toBe(turnOn);
  await expect(page.getByTestId('command-palette-status')).toHaveText(`Hide terminal gaps: ${turnOn ? 'on' : 'off'}`);
  await expect(toggle).toContainText(`Turn ${turnOn ? 'off' : 'on'}: Hide terminal gaps`);
  // Cmd/Ctrl+Enter on the setting flips it back.
  await paletteInput(page).press('ArrowUp');
  await expect(setting).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => store(page, s => s.hideTerminalGaps)).toBe(!turnOn);

  // Enter on the setting opens the sidebar at it, highlighted.
  await paletteInput(page).fill('terminal gaps');
  await expect(setting).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  const anchor = page.getByTestId('settings-sidebar').locator('[data-setting-id="view.hide-terminal-gaps"]');
  await expect(anchor).toHaveAttribute('data-setting-revealed', '');
  await expect(anchor).toBeVisible();
  await expect(anchor).toBeInViewport();
  await shot(page, 'palette_setting_revealed.png');

  // A toolbar setting opens its group; Escape closes and nothing else happens.
  await page.keyboard.press('ControlOrMeta+k');
  await paletteInput(page).fill('row height');
  await expect(option(page, 'setting:toolbar.row-height')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toolbar-group-reads')).toHaveAttribute('data-open', 'true');
  await page.keyboard.press('ControlOrMeta+k');
  await paletteInput(page).fill('r');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
});

test('the top bar button and the shortcuts dialog open it; actions show their keys', async ({ server, page }) => {
  await open(page, server.baseUrl);
  await page.getByTestId('command-palette-button').click();
  await expect(palette(page)).toBeVisible();
  await paletteInput(page).fill('reset view');
  const reset = option(page, 'cmd:reset-view');
  await expect(reset).toHaveAttribute('aria-selected', 'true');
  await expect(reset.locator('kbd')).toHaveText('R');
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  await expect(page.getByTestId('keyboard-shortcuts-dialog')).toBeVisible();
  await page.getByTestId('shortcuts-open-palette').click();
  await expect(page.getByTestId('keyboard-shortcuts-dialog')).toHaveCount(0);
  await expect(palette(page)).toBeVisible();
  // Panels: open one by name.
  await paletteInput(page).fill('footprints panel');
  await expect(option(page, 'panel:footprint-analysis')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(() => store(page, s => s.panels.some((p: any) => p.contentType === 'footprint-analysis' && !p.collapsed))).toBe(true);
});

test.describe('genes', () => {
  test.use({ fixtureBam: 'demo' });

  test('typing a gene offers Go to, and Enter goes there', async ({ server, page }) => {
    const status = await (await page.request.get(`${server.baseUrl}/api/status`)).json();
    if (status.current_genome !== 'hg38') {
      test.skip(!HG38_CACHED, 'needs hg38 in ~/.fiberhmm/genomes (not downloaded by tests)');
      test.setTimeout(180_000);
      expect((await (await page.request.post(`${server.baseUrl}/api/load_genome?genome_id=hg38`)).json()).success).toBe(true);
    }
    const gene = await (await page.request.get(`${server.baseUrl}/api/gene_search?query=NAPA`)).json();
    test.skip(!gene.found, 'the hg38 annotation has no NAPA here');

    await open(page, `${server.baseUrl}/?chrom=chr19&start=47000000&end=47004000`);
    await page.keyboard.press('ControlOrMeta+k');
    await paletteInput(page).fill('NAPA');
    const go = option(page, 'goto:gene:NAPA');
    await expect(go).toBeVisible({ timeout: 15_000 });
    await expect(go).toHaveAttribute('aria-selected', 'true');
    await expect(go).toContainText('Go to NAPA');
    await shot(page, 'palette_gene.png');
    await page.keyboard.press('Enter');
    await expect.poll(() => store(page, s => [s.chrom, s.start, s.end])).toEqual([gene.chrom, gene.start, gene.end]);

    // Coordinates too.
    await page.keyboard.press('ControlOrMeta+k');
    await paletteInput(page).fill('chr19:47,515,000-47,516,000');
    await expect(option(page, 'goto:locus:chr19:47515000-47516000')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect.poll(() => store(page, s => [s.chrom, s.start, s.end])).toEqual(['chr19', 47_515_000, 47_516_000]);
  });
});

test('the settings search filters the sidebar live and falls back to the palette', async ({ server, page }) => {
  await open(page, server.baseUrl);
  await page.getByTestId('settings-rail-file').click();
  const sidebar = page.getByTestId('settings-sidebar');
  await expect(sidebar).toBeVisible();
  const field = page.getByTestId('settings-search-input');
  await expect(field).toBeVisible();

  await field.fill('duplicate');
  await expect(sidebar.locator('[data-setting-id="view.show-duplicate-reads"]')).toBeVisible();
  // Every page with a match, under a heading of its own (here only Reads & Display).
  await expect(sidebar.getByRole('heading', { name: 'Reads & Display' })).toBeVisible();
  await expect(sidebar.getByRole('heading', { name: 'Data & Sessions' })).toHaveCount(0);
  await expect(sidebar.locator('[data-setting-id="view.fill-gaps"]')).toBeHidden();
  await shot(page, 'settings_search.png');

  // A setting in a closed fold ("Exact limits") is shown.
  await field.fill('display max');
  await expect(sidebar.locator('[data-setting-id="view.display-max"]')).toBeVisible();

  // Matches elsewhere are listed with Show.
  await field.fill('edges');
  await expect(page.getByTestId('settings-search-elsewhere')).toContainText('Footprint edges');

  await field.fill('qqqzzz');
  await expect(page.getByTestId('settings-search-empty')).toBeVisible();
  await page.getByTestId('settings-search-try-palette').click();
  await expect(palette(page)).toBeVisible();
  await expect(paletteInput(page)).toHaveValue('qqqzzz');
  await page.keyboard.press('Escape');

  // Cleared: back to the page picked in the rail.
  await field.fill('');
  await expect(page.getByTestId('settings-sidebar-title')).toHaveText('Data & Sessions');
  await expect(sidebar.getByRole('heading', { name: 'Reads & Display' })).toHaveCount(0);
});
