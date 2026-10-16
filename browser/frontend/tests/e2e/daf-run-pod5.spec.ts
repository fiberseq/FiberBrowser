/**
 * Raw Nanopore (POD5), end to end: the New run wizard's POD5 input, the dorado status,
 * the real fiberhmm-pipeline (FiberHMM 3.0) basecalling with a stand-in dorado
 * (tests/fake_dorado.py, FiberHMM's own test double: an unaligned BAM with dorado 2.0.1's
 * @PG/@RG, sup v5.2.0 and the 6mA model), aligning (minimap2), calling and QC, the
 * "basecall" step in Runs, and the finished run in the Library with its Basecaller line.
 *
 * Needs FiberHMM >= 3.0 importable by FIBERBROWSER_TEST_PYTHON (FIBERBROWSER_TEST_FIBERHMM: a
 * FiberHMM source folder to put on PYTHONPATH) and minimap2; skips otherwise. Nothing is
 * written to ~/.fiberhmm (the minimap2 index and dorado models go to a scratch folder).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR ? path.resolve(process.env.FIBERBROWSER_TEST_DIR) : path.resolve(HERE, '../../../..');
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const FIBERHMM = process.env.FIBERBROWSER_TEST_FIBERHMM?.trim();

test.use({ fixtureBam: 'demo' });

const ENV_KEYS = ['PATH', 'PYTHONPATH', 'FIBERBROWSER_PIPELINE_COMMAND', 'FIBERBROWSER_JOBS_DIR', 'FIBERBROWSER_NO_CAFFEINATE',
  'FAKE_DORADO_READS', 'FAKE_DORADO_LOG', 'FIBERHMM_DORADO_MODELS_DIR', 'FIBERHMM_DORADO', 'FIBERHMM_MINIMAP2_INDEX_DIR',
  'FIBERHMM_NO_UPDATE_CHECK'];

interface Fixture { fasta: string; reads: string; pod5: string; dorado: string; models: string; log: string }

function pythonEnv(): NodeJS.ProcessEnv {
  return FIBERHMM ? { ...process.env, PYTHONPATH: [FIBERHMM, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } : process.env;
}

/** Why the spec cannot run here (no FiberHMM 3.0 pipeline with a dorado step, no minimap2), or null. */
function missingTools(): string | null {
  const fh = spawnSync(PYTHON, ['-c', 'import fiberhmm.pipeline.basecall, fiberhmm.cli.pipeline'], { env: pythonEnv(), encoding: 'utf-8' });
  if (fh.status !== 0) return 'FiberHMM >= 3.0 (fiberhmm.pipeline.basecall) is not importable; set FIBERBROWSER_TEST_FIBERHMM';
  if (spawnSync('minimap2', ['--version']).status !== 0) return 'minimap2 is not installed';
  return null;
}

test.describe('New run: raw Nanopore (POD5) to the Library', () => {
  const saved: Record<string, string | undefined> = {};
  let fixture: Fixture;
  let skipped: string | null = null;

  test.beforeAll(() => {
    skipped = missingTools();
    if (skipped) return;
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-pod5-'));
    const made = spawnSync(PYTHON, [path.join(REPO_ROOT, 'tests', 'make_pod5_fixture.py'), dir], { encoding: 'utf-8' });
    if (made.status !== 0) throw new Error(`make_pod5_fixture.py failed: ${made.stderr}`);
    fixture = JSON.parse(made.stdout.trim().split('\n').pop()!);
    // The server fixture passes its environment to the server, the server to its jobs, the pipeline to dorado.
    // The stand-in dorado comes first on PATH: FiberBrowser's resolver and the pipeline both find it there.
    process.env.PATH = [path.dirname(fixture.dorado), process.env.PATH].filter(Boolean).join(path.delimiter);
    if (FIBERHMM) process.env.PYTHONPATH = pythonEnv().PYTHONPATH;
    process.env.FIBERBROWSER_PIPELINE_COMMAND = `${PYTHON} -m fiberhmm.cli.pipeline`;
    process.env.FIBERBROWSER_JOBS_DIR = path.join(dir, 'jobs');
    process.env.FIBERBROWSER_NO_CAFFEINATE = '1';
    process.env.FAKE_DORADO_READS = fixture.reads;
    process.env.FAKE_DORADO_LOG = fixture.log;
    process.env.FIBERHMM_DORADO_MODELS_DIR = fixture.models;
    process.env.FIBERHMM_MINIMAP2_INDEX_DIR = path.join(dir, 'minimap2_index');
    process.env.FIBERHMM_NO_UPDATE_CHECK = '1';
    delete process.env.FIBERHMM_DORADO;
  });

  test.afterAll(() => {
    if (skipped) return;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('POD5 folder → dorado (sup + 6mA) → aligned, called → Runs and the Library show the basecaller', async ({ server, page }) => {
    test.skip(Boolean(skipped), skipped ?? '');
    test.setTimeout(240_000);
    await page.goto(server.baseUrl);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'file', subsectionId: 'file.dafrun' },
    })));
    await page.getByTestId('daf-run-open').click();
    const dialog = page.getByTestId('daf-run-dialog');
    await expect(dialog).toBeVisible();

    // Reads: the POD5 option, dorado found before anything starts, a MinKNOW folder named after its run.
    await dialog.getByTestId('daf-run-input-pod5').click();
    const dorado = dialog.getByTestId('daf-run-dorado');
    await expect(dorado).toHaveAttribute('data-dorado', 'found');
    await expect(dorado).toContainText(`dorado 2.0.1+fake found: ${fixture.dorado}`);
    await dialog.getByTestId('daf-run-path-input').fill(fixture.pod5);
    await dialog.getByTestId('daf-run-add-path').click();
    await expect(dialog.getByTestId('daf-run-sample-name')).toHaveValue('yw_2_4h');
    await dialog.getByTestId('daf-run-next').click();

    await dialog.getByTestId('daf-run-ref-file').check();
    await dialog.getByTestId('daf-run-reference-path').fill(fixture.fasta);
    await dialog.getByTestId('daf-run-next').click();

    // Hia5 (m6A Fiber-seq): sup + 6mA by default, nothing to set.
    await dialog.getByTestId('daf-run-enzyme-hia5').click();
    await expect(dialog.getByTestId('daf-run-basecall-line')).toHaveText('dorado sup + 6mA');
    const out = path.join(path.dirname(fixture.fasta), 'FiberHMM runs', 'yw_2_4h');
    await dialog.getByTestId('daf-run-output').fill(out);
    await dialog.getByTestId('daf-run-auto-open').uncheck();
    await expect(dialog.getByTestId('daf-run-preview')).toContainText('yw_2_4h');
    await dialog.getByTestId('daf-run-submit').click();

    // Runs: basecall first, then the rest; the finished run's basecaller.
    const card = dialog.getByTestId('daf-run-job').first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-job-status', 'done', { timeout: 180_000 });
    const basecall = card.locator('[data-step="basecall"]');
    await expect(basecall).toHaveAttribute('data-step-status', 'done');
    await expect(basecall).toContainText('Basecalling (dorado)');
    await expect(basecall).toContainText('40 reads');
    await expect(card).toContainText('Options: basecall: dorado sup + 6mA');
    await expect(card.getByTestId('daf-run-job-basecaller')).toHaveText('Basecaller dorado 2.0.1 · sup v5.2.0 · 6mA v1');
    await expect(card.getByTestId('daf-run-job-summary')).toContainText('Reads basecalled 40');

    // The pipeline ran dorado itself, with its defaults (no --dorado-* flag, no --dorado: it found the same copy).
    const job = (await (await page.request.get(`${server.baseUrl}/api/pipeline/jobs`)).json()).jobs[0];
    expect(job.command).not.toContain('--dorado');
    expect(job.outputs.basecalled_bam).toBe(path.join(out, 'yw_2_4h.basecalled.bam'));
    expect(job.outputs.settings.basecaller.modbase_models).toEqual(['dna_r10.4.1_e8.2_400bps_sup@v5.2.0_6mA@v1']);
    await dialog.getByRole('button', { name: 'Close' }).click();

    // The Library: the run's called BAM, with its Basecaller line.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'file', subsectionId: 'file.library' },
    })));
    await page.getByTestId('library-open-panel').click();
    const library = page.getByTestId('library-dialog');
    const row = library.getByTestId('library-row').filter({ hasText: 'yw_2_4h' });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await row.click();
    const details = library.getByTestId('library-details');
    await expect(details.getByTestId('library-basecaller')).toHaveText('Basecallerdorado 2.0.1 · sup v5.2.0 · 6mA v1');
    await expect(details.getByTestId('library-basecaller')).toHaveAttribute('title', /Basecall model: dna_r10\.4\.1_e8\.2_400bps_sup@v5\.2\.0/);
  });
});
