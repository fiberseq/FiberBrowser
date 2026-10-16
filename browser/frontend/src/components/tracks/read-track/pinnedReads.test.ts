import { describe, expect, it } from 'vitest';
import { keepPinnedReads } from './useReadTrackData';

const r = (id: string) => ({ id, intervals: [] as [number, number, number][] });

/** fb-r4-clicks: a read gone to by name stays among the reads a panel shows. */
describe('keepPinnedReads', () => {
  const pool = ['a', 'b', 'c', 'd', 'e_2'].map(r);
  it('adds a pinned read the display sample left out, in its place among the others', () => {
    expect(keepPinnedReads([r('a'), r('c')], pool, 'd').map(x => x.id)).toEqual(['a', 'c', 'd']);
    expect(keepPinnedReads([r('a'), r('c')], pool, 'b').map(x => x.id)).toEqual(['a', 'b', 'c']);
  });
  it("a split read's segment counts as its read; nothing pinned, or not in view: the sample as is", () => {
    expect(keepPinnedReads([r('a')], pool, 'e').map(x => x.id)).toEqual(['a', 'e_2']);
    const sample = [r('a')];
    expect(keepPinnedReads(sample, pool, '')).toBe(sample);
    expect(keepPinnedReads(sample, pool, 'zzz')).toBe(sample);
  });
});
