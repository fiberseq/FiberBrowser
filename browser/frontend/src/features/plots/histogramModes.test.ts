/**
 * The footprint size histogram's weightings and inclusion rules on a hand-computed case, the view histogram's old
 * numbers (its replaced code kept here), pooling across regions, and the header text.
 */
import { describe, expect, it } from 'vitest';
import { histogramAccumulate, histogramMeasures, histogramRaws, histogramAxis } from './sizeHistogram';
import { newPlot, normalizeHistogramSettings, type HistogramSettings } from './plotModel';
import { poolProfiles, type ProfileRead } from './profileEngine';

// Region [100, 200). Footprints of one read (group g): sizes 20, 50, 30, 120.
//   A [90, 110)  size 20, midpoint 100 (inside), overlaps 10 bp inside
//   B [170, 220) size 50, midpoint 195 (inside), 30 bp inside
//   C [195, 225) size 30, midpoint 210 (outside), overlaps 5 bp inside
//   D [40, 160)  size 120, midpoint 100 (inside), 60 bp inside
const reads: ProfileRead[] = [{ group: 'g', start: 0, end: 300, intervals: [[90, 110], [170, 220], [195, 225], [40, 160]] }];
const h = (patch: Partial<HistogramSettings>): HistogramSettings => normalizeHistogramSettings({ binBp: 10, sizeMin: 0, sizeMax: 200, normalization: 'count', ...patch });
const bins = (p: Float64Array) => Object.fromEntries([...p].map((v, i) => [i * 10, v]).filter(([, v]) => v !== 0));
const region = { start: 100, end: 200 };

describe('weightings × inclusions (hand-computed)', () => {
  it('midpoint, count: A, B, D once each', () => {
    expect(bins(histogramAccumulate(reads, region, h({}), ['g'])[0].signal)).toEqual({ 20: 1, 50: 1, 120: 1 });
  });
  it('midpoint, bp: each its whole length', () => {
    expect(bins(histogramAccumulate(reads, region, h({ weighting: 'bp' }), ['g'])[0].signal)).toEqual({ 20: 20, 50: 50, 120: 120 });
  });
  it('overlap, count: A, B, C, D', () => {
    expect(bins(histogramAccumulate(reads, region, h({ inclusion: 'overlap' }), ['g'])[0].signal)).toEqual({ 20: 1, 30: 1, 50: 1, 120: 1 });
  });
  it('overlap, bp: whole lengths', () => {
    expect(bins(histogramAccumulate(reads, region, h({ inclusion: 'overlap', weighting: 'bp' }), ['g'])[0].signal)).toEqual({ 20: 20, 30: 30, 50: 50, 120: 120 });
  });
  it('clipped, count: as overlap', () => {
    expect(bins(histogramAccumulate(reads, region, h({ inclusion: 'clipped' }), ['g'])[0].signal)).toEqual({ 20: 1, 30: 1, 50: 1, 120: 1 });
  });
  it('clipped, bp: only the bp inside, at the footprint\'s whole size', () => {
    expect(bins(histogramAccumulate(reads, region, h({ inclusion: 'clipped', weighting: 'bp' }), ['g'])[0].signal)).toEqual({ 20: 10, 30: 5, 50: 30, 120: 60 });
  });
  it('fraction: over the group\'s total weight (bp: the share of footprint-covered bp); per read: over the reads', () => {
    const f = histogramAccumulate(reads, region, h({ inclusion: 'clipped', weighting: 'bp', normalization: 'density' }), ['g'])[0];
    expect(f.coverage[0]).toBe(105);
    const pr = histogramAccumulate(reads, region, h({ normalization: 'per-read' }), ['g'])[0];
    expect(pr.coverage[0]).toBe(1);
  });
  it('pooling regions keeps exact sums (numerator and denominator)', () => {
    const s = h({ normalization: 'density' });
    const a = histogramAccumulate(reads, region, s, ['g'])[0], b = histogramAccumulate(reads, { start: 0, end: 100 }, s, ['g'])[0];
    const p = poolProfiles([a, b], 'g');
    expect(p.coverage[0]).toBe(a.coverage[0] + b.coverage[0]);
    expect(bins(p.signal)).toEqual({ 20: 1, 50: 1, 120: 1, ...{ 120: 1 + (bins(b.signal)[120] ?? 0) } });
  });
});

// The view histogram before this change (midpoint, count), kept as the reference.
function oldHistogramRaws(rs: ProfileRead[], groups: Array<{ id: string }>, view: { start: number; end: number }, hh: HistogramSettings) {
  const n = Math.max(1, Math.ceil((hh.sizeMax - hh.sizeMin) / hh.binBp));
  const by = new Map(groups.map(g => [g.id, { group: g.id, nReads: 0, coverage: new Float64Array(n), signal: new Float64Array(n), footprints: 0 }]));
  for (const r of rs) {
    const p = by.get(r.group);
    if (!p) continue;
    let any = false;
    for (const [a, b] of r.intervals ?? []) {
      const mid = (a + b) / 2;
      if (mid < view.start || mid >= view.end) continue;
      any = true;
      const size = b - a;
      if (size < hh.sizeMin || size >= hh.sizeMax) continue;
      p.signal[Math.min(n - 1, Math.floor((size - hh.sizeMin) / hh.binBp))] += 1;
      p.footprints += 1;
    }
    if (any || (r.start < view.end && r.end > view.start)) p.nReads += 1;
  }
  return [...by.values()].map(p => { const d = hh.normalization === 'density' ? p.footprints : hh.normalization === 'per-read' ? p.nReads : 1; p.coverage.fill(d); return { group: p.group, nReads: p.nReads, coverage: p.coverage, signal: p.signal }; });
}

describe('the view histogram is unchanged under midpoint × count', () => {
  it('matches the replaced code on random reads', () => {
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const rs: ProfileRead[] = Array.from({ length: 300 }, (_, i) => {
      const st = Math.floor(rnd() * 5000);
      return { group: i % 2 ? 'a' : 'b', start: st, end: st + 3000, intervals: Array.from({ length: 12 }, () => { const a = st + Math.floor(rnd() * 3000); return [a, a + 1 + Math.floor(rnd() * 350)] as [number, number]; }) };
    });
    for (const norm of ['density', 'count', 'per-read'] as const) {
      const plot = newPlot({ type: 'size-histogram', hist: normalizeHistogramSettings({ binBp: 5, sizeMin: 10, sizeMax: 300, normalization: norm }) });
      const now = histogramRaws(rs, [{ id: 'a' }, { id: 'b' }], { start: 1000, end: 6000 }, plot);
      const was = oldHistogramRaws(rs, [{ id: 'a' }, { id: 'b' }], { start: 1000, end: 6000 }, plot.hist);
      expect(now.map(p => [p.nReads, [...p.coverage], [...p.signal]])).toEqual(was.map(p => [p.nReads, [...p.coverage], [...p.signal]]));
    }
  });
});

describe('header and axis', () => {
  it('says what it measures', () => {
    expect(histogramMeasures(newPlot({ type: 'size-histogram' }), '1,000 regions')).toBe('All footprints, midpoint in 1,000 regions, count, fraction; 0–400 bp in 5 bp bins; all reads in scope, seed 1');
  });
  it('log x and guides', () => {
    const a = histogramAxis(normalizeHistogramSettings({ binBp: 10, sizeMin: 0, sizeMax: 100, logX: true, guidesOn: true, guides: [90] }));
    expect(a.xs![0]).toBeCloseTo(Math.log10(5));
    expect(a.guides).toEqual([Math.log10(90)]);
    expect(histogramAxis(normalizeHistogramSettings({})).guides).toBeUndefined();
  });
});
