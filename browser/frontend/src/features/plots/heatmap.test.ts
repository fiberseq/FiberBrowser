/**
 * Heatmaps: read rows (source coverage per bin, blank where the read is absent; marks per bp), sorting and thinning,
 * the figure for reads (blocks per group, magma, Compare explained) and features (rows per feature, sorted by signal,
 * Compare each vs rest pooled exactly, RdBu), and the Gallery packing round trip.
 */
import { describe, expect, it } from 'vitest';
import { accumulateProfiles, readRows, sortReadRows, thinRows } from './profileEngine';
import { featureRaws, heatmapFigure, heatmapRequestKey, type HeatmapEntry } from './heatmapData';
import { packHeatmap, unpackHeatmap } from './HeatmapPlot';
import { DEFAULT_PROFILE_SETTINGS, newPlot } from './plotModel';

const region = { chrom: 'c', start: 0, end: 40 };

describe('read rows', () => {
  it('one row per read: the fraction of each bin the source covers; null where the read is absent', () => {
    const rows = readRows([{ group: 'a', start: 0, end: 30, intervals: [[0, 15]] }, { group: 'a', start: 10, end: 40, points: [12, 13, 35] }], region, 10);
    expect(rows[0].values).toEqual([1, 0.5, 0, null]);
    expect(rows[0].mean).toBeCloseTo(0.5);
    expect(rows[1].values[0]).toBeNull();
    expect(rows[1].values[1]).toBeCloseTo(0.2);
    expect(rows[1].values[3]).toBeCloseTo(0.1);
  });

  it('sorted within group order by signal (high first) or start; thinned evenly keeping order', () => {
    const r = (group: string, start: number, mean: number) => ({ group, start, mean, values: [] });
    const rows = [r('b', 5, 0.9), r('a', 3, 0.1), r('a', 1, 0.7), r('b', 2, 0.2)];
    expect(sortReadRows(rows, 'signal', ['a', 'b']).map(x => `${x.group}${x.mean}`)).toEqual(['a0.7', 'a0.1', 'b0.9', 'b0.2']);
    expect(sortReadRows(rows, 'start', ['a', 'b']).map(x => x.start)).toEqual([1, 3, 2, 5]);
    expect(thinRows([1, 2, 3, 4, 5, 6, 7, 8], 4)).toEqual([1, 3, 5, 7]);
    expect(thinRows([1, 2], 4)).toEqual([1, 2]);
  });
});

const readsEntry = (): HeatmapEntry => ({
  key: 'k', locus: { chrom: 'c', start: 0, end: 40, genome: null }, mode: 'reads', binBp: 10, start: 0,
  groups: [{ id: 'p|all', title: 'D1', color: '#123456' }, { id: 'q|all', title: 'D2' }],
  rows: [
    ...Array.from({ length: 30 }, (_, i) => ({ group: 'p|all', start: i, mean: i / 30, values: [i / 30, null, 0, 0], label: `read ${i}` })),
    ...Array.from({ length: 10 }, (_, i) => ({ group: 'q|all', start: i, mean: 0.5, values: [0.5, 0.5, 0.5, 0.5], label: `r${i}` })),
  ],
});

const featuresEntry = (): HeatmapEntry => {
  const f = (id: string, fracs: number[]) => ({
    feature: { id, label: id, chrom: 'c', start: 0, end: 40, genome: null },
    raws: accumulateProfiles(fracs.flatMap((frac, gi) => Array.from({ length: 10 }, (_, k) => ({ group: `p|${gi}`, start: 0, end: 40, intervals: k < frac * 10 ? [[0, 40]] as Array<[number, number]> : [] }))), region, 10, ['p|0', 'p|1', 'p|2']),
  });
  return {
    key: 'f', locus: { chrom: 'c', start: 0, end: 40, genome: null }, mode: 'features', binBp: 10, start: -20,
    groups: [{ id: 'p|0', title: 'C0' }, { id: 'p|1', title: 'C1' }, { id: 'p|2', title: 'C2' }],
    features: [f('low', [0.2, 0.5, 0.5]), f('high', [0.9, 0.5, 0.3])],
  };
};

describe('the heatmap figure', () => {
  it('reads (retired mode, as stored): blocks per group, rows thinned in proportion to the cap, magma; the note says it is retired', () => {
    const plot = newPlot({ type: 'heatmap', heatmap: { sort: 'signal', maxRows: 20, windowBp: 1000, maxFeatures: 200 } });
    const fig = heatmapFigure(plot, readsEntry());
    expect(fig.blocks.map(b => [b.title, b.rows.length])).toEqual([['D1', 15], ['D2', 5]]);
    expect(fig.blocks[0].rows[0].values[0]).toBeCloseTo(29 / 30);
    expect(fig.colormap).toBe('magma');
    expect(fig.signed).toBe(false);
    expect(fig.note).toMatch(/retired/);
  });

  it('features: a row per feature, sorted by the first group\'s signal; each vs rest pools exactly; RdBu', () => {
    const plot = newPlot({ type: 'heatmap', where: 'features', groupBy: 'cluster', profile: { ...DEFAULT_PROFILE_SETTINGS, sigmaBp: 0, minCoverage: 1 } });
    const fig = heatmapFigure(plot, featuresEntry());
    expect(fig.blocks.map(b => b.title)).toEqual(['C0', 'C1', 'C2']);
    expect(fig.blocks[0].rows.map(r => r.label)).toEqual(['high', 'low']);
    expect(fig.blocks[0].rows[0].values[0]).toBeCloseTo(0.9);
    const cmp = heatmapFigure({ ...plot, compare: 'diff' }, featuresEntry());
    expect(cmp.comparing).toBe(true);
    expect(cmp.colormap).toBe('rdbu_r');
    expect(cmp.blocks.map(b => b.title)).toEqual(['C0 vs rest', 'C1 vs rest', 'C2 vs rest']);
    // high: C0 0.9 vs (C1 + C2 pooled: 8 of 20) 0.4.
    expect(cmp.blocks[0].rows[0].values[0]).toBeCloseTo(0.5);
  });

  it('packs for the Gallery and unpacks to the same figure', () => {
    const plot = newPlot({ type: 'heatmap', where: 'features', groupBy: 'cluster', profile: { ...DEFAULT_PROFILE_SETTINGS, sigmaBp: 0, minCoverage: 1 } });
    const e = featuresEntry();
    const back = unpackHeatmap(packHeatmap(e, 400), 'f', e.locus);
    const a = heatmapFigure(plot, e), b = heatmapFigure(plot, back);
    expect(b.blocks.map(x => x.rows.map(r => r.label))).toEqual(a.blocks.map(x => x.rows.map(r => r.label)));
    expect(b.blocks[0].rows[0].values[0]).toBeCloseTo(a.blocks[0].rows[0].values[0]!, 3);
    const r = readsEntry();
    const rb = unpackHeatmap(packHeatmap(r, 400), 'k', r.locus);
    expect(rb.rows).toHaveLength(40);
    expect(rb.rows![0].values[1]).toBeNull();
  });
});

describe('selected-feature heatmaps use the plot sampling', () => {
  const f = { id: 'c:0-40', label: 'c:1', chrom: 'c', start: 0, end: 40, genome: null };
  const reads = Array.from({ length: 100 }, (_, i) => ({ group: 'p|all', id: `r${i}`, dataset: 'd', start: 0, end: 40 }));
  it('Random N keeps N reads per dataset across the windows (all reads otherwise)', () => {
    const all = featureRaws([{ f, reads }], ['p|all'], 10, { mode: 'all', n: 1, seed: 1 });
    expect(all[0].raws[0].nReads).toBe(100);
    const one = featureRaws([{ f, reads }, { f: { ...f, id: 'c:0-40b' }, reads }], ['p|all'], 10, { mode: 'random', n: 1, seed: 1 });
    expect(one.map(x => x.raws[0].nReads)).toEqual([1, 1]);
  });
  it('the request key follows N and the seed', () => {
    const target = { chrom: 'c', start: 0, end: 40, genome: null, panels: [] } as unknown as Parameters<typeof heatmapRequestKey>[1];
    const plot = (n: number, seed: number) => ({ ...newPlot('heatmap'), where: 'features' as const, sampling: { mode: 'random' as const, n, seed } });
    const k = (n: number, seed: number) => heatmapRequestKey(plot(n, seed), target, null, [f], 's', 'k');
    expect(k(1, 1)).not.toBe(k(2, 1));
    expect(k(1, 1)).not.toBe(k(1, 2));
  });
});
