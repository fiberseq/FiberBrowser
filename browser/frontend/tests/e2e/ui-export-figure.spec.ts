/**
 * The exported figure (fb-n3-figure, audit P7):
 * - M11: with a side panel in the drawer the figure had a blank strip on the
 *   right (the side panel took a column the figure doesn't draw);
 * - M12: the footer's second line ("Datasets: …") was cut off at the bottom;
 * - M1: in Per panel mode the default file name used the stale main locus;
 *   it names each region the panels show (and their references).
 * At 100% and 150% UI size (Match UI size on, the default), PNG and SVG.
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page } from '@playwright/test';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

test.use({ fixtureBam: 'demo' });

const DM6_BAM = process.env.FIBERBROWSER_TEST_DM6_BAM?.trim() || '';
const GENOMES = path.join(homedir(), '.fiberhmm', 'genomes');

// The main locus (left stale by Per panel mode) and where each panel is.
const MAIN = { chrom: 'chr19', start: 47_514_037, end: 47_519_435 };
const LEFT = { chrom: 'chr19', start: 47_514_262, end: 47_519_210 };
const RIGHT = { chrom: 'chr19', start: 47_515_000, end: 47_517_000 };
const stem = (l: { chrom: string; start: number; end: number }) => `${l.chrom}_${l.start}-${l.end}`;
const SIDE = 'read-stats';

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function open(page: Page, baseUrl: string) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1728, height: 1080 });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
}

async function readsSettled(page: Page) {
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 30_000 }).toBe(0);
  await page.waitForTimeout(400);
}

/** A side panel in the drawer (pinned to the side), as in the audit's Regions case. */
async function openDrawer(page: Page) {
  await panelButton(page, SIDE).click();
  const inDrawer = page.locator(`[data-testid="analysis-overlay"] [data-panel-content-type="${SIDE}"]`);
  if (!(await inDrawer.count())) await page.locator(`[data-testid="panel-dock-toggle-${SIDE}"]:visible`).click();
  await expect(inDrawer).toHaveCount(1);
}

async function exportFigure(page: Page, format: 'png' | 'svg', file: string) {
  await page.getByTestId('export-screenshot-button').click();
  await page.getByRole('button', { name: format.toUpperCase(), exact: true }).click();
  await expect(page.getByTestId('export-match-ui-size')).toBeChecked();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: `Export ${format.toUpperCase()}`, exact: true }).click();
  const download = await pending;
  await download.saveAs(file);
  return download.suggestedFilename();
}

/** PNG: the right-most column with ink in the tracks band, and the lowest row with ink. */
async function pngInk(page: Page, file: string) {
  const data = readFileSync(file).toString('base64');
  return page.evaluate(async data => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const ink = (x: number, y: number) => {
      const i = (y * canvas.width + x) * 4;
      return px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235;
    };
    // The tracks band: below the title, above the footer.
    const top = Math.round(canvas.height * 0.15), bottom = Math.round(canvas.height * 0.8);
    let right = -1;
    for (let x = canvas.width - 1; x >= 0 && right < 0; x--) {
      for (let y = top; y < bottom; y += 2) if (ink(x, y)) { right = x; break; }
    }
    let lowest = -1;
    for (let y = canvas.height - 1; y >= 0 && lowest < 0; y--) {
      for (let x = 0; x < canvas.width; x++) if (ink(x, y)) { lowest = y; break; }
    }
    return { width: canvas.width, height: canvas.height, right, lowest };
  }, data);
}

test('figure with a drawer open, in Per panel mode, at 100% and 150%: no blank strip, the whole footer, named after the panels', async ({ page, server }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // A second dataset (the demo under another name): the footer gets its datasets line.
  const copy = info.outputPath('napa_copy.bam');
  symlinkSync(server.bamPath, copy);
  symlinkSync(`${server.bamPath}.bai`, `${copy}.bai`);
  expect((await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: copy } })).ok()).toBe(true);
  await open(page, server.baseUrl);
  expect(await store(page, s => s.datasets.length)).toBe(2);

  await page.evaluate(([main, left, right]) => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.setViewport(main.chrom, main.start, main.end);
    st.setNavigationMode('perPanel');
    const ids = (window as any).__FIBERBROWSER_STORE__.getState().panels.filter((p: any) => p.contentType === 'dataset').map((p: any) => p.id);
    st.navigatePanel(ids[0], left.chrom, left.start, left.end);
    st.navigatePanel(ids[1], right.chrom, right.start, right.end);
  }, [MAIN, LEFT, RIGHT] as const);
  expect(await store(page, s => [s.navigationMode, s.chrom, s.start])).toEqual(['perPanel', MAIN.chrom, MAIN.start]);
  await openDrawer(page);

  for (const ui of [1, 1.5]) {
    await page.evaluate(scale => (window as any).__FIBERBROWSER_STORE__.getState().setUiScale(scale), ui);
    await readsSettled(page);
    await page.screenshot({ path: info.outputPath(`live-${ui}.png`) });

    const png = info.outputPath(`figure-${ui}.png`);
    const pngName = await exportFigure(page, 'png', png);
    // Named after the panels' regions, not the stale main locus.
    expect.soft(pngName).toBe(`fiberhmm_${stem(LEFT)}_${stem(RIGHT)}_2x.png`);
    const ink = await pngInk(page, png);
    info.attach(`png-${ui}`, { body: JSON.stringify(ink), contentType: 'application/json' });
    // M11: the panels reach the right edge (the panel gap and border at most).
    expect.soft(ink.right, 'no blank strip on the right').toBeGreaterThan(ink.width - 40 * ui);
    // M12: the footer's last line ends inside the image, with a margin.
    expect.soft(ink.lowest, 'footer inside the image').toBeLessThan(ink.height - 4 * ui);
    // The drawer is back after the export.
    await expect(page.locator(`[data-testid="analysis-overlay"] [data-panel-content-type="${SIDE}"]`)).toHaveCount(1);

    const svgFile = info.outputPath(`figure-${ui}.svg`);
    const svgName = await exportFigure(page, 'svg', svgFile);
    expect.soft(svgName).toBe(`fiberhmm_${stem(LEFT)}_${stem(RIGHT)}.svg`);
    const svg = readFileSync(svgFile, 'utf8');
    const height = Number(svg.match(/<svg[^>]*height="([\d.]+)"/)?.[1]);
    // vectorRenderers writes x, y, …, font-size in that order.
    const line = svg.match(/<text x="[\d.-]+" y="([\d.-]+)"[^>]*font-size="([\d.]+)"[^>]*>Datasets: [^<]*<\/text>/);
    expect(line, 'the datasets line').toBeTruthy();
    const [y, size] = [Number(line![1]), Number(line![2])];
    expect(y + size * 0.3, 'the datasets line inside the SVG').toBeLessThan(height);
    // The citation line (default on), below the datasets line and inside the figure.
    const cite = svg.match(/<text x="[\d.-]+" y="([\d.-]+)"[^>]*font-size="([\d.]+)"[^>]*>Made with FiberBrowser [^<]*<\/text>/);
    expect(cite, 'the citation line').toBeTruthy();
    expect(Number(cite![1])).toBeGreaterThan(y);
    expect(Number(cite![1]) + Number(cite![2]) * 0.3, 'the citation line inside the SVG').toBeLessThan(height);
    // The title names each panel's region.
    expect(svg).toContain(`${LEFT.chrom}:${LEFT.start.toLocaleString('en-US')}-${LEFT.end.toLocaleString('en-US')}`);
    expect(svg).toContain(`${RIGHT.chrom}:${RIGHT.start.toLocaleString('en-US')}-${RIGHT.end.toLocaleString('en-US')}`);
  }
  expect(errors).toEqual([]);
});

test('panels on two references: the figure title and file name name each region with its reference', async ({ page, server }, info) => {
  test.skip(!DM6_BAM || !existsSync(DM6_BAM), 'needs a dm6 BAM (FIBERBROWSER_TEST_DM6_BAM)');
  test.skip(!existsSync(path.join(GENOMES, 'dm6.fa.fai')), 'needs dm6 in ~/.fiberhmm/genomes (not downloaded by tests)');
  test.setTimeout(240_000);
  const status = await (await page.request.get(`${server.baseUrl}/api/status`)).json();
  if (status.current_genome !== 'hg38') {
    test.skip(!existsSync(path.join(GENOMES, 'hg38.fa.fai')), 'needs hg38 in ~/.fiberhmm/genomes (not downloaded by tests)');
    expect((await (await page.request.post(`${server.baseUrl}/api/load_genome?genome_id=hg38`)).json()).success).toBe(true);
  }
  expect((await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: DM6_BAM } })).ok()).toBe(true);
  await open(page, server.baseUrl);
  await page.evaluate(m => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(m.chrom, m.start, m.end), MAIN);
  await page.getByTestId('genome-mismatch-own-genome').click();
  await expect(page.getByTestId('panel-genome-chip')).toHaveText('dm6', { timeout: 60_000 });
  expect(await store(page, s => s.navigationMode)).toBe('perPanel');
  // The hg38 panel elsewhere than the (stale) main locus.
  const humanBar = page.getByTestId('panel-site-bar').filter({ hasNot: page.getByTestId('panel-genome-chip') });
  await humanBar.getByTestId('panel-location-input').fill(`${LEFT.chrom}:${LEFT.start}-${LEFT.end}`);
  await humanBar.getByTestId('panel-location-submit').click();
  const flyAt = await store(page, s => s.panels.find((p: any) => p.genome === 'dm6')?.viewportOverride) as { chrom: string; start: number; end: number };
  expect(flyAt?.chrom).toMatch(/^chr/);
  await openDrawer(page);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setUiScale(1.5));
  await readsSettled(page);

  const svgFile = info.outputPath('two-references.svg');
  const name = await exportFigure(page, 'svg', svgFile);
  expect(name).toBe(`fiberhmm_hg38_${stem(LEFT)}_dm6_${stem(flyAt)}.svg`);
  const svg = readFileSync(svgFile, 'utf8');
  const where = (l: typeof flyAt) => `${l.chrom}:${l.start.toLocaleString('en-US')}-${l.end.toLocaleString('en-US')}`;
  expect(svg).toContain(`hg38 ${where(LEFT)}  |  dm6 ${where(flyAt)}`);
});
