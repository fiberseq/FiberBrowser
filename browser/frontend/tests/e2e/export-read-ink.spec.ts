import { test, expect, type ServerFixture } from './fixtures/server';
import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const FLY = { chrom: 'chr2L', start: 9_464_000, end: 9_466_000 };
const DEMO = { chrom: 'chr19', start: 47_514_000, end: 47_518_000 };

async function open(page: Page, server: ServerFixture, kind: string) {
  if (kind === 'BigBed') {
    expect(server.fiberBigBedPath, 'Set FIBERBROWSER_TEST_BIGBED to a read-only fixture').toBeTruthy();
    const added = await page.request.post(`${server.baseUrl}/api/datasets/add`, {
      data: { path: server.fiberBigBedPath, label: 'Export fibers' },
    });
    expect(added.ok()).toBe(true);
    const datasets = await (await page.request.get(`${server.baseUrl}/api/datasets`)).json();
    for (const ds of datasets.datasets) {
      if (ds.id !== (await added.json()).dataset.id) {
        expect((await page.request.delete(`${server.baseUrl}/api/datasets/${ds.id}`)).ok()).toBe(true);
      }
    }
  }
  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1280, height: 950 });
  const region = kind === 'demo BAM' ? DEMO : FLY;
  await page.goto(`${server.baseUrl}/?chrom=${region.chrom}&start=${region.start}&end=${region.end}`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => !!window.__FIBERBROWSER_STORE__?.getState().datasets.length);
  await page.evaluate(region => {
    const store = window.__FIBERBROWSER_STORE__!;
    const panel = store.getState().panels.find(p => p.contentType === 'dataset')!;
    // Five columns exceed the interactive row's minimum width. Export changes that layout.
    const panels = Array.from({ length: 5 }, (_, i) => ({
      ...panel, id: `ink-${i}`, stateKey: `ink-${i}`, layoutRow: 0, layoutColumn: i,
      widthFraction: 0.2, subTracks: panel.subTracks.filter(t => ['axis', 'reads'].includes(t.type)),
    }));
    store.setState({ panels, slotOrder: panels.map(p => p.id), spanningOnly: false,
      minFootprints: 0, readDisplayMode: 'sample', downsampleCount: null,
      backgroundReadCap: 500, readRowHeight: 3, showCoverageHistogram: false });
    store.getState().setViewport(region.chrom, region.start, region.end);
  }, region);
  return region;
}

async function settled(page: Page, count = 5) {
  await expect(page.locator('[data-read-track-dataset-id]')).toHaveCount(count);
  await expect.poll(() => page.locator('[data-read-track-dataset-id]').evaluateAll(tracks =>
    tracks.every(t => t.getAttribute('data-read-track-loading') === 'false'
      && Number(t.getAttribute('data-read-track-render-count')) > 0)), { timeout: 60_000 }).toBe(true);
}

/** Count colored read marks in each panel's interior, away from headers, axes and loading text. */
async function readInk(page: Page, file: string, columns: number, left = 0, top = 0.35, height = 0.35) {
  if (file.endsWith('.pdf')) {
    // jsPDF embeds the read canvases as RGB images with PNG Sub prediction.
    const pdf = readFileSync(file);
    const ink: number[] = [];
    for (let at = pdf.indexOf('/Subtype /Image'); at >= 0; at = pdf.indexOf('/Subtype /Image', at + 1)) {
      const start = pdf.indexOf('stream\n', at) + 7;
      const header = pdf.subarray(at, start).toString();
      if (!header.includes('/DeviceRGB')) continue;
      expect(header).toContain('/Predictor 11');
      const number = (key: string) => Number(header.match(new RegExp(`/${key} (\\d+)`))![1]);
      const width = number('Width'), height = number('Height');
      const bytes = inflateSync(pdf.subarray(start, start + number('Length')));
      const stride = width * 3 + 1;
      let colored = 0, total = 0;
      for (let y = 0; y < height; y++) {
        const row = y * stride;
        expect(bytes[row]).toBe(1);
        for (let x = 3; x < width * 3; x++) bytes[row + 1 + x] += bytes[row + 1 + x - 3];
        if (y < height * 0.35 || y >= height * 0.7) continue;
        for (let x = Math.ceil(width * 0.2); x < width * 0.8; x++) {
          const i = row + 1 + x * 3;
          const hi = Math.max(bytes[i], bytes[i + 1], bytes[i + 2]);
          const lo = Math.min(bytes[i], bytes[i + 1], bytes[i + 2]);
          if (hi - lo > 30 && lo < 210) colored++;
          total++;
        }
      }
      ink.push(colored / total);
    }
    return ink;
  }
  const isSvg = file.endsWith('.svg');
  return page.evaluate(async ({ data, isSvg, columns, left, top, height }) => {
    const sources = isSvg
      ? [...new DOMParser().parseFromString(atob(data), 'image/svg+xml').querySelectorAll('image')]
        .map(el => el.getAttribute('href') || el.getAttribute('xlink:href')!)
      : [`data:image/png;base64,${data}`];
    const ink: number[] = [];
    for (const src of sources) {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      const n = isSvg ? 1 : columns;
      const offset = isSvg ? 0 : left * canvas.width;
      const w = (canvas.width - offset) / n;
      for (let col = 0; col < n; col++) {
        const pixels = ctx.getImageData(Math.floor(offset + (col + 0.2) * w),
          Math.floor(canvas.height * (isSvg ? 0.01 : top)), Math.max(1, Math.floor(w * 0.6)),
          Math.max(1, Math.floor(canvas.height * (isSvg ? 0.94 : height)))).data;
        let colored = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const hi = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
          const lo = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
          if (hi - lo > 30 && lo < 210 && pixels[i + 3] > 200) colored++;
        }
        ink.push(colored / (pixels.length / 4));
      }
    }
    return ink;
  }, { data: readFileSync(file).toString('base64'), isSvg, columns, left, top, height });
}

for (const kind of ['demo BAM', 'deep BAM', 'BigBed']) {
  test.describe(kind, () => {
    test.use({ fixtureBam: kind === 'deep BAM' ? process.env.FIBERBROWSER_TEST_BAM : 'demo' });
    test('exported figures and screenshots contain reads in every panel', async ({ page, server }, info) => {
      test.skip(kind === 'deep BAM' && !process.env.FIBERBROWSER_TEST_BAM, 'Set FIBERBROWSER_TEST_BAM');
      test.skip(kind === 'BigBed' && !server.fiberBigBedPath, 'Set FIBERBROWSER_TEST_BIGBED');
      test.setTimeout(300_000);
      const region = await open(page, server, kind);
      let delayed = false;
      await page.route('**/api/reads/compact*', async route => {
        if (delayed) await new Promise(resolve => setTimeout(resolve, 1500));
        await route.continue();
      });
      for (const mode of ['linked', 'perPanel'] as const) {
        await page.evaluate(({ mode, region }) => {
          const s = window.__FIBERBROWSER_STORE__!.getState();
          s.setNavigationMode(mode);
          if (mode === 'perPanel') {
            s.navigatePanel('ink-4', region.chrom, region.start + 100, region.end - 100);
            s.setPanelReversed('ink-4', true);
          }
        }, { mode, region });
        for (const format of ['png', 'svg', 'pdf'] as const) {
          delayed = false;
          await settled(page);
          await page.getByTestId('export-screenshot-button').click();
          await page.getByRole('button', { name: format.toUpperCase(), exact: true }).click();
          delayed = true;
          const download = page.waitForEvent('download', { timeout: 60_000 });
          await page.getByRole('button', { name: `Export ${format.toUpperCase()}`, exact: true }).click();
          const file = info.outputPath(`${mode}.${format}`);
          await (await download).saveAs(file);
          const ink = await readInk(page, file, 5);
          await info.attach(`${mode}-${format}-ink`, { body: JSON.stringify(ink), contentType: 'application/json' });
          // PDF may reuse the same image for identical panels.
          if (format === 'pdf') expect(ink.length).toBeGreaterThan(0);
          else expect.soft(ink.length).toBe(5);
          for (const [i, fraction] of ink.entries()) expect.soft(fraction, `${mode} ${format} panel ${i}`).toBeGreaterThan(0.01);
        }
      }
      delayed = false;
      await settled(page);
      const left = await page.locator('[data-export-container]').evaluate(el => el.getBoundingClientRect().left / innerWidth);
      await page.getByTestId('export-screenshot-button').click();
      await page.getByLabel('Capture full UI').check();
      delayed = true;
      const screenshot = page.waitForEvent('download', { timeout: 60_000 });
      await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
      const file = info.outputPath('full-ui.png');
      await (await screenshot).saveAs(file);
      const ink = await readInk(page, file, 5, left);
      await info.attach('full-ui-ink', { body: JSON.stringify(ink), contentType: 'application/json' });
      for (const [i, fraction] of ink.entries()) expect.soft(fraction, `full UI panel ${i}`).toBeGreaterThan(0.01);

      // A single-panel snapshot uses the same exporter from full view.
      delayed = false;
      await page.evaluate(() => window.__FIBERBROWSER_STORE__!.getState().setFullViewPanel('ink-4'));
      await settled(page, 1);
      await page.getByTestId('export-screenshot-button').click();
      const snapshot = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
      const snapshotFile = info.outputPath('panel-snapshot.png');
      await (await snapshot).saveAs(snapshotFile);
      expect((await readInk(page, snapshotFile, 1))[0]).toBeGreaterThan(0.01);

      // Two saved splits also remove their group strips during export, even without a scrolling row.
      await page.setViewportSize({ width: 1800, height: 950 });
      await page.evaluate(() => {
        const store = window.__FIBERBROWSER_STORE__!;
        const s = store.getState();
        const source = s.panels.find(p => p.id === 'ink-4')!;
        const ids = s.activeReadIds[source.stateKey!] ?? [];
        const panels = Array.from({ length: 3 }, (_, i) => ({
          ...source, id: `split-${i}`, stateKey: `split-${i}`, layoutColumn: i, widthFraction: 1 / 3,
          reversed: i === 2,
          readSubset: { groupId: i < 2 ? 'first-split' : 'second-split', label: `Group ${i + 1}`,
            colour: '#64748b', count: ids.length, sourcePanelId: source.id,
            rule: { kind: 'frozen' as const, datasetId: source.datasetId!, groupKeys: [String(i)],
              readIds: ids.filter((_, j) => j % 3 === i) } },
        }));
        store.setState({ panels, slotOrder: panels.map(p => p.id), fullViewPanelId: null, readDisplayMode: 'all' });
      });
      await settled(page, 3);
      await expect(page.getByTestId('split-group-strips')).toBeVisible();
      delayed = true;
      await page.getByTestId('export-screenshot-button').click();
      const splitPng = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
      const splitPngFile = info.outputPath('splits.png');
      await (await splitPng).saveAs(splitPngFile);
      // A small All-reads set occupies the top of its canvas, below the header and axis.
      for (const fraction of await readInk(page, splitPngFile, 3, 0, 0.15, 0.15)) {
        expect.soft(fraction).toBeGreaterThan(0.01);
      }
      delayed = false;
      await settled(page, 3);
      await page.getByTestId('export-screenshot-button').click();
      await page.getByRole('button', { name: 'SVG', exact: true }).click();
      await page.getByTestId('export-more-options').click();
      await page.getByLabel('Match read counts across visible samples').check();
      delayed = true;
      const splitExport = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
      const splitFile = info.outputPath('splits.svg');
      await (await splitExport).saveAs(splitFile);
      const splitInk = await readInk(page, splitFile, 3);
      await info.attach('split-ink', { body: JSON.stringify(splitInk), contentType: 'application/json' });
      expect(splitInk).toHaveLength(3);
      for (const fraction of splitInk) expect.soft(fraction).toBeGreaterThan(0.01);

      const datasetId = await page.evaluate(() => window.__FIBERBROWSER_STORE__!.getState().datasets[0].id);
      const rendered = await page.request.post(`${server.baseUrl}/api/render`, { timeout: 90_000, data: {
        ...region, engine: 'playwright', format: 'png', dataset_id: datasetId,
        width: 900, dpi: 96, max_reads: 200, spanning_only: false, show_layers: true, timeoutMs: 60_000,
      } });
      expect(rendered.ok(), rendered.ok() ? '' : await rendered.text()).toBe(true);
      const renderedFile = info.outputPath('render-snapshot.png');
      await info.attach('render-snapshot', { body: await rendered.body(), contentType: 'image/png' });
      writeFileSync(renderedFile, await rendered.body());
      expect((await readInk(page, renderedFile, 1))[0]).toBeGreaterThan(0.01);
    });
  });
}

test.describe('incomplete read exports', () => {
  test.use({ fixtureBam: 'demo' });
  for (const fullUI of [false, true]) {
    test(`${fullUI ? 'full UI' : 'figure'} reports a failed load and restores the view`, async ({ page, server }) => {
      await open(page, server, 'demo BAM');
      await settled(page);
      let downloads = 0;
      page.on('download', () => { downloads++; });
      await page.route('**/api/reads/compact*', route => route.fulfill({ status: 503, body: 'Read source unavailable' }));
      await page.getByTestId('export-screenshot-button').click();
      if (fullUI) await page.getByLabel('Capture full UI').check();
      await page.getByRole('button', { name: '4x', exact: true }).click();
      await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Could not load reads');
      await expect(page.getByRole('alert')).toContainText('export again');
      expect(downloads).toBe(0);
      expect(await page.evaluate(() => {
        const s = window.__FIBERBROWSER_STORE__!.getState();
        return [s.exportInProgress, s.exportFullReadTracks, s.exportMatchedReadCount];
      })).toEqual([false, false, null]);
      await expect(page.getByRole('button', { name: 'Export PNG', exact: true })).toBeEnabled();
    });
  }

  test('a stalled read request times out without saving a loading image', async ({ page, server }) => {
    await open(page, server, 'demo BAM');
    await settled(page);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/reads/compact*', async route => { await held; await route.abort(); });
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await page.getByTestId('export-screenshot-button').click();
    await page.clock.install();
    try {
      await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__FIBERBROWSER_STORE__!.getState().exportInProgress)).toBe(true);
      await expect(page.locator('[data-read-track-loading="true"]').first()).toBeAttached();
      await page.clock.fastForward(31_000);
      await expect(page.getByRole('alert')).toContainText('did not finish drawing');
      expect(downloads).toBe(0);
      expect(await page.evaluate(() => window.__FIBERBROWSER_STORE__!.getState().exportInProgress)).toBe(false);
    } finally { release(); }
  });
});

test.describe('streamed read exports', () => {
  test.use({ fixtureBam: process.env.FIBERBROWSER_TEST_BAM });
  test('All reads finishes its stream before exporting', async ({ page, server }, info) => {
    test.skip(!process.env.FIBERBROWSER_TEST_BAM, 'Set FIBERBROWSER_TEST_BAM');
    test.setTimeout(180_000);
    await open(page, server, 'deep BAM');
    await settled(page);
    const stream = page.waitForResponse(response => response.url().includes('/api/reads/compact')
      && (response.headers()['content-type'] ?? '').includes('reads.stream'), { timeout: 60_000 });
    await page.evaluate(() => {
      const store = window.__FIBERBROWSER_STORE__!;
      store.setState({ fullViewPanelId: 'ink-4', readDisplayMode: 'all', allReadsDisplayCap: 2000,
        backgroundReadCap: null, hideTerminalGaps: false, terminalGapThreshold: 0,
        enabledCigarTypes: { mismatches: false, insertions: false, deletions: false },
        loadAllReads: { [store.getState().datasets[0].id]: true } });
    });
    await page.getByTestId('export-screenshot-button').click();
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
    const file = info.outputPath('streamed.png');
    await (await download).saveAs(file);
    expect((await stream).ok()).toBe(true);
    expect((await readInk(page, file, 1))[0]).toBeGreaterThan(0.01);
  });
});
