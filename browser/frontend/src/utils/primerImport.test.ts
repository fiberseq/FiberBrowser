import { describe, expect, it } from 'vitest';
import { parsePrimerFile } from './primerImport';

const bed = (rows: string[][]) => rows.map(r => r.join('\t')).join('\n');

describe('BED primer import', () => {
  it('keeps same-named pairs on different chromosomes apart', () => {
    const { primers, errors } = parsePrimerFile('p.bed', bed([
      ['chr1', '100', '120', 'P_F', '0', '+', 'ACGT'],
      ['chr1', '300', '320', 'P_R', '0', '-', 'TTGA'],
      ['chr2', '500', '520', 'P_F', '0', '+', 'GGCA'],
      ['chr2', '700', '720', 'P_R', '0', '-', 'CCAT'],
    ]));
    expect(errors).toEqual([]);
    expect(primers.map(p => [p.name, p.chrom, p.targetStart])).toEqual([['P_chr1', 'chr1', 100], ['P_chr2', 'chr2', 500]]);
  });

  it('reports a duplicate direction instead of overwriting it', () => {
    const { primers, errors } = parsePrimerFile('p.bed', bed([
      ['chr1', '100', '120', 'P_F', '0', '+', 'ACGT'],
      ['chr1', '150', '170', 'P_F', '0', '+', 'AAAA'],
      ['chr1', '300', '320', 'P_R', '0', '-', 'TTGA'],
    ]));
    expect(primers).toHaveLength(1);
    expect(primers[0].name).toBe('P');
    expect(primers[0].pair.fwd_start).toBe(100);
    expect(errors).toEqual(['Pair "P" on chr1 has more than one forward primer; keeping the first']);
  });
});
