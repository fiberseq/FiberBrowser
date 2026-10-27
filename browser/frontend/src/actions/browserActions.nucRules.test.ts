import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';
import type { BrowserState } from '../stores/browserStore';
import type { AnalysisFilterRule, AnalysisSortRule } from '../types';

vi.mock('../utils/copilotAnchors', () => ({
  highlightForAction: vi.fn(async () => undefined),
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const LIFTED_Q1 = 'lift-cohort:v1 ["g|q1","q1","r",0,"17"]';
const HITS = [
  { setId: 'scan:a', hitId: 'h1', chrom: '2R', start: 1100, end: 1200 },
  { setId: 'scan:a', hitId: 'h2', chrom: '2R', start: 1500, end: 1520, label: 'two' },
];

function filterRule(overrides: Partial<AnalysisFilterRule>): AnalysisFilterRule {
  return {
    id: 'f1', name: 'NRL between 185 and 195 bp', enabled: true, scope: { kind: 'currentWindow' },
    terms: [{ id: 't1', source: 'molecule_metric', moleculeMetric: 'nuc.nrl', layer: null }],
    metric: 'value', operator: 'between', threshold: 185, thresholdMax: 195, ...overrides,
  };
}

function sortRule(overrides: Partial<AnalysisSortRule>): AnalysisSortRule {
  return {
    id: 's1', name: 'NRL high to low', enabled: true, scope: { kind: 'currentWindow' },
    terms: [{ id: 't1', source: 'molecule_metric', moleculeMetric: 'nuc.nrl' }], metric: 'value', descending: true, ...overrides,
  };
}

let bodies: Array<Record<string, any>>;

beforeEach(() => {
  useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  useBrowserStore.setState({
    chrom: '2R', start: 1000, end: 2000,
    datasets: [{ id: 'ds1', label: 'Dataset 1', available_layers: { nuc: true, nucsz: true, nucseg: true } }],
    panels: [{ id: 'panel-ds1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
    selectedDatasets: new Set<string>(),
  } as Partial<BrowserState>);
  bodies = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function serve(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return okResponse(body);
  }));
}

describe('filter rules with molecule metric and hub hit terms', () => {
  it('sends value, between, the upper bound and the metric, with no layer or size rule', async () => {
    serve({ results: { ds1: { read_ids: ['q1'], total: 2, filtered: 1 } } });
    useBrowserStore.setState({ analysisFilterRules: [filterRule({})] } as Partial<BrowserState>);
    await executeBrowserAction({ type: 'apply_filter_rule', rule_id: 'f1' });
    expect(bodies[0]).toMatchObject({ metric: 'value', operator: 'between', threshold: 185, threshold_max: 195, molecule_metric: 'nuc.nrl' });
    expect(bodies[0].layer).toBeUndefined();
    expect(bodies[0].rule).toBeUndefined();
    expect(bodies[0].feature_hub).toBeUndefined();
  });

  it('sends hub hits in snake case with their state and the count metric', async () => {
    serve({ results: { ds1: { read_ids: ['q1'], total: 2, filtered: 1 } } });
    useBrowserStore.setState({ analysisFilterRules: [filterRule({
      terms: [{ id: 't1', source: 'feature_hub', hubHits: HITS, hubState: '0', layer: null }],
      metric: 'count', operator: 'gte', threshold: 1, thresholdMax: null,
    })] } as Partial<BrowserState>);
    await executeBrowserAction({ type: 'apply_filter_rule', rule_id: 'f1' });
    expect(bodies[0]).toMatchObject({
      metric: 'count', operator: 'gte', threshold: 1,
      feature_hub: { state: '0', hits: [
        { set_id: 'scan:a', hit_id: 'h1', chrom: '2R', start: 1100, end: 1200 },
        { set_id: 'scan:a', hit_id: 'h2', chrom: '2R', start: 1500, end: 1520 },
      ] },
    });
    expect(bodies[0].threshold_max).toBeUndefined();
    expect(bodies[0].layer).toBeUndefined();
    expect(bodies[0].rule).toBeUndefined();
  });

  it('a hub term without hits is not sent', async () => {
    serve({ results: {} });
    useBrowserStore.setState({ analysisFilterRules: [filterRule({
      terms: [{ id: 't1', source: 'feature_hub', hubHits: [], hubState: '1' }], metric: 'count', operator: 'gte', threshold: 1,
    })] } as Partial<BrowserState>);
    expect(await executeBrowserAction({ type: 'apply_filter_rule', rule_id: 'f1' })).toMatch(/no hub hits/);
    expect(bodies).toHaveLength(0);
  });

  it('combine AND keeps only reads the current filter keeps (identity-aware) and says so', async () => {
    serve({ results: { ds1: { read_ids: [LIFTED_Q1, 'q2', 'q3'], total: 5, filtered: 3 } } });
    useBrowserStore.setState({ analysisFilterRules: [filterRule({ combine: 'and' })] } as Partial<BrowserState>);
    useBrowserStore.getState().setFilteredReadIds('ds1', new Set(['q1', 'q2']), { target: 'analysis-filter', label: 'Rules > Regular array' });
    const message = await executeBrowserAction({ type: 'apply_filter_rule', rule_id: 'f1' });
    expect(message).toMatch(/within the current filter/);
    expect([...(useBrowserStore.getState().filteredReadIds.ds1 ?? [])].sort()).toEqual([LIFTED_Q1, 'q2'].sort());
    expect(useBrowserStore.getState().readFilterSources.ds1?.label).toBe('Rules > Regular array AND NRL between 185 and 195 bp');
  });

  it('without AND the result replaces the current filter', async () => {
    serve({ results: { ds1: { read_ids: ['q3'], total: 5, filtered: 1 } } });
    useBrowserStore.setState({ analysisFilterRules: [filterRule({})] } as Partial<BrowserState>);
    useBrowserStore.getState().setFilteredReadIds('ds1', new Set(['q1', 'q2']), { target: 'analysis-filter', label: 'Rules > Regular array' });
    await executeBrowserAction({ type: 'apply_filter_rule', rule_id: 'f1' });
    expect([...(useBrowserStore.getState().filteredReadIds.ds1 ?? [])]).toEqual(['q3']);
    expect(useBrowserStore.getState().readFilterSources.ds1?.label).toBe('Rules > NRL between 185 and 195 bp');
  });
});

describe('sort rules with molecule metric and hub hit terms', () => {
  it('sorts by value with the metric and no layer', async () => {
    serve({ results: { ds1: { cluster_order: [], read_sort_order: ['q2', 'q1'] } } });
    useBrowserStore.setState({ analysisSortRules: [sortRule({})] } as Partial<BrowserState>);
    await executeBrowserAction({ type: 'apply_sort_rule', rule_id: 's1' });
    expect(bodies[0]).toMatchObject({ sort_by: 'value', molecule_metric: 'nuc.nrl', descending: true });
    expect(bodies[0].layer).toBeUndefined();
    expect(bodies[0].rule).toBeUndefined();
  });

  it('sorts by the count of hub hits in the state', async () => {
    serve({ results: { ds1: { cluster_order: [], read_sort_order: ['q2', 'q1'] } } });
    useBrowserStore.setState({ analysisSortRules: [sortRule({
      terms: [{ id: 't1', source: 'feature_hub', hubHits: HITS, hubState: '1' }], metric: 'count',
    })] } as Partial<BrowserState>);
    await executeBrowserAction({ type: 'apply_sort_rule', rule_id: 's1' });
    expect(bodies[0].sort_by).toBe('feature_hub');
    expect(bodies[0].feature_hub).toEqual({ state: '1', hits: HITS.map(h => ({ set_id: h.setId, hit_id: h.hitId, chrom: h.chrom, start: h.start, end: h.end })) });
    expect(bodies[0].rule).toBeUndefined();
    expect(bodies[0].layer).toBeUndefined();
  });
});

describe('Copilot add_filter_rule', () => {
  it('keeps a molecule metric range and AND', async () => {
    await executeBrowserAction({
      type: 'add_filter_rule', name: 'NRL 185-195', metric: 'value', operator: 'between', threshold: 185, threshold_max: 195,
      combine: 'and', scope: { kind: 'currentWindow' }, terms: [{ id: 't', source: 'molecule_metric', molecule_metric: 'nuc.nrl' }],
    });
    const rule = useBrowserStore.getState().analysisFilterRules.at(-1)!;
    expect(rule).toMatchObject({ metric: 'value', operator: 'between', threshold: 185, thresholdMax: 195, combine: 'and' });
    expect(rule.terms[0]).toMatchObject({ source: 'molecule_metric', moleculeMetric: 'nuc.nrl' });
  });
});
