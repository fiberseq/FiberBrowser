/**
 * Labels → Layer colours: a colour set for the nucleosome layer reaches every view, is saved with the session, and
 * Reset brings the built-in colour back. "Save as my default colours" keeps it on this computer for new sessions.
 *
 * Pinned to the tracked NAPA demo BAM (chr19:47514000-47518000). A nucleosome pixel of the read track (the
 * built-in Nucleosome rule's green) is found first and the same pixel is checked after each change.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';
import type { ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

type Rgb = [number, number, number];
const DEFAULT_ID = '__default_metaprofile__';
const PICK = '#ffd400';
const PICK_RGB: Rgb = [255, 212, 0];
const SHOTS = process.env.LAYER_COLOUR_SHOTS_DIR ?? '';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) });
}

async function openAt(page: Page, server: ServerFixture) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
  });
  await page.goto(server.baseUrl);
  await page.evaluate(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
  await page.waitForLoadState('networkidle');
  const r = server.defaultRegion!;
  const reads = page.waitForResponse(res => res.url().includes('/api/reads/compact'), { timeout: 45_000 }).catch(() => null);
  await page.getByTestId('location-search-input').fill(`${r.chrom}:${r.start}-${r.end}`);
  await page.getByTestId('location-search-submit').click();
  await reads;
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  await page.waitForTimeout(1500);
}

const getState = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => { const s = (window as any).__FIBERBROWSER_STORE__.getState(); return new Function('s', `return (${f})(s)`)(s); }, fn.toString()) as Promise<T>;

const isGreen = ([r, g, b]: Rgb) => g > 120 && r < 110 && b < 110;
const isPicked = (rgb: Rgb) => rgb.every((v, i) => Math.abs(v - PICK_RGB[i]) <= 24);

/** A read-track pixel inside a nucleosome (the built-in Nucleosome rule's green, with green neighbours). */
async function findNucPixel(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-copilot-track="reads"]') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const green = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return data[i + 1] > 120 && data[i] < 110 && data[i + 2] < 110 && data[i + 3] === 255;
    };
    for (let y = Math.floor(height * 0.25); y < height - 2; y += 3) {
      for (let x = 40; x < width - 2; x += 2) {
        if (green(x, y) && green(x - 1, y) && green(x + 1, y) && green(x, y - 1) && green(x, y + 1)) return { x, y };
      }
    }
    throw new Error('no nucleosome pixel on the read track');
  });
}

const pixelAt = (page: Page, p: { x: number; y: number }) => page.evaluate(({ x, y }) => {
  const canvas = document.querySelector('canvas[data-copilot-track="reads"]') as HTMLCanvasElement;
  return Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data.slice(0, 3));
}, p) as Promise<Rgb>;

/** Pixels of the default metaprofile's canvas in the picked colour (yellow: no built-in layer is). */
const metaprofilePicked = (page: Page) => page.evaluate(id => {
  const canvas = document.querySelector(`canvas[data-testid="composite-track-canvas-${id}"]`) as HTMLCanvasElement | null;
  if (!canvas) return -1;
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] > 231 && Math.abs(data[i + 1] - 212) <= 24 && data[i + 2] < 24 && data[i + 3] > 200) n += 1;
  return n;
}, DEFAULT_ID);

const nucSourceColor = (page: Page) => getState(page, s => {
  const track = s.compositeTracks.find((c: any) => c.id === '__default_metaprofile__');
  const src = track?.sources.find((x: any) => x.ref.kind === 'metaprofile' && ['nuc', 'footprint'].includes(x.ref.ruleId));
  return src?.color ?? null;
});

async function openLayerColours(page: Page) {
  const panel = page.locator('[data-panel-content-type="colormap"]');
  if (!(await panel.isVisible().catch(() => false))) await panelButton(page, 'colormap').click();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const details = panel.getByTestId('layer-colours-details');
  if (!(await details.evaluate(el => (el as HTMLDetailsElement).open))) await details.locator('summary').click();
  await expect(panel.getByTestId('layer-colours-section')).toBeVisible();
  return panel;
}

async function cluster(page: Page) {
  await page.evaluate(() => { if ((window as any).__FIBERBROWSER_STORE__.getState().getAllPeaks().length < 2) (window as any).fiberbrowserCommand?.('scan-peaks'); });
  await expect.poll(() => getState(page, s => s.getAllPeaks().length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.replacePeakSelection([0, 1]);
    st.setClusterMethod('kmeans');
  });
  const done = page.waitForResponse(res => res.url().includes('/api/cluster_all'), { timeout: 60_000 });
  await page.getByTestId('cluster-run-button').click();
  await done;
  await expect.poll(() => getState(page, s => Object.values(s.clusterAssignments)
    .reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0)), { timeout: 45_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
}

test('a nucleosome layer colour reaches the read track, metaprofile and cluster profiles; saved; Reset restores it', async ({ server, page }, info) => {
  test.setTimeout(300_000);
  await openAt(page, server);

  const p = await findNucPixel(page);
  expect(isGreen(await pixelAt(page, p))).toBe(true);
  await expect.poll(() => metaprofilePicked(page), { timeout: 20_000 }).toBe(0);
  const builtinSource = await nucSourceColor(page);
  expect(builtinSource).toBeTruthy();
  await shot(page, '1-builtin.png');

  // Labels → Layer colours: the nucleosome layer in yellow.
  const labels = await openLayerColours(page);
  const nucKey = (await labels.locator('[data-testid^="layer-colour-row-"]').first().getAttribute('data-testid'))!.replace('layer-colour-row-', '');
  expect(['nuc']).toContain(nucKey);
  await labels.getByTestId(`layer-colour-input-${nucKey}`).fill(PICK);
  await expect(labels.getByTestId(`layer-colour-source-${nucKey}`)).toHaveText('this session');
  await expect(labels.getByTestId('layer-colours-precedence')).toContainText("This session's colours win over your saved defaults");
  await shot(page, '2-labels-section.png');

  // Read track pixel, metaprofile line, cluster profile swatch.
  await expect.poll(async () => isPicked(await pixelAt(page, p)), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => nucSourceColor(page), { timeout: 20_000 }).toBe(PICK);
  await expect.poll(() => metaprofilePicked(page), { timeout: 20_000 }).toBeGreaterThan(0);

  await cluster(page);
  await panelButton(page, 'cluster-detail').click();
  const clusters = page.locator('[data-panel-content-type="cluster-detail"]');
  await clusters.locator('[data-analysis-tab="profiles"]').click();
  const chart = clusters.locator(`[data-testid="cluster-profile-chart"][data-layer="${nucKey}"]`);
  await expect(chart).toBeVisible({ timeout: 30_000 });
  await expect(chart.locator('span.rounded-sm').first()).toHaveCSS('background-color', 'rgb(255, 212, 0)');
  await shot(page, '3-picked-everywhere.png');

  // Saved with the session; restored after a reload (Open, the file picker answered by the test).
  const download = page.waitForEvent('download');
  await page.getByTestId('save-session-button').click();
  const sessionPath = info.outputPath('layer-colours-session.json');
  await (await download).saveAs(sessionPath);
  expect(JSON.parse(readFileSync(sessionPath, 'utf8')).frontend.layerColorOverrides).toEqual({ [nucKey]: PICK });

  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).__FIBERBROWSER_STORE__?.getState().datasets.length));
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ layerColorOverrides: {} }));
  await page.route(/\/api\/pick_file(?:\?|$)/, route => route.fulfill({ json: { success: true, path: sessionPath, paths: [sessionPath] } }));
  const [imported] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/import' && r.request().method() === 'POST', { timeout: 60_000 }),
    page.getByTestId('load-file-button').click(),
  ]);
  expect(imported.ok()).toBe(true);
  await expect.poll(() => getState(page, s => s.layerColorOverrides), { timeout: 20_000 }).toEqual({ [nucKey]: PICK });
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  const q = await findPickedOrNuc(page, p);
  await expect.poll(async () => isPicked(await pixelAt(page, q)), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => metaprofilePicked(page), { timeout: 30_000 }).toBeGreaterThan(0);
  await shot(page, '4-session-restored.png');

  // Reset: the built-in colour everywhere.
  const labels2 = await openLayerColours(page);
  await labels2.getByTestId(`layer-colour-reset-${nucKey}`).click();
  await expect.poll(async () => isGreen(await pixelAt(page, q)), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => nucSourceColor(page), { timeout: 20_000 }).toBe(builtinSource);
  await expect.poll(() => metaprofilePicked(page), { timeout: 20_000 }).toBe(0);
  await shot(page, '5-reset.png');

  // Save as my default colours: kept on this computer; a session's Reset falls back to it; Clear forgets it.
  await labels2.getByTestId(`layer-colour-input-${nucKey}`).fill(PICK);
  await labels2.getByTestId('layer-colour-save-default').click();
  await expect(labels2.getByTestId('layer-colours-message')).toContainText('Saved 1 layer colour');
  await expect.poll(async () => (await (await fetch(`${server.baseUrl}/api/preferences/analysis`)).json()).layer_colors, { timeout: 15_000 })
    .toEqual({ [nucKey]: PICK });
  await labels2.getByTestId(`layer-colour-reset-${nucKey}`).click();
  await expect(labels2.getByTestId(`layer-colour-source-${nucKey}`)).toHaveText('your default');
  await expect.poll(async () => isPicked(await pixelAt(page, q)), { timeout: 20_000 }).toBe(true);
  await shot(page, '6-saved-default.png');
  await labels2.getByTestId('layer-colour-clear-default').click();
  await expect.poll(async () => isGreen(await pixelAt(page, q)), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await (await fetch(`${server.baseUrl}/api/preferences/analysis`)).json()).layer_colors, { timeout: 15_000 })
    .toEqual({});
});

/** After a session import the reads may be laid out again: the old pixel if it is still a nucleosome, else a new one. */
async function findPickedOrNuc(page: Page, p: { x: number; y: number }) {
  await page.waitForTimeout(1500);
  const rgb = await pixelAt(page, p);
  if (isPicked(rgb)) return p;
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-copilot-track="reads"]') as HTMLCanvasElement;
    const { width, height } = canvas;
    const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
    const mag = (x: number, y: number) => { const i = (y * width + x) * 4; return data[i] > 231 && Math.abs(data[i + 1] - 212) <= 24 && data[i + 2] < 24; };
    for (let y = 2; y < height - 2; y += 2) for (let x = 40; x < width - 2; x += 2)
      if (mag(x, y) && mag(x - 1, y) && mag(x + 1, y) && mag(x, y - 1) && mag(x, y + 1)) return { x, y };
    return { x: 0, y: 0 };
  });
}
