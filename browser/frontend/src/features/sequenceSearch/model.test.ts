import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS, clampSetting, formatEvalue, hitLocus, hitMatchText, hitWindow, hitsToBed, looksLikeSequence,
  parseSequence, plannedMode, resultSummary, type SequenceHit,
} from './model';
import { SEARCH_SCORE } from '../../utils/search/providers';
import { SEQUENCE_SUGGESTION_SCORE, sequenceSearchProvider } from './provider';

const hit = (over: Partial<SequenceHit> = {}): SequenceHit => ({
  chrom: 'chr1', start: 999, end: 1016, strand: '+', mismatches: 0, identity: 100, evalue: null, bitscore: null,
  qstart: 0, qend: 17, matched: 'GATTACAGGCTTCAAGT', ...over,
});

describe('parseSequence', () => {
  it('takes FASTA text, spaces, numbers and RNA', () => {
    expect(parseSequence('>my seq\n1 gattacaggc ttcaagt\n')).toEqual({ ok: true, seq: 'GATTACAGGCTTCAAGT' });
    expect(parseSequence('GAUUACAGGCUUCAAGU')).toEqual({ ok: true, seq: 'GATTACAGGCTTCAAGT' });
  });

  it('refuses what is not one DNA sequence, as the server does', () => {
    expect(parseSequence('')).toMatchObject({ ok: false, error: expect.stringMatching(/Paste/) });
    expect(parseSequence('ACGT')).toMatchObject({ ok: false, error: expect.stringMatching(/at least 12/) });
    expect(parseSequence('ACGTACGTACGTXZ')).toMatchObject({ ok: false, error: expect.stringMatching(/Not DNA: 'X' 'Z'/) });
    expect(parseSequence('>a\nACGTACGTACGTAC\n>b\nACGTACGTACGTAC')).toMatchObject({ ok: false, error: expect.stringMatching(/one sequence/) });
    expect(parseSequence('NNNNNNNNNNNNNNNNNNNNACGT')).toMatchObject({ ok: false, error: expect.stringMatching(/ambiguous/) });
    expect(parseSequence('ACGTACGT', 8)).toEqual({ ok: true, seq: 'ACGTACGT' });
  });
});

describe('looksLikeSequence (the locus box offer)', () => {
  it('offers pasted DNA of 12+ bases, IUPAC included', () => {
    expect(looksLikeSequence('GATTACAGGCTTCAAGT')).toBe(true);
    expect(looksLikeSequence('gattaca ggcttc aagt')).toBe(true);
    expect(looksLikeSequence('GATTACANNRYGGCT')).toBe(true);
    expect(looksLikeSequence('>oligo\nGATTACAGGCTTCAAGT')).toBe(true);
  });

  it('never offers coordinates, genes, read names or short words', () => {
    for (const text of ['chr1:1000-2000', 'NAPA', 'ACTG1', 'GATTACA', 'm64012_190920_173625/1/ccs', 'CACNA1A', 'BRCA2 +/- 2kb', 'ACGTACGTACGT1']) {
      expect(looksLikeSequence(text), text).toBe(false);
    }
  });
});

describe('plannedMode', () => {
  const s = { ...DEFAULT_SETTINGS };
  it('uses the exact scan for short queries and any with IUPAC codes, BLAST for long ones', () => {
    expect(plannedMode('A'.repeat(20), s, true)).toEqual({ mode: 'exact', fallback: false });
    expect(plannedMode('ACGT'.repeat(10) + 'N', s, true)).toEqual({ mode: 'exact', fallback: false });
    expect(plannedMode('ACGT'.repeat(10), s, true)).toEqual({ mode: 'blast', fallback: false });
    expect(plannedMode('ACGT'.repeat(10), { ...s, exact_max_length: 50 }, true).mode).toBe('exact');
    expect(plannedMode('A'.repeat(20), { ...s, mode: 'blast' }, true).mode).toBe('blast');
  });

  it('falls back to exact when BLAST is not available', () => {
    expect(plannedMode('ACGT'.repeat(10), s, false)).toEqual({ mode: 'exact', fallback: true });
  });
});

describe('settings, hits, BED', () => {
  it('clamps settings to their limits', () => {
    expect(clampSetting('max_mismatches', 9)).toBe(5);
    expect(clampSetting('max_hits', 0)).toBe(1);
    expect(clampSetting('max_hits', Number.NaN)).toBe(DEFAULT_SETTINGS.max_hits);
    expect(clampSetting('evalue', 0.5)).toBe(0.5);
  });

  it('shows 1-based loci and a padded window', () => {
    expect(hitLocus(hit())).toBe('chr1:1,000-1,016');
    expect(hitWindow(hit())).toEqual({ start: 899, end: 1116 });
    expect(hitWindow({ start: 10, end: 20 }, 50)).toEqual({ start: 0, end: 50 });
  });

  it('writes BED6 with strand and identity scores', () => {
    const bed = hitsToBed([hit(), hit({ start: 19_999, end: 20_016, strand: '-', mismatches: 1, identity: 94.12 })]);
    const rows = bed.trim().split('\n');
    expect(rows[0]).toMatch(/^track name="sequence_search"/);
    expect(rows[1].split('\t')).toEqual(['chr1', '999', '1016', 'hit1', '1000', '+']);
    expect(rows[2].split('\t')).toEqual(['chr1', '19999', '20016', 'hit2_mm1', '941', '-']);
  });

  it('describes matches and results', () => {
    expect(hitMatchText(hit())).toBe('exact');
    expect(hitMatchText(hit({ mismatches: 2 }))).toBe('2 mismatches');
    expect(hitMatchText(hit({ mismatches: null, identity: 98.5 }))).toBe('98.5% identity');
    expect(formatEvalue(1.234e-45)).toBe('1.2e-45');
    expect(formatEvalue(0.0034)).toBe('0.0034');
    expect(formatEvalue(null)).toBe('—');
    expect(resultSummary({ hits: [hit(), hit()], total: 2, mode: 'exact' })).toBe('2 hits (exact search, both strands)');
    expect(resultSummary({ hits: [hit()], total: 1234, total_is_lower_bound: true, mode: 'blast', task: 'megablast' }))
      .toBe('Showing 1 of at least 1,234 hits (BLAST megablast)');
    expect(resultSummary({ hits: [], total: 0, mode: 'exact' })).toBe('No hits (exact search, both strands)');
  });
});

describe('the locus box suggestion', () => {
  const ctx = { source: 'locus' as const, signal: new AbortController().signal };
  it('offers a strong "Find this sequence in the genome" for DNA only', () => {
    const [s] = sequenceSearchProvider.search('GATTACAGGCTTCAAGT', ctx) as ReturnType<typeof sequenceSearchProvider.search> & unknown[];
    expect(s).toMatchObject({ kind: 'sequence', label: 'Find this sequence in the genome' });
    expect(s.score).toBe(SEQUENCE_SUGGESTION_SCORE);
    // Enter runs it, but an exact gene or region name and coordinates still come first.
    expect(s.score).toBeGreaterThanOrEqual(SEARCH_SCORE.strong);
    expect(s.score).toBeLessThan(SEARCH_SCORE.regionExact);
    expect(sequenceSearchProvider.search('NAPA', ctx)).toEqual([]);
    expect(sequenceSearchProvider.mightAnswer?.('chr19:1-100')).toBe(false);
  });

  it('leaves no status line under the locus box (the panel shows the search)', async () => {
    const [s] = sequenceSearchProvider.search('GATTACAGGCTTCAAGT', ctx) as any[];
    expect(await s.run(ctx)).toEqual({ ok: true });
  });

  it('is not offered in a panel box on another assembly', () => {
    expect(sequenceSearchProvider.search('GATTACAGGCTTCAAGT', { ...ctx, source: 'panel-locus', genome: 'dm6' })).toEqual([]);
  });
});

describe('pastedSequence (release audit 3.1.0)', () => {
  it('joins a sequence pasted on several lines, or a FASTA record, into the sequence', async () => {
    const { pastedSequence } = await import('./model');
    expect(pastedSequence('GATTACAG\nGCTTCAAGT')).toBe('GATTACAGGCTTCAAGT');
    expect(pastedSequence('>oligo 1\r\ngattacag\r\ngcttcaagt\r\n')).toBe('GATTACAGGCTTCAAGT');
    expect(pastedSequence('>iupac\nGATTACAGRY\nGCTTCAAGT')).toBe('GATTACAGRYGCTTCAAGT');
    expect(pastedSequence('     1 gattacaggc ttcaagt\n    18 gattacaggc')).toBe('GATTACAGGCTTCAAGTGATTACAGGC');
  });
  it('leaves single lines, name lists and short or several records alone', async () => {
    const { pastedSequence } = await import('./model');
    expect(pastedSequence('GATTACAGGCTTCAAGT')).toBeNull();
    expect(pastedSequence('ATM\nATR\nMYC\nGATA\nCHK')).toBeNull();
    expect(pastedSequence('read_1/ccs\nread_2/ccs')).toBeNull();
    expect(pastedSequence('ACGT\nACG')).toBeNull();
    expect(pastedSequence('>a\nGATTACAGGCTTCAAGT\n>b\nGATTACAGGCTTCAAGT')).toBeNull();
  });
});
