import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStatus } from './status';

describe('status API client', () => {
  it('fetches browser status with credentials', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ datasets: 1, chroms: 2, has_gtf: true, gene_count: 3, track_count: 4 }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const status = await getStatus();

    expect(status.datasets).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(['/api/status', { credentials: 'include' }]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
