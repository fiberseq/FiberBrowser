import '../testSetup';
import { describe, it, expect } from 'vitest';
import {
  altLayoutForContig, altPositionLabel, altToRef, describeAltPosition, mapSpanToAlt, mapSpanToRef, refToAlt,
} from './altAlleleCoords';
import type { AltAlleleLayout } from './types';

const L: AltAlleleLayout = {
  chrom: 'chr2L', ref: 9_467_038, insert_len: 9_184, flank_left: 20_000, flank_right: 20_000,
  name: 'chr2L_9467038_INS9184', length: 49_184, insert_start: 20_000, insert_end: 29_184,
};

describe('alt-allele coordinates', () => {
  it('maps the reference onto the contig, offsetting positions after the insert by its length', () => {
    expect(refToAlt(L, 9_447_038)).toBe(0);
    expect(refToAlt(L, 9_467_037)).toBe(19_999);
    expect(refToAlt(L, 9_467_038)).toBe(29_184);
    expect(refToAlt(L, 9_467_100)).toBe(29_246);
  });

  it('maps the contig back, positions inside the insert to the breakpoint', () => {
    expect(altToRef(L, 19_999)).toBe(9_467_037);
    expect(altToRef(L, 20_000)).toBe(9_467_038);
    expect(altToRef(L, 25_000)).toBe(9_467_038);
    expect(altToRef(L, 29_184)).toBe(9_467_038);
    expect(altToRef(L, 29_246)).toBe(9_467_100);
    for (const g of [9_447_038, 9_460_000, 9_467_037, 9_467_038, 9_480_000]) expect(altToRef(L, refToAlt(L, g))).toBe(g);
  });

  it('gives both readouts', () => {
    expect(describeAltPosition(L, 20_000)).toEqual({ segment: 'insert', ref: null, insert: 1 });
    expect(describeAltPosition(L, 29_183)).toEqual({ segment: 'insert', ref: null, insert: 9_184 });
    expect(describeAltPosition(L, 0)).toEqual({ segment: 'left', ref: 9_447_038, insert: null });
    expect(altPositionLabel(L, 21_233)).toBe('INS 1,234 / 9,184');
    expect(altPositionLabel(L, 29_184)).toBe('chr2L:9,467,039');
  });

  it('a reference view across the breakpoint widens by the insert; one wholly on a flank keeps its width', () => {
    expect(mapSpanToAlt(L, { chrom: 'chr2L', start: 9_466_038, end: 9_468_038 }))
      .toEqual({ chrom: L.name, start: 19_000, end: 30_184 });
    expect(mapSpanToAlt(L, { chrom: 'chr2L', start: 9_468_000, end: 9_469_000 }))
      .toEqual({ chrom: L.name, start: 30_146, end: 31_146 });
    // Another chromosome, or off the contig: no view.
    expect(mapSpanToAlt(L, { chrom: 'chr3R', start: 9_466_038, end: 9_468_038 })).toBeNull();
    expect(mapSpanToAlt(L, { chrom: 'chr2L', start: 1_000, end: 2_000 })).toBeNull();
    // Clamped to the contig.
    expect(mapSpanToAlt(L, { chrom: 'chr2L', start: 9_400_000, end: 9_500_000 })).toEqual({ chrom: L.name, start: 0, end: 49_184 });
  });

  it('an alt view maps back through the breakpoint; one inside the insert sits on it at its width', () => {
    expect(mapSpanToRef(L, { chrom: L.name, start: 19_000, end: 30_184 }))
      .toEqual({ chrom: 'chr2L', start: 9_466_038, end: 9_468_038 });
    expect(mapSpanToRef(L, { chrom: L.name, start: 21_000, end: 23_000 }))
      .toEqual({ chrom: 'chr2L', start: 9_466_038, end: 9_468_038 });
    // Half in the insert: the inside end is the breakpoint.
    expect(mapSpanToRef(L, { chrom: L.name, start: 19_000, end: 25_000 }))
      .toEqual({ chrom: 'chr2L', start: 9_466_038, end: 9_467_039 });
    expect(mapSpanToRef(L, { chrom: 'chr2L', start: 1, end: 2 })).toBeNull();
  });

  it('finds a contig\'s layout among the datasets', () => {
    const datasets = [{ id: 'a' }, { id: 'b', alt_allele: { layout: L } }];
    expect(altLayoutForContig(datasets, L.name)).toBe(L);
    expect(altLayoutForContig(datasets, 'chr2L')).toBeNull();
  });
});
