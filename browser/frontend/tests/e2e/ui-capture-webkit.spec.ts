import { test, expect } from './fixtures/server';
import { webkit, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Export → Image → Capture full UI in WebKit (Safari, the desktop app's window).
 * WebKit's first draw of html-to-image's SVG leaves every canvas blank, so a full UI
 * capture came out with headers and controls but no reads. Chromium never showed it
 * (export-read-ink.spec.ts covers full UI capture there).
 */
// launchOptions: {} drops a Chromium executable set by FIBERBROWSER_PLAYWRIGHT_EXECUTABLE.
test.use({ browserName: 'webkit', fixtureBam: 'demo', launchOptions: {} });

const DEMO = { chrom: 'chr19', start: 47_514_000, end: 47_518_000 };

async function open(page: Page, baseUrl: string) {
  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}/?chrom=${DEMO.chrom}&start=${DEMO.start}&end=${DEMO.end}`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => !!window.__FIBERBROWSER_STORE__?.getState().datasets.length);
  // Two panels side by side.
  await page.evaluate(region => {
    const store = window.__FIBERBROWSER_STORE__!;
    const panel = store.getState().panels.find(p => p.contentType === 'dataset')!;
    const panels = Array.from({ length: 2 }, (_, i) => ({
      ...panel, id: `cap-${i}`, stateKey: `cap-${i}`, layoutRow: 0, layoutColumn: i, widthFraction: 0.5,
      subTracks: panel.subTracks.filter(t => ['axis', 'reads'].includes(t.type)),
    }));
    store.setState({ panels, slotOrder: panels.map(p => p.id), readDisplayMode: 'sample', readRowHeight: 3 });
    store.getState().setViewport(region.chrom, region.start, region.end);
  }, DEMO);
  await expect(page.locator('[data-read-track-dataset-id]')).toHaveCount(2);
  await expect.poll(() => page.locator('[data-read-track-dataset-id]').evaluateAll(tracks =>
    tracks.every(t => t.getAttribute('data-read-track-loading') === 'false'
      && Number(t.getAttribute('data-read-track-render-count')) > 0)), { timeout: 60_000 }).toBe(true);
}

/** Read colour in each read track's box of the captured window image (PNG, or the image inside an SVG). */
async function readInk(page: Page, file: string): Promise<number[]> {
  const boxes = await page.locator('[data-read-track-dataset-id]').evaluateAll(tracks => {
    const root = document.querySelector('[data-browser-root]')!.getBoundingClientRect();
    return tracks.map(t => {
      const r = t.getBoundingClientRect();
      return { x: (r.left - root.left) / root.width, y: (r.top - root.top) / root.height,
        w: r.width / root.width, h: Math.min(r.height, innerHeight - r.top) / root.height };
    });
  });
  const isSvg = file.endsWith('.svg');
  return page.evaluate(async ({ data, isSvg, boxes }) => {
    const src = isSvg
      ? (() => { const el = new DOMParser().parseFromString(atob(data), 'image/svg+xml').querySelector('image')!;
        return el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')!; })()
      : `data:image/png;base64,${data}`;
    const image = new Image(); image.src = src; await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    return boxes.map(b => {
      const px = ctx.getImageData(Math.floor(b.x * canvas.width), Math.floor(b.y * canvas.height),
        Math.max(1, Math.floor(b.w * canvas.width)), Math.max(1, Math.floor(b.h * canvas.height))).data;
      let colored = 0;
      for (let i = 0; i < px.length; i += 4) {
        const hi = Math.max(px[i], px[i + 1], px[i + 2]), lo = Math.min(px[i], px[i + 1], px[i + 2]);
        if (hi - lo > 30 && lo < 210) colored++;
      }
      return colored / (px.length / 4);
    });
  }, { data: readFileSync(file).toString('base64'), isSvg, boxes });
}

test('full UI capture contains the reads in every panel (WebKit)', async ({ page, server, browserName }, info) => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed (npx playwright install webkit)');
  expect(browserName).toBe('webkit');
  test.setTimeout(240_000);
  await open(page, server.baseUrl);
  for (const [format, scale] of [['png', 1], ['png', 2], ['svg', 2]] as const) {
    await page.getByTestId('export-screenshot-button').click();
    await page.getByRole('button', { name: format.toUpperCase(), exact: true }).click();
    await page.getByLabel('Capture full UI').check();
    if (format === 'png') await page.getByRole('button', { name: `${scale}x`, exact: true }).click();
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: `Export ${format.toUpperCase()}`, exact: true }).click();
    const file = info.outputPath(`full-ui-${scale}x.${format}`);
    await (await download).saveAs(file);
    const ink = await readInk(page, file);
    await info.attach(`full-ui-${format}-${scale}x-ink`, { body: JSON.stringify(ink), contentType: 'application/json' });
    expect(ink).toHaveLength(2);
    for (const [i, fraction] of ink.entries()) expect.soft(fraction, `${format} ${scale}x panel ${i}`).toBeGreaterThan(0.02);
  }
});
