import { describe, expect, it } from 'vitest';
import { coverageHistogramBins } from './ReadTrackCanvas';

describe('coverageHistogramBins', () => {
  it('counts a molecule once per bin, however many of its intervals share the bin', () => {
    // 100 kb over 500 bins = 200 bp per bin; three adjacent intervals all touch bin 0.
    const read = { intervals: [[0, 40, 40], [40, 60, -20], [60, 120, 60]] as [number, number, number][] };
    const bins = coverageHistogramBins([read], 500, 100_000);
    expect(bins[0]).toBe(1);
    expect(Math.max(...bins)).toBe(1);
    expect(coverageHistogramBins([read, read], 500, 100_000)[0]).toBe(2);
  });

  it('keeps separate stretches of one read separate', () => {
    const read = { intervals: [[0, 100, 100], [900, 1000, 100]] as [number, number, number][] };
    const bins = coverageHistogramBins([read], 10, 1000);
    expect(Array.from(bins)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });
});
