/**
 * The region heatmap on a hand-computed case: rows sorted by the mean in a window, by the centre bin, by BED order and
 * by a BED column; k-means of the rows (two obvious clusters, numbered by mean) identical for the same seed whatever
 * the row order; the metaprofile on top pooled exactly; clusters as BED sets; Compare as per-region A − B with the
 * profile showing the groups; an old reads × position card opens as stored with the retired note.
 */
import { describe, expect, it } from 'vitest';
import { binsIn, centreBin, kmeansRows, regionHeatmapHeader, rowMean, sortRows, type RegionRow } from './regionHeatmap';
import { heatmapFigure, type HeatmapEntry } from './heatmapData';
import { clusterRegionSets } from './RegionHeatmapActions';
import { unpackHeatmap, packHeatmap } from './HeatmapPlot';
import { newPlot, normalizePlot, withType } from './plotModel';

const row = (id: string, vals: number[], bedIndex: number, score: number | null = null): RegionRow => ({ id, label: id, bedIndex, score, values: [vals] });
// Axis: 4 bins of 10 bp from -20 (bins start at -20, -10, 0, 10; the centre bin holds 0: index 2).
const axis = { n: 4, start: -20, binBp: 10 };
const R = [row('a', [1, 1, 1, 1], 0, 5), row('b', [0, 0, 4, 0], 1, 9), row('c', [3, 3, 0, 0], 2, 1)];

describe('sorting (hand-computed)', () => {
  it('the bins of a window and the centre bin', () => {
    expect(binsIn(4, -20, 10, null, null)).toEqual([0, 1, 2, 3]);
    expect(binsIn(4, -20, 10, -10, 10)).toEqual([1, 2]);
    expect(centreBin(4, -20, 10)).toBe(2);
    expect(centreBin(5, 0, 10)).toBe(0);
    // Scaled regions: the middle of the body.
    expect(centreBin(5, -20, 10, true)).toBe(2);
  });
  it('mean over the whole window: c (1.5) > a (1) = b (1), ties by BED order', () => {
    expect(R.map(r => rowMean(r, [0, 1, 2, 3]))).toEqual([1, 1, 1.5]);
    expect(sortRows(R, { sort: 'mean', sortFrom: null, sortTo: null }, axis)).toEqual([2, 0, 1]);
  });
  it('mean over [-10, 10): b (2) > c (1.5) > a (1)', () => {
    expect(sortRows(R, { sort: 'mean', sortFrom: -10, sortTo: 10 }, axis)).toEqual([1, 2, 0]);
  });
  it('centre: b (4) > a (1) > c (0); BED order; BED column (score) high first', () => {
    expect(sortRows(R, { sort: 'centre', sortFrom: null, sortTo: null }, axis)).toEqual([1, 0, 2]);
    expect(sortRows([R[2], R[0], R[1]], { sort: 'bed', sortFrom: null, sortTo: null }, axis)).toEqual([1, 2, 0]);
    expect(sortRows(R, { sort: 'score', sortFrom: null, sortTo: null }, axis)).toEqual([1, 0, 2]);
  });
});

describe('k-means of the rows', () => {
  const rows = [row('r1', [9, 9, 9, 9], 0), row('r2', [0, 0, 1, 0], 1), row('r3', [8, 9, 9, 8], 2), row('r4', [0, 1, 0, 0], 3), row('r5', [9, 8, 8, 9], 4)];
  it('finds the two obvious clusters, numbered by mean (high first)', () => {
    expect(kmeansRows(rows, 2, 1)).toEqual([0, 1, 0, 1, 0]);
  });
  it('is the same for the same seed whatever the order of the rows, and stable across seeds here', () => {
    const shuffled = [rows[3], rows[0], rows[4], rows[1], rows[2]];
    const a = kmeansRows(rows, 2, 7);
    const b = kmeansRows(shuffled, 2, 7);
    const byId = (rs: RegionRow[], cs: number[]) => Object.fromEntries(rs.map((r, i) => [r.id, cs[i]]));
    expect(byId(shuffled, b)).toEqual(byId(rows, a));
    expect(kmeansRows(rows, 2, 7)).toEqual(a);
    expect(kmeansRows(rows, 2, 99)).toEqual(kmeansRows(rows, 2, 1));
  });
  it('k larger than the rows: one cluster per row at most', () => {
    expect(new Set(kmeansRows(rows.slice(0, 2), 5, 1)).size).toBe(2);
  });
});

// A features entry: 2 regions, 1 group, 2 bins; coverage 10 everywhere, signal planted.
const raw = (sig: number[]) => ({ group: 'g', nReads: 10, coverage: Float64Array.from([10, 10]), signal: Float64Array.from(sig) });
const entry = (groups = 1): HeatmapEntry => ({
  key: 'k', locus: { chrom: 'chrT', start: 0, end: 100, genome: null }, mode: 'features', binBp: 10, start: -10,
  groups: Array.from({ length: groups }, (_, i) => ({ id: `p|d${i}`, title: `D${i}` })),
  features: [
    { feature: { id: 'f1', label: 'f1', chrom: 'chrT', start: 0, end: 20, genome: null, bedIndex: 0, region: [5, 15], strand: '+' }, raws: Array.from({ length: groups }, (_, i) => raw(i ? [5, 5] : [2, 4])) },
    { feature: { id: 'f2', label: 'f2', chrom: 'chrT', start: 50, end: 70, genome: null, bedIndex: 1, region: [55, 65], strand: '-' }, raws: Array.from({ length: groups }, (_, i) => raw(i ? [1, 1] : [8, 6])) },
  ],
});
const plot = { ...newPlot({ type: 'heatmap' }), profile: { ...newPlot().profile, sigmaBp: 0, minCoverage: 1, normalization: 'mean' as const } };

describe('the figure', () => {
  it('rows by mean (f2 0.7 > f1 0.3); the profile on top pools the regions exactly ((2+8)/20, (4+6)/20)', () => {
    const f = heatmapFigure(plot, entry());
    expect(f.blocks[0].rows.map(r => r.label)).toEqual(['f2', 'f1']);
    expect(f.blocks[0].rows[0].values).toEqual([0.8, 0.6]);
    expect(f.profile!.lines).toHaveLength(1);
    expect(f.profile!.lines[0].values).toEqual([0.5, 0.5]);
  });
  it('clusters: row blocks and a profile per cluster; Save cluster as BED set keeps the exact regions, strand and name', () => {
    const f = heatmapFigure({ ...plot, heatmap: { ...plot.heatmap, sort: 'cluster', k: 2 } }, entry());
    expect(f.clusters!.map(c => c.features.map(x => x.id))).toEqual([['f2'], ['f1']]);
    expect(f.blocks.map(b => b.title)).toEqual(['D0 · C1', 'D0 · C2']);
    expect(f.profile!.lines.map(l => l.title)).toEqual(['C1', 'C2']);
    const sets = clusterRegionSets(f, 'Peaks');
    expect(sets.map(s => [s.name, s.regions])).toEqual([['Peaks · Cluster 1', [['chrT', 55, 65, '-', 'f2']]], ['Peaks · Cluster 2', [['chrT', 5, 15, '+', 'f1']]]]);
  });
  it('Compare: the heatmap is the per-region A − B, the profile shows the groups', () => {
    const f = heatmapFigure({ ...plot, groupBy: 'dataset', compare: 'diff', compareMode: 'a-vs-b', compareAB: ['p|d0', 'p|d1'] }, entry(2));
    expect(f.comparing).toBe(true);
    const f1 = f.blocks[0].rows.find(r => r.label === 'f1')!;
    expect(f1.values.map(v => +(v as number).toFixed(6))).toEqual([-0.3, -0.1]);
    expect(f.profile!.lines.map(l => l.title)).toEqual(['D0', 'D1']);
  });
  it('the header says what it measures', () => {
    expect(regionHeatmapHeader({ source: 'Accessibility (fire)', regions: 1000, what: 'BED regions', window: '±1,000 bp', sort: plot.heatmap, seed: 1, subsample: 'random 1,000 regions per set' }))
      .toBe('Accessibility (fire) per region, 1,000 BED regions ±1,000 bp, sorted by mean; seed 1 · random 1,000 regions per set');
  });
});

describe('the retired reads × position mode', () => {
  it('a new heatmap is per region; switching a view plot to Heatmap takes the selected features', () => {
    expect(newPlot({ type: 'heatmap' }).where).toBe('features');
    expect(withType(newPlot({ type: 'metaprofile' }), 'heatmap').where).toBe('features');
  });
  it('an old reads-mode plot and card open as stored, with the note (no error); old sort values map', () => {
    const old = normalizePlot({ type: 'heatmap', where: 'view', heatmap: { sort: 'start' } });
    expect(old.where).toBe('view');
    expect(old.heatmap.sort).toBe('bed');
    expect(normalizePlot({ type: 'heatmap', heatmap: { sort: 'signal' } }).heatmap.sort).toBe('mean');
    const stored: HeatmapEntry = { key: 'k', locus: { chrom: 'chrT', start: 0, end: 30, genome: null }, mode: 'reads', binBp: 10, start: 0, groups: [{ id: 'p|d', title: 'D' }],
      rows: [{ group: 'p|d', start: 0, mean: 0.5, values: [0.5, 0.5, null], label: 'read 1' }] };
    const back = unpackHeatmap(JSON.parse(JSON.stringify(packHeatmap(stored, 400))), 'k', stored.locus);
    const f = heatmapFigure(old, back);
    expect(f.blocks[0].rows).toHaveLength(1);
    expect(f.note).toMatch(/retired/);
  });
});
