/**
 * A remembered reference never beats the server's (owner report, 3.1.0 RC, 20 Nov).
 *
 * What the owner hit: a server started with `--fasta dm6.fa` on a fresh ~/.fiberhmm had no dm6 genes (nothing cached
 * to pair with the FASTA), and loading dm6 from the genome list (or "Switch to dm6") answered "already loaded" and
 * did nothing, so the genes came only after loading another genome first (yeast, then dm6). Now one click loads
 * dm6's annotation and keeps the user's FASTA, "Load / Reset to dm6 genes" sits beside the annotation, a foreign
 * annotation is flagged with its reset, and a reference remembered in this browser (localStorage, an autosave from
 * an earlier session on this origin) never replaces the server's --fasta or a reference of the data's genome.
 *
 * All data is synthetic or local: a scratch HOME whose genome cache holds a small synthetic sacCer3 (as a registry
 * download would leave it) and the local dm6 FASTA (FIBERBROWSER_TEST_DM6_FASTA, default ~/.fiberhmm/genomes/dm6.fa),
 * and every download is sent to a dead proxy.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/nativeDialogs';
import { startServer, pickRandomPort, type ServerProcess } from './fixtures/server';
import { PYTHON } from './fixtures/syntheticData';

const DM6_FASTA = process.env.FIBERBROWSER_TEST_DM6_FASTA?.trim() || path.join(homedir(), '.fiberhmm', 'genomes', 'dm6.fa');

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

const MAKE_DATA = String.raw`
import os, random, shutil, sys
import pysam
out, dm6_fasta = sys.argv[1], os.path.abspath(sys.argv[2])
genomes = os.path.join(out, "home", ".fiberhmm", "genomes")
os.makedirs(genomes, exist_ok=True)
rng = random.Random(7)
YEAST = [("chrI", 230218), ("chrII", 81320), ("chrIII", 31620), ("chrIV", 41531), ("chrV", 57687), ("chrVI", 27016),
         ("chrVII", 40938), ("chrVIII", 52643), ("chrIX", 43888), ("chrX", 74575), ("chrXI", 66688), ("chrXII", 78177),
         ("chrXIII", 92431), ("chrXIV", 78433), ("chrXV", 91291), ("chrXVI", 94806), ("chrM", 85779)]
yfa = os.path.join(genomes, "sacCer3.fa")
yseq = {}
with open(yfa, "w") as fh:
    for name, n in YEAST:
        s = "".join(rng.choice("ACGT") for _ in range(n))
        yseq[name] = s
        fh.write(">%s\n" % name)
        for i in range(0, n, 60):
            fh.write(s[i:i + 60] + "\n")
pysam.faidx(yfa)
open(yfa + ".source", "w").write("https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/bigZips/sacCer3.fa.gz")
def gtf(path, genes):
    with open(path, "w") as fh:
        for i, (chrom, start, end, name) in enumerate(genes):
            attrs = 'gene_id "G%04d"; gene_name "%s"; gene_biotype "protein_coding";' % (i, name)
            t = attrs + ' transcript_id "T%04d"; transcript_name "%s-RA";' % (i, name)
            fh.write("%s\tsynthetic\tgene\t%d\t%d\t.\t+\t.\t%s\n" % (chrom, start, end, attrs))
            fh.write("%s\tsynthetic\ttranscript\t%d\t%d\t.\t+\t.\t%s\n" % (chrom, start, end, t))
            fh.write("%s\tsynthetic\texon\t%d\t%d\t.\t+\t.\t%s\n" % (chrom, start, end, t))
gtf(os.path.join(genomes, "sacCer3.gtf"), [(c, 1000 + k * 4000, 2500 + k * 4000, "YEAST_%s_%d" % (c, k)) for c, _ in YEAST[:6] for k in range(5)])
dfa = os.path.join(genomes, "dm6.fa")
if not os.path.lexists(dfa):
    os.symlink(dm6_fasta, dfa)
open(dfa + ".source", "w").write("https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/dm6/dm6.fa")
if os.path.exists(dm6_fasta + ".fai"):
    shutil.copyfile(dm6_fasta + ".fai", dfa + ".fai")
gtf(os.path.join(genomes, "dm6.gtf"), [("chr2L", 1000000 + k * 3000, 1001500 + k * 3000, "FLY_gene%d" % k) for k in range(8)])
def write_bam(path, contigs, chrom, start, fetch):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": n, "LN": l} for n, l in contigs]}
    tmp = path + ".unsorted.bam"
    names = [n for n, _ in contigs]
    with pysam.AlignmentFile(tmp, "wb", header=header) as bam:
        for i in range(60):
            pos = start + i * 100
            seq = fetch(pos, pos + 2000).upper()
            a = pysam.AlignedSegment()
            a.query_name = "read%03d" % i
            a.query_sequence = seq
            a.flag = 0
            a.reference_id = names.index(chrom)
            a.reference_start = pos
            a.mapping_quality = 60
            a.cigar = [(0, len(seq))]
            a.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
            bam.write(a)
    pysam.sort("-o", path, tmp)
    os.remove(tmp)
    pysam.index(path)
write_bam(os.path.join(out, "yeast.bam"), YEAST, "chrI", 10000, lambda a, b: yseq["chrI"][a:b])
with pysam.FastaFile(dm6_fasta) as fa:
    write_bam(os.path.join(out, "fly.bam"), [(n, fa.get_reference_length(n)) for n in fa.references], "chr2L", 1000000,
              lambda a, b: fa.fetch("chr2L", a, b))
`;

/** A scratch folder with its HOME's genome cache (sacCer3, dm6) and the two BAMs. */
function makeData(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-genome-restore-'));
  const run = spawnSync(PYTHON, ['-c', MAKE_DATA, dir, DM6_FASTA], { encoding: 'utf-8' });
  if (run.status !== 0) throw new Error(`synthetic data failed:\n${run.stderr}`);
  return dir;
}

/** Downloads go nowhere (a closed port); the local server is reached directly. */
const OFFLINE = {
  HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};

let procs: ServerProcess[] = [];
test.afterEach(async () => {
  for (const p of procs) {
    if (p.exitCode === null && p.signalCode === null) {
      p.kill('SIGTERM');
      await exited(p).catch(() => p.kill('SIGKILL'));
    }
  }
  procs = [];
});

async function exited(proc: ServerProcess, ms = 20_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await Promise.race([
    new Promise<void>(resolve => proc.once('exit', () => resolve())),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('server did not stop')), ms)),
  ]);
}

const genomes = (home: string) => path.join(home, '.fiberhmm', 'genomes');

/** A server on `home` (its genome cache and runtime folder); FIBERBROWSER_TEST_FASTA is never added. */
async function serve(home: string, port: number, args: string[]): Promise<ServerProcess> {
  const proc = await startServer(null, port, {
    runtimeFile: path.join(home, '.fiberhmm', 'browser_runtime.json'), extraArgs: args, env: { HOME: home, ...OFFLINE }, noTestFasta: true,
  });
  procs.push(proc);
  return proc;
}

async function status(baseUrl: string): Promise<any> {
  return (await fetch(`${baseUrl}/api/status`)).json();
}

/** The genes the server has in a window of chr2L / chrI (names only). */
async function geneNames(baseUrl: string, chrom: string, start: number, end: number): Promise<string[]> {
  const res = await (await fetch(`${baseUrl}/api/genes?chrom=${chrom}&start=${start}&end=${end}`)).json();
  return (res.genes ?? res.transcripts ?? []).map((g: any) => g.gene_name ?? g.name ?? '');
}

async function openGenomePage(page: Page) {
  const sidebar = page.getByTestId('settings-sidebar');
  if (!(await sidebar.isVisible().catch(() => false))) await page.getByTestId('settings-rail-genome').click();
  await expect(page.getByTestId('settings-sidebar-title')).toHaveText('Reference & Tracks');
  await page.evaluate(() => {
    for (const id of ['genome.reference', 'genome.online']) {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-subsection', { detail: { subsectionId: id } }));
    }
  });
}

/** An earlier session on this origin: a yeast BAM with sacCer3 (the start-up genome for yeast contigs), saved. */
async function earlierYeastSession(page: Page, dir: string, port: number, withWork: boolean): Promise<ServerProcess> {
  const home = path.join(dir, 'home');
  const a = await serve(home, port, ['--dataset', path.join(dir, 'yeast.bam')]);
  await page.goto(a.baseUrl);
  await page.waitForLoadState('networkidle');
  await expect.poll(() => store(page, s => s.currentGenome), { timeout: 30_000 }).toBe('sacCer3');
  if (withWork) {
    // Some analysis worth recovering (two reads in two clusters; the synthetic reads carry no calls, so they are
    // hidden as uncalled and the assignment is set directly).
    await page.evaluate(() => {
      const st = (window as any).__FIBERBROWSER_STORE__;
      const ds = st.getState().datasets[0].id;
      st.setState({ clusterAssignments: { [ds]: { read000: 0, read001: 1 } } });
    });
  }
  await expect.poll(() => page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('fiberhmm_history', 1);
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      try {
        const get = req.result.transaction('autosave', 'readonly').objectStore('autosave').get('latest');
        get.onsuccess = () => resolve(get.result?.state?.currentGenome ?? null);
        get.onerror = () => resolve(null);
      } catch { resolve(null); }
    };
  })), { timeout: 30_000 }).toBe('sacCer3');
  expect(await page.evaluate(() => localStorage.getItem('fiberhmm_last_genome'))).toBe('sacCer3');
  return a;
}

test.describe('genome restore precedence and one-step genome loads', () => {
  test.skip(!existsSync(DM6_FASTA) || !existsSync(`${DM6_FASTA}.fai`), 'needs an indexed local dm6 FASTA (FIBERBROWSER_TEST_DM6_FASTA)');
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true; });
    await page.setViewportSize({ width: 1500, height: 950 });
  });

  test("the owner's case: sacCer3 remembered in this browser, a --fasta dm6 server with a dm6 BAM: dm6, no yeast genes, dm6's genes in one click", async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const dir = makeData();
    const port = await pickRandomPort();
    const a = await earlierYeastSession(page, dir, port, false);
    a.kill('SIGTERM');
    await exited(a);

    // Today: a fresh scratch HOME (sacCer3 cached, dm6's annotation not), --fasta dm6.fa and a dm6 BAM, same port.
    const homeB = path.join(dir, 'homeB');
    spawnSync('cp', ['-R', path.join(dir, 'home'), homeB]);
    for (const f of ['browser_runtime.json', `browser_run_${port}.json`, 'genomes/dm6.gtf']) rmSync(path.join(homeB, '.fiberhmm', f), { force: true });
    const b = await serve(homeB, port, ['--dataset', path.join(dir, 'fly.bam'), '--fasta', DM6_FASTA]);
    const loads: string[] = [];
    page.on('request', r => { if (/load_genome|load_fasta|reference_pairs|load_gtf/.test(r.url())) loads.push(r.url()); });
    await page.goto(b.baseUrl);
    await page.waitForLoadState('networkidle');

    await expect.poll(() => store(page, s => [s.currentGenome, s.fastaPath, s.hasFasta])).toEqual(['dm6', DM6_FASTA, true]);
    await page.waitForTimeout(2_000);
    expect(loads).toEqual([]);           // nothing remembered was loaded over the server's reference
    const st = await status(b.baseUrl);
    expect([st.current_genome, st.fasta_path, st.startup_reference]).toEqual(['dm6', DM6_FASTA, true]);
    expect(st.gene_count).toBe(0);       // fresh HOME: no dm6 annotation yet, and never the cached yeast one
    await expect(page.getByTestId('genome-mismatch-banner')).toHaveCount(0);
    await expect(page.getByTestId('annotation-mismatch-banner')).toHaveCount(0);

    // "Load dm6 genes" beside the annotation row; dm6's annotation is in the cache now (never downloaded here).
    copyFileSync(path.join(genomes(path.join(dir, 'home')), 'dm6.gtf'), path.join(genomes(homeB), 'dm6.gtf'));
    await openGenomePage(page);
    const reset = page.getByTestId('annotation-reset-button');
    await expect(reset).toHaveText('Load dm6 genes');
    await reset.click();
    await expect.poll(async () => (await status(b.baseUrl)).gene_count, { timeout: 30_000 }).toBe(8);
    await expect(page.getByTestId('annotation-reset')).toHaveCount(0);   // the loaded annotation is dm6's own
    const names = await geneNames(b.baseUrl, 'chr2L', 999_000, 1_030_000);
    expect(names.some(n => n.startsWith('FLY_'))).toBe(true);
    expect(names.some(n => n.startsWith('YEAST_'))).toBe(false);
    expect((await status(b.baseUrl)).fasta_path).toBe(DM6_FASTA);
    expect(errors).toEqual([]);
  });

  test('one step: dm6 from the genome list when the server already has dm6 without genes', async ({ page }) => {
    const dir = makeData();
    const home = path.join(dir, 'home');
    rmSync(path.join(genomes(home), 'dm6.gtf'));
    const b = await serve(home, await pickRandomPort(), ['--dataset', path.join(dir, 'fly.bam'), '--fasta', DM6_FASTA]);
    await page.addInitScript(() => { try { localStorage.clear(); } catch { /* fresh */ } });
    await page.goto(b.baseUrl);
    await page.waitForLoadState('networkidle');
    await expect.poll(() => store(page, s => s.currentGenome)).toBe('dm6');
    expect((await status(b.baseUrl)).gene_count).toBe(0);
    // The annotation became available (cached) after start-up.
    makeGtfAgain(dir, home);

    await openGenomePage(page);
    const dm6 = page.getByRole('button', { name: 'D. melanogaster (dm6)' });
    await dm6.click();
    await expect.poll(async () => (await status(b.baseUrl)).gene_count, { timeout: 30_000 }).toBe(8);
    const st = await status(b.baseUrl);
    expect([st.current_genome, st.fasta_path]).toEqual(['dm6', DM6_FASTA]);   // the user's FASTA stays
    await expect.poll(() => store(page, s => [s.currentGenome, s.fastaPath])).toEqual(['dm6', DM6_FASTA]);
  });

  test('one step: "Switch to dm6" from sacCer3 brings dm6 and its genes; a foreign annotation is flagged and reset', async ({ page }) => {
    const dir = makeData();
    const home = path.join(dir, 'home');
    const yeastFa = path.join(genomes(home), 'sacCer3.fa');
    const b = await serve(home, await pickRandomPort(), ['--dataset', path.join(dir, 'fly.bam'), '--fasta', yeastFa]);
    await page.addInitScript(() => { try { localStorage.clear(); } catch { /* fresh */ } });
    await page.goto(b.baseUrl);
    await page.waitForLoadState('networkidle');
    const banner = page.getByTestId('genome-mismatch-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('dm6');
    await page.getByTestId('genome-mismatch-load-genome').click();
    await expect(banner).toHaveCount(0, { timeout: 60_000 });
    let st = await status(b.baseUrl);
    expect([st.current_genome, st.gene_count]).toEqual(['dm6', 8]);
    expect((await geneNames(b.baseUrl, 'chr2L', 999_000, 1_030_000)).some(n => n.startsWith('FLY_'))).toBe(true);

    // Yeast genes loaded over dm6 (a GTF of the wrong genome): flagged, and reset in one click.
    const gtf = await (await fetch(`${b.baseUrl}/api/load_gtf?path=${encodeURIComponent(path.join(genomes(home), 'sacCer3.gtf'))}`, { method: 'POST' })).json();
    expect(gtf.success ?? true).toBeTruthy();
    await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().triggerRefresh());
    const foreign = page.getByTestId('annotation-mismatch-banner');
    await expect(foreign).toBeVisible({ timeout: 30_000 });
    await expect(foreign).toContainText("not on dm6's contigs");
    await page.getByTestId('annotation-mismatch-reset').click();
    await expect(foreign).toHaveCount(0, { timeout: 30_000 });
    st = await status(b.baseUrl);
    expect(st.gene_count).toBe(8);
    expect((await geneNames(b.baseUrl, 'chr2L', 999_000, 1_030_000)).some(n => n.startsWith('YEAST_'))).toBe(false);
  });

  test('crash recovery of a sacCer3 session keeps the server\'s --fasta dm6 and says so in one line', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const dir = makeData();
    const port = await pickRandomPort();
    const a = await earlierYeastSession(page, dir, port, true);
    a.kill('SIGKILL');
    await exited(a);
    const home = path.join(dir, 'home');
    const b = await serve(home, port, ['--dataset', path.join(dir, 'fly.bam'), '--fasta', DM6_FASTA]);
    await page.goto(b.baseUrl);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('crash-recovery-banner')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.getByTestId('reference-notice-text'))
      .toHaveText('The saved reference (sacCer3) was not restored: this server was started with dm6.', { timeout: 30_000 });
    const st = await status(b.baseUrl);
    expect([st.current_genome, st.fasta_path]).toEqual(['dm6', DM6_FASTA]);
    expect(await store(page, s => s.currentGenome)).toBe('dm6');
    // The session's clusters came back; the view is on a dm6 contig (not the saved chrI).
    expect(await store(page, s => Object.keys(s.clusterAssignments).length)).toBe(1);
    const view = await store(page, s => ({ chrom: s.chrom, chroms: s.chroms.map((c: any) => c.name) }));
    expect(view.chroms).toContain(view.chrom);
    expect(view.chrom).not.toBe('chrI');
    expect(errors).toEqual([]);
  });

  test('no --fasta: a remembered sacCer3 FASTA is not restored under a dm6 BAM; dm6 is loaded and the page says so', async ({ page }) => {
    const dir = makeData();
    const port = await pickRandomPort();
    const a = await earlierYeastSession(page, dir, port, false);
    // The earlier page remembered the yeast FASTA's path (status hydration), as a local-FASTA session does.
    await page.evaluate(p => localStorage.setItem('fiberhmm_last_fasta_path', p), path.join(genomes(path.join(dir, 'home')), 'sacCer3.fa'));
    a.kill('SIGTERM');
    await exited(a);
    const b = await serve(path.join(dir, 'home'), port, ['--dataset', path.join(dir, 'fly.bam')]);
    await page.goto(b.baseUrl);
    await page.waitForLoadState('networkidle');
    await expect.poll(() => store(page, s => s.currentGenome), { timeout: 60_000 }).toBe('dm6');
    await expect(page.getByTestId('reference-notice-text')).toHaveText('The saved reference (sacCer3.fa) was not restored: the loaded data is dm6.');
    const st = await status(b.baseUrl);
    expect(st.current_genome).toBe('dm6');
    await expect(page.getByTestId('genome-mismatch-banner')).toHaveCount(0);
  });
});

/** dm6's annotation into the cache (as a download or another tab would leave it). */
function makeGtfAgain(dir: string, home: string) {
  const run = spawnSync(PYTHON, ['-c', `
import sys
with open(sys.argv[1], "w") as fh:
    for k in range(8):
        a = 'gene_id "G%04d"; gene_name "FLY_gene%d"; gene_biotype "protein_coding";' % (k, k)
        t = a + ' transcript_id "T%04d"; transcript_name "FLY_gene%d-RA";' % (k, k)
        s, e = 1000000 + k * 3000, 1001500 + k * 3000
        for f, at in (("gene", a), ("transcript", t), ("exon", t)):
            fh.write("chr2L\\tsynthetic\\t%s\\t%d\\t%d\\t.\\t+\\t.\\t%s\\n" % (f, s, e, at))
`, path.join(genomes(home), 'dm6.gtf')], { encoding: 'utf-8' });
  if (run.status !== 0) throw new Error(run.stderr);
  void dir;
}
