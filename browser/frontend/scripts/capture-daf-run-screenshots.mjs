#!/usr/bin/env node
/**
 * Walk "New DAF-seq run" in a real (headless) Chromium against a running
 * FiberBrowser (started with --no-token and a real fiberhmm-pipeline), run
 * one sample end to end, time it, and save the screenshots used by
 * docs/workflows/daf-seq-quick-run.md.
 *
 *   cd browser/frontend && npm run build
 *   python ../../browser.py -p 8631 --no-token --no-open        # with FiberHMM 3 + minimap2
 *   node scripts/capture-daf-run-screenshots.mjs --base-url http://localhost:8631 \
 *        --reads /path/to/ABC123.zip --genome dm6 --output-root /scratch/runs/demo
 *
 * Options:
 *   --base-url URL      the running server (required)
 *   --reads PATH        FASTQ/BAM file, folder or Plasmidsaurus .zip (required)
 *   --genome ID         catalog genome (default dm6); or --reference PATH for a plasmid map/FASTA
 *   --output-root DIR   where the run writes (required; use a scratch folder)
 *   --cores N           default 4
 *   --out DIR           screenshots (default <repo>/docs/images/daf-run)
 *   --no-compress       keep the raw 2x PNGs (else downscaled and palette-compressed with Pillow)
 *   --python PATH       Python with Pillow for compression (default python3)
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

function parseArgs(argv) {
  const opts = { baseUrl: null, reads: null, genome: 'dm6', reference: null, outputRoot: null, cores: 4,
    out: path.join(REPO_ROOT, 'docs', 'images', 'daf-run'), compress: true, python: 'python3', width: 1600 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base-url') opts.baseUrl = next().replace(/\/$/, '');
    else if (a === '--reads') opts.reads = path.resolve(next());
    else if (a === '--genome') opts.genome = next();
    else if (a === '--reference') opts.reference = path.resolve(next());
    else if (a === '--output-root') opts.outputRoot = path.resolve(next());
    else if (a === '--cores') opts.cores = Number(next());
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--no-compress') opts.compress = false;
    else if (a === '--python') opts.python = next();
  }
  if (!opts.baseUrl || !opts.reads || !opts.outputRoot) {
    console.error('Need --base-url, --reads and --output-root (see the header of this script).');
    process.exit(2);
  }
  return opts;
}

function compressAll(dir, width, python) {
  const code = `
import sys, glob
from PIL import Image
for path in glob.glob(sys.argv[1] + '/*.png'):
    im = Image.open(path).convert('RGB')
    if im.width > ${width}:
        im = im.resize((${width}, round(im.height * ${width} / im.width)), Image.LANCZOS)
    im = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    im.save(path, optimize=True)
`;
  const r = spawnSync(python, ['-c', code, dir], { stdio: 'inherit' });
  if (r.status !== 0) console.warn('Compression failed (is Pillow installed?); the PNGs stay uncompressed.');
}

const opts = parseArgs(process.argv.slice(2));
mkdirSync(opts.out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const shot = async (name, target = page) => {
  await page.waitForTimeout(300);
  await target.screenshot({ path: path.join(opts.out, name) });
  console.log(`saved ${name}`);
};
const t = { start: Date.now() };
const log = (event) => console.log(`[${((Date.now() - t.start) / 1000).toFixed(1)} s] ${event}`);

await page.goto(opts.baseUrl);
await page.waitForLoadState('networkidle');
const welcome = page.getByTestId('welcome-daf-run-cta');
if (await welcome.isVisible()) {
  await shot('01_welcome.png');
  await welcome.click();
} else {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-daf-run', { detail: { tab: 'new' } })));
}
const dialog = page.getByTestId('daf-run-dialog');
await dialog.waitFor();

await page.getByTestId('daf-run-path-input').fill(opts.reads);
await page.getByTestId('daf-run-add-path').click();
await page.getByTestId('daf-run-samples').waitFor();
await shot('02_reads.png', dialog);
await page.getByTestId('daf-run-next').click();

if (opts.reference) {
  await page.getByTestId('daf-run-ref-file').check();
  await page.getByTestId('daf-run-reference-path').fill(opts.reference);
} else {
  await page.getByTestId('daf-run-ref-genome').check();
  await page.getByTestId('daf-run-genome-select').selectOption(opts.genome);
}
await shot('03_reference.png', dialog);
await page.getByTestId('daf-run-next').click();

await page.getByTestId('daf-run-enzyme-dddb').click();
await page.getByTestId('daf-run-output').fill(opts.outputRoot);
await page.getByTestId('daf-run-cores').fill(String(opts.cores));
await page.getByTestId('daf-run-options').click();
await page.getByTestId('daf-run-preview').waitFor();
await shot('04_run_and_options.png', dialog);

log('Run clicked');
t.submit = Date.now();
await page.getByTestId('daf-run-submit').click();
const card = page.getByTestId('daf-run-job').first();
await card.waitFor();
const seen = new Set();
let progressShot = false;
for (;;) {
  const status = await card.getAttribute('data-job-status');
  const running = await card.locator('[data-step-status="running"]').first().getAttribute('data-step').catch(() => null);
  const key = `${status}:${running}`;
  if (!seen.has(key)) { seen.add(key); log(`status ${status}${running ? ` (${running})` : ''}`); }
  if (!progressShot && status === 'running' && (running === 'call' || running === 'align')) {
    await page.waitForTimeout(1500);
    await shot('05_progress.png', dialog);
    progressShot = true;
  }
  if (['done', 'error', 'cancelled', 'interrupted'].includes(status)) break;
  await page.waitForTimeout(1000);
}
t.done = Date.now();
log(`finished: ${((t.done - t.submit) / 1000).toFixed(1)} s from Run to done`);
await card.getByTestId('daf-run-job-summary').getByText('Reads aligned').waitFor({ timeout: 60_000 });
await shot('06_done.png', dialog);
await card.getByTestId('daf-run-show-qc').click();
await card.getByTestId('qc-rate-cdf').waitFor();
await card.getByTestId('qc-report').scrollIntoViewIfNeeded();
await shot('07_qc.png', card);

await card.getByTestId('daf-run-open-result').click();
await card.getByTestId('daf-run-job-message').waitFor();
log(`open: ${await card.getByTestId('daf-run-job-message').textContent()}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(4000);
await page.waitForLoadState('networkidle');
await shot('08_result.png');
log('done');
await browser.close();
if (opts.compress) compressAll(opts.out, opts.width, opts.python);
