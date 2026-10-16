import { describe, expect, it } from 'vitest';
import type { ColorRule } from '../../../types';
import {
  computeDifferencePanels,
  computeEnrichmentInference,
  differenceAxisMax,
  differencePanelReadsLabel,
  differencesHitTest,
  differencesLayout,
  formatEnrichmentTsv,
  rateDifference,
  splitUniformRules,
  wrapLabel,
} from './EnrichmentTabContent';

describe('cluster enrichment inference', () => {
  it('compares each cluster with the other plotted reads and adjusts the family', () => {
    const rules = [
      { id: 'r1', name: 'Rule 1', enabled: true },
      { id: 'r2', name: 'Rule 2', enabled: true },
    ] as ColorRule[];
    const data = new Map([
      ['r1', new Map([
        [0, { matched: 18, total: 20 }],
        [1, { matched: 2, total: 20 }],
      ])],
      ['r2', new Map([
        [0, { matched: 10, total: 20 }],
        [1, { matched: 10, total: 20 }],
      ])],
    ]);

    const inference = computeEnrichmentInference(data, rules, [{ cluster: 0 }, { cluster: 1 }]);
    expect(inference).toHaveLength(4);
    expect(inference[0]).toMatchObject({ matched: 18, total: 20, restMatched: 2, restTotal: 20 });
    expect(inference[0].oddsRatio).toBeGreaterThan(1);
    expect(inference[0].qValue).toBeLessThan(0.05);
    expect(inference[2].qValue).toBe(1);
  });

  it('exports plot values, denominators, intervals, and adjusted tests', () => {
    const rules = [{ id: 'r1', name: 'Rule 1', enabled: true }] as ColorRule[];
    const data = new Map([['r1', new Map([
      [0, { matched: 18, total: 20 }],
      [1, { matched: 2, total: 20 }],
    ])]]);
    const tsv = formatEnrichmentTsv(data, rules, [
      { cluster: 0, color: '#111111' },
      { cluster: 1, color: '#222222' },
    ]);
    const lines = tsv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('rest_matched\trest_total\todds_ratio\tp_value\tq_value');
    expect(lines[1]).toContain('r1\tRule 1\t0\tC0\t#111111\t18\t20\t0.9\t90');
    expect(lines[1]).toContain('\t2\t20\t');
  });

  it('keeps hidden clusters in the enrichment comparison and BH family', () => {
    const rules = [{ id: 'r1', name: 'Rule 1', enabled: true }] as ColorRule[];
    const data = new Map([['r1', new Map([
      [0, { matched: 18, total: 20 }],
      [1, { matched: 2, total: 20 }],
      [2, { matched: 10, total: 20 }],
    ])]]);
    const allClusters = [{ cluster: 0 }, { cluster: 1 }, { cluster: 2 }];
    const expected = computeEnrichmentInference(data, rules, allClusters)
      .find(item => item.cluster === 0)!;
    const tsv = formatEnrichmentTsv(
      data,
      rules,
      [{ cluster: 0, color: '#111111' }],
      allClusters,
    );
    const [header, line] = tsv.trim().split('\n').map(l => l.split('\t'));
    const row = Object.fromEntries(header.map((name, i) => [name, line[i]]));

    expect(Number(row.odds_ratio)).toBeCloseTo(expected.oddsRatio);
    expect(Number(row.q_value)).toBeCloseTo(expected.qValue);
    expect(Number(row.rest_total)).toBe(expected.restTotal);
    // The plotted difference: 90% vs 12 of 40 (30%) = +60 points.
    expect(Number(row.difference_pp)).toBeCloseTo(60);
  });
});

describe('enrichment chart in a narrow panel (M6)', () => {
  const rules = [
    { id: 'pol2', name: 'Pol II', enabled: true },
    { id: 'tf', name: 'TF', enabled: true },
    { id: 'acc', name: 'Accessibility', enabled: true },
  ] as ColorRule[];
  const clusters = [{ cluster: 0 }, { cluster: 1 }];
  const data = new Map([
    ['pol2', new Map([[0, { matched: 3, total: 10 }], [1, { matched: 1, total: 10 }]])],
    ['tf', new Map([[0, { matched: 10, total: 10 }], [1, { matched: 10, total: 10 }]])],
    ['acc', new Map([[0, { matched: 0, total: 10 }], [1, { matched: 0, total: 10 }]])],
  ]);

  it('leaves out rules at 100% (or 0%) in every cluster and names them', () => {
    const split = splitUniformRules(data, rules, clusters);
    expect(split.plotted.map(r => r.id)).toEqual(['pol2']);
    expect(split.allMatched.map(r => r.id)).toEqual(['tf']);
    expect(split.noneMatched.map(r => r.id)).toEqual(['acc']);
  });

  it('wraps category names instead of cutting them', () => {
    const measure = (s: string) => s.length * 6;
    expect(wrapLabel('Subnucleosomal footprint', 90, measure)).toEqual(['Subnucleosomal', 'footprint']);
    expect(wrapLabel('Pol II', 90, measure)).toEqual(['Pol II']);
    // A single word wider than the group still fits, with an ellipsis.
    const cut = wrapLabel('Accessibility', 40, measure);
    expect(cut).toHaveLength(1);
    expect(measure(cut[0])).toBeLessThanOrEqual(40);
    expect(cut[0].endsWith('…')).toBe(true);
  });

});

describe('uniform rules are judged on every cluster, not only the focused ones', () => {
  it('keeps a rule that differs between a focused cluster and a hidden one', () => {
    const rules = [{ id: 'r1', name: 'Pol II', enabled: true }] as ColorRule[];
    const data = new Map([['r1', new Map([[0, { matched: 20, total: 20 }], [1, { matched: 0, total: 20 }]])]]);
    // Focused on cluster 0 alone it looks uniform (100%) ...
    expect(splitUniformRules(data, rules, [{ cluster: 0 }] as never).plotted).toEqual([]);
    // ... but across all clusters it tells them apart, so it is plotted.
    expect(splitUniformRules(data, rules, [{ cluster: 0 }, { cluster: 1 }] as never).plotted.map(r => r.id)).toEqual(['r1']);
  });
});

describe('What sets each cluster apart (the differences chart)', () => {
  const rules = [
    { id: 'pol2', name: 'Pol II', enabled: true },
    { id: 'tf', name: 'TF at motif', enabled: true },
    { id: 'nuc', name: 'Nucleosome at TSS', enabled: true },
  ] as ColorRule[];
  const data = new Map([
    ['pol2', new Map([[0, { matched: 30, total: 40 }], [1, { matched: 8, total: 40 }], [2, { matched: 10, total: 40 }]])],
    ['tf', new Map([[0, { matched: 20, total: 40 }], [1, { matched: 21, total: 40 }], [2, { matched: 19, total: 40 }]])],
    ['nuc', new Map([[0, { matched: 4, total: 40 }], [1, { matched: 30, total: 40 }], [2, { matched: 28, total: 40 }]])],
  ]);
  const all = [{ cluster: 0, color: '#a00' }, { cluster: 1, color: '#0a0' }, { cluster: 2, color: '#00a' }];
  const inferenceByKey = new Map(computeEnrichmentInference(data, rules, all).map(i => [`${i.ruleId}:${i.cluster}`, i]));

  it('sorts each cluster\'s rules from more common to less common than in the other clusters', () => {
    const [c0] = computeDifferencePanels(data, rules, [all[0]], inferenceByKey);
    expect(c0.reads).toBe(40);
    expect(c0.rows.map(r => r.ruleId)).toEqual(['pol2', 'tf', 'nuc']);
    const pol2 = c0.rows[0];
    expect(pol2.rate).toBeCloseTo(0.75);
    expect(pol2.restRate).toBeCloseTo(18 / 80);
    expect(pol2.difference).toBeCloseTo(0.75 - 18 / 80);
    expect(pol2.low).toBeLessThan(pol2.difference);
    expect(pol2.high).toBeGreaterThan(pol2.difference);
    expect(pol2.qValue).toBeLessThan(0.05);
    expect(c0.rows[2].difference).toBeLessThan(0);
    // A rule that doesn't tell the clusters apart stays near 0 and is not significant.
    expect(Math.abs(c0.rows[1].difference)).toBeLessThan(0.05);
    expect(c0.rows[1].qValue).toBeGreaterThan(0.05);
  });

  it('says when the reads compared are a sample of the cluster', () => {
    const [c0] = computeDifferencePanels(data, rules, [{ ...all[0], totalCount: 412 }], inferenceByKey);
    expect(differencePanelReadsLabel(c0)).toBe('40 of 412 reads compared');
    expect(differencePanelReadsLabel({ reads: 40, assigned: 40 })).toBe('40 reads');
  });

  it('keeps the test family to every cluster when only some are drawn', () => {
    const one = computeDifferencePanels(data, rules, [all[1]], inferenceByKey)[0];
    const both = computeDifferencePanels(data, rules, all, inferenceByKey)[1];
    expect(one.rows).toEqual(both.rows);
  });

  it('brackets the difference with a Newcombe interval inside [-1, 1]', () => {
    const d = rateDifference(40, 40, 0, 40);
    expect(d.difference).toBe(1);
    expect(d.high).toBeLessThanOrEqual(1 + 1e-12);
    expect(d.low).toBeGreaterThan(0.8);
    expect(rateDifference(0, 10, 0, 10)).toMatchObject({ difference: 0 });
  });

  it('shares one round axis across the clusters and finds the row under the pointer', () => {
    const panels = computeDifferencePanels(data, rules, all, inferenceByKey);
    const max = differenceAxisMax(panels);
    expect([50, 60, 80, 100]).toContain(max);
    const layout = differencesLayout(400, panels);
    expect(layout.rows).toHaveLength(9);
    expect(layout.x1).toBeGreaterThan(layout.x0);
    const third = layout.rows[4];
    expect(differencesHitTest(third.y + 2, layout)).toEqual(third);
    expect(differencesHitTest(-5, layout)).toBeNull();
  });
});
