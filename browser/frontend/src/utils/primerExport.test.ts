import { describe, expect, it } from 'vitest';
import type { SavedPrimer } from '../types';
import { formatPrimerOrder } from './primerExport';

function primer(name = 'Pair 1'): SavedPrimer {
  return {
    name,
    chrom: 'chr2L',
    targetStart: 100,
    targetEnd: 200,
    addedAt: 1,
    source: 'design',
    pair: {
      fwd_seq: 'ACGTACGTACGTACGTAC',
      fwd_start: 80,
      fwd_end: 98,
      fwd_tm: 60.1,
      fwd_len: 18,
      rev_seq: 'TGCATGCATGCATGCATG',
      rev_start: 210,
      rev_end: 228,
      rev_tm: 60.3,
      rev_len: 18,
      product_size: 148,
      tm_diff: 0.2,
      g_count: 8,
    },
  };
}

describe('formatPrimerOrder', () => {
  it('formats IDT-style CSV with escaped primer names', () => {
    const result = formatPrimerOrder([primer('Pair, One')], 'idt');

    expect(result.filename).toBe('primer_order_idt.csv');
    expect(result.content.split('\n')).toEqual([
      'Name,Sequence,Scale,Purification',
      '"Pair, One_F",ACGTACGTACGTACGTAC,25 nmole,STD',
      '"Pair, One_R",TGCATGCATGCATGCATG,25 nmole,STD',
    ]);
  });

  it('formats Eurofins plate CSV with generated wells and plate names', () => {
    const result = formatPrimerOrder([primer('Amplicon')], 'eurofins');

    expect(result.filename).toBe('primer_order_eurofins_plate.csv');
    expect(result.content.split('\n')).toEqual([
      'Well,Oligo Name,Sequence,PlateName',
      'A1,Amplicon_F,ACGTACGTACGTACGTAC,FiberBrowser_1',
      'A2,Amplicon_R,TGCATGCATGCATGCATG,FiberBrowser_1',
    ]);
  });

  it('neutralizes spreadsheet formula injection in primer names', () => {
    const result = formatPrimerOrder([primer('=cmd|calc')], 'generic');

    const lines = result.content.split('\n');
    // Leading '=' is prefixed with a single quote so spreadsheets treat it as text.
    expect(lines[1]).toBe("'=cmd|calc_F,ACGTACGTACGTACGTAC,F");
    expect(lines[2]).toBe("'=cmd|calc_R,TGCATGCATGCATGCATG,R");
  });

  it('quotes and neutralizes a name that both injects and contains a delimiter', () => {
    const result = formatPrimerOrder([primer('+1,2')], 'generic');

    // Prefixed with ' for injection, then wrapped in quotes for the comma.
    expect(result.content.split('\n')[1]).toBe('"\'+1,2_F",ACGTACGTACGTACGTAC,F');
  });

  it('formats FASTA order exports', () => {
    const result = formatPrimerOrder([primer('Amplicon')], 'fasta');

    expect(result.filename).toBe('primer_order.fasta');
    expect(result.content).toBe([
      '>Amplicon_F',
      'ACGTACGTACGTACGTAC',
      '>Amplicon_R',
      'TGCATGCATGCATGCATG',
    ].join('\n'));
  });
});
