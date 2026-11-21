/** BED size plots on the client: chunk counts add exactly; Random N becomes the N-th smallest key per dataset. */
import { describe, expect, it } from 'vitest';
import { addCounts, bedFinishSettings, bedSizesKey, keyCuts } from './BedSizePlot';
import { comparisons } from './compare';
import { effectiveSizeSettings, newPlot } from './plotModel';

describe('BED size plots', () => {
  it('chunks add up cell by cell, with their margins and reads', () => {
    const sums = {};
    addCounts(sums, { 's|d1': { matrix: [[1, 0], [0, 2]], row: [1, 2], col: [1, 2], n_reads: 3 } });
    addCounts(sums, { 's|d1': { matrix: [[0, 4], [1, 0]], row: [4, 1], col: [1, 4], n_reads: 2 }, 't|d1': { matrix: [[1]], row: [1], col: [1], n_reads: 1 } });
    expect(sums).toEqual({ 's|d1': { matrix: [[1, 4], [1, 2]], row: [5, 3], col: [2, 6], n_reads: 5 }, 't|d1': { matrix: [[1]], row: [1], col: [1], n_reads: 1 } });
  });
  it('the key cut keeps exactly N distinct reads (a read seen in two regions once)', () => {
    const names = { d1: [['a', '30'], ['b', '10'], ['a', '30'], ['c', '18446744073709551615'], ['d', '20']] as Array<[string, string]>, d2: [['x', '5']] as Array<[string, string]> };
    expect(keyCuts(names, 2)).toEqual({ d1: '20' });
    expect(keyCuts(names, 3)).toEqual({ d1: '30' });
  });
  it('Compare finishes raw counts (not row-normalised shares) and keys the request on it', () => {
    const plot = { ...newPlot('size-enrichment'), where: 'bed' as const };
    const cmp = { ...plot, compare: 'log2ratio' as const };
    expect(bedFinishSettings(plot, 2).normalization).toBe(effectiveSizeSettings(plot).normalization);
    expect(bedFinishSettings(cmp, 2).normalization).toBe('raw');
    expect(bedFinishSettings(cmp, 1).normalization).toBe(effectiveSizeSettings(plot).normalization);
    const target = { chrom: 'c', start: 0, end: 1, genome: null, panels: [] } as unknown as Parameters<typeof bedSizesKey>[2];
    expect(bedSizesKey(cmp, [], target, 's', 'k')).not.toBe(bedSizesKey(plot, [], target, 's', 'k'));
    // Raw counts compare as distributions: [[90,90],[10,10]] vs [[10,10],[90,90]] is ±log2(9) per row.
    const [c] = comparisons([{ id: 'a', title: 'A', panelKey: 'a', matrix: [[90, 90], [10, 10]] }, { id: 'b', title: 'B', panelKey: 'b', matrix: [[10, 10], [90, 90]] }], 'a-vs-b');
    expect(c.matrix[0][0]).toBeCloseTo(Math.log2(9), 5);
    expect(c.matrix[1][1]).toBeCloseTo(-Math.log2(9), 5);
  });
});
