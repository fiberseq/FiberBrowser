import { describe, expect, it } from 'vitest';
import { computeClusterRateComparisons, formatClusterRateTsv } from './ClusterCharts';

describe('cluster-rate comparisons', () => {
  it('retains unequal dataset denominators in rates and Fisher tests', () => {
    const counts = new Map<number, number[]>([
      [0, [10, 20]],
      [1, [90, 980]],
    ]);
    const comparisons = computeClusterRateComparisons(counts, [100, 1000], [0, 1]);

    expect(comparisons).toHaveLength(2);
    expect(comparisons[0]).toMatchObject({
      cluster: 0,
      countI: 10,
      totalI: 100,
      countJ: 20,
      totalJ: 1000,
      rateI: 0.1,
      rateJ: 0.02,
    });
    expect(comparisons[0].difference).toBeCloseTo(0.08);
    expect(comparisons[0].pValue).toBeLessThan(0.001);
    expect(comparisons[0].qValue).toBeGreaterThanOrEqual(comparisons[0].pValue);
  });

  it('returns all dataset pairs and clamps counts to their denominators', () => {
    const comparisons = computeClusterRateComparisons(
      new Map([[3, [5, 100, 1]]]),
      [10, 20, 0],
      [3],
    );
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].countJ).toBe(20);
    expect(comparisons[0].rateJ).toBe(1);
  });

  it('exports displayed rates with raw unequal denominators and inference', () => {
    const tsv = formatClusterRateTsv({
      proportions: new Map([[0, [0.1, 0.02]]]),
      counts: new Map([[0, [10, 20]]]),
      datasetTotals: [100, 1000],
      datasetLabels: ['shallow', 'deep'],
      clusterColors: new Map([[0, '#123456']]),
      clusterIds: [0],
    });
    const lines = tsv.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('difference_percentage_points');
    expect(lines[1]).toContain('rate\t0\tC0\t#123456\t0\tshallow\t10\t100\t0.1\t10');
    expect(lines[3]).toContain('comparison\t0\tC0\t#123456\t0\tshallow\t10\t100\t0.1\t10');
    expect(lines[3]).toContain('\t1\tdeep\t20\t1000\t0.02\t2');
  });

  it('keeps a displayed cluster q-value tied to the complete cluster family', () => {
    const familyCounts = new Map<number, number[]>([
      [0, [10, 1]],
      [1, [20, 20]],
      [2, [70, 79]],
    ]);
    const expected = computeClusterRateComparisons(familyCounts, [100, 100], [0, 1, 2])
      .find(item => item.cluster === 0)!;
    const displayedOnly = computeClusterRateComparisons(new Map([[0, [10, 1]]]), [100, 100], [0])[0];
    const tsv = formatClusterRateTsv({
      proportions: new Map([[0, [0.1, 0.01]]]),
      counts: new Map([[0, [10, 1]]]),
      comparisonCounts: familyCounts,
      comparisonClusterIds: [0, 1, 2],
      datasetTotals: [100, 100],
      datasetLabels: ['A', 'B'],
      clusterColors: new Map([[0, '#111111']]),
      clusterIds: [0],
    });
    const comparison = tsv.trim().split('\n').find(line => line.startsWith('comparison\t'))!;
    const exportedQ = Number(comparison.split('\t').at(-1));

    expect(exportedQ).toBeCloseTo(expected.qValue);
    expect(exportedQ).not.toBeCloseTo(displayedOnly.qValue);
  });
});
