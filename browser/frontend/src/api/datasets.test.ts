import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDataset,
  mergeDatasets,
  refreshDatasetCapabilities,
  removeDataset,
  unmergeDataset,
} from './datasets';

describe('dataset API client', () => {
  it('serializes single and multi-file dataset loads', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await addDataset('/tmp/a.bam', 'A');
    await addDataset(['/tmp/a.bam', '/tmp/b.bam'], 'Merged');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/datasets/add');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      path: '/tmp/a.bam',
      label: 'A',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      paths: ['/tmp/a.bam', '/tmp/b.bam'],
      label: 'Merged',
    });
  });

  it('serializes dataset capability refresh and removal', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await refreshDatasetCapabilities('ds/with space');
    await removeDataset('ds1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/datasets/ds%2Fwith%20space/refresh_capabilities');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/datasets/ds1');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE', credentials: 'include' });
  });

  it('serializes merge and unmerge requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await mergeDatasets(['ds1', 'ds2'], 'merged');
    await unmergeDataset('merged');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/datasets/merge');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      dataset_ids: ['ds1', 'ds2'],
      label: 'merged',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/datasets/unmerge');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ dataset_id: 'merged' });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
