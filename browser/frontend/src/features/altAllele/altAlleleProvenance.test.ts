import { describe, expect, it } from 'vitest';
import { altAlleleProvenance, buildingText } from './AltAlleleProvenance';
import type { AltAlleleInfo, AltAlleleLayout } from './types';

const layout: AltAlleleLayout = {
  chrom: 'chr2L', ref: 9_467_038, insert_len: 9_184, flank_left: 20_000, flank_right: 20_000,
  name: 'chr2L_9467038_INS9184', length: 49_184, insert_start: 20_000, insert_end: 29_184,
};
const info = (carriers: NonNullable<NonNullable<AltAlleleInfo['meta']>['carriers']>, more: Partial<NonNullable<AltAlleleInfo['meta']>> = {}): AltAlleleInfo => ({
  source_dataset_id: 'numb', layout,
  definition: { chrom: 'chr2L', ref: 9_467_038, length: 9_184, pos: null, flank: 20_000, include_reference: false, max_carriers: 5_000, include_duplicates: false },
  meta: { consensus: { method: 'majority', length: 9_184 }, carriers, excluded: { other_insert: 4, not_informative: 30 }, seconds: 31.2, ...more },
});
const text = (sections: ReturnType<typeof altAlleleProvenance>) => sections.map(s => `${s.title}: ${s.lines.join(' | ')}`).join('\n');

describe('an insert-expanded panel\'s provenance', () => {
  it('says which carriers it shows, the partial ones and why others are left out', () => {
    const t = text(altAlleleProvenance(layout, info({ total: 120, written: 118, sampled: false, cigar: 100, clip_start: 8, clip_end: 6, hard: 4, poorly_aligned: 2 }), 'numb 2-4 h'));
    expect(t).toContain('120 carriers found at the site; 118 placed on the contig');
    expect(t).toContain('Soft-clipped at the breakpoint (partial: only the part of the insert they hold): 14 (8 at the left, 6 at the right)');
    expect(t).toContain('Hard-clipped (partial: their flank only, the clipped bases are not in the read): 4');
    expect(t).toContain('2 could not be placed');
    expect(t).toContain('2 placed with under 80%');
    expect(t).toContain('Left out: 4 with another insertion at the site');
    expect(t).toContain('30 not informative');
    expect(t).toContain('duplicates (flagged) are left out');
    expect(t).toContain('Carriers from numb 2-4 h');
    expect(t).toContain('Built in 31.2 s');
  });

  it('a capped build says it sampled, and how many it left out', () => {
    const t = text(altAlleleProvenance(layout, info({ total: 12_000, written: 5_000, sampled: true, cigar: 4_000, clip_start: 500, clip_end: 400, hard: 100 })));
    expect(t).toContain('Sampled: more carriers than the cap (5,000), so 5,000 were taken evenly along the site and 7,000 left out');
  });

  it('maps the contig to the reference: flanks, insert, breakpoint', () => {
    const t = text(altAlleleProvenance(layout, undefined));
    expect(t).toContain('1–20,000 = chr2L:9,447,039–9,467,038 (left flank)');
    expect(t).toContain('20,001–29,184 = the insert');
    expect(t).toContain('29,185–49,184 = chr2L:9,467,039–9,487,038 (right flank)');
    expect(t).toContain('Breakpoint: between chr2L:9,467,038 and 9,467,039');
  });

  it('the building chip says how long so far and what to expect', () => {
    expect(buildingText('Building the alternate allele of +9,184 bp…', 12)).toMatch(/12 s \(the first build of an insertion takes about 25–40 s/);
  });
});
