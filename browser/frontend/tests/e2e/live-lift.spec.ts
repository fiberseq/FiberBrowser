/**
 * Live lift (DESIGN_LIVE_LIFT.md P2a): SAMPLE_A's HG002-aligned reads at the chr3 AluY locus drawn on GRCh38 through
 * the HPRC graphlift map, next to the same molecules' native GRCh38 alignments. Opened from the Open menu's "Add live
 * lift…" (server started with FIBERBROWSER_LIVE_LIFT=1), it splits into a MAT and a PAT panel by default; each
 * panel's reads are its haplotype's lifted rows (lift_hap), drawn from their segments, with badges at the AluY.
 *
 * Needs the pg-lift work data (skipped without it): FIBERBROWSER_TEST_LIFT_BAM, FIBERBROWSER_TEST_LIFT_MAP and
 * FIBERBROWSER_TEST_LIFT_NATIVE, or their default paths on the development Mac.
 */
import { test, expect } from './fixtures/server';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HANDOFF = path.join(os.homedir(), 'pglift_work/demo_data');
const LIFT_BAM = process.env.FIBERBROWSER_TEST_LIFT_BAM ?? path.join(HANDOFF, 'SAMPLE_A.alu_chr3.hg002v1.1.bam');
const NATIVE_BAM = process.env.FIBERBROWSER_TEST_LIFT_NATIVE ?? path.join(HANDOFF, 'SAMPLE_A.alu_chr3.GRCh38.bam');
const LIFT_MAP = process.env.FIBERBROWSER_TEST_LIFT_MAP
  ?? path.join(os.homedir(), 'pglift_work/pglift_20261017/native/graphlift/scratch/v4/hprc.GRCh38.HG002.chain.graphlift.json');
const HAVE_DATA = [LIFT_BAM, NATIVE_BAM, LIFT_MAP].every(p => existsSync(p));
const VIEW = { chrom: 'chr3', start: 128_650_000, end: 128_670_000 };

test.skip(!HAVE_DATA, 'pg-lift work data not present');
test.skip(process.env.FIBERBROWSER_LIVE_LIFT !== '1', 'run with FIBERBROWSER_LIVE_LIFT=1 (the feature flag)');
test.use({ fixtureBam: NATIVE_BAM });

test('add a live-lift dataset next to the native BAM: split MAT/PAT panels render lifted rows', async ({ page, server }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  const lifted: Record<string, any[]> = {};
  page.on('response', async r => {
    const url = new URL(r.url());
    if (!url.pathname.endsWith('/api/reads/compact') || !url.searchParams.get('lift_hap') || !r.ok()) return;
    try { (lifted[url.searchParams.get('lift_hap')!] ??= []).push(await r.json()); } catch { /* superseded */ }
  });
  await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);

  // The flag is on: the Open menu offers "Add live lift…".
  await page.getByTestId('open-menu-button').click();
  await page.getByTestId('open-menu-add-live-lift').click();
  const dialog = page.getByTestId('live-lift-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('live-lift-bams').fill(LIFT_BAM);
  await page.getByTestId('live-lift-manifest').fill(LIFT_MAP);
  await expect(page.getByTestId('live-lift-haplotypes')).toContainText('MAT');
  await expect(page.getByTestId('live-lift-haplotypes')).toContainText('PAT');
  await page.getByTestId('live-lift-add').click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });

  // Split by default: one panel per haplotype, each with its chip, next to the native panel.
  await expect(page.getByTestId('live-lift-chip')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('live-lift-chip').filter({ hasText: 'MAT' })).toHaveCount(1);
  await expect(page.getByTestId('live-lift-chip').filter({ hasText: 'PAT' })).toHaveCount(1);
  const panels = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels
    .filter((p: any) => p.contentType === 'dataset').map((p: any) => ({ id: p.id, stateKey: p.stateKey ?? p.datasetId, dataset: p.datasetId, hap: p.liftHap ?? null })));
  expect(panels.filter((p: any) => p.hap === null)).toHaveLength(1);   // the native GRCh38 panel
  expect(panels.filter((p: any) => p.hap).map((p: any) => p.hap).sort()).toEqual(['MAT', 'PAT']);

  // Each panel's reads are its haplotype's lifted rows, drawn on GRCh38 (badges at the AluY source insertion).
  await expect.poll(() => (lifted.MAT?.length ?? 0) > 0 && (lifted.PAT?.length ?? 0) > 0, { timeout: 60_000 }).toBe(true);
  const last = (hap: string) => lifted[hap][lifted[hap].length - 1];
  for (const hap of ['MAT', 'PAT']) {
    const reads = last(hap).reads as any[];
    expect(reads.length).toBeGreaterThan(5);
    expect(reads.every(r => r.live_lift?.hap_label === hap)).toBe(true);
    expect(reads.every(r => r.live_lift.segments.length > 0)).toBe(true);
  }
  expect([...last('MAT').reads, ...last('PAT').reads].some((r: any) => (r.live_lift.badges ?? [])
    .some((b: any) => b[1] === 'source_insertion' && b[2] > 2000))).toBe(true);
  await expect.poll(() => page.locator('[data-read-track-loading="true"]').count(), { timeout: 60_000 }).toBe(0);
  // Read canvases for the native and both lifted panels.
  await expect.poll(() => page.locator('canvas[data-copilot-track="reads"]').count()).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: test.info().outputPath('live-lift-split.png') });

  // The canvas publishes the geometry it actually drew, so this clicks the
  // +2.4 kb badge of a visible MAT row, independent of sorting or row density.
  const mat = panels.find((p: any) => p.hap === 'MAT')!;
  await page.evaluate(() => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    store.setState({ fillReadHeight: false, readRowHeight: 16 });
  });
  const matCanvas = page.locator(`[data-read-track-state-key="${mat.stateKey}"] canvas[data-copilot-track="reads"]`);
  await expect.poll(() => matCanvas.getAttribute('data-live-lift-badge-target')).toBeTruthy();
  const target = JSON.parse((await matCanvas.getAttribute('data-live-lift-badge-target'))!);
  expect(target.bp).toBeGreaterThan(2000);
  expect(target.ins_id).toMatch(/^MAT:.*:insertion$/);
  const scale = await matCanvas.evaluate((c: HTMLCanvasElement) => ({ x: c.getBoundingClientRect().width / c.clientWidth, y: c.getBoundingClientRect().height / c.clientHeight }));
  await matCanvas.click({ position: { x: target.x * scale.x, y: target.y * scale.y } });
  await expect(page.getByTestId('live-lift-expanded-block')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId('live-lift-diff-popover')).toHaveCount(0);
  for (const block of await page.getByTestId('live-lift-expanded-block').all()) {
    await expect(block).toContainText('HG002 MAT +2,353 bp');
  }
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().liveLiftExpansions.main?.length)).toBe(1);
  await expect.poll(async () => Number(await matCanvas.getAttribute('data-live-lift-insertion-calls'))).toBeGreaterThan(0);
  await expect.poll(async () => JSON.parse((await matCanvas.getAttribute('data-live-lift-insertion-calls-by-id')) ?? '{}')[target.ins_id] ?? 0).toBeGreaterThan(0);
  const nativePanel = panels.find((p: any) => p.hap === null)!;
  const nativeCanvas = page.locator(`[data-read-track-state-key="${nativePanel.stateKey}"] canvas[data-copilot-track="reads"]`);
  await expect(nativeCanvas).toHaveAttribute('data-live-lift-insertion-calls', '0');
  // The badge opens the insertion directly; the × control closes the shared
  // columns in all three panels. Inspection is a separate strip/secondary action.
  await page.getByTestId('live-lift-expanded-collapse').first().click();
  await expect(page.getByTestId('live-lift-expanded-block')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().liveLiftExpansions.main?.length)).toBe(0);

  const strip = page.locator(`[data-testid="live-lift-diff-strip"][data-panel-id="${mat.id}"]`);
  // Resolve this known MAT-only SNV at base detail so adjacent 1 bp glyphs do
  // not mask its mouse target at the original 20 kb scale.
  await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().setViewport('chr3', 128_657_405, 128_657_445));
  const snv = strip.locator('[data-testid="live-lift-diff-item"][data-difference-id="MAT:chr3_MATERNAL:131197059-131197060:snv"]');
  await expect(snv).toBeVisible();
  await snv.click();
  const inspection = page.getByTestId('live-lift-diff-popover');
  await expect(inspection).toBeVisible();
  await expect(inspection.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
  await expect(inspection).toContainText('Allele');
  await expect(inspection).toContainText('HG002');
  await expect(inspection).toContainText('GRCh38');
  await expect(inspection.locator('tbody tr[data-hap="MAT"][data-allele="hg002"]').first()).toBeVisible();
  await expect(inspection.locator('tbody tr').first()).toHaveAttribute('data-hap', 'MAT');
  await expect(inspection.getByTestId('live-lift-other-hap-summary')).toContainText(/PAT: no difference here, \d+ reads agree with GRCh38/);
  await expect(inspection.locator('tbody tr[data-hap="PAT"][data-allele="grch38"]')).toHaveCount(0);
  await expect(inspection.locator('tbody')).not.toContainText('/ ?');
  await page.keyboard.press('Escape');

  const beforeNext = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start);
  await strip.getByTestId('live-lift-diff-next').click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start), { timeout: 30_000 }).not.toBe(beforeNext);
  const beforePrev = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start);
  await strip.getByTestId('live-lift-diff-prev').click();
  await expect.poll(() => page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().start), { timeout: 30_000 }).not.toBe(beforePrev);

  // Pooled is one click away.
  const datasetId = panels.find((p: any) => p.hap)!.dataset;
  await page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().poolLiftHapPanels(id), datasetId);
  await expect(page.getByTestId('live-lift-chip')).toHaveCount(1);
  await expect(page.getByTestId('live-lift-chip')).toContainText('MAT+PAT');
  expect(errors).toEqual([]);
});
