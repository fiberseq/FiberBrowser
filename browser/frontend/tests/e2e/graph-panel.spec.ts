/**
 * The graph-view panel (DESIGN_GRAPH_PANEL.md Gate B) with the real native helper, in a real browser.
 *
 * - Graph-only: a server with no BAM and live lift off; the panel opens from its launcher, follows the main view,
 *   draws the toy Alu graph on its own ruler (both insertions at boundary 97,395), resizes to its body, and is not
 *   crossed by the linear crosshair or changed by a linear highlight.
 * - Two panels: one follows the main view, one navigates on its own; neither moves the other.
 * - Navigation-to-topology traces measured in the browser (FIBERBROWSER_GRAPH_MEASURE_OUT writes them).
 * - Shutdown leaves no helper process.
 * - With the pg-lift work data and the HPRC package (optional): an expanded linear insertion leaves the graph panel
 *   unchanged; measured HPRC navigation traces.
 *
 * Needs FIBERBROWSER_TEST_GRAPH_HELPER (the fiberbrowser-graph executable) and FIBERBROWSER_TEST_GRAPH_PACKAGES
 * (prepared packages, ':'-separated; one named `alu`), and FIBERBROWSER_TEST_FASTA with chr3 (no hg38 download).
 * Optional: FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE, FIBERBROWSER_TEST_LIFT_{BAM,NATIVE,MAP} (live-lift.spec.ts).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { panelButton, pickRandomPort, startServer, stopServer, type ServerProcess } from './fixtures/server';

const HELPER = process.env.FIBERBROWSER_TEST_GRAPH_HELPER?.trim() ?? '';
const PACKAGES = (process.env.FIBERBROWSER_TEST_GRAPH_PACKAGES ?? '').split(':').filter(Boolean);
const ALU = PACKAGES.find(p => path.basename(p.replace(/\/$/, '')) === 'alu') ?? '';
const HPRC = process.env.FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE?.trim() ?? '';
const MEASURE_OUT = process.env.FIBERBROWSER_GRAPH_MEASURE_OUT?.trim();
const LIFT_BAM = process.env.FIBERBROWSER_TEST_LIFT_BAM ?? '';
const NATIVE_BAM = process.env.FIBERBROWSER_TEST_LIFT_NATIVE ?? '';
const LIFT_MAP = process.env.FIBERBROWSER_TEST_LIFT_MAP ?? '';
const HAVE_GRAPH = Boolean(HELPER && existsSync(HELPER) && ALU && existsSync(ALU) && process.env.FIBERBROWSER_TEST_FASTA);

test.skip(!HAVE_GRAPH, 'set FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_PACKAGES (with alu) and FIBERBROWSER_TEST_FASTA');

const GUTTER = 52;
const laneTop = (i: number) => 30 + 4 + i * (28 + 4);

async function graphServer(packages: string[], bam: string | null = null, extraEnv: Record<string, string> = {}): Promise<ServerProcess> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-graph-e2e-'));
  const saved: Record<string, string | undefined> = {};
  const env = { FIBERBROWSER_GRAPH_HELPER: HELPER, FIBERBROWSER_GRAPH_PACKAGES: packages.join(':'),
    FIBERBROWSER_GRAPH_REGISTRY: path.join(scratch, 'graph_registrations.json'), ...extraEnv };
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    return await startServer(bam, await pickRandomPort());
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function helperPids(server: ServerProcess): number[] {
  try {
    return execSync(`pgrep -P ${server.pid}`).toString().trim().split('\n').filter(Boolean).map(Number)
      .filter(pid => { try { return execSync(`ps -o command= -p ${pid}`).toString().includes('fiberbrowser-graph'); } catch { return false; } });
  } catch { return []; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function preparePage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    localStorage.setItem('fiberbrowser_show_preview_features', 'true');
  });
  return errors;
}

const store = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__FIBERBROWSER_STORE__.getState()[f as string](...(a as unknown[])), [fn, args] as const);

async function openGraphPanel(page: Page): Promise<Locator> {
  const before = await page.getByTestId('graph-panel').count();
  await panelButton(page, 'graph-view').first().click();
  await expect(page.getByTestId('graph-panel')).toHaveCount(before + 1, { timeout: 20_000 });
  return page.getByTestId('graph-panel').nth(before);
}

async function settled(panel: Locator, start: number, timeout = 20_000) {
  await expect(panel).toHaveAttribute('data-graph-drawn-start', String(start), { timeout });
  await expect(panel).toHaveAttribute('data-graph-loading', 'false', { timeout });
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

type Navigate = (chrom: string, start: number, end: number) => Promise<void>;

/** Through the panel's own "Go to a target locus…" (it navigates on its own afterwards). */
function typedLocus(page: Page, panel: Locator): Navigate {
  return async (chrom, start, end) => {
    await panel.getByTestId('graph-panel-canvas').click({ button: 'right', position: { x: 120, y: 12 } });
    await page.getByTestId('graph-panel-menu').getByText('Go to a target locus…').click();
    await panel.getByTestId('graph-panel-locus-input').fill(`${chrom}:${start}-${end}`);
    await panel.getByTestId('graph-panel-locus-input').press('Enter');
  };
}

async function measure(page: Page, panel: Locator, label: string, windows: Array<[string, number, number]>, navigate?: Navigate) {
  await page.evaluate(() => { (window as any).__FIBERBROWSER_GRAPH_TRACES__?.splice(0); });
  // A window equal to the one shown asks for nothing: leave it out.
  const shown = Number(await panel.getAttribute('data-graph-drawn-start'));
  windows = windows.filter((w, i) => !(i === 0 && w[1] === shown));
  for (const [chrom, start, end] of windows) {
    if (navigate) await navigate(chrom, start, end);
    else await store(page, 'setViewport', chrom, start, end);
    await settled(panel, start, 30_000);
    // Painted: the trace of that request has its paint mark.
    await expect.poll(() => page.evaluate(s => ((window as any).__FIBERBROWSER_GRAPH_TRACES__ ?? [])
      .some((t: any) => t.interval.start === s && t.paintedAt !== undefined), start), { timeout: 10_000 }).toBe(true);
  }
  const traces = await page.evaluate(() => ((window as any).__FIBERBROWSER_GRAPH_TRACES__ ?? []).filter((t: any) => t.paintedAt !== undefined));
  const rows = traces.map((t: any) => ({
    start: t.interval.start, end: t.interval.end, cached: t.cached,
    navigation_to_paint_ms: t.paintedAt - t.navigatedAt,
    debounce_ms: t.dispatchedAt - t.navigatedAt,
    request_ms: t.respondedAt - t.dispatchedAt,
    layout_ms: t.laidOutAt - t.respondedAt,
    paint_ms: t.paintedAt - t.laidOutAt,
    server_total_ms: t.server?.total_ms, helper_dispatch_ms: t.server?.dispatch_ms, queue_ms: t.server?.queue_ms,
    startup_ms: t.server?.startup_ms ?? null, frame_bytes: t.server?.frame_bytes,
  }));
  const pick = (k: string) => rows.map((r: any) => r[k]).filter((v: any) => typeof v === 'number' && Number.isFinite(v));
  const summary: Record<string, unknown> = { label, samples: rows.length };
  for (const k of ['navigation_to_paint_ms', 'debounce_ms', 'request_ms', 'layout_ms', 'paint_ms', 'server_total_ms', 'helper_dispatch_ms']) {
    const v = pick(k);
    summary[k] = { p50: percentile(v, 50), p95: percentile(v, 95), max: Math.max(...v) };
  }
  return { summary, rows };
}

test('graph-only panel: no BAM, the real helper, its own ruler, resize, no linear crosshair or highlight', async ({ page }) => {
  test.setTimeout(240_000);
  const server = await graphServer([ALU]);
  let pids: number[] = [];
  const measurements: Record<string, unknown> = {};
  try {
    const errors = await preparePage(page);
    await page.goto(`${server.baseUrl}/?chr=chr3&start=90000&end=100000`);
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().datasets.length)).toBe(0);

    const graph = await openGraphPanel(page);
    await expect(graph).toHaveAttribute('data-graph-lanes', 'target,mat,pat', { timeout: 30_000 });
    await expect(graph).toHaveAttribute('data-graph-complete', 'true');
    await expect(graph).toHaveAttribute('data-graph-link', 'follow');
    await settled(graph, 90_000);
    await expect(graph.getByTestId('graph-panel-status')).toContainText('3 paths');
    await expect(graph.getByTestId('graph-panel-status')).toContainText('complete');
    // Its own panel: no BAM prompt or linear tracks inside it.
    const host = page.locator(`[data-analysis-panel-id]`).filter({ has: graph });
    await expect(host).toHaveAttribute('data-panel-content-type', 'graph-view');
    await expect(host.locator('[data-testid="axis-ruler"]')).toHaveCount(0);
    pids = helperPids(server);
    expect(pids.length).toBeGreaterThan(0);

    // The canvas fills the panel body, before and after a window resize.
    const canvas = graph.getByTestId('graph-panel-canvas');
    const fits = async () => {
      const [c, h] = [await canvas.boundingBox(), await host.boundingBox()];
      return Math.abs((c!.width + 2) - h!.width) <= 2;
    };
    await expect.poll(fits).toBe(true);
    const wide = (await canvas.boundingBox())!.width;
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeLessThan(wide - 50);
    await expect.poll(fits).toBe(true);
    await page.setViewportSize({ width: 1500, height: 1000 });
    await expect.poll(fits).toBe(true);

    // The Alu boundary: both insertions at 97,395 with their true lengths, and no made-up target base there.
    await store(page, 'setViewport', 'chr3', 97_300, 97_500);
    await settled(graph, 97_300);
    const box = (await canvas.boundingBox())!;
    const cssWidth = await canvas.evaluate((c: HTMLCanvasElement) => c.clientWidth);
    const scale = box.width / cssWidth;
    const xAt = (pos: number) => box.x + (GUTTER + ((pos - 97_300) / 200) * (cssWidth - GUTTER - 6)) * scale;
    for (const [lane, bp] of [[1, '2,353'], [2, '2,350']] as const) {
      await page.mouse.move(xAt(97_395), box.y + (laneTop(lane) + 5) * scale);
      await expect(graph.getByTestId('graph-tooltip')).toContainText(`insertion of ${bp} bp at target boundary 97,395`);
      await expect(graph.getByTestId('graph-cursor')).toHaveCount(0);
    }
    // A target node: the graph's own cursor and a true target coordinate.
    await page.mouse.move(xAt(97_350), box.y + (laneTop(0) + 14) * scale);
    await expect(graph.getByTestId('graph-tooltip')).toContainText('on the target');
    await expect(graph.getByTestId('graph-cursor')).toHaveCount(1);
    await page.mouse.move(5, 5);
    await expect(graph.getByTestId('graph-tooltip')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('graph-only-alu.png') });

    // A linear highlight over the same coordinates (Shift-drag on the genome panel's ruler) draws nothing in the graph.
    const before = await canvas.screenshot();
    const ruler = page.locator('[data-panel-id] [data-testid="axis-ruler"]').first();
    let rb = (await ruler.boundingBox())!;
    await page.keyboard.down('Shift');
    await page.mouse.move(rb.x + rb.width * 0.3, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width * 0.7, rb.y + rb.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().highlights.length)).toBe(1);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await page.screenshot({ path: test.info().outputPath('graph-only-highlight.png') });
    expect((await canvas.screenshot()).equals(before)).toBe(true);

    // The linear crosshair is cut around the graph panel. It runs from the top of the panels down to the dataset
    // panels under the pointer, so with the genome panel stacked below the graph panel (one column) it would cross
    // the graph panel on its way to the genome panel's ruler.
    const graphId = await graph.getAttribute('data-graph-panel-id');
    const genomeId = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.contentType === 'dataset').id);
    await store(page, 'stackPanelBelow', genomeId, graphId);
    await page.waitForTimeout(400);
    rb = (await ruler.boundingBox())!;
    await page.mouse.move(rb.x + rb.width * 0.4, rb.y + rb.height / 2);
    await expect.poll(() => page.getByTestId('ruler-crosshair').count()).toBeGreaterThan(0);
    const graphBox = (await host.boundingBox())!;
    const genomeBox = (await page.locator(`[data-panel-id="${genomeId}"]`).boundingBox())!;
    expect(genomeBox.y).toBeGreaterThanOrEqual(graphBox.y + graphBox.height - 2);   // stacked below it, same column
    expect(Math.abs(graphBox.x - genomeBox.x)).toBeLessThan(4);
    let reaches = 0;
    for (const seg of await page.getByTestId('ruler-crosshair').all()) {
      const sb = await seg.boundingBox();
      if (!sb) continue;
      expect(intersects(sb, graphBox)).toBe(false);
      reaches = Math.max(reaches, sb.y + sb.height);
    }
    // It still runs through the genome panel below.
    expect(reaches).toBeGreaterThan(genomeBox.y + genomeBox.height * 0.8);
    await page.screenshot({ path: test.info().outputPath('graph-only-crosshair.png') });
    await page.mouse.move(5, 5);

    // Navigation-to-topology traces: 10 kb windows across the toy target, each after the debounce.
    const windows: Array<[string, number, number]> = [];
    for (let i = 0; i < 24; i++) windows.push(['chr3', 10_000 + i * 8_000, 20_000 + i * 8_000]);
    measurements.alu_10kb = await measure(page, graph, 'alu 10 kb pans', windows);
    const s = (measurements.alu_10kb as any).summary;
    console.log(JSON.stringify(s));
    expect(s.samples).toBeGreaterThanOrEqual(20);
    expect(s.navigation_to_paint_ms.p95).toBeLessThan(300);
    expect(errors).toEqual([]);
  } finally {
    const live = helperPids(server);
    pids = [...new Set([...pids, ...live])];
    await stopServer(server);
    if (MEASURE_OUT) writeFileSync(`${MEASURE_OUT}.alu.json`, JSON.stringify(measurements, null, 1));
  }
  // The server's shutdown reaped every helper it started.
  await expect.poll(() => pids.filter(alive)).toEqual([]);
});

test('two graph panels: one follows the main view, one navigates on its own', async ({ page }) => {
  test.setTimeout(180_000);
  const server = await graphServer([ALU]);
  try {
    const errors = await preparePage(page);
    await page.goto(`${server.baseUrl}/?chr=chr3&start=90000&end=100000`);
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
    const a = await openGraphPanel(page);
    await settled(a, 90_000, 30_000);
    // A second one from the first one's right-click menu (the launcher toggles the first).
    await a.getByTestId('graph-panel-canvas').click({ button: 'right', position: { x: 200, y: 50 } });
    await page.getByTestId('graph-panel-menu').getByText('Open another graph view').click();
    await expect(page.getByTestId('graph-panel')).toHaveCount(2, { timeout: 20_000 });
    const b = page.getByTestId('graph-panel').nth(1);
    await settled(b, 90_000, 30_000);
    // B goes to its own locus from its right-click menu.
    await b.getByTestId('graph-panel-canvas').click({ button: 'right', position: { x: 200, y: 50 } });
    await page.getByTestId('graph-panel-menu').getByText('Go to a target locus…').click();
    await b.getByTestId('graph-panel-locus-input').fill('chr3:150,000-160,000');
    await b.getByTestId('graph-panel-locus-input').press('Enter');
    await expect(b).toHaveAttribute('data-graph-link', 'independent');
    await settled(b, 150_000);
    // The main view moves: A follows, B stays.
    await store(page, 'setViewport', 'chr3', 120_000, 130_000);
    await settled(a, 120_000);
    await expect(b).toHaveAttribute('data-graph-start', '150000');
    // B pans by drag: neither A nor the main view moves.
    const canvas = b.getByTestId('graph-panel-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.6, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + 60, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Number(await b.getAttribute('data-graph-start'))).toBeGreaterThan(150_000);
    await expect(a).toHaveAttribute('data-graph-start', '120000');
    expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start)).toBe(120_000);
    // A pans by drag while following: it moves the main view, and follows it.
    const abox = (await a.getByTestId('graph-panel-canvas').boundingBox())!;
    await page.mouse.move(abox.x + abox.width * 0.6, abox.y + 60);
    await page.mouse.down();
    await page.mouse.move(abox.x + abox.width * 0.5, abox.y + 60, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start)).toBeGreaterThan(120_000);
    const mainStart = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start);
    await expect(a).toHaveAttribute('data-graph-start', String(mainStart));
    await page.screenshot({ path: test.info().outputPath('graph-two-panels.png') });
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
  }
});

const HAVE_LIFT = [LIFT_BAM, NATIVE_BAM, LIFT_MAP].every(p => p && existsSync(p)) && Boolean(HPRC && existsSync(HPRC));

test('an expanded linear insertion leaves the graph panel unchanged (HPRC package, live lift)', async ({ page }) => {
  test.skip(!HAVE_LIFT || process.env.FIBERBROWSER_LIVE_LIFT !== '1', 'needs the pg-lift work data, the HPRC package and FIBERBROWSER_LIVE_LIFT=1');
  test.setTimeout(420_000);
  const server = await graphServer([HPRC], NATIVE_BAM);
  const measurements: Record<string, unknown> = {};
  try {
    const errors = await preparePage(page);
    await page.goto(`${server.baseUrl}/?chr=chr3&start=128650000&end=128670000`);
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 120_000 }).toBe(0);
    const graph = await openGraphPanel(page);
    await expect(graph).toHaveAttribute('data-graph-lanes', 'grch38_chr3,pat_chr3,mat_chr3', { timeout: 120_000 });
    await settled(graph, 128_650_000, 60_000);
    // Live lift: the MAT/PAT panels, then expand the AluY insertion in the linear panels.
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-add-live-lift').click();
    await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
    await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
    await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
    await page.getByTestId('live-lift-add').click();
    await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 60_000 });
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 120_000 }).toBe(0);
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ fillReadHeight: false, readRowHeight: 16 }));
    const matKey = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.liftHap === 'MAT')?.stateKey
      ?? (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.liftHap === 'MAT')?.datasetId);
    const matCanvas = page.locator(`[data-read-track-state-key="${matKey}"] canvas[data-copilot-track="reads"]`);
    await expect.poll(() => matCanvas.getAttribute('data-live-lift-badge-target'), { timeout: 60_000 }).toBeTruthy();
    await settled(graph, 128_650_000, 60_000);
    await page.mouse.move(5, 5);
    const canvas = graph.getByTestId('graph-panel-canvas');
    const before = await canvas.screenshot();
    const startBefore = await graph.getAttribute('data-graph-start');
    const target = JSON.parse((await matCanvas.getAttribute('data-live-lift-badge-target'))!);
    const s = await matCanvas.evaluate((c: HTMLCanvasElement) => ({ x: c.getBoundingClientRect().width / c.clientWidth, y: c.getBoundingClientRect().height / c.clientHeight }));
    await matCanvas.click({ position: { x: target.x * s.x, y: target.y * s.y } });
    await expect(page.getByTestId('live-lift-expanded-block').first()).toBeVisible({ timeout: 30_000 });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(800);
    await page.screenshot({ path: test.info().outputPath('graph-with-expanded-linear-insertion.png') });
    expect(await graph.getAttribute('data-graph-start')).toBe(startBefore);
    expect((await canvas.screenshot()).equals(before)).toBe(true);
    await page.getByTestId('live-lift-expanded-collapse').first().click();
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
    if (MEASURE_OUT) writeFileSync(`${MEASURE_OUT}.lift.json`, JSON.stringify(measurements, null, 1));
  }
});

test('HPRC navigation-to-topology traces (measurement only)', async ({ page }) => {
  test.skip(!HPRC || !existsSync(HPRC) || !MEASURE_OUT, 'set FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE and FIBERBROWSER_GRAPH_MEASURE_OUT');
  test.setTimeout(600_000);
  const server = await graphServer([HPRC]);
  const out: Record<string, unknown> = {};
  try {
    await preparePage(page);
    const t0 = Date.now();
    await page.goto(`${server.baseUrl}/?chr=chr3&start=128650000&end=128660000`);
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
    const graph = await openGraphPanel(page);
    await settled(graph, 128_650_000, 180_000);
    out.first_open_ms = Date.now() - t0;
    const loci: Array<[string, string, number, number]> = [
      ['AluY_10kb', 'chr3', 128_650_000, 10_000], ['AluY_50kb', 'chr3', 128_635_000, 50_000],
      ['MHC_10kb', 'chr6', 29_000_000, 10_000], ['MHC_50kb', 'chr6', 29_000_000, 50_000],
      ['chr19_10kb', 'chr19', 43_017_556, 10_000], ['chr21_10kb', 'chr21', 10_371_898, 10_000],
    ];
    for (const [label, chrom, start, width] of loci) {
      // Pans of a quarter width from the locus, twice over (the second pass is warm).
      const windows: Array<[string, number, number]> = [];
      for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 6; i++) windows.push([chrom, start + i * (width / 4), start + i * (width / 4) + width]);
      out[label] = await measure(page, graph, label, windows, chrom === 'chr3' ? undefined : typedLocus(page, graph));
      console.log(JSON.stringify((out[label] as any).summary));
    }
  } finally {
    await stopServer(server);
    writeFileSync(`${MEASURE_OUT}.hprc.json`, JSON.stringify(out, null, 1));
  }
});
