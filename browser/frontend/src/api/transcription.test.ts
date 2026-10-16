import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPol2COM, filterByTranscriptionState } from './transcription';

describe('transcription API client', () => {
  it('serializes transcription-state filters and forwards abort signals', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ results: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await filterByTranscriptionState(
      'chr2R',
      100,
      200,
      true,
      ['ds1'],
      ['gene1'],
      { elongating_gte_1: true } as any,
      'paper',
      { signal: controller.signal },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/filter_by_transcription_state?chrom=chr2R&start=100&end=200&spanning=true');
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      dataset_ids: ['ds1'],
      gene_ids: ['gene1'],
      filters: { elongating_gte_1: true },
      sample_seed: 'paper',
    });
  });

  it('serializes Pol II center-of-mass settings', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ results: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await fetchPol2COM('chr2R', 100, 200, false, ['ds1'], ['gene1'], 20, 90, 50, 1.5, 'paper');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pol2_com?chrom=chr2R&start=100&end=200&spanning=false');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      dataset_ids: ['ds1'],
      gene_ids: ['gene1'],
      fp_size_min: 20,
      fp_size_max: 90,
      n_bins: 50,
      smoothing_sigma: 1.5,
      sample_seed: 'paper',
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
