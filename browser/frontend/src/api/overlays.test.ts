import { afterEach, describe, expect, it, vi } from 'vitest';
import { addOverlay, getOverlayMarks, pickOverlayFile, removeOverlay } from './overlays';

describe('overlay API client', () => {
  it('serializes overlay mutation and picker requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await addOverlay('/tmp/mods.bb', 'm6a');
    await removeOverlay('ov1');
    await pickOverlayFile('m6a');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/overlays/add');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      path: '/tmp/mods.bb',
      type: 'm6a',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/overlays/ov1');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE', credentials: 'include' });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/pick_file?file_type=overlay&overlay_type=m6a');
  });

  it('forwards abort signals to overlay marks requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ marks: {} }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await getOverlayMarks('ov1', 'chr2R', 100, 200, { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/overlays/ov1/marks?chrom=chr2R&start=100&end=200');
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
