/**
 * The Variants panel on an explicitly synthetic Fiber-seq BAM (tests/snp_fixtures.py: two SNPs, three allele
 * combinations: 14 reads reference at both, 10 alternate at both, 8 alternate at the first only; 3 reads cover the
 * first SNP only), generated per test into a temp dir. Finds the SNPs, lists the three combinations, splits the
 * reads into three panels by combination, and is warned (and asked) when the split opens more panels than allowed.
 */
import { test, expect, panelButton } from './fixtures/server';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.FIBERBROWSER_TEST_DIR
  ? path.resolve(process.env.FIBERBROWSER_TEST_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VIEW = { chrom: 'chrSNP', start: 7_000, end: 11_000 };

test.use({
  fixtureBam: async ({}, use) => {
    const bam = path.join(mkdtempSync(path.join(tmpdir(), 'fiberbrowser-snp-')), 'snp_demo.bam');
    execFileSync(process.env.FIBERBROWSER_TEST_PYTHON?.trim() || 'python',
      [path.join(REPO_ROOT, 'tests', 'make_snp_demo_bam.py'), bam], { stdio: 'inherit' });
    await use(bam);
  },
});

test('Variants: two SNPs, three combinations, split into three panels, a warning past the limit', async ({ page, server }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(`${server.baseUrl}/?chr=${VIEW.chrom}&start=${VIEW.start}&end=${VIEW.end}`);
  await expect(page.locator('canvas[data-copilot-track="reads"]')).toHaveCount(1, { timeout: 30_000 });

  // The rail tile is Variants now (the Insertions tile's place).
  const scan = page.waitForResponse(r => r.url().endsWith('/api/variants/snps') && r.request().method() === 'POST');
  await panelButton(page, 'variants').click();
  const panel = page.getByTestId('variants-panel');
  await expect(panel).toBeVisible();
  const scanJson = await (await scan).json();
  expect(scanJson.snps.map((s: any) => [s.pos, s.depth, s.minor])).toEqual([[8_000, 35, 17], [9_000, 32, 10]]);
  const rows = page.getByTestId('variants-row');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('variants-summary')).toContainText('2 SNPs');

  // The SNP channel above the reads marks both.
  await expect(page.getByTestId('snp-channel-snp')).toHaveCount(2);

  // Select both (click, shift-click), then their combinations.
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('variants-selected')).toHaveText('2 selected');
  await expect(page.locator('[data-testid="snp-channel-snp"][data-selected="true"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Combinations', exact: true }).last().click();
  const combos = page.locator('[data-testid="variants-combo"][data-kind="combo"]');
  await expect(combos).toHaveCount(3, { timeout: 30_000 });
  expect(await combos.evaluateAll(els => els.map(e => Number((e as HTMLElement).dataset.count)))).toEqual([14, 10, 8]);
  await expect(page.getByTestId('variants-phase')).toContainText('Not a two-haplotype pattern');

  // Split into panels: three, ticked; the count says so.
  await page.getByTestId('variants-combos-split').click();
  const dialog = page.getByTestId('variant-split-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('variant-split-row')).toHaveCount(4);   // 3 combinations + not informative
  await expect(page.getByTestId('variant-split-count')).toContainText('Opens 3 panels');

  // Past the limit (ask before more than 2): a warning, and nothing opens until it is confirmed.
  await page.getByTestId('variant-split-soft-limit').fill('2');
  await expect(page.getByTestId('variant-split-count')).toHaveAttribute('data-verdict', 'confirm');
  await expect(page.getByTestId('variant-split-count')).toContainText('This opens 3 panels (more than 2)');
  await page.getByTestId('variant-split-open').click();
  await expect(page.getByTestId('variant-split-confirm')).toContainText('Open 3 panels?');
  expect(await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels.filter((p: any) => p.readSubset).length)).toBe(0);
  await page.getByTestId('variant-split-open').click();
  await expect(dialog).toHaveCount(0);

  const split = await page.evaluate(() => (window as any).__FIBERBROWSER_STORE__.getState().panels
    .filter((p: any) => p.readSubset).map((p: any) => [p.readSubset.count, p.readSubset.rule.kind]));
  expect(split).toEqual([[14, 'frozen'], [10, 'frozen'], [8, 'frozen']]);
  await expect(page.locator('canvas[data-copilot-track="reads"]')).toHaveCount(3, { timeout: 30_000 });
  expect(errors).toEqual([]);
});
