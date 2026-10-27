/**
 * Graph mode beyond HG002 (DESIGN_GRAPH_PRIMARY §8, G8), end to end with the real helper: a neutral strain package
 * (dm6#0#chr2L target + strainA#0#chr2L) and a single-haplotype lifted BAM (strainA -> dm6, made by gbz2chain):
 *
 * - the live-lift dialog lists the map's own haplotype (strainA#0), not MAT/PAT;
 * - the new lifted dataset opens as a one-panel graph (nothing to split or fold), its reads drawn;
 * - the panel's chip and the graph's lanes carry the package's and map's names, never MAT/PAT.
 *
 * Needs FIBERBROWSER_TEST_GRAPH_HELPER, FIBERBROWSER_TEST_GRAPH_GENERALITY_PACKAGES (a folder named strain),
 * FIBERBROWSER_TEST_GRAPH_LIFT_GENERALITY (strain/strain.chain.graphlift.json, strain/strain.src.bam and
 * strain/dm6_chr2L.fa: the target's sequence, served as the main reference) and FIBERBROWSER_LIVE_LIFT=1.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/nativeDialogs';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickRandomPort, startServer, stopServer, type ServerProcess } from './fixtures/server';

const HELPER = process.env.FIBERBROWSER_TEST_GRAPH_HELPER?.trim() ?? '';
const STRAIN = (process.env.FIBERBROWSER_TEST_GRAPH_GENERALITY_PACKAGES ?? '').split(path.delimiter)
  .map(p => p.trim()).find(p => p && path.basename(path.normalize(p)) === 'strain') ?? '';
const LIFTS = process.env.FIBERBROWSER_TEST_GRAPH_LIFT_GENERALITY?.trim() ?? '';
const MAP = LIFTS && path.join(LIFTS, 'strain', 'strain.chain.graphlift.json');
const BAM = LIFTS && path.join(LIFTS, 'strain', 'strain.src.bam');
const FASTA = LIFTS && path.join(LIFTS, 'strain', 'dm6_chr2L.fa');
const READY = [HELPER, STRAIN, MAP, BAM, FASTA].every(p => p && existsSync(p)) && process.env.FIBERBROWSER_LIVE_LIFT !== '0';
const MAT_PAT = /\b(MAT|PAT|MATERNAL|PATERNAL)\b/i;

async function strainServer(): Promise<ServerProcess> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-graph-generality-'));
  const env = { FIBERBROWSER_GRAPH_HELPER: HELPER, FIBERBROWSER_GRAPH_PACKAGES: STRAIN, FIBERBROWSER_TEST_FASTA: FASTA,
    FIBERBROWSER_GRAPH_REGISTRY: path.join(scratch, 'reg.json') };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await startServer(null, await pickRandomPort()); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const panels = (page: Page) => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels
  .filter((p: any) => p.contentType === 'dataset')
  .map((p: any) => ({ id: p.id, ds: p.datasetId, liftHap: p.liftHap ?? null, viewMode: p.viewMode, collapsed: p.collapsed,
    member: p.graphMemberOf ?? null, role: p.graphView?.role ?? null })));

test('a single-haplotype strain lift opens as a one-panel graph with the map\'s own label', async ({ page }) => {
  test.skip(!READY, 'needs the graph helper, the strain package, its lift fixtures (live lift is on unless FIBERBROWSER_LIVE_LIFT=0)');
  test.setTimeout(300_000);
  const server = await strainServer();
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    });
    await page.goto(`${server.baseUrl}/?chr=chr2L&start=17500&end=20500`);
    await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__?.getState().chroms.length ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);

    await page.getByTestId('open-menu-button').click();
    await page.getByTestId('open-menu-add-live-lift').click();
    await page.getByTestId('live-lift-bams').fill(BAM);
    await page.getByTestId('live-lift-manifest').fill(MAP);
    const haps = page.getByTestId('live-lift-haplotypes');
    await expect(haps).toContainText('strainA#0', { timeout: 60_000 });
    expect(await haps.innerText()).not.toMatch(MAT_PAT);
    await expect(page.getByTestId('live-lift-open-graph')).toBeChecked();
    await page.getByTestId('live-lift-add').click();

    // One panel, opened as the graph host: no haplotype to split by, no member folded into it.
    await expect.poll(async () => (await panels(page)).filter(p => p.viewMode === 'graph').length, { timeout: 120_000 }).toBe(1);
    const all = await panels(page);
    expect(all).toHaveLength(1);
    const [host] = all;
    expect(host).toMatchObject({ liftHap: null, member: null, collapsed: false });
    const graph = page.locator(`[data-testid="graph-host-body"][data-panel-id="${host.id}"] [data-testid="graph-panel"]`);
    await expect.poll(async () => Number(await graph.getAttribute('data-graph-reads') || 0), { timeout: 120_000 }).toBeGreaterThan(5);

    // Labels: the map's haplotype on the chip; the package's paths on the lanes; MAT/PAT nowhere.
    const chip = page.locator(`[data-panel-id="${host.id}"] [data-testid="live-lift-chip"]`).first();
    await expect(chip).toContainText('strainA#0');
    expect(await chip.innerText()).not.toMatch(MAT_PAT);
    const lanes = await graph.getByTestId('graph-lane-label').allTextContents();
    expect(lanes.some(l => l.includes('strainA'))).toBe(true);
    expect(lanes.join(' ')).not.toMatch(MAT_PAT);
    // The drawn rows are this dataset's, on the strainA lane, with the map's haplotype label.
    const rows = await page.evaluate(pid => {
      const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string];
      return e?.reads ? Object.values(e.reads.lanes).flatMap((l: any) => (l.groups ?? []).map((g: any) => ({ member: g.member, rows: g.rows }))) : [];
    }, host.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((g: any) => g.member === host.id && g.rows > 0)).toBe(true);
    // Every drawn molecule on the strainA path (never the dm6 target, whose contig is also chr2L), with the map's
    // haplotype label and lifted identities (agy review, group D).
    const drawn = await page.evaluate(pid => {
      const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[pid as string];
      const strain = e?.model?.rows?.find((r: any) => String(r.label).includes('strainA'))?.key;
      return { strain, lanes: Object.keys(e?.reads?.lanes ?? {}), molecules: (e?.reads?.molecules ?? []).map((m: any) => ({
        lane: m.lane, hap: m.read.hap, aid: m.read.aid ?? '', rk: m.read.rk ?? '' })) };
    }, host.id);
    expect(drawn.strain).toBeTruthy();
    expect(drawn.lanes).toEqual([drawn.strain]);
    expect(drawn.molecules.length).toBeGreaterThan(5);
    expect(drawn.molecules.every((m: any) => m.lane === drawn.strain && m.hap === 'strainA#0'
      && m.aid.startsWith('lift-cohort:v1 ') && m.rk.startsWith('lift-record:v1 '))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
  }
});
