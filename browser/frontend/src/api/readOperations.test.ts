import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autozoom,
  clusterExpand,
  compactReadsQueryKey,
  filterReads,
  filterReadsByAnalysisRule,
  getWorkingSetInfo,
  linkedCompactReadsQueryKey,
  sortReads,
} from './readOperations';

describe('read operations API client', () => {
  it('normalizes compact-read query keys and keeps linked reads separate', () => {
    const a = new URLSearchParams();
    a.set('chrom', 'chr2R');
    a.set('start', '100');
    a.set('end', '200');
    a.set('dataset_id', 'ds1');

    const b = new URLSearchParams();
    b.set('dataset_id', 'ds1');
    b.set('end', '200');
    b.set('start', '100');
    b.set('chrom', 'chr2R');

    expect(compactReadsQueryKey(a)).toBe(compactReadsQueryKey(b));
    expect(linkedCompactReadsQueryKey(a)).not.toBe(compactReadsQueryKey(a));
  });

  it('serializes filter and sort read requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ read_ids: [], results: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await filterReads('chr2R', 100, 200, [{ start: 120, end: 150 }], 'either', true, 'ds1', 'tf', 'paper');
    await sortReads('chr2R', 100, 200, true, ['ds1'], 'footprint_count', {
      descending: false,
      linked: true,
      peakRegions: [[120, 150]],
	      selectedPeakWindows: [[130, 140]],
      layer: 'tf',
      transcriptionState: 'elongating',
      geneIds: ['tx1'],
      readIds: { ds1: ['r2', 'r3'] },
      clusterAssignments: { ds1: { r2: 7, r3: 8 } },
      sampleSeed: 'paper',
	    });
    await filterReadsByAnalysisRule('chr2R', 100, 200, true, ['ds1'], {
      metric: 'count',
      operator: 'gte',
      threshold: 1,
      rule: { size_min: 20, size_max: 80, conditions: [] },
      peakRegions: [[120, 150]],
	      scopeWindows: [[130, 140]],
	      layer: 'tf',
	      transcriptionState: 'pause',
	      geneIds: ['tx1'],
	      sampleSeed: 'paper',
	    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/filter?chrom=chr2R&start=100&end=200&spanning=true&dataset_id=ds1');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      peak_regions: [{ start: 120, end: 150 }],
      filter_mode: 'either',
      layer: 'tf',
      sample_seed: 'paper',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/sort_reads?chrom=chr2R&start=100&end=200&spanning=true');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      dataset_ids: ['ds1'],
      sort_by: 'footprint_count',
      descending: false,
      linked: true,
      peak_regions: [[120, 150]],
	      selected_peak_windows: [[130, 140]],
      layer: 'tf',
      transcription_state: 'elongating',
      gene_ids: ['tx1'],
      read_ids: { ds1: ['r2', 'r3'] },
      cluster_assignments: { ds1: { r2: 7, r3: 8 } },
      sample_seed: 'paper',
	    });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/filter_by_analysis_rule?chrom=chr2R&start=100&end=200&spanning=true');
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      dataset_ids: ['ds1'],
      metric: 'count',
      operator: 'gte',
      threshold: 1,
      rule: { size_min: 20, size_max: 80, conditions: [] },
      peak_regions: [[120, 150]],
	      scope_windows: [[130, 140]],
	      layer: 'tf',
	      transcription_state: 'pause',
	      gene_ids: ['tx1'],
	      sample_seed: 'paper',
	    });
  });

  it('serializes navigation and working-set helpers', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, reads: [], has_working_set: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await autozoom('chr2R', 100, 200, true, ['ds1'], 500, 10, 25, 75);
    await clusterExpand('chr2R', 100, 200, [1, 2], 'ds1', 1000);
    await getWorkingSetInfo('chr2R', 100, 200, 'ds1', 'paper');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/autozoom?chrom=chr2R&start=100&end=200&spanning=true');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      dataset_ids: ['ds1'],
      distance: 500,
      min_reads: 10,
      primer_clip: 25,
      cluster_window: 75,
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/cluster_expand?chrom=chr2R&start=100&end=200');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      cluster_ids: [1, 2],
      dataset_id: 'ds1',
      max_reads: 1000,
    });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/working_set_info?chrom=chr2R&start=100&end=200&dataset_id=ds1&sample_seed=paper');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('renders before speculative margins, yields to foreground requests and cancels on panel close', async () => {
  const { getCompactReads, cancelReadPrefetch } = await import('./readOperations');
  const { fetchJson } = await import('./sharedFetch');
  const { markReadViewDrawn } = await import('../utils/viewIdle');
  const { readBinaryBytes, readRegionProjectionSafe, readAlignmentBounds } = await import('./readBinary');
  const { clearLoadedReadRegions } = await import('./loadedReadRegion');
  clearLoadedReadRegions();
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const params = new URLSearchParams({ chrom: 'chr1', start: '100', end: '200', dataset_id: 'progressive',
    full_working_set: 'true', spanning: 'false', hide_terminal_gaps: 'false', terminal_gap_threshold: '0', max_reads: '1000' });
  const data = { count: 1, total: 1, total_overlapping: 1, working_count: 1, width: 100,
    reads: [{ id: 'one', intervals: [[0, 100, 100]] }] };
  readBinaryBytes.set(data, 100);
  readRegionProjectionSafe.add(data);
  readAlignmentBounds.set(data.reads[0], [100, 200]);
  let prefetchSignal: AbortSignal | undefined;
  let finishAnalysis: (response: Response) => void = () => {};
  const fetchMock = vi.fn((url: string, options: RequestInit) => {
    if (url === '/api/scan_peaks') return new Promise<Response>(resolve => { finishAnalysis = resolve; });
    if (url.includes('prefetch=true')) {
      prefetchSignal = options.signal!;
      return new Promise<Response>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    }
    return Promise.resolve({ ok: true, json: async () => data } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    expect(await getCompactReads(params)).toBe(data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const visible = new URL(fetchMock.mock.calls[0][0], 'http://localhost').searchParams;
    expect([visible.get('start'), visible.get('end')]).toEqual(['100', '200']);
    // A slow final redraw must not consume the delay before it can paint.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const analysis = fetchJson('/api/scan_peaks', { method: 'POST' });
    markReadViewDrawn();
    while (frames.length) frames.shift()!(0);
    await vi.advanceTimersByTimeAsync(750);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prefetchSignal).toBeUndefined();
    finishAnalysis({ ok: true, json: async () => ({}) } as Response);
    await analysis;
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(prefetchSignal?.aborted).toBe(false);
    cancelReadPrefetch('progressive');
    await vi.advanceTimersByTimeAsync(1);
    expect(prefetchSignal?.aborted).toBe(true);
    await getCompactReads(params);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    frames.shift()!(0);
    frames.shift()!(0);
    await vi.advanceTimersByTimeAsync(750);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    cancelReadPrefetch('progressive');
    await vi.advanceTimersByTimeAsync(1);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearLoadedReadRegions();
  }
});

it('fills overlapping neighborhoods outward and shares the queue across batch members', async () => {
  const { getCompactReadsAll, setReadPrefetchMargin } = await import('./readOperations');
  const { markReadViewDrawn } = await import('../utils/viewIdle');
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const data = { datasets: { a: { reads: [{ id: 'one' }] }, b: { reads: [{ id: 'two' }] } } };
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('prefetch=true') ? { reads: [] } : data }) as Response);
  vi.stubGlobal('fetch', fetch);
  setReadPrefetchMargin(1, 20);
  const params = new URLSearchParams({ dataset_ids: 'a,b', chrom: 'chr1', start: '10000', end: '10100', max_reads: '500' });
  try {
    await Promise.all([getCompactReadsAll(params), getCompactReadsAll(params)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
    markReadViewDrawn();
    while (frames.length) frames.shift()!(0);
    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url] of fetch.mock.calls.slice(1)) {
      const query = new URL(url, 'http://localhost').searchParams;
      expect([query.get('start'), query.get('end')]).toEqual(['9800', '10300']);
      expect(query.get('max_reads')).toBe('1');
      expect(query.get('full_working_set')).toBe('true');
      expect(query.get('prefetch_batch')).toBe('true');
    }
    expect(fetch.mock.calls.slice(1).map(([url]) => new URL(url, 'http://localhost').searchParams.get('dataset_id'))).toEqual(['a', 'b']);
    await getCompactReadsAll(params); // sampled batch revisit is retained too
    while (frames.length) frames.shift()!(0);
    await vi.advanceTimersByTimeAsync(20000);
    const fills = fetch.mock.calls.slice(1).map(([url]) => new URL(url, 'http://localhost').searchParams);
    expect(fills.every(q => q.get('prefetch') === 'true')).toBe(true);
    expect(new Set(fetch.mock.calls.map(([url]) => url)).size).toBe(fetch.mock.calls.length);
    for (const id of ['a', 'b']) {
      const windows = fills.filter(q => q.get('dataset_id') === id);
      expect(windows.length).toBeGreaterThan(3);
      expect(Math.min(...windows.map(q => Number(q.get('start'))))).toBeLessThanOrEqual(9050);
      expect(Math.max(...windows.map(q => Number(q.get('end'))))).toBeGreaterThanOrEqual(11050);
    }
  } finally {
    setReadPrefetchMargin(0.5);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('preserves an unfinished nearby fill through pans and cancels it on a distant jump', async () => {
  const { getCompactReads, setReadPrefetchMargin } = await import('./readOperations');
  const { clearLoadedReadRegions } = await import('./loadedReadRegion');
  const { markReadViewDrawn } = await import('../utils/viewIdle');
  clearLoadedReadRegions();
  setReadPrefetchMargin(1, 20);
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const fills: Array<{ query: URLSearchParams; signal: AbortSignal; finish: () => void }> = [];
  const fetch = vi.fn((url: string, options: RequestInit) => {
    const query = new URL(url, 'http://localhost').searchParams;
    const data = { reads: [{ id: 'sample' }], working_sampling: { level: 2 } };
    if (query.get('prefetch') === 'true') return new Promise<Response>((resolve, reject) => {
      fills.push({ query, signal: options.signal!, finish: () => resolve({ ok: true, json: async () => ({ reads: [] }) } as Response) });
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    return Promise.resolve({ ok: true, json: async () => data } as Response);
  });
  vi.stubGlobal('fetch', fetch);
  const params = (start: number) => new URLSearchParams({ dataset_id: 'nearby', chrom: 'chr1', start: String(start), end: String(start + 100), max_reads: '500' });
  const paint = () => { markReadViewDrawn(); while (frames.length) frames.shift()!(0); };
  try {
    await getCompactReads(params(10000));
    paint();
    await vi.advanceTimersByTimeAsync(1500);
    expect(fills).toHaveLength(1);
    expect(fills[0].query.get('prefetch_sample_level')).toBe('2');
    expect(fills[0].query.get('full_working_set')).toBe('false');
    await getCompactReads(params(10050));
    paint();
    await vi.advanceTimersByTimeAsync(1500);
    expect(fills[0].signal.aborted).toBe(false);
    expect(fills).toHaveLength(1);
    fills[0].finish();
    await vi.advanceTimersByTimeAsync(1500);
    expect(fills).toHaveLength(2);
    expect(fills[1].query.get('start')).not.toBe(fills[0].query.get('start'));
    await getCompactReads(params(10000)); // return reuses the exact sample and retains outward progress
    expect(fetch.mock.calls.filter(([url]) => !url.includes('prefetch=true'))).toHaveLength(2);
    expect(fills[1].signal.aborted).toBe(false);
    await getCompactReads(params(1000000));
    await vi.advanceTimersByTimeAsync(1);
    expect(fills[1].signal.aborted).toBe(true);
  } finally {
    setReadPrefetchMargin(0.5);
    await vi.advanceTimersByTimeAsync(1);
    clearLoadedReadRegions();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('keeps one fill per live-lift haplotype panel of the same dataset, and cancels both on panel close', async () => {
  const { getCompactReads, setReadPrefetchMargin, cancelReadPrefetch } = await import('./readOperations');
  const { clearLoadedReadRegions } = await import('./loadedReadRegion');
  const { markReadViewDrawn } = await import('../utils/viewIdle');
  clearLoadedReadRegions();
  setReadPrefetchMargin(1, 20);
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const fills: Array<{ query: URLSearchParams; signal: AbortSignal; finish: () => void }> = [];
  const fetch = vi.fn((url: string, options: RequestInit) => {
    const query = new URL(url, 'http://localhost').searchParams;
    if (query.get('prefetch') === 'true') return new Promise<Response>((resolve, reject) => {
      fills.push({ query, signal: options.signal!, finish: () => resolve({ ok: true, json: async () => ({ reads: [] }) } as Response) });
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    return Promise.resolve({ ok: true, json: async () => ({ reads: [{ id: `${query.get('lift_hap')}:${query.get('start')}` }] }) } as Response);
  });
  vi.stubGlobal('fetch', fetch);
  const params = (hap: string, start: number) => new URLSearchParams({ dataset_id: 'lifted', lift_hap: hap, chrom: 'chr1',
    start: String(start), end: String(start + 100), max_reads: '500' });
  const paint = () => { markReadViewDrawn(); while (frames.length) frames.shift()!(0); };
  try {
    // Both panels load their view, then pan together: neither request cancels the other panel's fill.
    await Promise.all([getCompactReads(params('MAT', 10000)), getCompactReads(params('PAT', 10000))]);
    paint();
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([getCompactReads(params('MAT', 10050)), getCompactReads(params('PAT', 10050))]);
    paint();
    await vi.advanceTimersByTimeAsync(1500);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.some(f => f.signal.aborted)).toBe(false);
    // The queue runs one fill at a time: finishing each lets the other panel's next tile go.
    for (let i = 0; i < 4 && i < fills.length; i++) {
      fills[i].finish();
      await vi.advanceTimersByTimeAsync(1500);
    }
    expect(fills.some(f => f.signal.aborted)).toBe(false);
    expect(new Set(fills.map(f => f.query.get('lift_hap')))).toEqual(new Set(['MAT', 'PAT']));
    const open = fills.filter((_f, i) => i >= 4);
    expect(open.length).toBeGreaterThan(0);
    cancelReadPrefetch('lifted');
    await vi.advanceTimersByTimeAsync(1);
    expect(open.every(f => f.signal.aborted)).toBe(true);
  } finally {
    setReadPrefetchMargin(0.5);
    await vi.advanceTimersByTimeAsync(1);
    clearLoadedReadRegions();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
