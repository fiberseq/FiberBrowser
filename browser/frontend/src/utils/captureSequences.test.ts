import { describe, expect, it } from 'vitest';
import { fetchCaptureSequences } from './captureSequences';

describe('fetchCaptureSequences', () => {
  it('reports a region missing from the reference or cut short, never fills it with N', async () => {
    const fetchSequence = async (chrom: string, start: number, end: number) => {
      if (chrom === 'contigX') throw new Error('404');
      if (chrom === 'chrM') return 'A'.repeat(5);
      return 'C'.repeat(end - start);
    };
    const { entries, failures } = await fetchCaptureSequences([
      { name: 'ok', chrom: 'chr1', start: 0, end: 10 },
      { name: 'missing', chrom: 'contigX', start: 0, end: 10 },
      { name: 'short', chrom: 'chrM', start: 0, end: 10 },
    ], fetchSequence);
    expect(entries).toEqual([{ name: 'ok', seq: 'C'.repeat(10) }]);
    expect(failures).toEqual([
      'missing (contigX:0-10) is not in the reference',
      'short (chrM:0-10) has 5 of 10 bases',
    ]);
  });
});
