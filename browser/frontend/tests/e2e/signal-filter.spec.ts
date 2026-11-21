/** Real indexed inputs are supplied as scratch symlinks in FIBERBROWSER_SIGNAL_DATA. */
import { test as base, expect } from './fixtures/nativeDialogs';
import { pickRandomPort, startServer } from './fixtures/server';
import path from 'node:path';

const folder = process.env.FIBERBROWSER_SIGNAL_DATA;
const region = { chrom: 'chr2L', start: 6358000, end: 6359000 };

const test = base.extend<{ signalServer: string }>({
  signalServer: async ({}, use) => {
    if (!folder) { await use(''); return; }
    const port = await pickRandomPort();
    const process = await startServer(path.join(folder, '1x_brain.fiberhmm.dddb.bam'), port);
    try { await use(process.baseUrl); }
    finally {
      if (process.exitCode === null) {
        process.kill('SIGTERM');
        await new Promise<void>(resolve => process.once('exit', () => resolve()));
      }
    }
  },
});

test('signal gates on a tagged BAM and an older BAM preserve the view and counts', async ({ page, signalServer }, info) => {
  test.skip(!folder, 'Set FIBERBROWSER_SIGNAL_DATA to scratch symlinks of the tagged and older BAMs');
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1450, height: 960 });
  await page.addInitScript(() => {
    (window as any).__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    (window as any).__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
  });
  await page.goto(`${signalServer}/?chrom=${region.chrom}&start=${region.start}&end=${region.end}`);
  await page.waitForFunction(() => (window as any).__FIBERBROWSER_STORE__?.getState().datasets.length > 0);
  const dataset = await page.evaluate(r => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    const id = store.getState().datasets[0].id;
    store.setState({ minFootprints: 0, minFootprintsAuto: false, spanningOnly: false,
      hideTerminalGaps: false, terminalGapThreshold: 0, readDisplayMode: 'all', allReadsDisplayCap: 50000,
      loadAllReads: { [id]: true } });
    store.getState().setViewport(r.chrom, r.start, r.end);
    window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'view', subsectionId: 'view.advanced' },
    }));
    return id;
  }, region);
  const summary = () => page.evaluate(id => {
    const state = (window as any).__FIBERBROWSER_STORE__.getState();
    return (Object.values(state.signalCounts) as any[]).find(s => s.datasetId === id)?.counts;
  }, dataset);
  await expect.poll(async () => (await summary())?.total ?? 0).toBeGreaterThan(0);
  const originalCounts = await summary();
  expect(originalCounts.background).toBeGreaterThan(0);
  const background = page.getByTestId('signal-hide-background-input');
  await expect(background).not.toBeChecked();
  const structure = page.getByTestId('signal-require-structure-input');
  if (originalCounts.structure_scored === 0) {
    await expect(structure).toBeDisabled();
    await expect(page.getByTestId('signal-filters')).toContainText('Unavailable: structure is unscored');
  } else {
    await expect(structure).toBeEnabled();
  }
  const visible = () => page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().activeReadIds[id] ?? [], dataset);
  await expect.poll(async () => (await visible()).length).toBeGreaterThan(0);
  const originalIds = await visible();
  const params = new URLSearchParams({ ...Object.fromEntries(Object.entries(region).map(([k, v]) => [k, String(v)])),
    dataset_id: dataset, max_reads: '0', min_footprints: '0', hide_terminal_gaps: 'false', terminal_gap_threshold: '0',
    sample_seed: 'signal-e2e', include_layers: 'true' });
  const fetchReads = async (filters = {}) => {
    const query = new URLSearchParams(params); query.set('signal_filters', JSON.stringify(filters));
    const response = await page.request.get(`${signalServer}/api/reads/compact?${query}`);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const before = await fetchReads();
  await background.check();
  await expect.poll(async () => (await summary())?.hidden).toBe(originalCounts.background);
  const after = await fetchReads({ hideBackground: true });
  expect(after.reads).toEqual(before.reads.filter((r: any) => r.signal?.status !== 'background'));
  expect(after.signal_counts.kept + after.signal_counts.hidden).toBe(after.signal_counts.total);
  expect(after.reads.some((r: any) => r.signal?.status === 'unclassified')).toBe(true);
  await expect(page.getByTestId('signal-filter-counts').first()).toContainText(`${originalCounts.background} hidden`);
  await page.screenshot({ path: info.outputPath('signal-filters.png') });
  await background.uncheck();
  await expect.poll(async () => (await summary())?.hidden).toBe(0);
  expect((await fetchReads()).reads).toEqual(before.reads);
  await expect.poll(visible).toEqual(originalIds);

  await page.getByTestId('signal-require-detectable-input').check();
  await expect.poll(async () => (await summary())?.kept).toBe(originalCounts.detectable);
  const strict = await fetchReads({ requireDetectable: true, requireStructure: true });
  expect(strict.reads).toEqual(before.reads.filter((r: any) =>
    r.signal?.status === 'detectable' && r.signal.structure.status === 'supported'));
  if (originalCounts.structure_scored > 0) {
    await structure.check();
    await expect.poll(async () => (await summary())?.hidden).toBe(strict.signal_counts.hidden);
    await structure.uncheck();
  }
  await page.getByTestId('signal-require-detectable-input').uncheck();
  await page.getByTestId('signal-exclude-unscored-input').check();
  await expect.poll(async () => (await summary())?.kept)
    .toBe(originalCounts.total - originalCounts.unscored - originalCounts.unknown);
  await page.getByTestId('signal-exclude-unscored-input').uncheck();

  // Locus changes use new counts and return to the same stable view.
  await page.evaluate(r => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, 2126, 3500), region);
  await expect.poll(async () => (await summary())?.unscored ?? 0).toBeGreaterThan(0);
  await page.evaluate(r => (window as any).__FIBERBROWSER_STORE__.getState().setViewport(r.chrom, r.start, r.end), region);
  await expect.poll(visible).toEqual(originalIds);

  const opened = await page.request.post(`${signalServer}/api/datasets/add`, { data: { path: path.join(folder!, 'older.bam'), label: 'Older input' } });
  expect(opened.ok()).toBe(true);
  const older = (await opened.json()).dataset;
  expect(older?.id).toBeTruthy();
  params.set('dataset_id', older.id);
  const untagged = await fetchReads();
  expect(untagged.reads.length).toBeGreaterThan(0);
  const untaggedFiltered = await fetchReads({ hideBackground: true });
  expect(untaggedFiltered.reads).toEqual(untagged.reads);
  expect(untaggedFiltered.signal_counts.hidden).toBe(0);
  // Open the untagged input as the visible track too: unavailable structure
  // stays disabled, and the default filter leaves its rendered cohort intact.
  await page.evaluate(({ older, dataset }) => {
    const store = (window as any).__FIBERBROWSER_STORE__;
    store.getState().addDataset(older);
    store.getState().removeDataset(dataset);
    store.setState({ loadAllReads: { [older.id]: true } });
  }, { older, dataset });
  const olderCounts = () => page.evaluate(id => {
    const state = (window as any).__FIBERBROWSER_STORE__.getState();
    return (Object.values(state.signalCounts) as any[]).find(s => s.datasetId === id)?.counts;
  }, older.id);
  await expect.poll(async () => (await olderCounts())?.total ?? 0).toBeGreaterThan(0);
  await expect(structure).toBeDisabled();
  await expect(page.getByTestId('signal-filters')).toContainText('Unavailable: structure is unscored');
  const olderVisible = () => page.evaluate(id => (window as any).__FIBERBROWSER_STORE__.getState().activeReadIds[id] ?? [], older.id);
  await expect.poll(async () => (await olderVisible()).length).toBeGreaterThan(0);
  const olderIds = await olderVisible();
  await background.check();
  await expect.poll(async () => (await olderCounts())?.hidden).toBe(0);
  await expect.poll(olderVisible).toEqual(olderIds);
  expect(errors).toEqual([]);
});
