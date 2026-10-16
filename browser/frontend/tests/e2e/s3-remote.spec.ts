/**
 * s3:// data end to end against a real S3-compatible server (opt-in).
 *
 * Skipped unless FIBERBROWSER_TEST_S3_ENDPOINT is set: a local MinIO is enough
 * (see tests/s3_minio.py). The spec stages its own buckets with that script
 * (FIBERBROWSER_TEST_S3_ACCESS_KEY / _SECRET_KEY) and deletes them after.
 *
 * - Load Remote URL with an endpoint opens a private s3:// BAM, with reads;
 * - a missing object is named in the error banner;
 * - a catalog with an "s3" block lists its groups, opens a private group, and
 *   names the files of a broken one (missing index, missing object).
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect, startServer, type ServerProcess, pickRandomPort, DEMO_FIXTURE } from './fixtures/server';

const ENDPOINT = process.env.FIBERBROWSER_TEST_S3_ENDPOINT?.trim();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PYTHON = process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python';
const SHOTS = process.env.FB_S3_SHOTS?.trim();

interface Staged {
  run: string; endpoint: string; bam: string; noidx_bam: string; missing_bam: string; public_bam: string;
  region: [string, number, number]; reads: number;
}

let staged: Staged | null = null;

if (ENDPOINT) {
  // The servers the fixtures start inherit these: the test keys, and never the
  // developer's own AWS files or an instance role.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-s3-'));
  process.env.AWS_ACCESS_KEY_ID = process.env.FIBERBROWSER_TEST_S3_ACCESS_KEY || 'minioadmin';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.FIBERBROWSER_TEST_S3_SECRET_KEY || 'minioadmin';
  process.env.AWS_CONFIG_FILE = path.join(scratch, 'no-aws-config');
  process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(scratch, 'no-aws-credentials');
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  delete process.env.AWS_PROFILE;
}

test.describe('s3:// against a local S3-compatible server', () => {
  test.skip(!ENDPOINT, 'set FIBERBROWSER_TEST_S3_ENDPOINT (e.g. a local MinIO) to run');
  test.use({ fixtureBam: 'demo' });

  test.beforeAll(() => {
    const out = execFileSync(PYTHON, [path.join(REPO_ROOT, 'tests', 's3_minio.py'), 'stage'], { encoding: 'utf8' });
    staged = JSON.parse(out.trim().split('\n').pop()!);
  });

  test.afterAll(() => {
    if (staged) execFileSync(PYTHON, [path.join(REPO_ROOT, 'tests', 's3_minio.py'), 'cleanup', staged.run]);
  });

  async function open(page: Page, url: string) {
    await page.addInitScript(() => {
      (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(url);
    await page.waitForLoadState('networkidle');
  }

  async function openRemoteUrlForm(page: Page) {
    await page.getByTestId('settings-rail-file').click();
    await page.getByTestId('settings-search-input').fill('endpoint');
    const anchor = page.getByTestId('settings-sidebar').locator('[data-setting-id="file.remote-url"]');
    await expect(anchor).toBeVisible();
    await anchor.getByRole('button', { name: /Load from URL/ }).click();
    return anchor;
  }

  test('Load Remote URL with an endpoint opens a private s3:// BAM', async ({ server, page }) => {
    await open(page, server.baseUrl);
    const form = await openRemoteUrlForm(page);
    await form.getByPlaceholder('s3://bucket/file.bam or https://host/path/file.bam').fill(staged!.bam);
    await form.getByTestId('remote-url-s3-endpoint').fill(staged!.endpoint);
    if (SHOTS) await form.screenshot({ path: path.join(SHOTS, 's3_load_remote_url.png') });
    const added = page.waitForResponse(r => r.url().includes('/api/datasets/add') && r.request().method() === 'POST');
    await form.getByRole('button', { name: 'Load', exact: true }).click();
    const body = await (await added).json();
    expect(body.success, JSON.stringify(body)).toBe(true);
    expect(body.dataset.path).toBe(staged!.bam);

    const [chrom, start, end] = staged!.region;
    const reads = await (await page.request.get(`${server.baseUrl}/api/reads/compact`, {
      params: { dataset_id: body.dataset.id, chrom, start, end },
    })).json();
    expect(reads.total).toBe(staged!.reads);
    await expect(page.getByTestId('remote-url-s3-status')).toContainText(new URL(staged!.endpoint).host);
  });

  test('a missing s3:// object is named in the error banner', async ({ server, page }) => {
    await open(page, server.baseUrl);
    const form = await openRemoteUrlForm(page);
    await form.getByPlaceholder('s3://bucket/file.bam or https://host/path/file.bam').fill(staged!.missing_bam);
    await form.getByTestId('remote-url-s3-endpoint').fill(staged!.endpoint);
    await form.getByRole('button', { name: 'Load', exact: true }).click();
    await expect(page.getByText(/Object not found: s3:\/\/.*missing\.bam/).first()).toBeVisible();
    const datasets = await (await page.request.get(`${server.baseUrl}/api/datasets`)).json();
    expect(datasets.datasets.map((d: any) => d.path)).not.toContain(staged!.missing_bam);
  });

  test('a catalog of s3:// datasets lists, opens, and names broken files', async ({ page }) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-s3-catalog-'));
    const catalog = path.join(dir, 'catalog.json');
    writeFileSync(catalog, JSON.stringify({
      name: 'Lab bucket',
      s3: { endpoint_url: staged!.endpoint },
      groups: [
        { name: 'Private runs', datasets: [{ url: staged!.bam, label: 'NAPA private' }] },
        { name: 'Broken entries', datasets: [
          { url: staged!.noidx_bam, label: 'No index' },
          { url: staged!.missing_bam, label: 'Gone' },
        ] },
      ],
    }));
    const port = await pickRandomPort();
    let proc: ServerProcess | null = null;
    try {
      proc = await startServer(DEMO_FIXTURE.bamPath, port, { extraArgs: ['--catalog', catalog] });
      const base = proc.baseUrl;
      await open(page, base);
      await page.getByTestId('settings-rail-file').click();
      const sidebar = page.getByTestId('settings-sidebar');
      const groupRow = (name: string) => sidebar.locator('div', { has: page.getByTitle(name, { exact: true }) })
        .filter({ has: page.locator('input[type="checkbox"]') }).last();
      await expect(sidebar.getByTitle('Private runs', { exact: true })).toBeVisible();

      const loaded = page.waitForResponse(r => r.url().includes('/api/catalog/load'));
      await groupRow('Private runs').locator('input[type="checkbox"]').click();  // controlled: ticks once loaded
      expect((await (await loaded).json()).success).toBe(true);
      const [chrom, start, end] = staged!.region;
      const reads = await (await page.request.get(`${base}/api/reads/compact`, {
        params: { dataset_id: 'catalog_0_0', chrom, start, end },
      })).json();
      expect(reads.total).toBe(staged!.reads);

      const broken = page.waitForResponse(r => r.url().includes('/api/catalog/load'));
      await groupRow('Broken entries').locator('input[type="checkbox"]').click();
      expect((await (await broken).json()).success).toBe(false);
      await expect(page.getByText(/No index: s3:\/\/.*No BAM index/).first()).toBeVisible();
      await expect(page.getByText(/Gone: s3:\/\/.*Object not found/).first()).toBeVisible();
    } finally {
      proc?.kill('SIGTERM');
    }
  });
});
