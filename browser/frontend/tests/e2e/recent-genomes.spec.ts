/**
 * Recent and pinned genomes (owner requests, 3.1.0): "a 'recent genomes' thing in the menu, it's annoying to navigate
 * to custom ones", "automatch to a recent if the current loaded one is imperfectly fit", "be able to pin them".
 *
 * - A custom local FASTA and its GTF, loaded once, are listed after a restart and load again in one click, with the
 *   GTF; pinned, they stay pinned across a restart and through Clear recent.
 * - A dm6 BAM under a reference that doesn't fit, with a local dm6 among the pinned/recent genomes: the mismatch
 *   banner offers it ("Switch to dm6 (matches your data)", pinned preferred over the registry dm6) and one click
 *   switches. Nothing that
 *   fits: nothing offered.
 * - Offer only (owner decision, 20 Nov): nothing switches on its own, even with an old saved auto-switch setting;
 *   the banner offers the matching genome.
 *
 * Local files only (the dm6 FASTA via FIBERBROWSER_TEST_DM6_FASTA, by symlink), a scratch HOME and settings files,
 * and every download sent to a dead proxy.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/nativeDialogs';
import { startServer, pickRandomPort, type ServerProcess } from './fixtures/server';
import { PYTHON } from './fixtures/syntheticData';

const DM6_FASTA = process.env.FIBERBROWSER_TEST_DM6_FASTA?.trim() || path.join(homedir(), '.fiberhmm', 'genomes', 'dm6.fa');

const MAKE_DATA = String.raw`
import os, sys, random
import pysam
out, dm6 = sys.argv[1], os.path.abspath(sys.argv[2])
os.makedirs(os.path.join(out, "home", ".fiberhmm", "genomes"), exist_ok=True)
rng = random.Random(3)
def fasta(path, contigs):
    with open(path, "w") as fh:
        for name, n in contigs:
            fh.write(">%s\n" % name)
            s = "".join(rng.choice("ACGT") for _ in range(n))
            for i in range(0, n, 60):
                fh.write(s[i:i + 60] + "\n")
    pysam.faidx(path)
fasta(os.path.join(out, "mygenome.fa"), [("ctgA", 20000), ("ctgB", 8000)])
fasta(os.path.join(out, "weird.fa"), [("w1", 5000), ("w2", 4000)])
with open(os.path.join(out, "mygenome.gtf"), "w") as fh:
    for k in range(5):
        a = 'gene_id "M%d"; gene_name "MYGENE_%d"; transcript_id "MT%d";' % (k, k, k)
        for f in ("gene", "transcript", "exon"):
            fh.write("ctgA\tsynthetic\t%s\t%d\t%d\t.\t+\t.\t%s\n" % (f, 1000 + k * 3000, 2500 + k * 3000, a))
for name in ("dm6_local.fa",):
    os.symlink(dm6, os.path.join(out, name))
    os.symlink(dm6 + ".fai", os.path.join(out, name + ".fai"))
with pysam.FastaFile(dm6) as fa:
    contigs = [(n, fa.get_reference_length(n)) for n in fa.references]
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": n, "LN": l} for n, l in contigs]}
    tmp = os.path.join(out, "fly.unsorted.bam")
    with pysam.AlignmentFile(tmp, "wb", header=header) as bam:
        names = [n for n, _ in contigs]
        for i in range(40):
            pos = 1000000 + i * 100
            seq = fa.fetch("chr2L", pos, pos + 1500).upper()
            r = pysam.AlignedSegment()
            r.query_name, r.query_sequence, r.flag = "r%03d" % i, seq, 0
            r.reference_id, r.reference_start, r.mapping_quality = names.index("chr2L"), pos, 60
            r.cigar = [(0, len(seq))]
            r.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
            bam.write(r)
    pysam.sort("-o", os.path.join(out, "fly.bam"), tmp)
    os.remove(tmp)
    pysam.index(os.path.join(out, "fly.bam"))
`;

function makeData(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-recent-'));
  const run = spawnSync(PYTHON, ['-c', MAKE_DATA, dir, DM6_FASTA], { encoding: 'utf-8' });
  if (run.status !== 0) throw new Error(`synthetic data failed:\n${run.stderr}`);
  return dir;
}

const OFFLINE = {
  HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

let procs: ServerProcess[] = [];
async function exited(proc: ServerProcess, ms = 20_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await Promise.race([
    new Promise<void>(resolve => proc.once('exit', () => resolve())),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('server did not stop')), ms)),
  ]);
}
test.afterEach(async () => {
  for (const p of procs) {
    if (p.exitCode === null && p.signalCode === null) {
      p.kill('SIGTERM');
      await exited(p).catch(() => p.kill('SIGKILL'));
    }
  }
  procs = [];
});

/** A server on the scratch HOME, with the recent genomes and preferences files kept across restarts. */
async function serve(dir: string, port: number, args: string[]): Promise<ServerProcess> {
  const home = path.join(dir, 'home');
  const proc = await startServer(null, port, {
    runtimeFile: path.join(home, '.fiberhmm', 'browser_runtime.json'), extraArgs: args, noTestFasta: true,
    env: { HOME: home, FIBERBROWSER_RECENT_GENOMES: path.join(dir, 'recent_genomes.json'),
      FIBERBROWSER_PREFERENCES: path.join(dir, 'preferences.json'), ...OFFLINE },
  });
  procs.push(proc);
  return proc;
}
async function restart(proc: ServerProcess, dir: string, port: number, args: string[]): Promise<ServerProcess> {
  proc.kill('SIGTERM');
  await exited(proc);
  return serve(dir, port, args);
}
const api = async (base: string, route: string, init?: RequestInit) => (await fetch(`${base}${route}`, init)).json();
const post = (base: string, route: string, body?: unknown) => api(base, route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function openRecentPage(page: Page) {
  if (!(await page.getByTestId('settings-sidebar').isVisible().catch(() => false))) await page.getByTestId('settings-rail-genome').click();
  await expect(page.getByTestId('settings-sidebar-title')).toHaveText('Reference & Tracks');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-subsection', { detail: { subsectionId: 'genome.recent' } })));
  await expect(page.getByTestId('recent-genomes')).toBeVisible();
}
const row = (page: Page, group: 'pinned' | 'recent', file: string) =>
  page.locator(`[data-testid="recent-genome-${group}"]`).filter({ hasText: file });

test.describe('recent and pinned genomes', () => {
  test.skip(!existsSync(DM6_FASTA) || !existsSync(`${DM6_FASTA}.fai`), 'needs an indexed local dm6 FASTA (FIBERBROWSER_TEST_DM6_FASTA)');
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    });
    await page.setViewportSize({ width: 1500, height: 950 });
  });

  test('a custom FASTA + GTF loaded once is listed after a restart and loads again in one click with its GTF; pins survive', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const dir = makeData();
    const port = await pickRandomPort();
    let srv = await serve(dir, port, []);
    // What Load FASTA… / Load GTF… do once their file is chosen (the native dialog is not driven here).
    expect((await post(srv.baseUrl, `/api/load_fasta?path=${encodeURIComponent(path.join(dir, 'mygenome.fa'))}`)).success).toBe(true);
    expect((await post(srv.baseUrl, `/api/load_gtf?path=${encodeURIComponent(path.join(dir, 'mygenome.gtf'))}`)).success).toBe(true);
    expect((await post(srv.baseUrl, `/api/load_fasta?path=${encodeURIComponent(path.join(dir, 'weird.fa'))}`)).success).toBe(true);

    srv = await restart(srv, dir, port, []);
    await page.goto(srv.baseUrl);
    await page.waitForLoadState('networkidle');
    await openRecentPage(page);
    const mine = row(page, 'recent', 'mygenome.fa');
    await expect(mine).toContainText('mygenome.fa + mygenome.gtf');
    await expect(page.locator('[data-testid="recent-genome-recent"]').first()).toContainText('weird.fa');   // most recent first
    await mine.getByTestId('recent-genome-open').click();
    await expect.poll(async () => (await api(srv.baseUrl, '/api/status')).gene_count, { timeout: 30_000 }).toBe(5);
    const st = await api(srv.baseUrl, '/api/status');
    expect(st.fasta_path.endsWith('mygenome.fa')).toBe(true);
    await expect.poll(() => store(page, s => [s.hasFasta, (s.fastaPath ?? '').endsWith('mygenome.fa')])).toEqual([true, true]);
    await expect(page.locator('[data-testid="recent-genome-recent"]').first()).toContainText('mygenome.fa');   // now the most recent

    // Pin it: it moves to Pinned, survives a restart and Clear recent.
    await row(page, 'recent', 'mygenome.fa').getByTestId('recent-genome-pin').click();
    await expect(row(page, 'pinned', 'mygenome.fa')).toHaveCount(1);
    srv = await restart(srv, dir, port, []);
    await page.goto(srv.baseUrl);
    await page.waitForLoadState('networkidle');
    await openRecentPage(page);
    await expect(row(page, 'pinned', 'mygenome.fa')).toHaveCount(1);
    await page.getByTestId('recent-genomes-clear').click();
    await expect(page.locator('[data-testid="recent-genome-recent"]')).toHaveCount(0);
    await expect(row(page, 'pinned', 'mygenome.fa')).toHaveCount(1);
    // Unpinned: back to Recent.
    await row(page, 'pinned', 'mygenome.fa').getByTestId('recent-genome-pin').click();
    await expect(row(page, 'recent', 'mygenome.fa')).toHaveCount(1);
    await expect(page.locator('[data-testid="recent-genome-pinned"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a dm6 BAM under a reference that does not fit: the banner offers the pinned local dm6 and one click switches', async ({ page }) => {
    const dir = makeData();
    const port = await pickRandomPort();
    // The registry dm6 is in the scratch cache (the same local file, as a download would leave it).
    const cache = path.join(dir, 'home', '.fiberhmm', 'genomes');
    spawnSync('ln', ['-s', DM6_FASTA, path.join(cache, 'dm6.fa')]);
    spawnSync('ln', ['-s', `${DM6_FASTA}.fai`, path.join(cache, 'dm6.fa.fai')]);
    spawnSync('sh', ['-c', `printf %s https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/dm6/dm6.fa > "${path.join(cache, 'dm6.fa.source')}"`]);
    let srv = await serve(dir, port, []);
    // A local dm6 (by its real path: the symlink counts as its target), then another genome, then the registry dm6.
    expect((await post(srv.baseUrl, `/api/load_fasta?path=${encodeURIComponent(path.join(dir, 'dm6_local.fa'))}`)).success).toBe(true);
    expect((await post(srv.baseUrl, `/api/load_fasta?path=${encodeURIComponent(path.join(dir, 'weird.fa'))}`)).success).toBe(true);
    expect((await post(srv.baseUrl, '/api/load_genome?genome_id=dm6')).fasta_loaded).toBe(true);
    let listed = await api(srv.baseUrl, '/api/recent_genomes');
    expect(listed.recent.map((e: any) => e.key)[0]).toBe('registry:dm6');          // the most recent, and it fits too
    const local = listed.recent.find((e: any) => e.kind === 'fasta' && e.fasta_name === 'dm6.fa');
    expect(local.assembly).toBe('dm6');
    listed = await post(srv.baseUrl, '/api/recent_genomes/pin', { key: local.key, pinned: true });
    expect(listed.pinned.map((e: any) => e.key)).toEqual([local.key]);

    srv = await restart(srv, dir, port, ['--dataset', path.join(dir, 'fly.bam'), '--fasta', path.join(dir, 'weird.fa')]);
    await page.goto(srv.baseUrl);
    await page.waitForLoadState('networkidle');
    const banner = page.getByTestId('genome-mismatch-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    const offer = page.getByTestId('genome-mismatch-recent-match');
    await expect(offer).toContainText('Switch to dm6 (matches your data)');
    await expect(offer).toContainText('all 1,870 contigs match');
    await expect(offer).toHaveAttribute('title', /^Pinned genome dm6 \(dm6\.fa\)/);   // pinned preferred over the registry dm6
    // --fasta was given: offered only, never switched on its own.
    expect((await api(srv.baseUrl, '/api/status')).fasta_path).toMatch(/weird\.fa$/);
    await offer.click();
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
    expect((await api(srv.baseUrl, '/api/status')).fasta_path).toBe(local.fasta);
    await expect.poll(() => store(page, s => s.chroms.some((c: any) => c.name === 'chr2L'))).toBe(true);
  });

  test('nothing in Recent fits: nothing is offered', async ({ page }) => {
    const dir = makeData();
    const port = await pickRandomPort();
    let srv = await serve(dir, port, []);
    expect((await post(srv.baseUrl, `/api/load_fasta?path=${encodeURIComponent(path.join(dir, 'mygenome.fa'))}`)).success).toBe(true);
    srv = await restart(srv, dir, port, ['--dataset', path.join(dir, 'fly.bam'), '--fasta', path.join(dir, 'weird.fa')]);
    await page.goto(srv.baseUrl);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('genome-mismatch-banner')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('genome-mismatch-recent-match')).toHaveCount(0);
    expect((await api(srv.baseUrl, '/api/genome/check')).recent_match).toBeNull();
  });

  for (const on of [false, true]) {
    test(`offer only: nothing switches on its own${on ? ' (an old saved auto-switch setting is ignored)' : ''}`, async ({ page }) => {
      const dir = makeData();
      const port = await pickRandomPort();
      let srv = await serve(dir, port, []);
      expect((await post(srv.baseUrl, `/api/load_fasta?path=${encodeURIComponent(path.join(dir, 'dm6_local.fa'))}`)).success).toBe(true);
      if (on) {
        await api(srv.baseUrl, '/api/preferences/analysis', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recent_genomes_autoswitch: true }) });
      }
      // No --fasta: the page restores the reference this browser remembers (a FASTA of no known assembly).
      srv = await restart(srv, dir, port, ['--dataset', path.join(dir, 'fly.bam')]);
      const weird = path.join(dir, 'weird.fa');
      await page.addInitScript(p => {
        (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = false;
        try { localStorage.setItem('fiberhmm_last_fasta_path', p); localStorage.removeItem('fiberhmm_last_genome'); } catch { /* fresh */ }
      }, weird);
      await page.goto(srv.baseUrl);
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('genome-mismatch-recent-match')).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(2_000);
      expect((await api(srv.baseUrl, '/api/status')).fasta_path).toMatch(/weird\.fa$/);
      await expect(page.getByTestId('reference-notice-text')).toHaveCount(0);
    });
  }
});
