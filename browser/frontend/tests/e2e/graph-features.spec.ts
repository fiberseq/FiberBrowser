/**
 * Graph mode at parity with linear panels (graph features), end to end with the real helper, the HPRC package and
 * the live-lift demo data:
 *
 * - toolbar Sort and Read Stats on a lifted dataset in graph mode: the requests are answered (no live-lift refusal),
 *   the band takes the sort order, Read Stats describes the lifted reads;
 * - Scan on graph columns (POST /api/graph/scan_peaks), then Cluster on the scanned peaks (graph columns);
 * - a graph run survives a bookmark jump and Back;
 * - past 50 kb (linear tracks) Scan scans the lifted dataset too.
 *
 * Needs FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE, FIBERBROWSER_TEST_LIFT_{BAM,MAP,NATIVE},
 * FIBERBROWSER_TEST_FASTA (chr3) and FIBERBROWSER_LIVE_LIFT=1.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/nativeDialogs';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickRandomPort, startServer, stopServer, type ServerProcess } from './fixtures/server';

const HELPER = process.env.FIBERBROWSER_TEST_GRAPH_HELPER?.trim() ?? '';
const HPRC = process.env.FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE?.trim() ?? '';
const LIFT_BAM = process.env.FIBERBROWSER_TEST_LIFT_BAM ?? '';
const LIFT_MAP = process.env.FIBERBROWSER_TEST_LIFT_MAP ?? '';
const NATIVE_BAM = process.env.FIBERBROWSER_TEST_LIFT_NATIVE ?? '';
const READY = [HELPER, HPRC, LIFT_BAM, LIFT_MAP, NATIVE_BAM].every(p => p && existsSync(p)) && process.env.FIBERBROWSER_LIVE_LIFT === '1'
  && Boolean(process.env.FIBERBROWSER_TEST_FASTA);

async function graphServer(): Promise<ServerProcess> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-graph-features-'));
  const env = { FIBERBROWSER_GRAPH_HELPER: HELPER, FIBERBROWSER_GRAPH_PACKAGES: HPRC, FIBERBROWSER_GRAPH_REGISTRY: path.join(scratch, 'reg.json') };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await startServer(NATIVE_BAM, await pickRandomPort()); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const state = <T,>(page: Page, fn: string) => page.evaluate(`(() => { const s = window.__FIBERBROWSER_STORE__.getState(); return (${fn})(s); })()`) as Promise<T>;

test('graph features: Sort, Read Stats, Scan on graph columns, Cluster, a run across Back, linear Scan (HPRC)', async ({ page }) => {
  test.skip(!READY, 'needs the graph helper, the HPRC package, the live-lift demo data and FIBERBROWSER_LIVE_LIFT=1');
  test.setTimeout(600_000);
  const server = await graphServer();
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const statuses: Record<string, number[]> = {};
    page.on('response', r => {
      const m = r.url().match(/\/api\/(sort_reads|reads\/stats|graph\/scan_peaks|scan_peaks|graph\/cluster)\?|\/api\/(graph\/scan_peaks|graph\/cluster)$/);
      if (m) (statuses[m[1] ?? m[2]] ??= []).push(r.status());
    });
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    });
    await page.goto(`${server.baseUrl}/?chr=chr3&start=128653000&end=128661000`);
    await expect.poll(() => state<number>(page, 's => s.chroms.length'), { timeout: 120_000 }).toBeGreaterThan(0);
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-add-live-lift').click();
    await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
    await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
    await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
    await page.getByTestId('live-lift-add').click();
    await expect.poll(() => state<number>(page, 's => s.panels.filter(p => p.viewMode === "graph").length'), { timeout: 120_000 }).toBe(1);
    const host = await state<string>(page, 's => s.panels.find(p => p.viewMode === "graph").id');
    const graph = page.locator(`[data-testid="graph-host-body"][data-panel-id="${host}"] [data-testid="graph-panel"]`);
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 120_000 }).toBeGreaterThan(20);

    // Sort: answered for the lifted dataset; the graph bands take the order.
    if (!await page.locator('[data-testid="toolbar-group-sort"] select').isVisible()) await page.getByTestId('toolbar-group-toggle-sort').click();
    await page.getByTestId('sort-run-button').click();
    await expect.poll(() => (statuses['sort_reads'] ?? []).length, { timeout: 90_000 }).toBeGreaterThan(0);
    expect((statuses['sort_reads'] ?? []).every(c => c === 200)).toBe(true);
    await expect.poll(() => page.evaluate(id => Object.values((window as any).__FIBERBROWSER_GRAPH_SCENES__?.[id]?.reads?.lanes ?? {})
      .flatMap((l: any) => (l.groups ?? []).map((g: any) => g.order)), host), { timeout: 60_000 }).toContain('sort');

    // Read Stats: lifted reads are described.
    await page.getByTestId('panel-rail-read-stats').click();
    await expect.poll(() => (statuses['reads/stats'] ?? []).length, { timeout: 60_000 }).toBeGreaterThan(0);
    expect((statuses['reads/stats'] ?? []).every(c => c === 200)).toBe(true);

    // Scan on graph columns, then Cluster on the scanned peaks.
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ peaksLocked: false }));
    await page.getByTestId('peak-scan-button').click();
    await expect.poll(() => (statuses['graph/scan_peaks'] ?? []).length, { timeout: 120_000 }).toBeGreaterThan(0);
    expect(statuses['graph/scan_peaks'].every(c => c === 200)).toBe(true);
    await expect.poll(() => state<number>(page, 's => Object.values(s.peaksByRule).reduce((n, l) => n + (l?.length ?? 0), 0)'),
      { timeout: 60_000 }).toBeGreaterThan(3);
    await page.evaluate(() => {
      const store = (window as any).__FIBERBROWSER_STORE__;
      const all = store.getState().getAllPeaks();
      const pick = all.filter((p: any) => [[128655000, 128655100], [128659000, 128659100]].some(([a, b]) => p.start < b && p.end > a));
      store.setState({ selectedPeaks: new Set(pick.map((p: any) => p.index)), clusterMethod: 'kmeans', clusterK: 2 });
    });
    await expect(page.getByTestId('cluster-run-button')).toHaveAttribute('title', /graph columns/);
    await page.getByTestId('cluster-run-button').click();
    await expect.poll(() => state<boolean>(page, 's => Boolean(s.clusterMatchedRun?.graph)'), { timeout: 120_000 }).toBe(true);

    // The run survives a bookmark jump and Back.
    const labelled = () => state<number>(page, 's => Object.values(s.clusterAssignments).reduce((n, a) => n + Object.keys(a).length, 0)');
    const before = await labelled();
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr3', 128666000, 128674000));
    await page.evaluate(() => { const st = (window as any).__FIBERBROWSER_STORE__; st.setState({ bookmarks: [{ id: 'b', name: 'b', chrom: 'chr3',
      start: 128653000, end: 128661000, created: '' }] }); st.getState().navigateToBookmark('b'); });
    await expect.poll(() => state<number>(page, 's => s.start')).toBe(128653000);
    expect(await state<boolean>(page, 's => Boolean(s.clusterMatchedRun?.graph)')).toBe(true);
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().goBack());
    await expect.poll(() => state<number>(page, 's => s.start')).toBe(128666000);
    expect(await state<boolean>(page, 's => Boolean(s.clusterMatchedRun?.graph)')).toBe(true);
    expect(await labelled()).toBeGreaterThanOrEqual(before);

    // Past 50 kb the host is linear; Scan scans the lifted dataset there too (no refusal).
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr3', 128620000, 128690000));
    await expect.poll(() => state<string>(page, `s => s.panels.find(p => p.id === "${host}")?.graphView?.handoff?.shown`), { timeout: 60_000 }).toBe('linear');
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.setState({ peaksLocked: false }));
    await page.getByTestId('peak-scan-button').click();
    await expect.poll(() => (statuses['scan_peaks'] ?? []).length, { timeout: 120_000 }).toBeGreaterThan(0);
    expect(statuses['scan_peaks'].every(c => c === 200)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
  }
});
