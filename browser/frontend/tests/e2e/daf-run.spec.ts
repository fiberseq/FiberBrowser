/**
 * New DAF-seq run, end to end in the UI with a stand-in pipeline
 * (tests/fake_fiberhmm_pipeline.py: contract-v1 progress, outputs.json, a
 * copy of the demo BAM and a synthetic fiberhmm-qc). Fast enough for CI; the
 * real fiberhmm-pipeline run is documented in docs/workflows/daf-seq-quick-run.md.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR ? path.resolve(process.env.FIBERBROWSER_TEST_DIR) : path.resolve(HERE, '../../../..');
const FAKE = path.join(REPO_ROOT, 'tests', 'fake_fiberhmm_pipeline.py');
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';

test.use({ fixtureBam: 'demo' });

const ENV_KEYS = ['FIBERBROWSER_PIPELINE_COMMAND', 'FIBERBROWSER_JOBS_DIR', 'FIBERBROWSER_NO_CAFFEINATE', 'FAKE_PIPELINE_STEP_S'];

function useFakePipeline(stepSeconds: string) {
  const saved: Record<string, string | undefined> = {};
  test.beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    // The server fixture passes its environment to the server, and the server to its jobs.
    process.env.FIBERBROWSER_PIPELINE_COMMAND = `${PYTHON} ${FAKE}`;
    process.env.FIBERBROWSER_JOBS_DIR = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-jobs-'));
    process.env.FIBERBROWSER_NO_CAFFEINATE = '1';
    process.env.FAKE_PIPELINE_STEP_S = stepSeconds;
  });
  test.afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function inputs() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-reads-'));
  const reads = path.join(dir, 'ABC123_1_my_sample.fastq');
  writeFileSync(reads, '@r1\nACGTACGTAC\n+\nIIIIIIIIII\n@r2\nACGTACGTAC\n+\nIIIIIIIIII\n');
  const fasta = path.join(dir, 'amplicon.fa');
  writeFileSync(fasta, `>amp\n${'ACGT'.repeat(100)}\n`);
  return { dir, reads, fasta, out: path.join(dir, 'FiberHMM runs', 'run1') };
}

async function openWizard(page: Page, baseUrl: string) {
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  // Data & Sessions > DAF-seq runs > New DAF-seq run… (the Copilot anchor daf-run-new)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: 'file', subsectionId: 'file.dafrun' },
  })));
  await page.getByTestId('daf-run-open').click();
  await expect(page.getByTestId('daf-run-dialog')).toBeVisible();
}

async function fillWizard(page: Page, files: ReturnType<typeof inputs>) {
  await page.getByTestId('daf-run-path-input').fill(files.reads);
  await page.getByTestId('daf-run-add-path').click();
  // Plasmidsaurus naming: order ABC123, barcode 1, sample "my_sample".
  await expect(page.getByTestId('daf-run-sample-name')).toHaveValue('my_sample');
  await page.getByTestId('daf-run-sample-name').fill('sample-A');
  await page.getByTestId('daf-run-next').click();

  await page.getByTestId('daf-run-ref-file').check();
  await page.getByTestId('daf-run-reference-path').fill(files.fasta);
  await page.getByTestId('daf-run-next').click();

  await page.getByTestId('daf-run-enzyme-dddb').click();
  await page.getByTestId('daf-run-output').fill(files.out);
  await page.getByTestId('daf-run-auto-open').uncheck();
  await page.getByTestId('daf-run-options').click();
  await page.getByTestId('daf-run-opt-dedup').selectOption('off');
  await expect(page.getByTestId('daf-run-preview')).toContainText('sample-A');
}

test.describe('New DAF-seq run', () => {
  useFakePipeline('0.3');

  test('reads → reference → run → progress → QC → open the result', async ({ server, page }) => {
    const files = inputs();
    await openWizard(page, server.baseUrl);
    await fillWizard(page, files);
    await page.getByTestId('daf-run-submit').click();

    const card = page.getByTestId('daf-run-job').first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-job-status', 'done', { timeout: 30_000 });
    await expect(card.getByTestId('daf-run-job-steps')).toContainText('Aligning reads');
    await expect(card.getByTestId('daf-run-job-summary')).toContainText('Reads aligned');
    await expect(card).toContainText('Options: duplicates off');

    // The argv reached the pipeline as separate items (no shell), with the option.
    const job = (await (await page.request.get(`${server.baseUrl}/api/pipeline/jobs`)).json()).jobs[0];
    expect(job.command).toContain('--dedup off');
    expect(job.outdir).toBe(files.out);

    // State-aware QC (fiberhmm-qc 3.0): the run's efficiency and background from outputs.json.
    await expect(card.getByTestId('daf-run-qc-efficiency')).toHaveText('Efficiency 42.0% PASS');
    await expect(card.getByTestId('daf-run-qc-background')).toHaveText('Background 8.0% PASS');

    await card.getByTestId('daf-run-show-qc').click();
    await expect(card.getByTestId('qc-report')).toBeVisible();
    await expect(card.getByTestId('qc-rate-cdf').locator('svg path').first()).toBeVisible();
    await expect(card.getByTestId('qc-phasogram')).toContainText('NRL 190 bp');
    await expect(card.getByTestId('qc-verdict-basis')).toContainText('Verdict from efficiency, background and periodicity');
    await expect(card.getByTestId('qc-state-efficiency')).toContainText('42.0%');
    await expect(card.getByTestId('qc-state-efficiency')).toContainText('PASS ≥ 38.0% · WARN ≥ 33.0%');
    await expect(card.getByTestId('qc-state-background')).toContainText('PASS ≤ 10.0% · WARN ≤ 12.0%');
    await expect(card.getByTestId('qc-state-cdf').locator('svg path')).toHaveCount(4);

    await card.getByTestId('daf-run-view-log').click();
    await expect(card.getByTestId('daf-run-log')).toContainText('fiberhmm-pipeline');

    await card.getByTestId('daf-run-open-result').click();
    await expect(card.getByTestId('daf-run-job-message')).toContainText('Opened sample-A');
    const datasets = (await (await page.request.get(`${server.baseUrl}/api/datasets`)).json()).datasets;
    expect(datasets.some((d: { path: string }) => d.path.endsWith('sample-A.fiberhmm.bam'))).toBeTruthy();
  });
});

test.describe('New DAF-seq run: cancel and retry', () => {
  useFakePipeline('20');

  test('a running job can be cancelled and retried', async ({ server, page }) => {
    const files = inputs();
    await openWizard(page, server.baseUrl);
    await fillWizard(page, files);
    await page.getByTestId('daf-run-submit').click();
    const card = page.getByTestId('daf-run-job').first();
    await expect(card).toHaveAttribute('data-job-status', 'running', { timeout: 15_000 });
    await expect(card.getByTestId('daf-run-job-headline')).toContainText(/Preparing|Starting|Working/);
    await card.getByTestId('daf-run-cancel').click();
    await expect(card).toHaveAttribute('data-job-status', 'cancelled', { timeout: 20_000 });
    await card.getByTestId('daf-run-retry').click();
    await expect(card).toHaveAttribute('data-job-status', /queued|running/);
    await card.getByTestId('daf-run-cancel').click();
    await expect(card).toHaveAttribute('data-job-status', 'cancelled', { timeout: 20_000 });
  });
});
