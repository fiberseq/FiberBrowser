/**
 * Feature hub G1 (native/feature_hub/DESIGN.md §4.3, §5.4, §13): hits of a scan of a live-lift dataset's own assembly
 * (HG002 MAT/PAT) in the hub, with the real liftbed, the HPRC graph package and the live-lift demo data:
 *
 * - a MAT hit outside the AluY insertion is lifted onto GRCh38 (exact), keeps its source coordinates and haplotype,
 *   and matches the same feature found by a GRCh38-frame scan of the native BAM (target-aliased match);
 * - a MAT hit inside the insertion is placed at the insertion's junction, and the GRCh38 dataset's column says
 *   "absent" (graph columns: the target lacks that sequence), never "not scanned";
 * - hover text names the lift and the graph statuses; "Matched only" keeps the matched pair;
 * - Use as anchors and Go to work on the lifted hit;
 * - in graph mode the selected insertion hit is drawn on its carriers' lanes, not on GRCh38's.
 *
 * The scans are written by tests/scan_fixtures.py (no FiberHMM needed). Needs FIBERBROWSER_TEST_LIFT_{BAM,MAP,NATIVE},
 * FIBERBROWSER_TEST_GRAPH_HELPER (with graphlift's liftbed next to it, or FIBERBROWSER_LIFTBED),
 * FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE and FIBERBROWSER_TEST_FASTA (chr3).
 */
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/nativeDialogs';
import { pickRandomPort, startServer, stopServer, type ServerProcess } from './fixtures/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const HELPER = process.env.FIBERBROWSER_TEST_GRAPH_HELPER?.trim() ?? '';
const HPRC = process.env.FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE?.trim() ?? '';
const LIFT_BAM = process.env.FIBERBROWSER_TEST_LIFT_BAM ?? '';
const LIFT_MAP = process.env.FIBERBROWSER_TEST_LIFT_MAP ?? '';
const NATIVE = process.env.FIBERBROWSER_TEST_LIFT_NATIVE ?? '';
const LIFTBED = process.env.FIBERBROWSER_LIFTBED?.trim() || (HELPER ? path.join(path.dirname(HELPER), 'liftbed') : '');
const READY = [HELPER, HPRC, LIFT_BAM, LIFT_MAP, NATIVE, LIFTBED].every(p => p && existsSync(p))
  && process.env.FIBERBROWSER_LIVE_LIFT !== '0' && Boolean(process.env.FIBERBROWSER_TEST_FASTA);
// HG002 MAT: a hit outside the AluY insertion (lifts to chr3:128,666,239-128,666,282) and one inside it (the insertion
// sits at GRCh38 chr3:128,657,390); a GRCh38 hit over the first one's lift.
const MAT = 'chr3_MATERNAL';
const EXACT = [131_205_881, 131_205_924] as const;
const INSIDE = [131_195_000, 131_195_100] as const;
const GRCH38 = [128_666_236, 128_666_284] as const;
const JUNCTION = 128_657_390;

function writeScans(dir: string): { source: string; target: string } {
  const script = `
import sys, pysam
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from scan_fixtures import write_scan_dir
lift_bam, native, out = sys.argv[3], sys.argv[4], sys.argv[5]
length = lambda bam, c: pysam.AlignmentFile(bam).get_reference_length(c)
mat = int(length(lift_bam, '${MAT}'))
hits = [(${EXACT[0]}, ${EXACT[1]}, 'fp:class:${MAT}:${(EXACT[0] + EXACT[1]) >> 1}:aaaaaaaa', 'lifted-exact'),
        (${INSIDE[0]}, ${INSIDE[1]}, 'fp:class:${MAT}:${(INSIDE[0] + INSIDE[1]) >> 1}:bbbbbbbb', 'in-insertion')]
vals = [(h, s, e, 'dataset_1::pooled', 'channel', 'prevalence', 0.6, 20) for s, e, h, _l in hits]
write_scan_dir(__import__('pathlib').Path(out) / 'source', lift_bam, contig='${MAT}', length=mat, hits=hits, values=vals, scan_id='1111111111111111')
c3 = int(length(native, 'chr3'))
t = [(${GRCH38[0]}, ${GRCH38[1]}, 'fp:class:chr3:${(GRCH38[0] + GRCH38[1]) >> 1}:cccccccc', 'grch38-hit')]
write_scan_dir(__import__('pathlib').Path(out) / 'target', native, contig='chr3', length=c3, hits=t,
               values=[(t[0][2], t[0][0], t[0][1], 'dataset_1::pooled', 'channel', 'prevalence', 0.4, 20)], scan_id='2222222222222222')
`;
  execFileSync(PYTHON, ['-c', script, path.resolve(HERE, '../../../../tests'), path.resolve(HERE, '../../../../browser'), LIFT_BAM, NATIVE, dir],
    { stdio: 'pipe' });
  return { source: path.join(dir, 'source'), target: path.join(dir, 'target') };
}

async function graphServer(): Promise<ServerProcess> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-hub-lifted-'));
  const env = { FIBERBROWSER_GRAPH_HELPER: HELPER, FIBERBROWSER_GRAPH_PACKAGES: HPRC, FIBERBROWSER_GRAPH_REGISTRY: path.join(scratch, 'reg.json'),
    FIBERBROWSER_LIFTBED: LIFTBED };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await startServer(null, await pickRandomPort()); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(src => (new Function('s', `return (${src})(s)`))((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

test('feature hub: lifted source-frame hits, insertion hits absent on GRCh38, cross-frame match, Use as, graph outlines', async ({ page }) => {
  test.skip(!READY, 'needs the live-lift demo data, the graph helper with liftbed, the HPRC package and FIBERBROWSER_TEST_FASTA');
  test.setTimeout(600_000);
  const scans = writeScans(mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-hub-lifted-')));
  const server = await graphServer();
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1700, height: 1100 });
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('fiberhmm_welcome_dismissed', '1');
    });
    const lifted = await (await page.request.post(`${server.baseUrl}/api/lift/datasets`,
      { data: { paths: [LIFT_BAM], manifest: LIFT_MAP, label: 'Sample (lifted)' } })).json();
    expect(lifted.success, JSON.stringify(lifted)).toBe(true);
    const native = await (await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: NATIVE, label: 'Sample (GRCh38)' } })).json();
    expect(native.success).toBe(true);
    await page.goto(`${server.baseUrl}/?chr=chr3&start=128653000&end=128668000`);
    await page.waitForFunction(() => (window as any).__FIBERBROWSER_STORE__?.getState().datasets.length >= 2, null, { timeout: 120_000 });
    await store(page, s => s.openAnalysisPanel('feature-hub'));
    await expect(page.getByTestId('hub-panel')).toBeVisible();
    for (const dir of [scans.source, scans.target]) {
      await page.getByTestId('hub-scan-path').fill(dir);
      await page.getByTestId('hub-scan-path').press('Enter');
    }
    await expect(page.getByTestId('hub-scan-row')).toHaveCount(2, { timeout: 60_000 });

    // The lifted hit: where it lifted, its haplotype, its chip, and the GRCh38 scan's hit matched to it.
    const exact = page.locator('[data-testid=hub-row][data-lift="exact"]');
    await expect(exact).toHaveCount(1, { timeout: 60_000 });
    await expect(exact).toHaveAttribute('data-hap', 'MAT');
    await expect(exact.getByTestId('hub-row-locus')).toContainText('chr3:128,666,');
    await expect(exact.getByTestId('hub-lift-chip')).toHaveText('lifted');
    await expect(exact.getByTestId('hub-match-chip')).toHaveText('≡ 1');
    expect(await exact.getAttribute('title')).toMatch(/^Lifted from MAT chr3_MATERNAL:131,205,882-131,205,924 to chr3:128,666,240-128,666,282: one placement/);

    // The hit inside the insertion: at the junction, and absent in the GRCh38 dataset's column (graph columns).
    const inside = page.locator('[data-testid=hub-row][data-lift="unmapped"]');
    await expect(inside).toHaveCount(1);
    await expect(inside.getByTestId('hub-lift-chip')).toHaveText('in insertion');
    // A boundary is named by the base after it (1-based), as every zero-width hub row is.
    await expect(inside.getByTestId('hub-row-locus')).toContainText(`chr3:${(JUNCTION + 1).toLocaleString('en-US')} ⋮`);
    await expect(inside.getByTestId('hub-cell-absent')).toHaveCount(1, { timeout: 60_000 });
    const insideTitle = await inside.getAttribute('title');
    expect(insideTitle).toContain('inside an insertion this genome lacks');
    expect(insideTitle).toMatch(/GRCh38[^;]*: absent \(lacks this sequence\)/);
    expect(insideTitle).toMatch(/MAT: carries it/);

    // Matched only: the lifted hit and the GRCh38 one.
    await page.getByTestId('hub-shared-only').check();
    await expect(page.getByTestId('hub-row')).toHaveCount(2);
    await page.getByTestId('hub-shared-only').uncheck();

    // Use as anchors: anchored where it lifted, its source kept. Go to the insertion hit: the view holds its junction.
    await exact.click();
    await inside.click({ modifiers: ['Shift'] });
    await page.getByTestId('hub-use-anchors').click();
    const anchors = await store(page, s => s.featureHub.anchors.at(-1).anchors);
    expect(anchors[0]).toMatchObject({ chrom: 'chr3', lift: 'exact', source: { chrom: MAT, start: EXACT[0], end: EXACT[1] } });
    expect(anchors[1]).toMatchObject({ chrom: 'chr3', pos: JUNCTION, insertion: true, lift: 'unmapped' });
    await inside.getByTestId('hub-row-expand').click();
    await expect(page.getByTestId('hub-row-lift')).toContainText('inside an insertion');
    await expect(page.getByTestId('hub-row-graph')).toContainText('absent');
    await page.getByTestId('hub-row-goto').click();
    const view = await store(page, s => [s.chrom, s.start, s.end]);
    expect(view[0]).toBe('chr3');
    expect(view[1]).toBeLessThanOrEqual(JUNCTION);
    expect(view[2]).toBeGreaterThanOrEqual(JUNCTION);

    // Graph mode: the selected insertion hit is drawn on the lanes that carry it (MAT and PAT), not GRCh38's.
    await inside.getByTestId('hub-row-expand').click();
    await inside.click();
    const panels = () => store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset').map((p: any) => ({ id: p.id, mode: p.viewMode ?? 'linear' })));
    if (!(await panels()).some(p => p.mode === 'graph')) await page.getByTestId('graph-mode-toggle').first().click({ timeout: 60_000 });
    await expect.poll(async () => (await panels()).some(p => p.mode === 'graph'), { timeout: 120_000 }).toBe(true);
    const host = (await panels()).find(p => p.mode === 'graph')!.id;
    const drawn = () => page.evaluate(id => {
      const e = (window as any).__FIBERBROWSER_GRAPH_SCENES__?.[id as string];
      if (!e) return null;
      const lane = new Map(e.scene.rows.map((r: any) => [r.top, r.key]));
      return (e.hubOutlines ?? []).filter((o: any) => o.selected && lane.has(o.y0)).map((o: any) => lane.get(o.y0));
    }, host);
    await expect.poll(async () => ((await drawn()) ?? []).length, { timeout: 120_000 }).toBeGreaterThan(0);
    const lanes = (await drawn())!;
    expect(lanes.some(k => /mat/i.test(String(k)))).toBe(true);
    expect(lanes.some(k => /grch38/i.test(String(k)))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server);
  }
});
