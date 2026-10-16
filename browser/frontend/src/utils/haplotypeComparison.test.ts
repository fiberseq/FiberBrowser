import { describe, expect, it } from 'vitest';
import {
  comparisonViews,
  matchedFeaturePairs,
  summarizeComparison,
  viewFeatures,
} from './haplotypeComparison';

const panel = (id: string, datasetId: string, side: 1 | 2 | undefined, chrom: string, extra: Record<string, unknown> = {}) => ({
  id,
  contentType: 'dataset' as const,
  datasetId,
  stateKey: `${datasetId}:hap-1:${side ?? 0}`,
  collapsed: false,
  haplotypeGroup: 'hap-1',
  haplotypeSide: side,
  viewportOverride: { chrom, start: 1000, end: 2000 },
  ...extra,
});

describe('comparisonViews', () => {
  it('groups comparison panels into View 1 and View 2 with their stacked datasets', () => {
    const views = comparisonViews([
      panel('p1', 'a', 1, 'chr1_mat'),
      panel('p2', 'b', 1, 'chr1_mat', { strand: 'GA' }),
      panel('p3', 'c', 2, 'chr1_pat'),
      { id: 'main', contentType: 'dataset', datasetId: 'a', collapsed: true },
    ]);
    expect(views.map(view => [view.id, view.chrom, view.panels.map(p => p.datasetId)])).toEqual([
      ['view1', 'chr1_mat', ['a', 'b']],
      ['view2', 'chr1_pat', ['c']],
    ]);
    expect(views[0].panels[1]).toMatchObject({ stateKey: 'b:hap-1:1', strand: 'GA' });
  });

  it('falls back to the layout column for panels from older sessions', () => {
    const views = comparisonViews([
      panel('p1', 'a', undefined, 'chrA', { layoutColumn: 0 }),
      panel('p2', 'a', undefined, 'chrB', { layoutColumn: 1 }),
    ]);
    expect(views.map(view => view.chrom)).toEqual(['chrA', 'chrB']);
  });

  it('is empty without a dataset on both sides', () => {
    expect(comparisonViews([panel('p1', 'a', 1, 'chrA')])).toEqual([]);
  });
});

describe('viewFeatures and matching', () => {
  const view1 = { chrom: 'chr1_mat', start: 1000, end: 2000 };
  const view2 = { chrom: 'chr1_pat', start: 1000, end: 2000 };
  const peaks = [
    { start: 1500, end: 1600, chrom: 'chr1_mat', mode: 'accessibility' },
    { start: 1100, end: 1200 },  // selected in the main view (chr1_mat)
    { start: 1300, end: 1400, chrom: 'chr1_pat', mode: 'tf' },
    { start: 1700, end: 1760, chrom: 'chr1_pat' },
    { start: 5000, end: 5100, chrom: 'chr1_mat' },  // outside the window
    { start: 1800, end: 1850, chrom: 'chr1_mat', mode: 'off' },
  ];

  it("takes each view's selected peaks inside its window, left to right", () => {
    expect(viewFeatures(view1, peaks, 'chr1_mat').map(f => [f.start, f.end])).toEqual([[1100, 1200], [1500, 1600]]);
    expect(viewFeatures(view2, peaks, 'chr1_mat')).toEqual([
      { start: 1300, end: 1400, mode: 'tf' },
      { start: 1700, end: 1760, mode: 'accessibility' },
    ]);
  });

  it('matches left to right, or View 2 right to left when it is reversed', () => {
    const f1 = viewFeatures(view1, peaks, 'chr1_mat');
    const f2 = viewFeatures(view2, peaks, 'chr1_mat');
    expect(matchedFeaturePairs(f1, f2, false).map(([a, b]) => [a.start, b.start])).toEqual([[1100, 1300], [1500, 1700]]);
    expect(matchedFeaturePairs(f1, f2, true).map(([a, b]) => [a.start, b.start])).toEqual([[1100, 1700], [1500, 1300]]);
  });
});

describe('summarizeComparison', () => {
  const views = comparisonViews([panel('p1', 'a', 1, 'chrA'), panel('p2', 'b', 2, 'chrB')]);
  const results = {
    L: { view_id: 'view1', assignments: { r1: 0, r2: 0, r3: 1, r4: 1 } },
    R: { view_id: 'view2', assignments: { s1: 0, s2: 1, s3: 1, s4: 1 } },
  } as any;

  it('reports each shared state per view and its shift in percentage points', () => {
    const rows = summarizeComparison({ results, label_space: 'shared', cluster_patterns: { 0: [1, 0], 1: [0, 0] } }, views);
    expect(rows).toEqual([
      { label: 0, name: 'OC', counts: [2, 1], fractions: [0.5, 0.25], shiftPp: -25 },
      { label: 1, name: 'CC', counts: [2, 3], fractions: [0.5, 0.75], shiftPp: 25 },
    ]);
  });

  it('gives no shift when each view has its own states', () => {
    const rows = summarizeComparison({ results, label_space: 'per_view', cluster_patterns: null }, views);
    expect(rows.map(row => [row.name, row.shiftPp])).toEqual([['C0', null], ['C1', null]]);
  });
});
