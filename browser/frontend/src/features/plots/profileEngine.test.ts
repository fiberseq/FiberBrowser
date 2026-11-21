/**
 * The profile engine and the metaprofile figure: coverage and signal per bin, overlapping intervals counted once,
 * marks, strand flip, exact pooling, smoothing, the normalisations and the coverage mask, comparisons (A − B and
 * log2 A/B; each vs rest pooled exactly), compact reads as engine reads per source, and the settings model.
 */
import { describe, expect, it } from 'vitest';
import { accumulateProfiles, binsOf, compareProfiles, finishProfile, gaussianSmooth1d, poolProfiles, type ProfileRead } from './profileEngine';
import { engineRead, sourceLayers } from './useProfileData';
import { profileFigure } from './profileFigure';
import { newPlot, normalizeProfileSettings, DEFAULT_PROFILE_SETTINGS } from './plotModel';

const region = { chrom: 'c', start: 100, end: 200 };

describe('accumulate', () => {
  it('coverage and interval signal per bin; overlapping intervals of a read count once', () => {
    const reads: ProfileRead[] = [
      { group: 'a', start: 100, end: 200, intervals: [[100, 130], [120, 140]] },
      { group: 'a', start: 150, end: 200, intervals: [[150, 160]] },
    ];
    const [p] = accumulateProfiles(reads, region, 10);
    expect(binsOf(region, 10)).toBe(10);
    expect(Array.from(p.coverage)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    expect(Array.from(p.signal)).toEqual([1, 1, 1, 1, 0, 1, 0, 0, 0, 0]);
    expect(p.nReads).toBe(2);
  });

  it('partial bins weigh by overlap; marks count per bin; reads outside are left out', () => {
    const [p] = accumulateProfiles([
      { group: 'g', start: 105, end: 115, intervals: [[105, 110]], points: [105, 106, 112, 300] },
      { group: 'g', start: 300, end: 400 },
    ], region, 10);
    expect(p.coverage[0]).toBeCloseTo(0.5);
    expect(p.coverage[1]).toBeCloseTo(0.5);
    expect(p.signal[0]).toBeCloseTo(0.5 + 2);
    expect(p.signal[1]).toBeCloseTo(1);
    expect(p.nReads).toBe(1);
  });

  it('a minus-strand region is flipped; named groups keep their order (and appear when empty)', () => {
    const [a, b] = accumulateProfiles([{ group: 'a', start: 100, end: 110, intervals: [[100, 110]] }], { ...region, strand: '-' }, 10, ['a', 'b']);
    expect(a.signal[9]).toBe(1);
    expect(a.signal[0]).toBe(0);
    expect(b.nReads).toBe(0);
  });

  it('fractional bin widths (a scaled body) finish and keep every bp: [1000, 2001) into 40 bins', () => {
    const r = { chrom: 'c', start: 1000, end: 2001 };
    const [p] = accumulateProfiles([{ group: 'g', start: 1000, end: 2001, intervals: [[1000, 2001]] }], r, 1001 / 40);
    expect(p.coverage.length).toBe(40);
    for (const v of p.coverage) expect(v).toBeCloseTo(1, 9);
    for (const v of p.signal) expect(v).toBeCloseTo(1, 9);
    const [q] = accumulateProfiles([{ group: 'g', start: 1013, end: 1990 }], r, 1001 / 40);
    expect(q.coverage.reduce((a, b) => a + b, 0) * (1001 / 40)).toBeCloseTo(977, 6);
  });

  it('pooling adds raw sums exactly', () => {
    const [a, b] = accumulateProfiles([
      { group: 'a', start: 100, end: 200, intervals: [[100, 150]] },
      { group: 'b', start: 100, end: 200, intervals: [[150, 200]] },
    ], region, 10, ['a', 'b']);
    const pool = poolProfiles([a, b], 'all');
    expect(pool.nReads).toBe(2);
    expect(Array.from(pool.coverage)).toEqual(new Array(10).fill(2));
    expect(Array.from(pool.signal)).toEqual(new Array(10).fill(1));
  });
});

describe('finish', () => {
  const [p] = accumulateProfiles(Array.from({ length: 10 }, (_, i) => ({ group: 'g', start: 100, end: 200, intervals: i < 5 ? [[100, 150]] as Array<[number, number]> : [] })), region, 10);

  it('fraction, counts, relative; bins under the minimum coverage are blank', () => {
    expect(finishProfile(p, { normalization: 'fraction', sigmaBp: 0, minCoverage: 1, binBp: 10 })).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0, 0]);
    expect(finishProfile(p, { normalization: 'count', sigmaBp: 0, minCoverage: 1, binBp: 10 })[0]).toBe(5);
    const rel = finishProfile(p, { normalization: 'relative', sigmaBp: 0, minCoverage: 1, binBp: 10 });
    expect(rel[0]).toBeCloseTo(2);
    expect(rel[9]).toBe(0);
    expect(finishProfile(p, { normalization: 'fraction', sigmaBp: 0, minCoverage: 11, binBp: 10 }).every(v => v === null)).toBe(true);
  });

  it('a Gaussian keeps a flat profile flat and spreads a step', () => {
    expect(Array.from(gaussianSmooth1d([2, 2, 2, 2], 1.5)).every(v => Math.abs(v - 2) < 1e-12)).toBe(true);
    const s = gaussianSmooth1d([0, 0, 0, 1, 1, 1], 1);
    expect(s[2]).toBeGreaterThan(0);
    expect(s[3]).toBeLessThan(1);
  });

  it('compare: A − B and log2 A/B, blank where either is blank', () => {
    expect(compareProfiles([0.5, null, 0.2, 0], [0.25, 0.1, null, 0.1], 'diff')).toEqual([0.25, null, null, -0.1]);
    expect(compareProfiles([0.5, 0], [0.25, 0.1], 'log2ratio')).toEqual([1, null]);
  });
});

describe('mark profiles are per read per bp', () => {
  // One mark per covering read in each 10-bp bin: 0.1 marks per read per bp, whatever the bin.
  const reads = (bin: number): ProfileRead[] => Array.from({ length: 4 }, () => ({ group: 'g', start: 100, end: 200, points: Array.from({ length: 100 / bin }, (_, k) => 100 + k * bin) }));
  it('fraction divides marks by the bin width; counts stay marks per bin', () => {
    for (const bin of [10, 20]) {
      const [p] = accumulateProfiles(reads(bin), region, bin);
      const o = { normalization: 'fraction' as const, sigmaBp: 0, minCoverage: 0, binBp: bin, marksPerBp: true };
      for (const v of finishProfile(p, o)) expect(v).toBeCloseTo(1 / bin, 9);
      for (const v of finishProfile(p, { ...o, normalization: 'count' })) expect(v).toBeCloseTo(4, 9);
    }
  });
  it('the m6A metaprofile figure draws marks per read per bp', () => {
    const [raw] = accumulateProfiles(reads(10), region, 10);
    const fig = profileFigure({ ...newPlot('metaprofile'), source: 'm6a', profile: { ...DEFAULT_PROFILE_SETTINGS, sigmaBp: 0, minCoverage: 0 } }, [{ id: 'g', title: 'G', raw }], 10);
    expect(fig.yLabel).toBe('marks per read per bp');
    for (const v of fig.series[0].values) expect(v).toBeCloseTo(0.1, 9);
  });
});

describe('the metaprofile figure', () => {
  const groups = ['0', '1', '2'].map((c, i) => {
    const [raw] = accumulateProfiles(Array.from({ length: 10 }, (_, k) => ({ group: c, start: 100, end: 200, intervals: k < 2 + 3 * i ? [[100, 200]] as Array<[number, number]> : [] })), region, 10);
    return { id: `p|${c}`, title: `C${c}`, color: '#000', raw };
  });

  it('one line per group, fraction of reads', () => {
    const fig = profileFigure(newPlot({ type: 'metaprofile', profile: { ...DEFAULT_PROFILE_SETTINGS, sigmaBp: 0, minCoverage: 1 } }), groups, 10);
    expect(fig.comparing).toBe(false);
    expect(fig.series.map(s => s.values[0])).toEqual([0.2, 0.5, 0.8]);
    expect(fig.yLabel).toBe('fraction of reads');
  });

  it('A − B each vs rest pools the rest exactly; signed', () => {
    const plot = newPlot({ type: 'metaprofile', groupBy: 'cluster', compare: 'diff', profile: { ...DEFAULT_PROFILE_SETTINGS, sigmaBp: 0, minCoverage: 1 } });
    const fig = profileFigure(plot, groups, 10);
    expect(fig.comparing).toBe(true);
    expect(fig.signed).toBe(true);
    expect(fig.series.map(s => s.label)).toEqual(['C0 vs rest', 'C1 vs rest', 'C2 vs rest']);
    // C0 0.2 vs (C1+C2 pooled: 13 of 20 reads) 0.65.
    expect(fig.series[0].values[0]).toBeCloseTo(0.2 - 0.65);
  });
});

describe('compact reads as engine reads', () => {
  const read = {
    id: 'r', aligned_blocks: [[1010, 1090]], intervals: [[10, 30, 20], [30, 40, -10]],
    layers: { nuc: { intervals: [[10, 30, 20]] }, tf: { intervals: [[50, 60, 10]] }, msp: { intervals: [[30, 40, 10]] } },
    methyl: [15, 55],
  };

  it('each source reads its layers (All footprints: Nuc + TF; Accessibility: msp; marks: m6A or the methyl list)', () => {
    expect(sourceLayers('all_footprints')).toEqual(['nuc', 'tf']);
    expect(engineRead(read, 1000, 'all_footprints', 'g')).toMatchObject({ start: 1010, end: 1090, intervals: [[1010, 1030, 20], [1050, 1060, 10]] });
    expect(engineRead(read, 1000, 'fire', 'g')!.intervals).toEqual([[1030, 1040, 10]]);
    expect(engineRead(read, 1000, 'm6a', 'g')!.points).toEqual([1015, 1055]);
    expect(engineRead({ ...read, layers: {} }, 1000, 'nuc', 'g')!.intervals).toEqual([[1010, 1030, 20]]);
  });

  it('profile settings normalise to defaults and bounds', () => {
    expect(normalizeProfileSettings({ binBp: 0, sigmaBp: -3, normalization: 'x', readCap: 1e9 })).toEqual({ ...DEFAULT_PROFILE_SETTINGS, binBp: 1, sigmaBp: 0, readCap: 20000 });
  });
});
