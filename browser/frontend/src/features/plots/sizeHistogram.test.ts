/**
 * Footprint size histogram: footprints counted by size when their midpoint is in the view; share of footprints, counts
 * or per read; pooling exact; Compare A − B between groups; the settings model.
 */
import { describe, expect, it } from 'vitest';
import { histogramAccumulate, histogramFigure, histogramRaws } from './sizeHistogram';
import { engineRead } from './useProfileData';
import { applyBandsAndCondition } from './sizeBands';
import { poolProfiles } from './profileEngine';
import { DEFAULT_HISTOGRAM_SETTINGS, DEFAULT_PROFILE_SETTINGS, newPlot, normalizeHistogramSettings } from './plotModel';
import { regionReadsFromServer } from './bedData';

const view = { start: 1000, end: 2000 };
const plotWith = (patch = {}) => newPlot({ type: 'size-histogram', hist: { ...DEFAULT_HISTOGRAM_SETTINGS, binBp: 10, sizeMin: 0, sizeMax: 100, ...patch } });
const reads = [
  { group: 'a', start: 900, end: 2100, intervals: [[1000, 1015], [1100, 1150], [1950, 2080]] as Array<[number, number]> },
  { group: 'a', start: 1000, end: 1500, intervals: [[1200, 1255]] as Array<[number, number]> },
  { group: 'b', start: 1000, end: 1500, intervals: [[1300, 1305], [1400, 1405]] as Array<[number, number]> },
];

describe('size histogram', () => {
  it('counts footprints by size when their midpoint is in the view; density sums to 1', () => {
    const [a, b] = histogramRaws(reads, [{ id: 'a' }, { id: 'b' }], view, plotWith());
    // a: sizes 15, 50, 55 (the 130 bp one has its midpoint outside the view... and is past sizeMax).
    expect(Array.from(a.signal)).toEqual([0, 1, 0, 0, 0, 2, 0, 0, 0, 0]);
    expect(a.coverage[0]).toBe(3);
    expect(a.nReads).toBe(2);
    expect(b.signal[0]).toBe(2);
    const fig = histogramFigure(plotWith(), [{ id: 'a', title: 'A', raw: a }, { id: 'b', title: 'B', raw: b }]);
    expect(fig.series[0].values.reduce((s, v) => (s as number) + (v ?? 0), 0)).toBeCloseTo(1);
    expect(fig.yLabel).toBe('fraction of footprints');
  });

  it('counts and per read; pooling is exact; Compare A − B', () => {
    const counts = histogramRaws(reads, [{ id: 'a' }], view, plotWith({ normalization: 'count' }));
    expect(histogramFigure(plotWith({ normalization: 'count' }), [{ id: 'a', title: 'A', raw: counts[0] }]).series[0].values[5]).toBe(2);
    const per = histogramRaws(reads, [{ id: 'a' }], view, plotWith({ normalization: 'per-read' }));
    expect(histogramFigure(plotWith({ normalization: 'per-read' }), [{ id: 'a', title: 'A', raw: per[0] }]).series[0].values[5]).toBe(1);
    const [a, b] = histogramRaws(reads, [{ id: 'a' }, { id: 'b' }], view, plotWith());
    const pooled = poolProfiles([a, b], 'all');
    expect(pooled.signal[0] / pooled.coverage[0]).toBeCloseTo(2 / 5);
    const cmp = histogramFigure({ ...plotWith(), compare: 'diff', compareMode: 'a-vs-b' }, [{ id: 'p|a', title: 'A', raw: a }, { id: 'q|b', title: 'B', raw: b }]);
    expect(cmp.comparing).toBe(true);
    expect(cmp.series[0].values[0]).toBeCloseTo(0 - 1);
    expect(cmp.yLabel).toBe('Δ fraction of footprints');
  });

  it('settings normalise: the range keeps at least one bin', () => {
    expect(normalizeHistogramSettings({ sizeMin: 200, sizeMax: 100, binBp: 10, normalization: 'x' })).toMatchObject({ sizeMin: 200, sizeMax: 210, normalization: 'density' });
  });
});

describe('clipped footprints keep their whole size', () => {
  // A 100-bp footprint [950, 1050) read over [1000, 1100): compact reads send [0, 50, 100] (clipped, whole size).
  const compact = { id: 'r', aligned_blocks: [[900, 1100]], intervals: [[0, 50, 100]] };
  const win = { start: 1000, end: 1100 };
  const h = { ...DEFAULT_HISTOGRAM_SETTINGS, binBp: 10, sizeMin: 0, sizeMax: 200, normalization: 'count' as const, weighting: 'count' as const };
  it('the size is the footprint\'s, not its clipped length; midpoint and clipped weight use its whole bounds', () => {
    const r = engineRead(compact, 1000, 'nuc', 'g')!;
    const [p] = histogramAccumulate([r], win, { ...h, inclusion: 'overlap' }, ['g']);
    expect(p.signal[10]).toBe(1);
    expect(p.signal[5]).toBe(0);
    // Its midpoint is 1000: inside [1000, 1100); the same footprint read over [1010, 1110) is left out (clipped midpoint 1030).
    expect(histogramAccumulate([r], win, { ...h, inclusion: 'midpoint' }, ['g'])[0].signal[10]).toBe(1);
    const late = engineRead({ ...compact, intervals: [[0, 40, 100]] }, 1010, 'nuc', 'g')!;
    expect(histogramAccumulate([late], { start: 1010, end: 1110 }, { ...h, inclusion: 'midpoint' }, ['g'])[0].signal[10]).toBe(0);
    // bp weighting under "clipped": the bp inside the region (50), counted in the 100-bp bin.
    expect(histogramAccumulate([r], win, { ...h, inclusion: 'clipped', weighting: 'bp' }, ['g'])[0].signal[10]).toBe(50);
  });
  it('an unclipped footprint is binned by its size field, as the server size plots and the bands do', () => {
    const r = engineRead({ id: 'r', aligned_blocks: [[1000, 1100]], intervals: [[10, 60, 48]] }, 1000, 'nuc', 'g')!;
    expect(histogramAccumulate([r], win, { ...h, inclusion: 'overlap' }, ['g'])[0].signal[4]).toBe(1);
  });
  it('size bands split by the whole size', () => {
    const r = engineRead(compact, 1000, 'nuc', 'g')!;
    const out = applyBandsAndCondition([r], [{ id: 'g', title: 'G' }], { ...DEFAULT_PROFILE_SETTINGS, band: 'each', bandEdges: [80] }, () => null);
    expect(out.reads.find(x => x.group === 'g|b1')!.intervals!.length).toBe(1);
    expect(out.reads.find(x => x.group === 'g|b0')!.intervals!.length).toBe(0);
  });
});

describe('a compact footprint cut at both ends of a narrower window (3.1.1)', () => {
  // A 300-bp footprint read over [1000, 1100): compact reads send [0, 100, 300], cut at both edges. Where it starts is
  // unknown, so its midpoint is too: it is not counted as one inside the window (it used to be centred on the window,
  // midpoint 1050, and counted). It does overlap the window, and its bp inside are exact (100).
  const r = engineRead({ id: 'r', aligned_blocks: [[500, 1600]], intervals: [[0, 100, 300]] }, 1000, 'nuc', 'g')!;
  const win = { start: 1000, end: 1100 };
  const h = { ...DEFAULT_HISTOGRAM_SETTINGS, binBp: 10, sizeMin: 0, sizeMax: 400, normalization: 'count' as const, weighting: 'count' as const };
  it('midpoint inclusion leaves it out; overlap and clipped keep it at its whole size', () => {
    expect(histogramAccumulate([r], win, { ...h, inclusion: 'midpoint' }, ['g'])[0].signal[30]).toBe(0);
    expect(histogramAccumulate([r], win, { ...h, inclusion: 'overlap' }, ['g'])[0].signal[30]).toBe(1);
    expect(histogramAccumulate([r], win, { ...h, inclusion: 'clipped', weighting: 'bp' }, ['g'])[0].signal[30]).toBe(100);
    // The read still touches the window (per-read denominators).
    expect(histogramAccumulate([r], win, { ...h, inclusion: 'midpoint' }, ['g'])[0].nReads).toBe(1);
  });
});

describe('BED transport sends whole footprints (size histograms)', () => {
  // Window [1000, 1100): [950, 1050) is 100 bp, cut on the left; [810, 1110) is 300 bp, cut on both sides with its
  // midpoint (960) outside the window. The server sends them whole, relative to the window start, with their sizes.
  const regions = [{ set: 's', index: 0, offset: 1000, reads: { d1: [[0, 100, [-50, 50, -190, 110], [], [], 'r1', null, [100, 300]]] as never } }];
  const sets = [{ id: 's', name: 's', path: '/x/s.bed', color: '#000', total: 1, regions: [['chrT', 1000, 1100, '+', ''] as [string, number, number, string, string]] }];
  const win = { start: 1000, end: 1100 };
  const h = { ...DEFAULT_HISTOGRAM_SETTINGS, binBp: 10, sizeMin: 0, sizeMax: 400, normalization: 'count' as const, weighting: 'count' as const };
  it('bins the real size and selects by the real midpoint', () => {
    const [item] = regionReadsFromServer(sets as never, regions);
    const r = { ...item.byDataset.get('d1')![0], group: 'g' };
    expect(r.intervals).toEqual([[950, 1050, 100], [810, 1110, 300]]);
    const mid = histogramAccumulate([r], win, { ...h, inclusion: 'midpoint' }, ['g'])[0];
    // The 100 bp footprint (midpoint 1000) is in its 100 bp bin, not a 50 bp one; the 300 bp one (midpoint 960) is out.
    expect(mid.signal[10]).toBe(1);
    expect(mid.signal[5]).toBe(0);
    expect(mid.signal[30]).toBe(0);
    const over = histogramAccumulate([r], win, { ...h, inclusion: 'overlap' }, ['g'])[0];
    expect(over.signal[10]).toBe(1);
    expect(over.signal[30]).toBe(1);
    // "clipped" bp weighting: the bp inside the window (50 and 100).
    const clipped = histogramAccumulate([r], win, { ...h, inclusion: 'clipped', weighting: 'bp' }, ['g'])[0];
    expect(clipped.signal[10]).toBe(50);
    expect(clipped.signal[30]).toBe(100);
  });

  it('a footprint across a large deletion that the fetch cut is not taken as whole (100M1900D100M)', () => {
    // 200 bp footprint on a read 100M1900D100M from reference 400: reference [400, 2500), midpoint 1450. Window
    // [1700, 1800), size max 400 (margin 800): the fetch [900, 2600) cut it to [900, 2500), which once passed for whole
    // with its midpoint at 1700, inside the window. The server lists it as cut (index 0).
    const cutRegions = [{ set: 's', index: 0, offset: 1700, reads: { d1: [[0, 100, [-800, 800], [], [], 'r1', null, [200], [0]]] as never } }];
    const cutSets = [{ ...sets[0], regions: [['chrT', 1700, 1800, '+', ''] as [string, number, number, string, string]] }];
    const [item] = regionReadsFromServer(cutSets as never, cutRegions);
    const r = { ...item.byDataset.get('d1')![0], group: 'g' };
    expect(r.intervals).toEqual([[900, 2500, 200, 1]]);
    const w = { start: 1700, end: 1800 };
    expect(histogramAccumulate([r], w, { ...h, inclusion: 'midpoint' }, ['g'])[0].signal[20]).toBe(0);
    // It does overlap the window, and its bp inside the window are exact (the cut is beyond the margin).
    expect(histogramAccumulate([r], w, { ...h, inclusion: 'overlap' }, ['g'])[0].signal[20]).toBe(1);
    expect(histogramAccumulate([r], w, { ...h, inclusion: 'clipped', weighting: 'bp' }, ['g'])[0].signal[20]).toBe(100);
  });
});
