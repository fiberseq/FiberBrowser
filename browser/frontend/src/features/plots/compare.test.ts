/**
 * Compare, made explicit: each vs rest (default for clusters), each vs all, A vs B (default for two datasets); labels
 * say what is compared; every comparison panel shares one symmetric RdBu_r scale centred on 0, while single plots keep
 * their own colour settings. Tested with four clusters in one dataset and with clusters in two datasets.
 */
import { describe, expect, it } from 'vitest';
import { compareBlocker, comparisons, fractionDifference, log2FractionRatio, resolveCompareMode, type CompareGroup } from './compare';
import { newPlot } from './plotModel';
import { requestSettings, sizeFigure } from './sizeFigure';

const m = (v: number) => [[v, v], [v, 2 * v]];
const g = (id: string, title: string, panelKey: string, v: number, matrix = m(v)): CompareGroup => ({ id, title, panelKey, matrix });

describe('compare modes', () => {
  it('defaults: clusters each vs rest; two datasets A vs B; more datasets each vs rest', () => {
    expect(resolveCompareMode('auto', 'cluster', 2)).toBe('each-vs-rest');
    expect(resolveCompareMode('auto', 'dataset', 2)).toBe('a-vs-b');
    expect(resolveCompareMode('auto', 'dataset', 3)).toBe('each-vs-rest');
    expect(resolveCompareMode('each-vs-all', 'cluster', 4)).toBe('each-vs-all');
  });

  it('log2 ratio of fractions: equal shapes give 0 whatever the depth; blanks where either side has no count', () => {
    expect(log2FractionRatio(m(1), m(10)).flat()).toEqual([0, 0, 0, 0]);
    const r = log2FractionRatio([[2, 0], [1, 1]], [[1, 1], [1, 1]]);
    expect(r[0][0]).toBeCloseTo(Math.log2((2 / 4) / (1 / 4)));
    expect(r[0][1]).toBeNull();
  });

  it('four clusters, each vs rest: one map per cluster against the other three, labelled', () => {
    const groups = [g('p|0', 'C0', 'p', 1, [[4, 1], [1, 1]]), g('p|1', 'C1', 'p', 1), g('p|2', 'C2', 'p', 1), g('p|3', 'C3', 'p', 1)];
    const c = comparisons(groups, 'each-vs-rest');
    expect(c.map(x => x.label)).toEqual(['C0 vs rest', 'C1 vs rest', 'C2 vs rest', 'C3 vs rest']);
    // C0 vs (C1+C2+C3): rest = [[3,3],[3,6]] (total 15); C0 = [[4,1],[1,1]] (total 7).
    expect(c[0].matrix[0][0]).toBeCloseTo(Math.log2((4 / 7) / (3 / 15)));
    expect(c.every(x => x.b === 'rest')).toBe(true);
  });

  it('each vs all includes the group itself; A vs B picks any two (not the first two)', () => {
    const groups = [g('p|0', 'C0', 'p', 1, [[4, 1], [1, 1]]), g('p|1', 'C1', 'p', 1), g('p|2', 'C2', 'p', 1)];
    const all = comparisons(groups, 'each-vs-all');
    expect(all.map(x => x.label)).toEqual(['C0 vs all', 'C1 vs all', 'C2 vs all']);
    expect(all[0].matrix[0][0]).toBeCloseTo(Math.log2((4 / 7) / (6 / 17)));
    const ab = comparisons(groups, 'a-vs-b', ['p|2', 'p|0']);
    expect(ab).toHaveLength(1);
    expect(ab[0].label).toBe('C2 vs C0');
  });

  it('clusters of two datasets: each cluster against the rest of its own dataset', () => {
    const groups = [g('a|0', 'A · C0', 'a', 1), g('a|1', 'A · C1', 'a', 2), g('b|0', 'B · C0', 'b', 5, [[1, 9], [1, 1]]), g('b|1', 'B · C1', 'b', 1)];
    const c = comparisons(groups, 'each-vs-rest');
    expect(c.map(x => x.label)).toEqual(['A · C0 vs rest', 'A · C1 vs rest', 'B · C0 vs rest', 'B · C1 vs rest']);
    // A's clusters have the same shape: 0 everywhere; B · C0 differs from B · C1.
    expect(c[0].matrix.flat().every(v => v === 0)).toBe(true);
    expect(c[2].matrix[0][1]).toBeGreaterThan(0);
  });

  it('one group: nothing to compare, and a message says why', () => {
    expect(comparisons([g('p|all', 'D', 'p', 1)], 'each-vs-rest')).toEqual([]);
    expect(compareBlocker(1, 'dataset')).toMatch(/one dataset/);
    expect(compareBlocker(1, 'cluster')).toMatch(/two or more/);
    expect(compareBlocker(2, 'dataset')).toBeNull();
  });
});

describe('the figure', () => {
  const plotsOf = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `p|${i}`, title: `C${i}`, data: { matrix: [[1 + i, 2], [3, 4 + 2 * i]], size_min: 10, size_max: 30, size_bin: 10, pos_bin: 10, n_reads: 10, n_footprints: 100 } as never,
  }));

  it('comparisons read counts and share one symmetric RdBu_r scale centred on 0', () => {
    const plot = newPlot({ groupBy: 'cluster', compare: 'log2ratio' });
    expect(requestSettings(plot, 3)).toMatchObject({ normalization: 'raw', log: false });
    expect(requestSettings(plot, 1).normalization).toBe(plot.size.normalization);
    const fig = sizeFigure({ plot, plots: plotsOf(3), start: 0, width: 240, height: 300 });
    expect(fig.comparing).toBe(true);
    expect(fig.mode).toBe('each-vs-rest');
    expect(fig.charts.map(c => c.title)).toEqual(['C0 vs rest', 'C1 vs rest', 'C2 vs rest']);
    const scales = new Set(fig.charts.map(c => JSON.stringify(c.scale)));
    expect(scales.size).toBe(1);
    const s = fig.charts[0].scale;
    expect(s).toMatchObject({ kind: 'diverging', mid: 0, colormap: 'rdbu_r' });
    expect(s.lo).toBeCloseTo(-s.hi);
  });

  it('single plots: magma for Size enrichment (log2 included), viridis for the V-plot', () => {
    const v = sizeFigure({ plot: newPlot({ type: 'vplot' }), plots: plotsOf(2), start: 0, width: 240, height: 300 });
    expect(v.comparing).toBe(false);
    expect(v.charts.every(c => c.scale.colormap === 'viridis')).toBe(true);
    const e = sizeFigure({ plot: newPlot(), plots: plotsOf(2), start: 0, width: 240, height: 300 });
    expect(e.charts.every(c => c.scale.colormap === 'magma')).toBe(true);
    // A comparison on the same plot settings: RdBu_r.
    const c = sizeFigure({ plot: newPlot({ compare: 'log2ratio' }), plots: plotsOf(2), start: 0, width: 240, height: 300 });
    expect(c.charts.every(x => x.scale.colormap === 'rdbu_r')).toBe(true);
  });
});

describe('A − B for the size plots', () => {
  it('is the difference of shares, blank where neither side counts, and swapping flips the sign', () => {
    const a = [[2, 0], [2, 0]], b = [[1, 1], [0, 0]];
    expect(fractionDifference(a, b)).toEqual([[0.5 - 0.5, -0.5], [0.5, null]]);
    const ab = comparisons([g('a', 'A', 'p', 1, a), g('b', 'B', 'q', 1, b)], 'a-vs-b', ['a', 'b'], 'diff')[0].matrix;
    const ba = comparisons([g('a', 'A', 'p', 1, a), g('b', 'B', 'q', 1, b)], 'a-vs-b', ['b', 'a'], 'diff')[0].matrix;
    ab.flat().forEach((v, i) => { const w = ba.flat()[i]; if (v == null) expect(w).toBeNull(); else expect(v + (w as number)).toBeCloseTo(0); });
  });
  it('draws on one symmetric RdBu scale centred on 0, titled A − B', () => {
    const plot = newPlot({ compare: 'diff', groupBy: 'dataset' });
    const plots = [0, 1].map(i => ({ id: `p${i}|all`, title: `D${i}`, data: { matrix: i ? [[1, 3], [2, 2]] : [[3, 1], [2, 2]], size_min: 0, size_max: 20, size_bin: 10, pos_bin: 10, n_reads: 5, n_footprints: 8 } }));
    const fig = sizeFigure({ plot, plots: plots as never, start: 0, width: 240, height: 300 });
    expect(fig.comparing).toBe(true);
    expect(fig.charts).toHaveLength(1);
    expect(fig.charts[0].title).toBe('D0 − D1');
    expect(fig.charts[0].scale).toMatchObject({ kind: 'diverging', mid: 0, colormap: 'rdbu_r' });
    expect(fig.charts[0].scale.lo).toBeCloseTo(-fig.charts[0].scale.hi);
    expect(requestSettings(plot, 2)).toMatchObject({ normalization: 'raw', log: false });
  });
});
