import { describe, expect, it } from 'vitest';
import {
  MAX_READABLE_PATTERNS, MAX_REMEMBERED_SELECTIONS, clusterSelectionLocus, defaultClusterSelection, findClusterSelection,
  footprintInView, membershipPatternCount, rememberClusterSelection, resolveClusterSelection,
} from './footprintClusterSelection';

describe('which saved footprints to cluster by', () => {
  it('defaults to all of up to three, else the first three', () => {
    expect(defaultClusterSelection([])).toEqual([]);
    expect(defaultClusterSelection(['a', 'b'])).toEqual(['a', 'b']);
    expect(defaultClusterSelection(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(defaultClusterSelection(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c']);
  });

  it('counts the patterns n footprints can make, and warns above 8', () => {
    expect([1, 2, 3, 4].map(membershipPatternCount)).toEqual([2, 4, 8, 16]);
    expect(membershipPatternCount(3) > MAX_READABLE_PATTERNS).toBe(false);
    expect(membershipPatternCount(4) > MAX_READABLE_PATTERNS).toBe(true);
  });

  it('keeps a remembered choice to the footprints in view, in their order', () => {
    expect(resolveClusterSelection(['a', 'b', 'c', 'd'], ['d', 'b'])).toEqual(['b', 'd']);
    // Footprints saved since are not added on their own.
    expect(resolveClusterSelection(['a', 'b', 'c', 'd', 'e'], ['a', 'b'])).toEqual(['a', 'b']);
    // Unticking everything is a choice too.
    expect(resolveClusterSelection(['a', 'b'], [])).toEqual([]);
    // None of the remembered ones in view any more: the default.
    expect(resolveClusterSelection(['x', 'y', 'z', 'w'], ['a'])).toEqual(['x', 'y', 'z']);
    expect(resolveClusterSelection(['x', 'y'], null)).toEqual(['x', 'y']);
  });

  it('prefers the footprints in view for the default', () => {
    // Three saved at another locus on this chromosome, two here.
    expect(resolveClusterSelection(['far1', 'far2', 'far3', 'here1', 'here2'], null, ['here1', 'here2'])).toEqual(['here1', 'here2']);
    expect(resolveClusterSelection(['a', 'b'], null, [])).toEqual(['a', 'b']);
  });

  it('remembers one choice per locus: the footprints placed in view, else the view', () => {
    const g = (id: string, s: number | null, e: number | null) => ({ id, referenceAbsStart: s, referenceAbsEnd: e }) as never;
    const view = { chrom: 'chr19', start: 50, end: 400 };
    // A footprint saved far away on the chromosome does not stretch the locus.
    expect(clusterSelectionLocus([g('a', 120, 140), g('b', 100, 110), g('c', 300, 320), g('far', 90_000, 90_050)], view))
      .toEqual({ chrom: 'chr19', start: 100, end: 320 });
    // Only unplaced ("Match anywhere") footprints, or none: the view itself, so a choice can still be remembered.
    expect(clusterSelectionLocus([g('m', null, null)], view)).toEqual(view);
    expect(footprintInView(g('m', null, null), view)).toBe(true);
    expect(footprintInView(g('far', 90_000, 90_050), view)).toBe(false);
    const locus = { chrom: 'chr19', start: 100, end: 320 };

    let remembered = rememberClusterSelection([], { ...locus, groupIds: ['a', 'b'] });
    remembered = rememberClusterSelection(remembered, { chrom: 'chr2', start: 100, end: 320, groupIds: ['q'] });
    // Same place (a footprint saved since widened the span): found, and replaced on the next choice.
    expect(findClusterSelection(remembered, { chrom: '19', start: 90, end: 400 })?.groupIds).toEqual(['a', 'b']);
    remembered = rememberClusterSelection(remembered, { chrom: 'chr19', start: 90, end: 400, groupIds: ['c'] });
    expect(remembered.filter(e => e.chrom === 'chr19')).toHaveLength(1);
    expect(findClusterSelection(remembered, locus)?.groupIds).toEqual(['c']);
    // Elsewhere: nothing remembered.
    expect(findClusterSelection(remembered, { chrom: 'chr19', start: 5000, end: 5100 })).toBeNull();
    expect(findClusterSelection(remembered, { chrom: 'chr2', start: 0, end: 200 })?.groupIds).toEqual(['q']);
  });

  it('keeps the newest choices only', () => {
    let remembered: ReturnType<typeof rememberClusterSelection> = [];
    for (let i = 0; i < MAX_REMEMBERED_SELECTIONS + 5; i++) {
      remembered = rememberClusterSelection(remembered, { chrom: 'chr1', start: i * 1000, end: i * 1000 + 10, groupIds: [`g${i}`] });
    }
    expect(remembered).toHaveLength(MAX_REMEMBERED_SELECTIONS);
    expect(remembered[remembered.length - 1].groupIds).toEqual([`g${MAX_REMEMBERED_SELECTIONS + 4}`]);
  });
});
