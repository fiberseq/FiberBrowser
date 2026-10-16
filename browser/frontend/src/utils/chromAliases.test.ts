import { describe, expect, it } from 'vitest';
import { findChromInfo, sameChrom } from './chromAliases';
import type { ChromInfo } from '../types';

const chroms: ChromInfo[] = [
  { name: '1', size: 1000 },
  { name: 'chrM', size: 16569, circular: true, circular_source: 'mito' },
];

describe('findChromInfo', () => {
  it('matches chr-prefixed aliases', () => {
    expect(findChromInfo(chroms, 'chr1')?.name).toBe('1');
    expect(findChromInfo(chroms, '1')?.name).toBe('1');
  });

  it('matches mitochondrial aliases', () => {
    expect(findChromInfo(chroms, 'MT')?.name).toBe('chrM');
    expect(findChromInfo(chroms, 'chrMT')?.name).toBe('chrM');
  });
});

describe('sameChrom', () => {
  it('matches chr-prefixed and bare names, and the mitochondrial aliases', () => {
    expect(sameChrom('chr1', '1')).toBe(true);
    expect(sameChrom('chrM', 'MT')).toBe(true);
    expect(sameChrom('chrX', 'X')).toBe(true);
    expect(sameChrom('chr1', 'chr2')).toBe(false);
    expect(sameChrom('chr1', 'chr10')).toBe(false);
  });

  it('an empty name never matches a contig named "chr"', () => {
    expect(sameChrom('', 'chr')).toBe(false);
    expect(sameChrom('chr', '')).toBe(false);
    expect(findChromInfo([{ name: 'chr', size: 10 }], '')).toBeUndefined();
  });
});
