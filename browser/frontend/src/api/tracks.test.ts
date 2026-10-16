import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addMotifPwmTrack,
  addMotifSequenceTrack,
  addTrack,
  exportTrack,
  exportTracksMulti,
  getBigBedNames,
  getTrackAnnotations,
  updateTrackFilter,
} from './tracks';

describe('track API client', () => {
  it('serializes track annotation and BigBed name lookups', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ label: 'track', intervals: [], names: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await getTrackAnnotations(4, 'chr2R', 100, 200, ['Pol2', 'GAF'], { signal: controller.signal });
    await getBigBedNames('/tmp/calls.bb', 'dm6');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const annotationsUrl = new URL(String(fetchMock.mock.calls[0][0]), 'http://fiberbrowser.test');
    expect(annotationsUrl.pathname).toBe('/api/tracks/4/annotations');
    expect(annotationsUrl.searchParams.get('filter_names')).toBe('Pol2,GAF');
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);

    const namesUrl = new URL(String(fetchMock.mock.calls[1][0]), 'http://fiberbrowser.test');
    expect(namesUrl.pathname).toBe('/api/bigbed/names');
    expect(namesUrl.searchParams.get('url')).toBe('/tmp/calls.bb');
    expect(namesUrl.searchParams.get('genome')).toBe('dm6');
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

  it('serializes track mutation requests', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await addTrack('/tmp/a.bb', 'Calls', ['Pol2'], 'motif');
    await updateTrackFilter(2, ['GAF']);
    await addMotifSequenceTrack('GATAAG', 'GATA motif', 0.9);
    await addMotifPwmTrack('PWM1', { A: [1, 0], C: [0, 1], G: [0, 0], T: [0, 0] }, 'PWM track', 0.8);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const addUrl = new URL(String(fetchMock.mock.calls[0][0]), 'http://fiberbrowser.test');
    expect(addUrl.pathname).toBe('/api/add_track');
    expect(addUrl.searchParams.get('label')).toBe('Calls');
    expect(addUrl.searchParams.get('filter_names')).toBe('Pol2');
    expect(addUrl.searchParams.get('category')).toBe('motif');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/tracks/2/filter');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ filter_names: ['GAF'] });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/tracks/add_motif_sequence');
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      sequence: 'GATAAG',
      label: 'GATA motif',
      threshold: 0.9,
    });
    expect(fetchMock.mock.calls[3][0]).toBe('/api/tracks/add_motif_pwm');
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({
      name: 'PWM1',
      counts: { A: [1, 0], C: [0, 1], G: [0, 0], T: [0, 0] },
      label: 'PWM track',
      threshold: 0.8,
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
