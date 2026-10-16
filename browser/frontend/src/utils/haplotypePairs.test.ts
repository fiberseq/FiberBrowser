import { describe, expect, it } from 'vitest';
import { detectHaplotypePairs } from './haplotypePairs';

describe('haplotype pair detection', () => {
  it('detects supported haplotype suffix conventions', () => {
    expect(detectHaplotypePairs([
      'chr2_hap1',
      'chr2_hap2',
      'chr3-paternal',
      'chr3-maternal',
      'contigA_h1',
      'contigA_h2',
      'chr4',
    ])).toEqual([
      { base: 'chr2', chrom1: 'chr2_hap1', chrom2: 'chr2_hap2' },
      { base: 'chr3', chrom1: 'chr3-paternal', chrom2: 'chr3-maternal' },
      { base: 'contigA', chrom1: 'contigA_h1', chrom2: 'contigA_h2' },
    ]);
  });

  it('ignores incomplete or ambiguous groups', () => {
    expect(detectHaplotypePairs([
      'chr2_hap1',
      'chr3_hap1',
      'chr3_hap2',
      'chr3_pat',
      'chr5',
    ])).toEqual([]);
  });
});
