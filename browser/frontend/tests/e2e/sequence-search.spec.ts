/**
 * Find sequence in genome, end to end on the demo BAM with a synthetic reference (tests/make_seqsearch_fasta.py:
 * every contig of the demo BAM's header at its own length, N except chr19, a 25-bp sequence planted on each strand
 * inside the demo locus). Pasting the sequence in the locus box offers "Find this sequence in the genome"; Enter
 * opens the Find sequence panel and runs the exact search; both planted copies are listed; clicking one moves the
 * view there with the match highlighted; the hits become a track and export as BED.
 *
 * Needs no hg38 and no BLAST (a 25-bp query uses the exact scan). FB_SEQSEARCH_SHOTS=<dir> saves screenshots.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { DEMO_FIXTURE, expect, panelButton, pickRandomPort, startServer, stopServer, type ServerProcess } from './fixtures/server';
// Not the server fixture's `test` (its page would start a second, default server): this spec runs its own.
import { test } from './fixtures/nativeDialogs';
import { PYTHON } from './fixtures/syntheticData';

const REPO_ROOT = path.resolve(path.dirname(DEMO_FIXTURE.bamPath), '..', '..', '..');
const SHOTS = process.env.FB_SEQSEARCH_SHOTS?.trim();

interface Planted { fasta: string; plant: string; hits: Array<{ chrom: string; start: number; end: number; strand: string }> }

let planted: Planted;
let server: ServerProcess | null = null;

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-seqsearch-'));
  const out = path.join(dir, 'demo_ref.fa.gz');
  const run = spawnSync(PYTHON, [path.join(REPO_ROOT, 'tests', 'make_seqsearch_fasta.py'), out], { encoding: 'utf-8' });
  if (run.status !== 0) throw new Error(`make_seqsearch_fasta.py failed:\n${run.stderr}`);
  planted = JSON.parse(run.stdout.trim().split('\n').pop()!);
  expect(existsSync(`${out}.fai`)).toBe(true);
  // The demo BAM on the synthetic reference (its --fasta comes last, so it wins over FIBERBROWSER_TEST_FASTA).
  server = await startServer(DEMO_FIXTURE.bamPath, await pickRandomPort(), { extraArgs: ['--fasta', planted.fasta] });
});

test.afterAll(async () => {
  if (server) await stopServer(server);
});

async function open(page: Page) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    if (!window.sessionStorage.getItem('fb-e2e-kept')) {
      window.localStorage.clear();
      window.sessionStorage.setItem('fb-e2e-kept', '1');
    }
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(server!.baseUrl);
  await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
  await page.waitForLoadState('networkidle');
}

test('paste a sequence in the locus box, find it, click a hit, see it highlighted', async ({ page }) => {
  test.setTimeout(150_000);
  await open(page);
  const status = await (await page.request.get(`${server!.baseUrl}/api/sequence_search/status`)).json();
  expect(status).toMatchObject({ searchable: true, genome_loaded: true });

  // The Tools launcher is there too.
  await expect(panelButton(page, 'sequence-search')).toHaveCount(1);

  // Pasted DNA in the locus box offers the search; Enter runs it.
  const box = page.getByTestId('location-search-input');
  await box.click();
  await box.fill(planted.plant.toLowerCase());
  await expect(page.getByText('Find this sequence in the genome')).toBeVisible();
  await shot(page, '01-locus-box-offer.png');
  await box.press('Enter');

  const panel = page.getByTestId('sequence-search');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('seqsearch-input')).toHaveValue(planted.plant.toLowerCase());
  await expect(page.getByTestId('seqsearch-summary')).toHaveText('2 hits (exact search, both strands)', { timeout: 90_000 });
  // No transient line under the locus box covering the toolbar: the panel shows the search.
  await expect(page.getByTestId('location-search-info')).toHaveCount(0);
  const rows = page.getByTestId('seqsearch-hit');
  await expect(rows).toHaveCount(2);
  const loci = await rows.evaluateAll(els => els.map(e => e.getAttribute('data-locus')));
  expect(loci).toEqual(planted.hits.map(h => `${h.chrom}:${h.start}-${h.end}`));
  await expect(rows.nth(1)).toContainText('chr19:47,516,801-47,516,825');
  await expect(rows.nth(1)).toContainText(planted.plant);  // the minus-strand copy reads as the query
  await shot(page, '02-results.png');

  // Click the minus-strand hit: the view moves there, the match is highlighted.
  await rows.nth(1).click();
  const minus = planted.hits[1];
  await expect.poll(async () => {
    const [chrom, start, end] = await store(page, s => [s.chrom, s.start, s.end]);
    return [chrom, start <= minus.start && end >= minus.end && end - start < 2_000];
  }).toEqual(['chr19', true]);
  const highlights = await store(page, s => s.highlights.map((h: any) => ({ id: h.id, chrom: h.chrom, start: h.start, end: h.end })));
  expect(highlights).toEqual([{ id: 'seqsearch-hit', chrom: 'chr19', start: minus.start, end: minus.end }]);
  await expect(page.locator('[data-highlight-id="seqsearch-hit"]').first()).toBeVisible();
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await shot(page, '03-hit-highlighted.png');

  // The other hit moves the same highlight.
  await rows.nth(0).click();
  await expect.poll(() => store(page, s => s.highlights.map((h: any) => h.start))).toEqual([planted.hits[0].start]);

  // All hits as a temporary track.
  await page.getByTestId('seqsearch-add-track').click();
  await expect(page.getByTestId('seqsearch-notice')).toContainText('Added 2 hits as the track');
  const tracks = await (await page.request.get(`${server!.baseUrl}/api/tracks`)).json();
  expect(JSON.stringify(tracks)).toContain('seqsearch://');
  await shot(page, '04-hits-track.png');

  // Export BED (a browser download: no dialog in headless Chromium).
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('seqsearch-export-bed').click()]);
  const bed = readFileSync((await download.path())!, 'utf-8').trim().split('\n');
  expect(bed[1].split('\t')).toEqual(['chr19', String(planted.hits[0].start), String(planted.hits[0].end), 'hit1', '1000', '+']);
  expect(bed[2].split('\t').slice(0, 3)).toEqual(['chr19', String(minus.start), String(minus.end)]);
});

test('a bad query is refused in the panel, and the Tools launcher opens it', async ({ page }) => {
  await open(page);
  await panelButton(page, 'sequence-search').click();
  await expect(page.getByTestId('sequence-search')).toBeVisible();
  await page.getByTestId('seqsearch-input').fill('ACGTACGTACGTXX');
  await expect(page.getByTestId('seqsearch-parse-error')).toContainText('Not DNA');
  await expect(page.getByTestId('seqsearch-find')).toBeDisabled();
  // The server refuses it too (no file paths, just the sequence).
  const res = await (await page.request.post(`${server!.baseUrl}/api/sequence_search`, { data: { sequence: 'hello world' } })).json();
  expect(res).toMatchObject({ success: false, code: 'bad_query' });
});
