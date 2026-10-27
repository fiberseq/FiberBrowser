/**
 * Cluster on graph columns (DESIGN_GRAPH_PRIMARY v2.2 G4/G5) with the real helper, the HPRC package and the live-lift
 * demo data, in a real browser: the toolbar Cluster, run while the host draws its graph, fits each haplotype once on
 * node columns and labels both sub-bands with one labelling; popping out a haplotype shows the same labels in its
 * linear panel and never refits; folding it back keeps them; undo and redo restore the run.
 *
 * Needs FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE, FIBERBROWSER_TEST_LIFT_{BAM,MAP},
 * FIBERBROWSER_TEST_FASTA (chr3) and FIBERBROWSER_LIVE_LIFT=1. FIBERBROWSER_GRAPH_SHOTS: a folder for screenshots.
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
const SHOTS = process.env.FIBERBROWSER_GRAPH_SHOTS?.trim();
const READY = [HELPER, HPRC, LIFT_BAM, LIFT_MAP].every(p => p && existsSync(p)) && process.env.FIBERBROWSER_LIVE_LIFT !== '0'
  && Boolean(process.env.FIBERBROWSER_TEST_FASTA);
// The four P2B AluY peaks (each 100 bp, carried by both haplotypes).
const PEAKS = [[128655000, 128655100], [128656200, 128656300], [128658000, 128658100], [128659000, 128659100]];

async function graphServer(): Promise<ServerProcess> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-graph-cluster-'));
  const env = { FIBERBROWSER_GRAPH_HELPER: HELPER, FIBERBROWSER_GRAPH_PACKAGES: HPRC, FIBERBROWSER_GRAPH_REGISTRY: path.join(scratch, 'reg.json') };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await startServer(null, await pickRandomPort()); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const store = (page: Page) => ({
  panels: () => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.filter((p: any) => p.contentType === 'dataset')
    .map((p: any) => ({ id: p.id, stateKey: p.stateKey ?? p.datasetId, liftHap: p.liftHap, viewMode: p.viewMode, collapsed: p.collapsed,
      member: p.graphMemberOf ?? null }))),
  assignments: () => page.evaluate(() => JSON.stringify((window as any).__FIBERBROWSER_STORE__.getState().clusterAssignments)),
  labels: (key: string) => page.evaluate(k => Object.values((window as any).__FIBERBROWSER_STORE__.getState().clusterAssignments[k as string] ?? {}) as number[], key),
  run: () => page.evaluate(() => {
    const r = (window as any).__FIBERBROWSER_STORE__.getState().clusterMatchedRun;
    return r ? { graph: Boolean(r.graph), observations: r.graph?.observations.length ?? 0, destinations: (r.destinations ?? []).map((d: any) => d.stateKey) } : null;
  }),
  groups: (id: string) => page.evaluate(pid => {
    const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string];
    return e?.reads ? Object.values(e.reads.lanes).flatMap((l: any) => (l.groups ?? []).map((g: any) => ({ member: g.member, order: g.order, reads: g.reads }))) : [];
  }, id),
});

async function headerItem(page: Page, panelId: string, testId: string) {
  await page.getByTestId(`panel-actions-${panelId}`).click();
  await page.getByTestId(testId).first().click();
}

test('Cluster on graph columns: one labelling across haplotypes and pop-outs, never refitted by a pop-out (HPRC)', async ({ page }) => {
  test.skip(!READY, 'needs the graph helper, the HPRC package, the live-lift demo data (live lift is on unless FIBERBROWSER_LIVE_LIFT=0)');
  test.setTimeout(600_000);
  const server = await graphServer();
  const s = store(page);
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
    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-add-live-lift').click();
    await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
    await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
    await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
    await page.getByTestId('live-lift-add').click();
    await expect.poll(async () => (await s.panels()).filter(p => p.viewMode === 'graph').length, { timeout: 120_000 }).toBe(1);
    const panels = await s.panels();
    const host = panels.find(p => p.viewMode === 'graph')!;
    const pat = panels.find(p => p.id !== host.id)!;
    const graph = page.locator(`[data-testid="graph-host-body"][data-panel-id="${host.id}"] [data-testid="graph-panel"]`);
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 120_000 }).toBeGreaterThan(20);

    // The four peaks on the target, selected: the toolbar says it clusters on graph columns.
    await page.evaluate(peaks => {
      const st = (window as any).__FIBERBROWSER_STORE__;
      const rule = { ...st.getState().peakRules[0], id: 'aluy', enabled: true, name: 'AluY peaks', color: '#167dcd' };
      st.setState({ clusterMethod: 'combinatorial', clusterK: 4, clusterPeakMode: 'accessibility', selectedPeaks: new Set(peaks.map((_: unknown, i: number) => i)),
        peakRules: [rule], peaksByRule: { aluy: peaks.map(([start, end]: number[], index: number) => ({ start, end, index, layer: 0, chrom: 'chr3' })) }, peaksLocked: true });
    }, PEAKS);
    await expect.poll(() => page.getByTestId('cluster-run-button').getAttribute('title')).toContain('graph columns');
    await page.getByTestId('cluster-run-button').click();
    await expect.poll(s.run, { timeout: 120_000 }).toMatchObject({ graph: true, observations: 2 });
    expect(fits).toHaveLength(1);
    expect(fits[0].observations.map((o: any) => o.binding).sort()).toEqual(['mat_chr3', 'pat_chr3']);
    expect((await s.run())!.destinations.sort()).toEqual([host.stateKey, pat.stateKey].sort());

    // One labelling: both haplotypes labelled, sub-bands grouped by cluster.
    const matLabels = await s.labels(host.stateKey!);
    const patLabels = await s.labels(pat.stateKey!);
    expect(matLabels.length).toBeGreaterThan(10);
    expect(patLabels.length).toBeGreaterThan(10);
    expect(new Set(matLabels).has(0) && new Set(patLabels).has(0)).toBe(true);
    await expect.poll(async () => (await s.groups(host.id)).filter(g => g.order === 'cluster').length).toBeGreaterThanOrEqual(2);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-graph-cluster.png') });

    // Pop out PAT: the same labels in its linear panel, no refit.
    const before = await s.assignments();
    await headerItem(page, host.id, 'graph-pop-out');
    await expect.poll(async () => (await s.panels()).find(p => p.id === pat.id)?.collapsed).toBe(false);
    await expect.poll(() => page.evaluate(k => ((window as any).__FIBERBROWSER_STORE__.getState().activeReadIds[k as string] ?? []).length, pat.stateKey),
      { timeout: 60_000 }).toBeGreaterThan(10);
    // Its drawn rows find their labels (by record key): every drawn row is one of the run's labelled records.
    const drawn = await page.evaluate(k => {
      const st = (window as any).__FIBERBROWSER_STORE__.getState();
      return (st.activeReadIds[k as string] ?? []).length;
    }, pat.stateKey);
    expect(drawn).toBeLessThanOrEqual(patLabels.length);
    expect(await s.assignments()).toBe(before);
    expect(fits).toHaveLength(1);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'e2e-graph-cluster-popout.png') });

    // Fold it back: labels kept, still one fit.
    await headerItem(page, pat.id, 'graph-fold-in');
    await expect.poll(async () => (await s.panels()).find(p => p.id === pat.id)?.collapsed).toBe(true);
    expect(await s.assignments()).toBe(before);
    expect(fits).toHaveLength(1);

    // Undo the run, redo it: the labels and the durable run come back.
    let steps = 0;
    while ((await s.run()) && steps < 6) {
      await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().undo());
      steps++;
    }
    expect(await s.run()).toBeNull();
    for (let i = 0; i < steps; i++) await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().redo());
    await expect.poll(s.run).toMatchObject({ graph: true });
    expect(await s.assignments()).toBe(before);
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
  }
});
