/** Size-band sources and conditioning on the state at the anchor, hand-computed; the metaprofile of a band equals the
 *  engine on the band's footprints only. */
import { describe, expect, it } from 'vitest';
import { anchorState, applyBandsAndCondition, bandOf, bandsText } from './sizeBands';
import { normalizeProfileSettings, bandLabel } from './plotModel';
import { accumulateProfiles, type ProfileRead } from './profileEngine';

const P = (patch = {}) => normalizeProfileSettings({ ...patch });

describe('size bands', () => {
  it('bands from the edges: < 90, 90–200, ≥ 200', () => {
    expect([10, 89, 90, 199, 200, 500].map(s => bandOf(s, [90, 200]))).toEqual([0, 0, 1, 1, 2, 2]);
    expect([0, 1, 2].map(i => bandLabel([90, 200], i))).toEqual(['< 90 bp', '90–200 bp', '≥ 200 bp']);
  });
  const reads: ProfileRead[] = [{ group: 'g', id: 'r', start: 0, end: 1000, intervals: [[100, 140], [300, 450], [600, 900]] }];  // 40, 150, 300 bp
  it('one band keeps only its footprints (the engine then counts them alone)', () => {
    const t = applyBandsAndCondition(reads, [{ id: 'g', title: 'G' }], P({ band: 1 }), () => null);
    expect(t.reads[0].intervals).toEqual([[300, 450]]);
    expect(t.groups).toEqual([{ id: 'g', title: 'G' }]);
    const a = accumulateProfiles(t.reads, { chrom: 'c', start: 0, end: 1000 }, 100, ['g'])[0];
    const b = accumulateProfiles([{ ...reads[0], intervals: [[300, 450]] }], { chrom: 'c', start: 0, end: 1000 }, 100, ['g'])[0];
    expect([...a.signal]).toEqual([...b.signal]);
  });
  it('one line per band: a group per band, each with its footprints', () => {
    const t = applyBandsAndCondition(reads, [{ id: 'g', title: 'G', color: '#f00' }], P({ band: 'each' }), () => null);
    expect(t.groups.map(g => g.title)).toEqual(['G · < 90 bp', 'G · 90–200 bp', 'G · ≥ 200 bp']);
    expect(t.reads.map(r => [r.group, r.intervals])).toEqual([['g|b0', [[100, 140]]], ['g|b1', [[300, 450]]], ['g|b2', [[600, 900]]]]);
  });
});

describe('state at the anchor', () => {
  const r = (fps: Array<[number, number]>): ProfileRead & { footprints: Array<[number, number]> } => ({ group: 'g', id: 'x', start: 0, end: 2000, intervals: fps, footprints: fps });
  it('nucleosome-sized wins, then TF-sized, else open (centre ± w)', () => {
    expect(anchorState(r([[950, 1100]]), 1000, 10, 90)).toBe('nucleosome');
    expect(anchorState(r([[995, 1020]]), 1000, 10, 90)).toBe('tf');
    expect(anchorState(r([[1005, 1030], [900, 995]]), 1000, 10, 90)).toBe('nucleosome');
    expect(anchorState(r([[1020, 1200]]), 1000, 10, 90)).toBe('open');
    expect(anchorState(r([[1009, 1200]]), 1000, 10, 90)).toBe('nucleosome');
  });
  it('splits each group into open / TF / nucleosome (dashes), the reads into their state', () => {
    const reads = [r([[950, 1100]]), { ...r([[995, 1020]]), id: 'y' }, { ...r([]), id: 'z' }];
    const t = applyBandsAndCondition(reads, [{ id: 'g', title: 'G' }], P({ conditionOn: true }), () => 1000);
    expect(t.groups.map(g => g.id)).toEqual(['g|s:open', 'g|s:tf', 'g|s:nucleosome']);
    expect(t.reads.map(x => x.group)).toEqual(['g|s:nucleosome', 'g|s:tf', 'g|s:open']);
    expect(bandsText(P({ conditionOn: true, band: 0 }))).toBe('footprints < 90 bp; reads grouped by their state at the anchor ± 10 bp (nucleosome ≥ 90 bp, TF-sized, open)');
  });
});
