/**
 * New DAF-seq run with the REAL fiberhmm-pipeline (daf-run.spec.ts uses a stand-in):
 * every wizard step, submit, the job runs to done, and the called BAM opens and draws.
 * The input is synthetic (a random genome and DddB-like reads, made here), so the run
 * takes seconds. Skips when the server's Python has no FiberHMM 3 pipeline or aligner.
 * The backend twin is tests/test_pipeline_real_run.py.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const ENV_KEYS = ['FIBERBROWSER_PIPELINE_COMMAND', 'FIBERBROWSER_CALL_COMMAND', 'FIBERBROWSER_NO_CAFFEINATE',
  'FIBERHMM_MINIMAP2_INDEX_DIR', 'FIBERHMM_NO_UPDATE_CHECK'];
const N_READS = 60;

/** Seeded PRNG (mulberry32): the same synthetic input every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPLEMENT: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
const revcomp = (s: string) => s.split('').reverse().map(b => COMPLEMENT[b]).join('');

/** A 20 kb random contig and DddB-like reads: C->T on the read's strand, rare in 147-of-200 bp stretches. */
function syntheticInputs() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-realrun-'));
  const r = rng(21);
  const genome = Array.from({ length: 20_000 }, () => 'ACGT'[Math.floor(r() * 4)]).join('');
  const fasta = path.join(dir, 'genome.fa');
  writeFileSync(fasta, `>chrA\n${genome.replace(/(.{80})/g, '$1\n')}\n`);
  const lines: string[] = [];
  for (let i = 0; i < N_READS; i++) {
    const size = 1500 + Math.floor(r() * 1100);
    const start = Math.floor(r() * (genome.length - size));
    const mol = genome.slice(start, start + size);
    const strand = r() < 0.5 ? mol : revcomp(mol);
    const offset = Math.floor(r() * 200);
    const read = strand.split('').map((b, j) => {
      const protectedBase = (j + offset) % 200 < 147;
      return b === 'C' && r() < (protectedBase ? 0.005 : 0.08) ? 'T' : b;
    }).join('');
    lines.push(`@m${i}`, read, '+', 'I'.repeat(read.length));
  }
  const reads = path.join(dir, 'synthetic_daf.fastq');
  writeFileSync(reads, `${lines.join('\n')}\n`);
  return { dir, reads, fasta, out: path.join(dir, 'FiberHMM runs', 'real1') };
}

test.describe('New DAF-seq run: the real fiberhmm-pipeline', () => {
  const saved: Record<string, string | undefined> = {};
  test.beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    // The server fixture passes its environment to the server, and the server to its jobs:
    // no stand-in pipeline, and the minimap2 index in a scratch folder.
    delete process.env.FIBERBROWSER_PIPELINE_COMMAND;
    delete process.env.FIBERBROWSER_CALL_COMMAND;
    process.env.FIBERBROWSER_NO_CAFFEINATE = '1';
    process.env.FIBERHMM_MINIMAP2_INDEX_DIR = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-mmi-'));
    process.env.FIBERHMM_NO_UPDATE_CHECK = '1';
  });
  test.afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('reads → reference → run → done → open: the called BAM draws', async ({ server, page }) => {
    test.setTimeout(300_000);
    const status = await (await page.request.get(`${server.baseUrl}/api/pipeline/status`)).json();
    test.skip(!status.available || status.source === 'environment', `no real fiberhmm-pipeline: ${status.hint || status.source}`);
    test.skip(!status.aligner?.ok, 'fiberhmm-pipeline has no aligner (minimap2 or mappy)');

    const files = syntheticInputs();
    await page.goto(server.baseUrl);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'file', subsectionId: 'file.dafrun' },
    })));
    await page.getByTestId('daf-run-open').click();
    const dialog = page.getByTestId('daf-run-dialog');
    await expect(dialog).toBeVisible();

    // 1. Reads: a typed path (never the native picker).
    await page.getByTestId('daf-run-path-input').fill(files.reads);
    await page.getByTestId('daf-run-add-path').click();
    await expect(page.getByTestId('daf-run-sample-name')).toHaveValue('synthetic_daf');
    await page.getByTestId('daf-run-next').click();

    // 2. Reference: the FASTA by path.
    await page.getByTestId('daf-run-ref-file').check();
    await page.getByTestId('daf-run-reference-path').fill(files.fasta);
    await page.getByTestId('daf-run-next').click();

    // 3. Run: DddB with the wizard's default options; open the result by hand below.
    await page.getByTestId('daf-run-enzyme-dddb').click();
    await page.getByTestId('daf-run-output').fill(files.out);
    await page.getByTestId('daf-run-auto-open').uncheck();
    await expect(page.getByTestId('daf-run-preview')).toContainText('synthetic_daf');
    const [posted] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/pipeline/jobs') && r.request().method() === 'POST'),
      page.getByTestId('daf-run-submit').click(),
    ]);
    const jobId: string = (await posted.json()).jobs[0].id;

    const card = dialog.locator(`[data-testid="daf-run-job"][data-job-id="${jobId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-job-status', 'done', { timeout: 240_000 });
    await expect(card.getByTestId('daf-run-job-summary')).toContainText(`Reads aligned ${N_READS}`);
    await expect(card.getByTestId('daf-run-job-summary')).toContainText(`Reads called ${N_READS}`);
    await expect(card.getByTestId('daf-run-job-steps')).toContainText('Calling footprints');

    const job = await (await page.request.get(`${server.baseUrl}/api/pipeline/jobs/${jobId}`)).json();
    expect(job.outdir).toBe(files.out);
    expect(job.command).toContain('--enzyme dddb');
    expect(job.outputs.settings.enzyme).toBe('dddb');
    expect(job.outputs.called_bam).toBe(path.join(files.out, 'synthetic_daf.fiberhmm.bam'));
    await card.getByTestId('daf-run-view-log').click();
    await expect(card.getByTestId('daf-run-log')).toContainText(`${N_READS} of ${N_READS} reads called`);

    // Open in browser: the reference and the called BAM; its reads and footprints draw.
    await card.getByTestId('daf-run-open-result').click();
    await expect(card.getByTestId('daf-run-job-message')).toContainText('Opened synthetic_daf');
    const datasets = (await (await page.request.get(`${server.baseUrl}/api/datasets`)).json()).datasets as { id: string; path: string }[];
    const opened = datasets.find(d => d.path === job.outputs.called_bam);
    expect(opened).toBeTruthy();
    const reads = await (await page.request.get(`${server.baseUrl}/api/reads/compact?chrom=chrA&start=0&end=20000`
      + `&dataset_id=${encodeURIComponent(opened!.id)}&include_layers=true&max_reads=500`)).json();
    expect(reads.reads.length).toBe(N_READS);
    // Each read's FiberHMM layers (ns/nl -> nuc, as/al -> msp) as {intervals: [...]}.
    type Layer = { intervals?: unknown[] };
    const withFootprints = reads.reads.filter((r: { layers?: Record<string, Layer> }) =>
      (r.layers?.nuc?.intervals?.length ?? 0) > 0 && (r.layers?.msp?.intervals?.length ?? 0) > 0);
    expect(withFootprints.length).toBeGreaterThan(N_READS / 2);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const header = page.getByTestId(`dataset-header-${opened!.id}`);
    // "N of M rows drawn", or "N/M" in a narrow header: some rows of the called BAM are on screen.
    await expect(header.getByTestId('panel-read-status')).toHaveText(/^[1-9][\d,]*( of |\/)[\d,]+/, { timeout: 60_000 });
  });
});
