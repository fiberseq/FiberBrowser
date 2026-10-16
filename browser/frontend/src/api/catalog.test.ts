import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogLoad, catalogLoadFailure, catalogTrackLoad, catalogTrackUnload, catalogUnload, getCatalog } from './catalog';

describe('catalog API client', () => {
  it('serializes catalog load/unload endpoints', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, catalog: null }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await getCatalog();
    await catalogLoad(2);
    await catalogUnload(3);
    await catalogTrackLoad(4);
    await catalogTrackUnload(5);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/catalog');
    expect(fetchMock.mock.calls[1]).toEqual(['/api/catalog/load?group_index=2', { method: 'POST', credentials: 'include' }]);
    expect(fetchMock.mock.calls[2]).toEqual(['/api/catalog/unload?group_index=3', { method: 'POST', credentials: 'include' }]);
    expect(fetchMock.mock.calls[3]).toEqual(['/api/catalog/tracks/load?track_index=4', { method: 'POST', credentials: 'include' }]);
    expect(fetchMock.mock.calls[4]).toEqual(['/api/catalog/tracks/unload?track_index=5', { method: 'POST', credentials: 'include' }]);
  });
});

// fb-n1-s3: a group whose files could not be opened failed without a word.
describe('catalogLoadFailure', () => {
  it('names failed files, and is quiet when every file opened', () => {
    expect(catalogLoadFailure({ success: true, message: 'Loaded 2 dataset(s)' })).toBeNull();
    expect(catalogLoadFailure({ success: true, message: 'Already loaded' })).toBeNull();
    const partial = 'Loaded 1 dataset(s) (1 failed: Rep 2: s3://lab/rep2.bam: Object not found: s3://lab/rep2.bam (on AWS S3))';
    expect(catalogLoadFailure({ success: true, message: partial })).toBe(partial);
    expect(catalogLoadFailure({ success: false, message: 'Loaded 0 dataset(s) (1 failed: X: Access denied)' }))
      .toContain('Access denied');
    expect(catalogLoadFailure({ success: false })).toBe('Could not load the catalog group');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
