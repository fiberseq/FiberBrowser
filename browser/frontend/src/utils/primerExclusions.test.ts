import { describe, expect, it } from 'vitest';
import type { SavedPrimer } from '../types';
import { buildPrimerExcludeRegions, buildPrimerExcludeRegionsByChrom } from './primerExclusions';

function savedPrimer(overrides: Partial<SavedPrimer> = {}): SavedPrimer {
  return {
    name: 'primer-a',
    chrom: 'chr2R',
    targetStart: 100,
    targetEnd: 200,
    addedAt: 1,
    source: 'design',
    pair: {
      fwd_seq: 'AAAA',
      fwd_start: 90,
      fwd_end: 110,
      fwd_tm: 60,
      fwd_len: 20,
      rev_seq: 'TTTT',
      rev_start: 190,
      rev_end: 210,
      rev_tm: 60,
      rev_len: 20,
      product_size: 120,
      tm_diff: 0,
      g_count: 0,
    },
    ...overrides,
  };
}

describe('primerExclusions', () => {
  it('builds padded exclusion regions for a single chromosome', () => {
    expect(buildPrimerExcludeRegions([savedPrimer()], 'chr2R', true, 5)).toEqual([
      [85, 115],
      [185, 215],
    ]);
  });

  it('ignores other chromosomes and disabled exclusion', () => {
    const primers = [savedPrimer(), savedPrimer({ chrom: 'chr3L' })];
    expect(buildPrimerExcludeRegions(primers, 'chr2R', true, 0)).toHaveLength(2);
    expect(buildPrimerExcludeRegions(primers, 'chr2R', false, 5)).toEqual([]);
  });

  it('groups exclusion regions by chromosome for split-locus design', () => {
    const primers = [savedPrimer(), savedPrimer({ name: 'primer-b', chrom: 'chr3L' })];
    expect(buildPrimerExcludeRegionsByChrom(primers, true, 2)).toEqual({
      chr2R: [[88, 112], [188, 212]],
      chr3L: [[88, 112], [188, 212]],
    });
  });

  it('clamps negative padded starts to zero', () => {
    const primer = savedPrimer({
      pair: {
        ...savedPrimer().pair,
        fwd_start: 2,
        fwd_end: 12,
      },
    });
    expect(buildPrimerExcludeRegions([primer], 'chr2R', true, 10)[0]).toEqual([0, 22]);
  });
});
