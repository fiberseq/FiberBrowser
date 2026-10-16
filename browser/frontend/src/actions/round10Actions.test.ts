import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';
import type { BrowserState } from '../stores/browserStore';

vi.mock('../utils/copilotAnchors', () => ({
  highlightForAction: vi.fn(async () => undefined),
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const panel = (id: string, datasetId: string, stateKey?: string) => ({
  id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
  ...(stateKey ? { stateKey } : {}),
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
function stubCluster(result: (body: any) => unknown, onCall?: () => void): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body });
    onCall?.();
    return okResponse(result(body));
  }));
  return calls;
}

const regions = { peak_regions: [[1200, 1300]] };

describe('round-10: api_call clustering', () => {
  beforeEach(() => setup());
  afterEach(() => vi.unstubAllGlobals());

  it('goes to query-string coordinates (strings) before clustering', async () => {
    const calls = stubCluster(() => ({ results: { ds1: { assignments: { a: 0 } }, ds2: { assignments: { b: 1 } } } }));
    await executeBrowserAction({
      type: 'api_call', method: 'POST', path: '/api/cluster_all?chrom=3L&start=5000&end=6000',
      body: { peak_regions: [[5100, 5200]] },
    });
    const st = useBrowserStore.getState();
    expect([st.chrom, st.start, st.end]).toEqual(['3L', 5000, 6000]);
    expect(calls[0].url).toContain('chrom=3L');
    expect(calls[0].url).toContain('start=5000');
  });

  it('clusters only the datasets it names', async () => {
    useBrowserStore.setState({ selectedDatasets: new Set(['p1', 'p2']), clusterAssignments: { ds2: { b: 3 } } } as unknown as Partial<BrowserState>);
    const calls = stubCluster(() => ({ results: { ds1: { assignments: { a: 0 } } } }));
    await executeBrowserAction({ type: 'api_call', method: 'POST', path: '/api/cluster_all', body: { ...regions, dataset_ids: ['ds1'] } });
    expect(calls.map(c => c.body.dataset_ids)).toEqual([['ds1']]);
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments.ds1).toEqual({ a: 0 });
    expect(st.clusterAssignments.ds2).toEqual({ b: 3 });
  });

  it('is dropped when the cluster branch changes while it runs', async () => {
    useBrowserStore.setState({ activeClusterTreeNodeId: 'branch-a', clusterAssignments: { ds1: { a: 5 } } } as unknown as Partial<BrowserState>);
    stubCluster(
      () => ({ results: { ds1: { assignments: { a: 0 } } } }),
      () => useBrowserStore.setState({ activeClusterTreeNodeId: 'branch-b' } as unknown as Partial<BrowserState>),
    );
    const message = await executeBrowserAction({ type: 'api_call', method: 'POST', path: '/api/cluster_all', body: { ...regions, dataset_ids: ['ds1'] } });
    expect(message).toMatch(/branch changed/);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ a: 5 });
  });

  it('is dropped when the view moves while it runs', async () => {
    stubCluster(
      () => ({ results: { ds1: { assignments: { a: 0 } } } }),
      () => useBrowserStore.setState({ start: 9000, end: 9900 } as unknown as Partial<BrowserState>),
    );
    const message = await executeBrowserAction({ type: 'api_call', method: 'POST', path: '/api/cluster_all', body: { ...regions, dataset_ids: ['ds1'] } });
    expect(message).toMatch(/view or cluster branch changed/);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toBeUndefined();
  });

  it('leaves a panel reclustered meanwhile as it is', async () => {
    useBrowserStore.setState({ clusterAssignments: { ds1: { a: 5 } } } as unknown as Partial<BrowserState>);
    stubCluster(
      () => ({ results: { ds1: { assignments: { a: 0 } } } }),
      () => useBrowserStore.setState({ clusterAssignments: { ds1: { a: 7 } } } as unknown as Partial<BrowserState>),
    );
    await executeBrowserAction({ type: 'api_call', method: 'POST', path: '/api/cluster_all', body: { ...regions, dataset_ids: ['ds1'] } });
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ a: 7 });
  });

  it('clusters two copies of a dataset separately, each with its own read filter', async () => {
    setup({
      datasets: [{ id: 'ds1', label: 'Dataset 1' }],
      panels: [panel('p1', 'ds1'), panel('pc', 'ds1', 'copy')],
      filteredReadIds: { ds1: new Set(['a', 'b']), copy: new Set(['c']) },
    } as unknown as Partial<BrowserState>);
    const calls = stubCluster(body => ({
      results: { ds1: { assignments: Object.fromEntries((body.read_ids?.ds1 ?? []).map((id: string, i: number) => [id, i])) } },
    }));
    await executeBrowserAction({ type: 'api_call', method: 'POST', path: '/api/cluster_all', body: regions });
    expect(calls.map(c => c.body.read_ids)).toEqual([{ ds1: ['a', 'b'] }, { ds1: ['c'] }]);
    const st = useBrowserStore.getState();
    expect(st.clusterAssignments.ds1).toEqual({ a: 0, b: 1 });
    expect(st.clusterAssignments.copy).toEqual({ c: 0 });
  });
});

describe('round-10: panels', () => {
  beforeEach(() => setup());

  it('a new link group never reuses one restored panels already carry', () => {
    useBrowserStore.setState({
      panels: [
        { ...panel('a', 'ds1'), linkGroup: 'link-1' }, { ...panel('b', 'ds2'), linkGroup: 'link-1' },
        panel('c', 'ds1', 'c'), panel('d', 'ds2', 'd'),
      ],
      nextLinkGroupId: 1,
    } as unknown as Partial<BrowserState>);
    useBrowserStore.getState().linkPanels(['c', 'd']);
    const groups = Object.fromEntries(useBrowserStore.getState().panels.map(p => [p.id, p.linkGroup]));
    expect(groups.a).toBe('link-1');
    expect(groups.c).not.toBe('link-1');
    expect(groups.c).toBe(groups.d);
    expect(useBrowserStore.getState().nextLinkGroupId).toBeGreaterThan(2);
  });

  it('replacing a contact-region comparison drops the old panels\' selection', () => {
    const st = useBrowserStore.getState();
    st.openContactRegions({ chrom: '2R', x_start: 1000, x_end: 1500, y_start: 5000, y_end: 5500 });
    const first = useBrowserStore.getState().panels.find(p => p.regionLabel === 'Locus X')!;
    useBrowserStore.setState({ selectedDatasets: new Set([first.id]), selectedPanelIds: new Set([first.id]) } as unknown as Partial<BrowserState>);
    useBrowserStore.getState().openContactRegions({ chrom: '2R', x_start: 2000, x_end: 2500, y_start: 7000, y_end: 7500 });
    const now = useBrowserStore.getState();
    expect(now.panels.some(p => p.id === first.id)).toBe(false);
    expect(now.selectedDatasets.has(first.id)).toBe(false);
    expect(now.selectedPanelIds.has(first.id)).toBe(false);
  });
});
