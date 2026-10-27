import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nucConditionsPayload, ruleTermPayload } from './ruleTermPayload';
import { executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';
import type { BrowserState } from '../stores/browserStore';
import type { AnalysisFilterRule, AnalysisSortRule, ClusterFeatureRuleTerm, ColorRule } from '../types';

vi.mock('../utils/copilotAnchors', () => ({
  highlightForAction: vi.fn(async () => undefined),
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));

// Codex M2 review D-1: label-rule nucleosome conditions reach Filter/Sort (backend read_metrics.compute_rule_metric).

function colorRule(overrides: Partial<ColorRule> = {}): ColorRule {
  return {
    id: 'c1', name: 'Mono', color: '#16a34a', opacity: 1, sizeMin: 1, sizeMax: null, targetLayers: [],
    conditions: [], enabled: true, ...overrides,
  };
}

function labelTerm(overrides: Partial<ColorRule> = {}): ClusterFeatureRuleTerm {
  return { id: 't1', source: 'label_rule', labelRuleId: 'c1', rule: colorRule(overrides) };
}

describe('ruleTermPayload', () => {
  it('carries a label rule\'s nucCoarse (the reviewer\'s reproducer)', () => {
    expect(ruleTermPayload(labelTerm({ nucCoarse: [2] }))).toStrictEqual({
      size_min: 1, size_max: null, conditions: [], quality_gates: [], nuc_coarse: [2],
    });
  });

  it('carries every nucleosome condition that is set', () => {
    expect(ruleTermPayload(labelTerm({ nucCoarse: [1, 3], nucNamed: [3], zMin: -1.5, zMax: 0.5, nucTf: false })))
      .toMatchObject({ nuc_coarse: [1, 3], nuc_named: [3], z_min: -1.5, z_max: 0.5, nuc_tf: false });
    expect(ruleTermPayload(labelTerm({ nucTf: true })).nuc_tf).toBe(true);
    expect(ruleTermPayload(labelTerm({ zMin: 0 })).z_min).toBe(0);
  });

  it('leaves plain rules exactly as before (empty lists and null bounds are no condition)', () => {
    const before = { size_min: 1, size_max: null, conditions: [], quality_gates: [] };
    expect(ruleTermPayload(labelTerm())).toStrictEqual(before);
    expect(ruleTermPayload(labelTerm({ nucCoarse: [], nucNamed: [], zMin: null, zMax: null, nucTf: null })))
      .toStrictEqual(before);
    expect(ruleTermPayload({ id: 't', source: 'layer', layer: 'tf', sizeMin: 10, sizeMax: 80 })).toStrictEqual({
      size_min: 10, size_max: 80, conditions: [], quality_gates: [],
    });
    expect(nucConditionsPayload(undefined)).toStrictEqual({});
  });
});

let bodies: Array<Record<string, any>>;

beforeEach(() => {
  useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  useBrowserStore.setState({
    chrom: '2R', start: 1000, end: 2000,
    datasets: [{ id: 'ds1', label: 'Dataset 1', available_layers: { nuc: true, nucsz: true } }],
    panels: [{ id: 'panel-ds1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
    selectedDatasets: new Set<string>(),
  } as Partial<BrowserState>);
  bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ results: { ds1: { read_ids: ['q1'], total: 2, filtered: 1, cluster_order: [], read_sort_order: ['q1'] } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apply_filter_rule / apply_sort_rule with a nucleosome label rule', () => {
  it('Filter sends the nucleosome conditions with the count rule', async () => {
    const rule: AnalysisFilterRule = {
      id: 'f1', name: 'Has a mono nucleosome', enabled: true, scope: { kind: 'currentWindow' },
      terms: [labelTerm({ nucCoarse: [2], nucTf: false })], metric: 'count', operator: 'gte', threshold: 1,
    };
    useBrowserStore.setState({ analysisFilterRules: [rule] } as Partial<BrowserState>);
    await executeBrowserAction({ type: 'apply_filter_rule', rule_id: 'f1' });
    expect(bodies[0].rule).toStrictEqual({
      size_min: 1, size_max: null, conditions: [], quality_gates: [], nuc_coarse: [2], nuc_tf: false,
    });
  });

  it('Sort sends them too', async () => {
    const rule: AnalysisSortRule = {
      id: 's1', name: 'Mono count', enabled: true, scope: { kind: 'currentWindow' },
      terms: [labelTerm({ nucNamed: [3], zMax: 1 })], metric: 'count', descending: true,
    };
    useBrowserStore.setState({ analysisSortRules: [rule] } as Partial<BrowserState>);
    await executeBrowserAction({ type: 'apply_sort_rule', rule_id: 's1' });
    expect(bodies[0]).toMatchObject({ sort_by: 'rule', rule: { nuc_named: [3], z_max: 1 } });
  });
});
