/**
 * Opening files, every way in (owner, 2026-10-01): "if I load BAIs with BAMs by mistake nothing
 * opens and there is no error. Previously it would open the BAMs and then complain. Need to make
 * sure that errors occur and that any files that can load do load."
 *
 * - Load File (toolbar) and File > Open (the command bus; the desktop app's own dialog through its
 *   JS bridge, window.pywebview.api.pick_files), drag-and-drop (uploads in a web browser, real
 *   paths in the app), Load by path (typed or pasted), and the Library's Add files (the Library
 *   opens from the intro screen beside Load a file, and from the analysis strip).
 * - A BAM with its .bai/.csi opens and the index is used; an index alone, a CRAM or an unknown
 *   file is named with the reason; one bad file never blocks the others.
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { DEMO_FIXTURE, expect, test, type ServerFixture, panelButton, TEST_PANEL_LAUNCHER } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

/** A folder with sampleA.bam + .bam.bai, sampleB.bam + .bai, an orphan index, a CRAM and a text file. */
function selectionFolder() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-open-'));
  const put = (name: string, from: string) => copyFileSync(from, path.join(dir, name));
  put('sampleA.bam', DEMO_FIXTURE.bamPath);
  put('sampleA.bam.bai', `${DEMO_FIXTURE.bamPath}.bai`);
  put('sampleB.bam', DEMO_FIXTURE.bamPath);
  put('sampleB.bai', `${DEMO_FIXTURE.bamPath}.bai`);
  put('orphan.bam.bai', `${DEMO_FIXTURE.bamPath}.bai`);
  writeFileSync(path.join(dir, 'reads.cram'), 'CRAM');
  writeFileSync(path.join(dir, 'notes.txt'), 'not data');
  const p = (name: string) => path.join(dir, name);
  return { dir, p };
}

async function boot(page: Page, server: ServerFixture) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
  await page.waitForLoadState('networkidle');
}

const opened = (page: Page) => page.evaluate(() =>
  (window as any).__FIBERBROWSER_STORE__.getState().datasets.map((d: any) => d.id).sort());
const errorText = (page: Page) => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().error as string | null);

test('Load File: BAMs with their indexes open; every file that cannot is named', async ({ server, page }) => {
  const { p } = selectionFolder();
  const chosen = [p('sampleA.bam'), p('sampleA.bam.bai'), p('sampleB.bai'), p('sampleB.bam'),
    p('orphan.bam.bai'), p('reads.cram'), p('notes.txt')];
  await page.route('**/api/pick_file**', route => route.fulfill({ json: { success: true, path: chosen[0], paths: chosen } }));
  await boot(page, server);

  // Just the BAMs and their indexes: both open, no error.
  await page.route('**/api/pick_file**', route => route.fulfill({ json: { success: true, path: chosen[0], paths: chosen.slice(0, 4) } }));
  await page.getByTestId('load-file-button').click();
  await expect.poll(() => opened(page), { timeout: 30_000 }).toEqual(['napa_ddda', 'sampleA', 'sampleB']);
  expect(await errorText(page)).toBeNull();

  // With files that can't open: named, each with its reason, in one banner.
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    for (const id of ['sampleA', 'sampleB']) s.removeDataset(id);
  });
  await page.request.delete(`${server.baseUrl}/api/datasets/sampleA`);
  await page.request.delete(`${server.baseUrl}/api/datasets/sampleB`);
  await page.unroute('**/api/pick_file**');
  await page.route('**/api/pick_file**', route => route.fulfill({ json: { success: true, path: chosen[0], paths: chosen } }));
  await page.getByTestId('load-file-button').click();
  await expect.poll(() => opened(page), { timeout: 30_000 }).toEqual(['napa_ddda', 'sampleA', 'sampleB']);
  const banner = page.getByText(/files could not be opened/);
  await expect(banner).toBeVisible();
  const error = (await errorText(page)) ?? '';
  expect(error).toMatch(/^3 of 5 files could not be opened:/);
  expect(error).toContain('orphan.bam.bai: this is a BAM index file, not a file to open on its own. Open orphan.bam instead');
  expect(error).toContain("reads.cram: CRAM files can't be opened; convert to BAM first");
  expect(error).toContain('notes.txt: not a file type FiberBrowser opens.');
  expect(error).not.toContain('sampleA.bam.bai');
  expect(error).not.toContain('sampleB.bai');
});

test('File > Open in the desktop app: its own dialog (JS bridge), same result', async ({ server, page }) => {
  const { p } = selectionFolder();
  const chosen = [p('sampleA.bam'), p('sampleA.bam.bai'), p('orphan.bam.bai')];
  let serverDialogs = 0;
  await page.route('**/api/pick_file**', route => { serverDialogs += 1; return route.fulfill({ json: { success: false, cancelled: true } }); });
  await page.addInitScript(paths => {
    // What pywebview injects in the app: window.pywebview.api.<method> -> Promise.
    (window as any).pywebview = { api: { pick_files: async (type: string, multiple: boolean) => {
      (window as any).__pickedWith = [type, multiple];
      return { success: true, path: paths[0], paths };
    } } };
  }, chosen);
  await boot(page, server);
  // File > Open File… (Cmd+O) runs this in the front window (fiberbrowser/app_menu.py).
  expect(await page.evaluate(() => window.fiberbrowserCommand!('open-file'))).toBe(true);
  await expect.poll(() => opened(page), { timeout: 30_000 }).toEqual(['napa_ddda', 'sampleA']);
  expect(await page.evaluate(() => (window as any).__pickedWith)).toEqual(['open', true]);
  expect(serverDialogs).toBe(0);
  expect(await errorText(page)).toContain('orphan.bam.bai: this is a BAM index file');
  expect(await errorText(page)).not.toContain('sampleA.bam.bai');
});

async function dropFiles(page: Page, files: Array<{ name: string; from?: string; text?: string }>) {
  const payload = files.map(f => ({ name: f.name, b64: f.from ? readFileSync(f.from).toString('base64') : Buffer.from(f.text ?? '').toString('base64') }));
  const dt = await page.evaluateHandle(items => {
    const dt = new DataTransfer();
    for (const item of items) dt.items.add(new File([Uint8Array.from(atob(item.b64), c => c.charCodeAt(0))], item.name));
    return dt;
  }, payload);
  const target = page.locator('[data-browser-root]');
  await target.dispatchEvent('dragenter', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
}

test('drag-and-drop: a BAM with its index opens; the index and a CRAM are not uploaded', async ({ server, page }) => {
  await boot(page, server);
  const uploads: string[] = [];
  page.on('response', async res => {
    if (res.url().includes('/api/files/upload')) uploads.push((await res.json().catch(() => ({}))).filename ?? '?');
  });
  await dropFiles(page, [
    { name: 'dropA.bam.bai', from: `${DEMO_FIXTURE.bamPath}.bai` },
    { name: 'dropA.bam', from: DEMO_FIXTURE.bamPath },
    { name: 'reads.cram', text: 'CRAM' },
  ]);
  await expect.poll(() => opened(page), { timeout: 30_000 }).toEqual(['dropA', 'napa_ddda']);
  await expect.poll(() => errorText(page)).toContain("reads.cram: CRAM files can't be opened");
  expect(await errorText(page)).not.toContain('dropA');
  expect(uploads).toEqual(['dropA.bam']);
});

test('drag-and-drop in the desktop app opens the real paths, no upload', async ({ server, page }) => {
  const { p } = selectionFolder();
  await boot(page, server);
  const uploads: string[] = [];
  page.on('request', req => { if (req.url().includes('/api/files/upload')) uploads.push(req.url()); });
  // fiberbrowser/desktop.py: sets the flag after registering its drop listener, then sends each
  // drop's paths with the native-drop command.
  await page.evaluate(() => { (window as any).__fiberbrowserNativeDrop = true; });
  await dropFiles(page, [{ name: 'sampleA.bam', text: 'bytes the app never uploads' }, { name: 'sampleA.bam.bai', text: '' }]);
  await page.evaluate(files => window.fiberbrowserCommand!('native-drop', { files }), [
    { name: 'sampleA.bam', path: p('sampleA.bam') }, { name: 'sampleA.bam.bai', path: p('sampleA.bam.bai') },
  ]);
  await expect.poll(() => opened(page), { timeout: 30_000 }).toEqual(['napa_ddda', 'sampleA']);
  expect(await errorText(page)).toBeNull();
  expect(uploads).toEqual([]);
});

test('Load by path: an index alone is explained; several pasted paths open together', async ({ server, page }) => {
  const { p } = selectionFolder();
  await boot(page, server);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: 'file', subsectionId: 'file.loadpath' },
  })));
  const input = page.getByTestId('load-by-path-input');
  await expect(input).toBeVisible();

  await input.fill(p('sampleB.bai'));
  await input.press('Enter');
  await expect.poll(() => errorText(page)).toContain('sampleB.bai: this is a BAM index file, not a file to open on its own. Open sampleB.bam instead');
  expect(await opened(page)).toEqual(['napa_ddda']);

  // Paste a BAM, its index and a CRAM, one per line.
  await input.fill('');
  await input.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [p('sampleA.bam'), p('sampleA.bam.bai'), p('reads.cram')].join('\n'));
  await expect.poll(() => opened(page), { timeout: 30_000 }).toEqual(['napa_ddda', 'sampleA']);
  await expect.poll(() => errorText(page)).toContain("reads.cram: CRAM files can't be opened");
  expect(await errorText(page)).not.toContain('sampleA.bam.bai');
});

// Owner, 1 Oct: the Library as an alternative to Load File, on the intro screen and among the panels.
test('Open from Library: beside Load a file on the intro screen, and in the analysis strip', async ({ server, page }) => {
  await boot(page, server);
  // The intro screen: no dataset open (and not dismissed this session).
  await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    for (const d of [...s.datasets]) s.removeDataset(d.id);
  });
  const welcome = page.getByTestId('welcome-card');
  await expect(welcome).toBeVisible();
  const load = welcome.getByTestId('welcome-load-file-cta');
  const library = welcome.getByTestId('welcome-library-cta');
  await expect(library).toBeVisible();
  await expect(library).toContainText('Open from Library');
  // Side by side: the same row, the same size.
  const [a, b] = [(await load.boundingBox())!, (await library.boundingBox())!];
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(Math.abs(a.height - b.height)).toBeLessThan(2);
  expect(b.x).toBeGreaterThan(a.x);
  await library.click();
  const dialog = page.getByTestId('library-dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // In a short window (1024 x 600) the taller card still fits: its × is on screen and works.
  await page.setViewportSize({ width: 1024, height: 600 });
  const dismiss = welcome.getByLabel('Dismiss welcome screen');
  // Measured once the page has laid out at the new size (both boxes in the same frame, after any transition): two
  // boxes read one after the other right after the resize could come from two layouts (the e2e flake: × above the card).
  const boxes = () => welcome.evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => null)));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const card = el.getBoundingClientRect();
    const x = el.querySelector('[aria-label="Dismiss welcome screen"]')!.getBoundingClientRect();
    return { top: card.top, bottom: card.bottom, xTop: x.top, viewport: window.innerHeight };
  });
  await expect.poll(async () => (await boxes()).viewport).toBe(600);
  await expect.poll(async () => { const b = await boxes(); return b.top >= 0 && b.bottom <= 600 && b.xTop >= b.top; }).toBe(true);
  const card = await boxes();
  expect(card.top).toBeGreaterThanOrEqual(0);
  expect(card.bottom).toBeLessThanOrEqual(600);
  expect(card.xTop).toBeGreaterThanOrEqual(card.top);

  // The analysis strip's Library chip opens the same window (it is not a panel).
  // It sits right before Tracks (Library · Tracks), shown or in More (owner, 2 Oct).
  await dismiss.click();
  if (TEST_PANEL_LAUNCHER === 'strip') {
    const shown = await page.getByTestId('analysis-strip-chips').evaluate(row =>
      Array.from(row.querySelectorAll(':scope > div > button')).map(el => el.getAttribute('data-testid')));
    const at = shown.indexOf('analysis-strip-library');
    if (at >= 0) {
      // Tracks right after it, or (the strip cut between the two) first in More.
      if (shown[at + 1] === 'analysis-strip-more') await expect(page.getByTestId('analysis-strip-more')).toHaveAttribute('title', /^More: Tracks/);
      else expect(shown[at + 1]).toBe('analysis-strip-button-track-browser');
    } else {
      // In More, and Tracks (after it) with it.
      await expect(page.getByTestId('analysis-strip-more')).toHaveAttribute('title', /Library, Tracks/);
    }
  } else {
    // The rail: the Library tile right after Tracks (PanelRail.railLaunchers).
    const tiles = await page.locator('[data-testid="panel-rail-launchers"] [data-rail-tile]').evaluateAll(els =>
      els.map(el => el.getAttribute('data-testid')));
    expect(tiles[tiles.indexOf('panel-rail-track-browser') + 1]).toBe('panel-rail-library');
  }
  const panelsBefore = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.length);
  await panelButton(page, 'library').click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.length)).toBe(panelsBefore);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('Library Add files: an index chosen with its BAM is not an error; the in-page dialog filters by type', async ({ server, page }) => {
  const { p } = selectionFolder();
  await page.route('**/api/pick_file**', route => route.fulfill({ json: {
    success: true, path: p('sampleA.bam'), paths: [p('sampleA.bam'), p('sampleA.bam.bai')] } }));
  await boot(page, server);
  expect(await page.evaluate(() => window.fiberbrowserCommand!('library'))).toBe(true);
  const dialog = page.getByTestId('library-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('library-add-files').click();
  await expect(dialog.getByTestId('library-status')).toHaveText('Added 1 file(s).');

  // The in-page file browser (remote pages, or no native dialog): Supported files by default, All files on request.
  await page.unroute('**/api/pick_file**');
  await page.route('**/api/pick_file**', route => route.fulfill({ json: { success: false, cancelled: false, message: 'no display' } }));
  await page.route('**/api/files/list**', route => route.fulfill({ json: {
    success: true, path: '/data', parent: '/', home: '/data',
    entries: ['run1', 'a.bam', 'a.bam.bai', 'notes.txt', 'peaks.bed'].map(name => ({
      name, path: `/data/${name}`, is_dir: name === 'run1', size: name === 'run1' ? null : 10 })),
  } }));
  await dialog.getByTestId('library-add-files').click();
  const browser = page.getByTestId('server-file-browser');
  await expect(browser).toBeVisible();
  const names = () => browser.getByTestId('server-file-entry').allInnerTexts();
  // Picking datasets: Supported files lists the folder and the BAM (not its index, a BED or a text file).
  await expect.poll(async () => (await names()).map(n => n.split('\n')[0].trim())).toEqual(['run1', 'a.bam']);
  await browser.getByTestId('server-file-filter').selectOption({ label: 'All files' });
  await expect.poll(async () => (await names()).length).toBe(5);
  await browser.getByRole('button', { name: 'Cancel' }).click();
});
