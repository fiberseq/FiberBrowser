import { afterEach, describe, expect, it, vi } from 'vitest';
import { clusterAllReads } from './clustering';
import { sortReads } from './readOperations';

/** fb-r3-tsne: the graph cluster method's resolution and the projection sort's map settings. */
describe('projection-related requests', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const stubFetch = () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ results: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const body = (fetchMock: ReturnType<typeof stubFetch>) => JSON.parse(String(fetchMock.mock.calls[0][1]?.body));

  it('sends the resolution with the graph method only', async () => {
    let fetchMock = stubFetch();
    await clusterAllReads('chr1', 0, 100, [{ start: 10, end: 20 }], 5, false, ['ds1'], 'graph',
      undefined, undefined, 90, 0.5, undefined, undefined, undefined, undefined, { resolution: 1.5 });
    expect(body(fetchMock)).toMatchObject({ method: 'graph', resolution: 1.5 });

    fetchMock = stubFetch();
    await clusterAllReads('chr1', 0, 100, [{ start: 10, end: 20 }], 5, false, ['ds1'], 'kmeans',
      undefined, undefined, 90, 0.5, undefined, undefined, undefined, undefined, { resolution: 1.5 });
    expect(body(fetchMock)).not.toHaveProperty('resolution');
  });

  it('sends the map settings with a projection sort', async () => {
    const fetchMock = stubFetch();
    await sortReads('chr1', 0, 100, false, ['ds1'], 'projection', {
      projection: { peakRegions: [{ start: 10, end: 20, mode: 'tf' }], clusterFeatureRules: [], subnucleosomalThreshold: 80, clusterAssignments: { ds1: { r1: 0, r2: 1 } } },
      sampleSeed: 'seed',
    });
    expect(body(fetchMock)).toMatchObject({
      sort_by: 'projection',
      sample_seed: 'seed',
      projection: { peak_regions: [{ start: 10, end: 20, mode: 'tf' }], cluster_feature_rules: [], subnucleosomal_threshold: 80, cluster_assignments: { ds1: { r1: 0, r2: 1 } } },
    });
  });
});
