/**
 * Acting on reads (fb-r4-clicks).
 *
 * No click modes: a plain click or drag on the reads pans; Shift+click selects
 * a read, Cmd/Ctrl+click a footprint. Right-click opens the read menu; its
 * "Copy read name" pasted into the locus box finds the read, goes to it and
 * highlights it.
 */
import { test, expect, DEMO_FIXTURE } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const REGION = DEMO_FIXTURE.region;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function openDemo(page: any, server: any) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate((r: typeof REGION) => {
    (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end);
  }, REGION);
  const reads = page.locator('canvas[data-copilot-track="reads"]').first();
  await expect(reads).toBeVisible();
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  await expect.poll(() => reads.evaluate((el: HTMLElement) => Number(el.closest('[data-read-track-render-count]')?.getAttribute('data-read-track-render-count') ?? 0)), { timeout: 30_000 }).toBeGreaterThan(5);
  return reads;
}

const store = (page: any, pick: string) => page.evaluate((p: string) => {
  const s = (window as any).__FIBERBROWSER_STORE__.getState();
  // eslint-disable-next-line no-new-func
  return new Function('s', `return (${p})`)(s);
}, pick);

async function readPoint(reads: any, fx = 0.5, row = 2) {
  const box = (await reads.boundingBox())!;
  // The first rows sit under the dataset label and coverage histogram: go a few rows down.
  return { x: box.x + box.width * fx, y: box.y + 60 + row * 2 };
}

test('right-click a read, copy its name, paste it in the locus box: the view goes to the read and highlights it', async ({ server, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.baseUrl });
  const reads = await openDemo(page, server);

  const p = await readPoint(reads);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const menu = page.getByTestId('read-context-menu');
  await expect(menu).toBeVisible();
  // The modifier clicks are shown beside their items.
  await expect(menu.locator('[data-action="select-read"]')).toContainText('⇧-click');
  await expect(menu.locator('[data-action="select-footprint"]')).toContainText('-click');
  const name = (await page.getByTestId('read-context-menu-title').textContent())!.trim();
  expect(name).toMatch(/\/ccs$/);
  // A right-click never pans.
  expect(await store(page, 's.start')).toBe(REGION.start);

  await menu.locator('[data-action="copy-read-name"]').click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('read-action-notice')).toContainText('Read name copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(name);

  // Somewhere else first, then paste the name into the locus box.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr19', 40_000_000, 40_010_000));
  const box = page.getByTestId('location-search-input');
  await box.click();
  await box.fill('');
  await page.keyboard.press('ControlOrMeta+V');
  await expect(box).toHaveValue(name);
  // The box's suggestion list (one search for the boxes and the palette): a Read, what Enter runs.
  const readOption = page.locator('[data-testid="search-suggestion"][data-kind="read"]');
  await expect(readOption).toBeVisible();
  await expect(readOption).toHaveAttribute('data-enter', 'true');
  await box.press('Enter');

  // The read's whole span (47,514,487-47,518,985 for every demo read here) with a margin.
  await expect.poll(() => store(page, '[s.chrom, s.start < 47514487 && s.start > 47500000, s.end > 47518985 && s.end < 47530000]'), { timeout: 30_000 })
    .toEqual(['chr19', true, true]);
  await expect(page.getByTestId('location-search-info')).toContainText(name);
  // Highlighted (pulsing) in the read stack once its reads load.
  const pulse = page.locator(`[data-testid="read-highlight-pulse"][data-read-id="${name}"]`);
  await expect(pulse.first()).toBeVisible({ timeout: 30_000 });
});

test('no click modes: V does nothing, a plain click selects nothing, the shortcuts list right-click', async ({ server, page }) => {
  const reads = await openDemo(page, server);
  expect(await store(page, "'interactionMode' in s || 'setInteractionMode' in s")).toBe(false);
  await page.locator('body').press('v');
  expect(await store(page, "'interactionMode' in s")).toBe(false);

  const p = await readPoint(reads);
  await page.mouse.click(p.x, p.y);
  expect(await store(page, 'Object.values(s.selectedReadIds).reduce((n, v) => n + v.size, 0)')).toBe(0);
  expect(await store(page, 's.selectedFootprints.length')).toBe(0);
  // The first click on reads says what clicks do (once).
  await expect(page.getByTestId('read-actions-hint')).toContainText('Right-click a read for actions');
  await page.getByTestId('read-actions-hint').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('read-actions-hint')).toHaveCount(0);

  await page.locator('body').press('?');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/Right-click/);
  await expect(dialog).toContainText(/Shift\+click read/);
  await expect(dialog).not.toContainText(/click mode/i);
});

test('Shift+click selects a read (Read Stats); Cmd/Ctrl+click selects a footprint (Footprints)', async ({ server, page }) => {
  const reads = await openDemo(page, server);
  const p = await readPoint(reads);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  await expect.poll(() => store(page, 'Object.values(s.selectedReadIds).reduce((n, v) => n + v.size, 0)')).toBe(1);
  expect(await store(page, 's.selectedFootprints.length')).toBe(0);

  // A footprint somewhere along a read: try a few places on a few rows.
  let selected = 0;
  outer: for (const row of [2, 6, 10, 14]) {
    for (const fx of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const q = await readPoint(reads, fx, row);
      await page.mouse.move(q.x, q.y);
      await page.keyboard.down(MOD);
      await page.mouse.click(q.x, q.y);
      await page.keyboard.up(MOD);
      selected = await store(page, 's.selectedFootprints.length');
      if (selected > 0) break outer;
    }
  }
  expect(selected).toBeGreaterThan(0);
  // The view did not pan on any of these clicks.
  expect(await store(page, 's.start')).toBe(REGION.start);
});

// Audit M9 / Codex 16: "Exclude selected reads" is an undo step (and Show too).
test('Exclude selected reads is undoable: Undo shows them again, Redo hides them again', async ({ server, page }) => {
  const reads = await openDemo(page, server);
  const p = await readPoint(reads);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  await expect.poll(() => store(page, 'Object.values(s.selectedReadIds).reduce((n, v) => n + v.size, 0)')).toBe(1);

  // Selecting opened Read Stats (the layout may have moved): right-click the reads where they are now.
  await page.waitForTimeout(500);
  const q = await readPoint(reads);
  await page.mouse.click(q.x, q.y, { button: 'right' });
  const menu = page.getByTestId('read-context-menu');
  await menu.locator('[data-action="exclude-selected"]').click();
  const chip = page.locator('[data-testid^="excluded-reads-"]');
  await expect(chip).toContainText('1 excluded');
  await expect(page.getByTestId('quick-undo-button')).toBeEnabled();

  await page.getByTestId('quick-undo-button').click();
  await expect(chip).toHaveCount(0);
  await page.getByTestId('quick-redo-button').click();
  await expect(chip).toContainText('1 excluded');

  // The chip's Show is a step too.
  await chip.getByRole('button', { name: 'Show' }).click();
  await expect(chip).toHaveCount(0);
  await page.getByTestId('quick-undo-button').click();
  await expect(chip).toContainText('1 excluded');
});
