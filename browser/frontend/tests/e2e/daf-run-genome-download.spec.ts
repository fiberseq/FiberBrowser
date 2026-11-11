/**
 * New DAF-seq run wizard: the Reference step's catalog genomes, against the real backend.
 *
 * The owner's report: with dm6 open in FiberBrowser, "Download dm6" looked pressed for a moment, then nothing
 * happened and Next stayed blocked (/api/load_genome answered "already loaded" without downloading). Now:
 * - a genome open from a local FASTA named for it is the run's reference: no download, Next goes on;
 * - a download that cannot reach any mirror says which URL failed and why, with Retry and "Use a FASTA file";
 * - (opt-in, real network: FIBERBROWSER_E2E_NETWORK=1) Download shows progress and Next goes on once ready.
 *
 * Mirrors are made unreachable with a dead proxy (HTTPS_PROXY=127.0.0.1:9) given to the server, so no
 * production seam is needed; it also keeps the start-up hg38 auto-load from downloading anything.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

function withEnv(values: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  test.beforeAll(() => {
    for (const [key, value] of Object.entries(values)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  test.afterAll(() => {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function reads(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-reads-'));
  const file = path.join(dir, 'ABC123_1_my_sample.fastq');
  writeFileSync(file, '@r1\nACGTACGTAC\n+\nIIIIIIIIII\n');
  return file;
}

/** A tiny indexed FASTA. Named dm6.fa, the server infers genome dm6 from its name. */
function localFasta(name: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-ref-'));
  mkdirSync(dir, { recursive: true });
  const fa = path.join(dir, name);
  const seq = 'ACGT'.repeat(25);
  writeFileSync(fa, `>chr2L\n${seq}\n`);
  writeFileSync(`${fa}.fai`, `chr2L\t100\t7\t100\t101\n`);
  return fa;
}

async function toReference(page: Page, baseUrl: string) {
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: 'file', subsectionId: 'file.dafrun' },
  })));
  await page.getByTestId('daf-run-open').click();
  await expect(page.getByTestId('daf-run-dialog')).toBeVisible();
  await page.getByTestId('daf-run-path-input').fill(reads());
  await page.getByTestId('daf-run-add-path').click();
  await expect(page.getByTestId('daf-run-sample-name')).toHaveValue('my_sample');
  await page.getByTestId('daf-run-next').click();
  await page.getByTestId('daf-run-ref-genome').check();
}

const DEAD_PROXY = {
  HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};

test.describe('Run wizard: a genome open from a local FASTA', () => {
  withEnv({ FIBERBROWSER_TEST_FASTA: localFasta('dm6.fa'), ...DEAD_PROXY });

  test('is the reference: no download, Next goes on', async ({ server, page }) => {
    await toReference(page, server.baseUrl);
    await page.getByTestId('daf-run-genome-select').selectOption('dm6');
    await expect(page.getByTestId('daf-run-download-genome')).toHaveCount(0);
    await expect(page.getByTestId('daf-run-genome-fasta')).toContainText('dm6.fa');
    await page.getByTestId('daf-run-next').click();
    await expect(page.getByTestId('daf-run-enzyme-dddb')).toBeVisible();
  });
});

test.describe('Run wizard: a download that cannot reach any mirror', () => {
  withEnv(DEAD_PROXY);

  test('says which URL failed and why, and offers Retry and a FASTA file', async ({ server, page }) => {
    await toReference(page, server.baseUrl);
    await page.getByTestId('daf-run-genome-select').selectOption('dm6');
    await page.getByTestId('daf-run-download-genome').click();
    const error = page.getByTestId('daf-run-genome-error');
    await expect(error).toContainText('Could not download D. melanogaster (dm6). Tried:', { timeout: 60_000 });
    await expect(error).toContainText('igv.broadinstitute.org/genomes/seq/dm6/dm6.fa: could not reach the server');
    await expect(error).toContainText('hgdownload.soe.ucsc.edu/goldenPath/dm6/bigZips/dm6.fa: could not reach the server');
    await expect(page.getByTestId('daf-run-download-genome')).toHaveText('Download dm6');
    await page.getByTestId('daf-run-genome-retry').click();
    await expect(error).toContainText('could not reach the server', { timeout: 60_000 });
    await page.getByTestId('daf-run-genome-use-file').click();
    await expect(page.getByTestId('daf-run-reference-path')).toBeVisible();
  });
});

test.describe('Run wizard: a real download (network)', () => {
  test.skip(!process.env.FIBERBROWSER_E2E_NETWORK, 'set FIBERBROWSER_E2E_NETWORK=1 (downloads sacCer3, 12 MB)');
  // A reference of its own, so the start-up auto-load does not fetch hg38 for the demo BAM.
  withEnv({ FIBERBROWSER_TEST_FASTA: localFasta('amplicon.fa') });

  test('shows progress, then Next goes on', async ({ server, page }) => {
    test.setTimeout(300_000);
    await toReference(page, server.baseUrl);
    await page.getByTestId('daf-run-genome-select').selectOption('sacCer3');
    const button = page.getByTestId('daf-run-download-genome');
    if (await button.count()) {
      await button.click();
      await expect(page.getByTestId('daf-run-genome-progress').or(page.getByTestId('daf-run-genome-fasta')))
        .toBeVisible();
      await expect(page.getByTestId('daf-run-genome-fasta')).toContainText('sacCer3.fa', { timeout: 240_000 });
    }
    await page.getByTestId('daf-run-next').click();
    await expect(page.getByTestId('daf-run-enzyme-dddb')).toBeVisible();
  });
});
