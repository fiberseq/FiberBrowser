/**
 * The command palette with panels on two assemblies (fb-n3-search, audit M7):
 * the hg38 demo and a dm6 BAM opened with dm6 in its own panel, which turns
 * on "Each panel navigates". Cmd/Ctrl+K then finds dm6 genes (labelled by
 * reference, under dm6's own contig names) and coordinates on dm6, and goes
 * there in the dm6 panel; an hg38 gene goes to the hg38 panel; analyses are
 * found by name ("proj").
 *
 * Needs a dm6 DddB amplicon BAM (FIBERBROWSER_TEST_DM6_BAM)
 * and dm6 and hg38 in ~/.fiberhmm/genomes (never downloaded here).
 */
import { test, expect } from './fixtures/server';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

test.use({ fixtureBam: 'demo' });

const DM6_BAM = process.env.FIBERBROWSER_TEST_DM6_BAM?.trim() || '';
const DM6_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'dm6.fa.fai'));
const HG38_CACHED = existsSync(path.join(homedir(), '.fiberhmm', 'genomes', 'hg38.fa.fai'));

const store = <T,>(page: Page, fn: (s: any) => T) =>
  page.evaluate(f => new Function('s', `return (${f})(s)`)((window as any).__FIBERBROWSER_STORE__.getState()), fn.toString()) as Promise<T>;

const panelOf = (page: Page, datasetId: string) =>
  store(page, s => s.panels.filter((p: any) => p.contentType === 'dataset' && !p.collapsed)
    .map((p: any) => ({ id: p.id, datasetId: p.datasetId, genome: p.genome ?? null, v: p.viewportOverride ?? null })))
    .then(list => list.find(p => p.datasetId === datasetId)!);

const palette = (page: Page) => page.getByTestId('command-palette');
const paletteInput = (page: Page) => page.getByTestId('command-palette-input');
const firstOption = (page: Page) => palette(page).locator('[role="option"]').first();

async function ask(page: Page, text: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await paletteInput(page).fill(text);
}

test('Cmd/Ctrl+K in Per panel mode goes to dm6 genes and coordinates in the dm6 panel', async ({ page, server }) => {
  test.skip(!DM6_BAM || !existsSync(DM6_BAM), 'needs a dm6 BAM (FIBERBROWSER_TEST_DM6_BAM)');
  test.skip(!DM6_CACHED, 'needs dm6 in ~/.fiberhmm/genomes (not downloaded by tests)');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  const status = await (await page.request.get(`${server.baseUrl}/api/status`)).json();
  if (status.current_genome !== 'hg38') {
    test.skip(!HG38_CACHED, 'needs hg38 in ~/.fiberhmm/genomes (not downloaded by tests)');
    expect((await (await page.request.post(`${server.baseUrl}/api/load_genome?genome_id=hg38`)).json()).success).toBe(true);
  }
  const added = await page.request.post(`${server.baseUrl}/api/datasets/add`, { data: { path: DM6_BAM } });
  const fly = (await added.json()).dataset.id as string;
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(server.baseUrl);
  await page.waitForLoadState('networkidle');
  const human = (await store(page, s => s.datasets.map((d: any) => d.id))).find((id: string) => id !== fly) as string;

  // dm6 in its own panel: Per panel navigation turns on.
  await page.getByTestId('genome-mismatch-own-genome').click();
  await expect(page.getByTestId('genome-mismatch-banner')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('panel-genome-chip')).toHaveText('dm6');
  await expect.poll(() => store(page, s => s.navigationMode)).toBe('perPanel');

  // A dm6 gene: offered first, labelled by its reference, under dm6's contig name; Enter goes there in the dm6 panel.
  await ask(page, 'eve');
  await expect(firstOption(page)).toContainText('Go to eve (dm6)', { timeout: 30_000 });
  await expect(firstOption(page)).toContainText('chr2R:');
  await expect(firstOption(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(palette(page)).not.toContainText('Each panel navigates');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect.poll(async () => (await panelOf(page, fly)).v?.chrom, { timeout: 30_000 }).toBe('chr2R');

  // dm6 coordinates: one runnable answer, for the dm6 panel.
  await ask(page, 'chr2R:9974000-9984000');
  await expect(firstOption(page)).toContainText('(dm6)');
  await expect(palette(page).locator('[role="option"][data-palette-kind="goto"]')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await panelOf(page, fly)).v).toEqual({ chrom: 'chr2R', start: 9_974_000, end: 9_984_000 });

  // An hg38 gene goes to the hg38 panel (moved away first); the dm6 panel stays.
  const humanBar = page.getByTestId('panel-site-bar').filter({ hasNot: page.getByTestId('panel-genome-chip') });
  await humanBar.getByTestId('panel-location-input').fill('chr19:1000000-1001000');
  await humanBar.getByTestId('panel-location-submit').click();
  await expect.poll(async () => (await panelOf(page, human)).v).toEqual({ chrom: 'chr19', start: 1_000_000, end: 1_001_000 });
  // The demo's amplicon is a saved region named NAPA too (fb-n2-regions): the gene named exactly
  // so (900) is offered first, above the region named exactly so (700), which is offered as well.
  // The region (a local suggestion) is listed at once and the gene once the server answers: wait
  // for the gene before reading its span (the region's would be read, and run, otherwise).
  await ask(page, 'NAPA');
  await expect(firstOption(page)).toHaveAttribute('data-palette-item', /^goto:gene:.*\|NAPA$/, { timeout: 30_000 });
  await expect(firstOption(page)).toContainText('Go to NAPA (hg38)');
  const napaRegion = palette(page).locator('[role="option"][data-palette-item*="|region:hg38:"]');
  await expect(napaRegion).toHaveCount(1);
  await expect(napaRegion).toContainText('Go to NAPA (hg38)');
  await expect(napaRegion).toContainText('chr19:47,514,487-47,518,985');
  const napa = (await firstOption(page).textContent())!.match(/chr19:([\d,]+)-([\d,]+)/)!;
  // The gene's span, not the amplicon's.
  expect(napa[0]).not.toBe('chr19:47,514,487-47,518,985');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  // Enter pressed at once, before the gene lookup answers (only the region listed yet): it waits
  // for the gene that outranks the region and goes there, as the locus box does.
  await ask(page, 'NAPA');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await panelOf(page, human)).v, { timeout: 30_000 }).toEqual({
    chrom: 'chr19', start: Number(napa[1].replace(/,/g, '')), end: Number(napa[2].replace(/,/g, '')),
  });
  expect((await panelOf(page, fly)).v).toEqual({ chrom: 'chr2R', start: 9_974_000, end: 9_984_000 });

  // Analyses by name: "proj" finds the projection (grayed out with why until reads are clustered).
  await ask(page, 'proj');
  const projection = palette(page).locator('[role="option"][data-palette-item="cmd:open-projection"]');
  await expect(projection).toBeVisible();
  await expect(projection).toContainText('Cluster reads first');
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
});
