/**
 * BED region sets: strand-aware anchors and windows, seeded subsampling (random N, equal N per set, the cap), the
 * occlusion filter per read (centre, fraction of centre ± N) and per region, depth matching, scale-regions, pooling
 * per set × dataset with the excluded group, and the counts.
 */
import { describe, expect, it } from 'vitest';
import {
  accumulateScaled, anchorOf, bedCountsText, bedProfiles, DEFAULT_BED_SETTINGS, depthMatch, normalizeBedSettings, readOccluded, readWindow,
  regionOcclusionPct, regionIdentity, subsampleSets, type BedRegion, type RegionSet,
} from './bedRegions';

const S = (patch = {}) => ({ ...DEFAULT_BED_SETTINGS, ...patch });
const set = (id: string, n: number, strand: '+' | '-' = '+'): RegionSet => ({
  id, name: id, path: `/x/${id}.bed`, color: '#000', total: n,
  regions: Array.from({ length: n }, (_, i) => ['chrT', 1000 + i * 100, 1050 + i * 100, strand, `${id}${i}`] as BedRegion),
});

describe('anchors and windows', () => {
  it('start is the 5′ end (TSS) and end the 3′ end, by strand; centre the middle', () => {
    expect(anchorOf(['c', 100, 200, '+', ''], 'start')).toBe(100);
    expect(anchorOf(['c', 100, 200, '-', ''], 'start')).toBe(200);
    expect(anchorOf(['c', 100, 200, '-', ''], 'end')).toBe(100);
    expect(anchorOf(['c', 100, 200, '.', ''], 'centre')).toBe(150);
    expect(readWindow(['c', 1000, 1200, '-', ''], S({ anchor: 'start', flankBp: 500 }))).toEqual({ chrom: 'c', start: 700, end: 1700, centre: 1200, strand: '-' });
    expect(readWindow(['c', 1000, 1200, '+', ''], S({ mode: 'scale', scaleFlankBp: 300 }))).toMatchObject({ start: 700, end: 1500 });
  });
});

describe('subsampling', () => {
  it('seeded by the stable rule: the same seed the same regions whatever their order, another seed others; order kept', () => {
    const sets = [set('a', 50)];
    const ids = (seed: number, ss = sets) => [...subsampleSets(ss, S({ subsample: 'random', n: 10 }), seed).get('a')!].map(regionIdentity);
    const a = ids(7);
    expect(ids(7)).toEqual(a);
    expect(ids(8)).not.toEqual(a);
    expect(new Set(ids(7, [{ ...sets[0], regions: [...sets[0].regions].reverse() }]))).toEqual(new Set(a));
  });

  it('random N per set, equal N per set down to the smallest, all up to the cap', () => {
    const sets = [set('a', 30), set('b', 12)];
    expect([...subsampleSets(sets, S({ subsample: 'random', n: 10 })).values()].map(v => v.length)).toEqual([10, 10]);
    expect([...subsampleSets(sets, S({ subsample: 'equal' })).values()].map(v => v.length)).toEqual([12, 12]);
    expect([...subsampleSets(sets, S({ subsample: 'all', maxRegions: 20 })).values()].map(v => v.length)).toEqual([20, 12]);
  });

  it('depth matching downsamples every dataset to the fewest reads', () => {
    const r = (id: string) => ({ id });
    const d1 = ['a', 'b', 'c', 'd', 'e'].map(r);
    const m = depthMatch(new Map([['d1', d1], ['d2', [r('x'), r('y')]]]), 1);
    expect(m.get('d1')).toHaveLength(2);
    expect(m.get('d2')!.map(x => x.id)).toEqual(['x', 'y']);
    // The same reads whatever their order (stable keys by name); another seed may pick others.
    const again = depthMatch(new Map([['d1', [...d1].reverse()], ['d2', [r('x'), r('y')]]]), 1);
    expect(new Set(again.get('d1')!.map(x => x.id))).toEqual(new Set(m.get('d1')!.map(x => x.id)));
  });
});

describe('occlusion', () => {
  const r = (occ: Array<[number, number]>, start = 0, end = 400) => ({ group: 'g', start, end, occluders: occ });
  it('per read: a nucleosome over the centre, or more than X% of centre ± N covered; reads not over the centre are kept', () => {
    expect(readOccluded(r([[180, 330]]), 200, S({ occlusionRead: 'centre' }))).toBe(true);
    expect(readOccluded(r([[210, 330]]), 200, S({ occlusionRead: 'centre' }))).toBe(false);
    // centre ± 50 = [150, 250): 40 bp of 100 covered.
    expect(readOccluded(r([[210, 330]]), 200, S({ occlusionRead: 'fraction', readPct: 30, readWindowBp: 50 }))).toBe(true);
    expect(readOccluded(r([[210, 330]]), 200, S({ occlusionRead: 'fraction', readPct: 50, readWindowBp: 50 }))).toBe(false);
    expect(readOccluded(r([[0, 400]], 300, 400), 200, S({ occlusionRead: 'centre' }))).toBe(false);
    expect(readOccluded(r([[180, 330]]), 200, S({ occlusionRead: 'off' }))).toBe(false);
  });

  it('per region: the share of reads over the centre with a nucleosome there', () => {
    expect(regionOcclusionPct([r([[180, 330]]), r([]), r([]), r([[0, 10]])], 200)).toBe(25);
    expect(regionOcclusionPct([r([], 300, 400)], 200)).toBeNull();
  });
});

describe('bedProfiles', () => {
  const sets = [set('prom', 2), set('enh', 1, '-')];
  const reads = (n: number, occluded: number) => [
    ...Array.from({ length: n - occluded }, () => ({ group: '', start: 0, end: 5000, intervals: [[0, 5000]] as Array<[number, number]>, occluders: [] as Array<[number, number]> })),
    ...Array.from({ length: occluded }, () => ({ group: '', start: 0, end: 5000, intervals: [] as Array<[number, number]>, occluders: [[0, 5000]] as Array<[number, number]> })),
  ];
  const input = [
    { set: 'prom', region: sets[0].regions[0], byDataset: new Map([['d1', reads(10, 2)], ['d2', reads(4, 0)]]) },
    { set: 'prom', region: sets[0].regions[1], byDataset: new Map([['d1', reads(10, 9)], ['d2', reads(4, 4)]]) },
    { set: 'enh', region: sets[1].regions[0], byDataset: new Map([['d1', reads(6, 0)], ['d2', reads(6, 0)]]) },
  ];

  it('groups per set × dataset, pooled across regions; occluded reads dropped and shown as their own group; counts', () => {
    const res = bedProfiles(input, sets, S({ flankBp: 100, occlusionRead: 'centre', showExcluded: true }), 50, { d1: 'D1', d2: 'D2' }, false);
    expect(res.pooled.map(g => g.title)).toEqual(['prom · D1', 'prom · D2', 'prom · excluded (occluded)', 'enh · D1', 'enh · D2', 'enh · excluded (occluded)']);
    expect(res.pooled[0].raw.nReads).toBe(8 + 1);
    expect(res.pooled[2].raw.nReads).toBe(2 + 9 + 4);
    expect(res.counts[0]).toMatchObject({ regionsTotal: 2, regionsRead: 2, regionsUsed: 2, readsUsed: 13, readsExcluded: 15 });
    expect(bedCountsText(res.counts, sets)).toContain('prom: 2 of 2 regions · 13 reads · 15 reads excluded by occlusion');
    expect(res.perRegion).toHaveLength(3);
  });

  it('the region filter drops regions whose centre is occluded in more than X% of reads; datasets pooled', () => {
    const res = bedProfiles(input, sets, S({ flankBp: 100, occlusionRegion: true, regionPct: 50 }), 50, {}, true);
    expect(res.counts[0]).toMatchObject({ regionsUsed: 1, regionsDroppedOcclusion: 1 });
    expect(res.pooled.map(g => g.title)).toEqual(['prom', 'enh']);
    expect(res.pooled[0].raw.nReads).toBe(14);
    expect(bedCountsText(res.counts, sets)).toContain('(1 dropped by the region filter)');
  });

  it('scale-regions: flanks and the body stretched to its bins, the same length for every region', () => {
    const res = bedProfiles(input, sets, S({ mode: 'scale', bodyBins: 10, scaleFlankBp: 100 }), 50, {}, true);
    expect(res.perRegion.every(p => p.raws.every(r => r.coverage.length === 2 + 10 + 2))).toBe(true);
  });

  it('settings normalise to defaults', () => {
    expect(normalizeBedSettings({ anchor: 'x', n: -4, setIds: ['a', 3] })).toMatchObject({ anchor: 'centre', n: 1, setIds: ['a'] });
  });
});

import { regionReadsFromServer } from './bedData';

describe('the server\'s region reads', () => {
  it('become per-region reads per dataset: source intervals, marks and nucleosomes as pairs', () => {
    const sets = [set('a', 3)];
    const out = regionReadsFromServer(sets, [{ set: 'a', index: 2, reads: { d1: [[1000, 1100, [1000, 1020, 1050, 1060], [], [1000, 1020]]] } }, { set: 'zz', index: 0, reads: {} }]);
    expect(out).toHaveLength(1);
    expect(out[0].region).toEqual(sets[0].regions[2]);
    expect(out[0].byDataset.get('d1')).toEqual([{ group: '', start: 1000, end: 1100, intervals: [[1000, 1020], [1050, 1060]], occluders: [[1000, 1020]] }]);
  });
});

describe('relative coordinates from the server', () => {
  it('adds the window offset back', () => {
    const out = regionReadsFromServer([set('a', 1)], [{ set: 'a', index: 0, offset: 1000, reads: { d1: [[0, 100, [0, 20], [5], [0, 20]]] } }]);
    expect(out[0].byDataset.get('d1')).toEqual([{ group: '', start: 1000, end: 1100, intervals: [[1000, 1020]], points: [1005], occluders: [[1000, 1020]] }]);
  });
  it('reads shared nucleosomes as the first k source numbers', () => {
    const out = regionReadsFromServer([set('a', 1)], [{ set: 'a', index: 0, offset: 10, reads: { d1: [[0, 100, [0, 20, 40, 50], [], 2]] } }]);
    expect(out[0].byDataset.get('d1')![0].occluders).toEqual([[10, 30]]);
  });
});

describe('scale-regions marks', () => {
  it('a mark every 5 bp finishes to 0.2 per read per bp in the flanks and a stretched body alike', async () => {
    const { finishProfile } = await import('./profileEngine');
    // Region [1000, 1300) with 40 body bins (7.5 bp each), 100 bp flanks in 10 bp bins.
    const r: BedRegion = ['chrT', 1000, 1300, '+', 'r'];
    const read = { group: 'g', start: 900, end: 1400, points: Array.from({ length: 100 }, (_, k) => 900 + k * 5) };
    const [p] = accumulateScaled([read], r, S({ mode: 'scale', scaleFlankBp: 100, bodyBins: 40 }), 10, ['g']);
    const v = finishProfile(p, { normalization: 'fraction', sigmaBp: 0, minCoverage: 0, binBp: 10, marksPerBp: true });
    expect(v.length).toBe(60);
    // Body bins of 7.5 bp hold one or two marks; their mean is still 0.2 per bp.
    const body = v.slice(10, 50) as number[];
    expect(body.reduce((a, b) => a + b, 0) / body.length).toBeCloseTo(0.2, 6);
    for (const x of [...v.slice(0, 10), ...v.slice(50)]) expect(x).toBeCloseTo(0.2, 9);
  });
});

describe('scale-regions mark counts', () => {
  it('Count keeps the raw marks: 40 marks over a 1,000 bp body in 40 bins are 1 per bin, 40 in all', async () => {
    const { finishProfile } = await import('./profileEngine');
    const r: BedRegion = ['chrT', 1000, 2000, '+', 'r'];
    const read = { group: '', start: 900, end: 2100, points: Array.from({ length: 40 }, (_, k) => 1000 + k * 25 + 12) };
    const one: RegionSet = { id: 's', name: 's', path: '/x/s.bed', color: '#000', total: 1, regions: [r] };
    const input = [{ set: 's', region: r, byDataset: new Map([['d1', [read]]]) }];
    const res = bedProfiles(input, [one], S({ mode: 'scale', scaleFlankBp: 0, bodyBins: 40 }), 10, {}, true, undefined, { rawMarkCounts: true });
    const v = finishProfile(res.pooled[0].raw, { normalization: 'count', sigmaBp: 0, minCoverage: 0, binBp: 10, marksPerBp: true }) as number[];
    expect(v).toHaveLength(40);
    expect(v.every(x => x === 1)).toBe(true);
    expect(v.reduce((a, b) => a + b, 0)).toBe(40);
    // The fraction (marks per read per bp) is the density either way: 40 / 1,000.
    const dens = bedProfiles(input, [one], S({ mode: 'scale', scaleFlankBp: 0, bodyBins: 40 }), 10, {}, true);
    const f = finishProfile(dens.pooled[0].raw, { normalization: 'fraction', sigmaBp: 0, minCoverage: 0, binBp: 10, marksPerBp: true }) as number[];
    for (const x of f) expect(x).toBeCloseTo(0.04, 9);
  });
});

describe('regions near the contig start', () => {
  // A region at 30 (window [-70, 130) logically; the server clamps only its fetch) pooled with one far from 0.
  const near: BedRegion = ['chrT', 20, 40, '+', 'n'];
  const far: BedRegion = ['chrT', 1000, 1020, '+', 'f'];
  const set1: RegionSet = { id: 's', name: 's', path: '/x/s.bed', color: '#000', total: 2, regions: [near, far] };
  const reads = [{ group: '', start: 0, end: 5000, intervals: [[0, 5000]] as Array<[number, number]> }];
  const input = [near, far].map(region => ({ set: 's', region, byDataset: new Map([['d1', reads]]) }));
  for (const mode of ['point', 'scale'] as const) {
    it(`${mode}: every region gets the same bins and the pool stays finite`, () => {
      const res = bedProfiles(input, [set1], S({ mode, flankBp: 100, scaleFlankBp: 100, bodyBins: 4 }), 10, {}, true);
      const lens = res.perRegion.map(p => p.raws[0].coverage.length);
      expect(new Set(lens).size).toBe(1);
      expect(Array.from(res.pooled[0].raw.coverage).every(Number.isFinite)).toBe(true);
      expect(res.pooled[0].raw.coverage.length).toBe(lens[0]);
    });
  }
  it('the window keeps anchor ± flank (no clamp at 0)', () => {
    expect(readWindow(near, S({ flankBp: 100 }))).toMatchObject({ start: -70, end: 130 });
  });
});
