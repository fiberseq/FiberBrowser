/**
 * Export data… (the toolbar's file button beside Export figure, Cmd/Ctrl+Shift+E):
 * every data export in one dialog. The reads table and a BAM subset of the
 * chosen reads download from it on a real server.
 */
import fs from 'node:fs/promises';
import { test, expect, DEMO_FIXTURE } from './fixtures/server';

test.use({ fixtureBam: 'demo' });

const REGION = DEMO_FIXTURE.region;

async function openWithReads(page: any, server: any) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
  });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  await page.evaluate((r: typeof REGION) => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start + 1500, r.start + 2500), REGION);
  await expect.poll(() => page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return Object.values(s.activeReadIds as Record<string, string[]>).reduce((n, ids) => n + ids.length, 0);
  }), { timeout: 30_000 }).toBeGreaterThan(5);
}

test('Export data: the reads table and a BAM subset download; disabled entries say why', async ({ server, page }, info) => {
  await openWithReads(page, server);

  // The keyboard opens it too, and Escape closes it.
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect(page.getByTestId('export-data-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-data-dialog')).toHaveCount(0);
  // From Export figure, the shortcut swaps to Export data (never two dialogs, so Escape works).
  await page.getByTestId('export-screenshot-button').click();
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect(page.locator('[data-export-modal]')).toHaveCount(0);
  await expect(page.getByTestId('export-data-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-data-dialog')).toHaveCount(0);

  await page.getByTestId('export-data-button').click();
  const dialog = page.getByTestId('export-data-dialog');
  await expect(dialog).toBeVisible();
  for (const group of ['reads', 'peaks', 'classes', 'clusters', 'analysis', 'session']) {
    await expect(dialog.getByTestId(`export-group-${group}`)).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('export-data-dialog.png') });
  // Nothing is clustered yet: the assignments entry is off and says why.
  await expect(dialog.getByTestId('export-entry-cluster-assignments-button')).toBeDisabled();
  await expect(dialog.getByTestId('export-entry-cluster-assignments-reason')).toContainText('Cluster reads first');

  // The reads shown: a TSV with per-read statistics and the cluster column.
  await dialog.getByTestId('export-read-scope').selectOption('shown');
  const shown = await page.evaluate(() => {
    const s = (window as any).__FIBERBROWSER_STORE__.getState();
    return [...new Set(Object.values(s.activeReadIds as Record<string, string[]>).flat())];
  });
  const tableDownload = page.waitForEvent('download');
  await dialog.getByTestId('export-entry-read-table-button').click();
  const table = await tableDownload;
  expect(table.suggestedFilename()).toMatch(/^reads_shown_chr19_.*\.tsv$/);
  const tablePath = info.outputPath('reads.tsv');
  await table.saveAs(tablePath);
  const lines = (await fs.readFile(tablePath, 'utf8')).trim().split('\n').map(l => l.split('\t'));
  expect(lines[0].slice(0, 6)).toEqual(['read_id', 'dataset_id', 'reference', 'chrom', 'cluster', 'aligned_span']);
  expect(lines.length - 1).toBe(Math.min(shown.length, 5000));
  expect(new Set(lines.slice(1).map(l => l[0]))).toEqual(new Set(shown.slice(0, 5000)));
  await expect(dialog.getByTestId('export-entry-read-table')).toContainText(`Saved ${(lines.length - 1).toLocaleString()} reads`);

  // Three selected reads: their names and a BAM of them.
  const picked = shown.slice(0, 3);
  await page.evaluate((ids: string[]) => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const sk = Object.keys(store.getState().activeReadIds)[0];
    store.setState({ selectedReadIds: { [sk]: new Set(ids) } });
  }, picked);
  await dialog.getByTestId('export-read-scope').selectOption('selection');
  await expect(dialog.getByTestId('export-entry-read-names-detail')).toHaveText('3 reads');
  const namesDownload = page.waitForEvent('download');
  await dialog.getByTestId('export-entry-read-names-button').click();
  const namesPath = info.outputPath('names.txt');
  await (await namesDownload).saveAs(namesPath);
  expect((await fs.readFile(namesPath, 'utf8')).trim().split('\n')).toEqual(picked);

  const bamDownload = page.waitForEvent('download');
  await dialog.getByTestId('export-entry-read-bam-button').click();
  const bam = await bamDownload;
  expect(bam.suggestedFilename()).toMatch(/_3reads\.bam$/);
  const bamPath = info.outputPath('subset.bam');
  await bam.saveAs(bamPath);
  const bytes = await fs.readFile(bamPath);
  expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);  // BGZF
  await expect(dialog.getByTestId('export-entry-read-bam')).toContainText('Saved 1 BAM');
});

test('the Export dialog Data tab shows the same list', async ({ server, page }) => {
  await openWithReads(page, server);
  await page.getByTestId('export-screenshot-button').click();
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect(page.locator('[data-export-modal]').getByTestId('export-data-list')).toBeVisible();
  await expect(page.locator('[data-export-modal]').getByTestId('export-entry-read-table')).toBeVisible();
});
