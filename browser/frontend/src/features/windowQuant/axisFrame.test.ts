import { describe, expect, it } from 'vitest';
import { axisTicks, fromRelative, genomicToRelative, normalizeAxisFrame, relativeToGenomic, resolveAnchor, screenFraction, toRelative, type ResolvedAnchor } from './axisFrame';
import { effectiveBounds, normalizeQuantWindow, windowGenomic } from './spec';
import { bpToPx, pxToBp } from './WindowBand';
import { genomeToScreenOriented } from '../../utils/coordinates';
import type { Gene } from '../../types';

const gene = (id: string, start: number, end: number, strand: '+' | '-'): Gene => ({ id, name: id, chrom: 'chr1', start, end, strand, biotype: 'protein_coding', exons: [] });
const VIEW = { chrom: 'chr1', start: 1000, end: 3000 };
const genes = [gene('PLUS', 1500, 5000, '+'), gene('MINUS', 0, 2201, '-')];

describe('anchors', () => {
  it('TSS and gene end are strand-aware; the nearest gene to the centre by default; a chosen gene; the view centre; a position', () => {
    const minus = resolveAnchor({ mode: 'relative', anchor: 'tss', gene: null, position: null }, { ...VIEW, genes }) as ResolvedAnchor;
    // MINUS's TSS (end − 1 = 2200) is nearer the centre (2000) than PLUS's (1500).
    expect(minus).toMatchObject({ pos: 2200, strand: '-', name: 'TSS of MINUS', axisLabel: 'Distance from the TSS of MINUS (bp, gene on − strand)' });
    expect(resolveAnchor({ mode: 'relative', anchor: 'tss', gene: 'PLUS', position: null }, { ...VIEW, genes })).toMatchObject({ pos: 1500, strand: '+' });
    expect(resolveAnchor({ mode: 'relative', anchor: 'gene-end', gene: 'MINUS', position: null }, { ...VIEW, genes })).toMatchObject({ pos: 0, strand: '-' });
    expect(resolveAnchor({ mode: 'relative', anchor: 'centre', gene: null, position: null }, { ...VIEW, genes: [] })).toMatchObject({ pos: 2000, strand: '+', axisLabel: 'Distance from the view centre (bp)', name: 'view centre' });
    expect(resolveAnchor({ mode: 'relative', anchor: 'position', gene: null, position: 1234 }, { ...VIEW, genes: [] })).toMatchObject({ pos: 1234 });
    expect(resolveAnchor({ mode: 'relative', anchor: 'tss', gene: null, position: null }, { ...VIEW, genes: [] })).toHaveProperty('reason');
    // A meta-locus is anchored on its sites as the pool was built ('+': its minus sites are flipped in the pool).
    expect(resolveAnchor({ mode: 'relative', anchor: 'tss', gene: null, position: null }, { chrom: 'meta:p', start: 0, end: 20000, genes, meta: { site: 10000, word: 'TSS' } }))
      .toMatchObject({ pos: 10000, strand: '+', axisLabel: 'Distance from the site TSS (bp)' });
    expect(normalizeAxisFrame({ mode: 'relative', anchor: 'bogus' })).toEqual({ mode: 'relative', anchor: 'tss', gene: null, position: null });
  });

  it('relative numbers are signed by the anchor\'s direction: upstream negative on either strand', () => {
    const plus = { pos: 1000, strand: '+' as const }, minus = { pos: 1000, strand: '-' as const };
    expect(toRelative(800, plus)).toBe(-200);
    expect(toRelative(800, minus)).toBe(200);
    expect(fromRelative(-200, minus)).toBe(1200);
    // −200..+50 is upstream..downstream on both strands.
    expect(relativeToGenomic(-200, 50, plus)).toEqual([800, 1050]);
    expect(relativeToGenomic(-200, 50, minus)).toEqual([950, 1200]);
    expect(genomicToRelative(950, 1200, minus)).toEqual([-200, 50]);
  });

  it('a relative window means the same thing when the view moves (and is stored relative)', () => {
    const w = normalizeQuantWindow({ chrom: 'chr1', from: -200, to: 50, relative: true })!;
    expect(w).toEqual({ chrom: 'chr1', from: -200, to: 50, relative: true });
    const a = { pos: 2200, strand: '-' as const };
    expect(windowGenomic(w, 'chr1', a)).toEqual([2150, 2400]);
    expect(windowGenomic(w, 'chr1', null)).toBeNull();
    expect(effectiveBounds({ bounds: 'window' }, w, { chrom: 'chr1', start: 2000, end: 4000 }, a)).toMatchObject({ from: 2150, to: 2400, kind: 'window' });
    expect(effectiveBounds({ bounds: 'window' }, w, { chrom: 'chr1', start: 1000, end: 3000 }, a)).toMatchObject({ from: 2150, to: 2400 });
  });
});

describe('the plot runs as the reads do', () => {
  const W = 800, LEFT = 40, GEOM = { left: LEFT, width: W };
  const anchor = resolveAnchor({ mode: 'relative', anchor: 'tss', gene: 'MINUS', position: null }, { ...VIEW, genes }) as ResolvedAnchor;

  for (const reversed of [false, true]) {
    it(`minus-strand gene, view ${reversed ? 'flipped (Reverse on)' : 'not flipped'}: band, ticks and reads agree on every position`, () => {
      for (const g of [1000, 1234, 2200, 2999]) {
        // The reads' x (the read track's mapping) and the band's x are the same pixel.
        expect(bpToPx(g, GEOM, VIEW, reversed)).toBeCloseTo(LEFT + genomeToScreenOriented(g, VIEW.start, VIEW.end, W, reversed), 9);
        expect(pxToBp(bpToPx(g, GEOM, VIEW, reversed), GEOM, VIEW, reversed)).toBe(g);
        expect(screenFraction(g, VIEW, reversed) * W).toBeCloseTo(genomeToScreenOriented(g, VIEW.start, VIEW.end, W, reversed), 9);
      }
      const ticks = axisTicks(VIEW, reversed, anchor);
      // Each relative tick sits where the reads show its genomic position.
      for (const t of ticks) {
        const r = Number(t.label.replace(/[+,]/g, ''));
        expect(t.t * W).toBeCloseTo(genomeToScreenOriented(fromRelative(r, anchor), VIEW.start, VIEW.end, W, reversed), 6);
      }
      // Not flipped: genome left to right, so a minus-strand gene's downstream (positive) side is on the left.
      // Flipped (Reverse on, reads and plots together): downstream reads left to right.
      const first = Number(ticks[0].label.replace(/[+,]/g, '')), last = Number(ticks[ticks.length - 1].label.replace(/[+,]/g, ''));
      if (reversed) expect(first).toBeLessThan(last); else expect(first).toBeGreaterThan(last);
    });
  }

  it('a plus-strand gene reads upstream to downstream left to right without flipping', () => {
    const a = resolveAnchor({ mode: 'relative', anchor: 'tss', gene: 'PLUS', position: null }, { ...VIEW, genes }) as ResolvedAnchor;
    const t = axisTicks(VIEW, false, a);
    expect(Number(t[0].label.replace(/[+,]/g, ''))).toBeLessThan(Number(t[t.length - 1].label.replace(/[+,]/g, '')));
    expect(axisTicks(VIEW, false, null).map(x => x.label)[0]).toBe('1,000');
  });
});
