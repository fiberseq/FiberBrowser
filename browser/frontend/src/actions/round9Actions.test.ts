import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';
import type { BrowserState } from '../stores/browserStore';
import { nextSortRequest } from '../utils/sortRequests';
import { branchScopesPanel } from '../utils/readScopes';

vi.mock('../utils/copilotAnchors', () => ({
  highlightForAction: vi.fn(async () => undefined),
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const base = {
  id: 'panel-ds1', contentType: 'dataset', datasetId: 'ds1', subTracks: [],
  collapsed: false, linkGroup: null, layoutRow: 0,
};

function setup(extra: Partial<BrowserState> = {}) {
  useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  useBrowserStore.setState({
    chrom: '2R', start: 1000, end: 2000,
    datasets: [{ id: 'ds1', label: 'Dataset 1', available_layers: { tf: true, nuc: true } }],
    panels: [base],
    selectedDatasets: new Set<string>(),
    clusterAssignments: { ds1: { a: 0, b: 1 } },
    clusterOrder: { ds1: [0, 1] },
    analysisSortRules: [{
      id: 'sort1', name: 'TF count', enabled: true, scope: { kind: 'currentWindow' },
      terms: [{ id: 't', source: 'layer', layer: 'tf', sizeMin: 20, sizeMax: 80 }],
      metric: 'count', descending: true,
    }],
    ...extra,
  } as unknown as Partial<BrowserState>);
}

describe('round-9: a late Copilot sort', () => {
  beforeEach(() => setup({ activeClusterTreeNodeId: 'branch-a' } as unknown as Partial<BrowserState>));
  afterEach(() => vi.unstubAllGlobals());

  it('is dropped when the cluster branch changed meanwhile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      useBrowserStore.setState({ activeClusterTreeNodeId: 'branch-b' } as unknown as Partial<BrowserState>);
      return okResponse({ results: { ds1: { cluster_order: [1, 0], read_sort_order: ['b', 'a'] } } });
    }));
    const message = await executeBrowserAction({ type: 'apply_sort_rule', rule_name: 'TF count' });
    expect(message).toMatch(/branch changed/);
    expect(useBrowserStore.getState().clusterOrder.ds1).toEqual([0, 1]);
  });

  it('is not applied to a panel reclustered meanwhile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      useBrowserStore.setState({ clusterAssignments: { ds1: { a: 1, b: 0 } } } as unknown as Partial<BrowserState>);
      return okResponse({ results: { ds1: { cluster_order: [1, 0] } } });
    }));
    await executeBrowserAction({ type: 'apply_sort_rule', rule_name: 'TF count' });
    expect(useBrowserStore.getState().clusterOrder.ds1).toEqual([0, 1]);
  });

  it('is superseded by a newer sort from the Sort button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      nextSortRequest();
      return okResponse({ results: { ds1: { cluster_order: [1, 0] } } });
    }));
    const message = await executeBrowserAction({ type: 'apply_sort_rule', rule_name: 'TF count' });
    expect(message).toMatch(/superseded/);
    expect(useBrowserStore.getState().clusterOrder.ds1).toEqual([0, 1]);
  });
});

describe('round-9: api_call clustering', () => {
  beforeEach(() => setup({
    clusterAssignments: {},
    peaksByRule: { r1: [{ start: 1200, end: 1300, index: 0, layer: 0, ruleId: 'r1' }] },
    peakRules: [{ id: 'r1', name: 'Peaks', enabled: true, source: 'accessibility' }],
  } as unknown as Partial<BrowserState>));
  afterEach(() => vi.unstubAllGlobals());

  it('runs as the browser\'s own clustering and shows the result', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return okResponse({ results: { ds1: { assignments: { a: 2, b: 0 } } } });
    }));
    const message = await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/cluster_all?chrom=2R&start=1000&end=2000',
      body: { k: 3, method: 'kmeans' },
    });
    const st = useBrowserStore.getState();
    expect(st.clusterK).toBe(3);
    expect(st.clusterMethod).toBe('kmeans');
    expect(st.clusterAssignments.ds1).toEqual({ a: 2, b: 0 });
    expect(message).toMatch(/Clustered 2 reads/);
    expect(calls.some(c => c.url.includes('/api/cluster_all'))).toBe(true);
  });
});

describe('round-9: a panel copied while viewing a subcluster', () => {
  it('keeps all its reads: only the branch\'s own panels are scoped', () => {
    const branch = { parentId: 'root', assignments: { ds1: { a: 0 } } };
    expect(branchScopesPanel(branch, 'ds1')).toBe(true);
    expect(branchScopesPanel(branch, 'copy-1')).toBe(false);
    expect(branchScopesPanel({ parentId: null, assignments: { ds1: {} } }, 'ds1')).toBe(false);
    expect(branchScopesPanel(null, 'ds1')).toBe(false);
  });
});

describe('round-9: custom peaks', () => {
  beforeEach(() => setup({ peaksByRule: {} } as unknown as Partial<BrowserState>));

  it('are kept on each chromosome even at the same coordinates', () => {
    const add = useBrowserStore.getState().addCustomPeak;
    add(1100, 1200);             // main view (2R)
    add(1100, 1200, 'chr3L');    // another panel's chromosome
    add(1100, 1200, 'chr2R');    // 2R again under its alias: a duplicate
    const st = useBrowserStore.getState();
    const peaks = st.peaksByRule[st.getCustomRuleId()] ?? [];
    expect(peaks.map(p => p.chrom ?? st.chrom)).toEqual(['2R', 'chr3L']);
  });
});
