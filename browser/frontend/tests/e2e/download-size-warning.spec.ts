/**
 * Downloads have no size cap but a warning size (3.1.0). The run wizard shows a genome download's size before it
 * starts, asks before one over the warning size, and starts it confirmed; a download the server holds for
 * confirmation offers Download. The size, start and status answers are stubbed in the page (page.route), so
 * nothing is downloaded or probed: the rest is the real backend on the demo BAM.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/server';
import type { Page, Route } from '@playwright/test';

test.use({ fixtureBam: 'demo' });

// A dead proxy for the server: nothing it might fetch (the start-up genome, a mirror) leaves this computer.
const DEAD_PROXY = {
  HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};
const saved: Record<string, string | undefined> = {};
test.beforeAll(() => {
  for (const [key, value] of Object.entries(DEAD_PROXY)) { saved[key] = process.env[key]; process.env[key] = value; }
});
test.afterAll(() => {
  for (const key of Object.keys(DEAD_PROXY)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const BIG = { genome_id: 'dm6', url: 'https://mirror.example/dm6.fa', bytes: 5_200_000_000, threshold: 4_000_000_000, over: true };

function reads(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-reads-'));
  const file = path.join(dir, 'ABC123_1_my_sample.fastq');
  writeFileSync(file, '@r1\nACGTACGTAC\n+\nIIIIIIIIII\n');
  return file;
}

async function toReference(page: Page, baseUrl: string) {
  await page.addInitScript(() => { (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true; });
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

test('the wizard shows the size, asks over the warning size, and starts confirmed', async ({ server, page }) => {
  const starts: string[] = [];
  await page.route('**/api/pipeline/genome_download/size?*', (route: Route) => route.fulfill({ json: BIG }));
  await page.route('**/api/pipeline/genome_download?*', (route: Route) => {
    const url = route.request().url();
    if (route.request().method() === 'POST') {
      starts.push(url);
      const confirmed = url.includes('confirm_large=true');
      return route.fulfill({ json: confirmed
        ? { genome_id: 'dm6', state: 'running', url: BIG.url, bytes: 0, total: BIG.bytes, warning: null }
        : { genome_id: 'dm6', name: 'D. melanogaster (dm6)', state: 'confirm', url: BIG.url, total: BIG.bytes, threshold: BIG.threshold } });
    }
    return route.fulfill({ json: starts.some(u => u.includes('confirm_large=true'))
      ? { genome_id: 'dm6', state: 'running', url: BIG.url, bytes: 1_000_000, total: BIG.bytes }
      : { genome_id: 'dm6', state: 'idle' } });
  });
  await page.route('**/api/pipeline/genome_download/cancel?*', (route: Route) => route.fulfill({ json: { genome_id: 'dm6', state: 'cancelled' } }));

  await toReference(page, server.baseUrl);
  await page.getByTestId('daf-run-genome-select').selectOption('dm6');
  const button = page.getByTestId('daf-run-download-genome');
  await expect(button).toHaveText('Download dm6 (5.2 GB)', { timeout: 30_000 });

  // Declined: nothing starts.
  page.once('dialog', dialog => {
    expect(dialog.message()).toContain('is 5.2 GB to download from mirror.example, over the 4.0 GB download warning size');
    void dialog.dismiss();
  });
  await button.click();
  await page.waitForTimeout(500);
  expect(starts).toHaveLength(0);

  // Accepted: the start says so.
  page.once('dialog', dialog => void dialog.accept());
  await button.click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toContain('confirm_large=true');
  await expect(page.getByTestId('daf-run-genome-progress')).toBeVisible();
  await page.getByTestId('daf-run-genome-cancel').click();
});

test('a download the server holds for confirmation offers Download', async ({ server, page }) => {
  const starts: string[] = [];
  // The size is unknown before it starts (the server did not say); the server learns it when it begins.
  await page.route('**/api/pipeline/genome_download/size?*', (route: Route) => route.fulfill({ json: { ...BIG, bytes: null, over: false } }));
  await page.route('**/api/pipeline/genome_download?*', (route: Route) => {
    const url = route.request().url();
    if (route.request().method() === 'POST') starts.push(url);
    const confirmed = starts.some(u => u.includes('confirm_large=true'));
    return route.fulfill({ json: route.request().method() === 'GET' && !starts.length
      ? { genome_id: 'dm6', state: 'idle' }
      : confirmed
        ? { genome_id: 'dm6', state: 'running', url: BIG.url, bytes: 1_000_000, total: BIG.bytes,
          warning: 'Large download: 5.2 GB (over the 4.0 GB download warning size) from https://mirror.example/dm6.fa' }
        : { genome_id: 'dm6', name: 'D. melanogaster (dm6)', state: 'confirm', url: BIG.url, total: BIG.bytes, threshold: BIG.threshold } });
  });
  await page.route('**/api/pipeline/genome_download/cancel?*', (route: Route) => route.fulfill({ json: { genome_id: 'dm6', state: 'cancelled' } }));

  await toReference(page, server.baseUrl);
  await page.getByTestId('daf-run-genome-select').selectOption('dm6');
  await expect(page.getByTestId('daf-run-download-genome')).toHaveText('Download dm6');
  await page.getByTestId('daf-run-download-genome').click();
  await expect(page.getByTestId('daf-run-genome-confirm')).toContainText('D. melanogaster (dm6) is 5.2 GB to download');
  await page.getByTestId('daf-run-genome-confirm-download').click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]).toContain('confirm_large=true');
  await expect(page.getByTestId('daf-run-genome-warning')).toContainText('Large download: 5.2 GB');
  await page.getByTestId('daf-run-genome-cancel').click();
});
