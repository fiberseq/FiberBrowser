import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';
import type { BrowserState } from '../stores/browserStore';
import type { PanelConfig } from '../types';
import { nextSortRequest } from '../utils/sortRequests';

vi.mock('../utils/copilotAnchors', () => ({
  highlightForAction: vi.fn(async () => undefined),
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));

const downloadSession = vi.fn(async (_name?: string | null) => 'fiberhmm_session_x.json');
vi.mock('../api/session', () => ({ downloadSession: (name?: string | null) => downloadSession(name) }));

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const panel = (id: string, datasetId: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
}) as unknown as PanelConfig;

beforeEach(() => {
  useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  useBrowserStore.setState({
    chrom: '2R', start: 1000, end: 2000,
    datasets: [{ id: 'ds1', label: 'Dataset 1' }],
    panels: [panel('p1', 'ds1')],
    sessionName: 'my run',
  } as unknown as Partial<BrowserState>);
  downloadSession.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('round-13: Copilot api_call session export', () => {
  it('saves a session through the browser, not a bare backend export', async () => {
    const fetchMock = vi.fn(async () => okResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const message = await executeBrowserAction({ type: 'api_call', method: 'POST', path: '/api/session/export', body: {} });
    expect(downloadSession).toHaveBeenCalledWith('my run');
    expect(message).toMatch(/Saved the session as fiberhmm_session_x\.json/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('round-13: Copilot api_call sort and filter', () => {
  it('applies a sort to the panels, moving a body region into the query', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return okResponse({ results: { ds1: { cluster_order: [], read_sort_order: ['r2', 'r1'] } } });
    }));
    const message = await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/sort_reads',
      body: { chrom: '2R', start: 1000, end: 2000, sort_by: 'accessibility' },
    });
    expect(message).toMatch(/Sorted 1 panel/);
    expect(useBrowserStore.getState().readSortOrder.ds1).toEqual(['r2', 'r1']);
    const sent = urls.find(u => u.includes('/api/sort_reads'))!;
    expect(sent).toContain('chrom=2R');
    expect(sent).toContain('start=1000');
  });

  it('applies filter results, including a single-dataset /api/filter answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/api/filter_by_analysis_rule')
      ? okResponse({ results: { ds1: { read_ids: ['r1'], total: 2, filtered: 1 } } })
      : okResponse({ read_ids: ['r3'], total: 3, filtered: 1 }))));
    await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/filter_by_analysis_rule?chrom=2R&start=1000&end=2000',
      body: { metric: 'count', operator: '>=', threshold: 1 },
    });
    expect([...(useBrowserStore.getState().filteredReadIds.ds1 ?? [])]).toEqual(['r1']);
    await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/filter?chrom=2R&start=1000&end=2000', body: { filter_mode: 'open' },
    });
    expect([...(useBrowserStore.getState().filteredReadIds.ds1 ?? [])]).toEqual(['r3']);
  });

  it('drops a sort a newer sort superseded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      nextSortRequest();
      return okResponse({ results: { ds1: { cluster_order: [], read_sort_order: ['r9'] } } });
    }));
    const message = await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/sort_reads?chrom=2R&start=1000&end=2000', body: { sort_by: 'fp_count' },
    });
    expect(message).toMatch(/superseded/);
    expect(useBrowserStore.getState().readSortOrder.ds1).toBeUndefined();
  });
});
