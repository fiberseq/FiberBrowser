/**
 * Screenshots for Recent and pinned genomes (docs/guide.md "Recent and pinned genomes"): Reference & Tracks →
 * Recent genomes, and the genome-mismatch banner's "Switch to dm6 (matches your data)" offer.
 *
 *   node scripts/capture-genome-screenshots.mjs --dm6 /path/to/dm6.fa --port PORT [--python PY] [--out ../../docs/images]
 *
 * Starts its own throwaway servers (browser.py from the repository root) on PORT with a scratch HOME, scratch recent
 * genomes and preferences files, and every download sent to a dead proxy (127.0.0.1:18939): nothing is downloaded and
 * ~/.fiberhmm is never read or written. FIBERBROWSER_FRONTEND_DIST, if set, is passed on (a scratch build).
 * Data: two small synthetic references with neutral names, the local indexed dm6 FASTA by symlink, and a few synthetic
 * fly reads on it (the BAM whose genome the banner matches), as tests/e2e/recent-genomes.spec.ts makes them.
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const opts = { out: path.resolve(here, '../../../docs/images'), python: process.env.FIBERBROWSER_TEST_PYTHON || 'python3', port: null, dm6: null, compress: true };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const next = () => process.argv[++i];
  if (a === '--out') opts.out = path.resolve(next());
  else if (a === '--python') opts.python = next();
  else if (a === '--port') opts.port = Number(next());
  else if (a === '--dm6') opts.dm6 = path.resolve(next());
  else if (a === '--no-compress') opts.compress = false;
  else throw new Error(`Unknown option ${a}`);
}
if (!opts.port || !opts.dm6) throw new Error('--port and --dm6 are required');

const MAKE_DATA = String.raw`
import os, sys, random
import pysam
out, dm6 = sys.argv[1], os.path.abspath(sys.argv[2])
os.makedirs(os.path.join(out, "home", ".fiberhmm"), exist_ok=True)
rng = random.Random(3)
def fasta(path, contigs):
    with open(path, "w") as fh:
        for name, n in contigs:
            fh.write(">%s\n" % name)
            s = "".join(rng.choice("ACGT") for _ in range(n))
            for i in range(0, n, 60):
                fh.write(s[i:i + 60] + "\n")
    pysam.faidx(path)
fasta(os.path.join(out, "my_assembly.fa"), [("ctgA", 20000), ("ctgB", 8000)])
fasta(os.path.join(out, "construct.fa"), [("insert", 5000), ("backbone", 4000)])
with open(os.path.join(out, "my_assembly.gtf"), "w") as fh:
    for k in range(5):
        a = 'gene_id "M%d"; gene_name "GENE_%d"; transcript_id "MT%d";' % (k, k, k)
        for f in ("gene", "transcript", "exon"):
            fh.write("ctgA\tsynthetic\t%s\t%d\t%d\t.\t+\t.\t%s\n" % (f, 1000 + k * 3000, 2500 + k * 3000, a))
os.symlink(dm6, os.path.join(out, "dm6.fa"))
os.symlink(dm6 + ".fai", os.path.join(out, "dm6.fa.fai"))
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
            r.query_name, r.query_sequence, r.flag = "read_%03d" % i, seq, 0
            r.reference_id, r.reference_start, r.mapping_quality = names.index("chr2L"), pos, 60
            r.cigar = [(0, len(seq))]
            r.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
            bam.write(r)
    pysam.sort("-o", os.path.join(out, "fly_sample.bam"), tmp)
    os.remove(tmp)
    pysam.index(os.path.join(out, "fly_sample.bam"))
`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const work = mkdtempSync(path.join(os.tmpdir(), 'fb-genome-capture-'));
const made = spawnSync(opts.python, ['-c', MAKE_DATA, work, opts.dm6], { encoding: 'utf-8' });
if (made.status !== 0) throw new Error(`synthetic data failed:\n${made.stderr}`);
const base = `http://127.0.0.1:${opts.port}`;
const written = [];

function serve(args) {
  const home = path.join(work, 'home');
  const dead = 'http://127.0.0.1:18939';
  const proc = spawn(opts.python, ['browser.py', '-p', String(opts.port), '--copilot', 'off', '--no-open', '--no-token', ...args], {
    cwd: repo,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env, HOME: home, FIBERBROWSER_NO_OPEN: '1', FIBERBROWSER_NO_UPDATE_CHECK: '1',
      FIBERBROWSER_PORT_MIN: String(opts.port), FIBERBROWSER_PORT_MAX: String(opts.port),
      FIBERBROWSER_SETTINGS: path.join(repo, 'tests', '__no_user_settings__.json'),
      FIBERBROWSER_APP_SETTINGS: path.join(work, 'app_settings.json'),
      FIBERBROWSER_RUNTIME_FILE: path.join(work, 'runtime.json'),
      FIBERBROWSER_LIBRARY: path.join(work, 'library.json'), FIBERBROWSER_JOBS_DIR: path.join(work, 'jobs'),
      FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN: '1', FIBERBROWSER_UPLOAD_DIR: path.join(work, 'uploads'),
      FIBERBROWSER_REGION_CATALOG_DIR: path.join(work, 'regions'),
      FIBERBROWSER_PREFERENCES: path.join(work, 'preferences.json'),
      FIBERBROWSER_RECENT_GENOMES: path.join(work, 'recent_genomes.json'),
      HTTPS_PROXY: dead, HTTP_PROXY: dead, https_proxy: dead, http_proxy: dead,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    },
  });
  return proc;
}
async function ready() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/api/version`)).ok) return; } catch { /* starting */ }
    await sleep(1000);
  }
  throw new Error('server did not start');
}
async function stop(proc) {
  await fetch(`${base}/api/quit`, { method: 'POST' }).catch(() => {});
  for (let i = 0; i < 20 && proc.exitCode === null; i++) await sleep(500);
  if (proc.exitCode === null) proc.kill('SIGTERM');
  for (let i = 0; i < 20 && proc.exitCode === null; i++) await sleep(500);
}
const post = async (route, body) => (await fetch(`${base}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json();

async function shoot(target, rel) {
  const file = path.join(opts.out, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  await target.screenshot({ path: file });
  written.push(file);
  console.log(`  wrote ${rel}`);
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    try { localStorage.clear(); sessionStorage.setItem('fiberhmm_welcome_dismissed', '1'); } catch { /* private mode */ }
  });
  await page.goto(base);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('panel-rail-coach-dismiss').click({ timeout: 3000 }).catch(() => {});
  return page;
}

const browser = await chromium.launch();
let proc = serve([]);
try {
  await ready();
  // Loaded in this order, so the list reads most recent first; the local dm6 and the custom assembly are pinned.
  for (const file of ['construct.fa', 'dm6.fa', 'my_assembly.fa']) {
    const r = await post(`/api/load_fasta?path=${encodeURIComponent(path.join(work, file))}`);
    if (!r.success) throw new Error(`could not load ${file}`);
    if (file === 'my_assembly.fa') await post(`/api/load_gtf?path=${encodeURIComponent(path.join(work, 'my_assembly.gtf'))}`);
  }
  let listed = await (await fetch(`${base}/api/recent_genomes`)).json();
  for (const name of ['dm6.fa', 'my_assembly.fa']) {
    const entry = listed.recent.find(e => e.fasta_name === name);
    if (entry) listed = await post('/api/recent_genomes/pin', { key: entry.key, pinned: true });
  }
  const page = await newPage(browser);
  console.log('shot recent-genomes');
  await page.getByTestId('settings-rail-genome').click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-subsection', { detail: { subsectionId: 'genome.recent' } })));
  const section = page.getByTestId('recent-genomes');
  await section.waitFor({ timeout: 15_000 });
  await section.scrollIntoViewIfNeeded();
  await sleep(1500);
  await shoot(page, 'genome/recent-genomes.png');
  await page.context().close();
  await stop(proc);

  // The fly reads under a reference that does not fit them: the banner offers the pinned dm6.
  proc = serve(['--dataset', path.join(work, 'fly_sample.bam'), '--fasta', path.join(work, 'construct.fa')]);
  await ready();
  const bpage = await newPage(browser);
  console.log('shot recent-match');
  const banner = bpage.getByTestId('genome-mismatch-banner');
  await banner.waitFor({ timeout: 30_000 });
  await bpage.getByTestId('genome-mismatch-recent-match').waitFor({ timeout: 30_000 });
  await sleep(1500);
  await shoot(banner, 'genome/recent-match-banner.png');   // the banner only (the empty panel below says the same)
  await bpage.context().close();
} finally {
  await stop(proc);
  await browser.close();
}

if (opts.compress && written.length) {
  const py = `
import sys
from PIL import Image
for p in sys.argv[1:]:
    im = Image.open(p).convert('RGB')
    if im.width > 1600:
        im = im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS)
    im = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    im.save(p, optimize=True)
`;
  spawnSync(opts.python, ['-c', py, ...written], { stdio: 'inherit' });
}
console.log(`${written.length} screenshots (work folder ${path.basename(work)})`);
