/**
 * The graph-mode workflow end to end (DESIGN_GRAPH_PRIMARY v2.2, G7/G8): comparable panels side by side and
 * co-analysed, with the real helper, the HPRC package and the live-lift demo data plus a native GRCh38 dataset:
 *
 * - a new lifted dataset opens in graph mode (one haplotype hosts, the other folded in); the native panel joins the
 *   graph and its reads are drawn on the target path;
 * - toggle to linear (members side by side) and back (folded again), pop out a haplotype and fold it back;
 * - Cluster on graph columns across the three members (one fit each), then a pan away from the regions keeps the run;
 * - sub-bands fill the panel, each band's report and budgets; a short panel draws density strips;
 * - the zoom hand-off keeps the run: linear above 50 kb with members revealed, the graph again at 30 kb;
 * - screenshots in both themes (FIBERBROWSER_GRAPH_SHOTS).
 *
 * Needs FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE, FIBERBROWSER_TEST_LIFT_{BAM,MAP,NATIVE},
 * FIBERBROWSER_TEST_FASTA (chr3) and FIBERBROWSER_LIVE_LIFT=1.
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickRandomPort, startServer, stopServer, type ServerProcess } from './fixtures/server';

const HELPER = process.env.FIBERBROWSER_TEST_GRAPH_HELPER?.trim() ?? '';
const HPRC = process.env.FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE?.trim() ?? '';
const LIFT_BAM = process.env.FIBERBROWSER_TEST_LIFT_BAM ?? '';
const LIFT_MAP = process.env.FIBERBROWSER_TEST_LIFT_MAP ?? '';
const NATIVE_BAM = process.env.FIBERBROWSER_TEST_LIFT_NATIVE ?? '';
const SHOTS = process.env.FIBERBROWSER_GRAPH_SHOTS?.trim();
const READY = [HELPER, HPRC, LIFT_BAM, LIFT_MAP, NATIVE_BAM].every(p => p && existsSync(p)) && process.env.FIBERBROWSER_LIVE_LIFT === '1'
  && Boolean(process.env.FIBERBROWSER_TEST_FASTA);
const PEAKS = [[128655000, 128655100], [128656200, 128656300], [128658000, 128658100], [128659000, 128659100]];

async function graphServer(): Promise<ServerProcess> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-graph-workflow-'));
  const env = { FIBERBROWSER_GRAPH_HELPER: HELPER, FIBERBROWSER_GRAPH_PACKAGES: HPRC, FIBERBROWSER_GRAPH_REGISTRY: path.join(scratch, 'reg.json') };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await startServer(NATIVE_BAM, await pickRandomPort()); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const S = (page: Page) => ({
  panels: () => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.filter((p: any) => p.contentType === 'dataset')
    .map((p: any) => ({ id: p.id, ds: p.datasetId, stateKey: p.stateKey ?? p.datasetId, liftHap: p.liftHap, viewMode: p.viewMode,
      collapsed: p.collapsed, member: p.graphMemberOf ?? null, shown: p.graphView?.handoff?.shown ?? null }))),
  view: (start: number, end: number) => page.evaluate(([a, b]) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr3', a, b), [start, end] as const),
  scene: (id: string) => page.evaluate(pid => {
    const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string];
    return e?.reads ? { groups: Object.values(e.reads.lanes).flatMap((l: any) => l.groups ?? []), strips: e.reads.strips ?? 0,
      bands: e.reads.report?.bands ?? [], budgets: e.reads.report?.budgets ?? null } : null;
  }, id),
  run: () => page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    const r = st.clusterMatchedRun;
    const labelled = Object.values(st.clusterAssignments).reduce((n: number, a: any) => n + Object.keys(a).length, 0);
    return r ? { graph: Boolean(r.graph), observations: r.graph?.observations.length ?? 0, labelled } : null;
  }),
});

async function headerItem(page: Page, panelId: string, testId: string, member?: string) {
  await page.getByTestId(`panel-actions-${panelId}`).click();
  const item = member ? page.locator(`[data-testid="${testId}"][data-member="${member}"]`) : page.getByTestId(testId);
  await item.first().click();
}

test('graph workflow: join a native panel, toggle, pop out and fold, Cluster, pan, strips, hand-off (HPRC)', async ({ page }) => {
  test.skip(!READY, 'needs the graph helper, the HPRC package, the live-lift demo data (and its native BAM) and FIBERBROWSER_LIVE_LIFT=1');
  test.setTimeout(600_000);
  const server = await graphServer();
  const s = S(page);
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const fits: any[] = [];
    page.on('request', r => { if (r.url().endsWith('/api/graph/cluster')) fits.push(r.postDataJSON()); });
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    });
    await page.goto(`${server.baseUrl}/?chr=chr3&start=128653000&end=128661000`);
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await s.panels()).length, { timeout: 60_000 }).toBe(1);
    const native = (await s.panels())[0];
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-add-live-lift').click();
    await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
    await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
    await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
    await expect(page.getByTestId('live-lift-open-graph')).toBeChecked();
    await page.getByTestId('live-lift-add').click();
    await expect.poll(async () => (await s.panels()).filter(p => p.viewMode === 'graph').length, { timeout: 120_000 }).toBe(1);
    let panels = await s.panels();
    const host = panels.find(p => p.viewMode === 'graph')!;
    const pat = panels.find(p => p.member === host.id)!;
    expect(pat).toMatchObject({ collapsed: true });
    const graph = page.locator(`[data-testid="graph-host-body"][data-panel-id="${host.id}"] [data-testid="graph-panel"]`);
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 120_000 }).toBeGreaterThan(20);

    // The native panel joins the graph: folded in, its reads on the target path in a sub-band of their own.
    await headerItem(page, host.id, 'graph-add-panel', native.id);
    await expect.poll(async () => (await s.panels()).find(p => p.id === native.id)).toMatchObject({ member: host.id, collapsed: true });
    await expect.poll(async () => (await s.scene(host.id))?.groups.map((g: any) => g.member).sort(), { timeout: 60_000 })
      .toEqual([host.id, pat.id, native.id].sort());
    // Fill height: every member's rows; the report lists each band and the profile's budgets.
    const filled = (await s.scene(host.id))!;
    expect(filled.bands.length).toBe(3);
    expect(filled.budgets.molecules).toBeGreaterThanOrEqual(1000);
    expect(filled.groups.every((g: any) => g.rows > 0)).toBe(true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-workflow-graph-light.png') });

    // Toggle to linear: every member side by side; back to the graph: folded again.
    await page.locator(`[data-panel-id="${host.id}"] [data-testid="graph-mode-toggle"]`).first().click();
    await expect.poll(async () => (await s.panels()).find(p => p.id === host.id)?.viewMode).toBe('linear');
    panels = await s.panels();
    expect(panels.find(p => p.id === pat.id)!.collapsed).toBe(false);
    expect(panels.find(p => p.id === native.id)!.collapsed).toBe(false);
    await headerItem(page, host.id, 'graph-view-as-graph');
    await expect.poll(async () => (await s.panels()).filter(p => p.member === host.id && p.collapsed).length).toBe(2);

    // Pop out PAT, fold it back.
    await headerItem(page, host.id, 'graph-pop-out', pat.id);
    await expect.poll(async () => (await s.panels()).find(p => p.id === pat.id)?.collapsed).toBe(false);
    await headerItem(page, pat.id, 'graph-fold-in');
    await expect.poll(async () => (await s.panels()).find(p => p.id === pat.id)?.collapsed).toBe(true);

    // Cluster on graph columns: one fit, three observations (MAT, PAT, native).
    await page.evaluate(peaks => {
      const st = (window as any).__FIBERBROWSER_STORE__;
      const rule = { ...st.getState().peakRules[0], id: 'aluy', enabled: true, name: 'AluY peaks', color: '#167dcd' };
      st.setState({ clusterMethod: 'kmeans', clusterK: 3, clusterPeakMode: 'accessibility', selectedPeaks: new Set(peaks.map((_: unknown, i: number) => i)),
        peakRules: [rule], peaksByRule: { aluy: peaks.map(([start, end]: number[], index: number) => ({ start, end, index, layer: 0, chrom: 'chr3' })) }, peaksLocked: true });
    }, PEAKS);
    await expect.poll(() => page.getByTestId('cluster-run-button').getAttribute('title')).toContain('graph columns');
    await page.getByTestId('cluster-run-button').click();
    await expect.poll(s.run, { timeout: 120_000 }).toMatchObject({ graph: true, observations: 3 });
    expect(fits).toHaveLength(1);
    const labelled = (await s.run())!.labelled;
    expect(labelled).toBeGreaterThan(40);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-workflow-cluster-light.png') });

    // A pan away from the regions keeps the run (its regions are graph columns, not the view).
    await s.view(128_666_000, 128_674_000);
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-drawn-start') || 0), { timeout: 60_000 }).toBe(128_666_000);
    expect(await s.run()).toMatchObject({ graph: true, observations: 3 });
    expect((await s.run())!.labelled).toBeGreaterThanOrEqual(labelled);
    await s.view(128_653_000, 128_661_000);

    // A short panel: bands share its height, and the ones drawing fewer rows than molecules get density strips.
    await page.evaluate(pid => (window as any).__FIBERBROWSER_STORE__.setState((st: any) => ({
      panels: st.panels.map((p: any) => (p.id === pid ? { ...p, graphView: { ...p.graphView, reads: { ...(p.graphView.reads ?? { show: true, datasets: null }), maxRowsPerLane: 20 } } } : p)) })), host.id);
    await expect.poll(async () => (await s.scene(host.id))?.strips ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    const stripped = (await s.scene(host.id))!;
    expect(stripped.groups.some((g: any) => g.strip > 0 && g.hidden > 0)).toBe(true);
    if (SHOTS) {
      await page.screenshot({ path: path.join(SHOTS, 'e2e-workflow-strips-light.png') });
      await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().toggleDarkMode());
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS, 'e2e-workflow-strips-dark.png') });
      await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().toggleDarkMode());
    }

    // The zoom hand-off keeps the run: linear above 50 kb (members side by side), graph again at 30 kb.
    await s.view(128_620_000, 128_690_000);
    await expect.poll(async () => (await s.panels()).find(p => p.id === host.id)?.shown, { timeout: 10_000 }).toBe('linear');
    panels = await s.panels();
    expect(panels.filter(p => p.member === host.id).every(p => !p.collapsed)).toBe(true);
    expect(await s.run()).toMatchObject({ graph: true });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-workflow-handoff-light.png') });
    await s.view(128_640_000, 128_670_000);
    await expect.poll(async () => (await s.panels()).find(p => p.id === host.id)?.shown, { timeout: 10_000 }).toBe('graph');
    await expect.poll(async () => (await s.panels()).filter(p => p.member === host.id && p.collapsed).length).toBe(2);
    expect(await s.run()).toMatchObject({ graph: true });
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
  }
});
