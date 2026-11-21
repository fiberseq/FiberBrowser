/**
 * Two BAMs on two assemblies on the command line (fb-n1-bugs 3):
 * `browser.py --dataset napa_ddda.bam (hg38) --dataset amplicons.bam (dm6) --fasta hg38.fa`.
 *
 * It opened on the store's built-in locus (chr2L:1,000,000) under hg38's
 * chromosome list, with no reads in either panel, and after "Open with dm6 in
 * its own panel" the hg38 panel stayed on chr2L. Now the main view opens on
 * the hg38 dataset's reads, the banner offers dm6 for the fly dataset's own
 * panel (as for a dataset opened in the app), the panels sit side by side as
 * in-app datasets do, and after the own-panel genome each panel shows its
 * dataset's reads.
 *
 * Needs a dm6 DddB amplicon BAM (FIBERBROWSER_TEST_DM6_BAM)
 * and hg38 and dm6 in ~/.fiberhmm/genomes (never downloaded here).
 */
import { test, expect } from './fixtures/nativeDialogs';
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEMO_FIXTURE, pickRandomPort, startServer, type ServerProcess } from './fixtures/server';

const DM6_BAM = process.env.FIBERBROWSER_TEST_DM6_BAM?.trim() || '';
const GENOMES = path.join(homedir(), '.fiberhmm', 'genomes');
const HG38_FASTA = process.env.FIBERBROWSER_TEST_FASTA?.trim() || path.join(GENOMES, 'hg38.fa');

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

const renderedReads = (page: Page, datasetId: string) =>
  page.locator(`[data-read-track-dataset-id="${datasetId}"]`).first().getAttribute('data-read-track-render-count')
    .then(v => Number(v ?? 0));

let proc: ServerProcess | null = null;
test.afterEach(async () => {
  proc?.kill('SIGTERM');
  proc = null;
});

test('hg38 and dm6 BAMs at start-up open on the hg38 reads; dm6 gets its own panel genome', async ({ page }) => {
  test.skip(!DM6_BAM || !existsSync(DM6_BAM), 'needs a dm6 BAM (FIBERBROWSER_TEST_DM6_BAM)');
  test.skip(!existsSync(`${HG38_FASTA}.fai`), 'needs an indexed hg38 FASTA (~/.fiberhmm/genomes or FIBERBROWSER_TEST_FASTA)');
  test.skip(!existsSync(path.join(GENOMES, 'dm6.fa.fai')), 'needs dm6 in ~/.fiberhmm/genomes (not downloaded by tests)');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  const port = await pickRandomPort();
  proc = await startServer(null, port, {
    extraArgs: ['--dataset', DEMO_FIXTURE.bamPath, '--dataset', DM6_BAM, '--fasta', HG38_FASTA],
  });
  const baseUrl = proc.baseUrl;
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');

  const ids = await store(page, s => s.datasets.map((d: any) => d.id)) as string[];
  expect(ids).toHaveLength(2);
  const [human, fly] = ids;

  // --- The main view: on the hg38 dataset's reads, consistent with hg38's chromosomes ---
  await expect.poll(() => store(page, s => s.chrom), { timeout: 30_000 }).toBe(DEMO_FIXTURE.region.chrom);
  const view = await store(page, s => ({ chrom: s.chrom, start: s.start, end: s.end, genome: s.currentGenome,
    chroms: s.chroms.map((c: any) => c.name) }));
  expect(view.genome).toBe('hg38');
  expect(view.chroms).toContain(view.chrom);
  expect(view.chroms).not.toContain('chr2L');
  expect(view.start).toBeGreaterThanOrEqual(DEMO_FIXTURE.region.start - 5_000);
  expect(view.end).toBeLessThanOrEqual(DEMO_FIXTURE.region.end + 5_000);
  await expect(page.getByTestId('location-search-input')).toHaveValue(new RegExp(`^${view.chrom}:`));
  await expect.poll(() => renderedReads(page, human), { timeout: 45_000 }).toBeGreaterThan(0);

  // --- Side by side and linked, as datasets opened in the app ---------------------------
  const panels = await store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset')
    .map((p: any) => ({ ds: p.datasetId, row: p.layoutRow ?? 0, col: p.layoutColumn ?? null, link: p.linkGroup, collapsed: !!p.collapsed })));
  expect(panels.map(p => p.ds)).toEqual([human, fly]);
  expect(panels.every(p => p.row === 0 && p.col === null && !p.collapsed)).toBe(true);
  expect(panels[0].link).not.toBeNull();
  expect(panels[1].link).toBe(panels[0].link);

  // --- The mismatch banner offers dm6 for the fly dataset's own panel -------------------
  const banner = page.getByTestId('genome-mismatch-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('dm6');
  const own = page.getByTestId('genome-mismatch-own-genome');
  await expect(own).toHaveText(/Open with dm6 in its own panel/);
  await own.click();
  await expect(banner).toHaveCount(0, { timeout: 60_000 });

  // --- Each panel on its own dataset's reads --------------------------------------------
  await expect.poll(() => store(page, s => s.panels.find((p: any) => p.datasetId === s.datasets[1].id)?.genome ?? null), { timeout: 30_000 })
    .toBe('dm6');
  const after = await store(page, s => Object.fromEntries(s.panels.filter((p: any) => p.contentType === 'dataset')
    .map((p: any) => [p.datasetId, p.viewportOverride ?? null])));
  expect(after[fly]?.chrom).toMatch(/^chr(2L|2R|3L|3R|4|X)$/);
  // The hg38 panel stays where the main view was (it gets its own locus box with Per panel).
  const humanView = after[human] ?? { chrom: view.chrom };
  expect(humanView.chrom).toBe(view.chrom);
  expect(await store(page, s => [s.currentGenome, s.chrom])).toEqual(['hg38', view.chrom]);
  await expect.poll(() => renderedReads(page, fly), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(() => renderedReads(page, human), { timeout: 30_000 }).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
