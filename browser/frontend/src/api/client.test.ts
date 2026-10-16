import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compactReadsQueryKey,
  coverageQueryKey,
  exportDerivedLayers,
  exportTrack,
  exportTracksMulti,
  getCoaccArcs,
  getCoaccMetadata,
  getCoaccSlice,
  getCoaccStripUrl,
  getCoverage,
  getPrimerProgress,
  linkedCompactReadsQueryKey,
  scanPeaks,
  loadDerivedLayers,
  loadFootprintRules,
  saveFootprintRules,
  abortPrimerDesign,
  clusterByAnnotations,
  design4cPrimers,
  designDafcPrimers,
  designPrimers,
  getAnnotationProfile,
  getAnnotationsForRegion,
  getChipAtlasFacets,
  getEncodeFacets,
  getGenomes,
  getUcscCurated,
  browseUcscTracks,
  filterByAnnotations,
  searchChipAtlas,
  searchEncode,
  searchGene,
} from './client';

describe('compact read request keys', () => {
  it('sorts query params so identical compact requests coalesce', () => {
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
    expect(compactReadsQueryKey(a)).toContain('/api/reads/compact?');
  });

  it('keeps linked compact requests in a separate namespace', () => {
    const params = new URLSearchParams({ session_id: 'abc', region: 'x' });

    expect(linkedCompactReadsQueryKey(params)).toContain('/api/linked/reads/compact?');
    expect(linkedCompactReadsQueryKey(params)).not.toBe(compactReadsQueryKey(params));
  });

  it('sorts coverage query params for shared zoomed-out requests', () => {
    const a = new URLSearchParams();
    a.set('chrom', 'chr2R');
    a.set('start', '100');
    a.set('end', '200');
    a.set('bins', '400');
    a.set('dataset_id', 'ds1');

    const b = new URLSearchParams();
    b.set('dataset_id', 'ds1');
    b.set('bins', '400');
    b.set('end', '200');
    b.set('start', '100');
    b.set('chrom', 'chr2R');

    expect(coverageQueryKey(a)).toBe(coverageQueryKey(b));
    expect(coverageQueryKey(a)).toContain('/api/coverage?');
  });

  it('sends coverage requests through the abort-aware shared GET path', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ coverage: [1, 2], max: 2 }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await getCoverage('chr2R', 100, 200, 400, 'ds1', { signal: new AbortController().signal });

    expect(res).toEqual({ coverage: [1, 2], max: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), 'http://fiberbrowser.test');
    expect(parsed.pathname).toBe('/api/coverage');
    expect(parsed.searchParams.get('dataset_id')).toBe('ds1');
    expect(init?.credentials).toBe('include');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not start coverage fetches for already-aborted consumers', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(getCoverage('chr2R', 100, 200, 400, 'ds1', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes scan peak dataset scope in the request body', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ peaks: [], layer_info: [], n_reads: 0, mode: 'Fast' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await scanPeaks(
      'chr2R',
      100,
      200,
      80,
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      { ds2: ['r1', 'r2'] },
      'tf_layer',
      true,
      'scan-seed',
      ['ds2'],
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), 'http://fiberbrowser.test');
    expect(parsed.pathname).toBe('/api/scan_peaks');
    expect(parsed.searchParams.get('chrom')).toBe('chr2R');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      read_ids_by_dataset: { ds2: ['r1', 'r2'] },
      dataset_ids: ['ds2'],
      signal_source: 'tf_layer',
      return_signal: true,
      sample_seed: 'scan-seed',
    });
  });

  it('sends credentials for track export downloads', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      blob: async () => new Blob(['track']),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await exportTrack(3, 'chr2R', 100, 200, 'tsv', 50);
    await exportTracksMulti([1, 2], ['A', 'B'], 'chr2R', 100, 200, 50);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('maps co-accessibility strip signal scope into query params', () => {
    const url = getCoaccStripUrl('chr2R', 100, 200, {
      datasetIds: ['ds1', 'ds2'],
      signalType: 'nucleosome',
      layer: 'tf',
      readIdsByDataset: { ds1: ['r1'], ds2: ['r2', 'r3'] },
      sampleSeed: 'paper',
    });
    const parsed = new URL(url, 'http://fiberbrowser.test');

    expect(parsed.searchParams.get('dataset_ids')).toBe('ds1,ds2');
    expect(parsed.searchParams.get('signal_type')).toBe('nucleosome');
    expect(parsed.searchParams.get('layer')).toBe('tf');
    expect(JSON.parse(parsed.searchParams.get('read_ids_by_dataset') ?? '{}')).toEqual({
      ds1: ['r1'],
      ds2: ['r2', 'r3'],
    });
    expect(parsed.searchParams.get('sample_seed')).toBe('paper');
  });

  it('preserves explicit empty co-accessibility dataset scopes', () => {
    const url = getCoaccStripUrl('chr2R', 100, 200, {
      datasetIds: ['ds1', 'ds2'],
      readIdsByDataset: { ds1: [], ds2: ['r2'] },
    });
    const parsed = new URL(url, 'http://fiberbrowser.test');

    expect(JSON.parse(parsed.searchParams.get('read_ids_by_dataset') ?? '{}')).toEqual({
      ds1: [],
      ds2: ['r2'],
    });
  });

  it('serializes co-accessibility track dataset scope for arcs and virtual 4C', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ arcs: [], profile: [], coverage: [], n_bins: 0 }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await getCoaccArcs('chr2R', 100, 200, {
      datasetIds: ['ds1', 'ds2'],
      normalization: 'oe_distance',
      sampleSeed: 'paper',
    });
    await getCoaccSlice('chr2R', 100, 200, 150, {
      datasetIds: ['ds1', 'ds2'],
      normalization: 'correlation',
      sampleSeed: 'paper',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const arcsUrl = new URL(String(fetchMock.mock.calls[0][0]), 'http://fiberbrowser.test');
    const sliceUrl = new URL(String(fetchMock.mock.calls[1][0]), 'http://fiberbrowser.test');
    expect(arcsUrl.pathname).toBe('/api/coacc/arcs');
    expect(arcsUrl.searchParams.get('dataset_ids')).toBe('ds1,ds2');
    expect(arcsUrl.searchParams.get('normalization')).toBe('oe_distance');
    expect(sliceUrl.pathname).toBe('/api/coacc/slice');
    expect(sliceUrl.searchParams.get('dataset_ids')).toBe('ds1,ds2');
    expect(sliceUrl.searchParams.get('normalization')).toBe('correlation');
    expect(sliceUrl.searchParams.get('sample_seed')).toBe('paper');
  });

  it('serializes co-accessibility metadata normalization', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ n_bins: 0, n_reads: 0 }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await getCoaccMetadata('chr2R', 100, 200, {
      datasetIds: ['ds1'],
      normalization: 'correlation',
      sampleSeed: 'paper',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const metadataUrl = new URL(String(fetchMock.mock.calls[0][0]), 'http://fiberbrowser.test');
    expect(metadataUrl.pathname).toBe('/api/coacc/metadata');
    expect(metadataUrl.searchParams.get('dataset_ids')).toBe('ds1');
    expect(metadataUrl.searchParams.get('normalization')).toBe('correlation');
    expect(metadataUrl.searchParams.get('sample_seed')).toBe('paper');
  });

  it('serializes annotation filters with dataset scope and sample seed', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ read_ids: ['r1'], total: 2, filtered: 1 }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await filterByAnnotations(['GAF'], 'has_any', 'chr2R', 100, 200, ['ds1'], 'paper');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/annotations/filter');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      annotation_types: ['GAF'],
      filter_mode: 'has_any',
      chrom: 'chr2R',
      start: 100,
      end: 200,
      dataset_ids: ['ds1'],
      sample_seed: 'paper',
    });
  });

  it('forwards abort signals to annotation requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ annotations: {}, types: [], profiles: {}, read_ids: [], total: 0, filtered: 0, assignments: {}, order: [], patterns: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await getAnnotationsForRegion('chr2R', 100, 200, ['ds1'], ['file1'], 'paper', { signal: controller.signal });
    await getAnnotationProfile('chr2R', 100, 200, 'ds1', ['GAF'], undefined, { signal: controller.signal });
    await filterByAnnotations(['GAF'], 'has_any', 'chr2R', 100, 200, ['ds1'], 'paper', { signal: controller.signal });
    await clusterByAnnotations([{ start: 120, end: 160 }], ['GAF'], 'combinatorial', 5, ['ds1'], 'chr2R', 100, 200, 'paper', { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
    }
  });

  it('forwards abort signals to gene search requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ found: false, suggestions: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await searchGene('eve', { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/gene_search?query=eve');
    expect(init?.signal).toBe(controller.signal);
  });

  it('forwards abort signals to online track catalog requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ genomes: [], tracks: [], groups: {}, supported: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await getGenomes({ signal: controller.signal });
    await getUcscCurated('dm6', { signal: controller.signal });
    await browseUcscTracks('dm6', { signal: controller.signal });
    await getEncodeFacets('hg38', { signal: controller.signal });
    await searchEncode('hg38', undefined, undefined, undefined, 'CTCF', 25, { signal: controller.signal });
    await getChipAtlasFacets('dm6', { signal: controller.signal });
    await searchChipAtlas('dm6', undefined, 'Pol2', undefined, undefined, 25, { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
    }
  });

  it('serializes derived-layer export requests for cart materialization', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, bundles: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await exportDerivedLayers('chr2R', 100, 200, true, {
      dataset_ids: ['ds1'],
      groups: [{ id: 'g1', name: 'Short TF', layer: 'tf', enabled: true } as any],
      output_dir: '/tmp/out',
      bundle_name: 'cart',
      sample_seed: 'paper-seed',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/footprint/derived_layers/export?chrom=chr2R&region_start=100&region_end=200&spanning=true');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      dataset_ids: ['ds1'],
      groups: [{ id: 'g1', name: 'Short TF', layer: 'tf', enabled: true }],
      output_dir: '/tmp/out',
      bundle_name: 'cart',
      sample_seed: 'paper-seed',
    });
  });

  it('serializes derived-layer load requests for saved bundles', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, attached: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await loadDerivedLayers('/tmp/cart.fiberlayers.json', ['ds1']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/footprint/derived_layers/load');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      path: '/tmp/cart.fiberlayers.json',
      dataset_ids: ['ds1'],
    });
  });

  it('serializes footprint rule save requests for portable carts', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, path: '/tmp/cart.fiberlayer-rules.json', n_rules: 1 }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await saveFootprintRules({
      groups: [{ id: 'g1', name: 'Short TF', layer: 'tf', enabled: true } as any],
      output_dir: '/tmp/out',
      bundle_name: 'cart',
      chrom: 'chr2R',
      start: 100,
      end: 200,
      spanning: true,
      dataset_ids: ['ds1'],
      sample_seed: 'paper-seed',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/footprint/rules/save');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: [{ id: 'g1', name: 'Short TF', layer: 'tf', enabled: true }],
      output_dir: '/tmp/out',
      bundle_name: 'cart',
      chrom: 'chr2R',
      start: 100,
      end: 200,
      spanning: true,
      dataset_ids: ['ds1'],
      sample_seed: 'paper-seed',
    });
  });

  it('serializes footprint rule load requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, groups: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await loadFootprintRules('/tmp/cart.fiberlayer-rules.json');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/footprint/rules/load');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      path: '/tmp/cart.fiberlayer-rules.json',
    });
  });

  it('uses shared API helpers for primer progress and abort', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        active: true,
        stage: 'blast',
        progress: 74,
        message: 'BLAST pass complete',
        details: { valid_pairs: 12, cached: 4, blasted: 18 },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const progress = await getPrimerProgress();
    await abortPrimerDesign();

    expect(progress.details).toEqual({ valid_pairs: 12, cached: 4, blasted: 18 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/primer_progress');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/primer_abort');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
    });
  });

  it('passes the shared sample seed to DAF-C primer design', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, quads: [], sample_seed: 'paper-v1' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await designDafcPrimers('chr2L', 100, 200, 1000, 1200, { sample_seed: 'paper-v1' }, 'chr3R');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/design_dafc_primers');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      chrom: 'chr2L',
      x_start: 100,
      x_end: 200,
      y_start: 1000,
      y_end: 1200,
      y_chrom: 'chr3R',
      sample_seed: 'paper-v1',
    });
  });

  it('forwards abort signals to primer design requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, pairs: [], quads: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await designPrimers('chr2L', 100, 200, {}, { signal: controller.signal });
    await design4cPrimers('chr2L', 100, 200, {}, { signal: controller.signal });
    await designDafcPrimers('chr2L', 100, 200, 1000, 1200, {}, undefined, { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
      expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
