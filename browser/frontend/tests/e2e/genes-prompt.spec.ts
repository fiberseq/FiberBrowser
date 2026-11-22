/**
 * "No genes loaded for sacCer3 · Load sacCer3 genes" (owner, 3.1.1): a catalog genome loaded without its annotation
 * says so in the Genes track, and one click loads it; a failed load says why and offers Retry.
 *
 * All data is synthetic and local: a scratch HOME whose genome cache holds a small synthetic sacCer3 FASTA (the
 * catalog genome's contig lengths), a yeast BAM, and every download sent to a dead proxy. The first click finds no
 * annotation in the cache and its download fails (the dead proxy); then the annotation is put in the cache, standing
 * in for the catalog file, and Retry loads it. Nothing large is ever downloaded.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/nativeDialogs';
import { startServer, pickRandomPort, type ServerProcess } from './fixtures/server';
import { PYTHON } from './fixtures/syntheticData';

const MAKE_DATA = String.raw`
import os, random, sys
import pysam
out = sys.argv[1]
genomes = os.path.join(out, "home", ".fiberhmm", "genomes")
os.makedirs(genomes, exist_ok=True)
rng = random.Random(11)
YEAST = [("chrI", 230218), ("chrII", 813184), ("chrIII", 316620), ("chrIV", 1531933), ("chrV", 576874),
         ("chrVI", 270161), ("chrVII", 1090940), ("chrVIII", 562643), ("chrIX", 439888), ("chrX", 745751),
         ("chrXI", 666816), ("chrXII", 1078177), ("chrXIII", 924431), ("chrXIV", 784333), ("chrXV", 1091291),
         ("chrXVI", 948066), ("chrM", 85779)]
fa = os.path.join(genomes, "sacCer3.fa")
first = None
with open(fa, "w") as fh:
    for name, n in YEAST:
        s = "".join(rng.choice("ACGT") for _ in range(n)) if name == "chrI" else "N" * n
        if name == "chrI":
            first = s
        fh.write(">%s\n" % name)
        for i in range(0, n, 60):
            fh.write(s[i:i + 60] + "\n")
pysam.faidx(fa)
open(fa + ".source", "w").write("https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/bigZips/sacCer3.fa.gz")
with open(os.path.join(out, "sacCer3.gtf"), "w") as fh:
    for k in range(6):
        start, end = 10000 + k * 3000, 11500 + k * 3000
        attrs = 'gene_id "G%02d"; gene_name "YEAST_gene%d"; gene_biotype "protein_coding";' % (k, k)
        t = attrs + ' transcript_id "T%02d"; transcript_name "YEAST_gene%d-RA";' % (k, k)
        fh.write("chrI\tsynthetic\tgene\t%d\t%d\t.\t+\t.\t%s\n" % (start, end, attrs))
        fh.write("chrI\tsynthetic\ttranscript\t%d\t%d\t.\t+\t.\t%s\n" % (start, end, t))
        fh.write("chrI\tsynthetic\texon\t%d\t%d\t.\t+\t.\t%s\n" % (start, end, t))
header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": n, "LN": l} for n, l in YEAST]}
tmp = os.path.join(out, "yeast.unsorted.bam")
with pysam.AlignmentFile(tmp, "wb", header=header) as bam:
    for i in range(40):
        pos = 10000 + i * 200
        seq = first[pos:pos + 2000].upper()
        a = pysam.AlignedSegment()
        a.query_name = "read%03d" % i
        a.query_sequence = seq
        a.flag = 0
        a.reference_id = 0
        a.reference_start = pos
        a.mapping_quality = 60
        a.cigar = [(0, len(seq))]
        a.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
        bam.write(a)
pysam.sort("-o", os.path.join(out, "yeast.bam"), tmp)
os.remove(tmp)
pysam.index(os.path.join(out, "yeast.bam"))
`;

const OFFLINE = {
  HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};

let proc: ServerProcess | null = null;
test.afterEach(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  proc = null;
});

test('a catalog genome without genes: the Genes track offers them, a failed load offers Retry, and Retry loads them', async ({ page }) => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-genes-prompt-'));
  const run = spawnSync(PYTHON, ['-c', MAKE_DATA, dir], { encoding: 'utf-8' });
  if (run.status !== 0) throw new Error(`synthetic data failed:\n${run.stderr}`);
  const home = path.join(dir, 'home');
  const genomes = path.join(home, '.fiberhmm', 'genomes');
  proc = await startServer(null, await pickRandomPort(), {
    runtimeFile: path.join(home, '.fiberhmm', 'browser_runtime.json'), noTestFasta: true,
    extraArgs: ['--dataset', path.join(dir, 'yeast.bam'), '--fasta', path.join(genomes, 'sacCer3.fa')],
    env: { HOME: home, ...OFFLINE },
  });
  const base = proc.baseUrl;
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch { /* fresh */ } });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${base}/?locus=chrI:9000-30000`);
  await page.waitForLoadState('networkidle');

  // The prompt: in the Genes track, else (no Genes track shown) under the genome banner.
  const inTrack = page.getByTestId('genes-prompt');
  const notice = page.getByTestId('genes-notice-prompt');
  await expect(inTrack.or(notice).first()).toBeVisible({ timeout: 60_000 });
  const prompt = (await inTrack.count()) ? inTrack.first() : notice.first();
  const id = (await inTrack.count()) ? 'genes-prompt' : 'genes-notice-prompt';
  await expect(prompt.getByTestId(`${id}-message`)).toHaveText('No genes loaded for sacCer3');
  await expect(prompt.getByTestId(`${id}-button`)).toHaveText('Load sacCer3 genes');

  // Not in the cache, and the download goes to a dead proxy: the error, and Retry.
  await prompt.getByTestId(`${id}-button`).click();
  await expect(prompt.getByTestId(`${id}-error`)).toBeVisible({ timeout: 60_000 });
  await expect(prompt.getByTestId(`${id}-retry`)).toBeVisible();

  // The catalog annotation becomes available (cached, as a download would leave it): Retry loads it.
  spawnSync('cp', [path.join(dir, 'sacCer3.gtf'), path.join(genomes, 'sacCer3.gtf')]);
  await prompt.getByTestId(`${id}-retry`).click();
  await expect.poll(async () => (await (await fetch(`${base}/api/status`)).json()).gene_count, { timeout: 60_000 }).toBe(6);
  await expect(page.getByTestId('genes-prompt')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('genes-notice')).toHaveCount(0);
  const genes = await (await fetch(`${base}/api/genes?chrom=chrI&start=9000&end=30000`)).json();
  expect((genes.genes ?? []).map((g: any) => g.gene_name ?? g.name).filter((n: string) => n.startsWith('YEAST_gene')).length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
