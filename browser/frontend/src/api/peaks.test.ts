import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanPeaks } from './peaks';

describe('peak API client', () => {
  it('serializes peak scan scope, thresholds, and abort signals', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ peaks: [], layer_info: [], n_reads: 0, mode: 'Fast' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await scanPeaks(
      'chr2R',
      100,
      200,
      80,
      5,
      undefined,
      undefined,
      {
        smoothWidth: 75,
        thresholdStrong: 0.6,
        thresholdMedium: 0.4,
        thresholdWeak: 0.2,
        thresholdRare: 0.1,
      },
      undefined,
      { ds2: ['r1', 'r2'] },
      'tf_layer',
      true,
      'scan-seed',
      ['ds2'],
      { signal: controller.signal },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), 'http://fiberbrowser.test');
    expect(parsed.pathname).toBe('/api/scan_peaks');
    expect(init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      read_ids_by_dataset: { ds2: ['r1', 'r2'] },
      dataset_ids: ['ds2'],
      smooth_width: 75,
      threshold_strong: 0.6,
      signal_source: 'tf_layer',
      return_signal: true,
      sample_seed: 'scan-seed',
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
