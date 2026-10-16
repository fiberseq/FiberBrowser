import { describe, expect, it } from 'vitest';
import {
  benjaminiHochberg,
  bootstrapMeanCI,
  bootstrapMedianCI,
  fisherExactTwoSided,
  oddsRatio2x2,
  wilsonCountInterval,
  wilsonInterval,
} from './statistics';

describe('analysis statistics', () => {
  it('computes a bounded Wilson score interval', () => {
    const ci = wilsonInterval(10, 100);
    expect(ci.low).toBeCloseTo(0.0552, 4);
    expect(ci.high).toBeCloseTo(0.1744, 4);
    expect(wilsonInterval(0, 10).low).toBe(0);
    expect(wilsonInterval(10, 10).high).toBe(1);
    expect(wilsonCountInterval(10, 100).high).toBeCloseTo(17.44, 2);
  });

  it('uses a deterministic read-level percentile bootstrap', () => {
    const first = bootstrapMeanCI([1, 2, 3, 10], { seed: 'dataset:cluster', resamples: 500 });
    const second = bootstrapMeanCI([1, 2, 3, 10], { seed: 'dataset:cluster', resamples: 500 });
    expect(first).toEqual(second);
    expect(first.low).toBeLessThanOrEqual(4);
    expect(first.high).toBeGreaterThanOrEqual(4);
    expect(first.n).toBe(4);
    expect(first.resamples).toBe(500);

    const median = bootstrapMedianCI([5, 5, 5], { seed: 'constant', resamples: 50 });
    expect(median.low).toBe(5);
    expect(median.high).toBe(5);
  });

  it('applies monotone Benjamini-Hochberg adjustment in input order', () => {
    expect(benjaminiHochberg([0.01, 0.04, 0.03])).toEqual([0.03, 0.04, 0.04]);
    expect(benjaminiHochberg([])).toEqual([]);
  });

  it('matches a reference two-sided Fisher exact test', () => {
    expect(fisherExactTwoSided(1, 9, 11, 3)).toBeCloseTo(0.00275946, 7);
    expect(fisherExactTwoSided(11, 3, 1, 9)).toBeCloseTo(0.00275946, 7);
    expect(fisherExactTwoSided(0, 0, 0, 0)).toBe(1);
    expect(oddsRatio2x2(1, 9, 11, 3)).toBeCloseTo(3 / 99, 8);
    expect(oddsRatio2x2(0, 2, 4, 6)).toBeGreaterThan(0);
  });
});
