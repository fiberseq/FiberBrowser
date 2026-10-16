import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';
import type { BrowserState } from '../stores/browserStore';
import { invalidateFilterRequests } from '../utils/filterRequests';

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
    analysisSortRules: [{
      id: 'sort1', name: 'TF count', enabled: true, scope: { kind: 'currentWindow' },
      terms: [{ id: 't', source: 'layer', layer: 'tf', sizeMin: 20, sizeMax: 80 }],
      metric: 'count', descending: true,
    }],
    analysisFilterRules: [{
      id: 'filter1', name: 'TF present', enabled: true, scope: { kind: 'currentWindow' },
      terms: [{ id: 't', source: 'layer', layer: 'tf', sizeMin: 20, sizeMax: 80 }],
      metric: 'count', operator: 'gte', threshold: 1,
    }],
    ...extra,
  } as unknown as Partial<BrowserState>);
}

describe('round-7 Copilot rule actions', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('apply_sort_rule', () => {
    beforeEach(() => {
      setup({
        panels: [base, { ...base, id: 'copy', stateKey: 'copy' }],
        selectedDatasets: new Set(['copy']),
        clusterAssignments: { ds1: { a: 1, b: 0 }, copy: { a: 0, b: 1 } },
      } as unknown as Partial<BrowserState>);
    });

    it('sends the selected copy its own clusters and applies the order only to it', async () => {
      const bodies: any[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return okResponse({ results: { ds1: { cluster_order: [0, 1], read_sort_order: ['a', 'b'] } } });
      }));
      const message = await executeBrowserAction({ type: 'apply_sort_rule', rule_name: 'TF count' });
      expect(message).toMatch(/Applied sort rule/);
      expect(bodies).toHaveLength(1);
      expect(bodies[0].cluster_assignments).toEqual({ ds1: { a: 0, b: 1 } });
      const st = useBrowserStore.getState();
      expect(st.clusterOrder.copy).toEqual([0, 1]);
      expect(st.clusterOrder.ds1).toBeUndefined();
    });

    it('sorts two independently clustered panels of a dataset with one request each', async () => {
      useBrowserStore.setState({ selectedDatasets: new Set(['panel-ds1', 'copy']) } as unknown as Partial<BrowserState>);
      const sent: Array<Record<string, Record<string, number>>> = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        sent.push(body.cluster_assignments);
        const order = body.cluster_assignments.ds1.a === 1 ? [1, 0] : [0, 1];
        return okResponse({ results: { ds1: { cluster_order: order } } });
      }));
      await executeBrowserAction({ type: 'apply_sort_rule', rule_name: 'TF count' });
      expect(sent).toHaveLength(2);
      const st = useBrowserStore.getState();
      expect(st.clusterOrder.ds1).toEqual([1, 0]);
      expect(st.clusterOrder.copy).toEqual([0, 1]);
    });
  });

  describe('apply_filter_rule', () => {
    beforeEach(() => setup());

    it('a Clear while the request runs keeps the cleared filter cleared', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        // The user clicks Clear filter in the Rules panel meanwhile.
        invalidateFilterRequests();
        return okResponse({ results: { ds1: { read_ids: ['a'], filtered: 1, total: 2 } } });
      }));
      const message = await executeBrowserAction({ type: 'apply_filter_rule', rule_name: 'TF present' });
      expect(message).toMatch(/not applied/);
      expect(useBrowserStore.getState().filteredReadIds.ds1 ?? null).toBeNull();
    });

    it('Copilot clear_filter supersedes a pending Copilot filter', async () => {
      let release: () => void = () => undefined;
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {
        release = () => resolve(okResponse({ results: { ds1: { read_ids: ['a'], filtered: 1, total: 2 } } }));
      })));
      const pending = executeBrowserAction({ type: 'apply_filter_rule', rule_name: 'TF present' });
      await new Promise(resolve => setTimeout(resolve, 0));
      await executeBrowserAction({ type: 'clear_filter' });
      release();
      expect(await pending).toMatch(/not applied/);
      expect(useBrowserStore.getState().filteredReadIds.ds1 ?? null).toBeNull();
    });

    it('applies normally when nothing intervenes', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okResponse({ results: { ds1: { read_ids: ['a'], filtered: 1, total: 2 } } })));
      await executeBrowserAction({ type: 'apply_filter_rule', rule_name: 'TF present' });
      expect([...(useBrowserStore.getState().filteredReadIds.ds1 ?? [])]).toEqual(['a']);
    });
  });
});
