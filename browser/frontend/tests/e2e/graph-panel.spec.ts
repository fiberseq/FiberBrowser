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
 *   unchanged; measured HPRC navigation traces; reads of a live-lift dataset drawn along the MAT/PAT walks (Gate E),
 *   with their navigation-to-reads traces.
 *
 * Needs FIBERBROWSER_TEST_GRAPH_HELPER (the fiberbrowser-graph executable) and FIBERBROWSER_TEST_GRAPH_PACKAGES
 * (prepared packages, ':'-separated; one named `alu`), and FIBERBROWSER_TEST_FASTA with chr3 (no hg38 download).
 * Optional: FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE, FIBERBROWSER_TEST_LIFT_{BAM,NATIVE,MAP} (live-lift.spec.ts).
 */
import type { Page, Locator } from '@playwright/test';
import { test, expect } from './fixtures/nativeDialogs';
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

const laneTop = (i: number) => 30 + 4 + i * (28 + 4);

/**
 * Where something is in a graph panel's joint layout (CSS px inside its canvas), from the scene the panel exposes
 * to e2e runs: an allele of a lane at a target boundary, or a target position on target-backed geometry.
 */
async function locate(page: Page, panel: Locator, what: { allele: string; boundary: number } | { target: number }) {
  const id = await panel.getAttribute('data-graph-panel-id');
  return page.evaluate(([pid, w]) => {
    const entry = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string];
    if (!entry) return null;
    const { scene, offset } = entry;
    const q = w as any;
    if (q.allele) {
      const hit = scene.hits.filter((h: any) => h.payload.kind === 'allele' && h.payload.lane === q.allele
        && h.payload.group.target?.start === q.boundary && h.payload.group.target?.end === q.boundary).at(-1);
      return hit ? { x: (hit.x0 + hit.x1) / 2 + offset, y: (hit.y0 + hit.y1) / 2 } : null;
    }
    const m = scene.targetMap.find((e: any) => e.kind === 'seq' && e.t0 <= q.target && q.target < e.t1);
    if (!m) return null;
    const row = scene.rows[0];
    return { x: m.x0 + ((q.target + 0.5 - m.t0) / (m.t1 - m.t0)) * (m.x1 - m.x0) + offset, y: row.center };
  }, [id, what] as const);
}

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
    layout_compute_ms: t.layoutMs,
    paint_ms: t.paintedAt - t.laidOutAt,
    server_total_ms: t.server?.total_ms, helper_dispatch_ms: t.server?.dispatch_ms, queue_ms: t.server?.queue_ms,
    startup_ms: t.server?.startup_ms ?? null, frame_bytes: t.server?.frame_bytes,
  }));
  const pick = (k: string) => rows.map((r: any) => r[k]).filter((v: any) => typeof v === 'number' && Number.isFinite(v));
  const summary: Record<string, unknown> = { label, samples: rows.length };
  for (const k of ['navigation_to_paint_ms', 'debounce_ms', 'request_ms', 'layout_ms', 'layout_compute_ms', 'paint_ms', 'server_total_ms', 'helper_dispatch_ms']) {
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
    // One slot at 97,395 (the joint layout): each lane says its own insertion there, with no target cursor.
    await expect(graph).toHaveAttribute('data-graph-bubbles', /\d+/);
    for (const [lane, bp] of [['mat', '2,353'], ['pat', '2,350']] as const) {
      const at = await locate(page, graph, { allele: lane, boundary: 97_395 });
      expect(at).not.toBeNull();
      await page.mouse.move(box.x + at!.x * scale, box.y + at!.y * scale);
      await expect(graph.getByTestId('graph-tooltip')).toContainText(`insertion of ${bp} bp at target boundary 97,395`);
      await expect(graph.getByTestId('graph-cursor')).toHaveCount(0);
    }
    // A target node: the graph's own cursor and a true target coordinate.
    const node = (await locate(page, graph, { target: 97_350 }))!;
    await page.mouse.move(box.x + node.x * scale, box.y + node.y * scale);
    await expect(graph.getByTestId('graph-tooltip')).toContainText('97,350 on the target');
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
  test.skip(!HAVE_LIFT || process.env.FIBERBROWSER_LIVE_LIFT === '0', 'needs the pg-lift work data, the HPRC package (live lift is on unless FIBERBROWSER_LIVE_LIFT=0)');
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
    await page.getByTestId('live-lift-open-split').check();   // split panels (graph mode is the default with a package)
    await page.getByTestId('live-lift-add').click();
    await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 60_000 });
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 120_000 }).toBe(0);
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ fillReadHeight: false, readRowHeight: 16 }));
    // The lifted molecules are drawn on the graph too (Gate E): wait for them before the reference picture.
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 60_000 }).toBeGreaterThan(0);
    await expect(graph).toHaveAttribute('data-graph-reads-loading', 'false', { timeout: 60_000 });
    const matKey = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.liftHap === 'MAT')?.stateKey
      ?? (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.liftHap === 'MAT')?.datasetId);
    const matCanvas = page.locator(`[data-read-track-state-key="${matKey}"] canvas[data-copilot-track="reads"]`);
    await expect.poll(() => matCanvas.getAttribute('data-live-lift-badge-target'), { timeout: 60_000 }).toBeTruthy();
    await settled(graph, 128_650_000, 60_000);
    await page.mouse.move(5, 5);
    const canvas = graph.getByTestId('graph-panel-canvas');
    // The canvas's own pixels (an element screenshot of a canvas taller than the window is stitched while scrolling,
    // so its text can rasterise differently between two shots of one drawing).
    const pixels = () => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    const before = await pixels();
    const startBefore = await graph.getAttribute('data-graph-start');
    const target = JSON.parse((await matCanvas.getAttribute('data-live-lift-badge-target'))!);
    const s = await matCanvas.evaluate((c: HTMLCanvasElement) => ({ x: c.getBoundingClientRect().width / c.clientWidth, y: c.getBoundingClientRect().height / c.clientHeight }));
    await matCanvas.click({ position: { x: target.x * s.x, y: target.y * s.y } });
    await expect(page.getByTestId('live-lift-expanded-block').first()).toBeVisible({ timeout: 30_000 });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(800);
    await page.screenshot({ path: test.info().outputPath('graph-with-expanded-linear-insertion.png') });
    expect(await graph.getAttribute('data-graph-start')).toBe(startBefore);
    expect(await pixels()).toBe(before);
    await page.getByTestId('live-lift-expanded-collapse').first().click();
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
    if (MEASURE_OUT) writeFileSync(`${MEASURE_OUT}.lift.json`, JSON.stringify(measurements, null, 1));
  }
});

test('reads of a live-lift dataset drawn along their graph walk (HPRC package, Gate E)', async ({ page }) => {
  test.skip(!HAVE_LIFT || process.env.FIBERBROWSER_LIVE_LIFT === '0', 'needs the pg-lift work data, the HPRC package (live lift is on unless FIBERBROWSER_LIVE_LIFT=0)');
  test.setTimeout(480_000);
  const server = await graphServer([HPRC]);
  try {
    const errors = await preparePage(page);
    await page.goto(`${server.baseUrl}/?chr=chr3&start=128650000&end=128660000`);
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-add-live-lift').click();
    await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
    await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
    await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
    await page.getByTestId('live-lift-open-split').check();   // split panels (graph mode is the default with a package)
    await page.getByTestId('live-lift-add').click();
    await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 60_000 });
    const graph = await openGraphPanel(page);
    await expect(graph).toHaveAttribute('data-graph-lanes', 'grch38_chr3,pat_chr3,mat_chr3', { timeout: 120_000 });
    await settled(graph, 128_650_000, 120_000);
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 90_000 }).toBeGreaterThan(20);
    await expect(graph).toHaveAttribute('data-graph-reads-loading', 'false');
    const id = await graph.getAttribute('data-graph-panel-id');
    const geometry = () => page.evaluate((pid) => {
      const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string];
      const slot = e.scene.targetMap.find((t: any) => t.kind === 'slot' && Math.abs(t.x1 - t.x0) > 100);
      const mols = e.reads.molecules;
      const inSlot = (p: any) => slot && Math.min(p.x0, p.x1) >= Math.min(slot.x0, slot.x1) - 0.5 && Math.max(p.x0, p.x1) <= Math.max(slot.x0, slot.x1) + 0.5;
      return {
        lanes: Object.keys(e.reads.lanes).sort(),
        slot: slot ? [slot.t0, Math.round(Math.abs(slot.x1 - slot.x0))] : null,
        // Molecules walking the AluY: body inside the insertion slot, the source-only sequence.
        inSlot: Object.fromEntries(['mat_chr3', 'pat_chr3'].map(l => [l, mols.filter((m: any) => m.lane === l && m.body.some(inSlot)).length])),
        // Nothing of a molecule is drawn in its own connector space.
        crossing: mols.reduce((t: number, m: any) => t + m.connectors.filter((c: any) => c.x1 - c.x0 > 2).reduce((u: number, c: any) =>
          u + [...m.body, ...m.calls].filter((p: any) => p.x0 > c.x0 + 0.5 && p.x1 < c.x1 - 0.5).length, 0), 0),
        // Every piece of a call keeps the whole call: size and identity agree across its pieces.
        split: mols.reduce((t: number, m: any) => {
          const by = new Map<string, Set<string>>();
          for (const c of m.calls) { const k = `${c.layer}:${c.index}`; (by.get(k) ?? by.set(k, new Set()).get(k)!).add(`${c.id}|${c.call.join(',')}`); }
          return t + [...by.values()].filter(s => s.size > 1).length;
        }, 0),
        calls: mols.reduce((t: number, m: any) => t + m.calls.length, 0),
        identities: mols.flatMap((m: any) => m.calls.map((c: any) => `${m.read.k}|${c.layer}|${c.id}|${c.s0}|${c.s1}|${c.call[2]}`)).sort(),
      };
    }, id);
    const g = await geometry();
    expect(g.lanes).toEqual(['mat_chr3', 'pat_chr3']);
    expect(g.slot).not.toBeNull();   // the AluY insertion slot, one slot for MAT and PAT
    expect(g.inSlot.mat_chr3).toBeGreaterThan(5);
    expect(g.inSlot.pat_chr3).toBeGreaterThan(5);
    expect(g.crossing).toBe(0);
    expect(g.split).toBe(0);
    expect(g.calls).toBeGreaterThan(1000);
    // Hover names the molecule and the whole call under the pointer.
    const box = (await graph.getByTestId('graph-panel-canvas').boundingBox())!;
    const hit = await page.evaluate((pid) => {
      const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string];
      const h = e.reads.hits.find((x: any) => x.molecule.calls.some((c: any) => c.layer === 'nuc' && c.x1 - c.x0 > 4));
      const c = h.molecule.calls.find((x: any) => x.layer === 'nuc' && x.x1 - x.x0 > 4);
      return { x: (c.x0 + c.x1) / 2 + e.offset, y: (h.y0 + h.y1) / 2 };
    }, id);
    await page.mouse.move(box.x + hit.x, box.y + hit.y);
    await expect(page.getByTestId('graph-tooltip')).toContainText(/nucleosome [\d,]+ bp at [\d,]+-[\d,]+/);
    // The read bands follow the toolbar's Layers row (the read tracks' own toggles), with no refetch: m6A on draws
    // ticks, m6A off draws none.
    const drawn = () => page.evaluate((pid) => (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string].reads?.drawn ?? null, id);
    const m6a = page.getByTestId('layer-checkbox-m6a');
    await expect(m6a).toBeVisible({ timeout: 15_000 });
    let readRequests = 0;
    const countReads = (r: { url(): string }) => { if (r.url().includes('/api/graph/reads')) readRequests++; };
    page.on('request', countReads);
    await m6a.setChecked(true);
    await expect.poll(async () => ((await drawn())?.m6a ?? 0) + ((await drawn())?.m6aDensity ?? 0), { timeout: 10_000 }).toBeGreaterThan(0);
    await m6a.setChecked(false);
    await expect.poll(async () => { const d = await drawn(); return d ? d.m6a + d.m6aDensity : -1; }, { timeout: 10_000 }).toBe(0);
    expect((await drawn()).nuc).toBeGreaterThan(0);
    await expect(graph).toHaveAttribute('data-graph-reads-loading', 'false');
    page.off('request', countReads);
    expect(readRequests).toBe(0);   // redrawn from the loaded reads
    // Reversal mirrors the walk; every call piece keeps its identity, size and source span.
    await store(page, 'setPanelReversed', id, true);
    await expect.poll(async () => (await geometry()).identities.join('\n'), { timeout: 20_000 }).toBe(g.identities.join('\n'));
    await store(page, 'setPanelReversed', id, false);
    // The right-click menu turns reads off and on (rows show only data; options live in the menu).
    await graph.getByTestId('graph-panel-canvas').click({ button: 'right', position: { x: 200, y: 20 } });
    await page.getByTestId('graph-panel-menu').getByText(/^Reads:/).click();
    await page.getByText('✓ Show reads on the paths').click();
    await expect(graph).toHaveAttribute('data-graph-reads', '', { timeout: 10_000 });
    await graph.getByTestId('graph-panel-canvas').click({ button: 'right', position: { x: 200, y: 20 } });
    await page.getByTestId('graph-panel-menu').getByText(/^Reads:/).click();
    await page.getByText('Show reads on the paths').click();
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 60_000 }).toBeGreaterThan(20);
    await expect(page.getByTestId('graph-panel-status')).toContainText(/\d+ reads \(\d+ molecules\)/);
    if (process.env.FIBERBROWSER_GRAPH_SCREENSHOT_DIR) {
      const dir = process.env.FIBERBROWSER_GRAPH_SCREENSHOT_DIR;
      await page.evaluate((pid) => (window as any).__FIBERBROWSER_STORE__.setState({ fullViewPanelId: pid }), await graph.evaluate(el => el.closest('[data-analysis-panel-id]')?.getAttribute('data-analysis-panel-id')));
      await page.waitForTimeout(1200);
      await page.mouse.move(5, 5);
      const host = page.locator('[data-analysis-panel-id]').filter({ has: graph });
      await host.screenshot({ path: path.join(dir, 'graph-reads-aluy-light.png') });
      await store(page, 'toggleDarkMode');
      await page.waitForTimeout(400);
      await host.screenshot({ path: path.join(dir, 'graph-reads-aluy-dark.png') });
      await page.screenshot({ path: path.join(dir, 'graph-reads-aluy-dark-page.png') });
      await store(page, 'toggleDarkMode');
      await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ fullViewPanelId: null }));
    }
    // Navigation to reads: pans of a quarter width, twice (the second pass warm), measured to the reads of the
    // new window being drawn.
    if (MEASURE_OUT) {
      const traces: number[] = [];
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i <= 6; i++) {
          const start = 128_650_000 + i * 2_500;
          const t0 = await page.evaluate(([s]) => { (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr3', s, s + 10_000); return performance.now(); }, [start]);
          await expect(graph).toHaveAttribute('data-graph-reads-start', String(start), { timeout: 30_000 });
          await expect(graph).toHaveAttribute('data-graph-reads-loading', 'false', { timeout: 30_000 });
          traces.push(await page.evaluate(([a]) => performance.now() - a, [t0]));
        }
      }
      const summary = { n: traces.length, p50: percentile(traces, 50), p95: percentile(traces, 95), max: Math.max(...traces) };
      console.log('nav-to-reads', JSON.stringify(summary));
      writeFileSync(`${MEASURE_OUT}.reads.json`, JSON.stringify({ traces, summary }, null, 1));
    }
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
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
    // The AluY locus in both themes (the graph canvas stays light, like every track canvas).
    if (process.env.FIBERBROWSER_GRAPH_SCREENSHOT_DIR) {
      await page.mouse.move(5, 5);
      await page.waitForTimeout(300);
      const dir = process.env.FIBERBROWSER_GRAPH_SCREENSHOT_DIR;
      const host = page.locator('[data-analysis-panel-id]').filter({ has: graph });
      await host.screenshot({ path: path.join(dir, 'graph-aluy-light.png') });
      await store(page, 'toggleDarkMode');
      await page.waitForTimeout(400);
      await host.screenshot({ path: path.join(dir, 'graph-aluy-dark.png') });
      await page.screenshot({ path: path.join(dir, 'graph-aluy-dark-page.png') });
      await store(page, 'toggleDarkMode');
      await page.waitForTimeout(200);
    }
    const loci: Array<[string, string, number, number]> = [
      ['AluY_10kb', 'chr3', 128_650_000, 10_000], ['AluY_50kb', 'chr3', 128_635_000, 50_000],
      ['MHC_10kb', 'chr6', 29_000_000, 10_000], ['MHC_50kb', 'chr6', 29_000_000, 50_000],
      ['chr19_10kb', 'chr19', 43_017_556, 10_000], ['chr19_50kb', 'chr19', 43_017_556, 50_000],
      ['chr21_10kb', 'chr21', 10_371_898, 10_000], ['chr21_50kb', 'chr21', 10_371_898, 50_000],
    ];
    for (const [label, chrom, start, width] of loci) {
      // Pans of a quarter width from the locus, twice over (the second pass is warm).
      const windows: Array<[string, number, number]> = [];
      for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 6; i++) windows.push([chrom, start + i * (width / 4), start + i * (width / 4) + width]);
      out[label] = await measure(page, graph, label, windows, chrom === 'chr3' ? undefined : typedLocus(page, graph));
      console.log(JSON.stringify((out[label] as any).summary));
    }
    // MHC and chr19 at 10 kb (the panel navigates on its own by now).
    if (process.env.FIBERBROWSER_GRAPH_SCREENSHOT_DIR) {
      const dir = process.env.FIBERBROWSER_GRAPH_SCREENSHOT_DIR;
      const host = page.locator('[data-analysis-panel-id]').filter({ has: graph });
      for (const [name, chrom, start] of [['graph-mhc-light.png', 'chr6', 29_000_000], ['graph-chr19-light.png', 'chr19', 43_017_556]] as const) {
        await typedLocus(page, graph)(chrom, start, start + 10_000);
        await settled(graph, start, 60_000);
        await page.mouse.move(5, 5);
        await page.waitForTimeout(300);
        await host.screenshot({ path: path.join(dir, name) });
      }
    }
  } finally {
    await stopServer(server);
    writeFileSync(`${MEASURE_OUT}.hprc.json`, JSON.stringify(out, null, 1));
  }
});

/** A scene hit's centre (CSS px in the canvas) by payload kind and target boundary. */
async function hitAt(page: Page, panel: Locator, kind: string, boundary: number) {
  const id = await panel.getAttribute('data-graph-panel-id');
  return page.evaluate(([pid, k, b]) => {
    const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string];
    const h = e?.scene.hits.filter((x: any) => x.payload.kind === k && (x.payload.boundary === b || x.payload.group?.target?.start === b)).at(-1);
    return h ? { x: (h.x0 + h.x1) / 2 + e.offset, y: (h.y0 + h.y1) / 2, w: h.x1 - h.x0 } : null;
  }, [id, kind, boundary] as const);
}

async function canvasPoint(panel: Locator, at: { x: number; y: number }) {
  const canvas = panel.getByTestId('graph-panel-canvas');
  const box = (await canvas.boundingBox())!;
  const css = await canvas.evaluate((c: HTMLCanvasElement) => c.clientWidth);
  const s = box.width / css;
  return { x: box.x + at.x * s, y: box.y + at.y * s };
}

test('Gate F: graph-only inspection, expansion, focus, source span and restore with live lift off', async ({ page }) => {
  test.setTimeout(240_000);
  const server = await graphServer([ALU], null, { FIBERBROWSER_LIVE_LIFT: '0' });
  try {
    const errors = await preparePage(page);
    await page.goto(`${server.baseUrl}/?chr=chr3&start=92395&end=102395`);
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
    expect((await (await page.request.get(`${server.baseUrl}/api/lift/enabled`)).json()).enabled).toBe(false);
    const graph = await openGraphPanel(page);
    await expect(graph).toHaveAttribute('data-graph-lanes', 'target,mat,pat', { timeout: 30_000 });
    await settled(graph, 92_395);
    const canvas = graph.getByTestId('graph-panel-canvas');

    // A plain click on the AluY slot expands it (true bp); it never opens the inspector.
    const slot = (await hitAt(page, graph, 'slot', 97_395))!;
    await page.mouse.click(...Object.values(await canvasPoint(graph, slot)) as [number, number]);
    await expect(graph).not.toHaveAttribute('data-graph-expanded', '');
    await expect(page.getByTestId('graph-inspector')).toHaveCount(0);
    await expect.poll(async () => (await hitAt(page, graph, 'slot', 97_395))?.w ?? 0).toBeGreaterThan(slot.w);
    await page.screenshot({ path: test.info().outputPath('gateF-expanded.png') });

    // ⌘/Ctrl-click: the inspector, with no dataset: both alleles, both frames, no read binding, no canonical reuse.
    const wide = (await hitAt(page, graph, 'slot', 97_395))!;
    const pt = await canvasPoint(graph, wide);
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.click(pt.x, pt.y);
    await page.keyboard.up('ControlOrMeta');
    const inspector = page.getByTestId('graph-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toHaveAttribute('data-what', 'insertion');
    await expect(inspector).toHaveAttribute('data-kind', 'graph-difference');
    await expect(inspector.getByTestId('graph-inspector-alleles')).toContainText('2,353 bp');
    await expect(inspector.getByTestId('graph-inspector-alleles')).toContainText('2,350 bp');
    await expect(inspector.getByTestId('graph-inspector-reads')).toContainText('No read binding');
    await expect(inspector.getByTestId('graph-inspector-canonical')).toContainText('No canonical live-lift difference');
    await inspector.getByTestId('graph-inspector-load-sequence').first().click();
    await expect.poll(async () => ((await inspector.getByTestId('graph-inspector-bases').first().textContent()) ?? '').length).toBeGreaterThan(100);
    await page.screenshot({ path: test.info().outputPath('gateF-inspector.png') });

    // Focus the insertion boundary: following the main view, the main view moves (its own frame) and the graph follows.
    await inspector.getByTestId('graph-inspector-focus').click();
    await expect.poll(async () => {
      const [a, b] = [Number(await graph.getAttribute('data-graph-start')), Number(await graph.getAttribute('data-graph-end'))];
      return a < 97_395 && b > 97_395 && b - a <= 8_000;
    }).toBe(true);
    await expect(graph).toHaveAttribute('data-graph-link', 'follow');
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start)).toBe(Number(await graph.getAttribute('data-graph-start')));
    await settled(graph, Number(await graph.getAttribute('data-graph-start')));

    // Right-click: Inspect, Collapse, Focus and the source span, in the menu (rows show only data).
    const now = (await hitAt(page, graph, 'slot', 97_395))!;
    const rp = await canvasPoint(graph, now);
    await page.mouse.click(rp.x, rp.y, { button: 'right' });
    const menu = page.getByTestId('graph-panel-menu');
    await expect(menu.getByText('Inspect', { exact: true })).toBeVisible();
    await expect(menu.getByText('Collapse the insertion')).toBeVisible();
    await menu.getByText(/^Show source span/).click();
    // No source panel of these files: a graph view on the MAT path itself, its span holding the inserted bases.
    await page.getByText(/^MAT 94,676-97,029 .*a graph view on the path/).click();
    await expect(page.getByTestId('graph-panel')).toHaveCount(2);
    const pathView = page.getByTestId('graph-panel').nth(1);
    await expect(pathView).toHaveAttribute('data-graph-lanes', 'mat', { timeout: 30_000 });
    expect(Number(await pathView.getAttribute('data-graph-start'))).toBeLessThanOrEqual(94_676);
    expect(Number(await pathView.getAttribute('data-graph-end'))).toBeGreaterThanOrEqual(97_029);
    await expect(pathView).toHaveAttribute('data-graph-link', 'independent');

    // Closing the graph panel the selection came from: the inspection stays usable (frozen data, no actions on it).
    const pathPanelId = await pathView.getAttribute('data-graph-panel-id');
    await store(page, 'closeAnalysisPanel', pathPanelId);
    await expect(page.getByTestId('graph-panel')).toHaveCount(1);
    await expect(inspector).toBeVisible();

    // Restore at other package revisions: the panel says so, keeps its saved view frozen, and the inspector does
    // not re-resolve the selection.
    const id = await graph.getAttribute('data-graph-panel-id');
    const saved = await page.evaluate((pid) => JSON.parse(JSON.stringify((window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.id === pid).graphView)), id);
    await page.evaluate(([pid, gv]) => {
      const s = (window as any).__FIBERBROWSER_STORE__;
      const sel = s.getState().graphSelection;
      s.setState({ panels: s.getState().panels.map((p: any) => p.id === pid ? { ...p, graphView: { ...(gv as any), linkMode: 'independent', packageRevision: 'stale' } } : p),
        graphSelection: { ...sel, revisions: { ...sel.revisions, package: 'stale' } }, graphInspect: true });
    }, [id, saved] as const);
    await expect(graph.getByTestId('graph-panel-stale')).toBeVisible();
    await expect(graph.getByTestId('graph-panel-frozen')).toContainText('target chr3:');
    await expect(inspector).toHaveAttribute('data-problem', /changed since it was selected/);
    await expect(inspector.getByTestId('graph-inspector-focus')).toHaveCount(0);
    // The same revisions again: live.
    await page.evaluate(([pid, gv]) => {
      const s = (window as any).__FIBERBROWSER_STORE__;
      s.setState({ panels: s.getState().panels.map((p: any) => p.id === pid ? { ...p, graphView: gv } : p) });
    }, [id, saved] as const);
    await expect(graph.getByTestId('graph-panel-stale')).toHaveCount(0);
    await expect(graph).toHaveAttribute('data-graph-lanes', 'target,mat,pat', { timeout: 30_000 });
    await page.getByTestId('graph-inspector-close').click();
    await expect(inspector).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
  }
});

test('Gate F: graph-plus-lifted-only and three-view molecule hover, canonical reuse, source panel and initiator closure (HPRC)', async ({ page }) => {
  test.skip(!HAVE_LIFT || process.env.FIBERBROWSER_LIVE_LIFT === '0', 'needs the pg-lift work data, the HPRC package (live lift is on unless FIBERBROWSER_LIVE_LIFT=0)');
  test.setTimeout(480_000);
  const server = await graphServer([HPRC]);
  try {
    const errors = await preparePage(page);
    await page.goto(`${server.baseUrl}/?chr=chr3&start=128650000&end=128660000`);
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-add-live-lift').click();
    await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
    await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
    await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
    await page.getByTestId('live-lift-open-split').check();   // split panels (graph mode is the default with a package)
    await page.getByTestId('live-lift-add').click();
    await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 60_000 });
    const graph = await openGraphPanel(page);
    await expect(graph).toHaveAttribute('data-graph-lanes', 'grch38_chr3,pat_chr3,mat_chr3', { timeout: 120_000 });
    await settled(graph, 128_650_000, 120_000);
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 90_000 }).toBeGreaterThan(20);
    await expect(graph).toHaveAttribute('data-graph-reads-loading', 'false');
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
    const id = await graph.getAttribute('data-graph-panel-id');
    const hap = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.liftHap === 'PAT'));
    const hapCanvas = page.locator(`[data-read-track-state-key="${hap.stateKey ?? hap.datasetId}"] canvas[data-copilot-track="reads"]`);

    // Graph-plus-lifted-only: no source panel is open; hovering graph molecules outlines the lifted PAT panel's rows.
    const hits = await page.evaluate((pid) => (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string].reads.hits
      .filter((h: any) => h.molecule.read.b === 'pat_chr3').map((h: any) => ({ x: (h.x0 + h.x1) / 2, y: (h.y0 + h.y1) / 2 })), id);
    const offset = await page.evaluate((pid) => (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string].offset, id);
    let shared = false;
    for (const h of hits.slice(0, 60)) {
      const p = await canvasPoint(graph, { x: h.x + offset, y: h.y });
      if (p.y > 990) continue;   // below the window: not hoverable
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(80);
      if (Number(await hapCanvas.getAttribute('data-lift-hover-rows')) > 0) { shared = true; break; }
    }
    expect(shared).toBe(true);
    expect(await page.evaluate((pid) => (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string].reads.hovered, id)).toBeGreaterThan(0);
    await page.mouse.move(5, 5);

    // Open PAT's linked source view: three views share the hover (graph ↔ lifted ↔ source).
    await page.getByTestId(`panel-actions-${hap.id}`).click();
    await page.getByTestId('live-lift-open-source-PAT').click();
    await expect(page.getByTestId('lift-link-chip')).toHaveCount(1, { timeout: 60_000 });
    const linked = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.liftLink));
    await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
    const srcCanvas = page.locator(`[data-read-track-state-key="${linked.stateKey}"] canvas[data-copilot-track="reads"]`);
    let three = false;
    const hits2 = await page.evaluate((pid) => (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string].reads.hits
      .filter((h: any) => h.molecule.read.b === 'pat_chr3').map((h: any) => ({ x: (h.x0 + h.x1) / 2, y: (h.y0 + h.y1) / 2 })), id);
    const offset2 = await page.evaluate((pid) => (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string].offset, id);
    for (const h of hits2.slice(0, 80)) {
      const p = await canvasPoint(graph, { x: h.x + offset2, y: h.y });
      if (p.y > 990) continue;
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(80);
      if (Number(await hapCanvas.getAttribute('data-lift-hover-rows')) > 0 && Number(await srcCanvas.getAttribute('data-lift-hover-rows')) > 0) { three = true; break; }
    }
    expect(three).toBe(true);
    await page.screenshot({ path: test.info().outputPath('gateF-three-view-hover.png') });
    await page.mouse.move(5, 5);

    // The canonical difference is reused: the dataset's map is the package's map, same boundary and placement.
    const slot = await page.evaluate((pid) => {
      const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__[pid as string];
      const h = e.scene.hits.filter((x: any) => x.payload.kind === 'slot' && x.x1 - x.x0 > 60).at(-1);
      return h ? { x: (h.x0 + h.x1) / 2 + e.offset, y: (h.y0 + h.y1) / 2, b: h.payload.boundary } : null;
    }, id);
    expect(slot).not.toBeNull();
    const sp = await canvasPoint(graph, slot!);
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.click(sp.x, sp.y);
    await page.keyboard.up('ControlOrMeta');
    const inspector = page.getByTestId('graph-inspector');
    await expect(inspector).toHaveAttribute('data-what', 'insertion');
    await expect(inspector).not.toHaveAttribute('data-canonical', '', { timeout: 30_000 });
    await expect(inspector.getByTestId('graph-inspector-reads')).toContainText(/\d+ molecules of/);

    // Show source span in the open source panel: it moves to the PAT insertion's own span (the inserted bases).
    const target = inspector.getByTestId('graph-inspector-placement').filter({ hasText: 'PAT' }).first();
    const [s0, s1] = [Number(await target.getAttribute('data-start')), Number(await target.getAttribute('data-end'))];
    await target.getByTestId('graph-inspector-show-source').click();
    await expect.poll(async () => {
      const v = await page.evaluate((lid) => (window as any).__FIBERBROWSER_STORE__.getState().panels.find((p: any) => p.id === lid)?.viewportOverride, linked.id);
      return Boolean(v && v.start <= s0 && v.end >= s1);
    }, { timeout: 20_000 }).toBe(true);

    // Closing the source panel: graph inspection and navigation stay usable.
    await store(page, 'removePanel', linked.id);
    await expect(page.getByTestId('lift-link-chip')).toHaveCount(0, { timeout: 20_000 });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByTestId('graph-inspector-focus')).toBeVisible();

    // Following a panel with a view of its own (the initiator), then closing it: the graph stays where it was, on its own.
    await page.evaluate((mid) => (window as any).__FIBERBROWSER_STORE__.getState().navigatePanelOwnView(mid, 'chr3', 128_651_000, 128_661_000), hap.id);
    await graph.getByTestId('graph-panel-canvas').click({ button: 'right', position: { x: 120, y: 12 } });
    await page.getByTestId('graph-panel-menu').getByText(/^Follow .*128,651,000/).click();
    await expect(graph).toHaveAttribute('data-graph-start', '128651000', { timeout: 20_000 });
    await store(page, 'removePanel', hap.id);
    await expect(graph).toHaveAttribute('data-graph-link', 'independent', { timeout: 20_000 });
    await expect(graph).toHaveAttribute('data-graph-start', '128651000');
    await page.getByTestId('graph-inspector-close').click();
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
  }
});
