import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLinkedSession,
  getAPA,
  getDafcMatrixData,
  getDafcStatus,
  getLinkedReadsCompact,
  getLinkedReadsData,
  getLinkedSession,
  getMicrocArcs,
  loadDafc,
  sendToLinkedSession,
} from './dafc';

describe('DAF-C API transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a Micro-C min distance of 0 ("Off") instead of leaving the 5 kb default', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ arcs: [], max_distance: 0, normalization: 'oe' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await getMicrocArcs('chr1', 0, 1000, { minDistance: 0 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('min_distance=0');
  });

  it('sends credentials on session-scoped DAF-C and Micro-C fetches', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true, arcs: [], apa: [] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await loadDafc('/tmp/contact.cool');
    await getDafcStatus();
    await getDafcMatrixData('chr2L', 10, 20, 30, 40, 5, 'balanced');
    await sendToLinkedSession('linked-1', {
      chrom: 'chr2L',
      x_start: 10,
      x_end: 20,
      y_start: 30,
      y_end: 40,
    }, ['read-a']);
    await getMicrocArcs('chr2L', 10, 100);
    await getAPA('chr2L', [{ start: 20, end: 30 }]);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe('include');
    }
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(String(fetchMock.mock.calls[2][0])).toContain('/api/dafc/matrix/data?');
    expect(String(fetchMock.mock.calls[2][0])).toContain('normalization=balanced');
    expect(fetchMock.mock.calls[3][1]?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(fetchMock.mock.calls[5][1]?.method).toBe('POST');
  });

  it('maps linked session semantics and compact read options', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        success: true,
        session_id: 'linked-1',
        session: {
          id: 'linked-1',
          version: 0,
          has_regions: false,
          has_reads: false,
          n_reads: 0,
          regions: null,
          contact_mode: null,
          split_view_mode: 'unassigned',
          split_view_semantics: { mode: 'unassigned' },
        },
        id: 'linked-1',
        version: 3,
        has_regions: true,
        has_reads: true,
        n_reads: 2,
        regions: null,
        reads: [],
        read_order: [],
        linked_reads: [],
        x_segment_names: [],
        y_segment_names: [],
        contact_mode: 'microc',
        split_view_mode: 'coordinate_synced',
        split_view_semantics: { mode: 'coordinate_synced' },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const created = await createLinkedSession();
    const session = await getLinkedSession('linked-1');
    const data = await getLinkedReadsData('linked-1');
    const compact = await getLinkedReadsCompact('linked-1', 'y', {
      maxReads: 250,
      sortBy: 'y',
      hideTerminalGaps: false,
      terminalGapThreshold: 0,
      sampleSeed: 'paper-v1',
    });

    expect(created.session?.split_view_mode).toBe('unassigned');
    expect(session.split_view_mode).toBe('coordinate_synced');
    expect(data.split_view_semantics?.mode).toBe('coordinate_synced');
    expect(compact.split_view_mode).toBe('coordinate_synced');

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toBe('/api/linked/session/create');
    expect(urls[1]).toBe('/api/linked/session/linked-1');
    expect(urls[2]).toBe('/api/linked/reads/data?session_id=linked-1');
    expect(urls[3]).toContain('/api/linked/reads/compact?');
    expect(urls[3]).toContain('hide_terminal_gaps=false');
    expect(urls[3]).toContain('max_reads=250');
    expect(urls[3]).toContain('region=y');
    expect(urls[3]).toContain('sample_seed=paper-v1');
    expect(urls[3]).toContain('sort_by=y');
    expect(urls[3]).toContain('terminal_gap_threshold=0');
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe('include');
    }
  });
});
