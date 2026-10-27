import { describe, expect, it } from 'vitest';
import type { AnalysisFilterRule, AnalysisSortRule, ClusterFeatureRuleTerm } from '../types';
import {
  analysisFilterLabel,
  analysisRuleTermProblem,
  buildAnalysisFilterRuleAutoName,
  buildAnalysisSortRuleAutoName,
  buildClusterFeatureRuleAutoName,
  filterOperatorLabel,
  filterRuleRequestFields,
  intersectWithCurrentFilter,
  sortMetricLabel,
  sortRuleRequestFields,
} from './analysisRules';
import { normalizeAnalysisFilterRules, normalizeAnalysisSortRules, normalizeClusterFeatureRules } from '../stores/utils';

const nrl: ClusterFeatureRuleTerm = { id: 't1', source: 'molecule_metric', moleculeMetric: 'nuc.nrl' };
const hubHits = [
  { setId: 'scan:a', hitId: 'h1', chrom: 'chr1', start: 100, end: 200, label: 'one' },
  { setId: 'scan:a', hitId: 'h2', chrom: 'chr1', start: 300, end: 400 },
  { setId: 'scan:b', hitId: 'h3', chrom: 'chr1', start: 500, end: 520 },
];
const hub: ClusterFeatureRuleTerm = { id: 't2', source: 'feature_hub', hubHits, hubState: '1' };

function filterRule(overrides: Partial<AnalysisFilterRule>): AnalysisFilterRule {
  return {
    id: 'f1', name: '', enabled: true, scope: { kind: 'currentWindow' }, terms: [nrl],
    metric: 'value', operator: 'between', threshold: 185, thresholdMax: 195, ...overrides,
  };
}

describe('auto names for molecule metric and hub hit terms', () => {
  it('names a molecule metric range with its unit and no metric word', () => {
    expect(buildAnalysisFilterRuleAutoName(filterRule({}))).toBe('NRL between 185 and 195 bp');
    expect(buildAnalysisFilterRuleAutoName(filterRule({ operator: 'gte', threshold: 185 }))).toBe('NRL >= 185 bp');
    // Fractions and counts are plain numbers.
    expect(buildAnalysisFilterRuleAutoName(filterRule({
      terms: [{ id: 't', source: 'molecule_metric', moleculeMetric: 'nuc.reg_fraction' }], operator: 'gt', threshold: 0.5,
    }))).toBe('Regular fraction > 0.5');
  });

  it('orders between bounds low first', () => {
    expect(buildAnalysisFilterRuleAutoName(filterRule({ threshold: 195, thresholdMax: 185 }))).toBe('NRL between 185 and 195 bp');
  });

  it('keeps a scope other than the current window', () => {
    expect(buildAnalysisFilterRuleAutoName(filterRule({ scope: { kind: 'allPeaks' } }))).toBe('NRL between 185 and 195 bp @ all peaks');
  });

  it('names hub hit terms by hit count and state', () => {
    expect(buildAnalysisFilterRuleAutoName(filterRule({ terms: [hub], metric: 'count', operator: 'gte', threshold: 1 })))
      .toBe('Hub hits (3) state 1 count >= 1');
    expect(buildAnalysisSortRuleAutoName({ terms: [{ ...hub, hubState: '0' }], metric: 'count', descending: true, scope: { kind: 'currentWindow' } }))
      .toBe('Hub hits (3) state 0 count high to low');
  });

  it('names sorts by a molecule metric without a metric word', () => {
    expect(buildAnalysisSortRuleAutoName({ terms: [nrl], metric: 'value', descending: false, scope: { kind: 'currentWindow' } }))
      .toBe('NRL low to high');
  });

  it('names between on layer counts and molecule metric cluster terms', () => {
    expect(buildAnalysisFilterRuleAutoName({
      terms: [{ id: 't', source: 'layer', layer: 'nuc' }], scope: { kind: 'currentWindow' },
      metric: 'count', operator: 'between', threshold: 1, thresholdMax: 3,
    })).toBe('Nuc count between 1 and 3 @ current window');
    expect(buildClusterFeatureRuleAutoName({ terms: [nrl, { id: 't3', source: 'layer', layer: 'tf' }], scope: { kind: 'selectedPeaks' } }))
      .toBe('NRL OR TF');
  });

  it('labels the new metric and operator', () => {
    expect(sortMetricLabel('value')).toBe('');
    expect(filterOperatorLabel('between')).toBe('between');
  });
});

describe('request fields for the new term sources', () => {
  it('a molecule metric range: value, between, ordered bounds, no layer', () => {
    expect(filterRuleRequestFields(filterRule({ threshold: 195, thresholdMax: 185 }))).toEqual({
      metric: 'value', operator: 'between', threshold: 185, thresholdMax: 195, moleculeMetric: 'nuc.nrl', layerFree: true,
    });
  });

  it('between without an upper bound uses the lower one', () => {
    expect(filterRuleRequestFields(filterRule({ thresholdMax: null }))).toMatchObject({ threshold: 185, thresholdMax: 185 });
  });

  it('hub hits: count of hits in the state, snake_case hits', () => {
    const fields = filterRuleRequestFields(filterRule({ terms: [hub], metric: 'count', operator: 'gte', threshold: 1, thresholdMax: null }));
    expect(fields).toEqual({
      metric: 'count', operator: 'gte', threshold: 1, layerFree: true,
      featureHub: {
        state: '1',
        hits: [
          { set_id: 'scan:a', hit_id: 'h1', chrom: 'chr1', start: 100, end: 200 },
          { set_id: 'scan:a', hit_id: 'h2', chrom: 'chr1', start: 300, end: 400 },
          { set_id: 'scan:b', hit_id: 'h3', chrom: 'chr1', start: 500, end: 520 },
        ],
      },
    });
  });

  it('a layer term never sends value, and gets no threshold_max unless between', () => {
    const fields = filterRuleRequestFields(filterRule({ terms: [{ id: 't', source: 'layer', layer: 'tf' }], metric: 'value', operator: 'gte', threshold: 2 }));
    expect(fields).toEqual({ metric: 'count', operator: 'gte', threshold: 2, layerFree: false });
  });

  it('sorts: value with the metric, feature_hub with the hits; layer terms keep their own path', () => {
    const sort = (terms: ClusterFeatureRuleTerm[]): Pick<AnalysisSortRule, 'terms'> => ({ terms });
    expect(sortRuleRequestFields(sort([nrl]))).toEqual({ sortBy: 'value', moleculeMetric: 'nuc.nrl' });
    expect(sortRuleRequestFields(sort([{ ...hub, hubState: '0' }]))).toMatchObject({ sortBy: 'feature_hub', featureHub: { state: '0' } });
    expect(sortRuleRequestFields(sort([{ id: 't', source: 'layer', layer: 'tf' }]))).toBeNull();
  });

  it('a hub term without hits cannot run', () => {
    expect(analysisRuleTermProblem({ ...hub, hubHits: [] })).toMatch(/no hub hits/);
    expect(analysisRuleTermProblem(hub)).toBeNull();
    expect(analysisRuleTermProblem(nrl)).toBeNull();
  });
});

describe('filters applied within the current filter', () => {
  const liftedQ1 = 'lift-cohort:v1 ["g|q1","q1","r",0,"17"]';

  it('no current filter: the result as it is', () => {
    expect([...intersectWithCurrentFilter(['q1', 'q2'], null)]).toEqual(['q1', 'q2']);
  });

  it('keeps only reads the current filter keeps, by QNAME or record key', () => {
    expect([...intersectWithCurrentFilter([liftedQ1, 'q2', 'q3'], new Set(['q1', 'q2']))]).toEqual([liftedQ1, 'q2']);
    const byRecord = new Set(['lift-record:v1 ["g|q1","q1","r"]']);
    expect([...intersectWithCurrentFilter([liftedQ1, 'q3'], byRecord)]).toEqual([liftedQ1]);
    expect([...intersectWithCurrentFilter(['q1'], new Set())]).toEqual([]);
  });

  it('says so in the filter label', () => {
    expect(analysisFilterLabel('NRL between 185 and 195 bp')).toBe('Rules > NRL between 185 and 195 bp');
    expect(analysisFilterLabel('NRL between 185 and 195 bp', { label: 'Rules > Regular array' }))
      .toBe('Rules > Regular array AND NRL between 185 and 195 bp');
    expect(analysisFilterLabel('B', {})).toBe('Current filter AND B');
  });
});

describe('saved rules keep the new fields', () => {
  it('filter rules keep molecule metric, between, upper bound and AND', () => {
    const [rule] = normalizeAnalysisFilterRules([{ ...filterRule({ combine: 'and' }), name: '' }]);
    expect(rule).toMatchObject({ metric: 'value', operator: 'between', threshold: 185, thresholdMax: 195, combine: 'and' });
    expect(rule.terms[0]).toMatchObject({ source: 'molecule_metric', moleculeMetric: 'nuc.nrl', layer: null });
    expect(rule.name).toBe('NRL between 185 and 195 bp');
    // 'replace' is the default and is not stored.
    expect(normalizeAnalysisFilterRules([filterRule({ combine: 'replace' })])[0].combine).toBeUndefined();
  });

  it('hub terms keep their hits and state; bad hits are dropped', () => {
    const [rule] = normalizeAnalysisFilterRules([filterRule({
      terms: [{ ...hub, hubState: '0', layer: 'tf', hubHits: [...hubHits, { setId: '', hitId: 'x', chrom: 'chr1', start: 1, end: 2 }] }],
      metric: 'count', operator: 'gte', threshold: 1,
    })]);
    expect(rule.terms[0]).toMatchObject({ source: 'feature_hub', hubState: '0', layer: null });
    expect(rule.terms[0].hubHits).toEqual(hubHits);
  });

  it('sort and cluster rules keep molecule metric terms', () => {
    const [sort] = normalizeAnalysisSortRules([{ id: 's', name: '', enabled: true, terms: [nrl], metric: 'value', descending: true }]);
    expect(sort.metric).toBe('value');
    expect(sort.terms[0].moleculeMetric).toBe('nuc.nrl');
    const [cluster] = normalizeClusterFeatureRules([{ id: 'c', enabled: true, terms: [{ id: 't', source: 'molecule_metric', molecule_metric: 'nfr.openness' }] }]);
    expect(cluster.terms[0]).toMatchObject({ source: 'molecule_metric', moleculeMetric: 'nfr.openness' });
  });
});
