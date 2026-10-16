import { describe, expect, it } from 'vitest';
import { boundingTarget } from './CapturePanel';

describe('boundingTarget', () => {
  it("bounds the selected peaks on their own chromosome, not the view's", () => {
    expect(boundingTarget([
      { chrom: 'chrX', start: 500, end: 600 },
      { chrom: 'chrX', start: 100, end: 200 },
    ], 'chr2L')).toEqual({ chrom: 'chrX', start: 100, end: 600, size: 500, count: 2 });
  });

  it('treats peaks without a chromosome as the view chromosome', () => {
    expect(boundingTarget([{ start: 10, end: 20 }], 'chr2L')).toMatchObject({ chrom: 'chr2L', start: 10, end: 20 });
  });

  it('has no bounding region across chromosomes', () => {
    expect(boundingTarget([
      { chrom: 'chrX', start: 100, end: 200 },
      { start: 300, end: 400 },
    ], 'chr2L')).toEqual({ chroms: ['chrX', 'chr2L'], count: 2 });
    expect(boundingTarget([], 'chr2L')).toBeNull();
  });
});
