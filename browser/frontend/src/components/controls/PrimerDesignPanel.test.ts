import { describe, expect, it } from 'vitest';
import { designedAt, peaksOnLocus, primerTargetChrom } from './PrimerDesignPanel';

describe('primerTargetChrom', () => {
  it("takes the selected peaks' own chromosome, not the view's", () => {
    expect(primerTargetChrom([{ chrom: 'chr2' }, { chrom: 'chr2' }], 'chr1')).toEqual({ chroms: ['chr2'], chrom: 'chr2', mixed: false });
    expect(primerTargetChrom([{}], 'chr1')).toEqual({ chroms: ['chr1'], chrom: 'chr1', mixed: false });
    expect(primerTargetChrom([{ chrom: 'chr2' }, {}], 'chr1').mixed).toBe(true);
  });
});
import type { PrimerPair } from '../../types/primer';

describe('primer design context', () => {
  it('tags results with the chromosome and target they were designed for', () => {
    const pair = { fwd_seq: 'ACGT', rev_seq: 'TGCA' } as unknown as PrimerPair;
    expect(designedAt('chr3L', 100, 900)(pair)).toMatchObject({
      fwd_seq: 'ACGT', designChrom: 'chr3L', designTargetStart: 100, designTargetEnd: 900,
    });
  });

  it("matches 3C peaks by the locus's chromosome as well as its interval", () => {
    const peaks = [
      { index: 0, chrom: 'chrX', start: 150, end: 250 },
      { index: 1, start: 150, end: 250 },               // the main view's (chr2L)
      { index: 2, chrom: 'chr2L', start: 5000, end: 5100 },
    ];
    expect(peaksOnLocus(peaks, { chrom: 'chr2L', start: 100, end: 300 }, 'chr2L').map(p => p.index)).toEqual([1]);
    expect(peaksOnLocus(peaks, { chrom: 'chrX', start: 100, end: 300 }, 'chr2L').map(p => p.index)).toEqual([0]);
  });
});
