/**
 * Opening files (fb-n2-files, release audit P9).
 *
 * - M21: Load by path of a Dropbox online-only BAM (a zero-length placeholder
 *   with the com.dropbox.placeholder attribute) opened an empty dataset with no
 *   message. Now it is refused, saying to make it available offline.
 * - L11: a BED for another assembly than the main genome opens with a warning
 *   that names its chromosomes (tracks are drawn in the main view only).
 * - L12: a window opened after a dataset was given its own reference starts
 *   that panel at the dataset's reads, not at the first chromosome's 0-10,000.
 *
 * The placeholder is simulated in a temp folder (never a real cloud file).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { DEMO_FIXTURE, blockNativeDialogs, expect, test, type ServerFixture } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;
const opened = (page: Page) => store(page, s => s.datasets.map((d: any) => d.id).sort());
const errorText = (page: Page) => store(page, s => s.error as string | null);

async function boot(page: Page, server: ServerFixture) {
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
  });
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => !!(window as any).__FIBERBROWSER_STORE__);
  await page.waitForLoadState('networkidle');
}

async function loadByPath(page: Page, value: string) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: 'file', subsectionId: 'file.loadpath' },
  })));
  const input = page.getByTestId('load-by-path-input');
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press('Enter');
}

test('Load by path: an online-only BAM is refused with "make it available offline" (M21)', async ({ server, page }) => {
  test.skip(process.platform !== 'darwin' || !existsSync('/usr/bin/xattr'), 'Dropbox placeholders are a macOS attribute');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-cloud-'));
  const bam = path.join(dir, 'sample_c.bam');
  for (const file of [bam, `${bam}.bai`]) {
    writeFileSync(file, '');
    execFileSync('/usr/bin/xattr', ['-w', 'com.dropbox.placeholder', '1', file]);
  }
  await boot(page, server);
  await loadByPath(page, bam);
  await expect.poll(() => errorText(page), { timeout: 30_000 }).toBe(
    'sample_c.bam is in the cloud and not downloaded: make it available offline in Dropbox/iCloud, then reopen it.');
  await expect(page.getByText(/is in the cloud and not downloaded/)).toBeVisible();
  expect(await opened(page)).toEqual(['napa_ddda']);
});

test('Load by path: a fly BED on the human data opens with a warning naming its chromosomes (L11)', async ({ server, page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fiberbrowser-e2e-bed-'));
  const bed = path.join(dir, 'fly_enhancers.bed');
  writeFileSync(bed, 'track name=fly\nchr2L\t100\t900\te1\nchr3R\t5000\t6000\te2\nchr2R\t7000\t7500\te3\nchr3R\t9000\t9100\te4\n');
  await boot(page, server);
  await loadByPath(page, bed);
  await expect.poll(() => errorText(page), { timeout: 30_000 })
    .toMatch(/^fly_enhancers\.bed: its chromosomes \(chr3R, chr2L, chr2R\) are not on .+, the main genome, so it shows nothing there/);
  // Added all the same (switching the main genome shows it).
  expect(await store(page, s => s.catalog.some((e: any) => String(e.path ?? '').endsWith('fly_enhancers.bed')))).toBe(true);

  // A BED on the human data: no warning.
  await store(page, s => s.setError(null));
  const human = path.join(dir, 'human.bed');
  writeFileSync(human, `${DEMO_FIXTURE.region.chrom}\t${DEMO_FIXTURE.region.start}\t${DEMO_FIXTURE.region.start + 500}\tpeak\n`);
  await loadByPath(page, human);
  await page.waitForLoadState('networkidle');
  expect(await errorText(page)).toBeNull();
});

test('a later window opens a panel with its own reference at its reads (L12)', async ({ server, page, browser }) => {
  // The demo dataset gets its own reference (its BAM header's contigs: chr1 first).
  const attach = await page.request.post(`${server.baseUrl}/api/panel_genomes/attach`, {
    data: { dataset_ids: ['napa_ddda'], contigs: true, span: 2_000 },
  });
  const body = await attach.json();
  expect(body.success).toBe(true);
  const reads = body.loci.napa_ddda;
  expect(reads.chrom).toBe(DEMO_FIXTURE.region.chrom);

  // A fresh profile: nothing saved in the browser.
  const fresh = await browser.newContext();
  await blockNativeDialogs(fresh);
  const later = await fresh.newPage();
  await boot(later, server);
  const key = body.genome.key;
  await expect.poll(() => store(later, s => s.panels.find((p: any) => p.datasetId === 'napa_ddda')?.genome ?? null),
    { timeout: 30_000 }).toBe(key);
  const view = await store(later, s => s.panels.find((p: any) => p.datasetId === 'napa_ddda')?.viewportOverride ?? null);
  expect(view).toEqual(reads);  // not chr1:0-10,000
  await expect.poll(() => later.locator('[data-read-track-dataset-id="napa_ddda"]').first()
    .getAttribute('data-read-track-render-count').then(v => Number(v ?? 0)), { timeout: 45_000 }).toBeGreaterThan(0);
  await fresh.close();
});
