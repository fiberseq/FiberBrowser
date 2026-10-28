import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignToClusters, autoCullClusters, clusterAllReads, clusterMatchedViews, dissolveCluster, fetchClusterProjection, fetchClusterVPlot } from './clustering';

describe('clustering API client', () => {
  it('requests early preparation only when explicitly configured', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true, json: async () => ({ results: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    for (const preparationSampleCount of [10000, null]) {
      await clusterAllReads('chr1', 0, 100, [], 5, false, ['ds1'], 'kmeans',
        undefined, undefined, 90, 0.5, undefined, 'seed', undefined, undefined,
        { preparationSampleCount });
    }
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).preparation_sample_count).toBe(10000);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).not.toHaveProperty('preparation_sample_count');
  });
  it('serializes shared clustering scope and reproducibility options', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ results: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await clusterAllReads(
      'chr2R',
      100,
      200,
      [{ start: 120, end: 150, mode: 'tf' }],
      8,
      true,
      ['ds1', 'ds2'],
      'kmeans',
      { ds1: ['r1'], ds2: ['r2', 'r3'] },
      5000,
      80,
      0.7,
      ['chr2R_hap2'],
      'paper-seed',
      [{
        id: 'short_tf',
        name: 'Short TF',
        enabled: true,
        terms: [{ id: 't1', source: 'layer', layer: 'tf', sizeMin: 1, sizeMax: 40 }],
      }],
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), 'http://fiberbrowser.test');
    expect(parsed.pathname).toBe('/api/cluster_all');
    expect(parsed.searchParams.get('spanning')).toBe('true');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      peak_regions: [{ start: 120, end: 150, mode: 'tf' }],
      k: 8,
      method: 'kmeans',
      dataset_ids: ['ds1', 'ds2'],
      subnucleosomal_threshold: 80,
      accessibility_threshold: 0.7,
      read_ids: { ds1: ['r1'], ds2: ['r2', 'r3'] },
      max_reads: 5000,
      sample_seed: 'paper-seed',
      extra_chroms: ['chr2R_hap2'],
      cluster_feature_rules: [{
        id: 'short_tf',
        name: 'Short TF',
        enabled: true,
        terms: [{ id: 't1', source: 'layer', layer: 'tf', sizeMin: 1, sizeMax: 40 }],
      }],
    });
  });

  it('forwards projection settings and abort signals', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ coords_x: [], coords_y: [], read_ids: [], dataset_ids: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await fetchClusterProjection(
      'chr2R',
      100,
      200,
      ['ds1'],
      [{ start: 120, end: 150 }],
      'umap',
      false,
      {
        simulateAutocull: true,
        minFraction: 0.04,
        maxCosineSimilarity: 0.91,
        subnucleosomalThreshold: 75,
        accessibilityThreshold: 0.6,
        nComponents: 2,
        sampleSeed: 'projection-seed',
        signal: controller.signal,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), 'http://fiberbrowser.test');
    expect(parsed.pathname).toBe('/api/cluster_projection');
    expect(parsed.searchParams.get('spanning')).toBe('false');
    expect(init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      dataset_ids: ['ds1'],
      peak_regions: [{ start: 120, end: 150 }],
      method: 'umap',
      simulate_autocull: true,
      min_fraction: 0.04,
      max_cosine_similarity: 0.91,
      subnucleosomal_threshold: 75,
      accessibility_threshold: 0.6,
      sample_seed: 'projection-seed',
    });
  });

  it('serializes matched-domain comparison clustering', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ results: {}, label_space: 'shared' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await clusterMatchedViews({
      views: [{
        id: 'view1', chrom: 'hap1', start: 100, end: 500,
        panels: [{ dataset_id: 'ds1', result_key: 'ds1:hap:1', read_ids: ['r1'] }],
        peak_regions: [{ start: 180, end: 260, mode: 'accessibility' }],
      }, {
        id: 'view2', chrom: 'hap2', start: 900, end: 1400,
        panels: [{ dataset_id: 'ds2', result_key: 'ds2:hap:2', strand: 'GA' }],
        peak_regions: [{ start: 1030, end: 1150, mode: 'accessibility' }],
        reverse: true,
      }],
      mode: 'joint',
      k: 4,
      method: 'kmeans',
      balanceViews: false,
      maxReads: 2000,
      sampleSeed: 'paired-seed',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url), 'http://fiberbrowser.test').pathname).toBe('/api/cluster_matched_views');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      views: [
        { id: 'view1', chrom: 'hap1', start: 100, end: 500,
          panels: [{ dataset_id: 'ds1', result_key: 'ds1:hap:1', read_ids: ['r1'] }],
          peak_regions: [{ start: 180, end: 260, mode: 'accessibility' }] },
        { id: 'view2', chrom: 'hap2', start: 900, end: 1400,
          panels: [{ dataset_id: 'ds2', result_key: 'ds2:hap:2', strand: 'GA' }],
          peak_regions: [{ start: 1030, end: 1150, mode: 'accessibility' }], reverse: true },
      ],
      mode: 'joint',
      k: 4,
      method: 'kmeans',
      bins_per_feature: 20,
      balance_views: false,
      max_reads: 2000,
      sample_seed: 'paired-seed',
      subnucleosomal_threshold: 90,
      accessibility_threshold: 0.5,
    });
  });

  it('serializes V-plot layer and smoothing options', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, data: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await fetchClusterVPlot('chr2R', 100, 200, {
      sizeBin: 10,
      posBin: 20,
      sizeMin: 30,
      sizeMax: 250,
      logNorm: false,
      smooth: 2,
      layer: 'tf',
      normalize: 'shared',
      sampleSeed: 'vplot-seed',
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), 'http://fiberbrowser.test');
    expect(parsed.pathname).toBe('/api/cluster/vplot');
    expect(parsed.searchParams.get('region_start')).toBe('100');
    expect(parsed.searchParams.get('region_end')).toBe('200');
    expect(init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(init?.body))).toEqual({
      size_bin: 10,
      pos_bin: 20,
      size_min: 30,
      size_max: 250,
      log_norm: false,
      smooth: 2,
      layer: 'tf',
      normalize: 'shared',
      mode: 'midpoint',
      row_normalize: false,
      sample_seed: 'vplot-seed',
    });

    // The full-footprint V-plot with per-size-row enrichment (fb-n5-charts).
    await fetchClusterVPlot('chr2R', 100, 200, { mode: 'span', rowNormalize: true });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ mode: 'span', row_normalize: true });
  });
});

describe('dynamic assignment request', () => {
  it('sends the fit\'s metric cohort with patterns or centroids, and nothing without one (Codex C2-1)', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true, json: async () => ({ results: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const cohort = { 'nuc.nrl': { values: [180, 190, 200, 210], counts: [1, 1, 1, 1] } };
    const peaks = [{ start: 0, end: 100, mode: 'cluster_rule:m' as const }];
    await assignToClusters('chr1', 0, 100, peaks, { 0: [0], 1: [1] }, ['ds1'], false, 90, 0.5, { metricCohort: cohort });
    await assignToClusters('chr1', 0, 100, peaks, {}, ['ds1'], false, 90, 0.5,
      { centroids: { 0: [0.25], 1: [0.75] }, peakWidths: [1], metricCohort: cohort });
    await assignToClusters('chr1', 0, 100, peaks, { 0: [0], 1: [1] }, ['ds1'], false, 90, 0.5, { metricCohort: {} });
    const bodies = fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(bodies[0].cluster_metric_cohort).toEqual(cohort);
    expect(bodies[1].cluster_metric_cohort).toEqual(cohort);
    expect(bodies[1].cluster_centroids).toEqual({ 0: [0.25], 1: [0.75] });
    expect(bodies[2]).not.toHaveProperty('cluster_metric_cohort');
  });
});

describe('merge and projection requests', () => {
  it('send the fit\'s metric cohort when there is one, and nothing for an empty one', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true, json: async () => ({ results: {}, dissolved: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const cohort = { 'nuc.nrl': { values: [180, 190, 200, 210], counts: [1, 1, 1, 1] } };
    const peaks = [{ start: 0, end: 100, mode: 'cluster_rule:m' as const }];
    const assignments = { ds1: { r1: 0, r2: 1 } };
    for (const metricCohort of [cohort, {}]) {
      await dissolveCluster('chr1', 0, 100, 1, assignments, peaks, ['ds1'], false, 90, 0.5, 'seed', [], null, { metricCohort });
      await autoCullClusters('chr1', 0, 100, assignments, peaks, ['ds1'], false, 90, 0.5, 0.05, 0.95, 'seed', [], null,
        undefined, { metricCohort });
      await fetchClusterProjection('chr1', 0, 100, ['ds1'], peaks, 'pca', false, { clusterAssignments: assignments, metricCohort });
    }
    const calls = fetchMock.mock.calls.map(call => ({ path: new URL(String(call[0]), 'http://x').pathname, body: JSON.parse(String(call[1]?.body)) }));
    expect(calls.map(c => c.path)).toEqual([
      '/api/dissolve_cluster', '/api/auto_cull_clusters', '/api/cluster_projection',
      '/api/dissolve_cluster', '/api/auto_cull_clusters', '/api/cluster_projection',
    ]);
    for (const call of calls.slice(0, 3)) expect(call.body.cluster_metric_cohort).toEqual(cohort);
    for (const call of calls.slice(3)) expect(call.body).not.toHaveProperty('cluster_metric_cohort');
    // Callers that pass no options send none either.
    await dissolveCluster('chr1', 0, 100, 1, assignments, peaks, ['ds1'], false);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).not.toHaveProperty('cluster_metric_cohort');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
