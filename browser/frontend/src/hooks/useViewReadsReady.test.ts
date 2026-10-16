import { describe, expect, it } from 'vitest';
import { viewReadsReady } from './useViewReadsReady';

const s = (chrom: string, start: number, end: number, loading: boolean, stale = false) =>
  ({ datasetId: 'd', chrom, start, end, loading, stale } as any);

describe('viewReadsReady', () => {
  it('waits while a panel showing the view loads it', () => {
    expect(viewReadsReady({ a: s('chr1', 0, 10, true) }, 'chr1', 0, 10)).toBe(false);
    expect(viewReadsReady({ a: s('chr1', 0, 10, false, true) }, 'chr1', 0, 10)).toBe(false);
    expect(viewReadsReady({ a: s('chr1', 0, 10, false) }, 'chr1', 0, 10)).toBe(true);
  });
  it('ignores panels at other loci, and is ready with no read panels', () => {
    expect(viewReadsReady({ a: s('chr2', 0, 10, true) }, 'chr1', 0, 10)).toBe(true);
    expect(viewReadsReady({}, 'chr1', 0, 10)).toBe(true);
  });
});
