import { describe, expect, it } from 'vitest';
import { groupEntriesByChrom } from './cartExport';

describe('groupEntriesByChrom', () => {
  it('fetches each saved footprint on its own chromosome, in its original order', () => {
    const groups = groupEntriesByChrom([
      { referenceChrom: 'chr1', referenceAbsStart: 100, referenceAbsEnd: 120 },
      { referenceAbsStart: 500, referenceAbsEnd: 540 },  // no chrom: the one in view
      { referenceChrom: 'chr1', referenceAbsStart: 900, referenceAbsEnd: 950 },
      { referenceChrom: 'chr3', referenceAbsStart: null, referenceAbsEnd: 10 },  // not pinned
    ], 'chr2', 10);
    expect(groups.map(g => [g.chrom, g.indices, g.start, g.end])).toEqual([
      ['chr1', [0, 2], 90, 960],
      ['chr2', [1], 490, 550],
    ]);
  });
});
