import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';
import type { BrowserState } from '../stores/browserStore';
import { registerClusterRunner } from '../utils/clusterRunner';

vi.mock('../utils/copilotAnchors', () => ({
  highlightForAction: vi.fn(async () => undefined),
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const panel = (id: string, datasetId: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
});

function setup(extra: Partial<BrowserState> = {}) {
  useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  useBrowserStore.setState({
    chrom: '2R', start: 1000, end: 2000,
    datasets: [{ id: 'ds1', label: 'Dataset 1' }, { id: 'ds2', label: 'Dataset 2' }],
    panels: [panel('p1', 'ds1'), panel('p2', 'ds2')],
    selectedDatasets: new Set<string>(),
    clusterAssignments: {},
    ...extra,
  } as unknown as Partial<BrowserState>);
}

type Call = { url: string; body: any };
function stub(result: (url: string, body: any) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body });
    return okResponse(result(String(url), body));
  }));
  return calls;
}

describe('round-11: api_call clustering', () => {
  beforeEach(() => setup());
  afterEach(() => vi.unstubAllGlobals());

  it("sends the call's rule definitions (and saved rules) with rule-mode regions", async () => {
    const saved = { id: 'saved', name: 'Saved', enabled: true, terms: [] };
    useBrowserStore.setState({ clusterFeatureRules: [saved] } as unknown as Partial<BrowserState>);
    const rule = { id: 'r', name: 'Short', enabled: true, terms: [{ id: 't', sizeMin: 10, sizeMax: 40 }] };
    const calls = stub(() => ({ results: { ds1: { assignments: { a: 0 } } } }));
    await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/cluster_all',
      body: { peak_regions: [{ start: 1200, end: 1300, mode: 'cluster_rule:r' }], cluster_feature_rules: [rule], dataset_ids: ['ds1'] },
    });
    expect(calls[0].body.cluster_feature_rules.map((r: { id: string }) => r.id)).toEqual(['r', 'saved']);
    expect(calls[0].body.peak_regions[0].mode).toBe('cluster_rule:r');
  });

  it('clusters a one-strand panel on its own strand, and maps the result back to it', async () => {
    setup({
      panels: [panel('ct', 'ds1', { stateKey: 'ct', strand: 'CT' }), panel('ga', 'ds1', { stateKey: 'ga', strand: 'GA' })],
    } as unknown as Partial<BrowserState>);
    const calls = stub((_u, body) => ({
      results: Object.fromEntries(body.viewports.map((v: { result_key: string }) => [v.result_key, { assignments: { ['r_' + v.result_key]: 1 } }])),
    }));
    await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/cluster_all', body: { peak_regions: [[1200, 1300]], dataset_ids: ['ds1'] },
    });
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.body.viewports.map((v: { strand: string; result_key: string }) => v.result_key + ':' + v.strand)))
      .toEqual([['ct:CT'], ['ga:GA']]);
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments.ct).toEqual({ r_ct: 1 });
    expect(st.clusterAssignments.ga).toEqual({ r_ga: 1 });
  });

  it("never clusters the user's selection for a named dataset with no panel", async () => {
    useBrowserStore.setState({
      selectedDatasets: new Set(['p1']), selectedPeaks: new Set([0]),
      clusterAssignments: { ds1: { a: 4 } },
    } as unknown as Partial<BrowserState>);
    const calls = stub(() => ({ results: {} }));
    let buttonRuns = 0;
    registerClusterRunner(async () => {
      buttonRuns += 1;
      useBrowserStore.getState().setClusterAssignments('ds1', { a: 9 });
    });
    const message = await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/cluster_all?dataset_ids=missing', body: {},
    });
    registerClusterRunner(null);
    expect(buttonRuns).toBe(0);
    expect(message).toMatch(/No loaded dataset matches missing|No peak regions/);
    expect(calls.filter(c => c.url.includes('cluster_all'))).toHaveLength(0);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ a: 4 });
  });
});

describe('round-11: link, unlink, merge', () => {
  beforeEach(() => setup());
  afterEach(() => vi.unstubAllGlobals());

  it('links and unlinks panels named by dataset id', async () => {
    const linked = await executeBrowserAction({ type: 'link_datasets', panel_ids: ['ds1', 'ds2'] });
    expect(linked).toMatch(/Linked 2 panels/);
    const groups = useBrowserStore.getState().panels.map(p => p.linkGroup);
    expect(groups[0]).toBeTruthy();
    expect(groups[0]).toBe(groups[1]);
    await executeBrowserAction({ type: 'unlink_dataset', panel_id: 'ds2' });
    expect(useBrowserStore.getState().panels.find(p => p.id === 'p2')?.linkGroup).toBeNull();
    expect(await executeBrowserAction({ type: 'unlink_dataset', panel_id: 'nope' })).toMatch(/nothing changed/);
  });

  it('merges the selected panels (selectedDatasets), and says so when nothing merged', async () => {
    useBrowserStore.setState({ selectedDatasets: new Set(['p1', 'p2']) } as unknown as Partial<BrowserState>);
    const calls = stub(url => (url.includes('/datasets/merge')
      ? { success: true, dataset: { id: 'merged', label: 'merged' }, removed_ids: ['ds1', 'ds2'] }
      : {}));
    expect(await executeBrowserAction({ type: 'merge_datasets' })).toBe('Merged the selected datasets.');
    expect(calls.find(c => c.url.includes('/datasets/merge'))?.body.dataset_ids).toEqual(['ds1', 'ds2']);
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['merged']);

    setup({ panels: [panel('p1', 'ds1')] } as unknown as Partial<BrowserState>);
    expect(await executeBrowserAction({ type: 'merge_datasets' })).toMatch(/nothing merged/);
  });
});
