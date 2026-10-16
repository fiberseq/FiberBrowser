/**
 * Navigation with background work on: auto-scanned peaks, the toolbar's quality summary (the FIRE default filter) and
 * whatever background panels the caller opens. Pans the reads by dragging and logs every /api request with its
 * timing, then checks that
 * - each background endpoint is asked at most once per settled view (no duplicate in-flight requests, nothing
 *   re-fired for the same view), and
 * - the reads load first: no background request is sent before the view's reads have arrived.
 *
 * On the tracked demo BAM by default. FIBERBROWSER_NAVPERF_BAM (+ _REGION) points it at a heavier BAM, and
 * FIBERBROWSER_NAVPERF_OUT writes the request log and per-pan summary as JSON (the before/after measurement).
 */
import { expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { DEMO_FIXTURE } from './server';

export const BAM = process.env.FIBERBROWSER_NAVPERF_BAM?.trim();
const OUT = process.env.FIBERBROWSER_NAVPERF_OUT?.trim();
const PANS = Number(process.env.FIBERBROWSER_NAVPERF_PANS ?? 6);
const DWELL_MS = Number(process.env.FIBERBROWSER_NAVPERF_DWELL_MS ?? 1500);
export const MEASURE = Boolean(OUT);

function parseRegion(value: string | undefined) {
  const m = value?.replace(/,/g, '').match(/^([^:]+):(\d+)-(\d+)$/);
  return m ? { chrom: m[1], start: Number(m[2]), end: Number(m[3]) } : null;
}
const REGION = parseRegion(process.env.FIBERBROWSER_NAVPERF_REGION) ?? DEMO_FIXTURE.region;


/** Background endpoints every run checks. */
const CORE_BACKGROUND = ['/api/quality/impact', '/api/scan_peaks', '/api/reads/top_windows'];

export interface NavperfOptions {
  /** Further background endpoints (those of the panels `setup` opens). */
  background?: string[];
  /** Open more background panels before the pans; `inflight(endpoint)` counts its requests still running. */
  setup?: (page: Page, inflight: (endpoint: string) => number) => Promise<void>;
}

interface Rec {
  id: number;
  method: string;
  endpoint: string;
  key: string;
  pan: number;
  start: number;
  end?: number;
  status?: number;
  failed?: string;
}

/** The view a request is about: its start (query or JSON body). */
function viewStart(key: string): string | null {
  return key.match(/[?&]start=(\d+)/)?.[1] ?? key.match(/"start":(\d+)/)?.[1] ?? null;
}

function serverCpuSeconds(port: number): number | null {
  try {
    const pid = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`).toString().trim().split('\n')[0];
    const t = execSync(`ps -o time= -p ${pid}`).toString().trim(); // [[dd-]hh:]mm:ss.cc
    return t.split(/[-:]/).map(Number).reduce((acc, v) => acc * 60 + v, 0);
  } catch {
    return null;
  }
}

async function readsSettled(page: Page, inflightCompact: () => number) {
  return (await page.locator('[data-read-track-loading="true"]').count()) === 0 && inflightCompact() === 0;
}

export async function runNavperf(page: Page, server: { baseUrl: string; port: number; bamPath?: string }, options: NavperfOptions): Promise<void> {
  const BACKGROUND = [...CORE_BACKGROUND, ...(options.background ?? [])];
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });

  const t0 = Date.now();
  let pan = 0;
  const recs: Rec[] = [];
  const byRequest = new Map<object, Rec>();
  page.on('request', req => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) return;
    const query = [...url.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join('&');
    const rec: Rec = {
      id: recs.length, method: req.method(), endpoint: url.pathname,
      key: `${req.method()} ${url.pathname}?${query} ${req.postData() ?? ''}`,
      pan, start: Date.now() - t0,
    };
    recs.push(rec);
    byRequest.set(req, rec);
  });
  page.on('requestfinished', async req => {
    const rec = byRequest.get(req);
    if (!rec) return;
    rec.end = Date.now() - t0;
    rec.status = (await req.response())?.status();
  });
  page.on('requestfailed', req => {
    const rec = byRequest.get(req);
    if (!rec) return;
    rec.end = Date.now() - t0;
    rec.failed = req.failure()?.errorText ?? 'failed';
  });
  const inflight = (endpoint: string) => recs.filter(r => r.endpoint === endpoint && r.end === undefined).length;
  const inflightCompact = () => inflight('/api/reads/compact');

  const cpu0 = serverCpuSeconds(server.port);
  await page.goto(`${server.baseUrl}/?chr=${REGION.chrom}&start=${REGION.start}&end=${REGION.end}`);
  const reads = page.locator('canvas[data-copilot-track="reads"]').first();
  await expect(reads).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => readsSettled(page, inflightCompact), { timeout: 180_000 }).toBe(true);

  // The Quality group open: its counts follow the view (folded, its summary asks nothing).
  const qualityToggle = page.getByTestId('toolbar-group-toggle-quality');
  if (await qualityToggle.count()) {
    if ((await qualityToggle.first().getAttribute('data-group-open')) !== 'true') await qualityToggle.first().click();
  }
  // More background panels opened by the caller (a plugin pack's), settled before panning.
  if (options.setup) await options.setup(page, inflight);
  // Let the first view's background work settle before panning (the peak scan waits ~1 s first).
  await page.waitForTimeout(2500);
  await expect.poll(() => recs.filter(r => r.end === undefined).length, { timeout: 300_000 }).toBe(0);

  const panRows: Array<{ pan: number; readsMs: number | null }> = [];
  for (let i = 1; i <= PANS; i++) {
    const box = (await reads.boundingBox())!;
    const y = box.y + Math.min(80, box.height / 2);
    const x = box.x + box.width * 0.6;
    const dx = (i % 3 === 0 ? 1 : -1) * box.width * 0.25; // mostly rightwards, sometimes back
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 8 });
    pan = i;
    const released = Date.now();
    await page.mouse.up();
    await page.waitForTimeout(150);
    let readsMs: number | null = null;
    try {
      await expect.poll(() => readsSettled(page, inflightCompact), { timeout: 150_000, intervals: [50] }).toBe(true);
      readsMs = Date.now() - released;
    } catch { /* recorded as null */ }
    panRows.push({ pan: i, readsMs });
    if (OUT) writeFileSync(`${OUT}.partial`, JSON.stringify({ panRows, recs }, null, 1));
    await page.waitForTimeout(DWELL_MS);
  }
  pan = PANS + 1;
  // Everything still running after the last pan: let it finish (or fail).
  await expect.poll(() => recs.filter(r => r.end === undefined).length, { timeout: MEASURE ? 600_000 : 120_000 }).toBe(0);
  const cpu1 = serverCpuSeconds(server.port);

  const summary = panRows.map(row => {
    const mine = recs.filter(r => r.pan === row.pan);
    const bg = mine.filter(r => BACKGROUND.includes(r.endpoint));
    const perEndpoint = Object.fromEntries(BACKGROUND.map(e => [e, bg.filter(r => r.endpoint === e).length]));
    // Duplicates: a background request identical to one still in flight.
    const dupes = bg.filter(r => recs.some(o => o !== r && o.key === r.key && o.start <= r.start && (o.end ?? Infinity) > r.start)).length;
    // Repeats: the same endpoint asked more than once for this pan's view.
    const repeats = Object.values(perEndpoint).reduce((n, c) => n + Math.max(0, c - 1), 0);
    const compact = mine.filter(r => r.endpoint === '/api/reads/compact' && r.end !== undefined && !r.failed);
    return {
      ...row, requests: mine.length, background: bg.length, aborted: bg.filter(r => r.failed).length,
      dupes, repeats, perEndpoint,
      compactMs: compact.map(r => r.end! - r.start),
      bgMs: bg.map(r => ({ e: r.endpoint, ms: (r.end ?? NaN) - r.start, failed: r.failed })),
      // Background requests sent before their view's reads arrived (matched by the view's start).
      bgBeforeReads: bg.filter(r => {
        const view = viewStart(r.key);
        const reads = recs.filter(c => c.endpoint === '/api/reads/compact' && !c.failed && c.end !== undefined
          && viewStart(c.key) === view);
        return reads.length > 0 && r.start < Math.min(...reads.map(c => c.end!));
      }).length,
    };
  });
  const report = { region: REGION, bam: server.bamPath, pans: PANS, dwellMs: DWELL_MS, cpuSeconds: cpu0 != null && cpu1 != null ? cpu1 - cpu0 : null, summary, recs };
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summary.map(({ bgMs, ...s }) => s)));

  expect(errors).toEqual([]);
  for (const row of summary) {
    expect(row.dupes, `pan ${row.pan}: duplicate in-flight background requests`).toBe(0);
    expect(row.repeats, `pan ${row.pan}: a background endpoint asked twice for one view`).toBe(0);
    expect(row.bgBeforeReads, `pan ${row.pan}: background requests sent before the reads arrived`).toBe(0);
    expect(row.readsMs, `pan ${row.pan}: reads never settled`).not.toBeNull();
  }
}
