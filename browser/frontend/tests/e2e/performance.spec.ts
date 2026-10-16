import { test, expect } from './fixtures/server';

declare global {
  interface Window {
    __FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD?: boolean;
    __FIBERBROWSER_E2E_EXPOSE_STORE?: boolean;
    __FIBERBROWSER_STORE__?: any;
  }
}

const TRACK_COUNT = 120;
const VISIBLE_COMPOSITES = 48;
const BINS = 2400;

type ReadResponseTiming = {
  label: string;
  serverMs: number | null;
  timings: Record<string, number>;
  reads: number;
  bytes: number;
};

type PeakScanResponseTiming = {
  label: string;
  requestMs: number;
  serverMs: number | null;
  timings: Record<string, number>;
  peaks: number;
  reads: number;
  bytes: number;
};

test.skip(process.env.FIBERBROWSER_RUN_PERF_E2E !== '1', 'Set FIBERBROWSER_RUN_PERF_E2E=1 to run browser performance guardrails.');

function signalValues(trackIndex: number, generation: number, bins: number): number[] {
  return Array.from({ length: bins }, (_, bin) => {
    const wave = Math.sin((bin + generation * 7) / 37) * 8;
    const local = ((bin + trackIndex * 13) % 29) / 3;
    return Number((wave + local + trackIndex * 0.05).toFixed(4));
  });
}

async function installSyntheticTrackApi(page: any) {
  await page.route('**/api/tracks', async (route: any) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        tracks: Array.from({ length: TRACK_COUNT }, (_, index) => ({
          index,
          label: `Perf Track ${index}`,
          path: `/synthetic/perf-${index}.bw`,
          render_mode: 'signal',
          format: 'bigWig',
        })),
      }),
    });
  });

  await page.route('**/api/tracks/batch', async (route: any) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const bins = Math.max(1, Math.min(Number(body.bins ?? BINS), BINS));
    const generation = Math.floor(Number(body.start ?? 0) / 1000);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        tracks: (body.track_indices ?? []).map((index: number) => ({
          index,
          label: `Perf Track ${index}`,
          values: signalValues(index, generation, bins),
          render_mode: 'signal',
        })),
      }),
    });
  });
}

async function summarizeReadResponse(label: string, response: any): Promise<ReadResponseTiming | null> {
  if (!response) return null;
  const body = await response.text().catch(() => '');
  if (!body) return null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return {
    label,
    serverMs: typeof parsed.server_elapsed_ms === 'number' ? parsed.server_elapsed_ms : null,
    timings: parsed.server_timings ?? {},
    reads: Array.isArray(parsed.reads) ? parsed.reads.length : 0,
    bytes: body.length,
  };
}

async function summarizePeakScanResponse(label: string, requestMs: number, response: any): Promise<PeakScanResponseTiming | null> {
  if (!response) return null;
  const body = await response.text().catch(() => '');
  if (!body) return null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return {
    label,
    requestMs,
    serverMs: typeof parsed.server_elapsed_ms === 'number' ? parsed.server_elapsed_ms : null,
    timings: parsed.server_timings ?? {},
    peaks: Array.isArray(parsed.peaks) ? parsed.peaks.length : 0,
    reads: Number(parsed.n_reads ?? 0),
    bytes: body.length,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function averageTiming(rows: ReadResponseTiming[], key: string): number {
  return average(rows.map(row => row.timings[key]).filter(value => typeof value === 'number' && Number.isFinite(value)));
}

function averageAnyTiming(rows: ReadResponseTiming[], keys: string[]): number {
  return average(rows.map(row => {
    for (const key of keys) {
      const value = row.timings[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  }).filter((value): value is number => value !== null));
}

test('large orthogonal cart pan/update benchmark', async ({ server, page }) => {
  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await installSyntheticTrackApi(page);

  await page.goto(server.baseUrl);
  await page.waitForFunction(() => Boolean(window.__FIBERBROWSER_STORE__));
  await page.waitForLoadState('networkidle');

  const metrics = await page.evaluate(async ({ trackCount, visibleComposites, bins }) => {
    const store = window.__FIBERBROWSER_STORE__;
    const colors = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];
    const makeValues = (trackIndex: number, generation: number) =>
      Array.from({ length: bins }, (_, bin) => {
        const wave = Math.sin((bin + generation * 7) / 37) * 8;
        const local = ((bin + trackIndex * 13) % 29) / 3;
        return Number((wave + local + trackIndex * 0.05).toFixed(4));
      });
    const makeTracks = (generationByIndex: Map<number, number> = new Map()) =>
      Array.from({ length: trackCount }, (_, index) => ({
        index,
        label: `Perf Track ${index}`,
        path: `/synthetic/perf-${index}.bw`,
        renderMode: 'signal',
        format: 'bigWig',
        values: makeValues(index, generationByIndex.get(index) ?? 0),
      }));
    const composites = Array.from({ length: visibleComposites }, (_, index) => ({
      id: `perf-composite-${index}`,
      label: `Perf ${index}`,
      kind: 'signal',
      sources: [{
        id: `perf-source-${index}`,
        ref: { kind: 'bigwig', catalogEntryId: `perf-entry-${index}` },
        color: colors[index % colors.length],
        visible: true,
        negate: false,
        scale: 1,
      }],
      scaleMode: 'auto',
      logScale: false,
      visible: true,
      groupAutoscaleSelected: false,
      showAxes: true,
    }));

    store.setState({
      chrom: 'chr2L',
      start: 100_000,
      end: 160_000,
      datasets: [{
        id: 'primary',
        label: 'Synthetic',
        path: '/synthetic/perf.bam',
        color: '#2563eb',
        available_layers: { nuc: true, tf: true },
      }],
      slotOrder: ['primary', 'panel-perf'],
      selectedDatasets: new Set(),
      panels: [{
        id: 'panel-perf',
        contentType: 'dataset',
        datasetId: 'primary',
        subTracks: [
          { type: 'axis', visible: true },
          ...composites.map(track => ({ type: `composite-${track.id}`, visible: true })),
        ],
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      }],
      catalog: Array.from({ length: trackCount }, (_, index) => ({
        id: `perf-entry-${index}`,
        source: 'local',
        kind: 'bigwig',
        label: `Perf Track ${index}`,
        path: `/synthetic/perf-${index}.bw`,
        loaded: true,
        trackIndex: index,
      })),
      compositeTracks: composites,
    });
    store.getState().setOrthogonalTracks(makeTracks());

    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const settle = async () => {
      await nextFrame();
      await nextFrame();
    };
    await settle();

    const unrelatedDurations: number[] = [];
    for (let iteration = 1; iteration <= 8; iteration++) {
      const t0 = performance.now();
      store.getState().setOrthogonalTracks(makeTracks(new Map([[trackCount - 1, iteration]])));
      await settle();
      unrelatedDurations.push(performance.now() - t0);
    }

    const panDurations: number[] = [];
    for (let iteration = 1; iteration <= 8; iteration++) {
      const t0 = performance.now();
      store.getState().setViewport('chr2L', 100_000 + iteration * 1500, 160_000 + iteration * 1500);
      store.getState().setOrthogonalTracks(makeTracks(
        new Map(Array.from({ length: visibleComposites }, (_, index) => [index, iteration])),
      ));
      await settle();
      panDurations.push(performance.now() - t0);
    }

    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    return {
      canvasCount: document.querySelectorAll('canvas').length,
      unrelatedAvgMs: average(unrelatedDurations),
      unrelatedMaxMs: Math.max(...unrelatedDurations),
      panAvgMs: average(panDurations),
      panMaxMs: Math.max(...panDurations),
    };
  }, { trackCount: TRACK_COUNT, visibleComposites: VISIBLE_COMPOSITES, bins: BINS });

  console.log(
    `large orthogonal cart perf: unrelated avg=${metrics.unrelatedAvgMs.toFixed(1)}ms max=${metrics.unrelatedMaxMs.toFixed(1)}ms; `
    + `pan avg=${metrics.panAvgMs.toFixed(1)}ms max=${metrics.panMaxMs.toFixed(1)}ms; canvases=${metrics.canvasCount}`,
  );

  expect(metrics.canvasCount).toBeGreaterThanOrEqual(VISIBLE_COMPOSITES);
  expect(metrics.unrelatedAvgMs).toBeLessThan(60);
  expect(metrics.unrelatedMaxMs).toBeLessThan(180);
  expect(metrics.panAvgMs).toBeLessThan(180);
  expect(metrics.panMaxMs).toBeLessThan(420);
});

test('read track pan/fetch benchmark', async ({ server, page }) => {
  const browserPerfLogs: string[] = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.startsWith('[perf] read.')) browserPerfLogs.push(text);
  });

  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  await page.goto(server.baseUrl);
  await page.waitForFunction(() => Boolean(window.__FIBERBROWSER_STORE__));
  await page.waitForLoadState('networkidle');

  const region = { chrom: 'chr2R', start: 9_960_000, end: 9_980_000 };
  await page.evaluate(({ chrom, start, end }) => {
    const store = window.__FIBERBROWSER_STORE__;
    store.setState({
      readDisplayMode: 'sample',
      downsampleCount: null,
      allReadsDisplayCap: 2000,
      backgroundReadCap: 1000,
      spanningOnly: false,
      readRowHeight: 1,
      fillReadHeight: true,
      showCoverageHistogram: false,
      maxRegionForReads: 100_000,
    });
    store.getState().setViewport(chrom, start, end);
  }, region);
  const readTimings: ReadResponseTiming[] = [];
  const initialReadResponse = await page.waitForResponse(
    resp => resp.url().includes('/api/reads/compact') && resp.status() === 200,
    { timeout: 30_000 },
  ).catch(() => null);
  const initialTiming = await summarizeReadResponse('initial', initialReadResponse);
  if (initialTiming) readTimings.push(initialTiming);
  await page.waitForTimeout(250);

  const durations: number[] = [];
  const width = region.end - region.start;
  for (let iteration = 1; iteration <= 6; iteration++) {
    const offset = iteration * 1500;
    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/api/reads/compact') && resp.status() === 200,
      { timeout: 30_000 },
    );
    const started = await page.evaluate(() => performance.now());
    await page.evaluate(({ chrom, start, width }) => {
      window.__FIBERBROWSER_STORE__.getState().setViewport(chrom, start, start + width);
    }, { chrom: region.chrom, start: region.start + offset, width });
    const response = await responsePromise;
    const elapsed = await page.evaluate(async (startedAt) => {
      const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await nextFrame();
      await nextFrame();
      return performance.now() - startedAt;
    }, started);
    durations.push(elapsed);
    const timing = await summarizeReadResponse(`pan-${iteration}`, response);
    if (timing) readTimings.push(timing);
  }
  const metrics = await page.evaluate((durationsArg) => {
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    return {
      avgMs: average(durationsArg),
      maxMs: Math.max(...durationsArg),
      canvasCount: document.querySelectorAll('canvas').length,
      readRequestCount: (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        .filter(entry => entry.name.includes('/api/reads/compact')).length,
    };
  }, durations);
  const timingSummary = {
    initialServerMs: readTimings[0]?.serverMs ?? null,
    panServerAvgMs: average(readTimings.slice(1).map(row => row.serverMs ?? 0)),
    panBackendWorkAvgMs: averageAnyTiming(readTimings.slice(1), ['display_working_set_ms', 'working_set_ms']),
    panDisplayWorkingAvgMs: averageTiming(readTimings.slice(1), 'display_working_set_ms'),
    panCandidateAvgMs: averageTiming(readTimings.slice(1), 'display_candidate_ms'),
    panProfileRawAvgMs: averageTiming(readTimings.slice(1), 'display_profile_ms'),
    panProfileSelectAvgMs: averageTiming(readTimings.slice(1), 'display_profile_select_ms'),
    panProfilePayloadAvgMs: averageTiming(readTimings.slice(1), 'display_profile_payload_ms'),
    panDisplaySelectAvgMs: averageTiming(readTimings.slice(1), 'display_select_ms'),
    panProjectAvgMs: averageTiming(readTimings.slice(1), 'display_project_ms'),
    panWorkingAvgMs: averageTiming(readTimings.slice(1), 'working_set_ms'),
    panSortAvgMs: averageTiming(readTimings.slice(1), 'display_sort_ms'),
    panSampleAvgMs: averageTiming(readTimings.slice(1), 'display_sample_ms'),
    panMetaprofileAvgMs: averageTiming(readTimings.slice(1), 'metaprofile_ms'),
    avgReturnedReads: average(readTimings.map(row => row.reads)),
    avgPayloadKb: average(readTimings.map(row => row.bytes)) / 1024,
  };

  console.log(
    `read track perf: avg=${metrics.avgMs.toFixed(1)}ms max=${metrics.maxMs.toFixed(1)}ms; `
    + `canvases=${metrics.canvasCount}; readRequests=${metrics.readRequestCount}; `
    + `initialServer=${timingSummary.initialServerMs?.toFixed(1) ?? 'n/a'}ms `
    + `panServerAvg=${timingSummary.panServerAvgMs.toFixed(1)}ms `
    + `panBackendWorkAvg=${timingSummary.panBackendWorkAvgMs.toFixed(1)}ms `
    + `panDisplayWorkingAvg=${timingSummary.panDisplayWorkingAvgMs.toFixed(1)}ms `
    + `panCandidateAvg=${timingSummary.panCandidateAvgMs.toFixed(1)}ms `
    + `panProfileRawAvg=${timingSummary.panProfileRawAvgMs.toFixed(1)}ms `
    + `panProfileSelectAvg=${timingSummary.panProfileSelectAvgMs.toFixed(1)}ms `
    + `panProfilePayloadAvg=${timingSummary.panProfilePayloadAvgMs.toFixed(1)}ms `
    + `panDisplaySelectAvg=${timingSummary.panDisplaySelectAvgMs.toFixed(1)}ms `
    + `panProjectAvg=${timingSummary.panProjectAvgMs.toFixed(1)}ms `
    + `panWorkingAvg=${timingSummary.panWorkingAvgMs.toFixed(1)}ms `
    + `panSortAvg=${timingSummary.panSortAvgMs.toFixed(1)}ms `
    + `panSampleAvg=${timingSummary.panSampleAvgMs.toFixed(1)}ms `
    + `panMetaprofileAvg=${timingSummary.panMetaprofileAvgMs.toFixed(1)}ms `
    + `readsAvg=${timingSummary.avgReturnedReads.toFixed(1)} `
    + `payloadAvg=${timingSummary.avgPayloadKb.toFixed(1)}KB`,
  );
  if (browserPerfLogs.length > 0) {
    console.log(`read track browser perf logs:\n${browserPerfLogs.slice(-14).join('\n')}`);
  }

  expect(metrics.canvasCount).toBeGreaterThan(0);
  expect(metrics.readRequestCount).toBeGreaterThan(0);
  expect(metrics.avgMs).toBeLessThan(5_000);
  expect(metrics.maxMs).toBeLessThan(10_000);
});

test('peak scan endpoint benchmark', async ({ server, request }) => {
  const region = { chrom: 'chr2R', start: 9_960_000, end: 9_980_000 };
  const warm = await request.get(
    `${server.baseUrl}/api/reads/compact?chrom=${region.chrom}&start=${region.start}&end=${region.end}`
    + `&dataset_id=primary&max_reads=1000&spanning=false&include_metaprofile=true&profile_max_reads=1000`
    + `&include_layers=false&include_methylation=false`,
  );
  expect(warm.ok()).toBeTruthy();

  const scans: PeakScanResponseTiming[] = [];
  const width = region.end - region.start;
  for (let iteration = 0; iteration < 6; iteration++) {
    const start = region.start + iteration * 1500;
    const started = Date.now();
    const response = await request.post(
      `${server.baseUrl}/api/scan_peaks?chrom=${region.chrom}&start=${start}&end=${start + width}&dataset_id=primary`,
      {
        data: {
          min_width: 80,
          min_reads: 5,
          smooth_width: 100,
          threshold_strong: 0.50,
          threshold_medium: 0.30,
          threshold_weak: 0.15,
          threshold_rare: 0.08,
          signal_source: 'accessibility',
          return_signal: true,
          signal_bins: 500,
        },
      },
    );
    expect(response.ok()).toBeTruthy();
    const scan = await summarizePeakScanResponse(`scan-${iteration}`, Date.now() - started, response);
    if (scan) scans.push(scan);
  }

  const panScans = scans.slice(1);
  const requestAvgMs = average(panScans.map(row => row.requestMs));
  const serverAvgMs = average(panScans.map(row => row.serverMs ?? 0));
  const workingAvgMs = averageTiming(panScans, 'working_set_ms');
  const signalAvgMs = averageTiming(panScans, 'signal_ms');
  const smoothAvgMs = averageTiming(panScans, 'smooth_ms');
  const detectAvgMs = averageTiming(panScans, 'detect_ms');
  const payloadAvgKb = average(panScans.map(row => row.bytes)) / 1024;

  console.log(
    `peak scan perf: requestAvg=${requestAvgMs.toFixed(1)}ms `
    + `serverAvg=${serverAvgMs.toFixed(1)}ms `
    + `workingAvg=${workingAvgMs.toFixed(1)}ms `
    + `signalAvg=${signalAvgMs.toFixed(1)}ms `
    + `smoothAvg=${smoothAvgMs.toFixed(1)}ms `
    + `detectAvg=${detectAvgMs.toFixed(1)}ms `
    + `readsAvg=${average(panScans.map(row => row.reads)).toFixed(1)} `
    + `peaksAvg=${average(panScans.map(row => row.peaks)).toFixed(1)} `
    + `payloadAvg=${payloadAvgKb.toFixed(1)}KB`,
  );

  expect(scans.length).toBeGreaterThan(0);
  expect(requestAvgMs).toBeLessThan(5_000);
  expect(serverAvgMs).toBeLessThan(4_000);
});

test('interactive keyboard and drag pan benchmark', async ({ server, page }) => {
  await page.addInitScript(() => {
    window.__FIBERBROWSER_E2E_DISABLE_GENOME_AUTOLOAD = true;
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await installSyntheticTrackApi(page);

  await page.goto(server.baseUrl);
  await page.waitForFunction(() => Boolean(window.__FIBERBROWSER_STORE__));
  await page.waitForLoadState('networkidle');

  const region = { chrom: 'chr2R', start: 9_960_000, end: 9_980_000 };
  await page.evaluate(({ chrom, start, end, visibleComposites, bins }) => {
    const store = window.__FIBERBROWSER_STORE__;
    const datasetId = store.getState().datasets[0]?.id ?? 'primary';
    const colors = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];
    const makeValues = (trackIndex: number) =>
      Array.from({ length: bins }, (_, bin) => {
        const wave = Math.sin((bin + trackIndex * 3) / 37) * 8;
        const local = ((bin + trackIndex * 13) % 29) / 3;
        return Number((wave + local + trackIndex * 0.05).toFixed(4));
      });
    const composites = Array.from({ length: visibleComposites }, (_, index) => ({
      id: `interactive-composite-${index}`,
      label: `Interactive ${index}`,
      kind: 'signal',
      sources: [{
        id: `interactive-source-${index}`,
        ref: { kind: 'bigwig', catalogEntryId: `interactive-entry-${index}` },
        color: colors[index % colors.length],
        visible: true,
        negate: false,
        scale: 1,
      }],
      scaleMode: 'auto',
      logScale: false,
      visible: true,
      groupAutoscaleSelected: false,
      showAxes: true,
    }));

    store.setState({
      readDisplayMode: 'sample',
      downsampleCount: null,
      allReadsDisplayCap: 2000,
      backgroundReadCap: 1000,
      spanningOnly: false,
      readRowHeight: 1,
      fillReadHeight: true,
      showCoverageHistogram: false,
      maxRegionForReads: 100_000,
      panels: [{
        id: 'panel-interactive',
        contentType: 'dataset',
        datasetId,
        subTracks: [
          { type: 'axis', visible: true },
          { type: 'genes', visible: true, height: 48 },
          { type: 'fire', visible: true, height: 42 },
          ...composites.map(track => ({ type: `composite-${track.id}`, visible: true, height: 28 })),
          { type: 'reads', visible: true },
        ],
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      }],
      catalog: Array.from({ length: visibleComposites }, (_, index) => ({
        id: `interactive-entry-${index}`,
        source: 'local',
        kind: 'bigwig',
        label: `Interactive Track ${index}`,
        path: `/synthetic/interactive-${index}.bw`,
        loaded: true,
        trackIndex: index,
      })),
      compositeTracks: composites,
    });
    store.getState().setOrthogonalTracks(Array.from({ length: visibleComposites }, (_, index) => ({
      index,
      label: `Interactive Track ${index}`,
      path: `/synthetic/interactive-${index}.bw`,
      renderMode: 'signal',
      format: 'bigWig',
      values: makeValues(index),
    })));
    store.getState().setViewport(chrom, start, end);
  }, { ...region, visibleComposites: VISIBLE_COMPOSITES, bins: BINS });

  await page.waitForResponse(resp => resp.url().includes('/api/reads/compact') && resp.status() === 200, { timeout: 30_000 }).catch(() => null);
  await page.waitForTimeout(250);

  const keyboardStartRequests = await page.evaluate(() => (
    performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  ).filter(entry => entry.name.includes('/api/reads/compact')).length);
  const keyboardResponse = page.waitForResponse(
    resp => resp.url().includes('/api/reads/compact') && resp.status() === 200,
    { timeout: 30_000 },
  ).catch(() => null);
  const keyboardMetrics = await page.evaluate(async () => {
    const store = window.__FIBERBROWSER_STORE__;
    const startBefore = store.getState().start;
    const t0 = performance.now();
    for (let i = 0; i < 12; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        repeat: i > 0,
      }));
    }
    await new Promise(resolve => setTimeout(resolve, 180));
    await new Promise(resolve => requestAnimationFrame(resolve));
    return {
      dispatchMs: performance.now() - t0,
      shiftedBp: store.getState().start - startBefore,
    };
  });
  await keyboardResponse;
  await page.waitForTimeout(100);
  const keyboardEndRequests = await page.evaluate(() => (
    performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  ).filter(entry => entry.name.includes('/api/reads/compact')).length);

  const dragMetrics = await page.evaluate(async () => {
    const canvases = Array.from(document.querySelectorAll('canvas'))
      .map(canvas => ({ canvas, rect: canvas.getBoundingClientRect() }))
      .filter(item => item.rect.width > 200 && item.rect.height > 80)
      .sort((a, b) => b.rect.height - a.rect.height);
    const target = canvases[0];
    if (!target) return { avgFrameMs: 0, maxFrameMs: 0, frames: 0 };

    const { canvas, rect } = target;
    const y = rect.top + rect.height / 2;
    const x0 = rect.left + rect.width * 0.65;
    const dx = -Math.min(260, rect.width * 0.3);
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      clientX: x0,
      clientY: y,
      bubbles: true,
      buttons: 1,
    }));
    await nextFrame();

    const frames: number[] = [];
    for (let i = 1; i <= 24; i++) {
      const t0 = performance.now();
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: x0 + (dx * i) / 24,
        clientY: y,
        bubbles: true,
        buttons: 1,
      }));
      await nextFrame();
      frames.push(performance.now() - t0);
    }
    document.dispatchEvent(new MouseEvent('mouseup', {
      clientX: x0 + dx,
      clientY: y,
      bubbles: true,
      buttons: 0,
    }));
    await nextFrame();

    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    return {
      avgFrameMs: average(frames),
      maxFrameMs: Math.max(...frames),
      frames: frames.length,
    };
  });

  const keyboardRequests = keyboardEndRequests - keyboardStartRequests;
  console.log(
    `interactive pan perf: keyboard dispatch=${keyboardMetrics.dispatchMs.toFixed(1)}ms `
    + `shift=${keyboardMetrics.shiftedBp}bp requests=${keyboardRequests}; `
    + `drag avgFrame=${dragMetrics.avgFrameMs.toFixed(1)}ms maxFrame=${dragMetrics.maxFrameMs.toFixed(1)}ms`,
  );

  expect(keyboardMetrics.shiftedBp).toBeGreaterThan(0);
  expect(keyboardRequests).toBeLessThanOrEqual(2);
  expect(dragMetrics.frames).toBe(24);
  expect(dragMetrics.avgFrameMs).toBeLessThan(35);
  expect(dragMetrics.maxFrameMs).toBeLessThan(100);
});
