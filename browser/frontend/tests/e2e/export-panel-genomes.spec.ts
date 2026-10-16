/**
 * Export data with an hg38 panel and a dm6 panel on its own genome (fb-n3-export),
 * in "Each panel navigates" with the hg38 panel moved off the (now stale) main
 * locus. Every Data entry that downloads is run and its file read:
 *
 * - audit M1: Current region and the file names use the panels' loci;
 * - audit M3: the working set has the dm6 reads (it had only the hg38 ones);
 * - audit M5: peaks are one BED per reference;
 * - audit M6: the read table has ref_start / ref_end and a plain strand;
 * - Codex audit #11: the dm6 panel's read statistics and BAM subset ask dm6;
 * - audit M20: the dialog takes focus and keeps Tab inside.
 *
 * Needs a dm6 DddB amplicon BAM (FIBERBROWSER_TEST_DM6_BAM)
 * and hg38 + dm6 in ~/.fiberhmm/genomes (never downloaded here).
 */
import { test, expect } from './fixtures/server';
import type { Download, Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

test.use({ fixtureBam: 'demo' });

const DM6_BAM = process.env.FIBERBROWSER_TEST_DM6_BAM?.trim() || '';
const DM6_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'dm6.fa.fai'));
const HG38_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'hg38.fa.fai'));
const MAIN = { chrom: 'chr19', start: 47_515_000, end: 47_516_000 };
const HUMAN_AT = { chrom: 'chr19', start: 47_515_200, end: 47_515_900 };

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

const datasetPanel = (page: Page, datasetId: string) =>
  store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset')
    .map((p: any) => ({ id: p.id, datasetId: p.datasetId, stateKey: p.stateKey ?? p.datasetId, genome: p.genome ?? null, v: p.viewportOverride ?? null })))
    .then(list => list.find(p => p.datasetId === datasetId)!);

/** Click an entry and collect its `n` downloads (one per reference, per dataset…). */
async function run(page: Page, id: string, n: number, info: any): Promise<Array<{ name: string; file: string }>> {
  const downloads: Download[] = [];
  const done = new Promise<void>(resolve => {
    const on = (d: Download) => { downloads.push(d); if (downloads.length === n) { page.off('download', on); resolve(); } };
    page.on('download', on);
  });
  await page.getByTestId(`export-entry-${id}-button`).click();
  await done;
  const out: Array<{ name: string; file: string }> = [];
  for (const d of downloads) {
    const file = info.outputPath(`${id}-${d.suggestedFilename()}`);
    await d.saveAs(file);
    out.push({ name: d.suggestedFilename(), file });
  }
  // No more than n.
  await page.waitForTimeout(400);
  expect(downloads).toHaveLength(n);
  return out;
}
const tsv = (file: string) => readFileSync(file, 'utf8').trim().split('\n').filter(l => !l.startsWith('#')).map(l => l.split('\t'));

test('Export data with hg38 and dm6 panels: every download entry, its file and its name', async ({ page, server }, info) => {
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
  await expect.poll(() => store(page, s => s.start)).toBe(MAIN.start);
  const human = (await store(page, s => s.datasets.map((d: any) => d.id))).find((id: string) => id !== fly) as string;

  // dm6 in its own panel: "Each panel navigates" turns on.
  await page.getByTestId('genome-mismatch-own-genome').click();
  await expect(page.getByTestId('genome-mismatch-banner')).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => store(page, s => s.navigationMode)).toBe('perPanel');
  const flyPanel = await datasetPanel(page, fly);
  expect(flyPanel.genome).toBe('dm6');
  const FLY_AT = flyPanel.v as { chrom: string; start: number; end: number };
  expect(FLY_AT.chrom).toMatch(/^chr(2L|2R|3L|3R|X|4)$/);

  // The hg38 panel moves; the main locus stays where it was (stale).
  const humanBar = page.getByTestId('panel-site-bar').filter({ hasNot: page.getByTestId('panel-genome-chip') });
  await humanBar.getByTestId('panel-location-input').fill(`${HUMAN_AT.chrom}:${HUMAN_AT.start}-${HUMAN_AT.end}`);
  await humanBar.getByTestId('panel-location-submit').click();
  await expect.poll(async () => (await datasetPanel(page, human)).v).toEqual(HUMAN_AT);
  expect(await store(page, s => [s.chrom, s.start])).toEqual([MAIN.chrom, MAIN.start]);
  const humanKey = (await datasetPanel(page, human)).stateKey;
  const flyKey = flyPanel.stateKey;
  await expect.poll(async () => {
    const ids = await store(page, s => s.activeReadIds);
    return Math.min((ids[humanKey] ?? []).length, (ids[flyKey] ?? []).length);
  }, { timeout: 60_000 }).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle');
  const shown = await store(page, s => s.activeReadIds);
  const humanStem = `chr19_${HUMAN_AT.start}-${HUMAN_AT.end}`;
  const flyStem = `${FLY_AT.chrom}_${FLY_AT.start}-${FLY_AT.end}`;

  // --- The dialog takes focus and keeps Tab inside (M20) -----------------------------
  await page.keyboard.press('ControlOrMeta+Shift+E');
  const dialog = page.getByTestId('export-data-dialog');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="export-data-dialog"]'))).toBe(true);
  for (let i = 0; i < 60; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="export-data-dialog"]'))).toBe(true);
  await dialog.getByTestId('export-read-scope').selectOption('shown');

  // --- Read names: both panels' reads; the file named after their loci ----------------
  const [names] = await run(page, 'read-names', 1, info);
  expect(names.name).toBe(`read_names_shown_${humanStem}_plus1.txt`);
  const nameSet = new Set(readFileSync(names.file, 'utf8').trim().split('\n'));
  expect(shown[flyKey].every((id: string) => nameSet.has(id))).toBe(true);
  expect(shown[humanKey].every((id: string) => nameSet.has(id))).toBe(true);

  // --- Read table: reference, alignment bounds, a plain strand (M6, #11) -------------
  const statsRequests: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/reads/stats')) statsRequests.push(r.url()); });
  const [table] = await run(page, 'read-table', 1, info);
  expect(table.name).toMatch(new RegExp(`^reads_shown_${humanStem}_plus1_\\d{8}_\\d{6}\\.tsv$`));
  expect(statsRequests.some(u => u.includes('panel_genome=dm6') && u.includes(`chrom=${FLY_AT.chrom}`))).toBe(true);
  const [head, ...rows] = tsv(table.file);
  const c = (n: string) => head.indexOf(n);
  const flyRows = rows.filter(r => r[c('dataset_id')] === fly);
  const humanRows = rows.filter(r => r[c('dataset_id')] === human);
  expect(flyRows.length).toBe(shown[flyKey].length);
  expect(humanRows.length).toBe(shown[humanKey].length);
  for (const r of flyRows) expect([r[c('reference')], r[c('chrom')]]).toEqual(['dm6', FLY_AT.chrom]);
  for (const r of humanRows) expect([r[c('reference')], r[c('chrom')]]).toEqual(['hg38', 'chr19']);
  for (const r of rows) {
    expect(Number(r[c('ref_end')])).toBeGreaterThan(Number(r[c('ref_start')]));
    expect(['+', '-']).toContain(r[c('strand')]);
  }

  // --- BAM subset: one per dataset; the dm6 one on dm6 -------------------------------
  const bams = await run(page, 'read-bam', 2, info);
  const flyBam = new RegExp(`_${FLY_AT.chrom}_${FLY_AT.start}-${FLY_AT.end}_\\d+reads\\.bam$`);
  const humanBam = new RegExp(`_chr19_${HUMAN_AT.start}-${HUMAN_AT.end}_\\d+reads\\.bam$`);
  expect(bams.filter(b => flyBam.test(b.name))).toHaveLength(1);
  expect(bams.filter(b => humanBam.test(b.name))).toHaveLength(1);
  for (const b of bams) {
    const header = zlib.gunzipSync(readFileSync(b.file)).subarray(0, 4).toString('latin1');
    expect(header).toBe('BAM\u0001');
  }

  // --- Working set: the dm6 reads are there (M3) ------------------------------------
  const [ws] = await run(page, 'working-set', 1, info);
  expect(ws.name).toMatch(new RegExp(`^working_set_${humanStem}_plus1_\\d{8}_\\d{6}\\.tsv$`));
  const [wsHead, ...wsRows] = tsv(ws.file);
  expect(wsHead.slice(-2)).toEqual(['reference', 'chrom']);
  const wsFly = new Set(wsRows.filter(r => r[1] === fly).map(r => `${r.at(-2)}|${r.at(-1)}`));
  const wsHuman = new Set(wsRows.filter(r => r[1] === human).map(r => `${r.at(-2)}|${r.at(-1)}`));
  expect([...wsFly]).toEqual([`dm6|${FLY_AT.chrom}`]);
  expect([...wsHuman]).toEqual(['hg38|chr19']);
  expect(new Set(wsRows.filter(r => r[1] === fly).map(r => r[2])).size).toBeGreaterThan(0);

  // --- Current region: one BED per reference, the panels' loci (M1) ------------------
  await expect(dialog.getByTestId('export-entry-viewport-bed-detail'))
    .toHaveText(`hg38 chr19:${HUMAN_AT.start.toLocaleString('en-US')}-${HUMAN_AT.end.toLocaleString('en-US')}, dm6 ${FLY_AT.chrom}:${FLY_AT.start.toLocaleString('en-US')}-${FLY_AT.end.toLocaleString('en-US')}`);
  const regions = await run(page, 'viewport-bed', 2, info);
  expect(regions.map(r => [r.name, readFileSync(r.file, 'utf8')])).toEqual([
    [`region_hg38_${humanStem}.bed`, `chr19\t${HUMAN_AT.start}\t${HUMAN_AT.end}\tviewport\t0\t.\n`],
    [`region_dm6_${flyStem}.bed`, `${FLY_AT.chrom}\t${FLY_AT.start}\t${FLY_AT.end}\tviewport\t0\t.\n`],
  ]);

  // --- Peaks: one BED per reference (M5) --------------------------------------------
  const peakGenomes = await store(page, s => [...new Set(s.getAllPeaks().map((p: any) => p.genome ?? 'hg38'))]);
  if (peakGenomes.length > 0) {
    const peaks = await run(page, 'peaks-bed', peakGenomes.length, info);
    for (const p of peaks) {
      const ref = readFileSync(p.file, 'utf8').match(/^# reference=(.+)$/m)?.[1];
      expect(peakGenomes).toContain(ref);
      const chroms = new Set(tsv(p.file).map(r => r[0]));
      expect([...chroms]).toEqual([ref === 'dm6' ? FLY_AT.chrom : 'chr19']);
      if (peakGenomes.length > 1) expect(p.name.startsWith(`peaks_${ref}_`)).toBe(true);
    }
  }

  // --- The session file ----------------------------------------------------------------
  const [session] = await run(page, 'session-json', 1, info);
  expect(JSON.parse(readFileSync(session.file, 'utf8')).panel_genomes.datasets[fly]).toBe('dm6');

  expect(errors).toEqual([]);
});
