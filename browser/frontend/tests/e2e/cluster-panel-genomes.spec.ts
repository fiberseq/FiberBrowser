/**
 * Clusters with the hg38 demo and a dm6 dataset in its own panel (fb-n3-clusters,
 * audit H1/H2/L7). "Open with dm6 in its own panel" switches to Per panel mode,
 * where the main locus goes stale:
 *  - peaks selected on both assemblies are not clustered together (H1): the run
 *    is refused with the way out, and a run on one reference's peaks leaves the
 *    other reference's panel out;
 *  - Clusters > Charts > Projection, V-Plot and Enrichment plot the clustered
 *    panel at its own locus (and reference), not the stale main locus (H2);
 *  - the Neighbourhoods undo label names its resolution, not K (L7);
 *  - a dm6 run is sent on dm6 (panel_genome) at the dm6 panel's locus (fb-n4-integ).
 *
 * Needs a dm6 DddB amplicon BAM (FIBERBROWSER_TEST_DM6_BAM)
 * and dm6 in ~/.fiberhmm/genomes (it is never downloaded here).
 */
import { test, expect, panelButton } from './fixtures/server';
import type { Page, Request } from '@playwright/test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

test.use({ fixtureBam: 'demo' });

const DM6_BAM = process.env.FIBERBROWSER_TEST_DM6_BAM?.trim() || '';
const DM6_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'dm6.fa.fai'));
const HG38_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'hg38.fa.fai'));
// The audit's loci: NAPA (hg38 panel at its own locus) and a CG9500 amplicon (dm6).
const MAIN = { chrom: 'chr19', start: 47_514_037, end: 47_518_985 };
const HUMAN = { chrom: 'chr19', start: 47_514_262, end: 47_519_210 };
const FLY = { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 };

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

const panelOf = (page: Page, datasetId: string) =>
  store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset' && !p.collapsed)
    .map((p: any) => ({ id: p.id, datasetId: p.datasetId, genome: p.genome ?? null, v: p.viewportOverride ?? null })))
    .then(list => list.find(p => p.datasetId === datasetId)!);

const query = (request: Request) => new URL(request.url()).searchParams;

async function select(page: Page, which: 'human' | 'fly' | 'both') {
  await page.evaluate(w => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.setError(null);
    const peaks = st.getAllPeaks();
    const human = peaks.filter((p: any) => !p.genome && (p.chrom ?? 'chr19') === 'chr19' && p.start >= 47_514_262 && p.end <= 47_519_210).slice(0, 2);
    const fly = peaks.filter((p: any) => p.chrom === 'chr2L').slice(0, 2);
    const chosen = w === 'human' ? human : w === 'fly' ? fly : [...human, ...fly];
    // Accessibility at each peak (the DddB amplicons have no FIRE layer).
    st.replacePeakSelection(chosen.map((p: any) => p.index), 'accessibility');
    for (const p of chosen) st.setPeakMode(p.index, 'accessibility');
  }, which);
}

async function openChart(page: Page, tab: 'projection' | 'vplot' | 'enrichment') {
  const panel = page.locator('[data-panel-content-type="cluster-detail"]');
  if (!(await panel.count())) await panelButton(page, 'cluster-detail').click();
  await panel.locator(`[data-analysis-tab="${tab}"]`).first().click({ force: true });
  return panel;
}

test('clusters stay on one reference, and their charts plot the clustered panel in Per panel mode', async ({ page, server }) => {
  test.skip(!DM6_BAM || !existsSync(DM6_BAM), 'needs a dm6 BAM (FIBERBROWSER_TEST_DM6_BAM)');
  test.skip(!DM6_CACHED, 'needs dm6 in ~/.fiberhmm/genomes (not downloaded by tests)');
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  const status = await (await page.request.get(`${server.baseUrl}/api/status`)).json();
  if (status.current_genome !== 'hg38') {
    test.skip(!HG38_CACHED, 'needs hg38 in ~/.fiberhmm/genomes (not downloaded by tests)');
    expect((await (await page.request.post(`${server.baseUrl}/api/load_genome?genome_id=hg38`)).json()).success).toBe(true);
  }
  const fly = (await (await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: DM6_BAM } })).json()).dataset.id as string;
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('location-search-input').fill(`${MAIN.chrom}:${MAIN.start}-${MAIN.end}`);
  await page.getByTestId('location-search-submit').click();
  await expect.poll(() => store(page, s => [s.chrom, s.start])).toEqual([MAIN.chrom, MAIN.start]);
  const human = (await store(page, s => s.datasets.map((d: any) => d.id))).find((id: string) => id !== fly) as string;

  // Open the dm6 dataset with dm6 in its own panel: Per panel mode.
  await page.getByTestId('genome-mismatch-own-genome').click();
  await expect(page.getByTestId('genome-mismatch-banner')).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => store(page, s => s.navigationMode)).toBe('perPanel');
  const humanBar = page.getByTestId('panel-site-bar').filter({ hasNot: page.getByTestId('panel-genome-chip') });
  const flyBar = page.getByTestId('panel-site-bar').filter({ has: page.getByTestId('panel-genome-chip') });
  await humanBar.getByTestId('panel-location-input').fill(`${HUMAN.chrom}:${HUMAN.start}-${HUMAN.end}`);
  await humanBar.getByTestId('panel-location-submit').click();
  await expect.poll(async () => (await panelOf(page, human)).v).toEqual(HUMAN);
  await flyBar.getByTestId('panel-location-input').fill(`${FLY.chrom}:${FLY.start}-${FLY.end}`);
  await flyBar.getByTestId('panel-location-submit').click();
  await expect.poll(async () => (await panelOf(page, fly)).v).toEqual(FLY);
  // The main locus is stale: the hg38 panel is elsewhere.
  expect(await store(page, s => [s.chrom, s.start, s.end])).toEqual([MAIN.chrom, MAIN.start, MAIN.end]);

  // Peaks: the demo's (scanned on hg38) and two drawn in the dm6 panel (as the peak track records them), inside the amplicon reads.
  await expect.poll(() => store(page, s => s.getAllPeaks().filter((p: any) => !p.genome && p.start >= 47_514_262 && p.end <= 47_519_210).length),
    { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const st = (window as any).__FIBERBROWSER_STORE__.getState();
    st.addCustomPeak(6_356_930, 6_357_166, 'chr2L', 'dm6');
    st.addCustomPeak(6_357_191, 6_357_500, 'chr2L', 'dm6');
  });
  await expect.poll(() => store(page, s => s.getAllPeaks().filter((p: any) => p.chrom === 'chr2L').length)).toBe(2);
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setClusterMethod('graph'));

  // --- H1: peaks on hg38 and dm6 are not clustered together ------------------------------
  const clusterRequests: Request[] = [];
  page.on('request', r => { if (r.url().includes('/api/cluster_all')) clusterRequests.push(r); });
  await select(page, 'both');
  // Refused before running: Cluster is off and says why (round 4, Q7).
  await expect(page.getByTestId('cluster-run-button')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('cluster-run-button')).toHaveAttribute('title', /Peaks are selected on hg38 and dm6/);
  await page.waitForTimeout(1000);
  expect(clusterRequests).toHaveLength(0);
  expect(await store(page, s => Object.keys(s.clusterAssignments).length)).toBe(0);

  // hg38 peaks: only the hg38 panel is clustered; the dm6 panel is named as left out.
  await select(page, 'human');
  const humanRun = page.waitForResponse(r => r.url().includes('/api/cluster_all'), { timeout: 90_000 });
  await page.getByTestId('cluster-run-button').click();
  const run = await humanRun;
  const windows = JSON.parse(run.request().postData() || '{}').viewports ?? [];
  expect(windows.map((w: any) => w.dataset_id)).toEqual([human]);
  // The main genome's run names no panel reference.
  expect(query(run.request()).get('panel_genome')).toBeNull();
  await expect.poll(() => store(page, s => Object.values(s.clusterAssignments).reduce((n: number, a: any) => n + Object.keys(a || {}).length, 0)),
    { timeout: 60_000 }).toBeGreaterThan(0);
  const clusteredKeys = await store(page, s => Object.entries(s.clusterAssignments).filter(([, a]: any) => Object.keys(a || {}).length).map(([k]) => k));
  const humanKey = await store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset' && !p.genome).map((p: any) => p.stateKey ?? p.datasetId));
  const flyKey = await store(page, s => s.panels.filter((p: any) => p.genome).map((p: any) => p.stateKey ?? p.datasetId));
  expect(clusteredKeys.every(k => humanKey.includes(k))).toBe(true);
  expect(clusteredKeys.some(k => flyKey.includes(k))).toBe(false);
  await expect(page.getByTestId('run-result-cluster-text')).toContainText(/Not clustered: .*on dm6/);
  // L7: Neighbourhoods takes a resolution, not K.
  await expect.poll(() => store(page, s => s._historyStack.map((e: any) => e.label).filter((l: string) => l.startsWith('Cluster ')).pop()))
    .toMatch(/^Cluster Neighbourhoods resolution [\d.]+$/);

  // --- H2: the charts plot the clustered hg38 panel at its own locus ----------------------
  const projection = page.waitForRequest(r => r.url().includes('/api/cluster_projection'), { timeout: 60_000 });
  const panel = await openChart(page, 'projection');
  const p = query(await projection);
  expect([p.get('chrom'), p.get('start'), p.get('end')]).toEqual([HUMAN.chrom, String(HUMAN.start), String(HUMAN.end)]);
  expect(p.get('panel_genome')).toBeNull();
  await expect(panel.getByTestId('projection-summary')).toContainText('t-SNE', { timeout: 120_000 });
  await expect(panel).not.toContainText('run clustering first');
  await expect(panel).not.toContainText('left out');

  const vplot = page.waitForRequest(r => r.url().includes('/api/cluster/vplot'), { timeout: 60_000 });
  await openChart(page, 'vplot');
  const v = query(await vplot);
  expect([v.get('chrom'), v.get('region_start'), v.get('region_end')]).toEqual([HUMAN.chrom, String(HUMAN.start), String(HUMAN.end)]);
  await expect(page.getByTestId('cluster-detail-off-locus-note')).toHaveCount(0);

  const enrichmentReads = page.waitForRequest(r => r.url().includes('/api/reads/compact') && query(r).get('include_layers') === 'true', { timeout: 60_000 });
  await openChart(page, 'enrichment');
  const e = query(await enrichmentReads);
  expect([e.get('chrom'), e.get('start'), e.get('end'), e.get('dataset_id')]).toEqual([HUMAN.chrom, String(HUMAN.start), String(HUMAN.end), human]);

  // --- dm6: cluster the dm6 panel; with it selected the charts plot it on dm6 --------------
  await select(page, 'fly');
  const flyPanelId = (await panelOf(page, fly)).id;
  await page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().toggleDatasetSelection(id), flyPanelId);
  const flyRun = page.waitForResponse(r => r.url().includes('/api/cluster_all'), { timeout: 90_000 });
  await page.getByTestId('cluster-run-button').click();
  const flyResponse = await flyRun;
  expect((JSON.parse(flyResponse.request().postData() || '{}').viewports ?? []).map((w: any) => w.dataset_id)).toEqual([fly]);
  // fb-n4-integ (Codex integ 1): the run is on dm6 (its reads, chromosomes and the
  // genes of gene-conditioned rules), at the dm6 panel's locus, not hg38's stale main one.
  const flyQuery = query(flyResponse.request());
  expect([flyQuery.get('panel_genome'), flyQuery.get('chrom'), flyQuery.get('start'), flyQuery.get('end')])
    .toEqual(['dm6', FLY.chrom, String(FLY.start), String(FLY.end)]);
  expect(flyResponse.ok()).toBe(true);
  await expect.poll(() => store(page, s => Object.entries(s.clusterAssignments)
    .filter(([k, a]: any) => s.panels.some((p: any) => p.genome && (p.stateKey ?? p.datasetId) === k) && Object.keys(a || {}).length).length), { timeout: 60_000 }).toBe(1);
  const flyProjection = page.waitForRequest(r => r.url().includes('/api/cluster_projection') && query(r).get('chrom') === 'chr2L', { timeout: 60_000 });
  await openChart(page, 'projection');
  const fp = query(await flyProjection);
  expect([fp.get('start'), fp.get('end'), fp.get('panel_genome')]).toEqual([String(FLY.start), String(FLY.end), 'dm6']);
  await expect(panel.getByTestId('projection-summary')).toContainText('t-SNE', { timeout: 120_000 });

  // --- fb-n6-integ (Codex integ 3): the toolbar's Merge similar clusters sends what the map
  // previews: the dm6 panel on dm6 at its own locus (it was skipped, or sent on hg38).
  if (!(await page.getByTestId('cluster-auto-cull-button').isVisible())) await page.getByTestId('toolbar-group-toggle-cluster').click();
  await expect(page.getByTestId('cluster-auto-cull-button')).toBeEnabled();
  const merge = page.waitForRequest(r => r.url().includes('/api/auto_cull_clusters'), { timeout: 60_000 });
  await page.getByTestId('cluster-auto-cull-button').click();
  const mq = query(await merge);
  expect([mq.get('panel_genome'), mq.get('chrom'), mq.get('start'), mq.get('end')]).toEqual(['dm6', FLY.chrom, String(FLY.start), String(FLY.end)]);
  await expect(page.getByTestId('cluster-auto-cull-button')).toBeEnabled({ timeout: 60_000 });

  // --- fb-n6-integ (Codex integ 1): with both panels clustered and none selected, the map
  // plots one of them; clicking a cluster on it focuses that panel only.
  const keyOf = (genome: boolean) => store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset')
    .map((p: any) => ({ key: p.stateKey ?? p.datasetId, genome: !!p.genome }))).then(list => list.find(p => p.genome === genome)!.key as string);
  const [humanPanelKey, flyPanelKey] = [await keyOf(false), await keyOf(true)];
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().clearClusterFocus());
  await page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().toggleDatasetSelection(id), flyPanelId);
  await openChart(page, 'projection');
  // The map on show (the panel moved last: kept, or redrawn after a merge); its reference says whose it is.
  await page.waitForTimeout(2000);
  await expect(panel.getByTestId('projection-summary')).toContainText('t-SNE', { timeout: 120_000 });
  const mapped = (await store(page, s => s.readProjection?.genome ?? null)) === 'dm6' ? flyPanelKey : humanPanelKey;
  const other = mapped === flyPanelKey ? humanPanelKey : flyPanelKey;
  await panel.locator('[data-testid^="projection-legend-"]').first().click();
  const focusOf = (key: string) => page.evaluate(k => {
    const f = (window as any).__FIBERBROWSER_STORE__.getState().clusterFocus[k];
    return f ? [...f] : null;
  }, key);
  await expect.poll(() => focusOf(mapped)).not.toBeNull();
  expect(await focusOf(other)).toBeNull();

  expect(errors).toEqual([]);
});
