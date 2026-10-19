import { describe, expect, it } from 'vitest';
import { footprintGroups } from './footprintGroups';
import { layoutLens, mapLensRead, type LensEntry, type LensResponse } from '../insertion/insertionLensModel';

const response = { success: true, chrom: 'chrTest', flank: 0,
  cluster: { ref: 100, len: 80 },
  carriers: [
    { id: 'first', len: 80, read: { intervals: [], layers: { nuc: { intervals: [[0, 40, 40]] } } } },
    { id: 'second', len: 80, read: { intervals: [], layers: { nuc: { intervals: [[0, 40, 40]] } } } },
    { id: 'end', len: 40, partial: 'end', read: { intervals: [], layers: { nuc: { intervals: [] } } } },
    { id: 'unknown', len: 80, read: { intervals: [] } },
    { id: 'hard', len: 80, hard: true, read: { intervals: [], layers: { nuc: { intervals: [] } } } },
  ], reference: [],
} as unknown as LensResponse;

describe('bounded footprint pattern clustering of the frozen lens', () => {
  it('preserves half-open footprint membership when a probe is exactly on an edge', () => {
    const edge = { ...response, carriers: [{ ...response.carriers[0], read: { intervals: [], layers: { nuc: { intervals: [[10, 30, 20]] } } } }] } as unknown as LensResponse;
    for (const reverse of [false, true]) expect(footprintGroups(layoutLens(edge, 'left', reverse), 'nuc')[0].pattern).toBe('1000');
  });
  it('maps numeric deamination opportunities without treating them as observed deamination pairs', () => {
    const entry = { len: 80, read: { intervals: [], possible_deam_ct: [2, 12], possible_deam_ga: [7], deam: [[12, 1]] } } as unknown as LensEntry;
    const mapped = mapLensRead(entry, { flank: 0, displayLen: 80, total: 80, reversed: true }, 'left');
    expect(mapped.possible_deam_ct).toEqual([67, 77]);
    expect(mapped.possible_deam_ga).toEqual([72]);
    expect(mapped.deam).toEqual([[67, 1]]);
  });
  it.each([false, true])('keeps all molecules, unknown layers and partial coverage explicit (reversed=%s)', reversed => {
    const layout = layoutLens(response, 'left', reversed);
    const before = JSON.stringify(layout);
    const groups = footprintGroups(layout, 'nuc', 4);
    expect(groups.find(g => g.pattern === '1100')?.indices).toEqual([0, 1]);
    expect(groups.find(g => g.pattern === '??00')?.indices).toEqual([2]);
    expect(groups.find(g => g.pattern === '????')?.indices).toEqual([3, 4]);
    expect(groups.flatMap(g => g.indices).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(JSON.stringify(layout)).toBe(before);
    expect(footprintGroups(layout, 'none')).toEqual([]);
    expect(footprintGroups(layout, 'msp')).toEqual([{ pattern: '????', indices: [0, 1, 2, 3, 4] }]);
  });
});
