import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from './browserActions';
import { getStateKeyMap, useBrowserStore } from '../stores/browserStore';
import type { BrowserState } from '../stores/browserStore';
import type { PanelConfig } from '../types';

vi.mock('../utils/copilotAnchors', () => ({
  highlightForAction: vi.fn(async () => undefined),
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const panel = (id: string, datasetId: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
}) as unknown as PanelConfig;

describe('round-12: Copilot-created motifs', () => {
  beforeEach(() => {
    useBrowserStore.setState(useBrowserStore.getInitialState(), true);
    useBrowserStore.setState({
      chrom: '2R', start: 1000, end: 2000,
      datasets: [{ id: 'ds1', label: 'Dataset 1' }],
      panels: [panel('p1', 'ds1')],
    } as unknown as Partial<BrowserState>);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('registers a motif made through api_call so a following motif query finds it', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/api/tracks/add_motif_sequence')) {
        return okResponse({ success: true, track_index: 4, path: 'motif://sequence/TGASTCA', label: 'TGASTCA' });
      }
      if (String(url).includes('/annotations')) {
        return okResponse({ intervals: [{ start: 1200, end: 1207, name: 'TGASTCA' }] });
      }
      return okResponse({});
    }));
    const message = await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/tracks/add_motif_sequence',
      body: { sequence: 'TGASTCA', threshold: 0.85 },
    });
    expect(message).toMatch(/added 1 motif track/);
    const entry = useBrowserStore.getState().catalog.find(e => e.kind === 'motif');
    expect(entry?.trackIndex).toBe(4);
    expect(entry?.meta).toMatchObject({ threshold: 0.85 });
    expect(useBrowserStore.getState().compositeTracks.length).toBeGreaterThan(0);

    const overlap = await executeBrowserAction({ type: 'query_motif_overlaps', start: 1100, end: 1300 });
    expect(overlap).toMatch(/Motif overlaps: TGASTCA/);
  });
});

describe('round-12: linked panels in analysis targets', () => {
  it('a selected panel brings the panels linked to it, each under its own state key', () => {
    const panels = [
      panel('a', 'ds1', { linkGroup: 'link-1' }),
      panel('b', 'ds1', { linkGroup: 'link-1', stateKey: 'b' }),
      panel('c', 'ds2', { linkGroup: 'link-1', stateKey: 'c' }),
      panel('d', 'ds2'),
    ];
    const datasets = [{ id: 'ds1' }, { id: 'ds2' }];
    const map = getStateKeyMap(new Set(['a']), panels, datasets);
    expect(map.ds1.sort()).toEqual(['b', 'ds1']);
    // ds2's linked copy, not its unselected original panel (nor the bare dataset id).
    expect(map.ds2).toEqual(['c']);
  });

  it('a dataset without panels still maps to its own id', () => {
    expect(getStateKeyMap(new Set(), [], [{ id: 'solo' }])).toEqual({ solo: ['solo'] });
  });
});
