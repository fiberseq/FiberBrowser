/**
 * QC-fail reads (SAM 0x200), including FiberHMM DAF strand-swap chimeras (xc:Z:strand_swap), are hidden by default
 * like duplicates (FiberBrowser 3.0.2). The panel header counts them, chimeras separately; the toolbar Quality
 * group's "Show QC-fail reads (incl. FiberHMM chimeras)" brings them back, marked in the reads' payload.
 *
 * Data: a copy of the tracked NAPA demo BAM with every fifth read in the demo region flagged QC-fail, half of
 * those as chimeras (written once per run by pysam into the test TMPDIR).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, DEMO_FIXTURE } from './fixtures/server';
import { PYTHON } from './fixtures/syntheticData';
import type { Page } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_BAM = path.resolve(__dirname, '../../../data/demo/napa_ddda.bam');
const REGION = DEMO_FIXTURE.region;
const OUT_DIR = path.join(os.tmpdir(), 'fb-e2e-chimera-quality');
const QC_BAM = path.join(OUT_DIR, 'napa_qcfail.bam');

const SCRIPT = `
import sys, pysam
src, out, chrom, start, end = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
names = []
with pysam.AlignmentFile(src) as bam:
    for r in bam.fetch(chrom, start, end):
        if not (r.is_secondary or r.is_supplementary or r.is_unmapped) and r.query_name not in names:
            names.append(r.query_name)
flagged = {n: i for i, n in enumerate(names[::5])}
with pysam.AlignmentFile(src) as bam, pysam.AlignmentFile(out, 'wb', template=bam) as dst:
    for r in bam.fetch(until_eof=True):
        if r.query_name in flagged:
            r.flag |= 0x200
            if flagged[r.query_name] % 2 == 0:
                r.set_tag('xc', 'strand_swap', 'Z')
        dst.write(r)
pysam.index(out)
print(len(flagged), sum(1 for i in flagged.values() if i % 2 == 0))
`;

function writeBam(): { qcfail: number; chimeras: number } | string {
  mkdirSync(OUT_DIR, { recursive: true });
  const run = spawnSync(PYTHON, ['-c', SCRIPT, DEMO_BAM, QC_BAM, REGION.chrom, String(REGION.start), String(REGION.end)], { encoding: 'utf-8' });
  if (run.status !== 0 || !existsSync(`${QC_BAM}.bai`)) return `could not write the QC-fail BAM: ${(run.stderr || run.error?.message || '').trim()}`;
  const [qcfail, chimeras] = run.stdout.trim().split(/\s+/).map(Number);
  return { qcfail, chimeras };
}

const written = writeBam();
if (typeof written === 'string') throw new Error(written);

test.use({ fixtureBam: QC_BAM });

async function openRegion(page: Page, baseUrl: string) {
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
}

const readsResponse = (page: Page, qcfail: boolean) => page.waitForResponse(res => {
  const url = res.url();
  return url.includes('/api/reads/compact') && url.includes(`include_qcfail=true`) === qcfail;
}, { timeout: 90_000 });

test('QC-fail reads are hidden by default, counted (chimeras separately) and shown again from the toolbar', async ({ server, page }) => {
  test.setTimeout(180_000);
  const { qcfail, chimeras } = written as { qcfail: number; chimeras: number };
  expect(qcfail).toBeGreaterThan(1);
  expect(chimeras).toBeGreaterThan(0);

  await openRegion(page, server.baseUrl);
  const hiddenLoad = readsResponse(page, false);
  await page.evaluate((r: typeof REGION) => {
    (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end);
  }, REGION);
  const hidden = await (await hiddenLoad).json();
  expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().showQcFailReads)).toBe(false);
  const hiddenReads = (hidden.reads ?? []) as Array<{ qcfail?: boolean }>;
  expect(hiddenReads.some(r => r.qcfail)).toBe(false);
  expect(hidden.signal_counts).toMatchObject({ qcfail_hidden: qcfail, chimera_hidden: chimeras });

  // The panel header counts what the policy hides, chimeras on their own.
  const status = page.getByTestId('panel-read-status').first();
  await expect(status).toContainText(`${qcfail} QC-fail reads hidden`, { timeout: 30_000 });
  await expect(status).toContainText(`${chimeras} chimeric reads hidden`);

  // Toolbar Quality group: show them again.
  const toolbar = page.getByTestId('quality-controls-toolbar');
  if (!(await toolbar.isVisible())) await page.getByTestId('toolbar-group-toggle-quality').click();
  await expect(toolbar).toBeVisible();
  const toggle = toolbar.locator('label', { hasText: 'Show QC-fail reads (incl. FiberHMM chimeras)' }).locator('input[type="checkbox"]');
  await expect(toggle).not.toBeChecked();
  const shownLoad = readsResponse(page, true);
  await toggle.check();
  const shown = await (await shownLoad).json();
  const shownReads = (shown.reads ?? []) as Array<{ qcfail?: boolean; chimera?: string }>;
  // The display load may be sampled: the flagged reads are back, marked, and nothing is hidden by the policy.
  expect(shownReads.filter(r => r.qcfail).length).toBeGreaterThan(0);
  expect(shownReads.filter(r => r.chimera === 'strand_swap').length).toBeGreaterThan(0);
  expect(shownReads.filter(r => r.chimera === 'strand_swap').every(r => r.qcfail)).toBe(true);
  expect(shown.signal_counts?.qcfail_hidden ?? 0).toBe(0);
  expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().showQcFailReads)).toBe(true);
  await expect(status).not.toContainText('QC-fail reads hidden', { timeout: 30_000 });

  // Off again: hidden again.
  const againLoad = readsResponse(page, false);
  await toggle.uncheck();
  const again = await (await againLoad).json();
  expect(((again.reads ?? []) as Array<{ qcfail?: boolean }>).some(r => r.qcfail)).toBe(false);
});
