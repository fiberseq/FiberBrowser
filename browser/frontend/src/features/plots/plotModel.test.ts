/**
 * The Plots settings model: a plot is Type × Source × Where × Group by + Compare with its type's settings; defaults,
 * normalising stored values, type switches, the request settings, names and duplicates.
 */
import { describe, expect, it } from 'vitest';
import { ALL_FOOTPRINTS, DEFAULT_FOOTPRINT_SIZE_COLORMAPS, colorSlotOf } from '../../utils/footprintSizeSettings';
import {
  DEFAULT_FOLLOW_DELAY_MS, compareAvailable, groupAvailable, whereAvailable, PLOT_COMPARE, PLOT_GROUP_BY, PLOT_TYPES, PLOT_WHERE, describePlot, duplicatePlot, effectiveSizeSettings,
  followsView, formatLocus, newPlot, normalizePlot, plotDisplayName, withType,
} from './plotModel';

describe('plot model', () => {
  it('a new plot: Size enrichment of all footprints in the current view, by dataset, following the view', () => {
    const p = newPlot();
    expect(p).toMatchObject({ type: 'size-enrichment', source: ALL_FOOTPRINTS, where: 'view', groupBy: 'dataset', compare: 'off', pinned: null, name: '' });
    expect(followsView(p)).toBe(true);
    expect(p.size).toMatchObject({ view: 'enrichment', mode: 'span', normalization: 'row', log: true, ratio: null });
    expect(DEFAULT_FOLLOW_DELAY_MS).toBe(300);
  });

  it('colormaps: single plots magma (Size enrichment) or viridis (V-plot); comparisons RdBu_r centred on 0', () => {
    const enrich = newPlot();
    expect(colorSlotOf(enrich.size)).toBe('enrichment');
    expect(enrich.size.colormaps.enrichment.name).toBe('magma');
    const v = newPlot({ type: 'vplot' });
    expect(v.size).toMatchObject({ view: 'vplot', mode: 'midpoint', normalization: 'raw' });
    expect(colorSlotOf(v.size)).toBe('vplot');
    expect(v.size.colormaps.vplot.name).toBe('viridis');
    expect(colorSlotOf(enrich.size, true)).toBe('comparative');
    expect(enrich.size.colormaps.comparative.name).toBe('rdbu_r');
    expect(DEFAULT_FOOTPRINT_SIZE_COLORMAPS.enrichment.name).toBe('magma');
  });

  it('switching between the size types applies the view preset and keeps the rest', () => {
    const p = newPlot();
    const edited = { ...p, size: { ...p.size, sizeBin: 5, minFootprints: 7 } };
    const v = withType(edited, 'vplot');
    expect(v.type).toBe('vplot');
    expect(v.size).toMatchObject({ view: 'vplot', mode: 'midpoint', normalization: 'raw', sizeBin: 5, minFootprints: 7 });
    expect(withType(v, 'size-enrichment').size).toMatchObject({ view: 'enrichment', mode: 'span', normalization: 'row', sizeBin: 5 });
    expect(withType(v, 'vplot')).toBe(v);
  });

  it('available choices per phase: size types, Metaprofile, Heatmap; None, A − B and Selected features where they apply', () => {
    expect(PLOT_TYPES.filter(t => t.available).map(t => t.type)).toEqual(['size-enrichment', 'vplot', 'metaprofile', 'heatmap', 'size-histogram', 'differential', 'co-accessibility']);
    expect(PLOT_TYPES.filter(t => !t.available).every(t => t.phase && t.phase > 1)).toBe(true);
    // The heatmap is per region (its reads × position mode over the view is retired).
    expect(PLOT_WHERE.filter(w => whereAvailable(w, 'heatmap')).map(w => w.value)).toEqual(['features', 'bed']);
    expect(PLOT_WHERE.filter(w => whereAvailable(w, 'metaprofile')).map(w => w.value)).toEqual(['view', 'features', 'bed']);
    expect(PLOT_WHERE.filter(w => whereAvailable(w, 'vplot')).map(w => w.value)).toEqual(['view', 'bed']);
    expect(withType(newPlot({ type: 'heatmap', where: 'features' }), 'vplot').where).toBe('view');
    for (const t of ['metaprofile', 'heatmap', 'size-enrichment', 'vplot'] as const) {
      expect(PLOT_GROUP_BY.filter(g => groupAvailable(g, t)).map(g => g.value)).toEqual(['none', 'dataset', 'cluster', 'classes', 'read-groups']);
    }
    expect(PLOT_COMPARE.filter(c => compareAvailable(c, 'metaprofile')).map(c => c.value)).toEqual(['off', 'diff', 'log2ratio']);
    expect(PLOT_COMPARE.filter(c => compareAvailable(c, 'vplot')).map(c => c.value)).toEqual(['off', 'diff', 'log2ratio']);
    expect(newPlot().compareMode).toBe('auto');
  });

  it('normalises stored plots: unknown values fall back, ids are kept, the size copy carries no ratio', () => {
    const p = normalizePlot({
      id: 'plot-a', name: 'Mine', type: 'nonsense', source: 'msp', where: 'moon', groupBy: 'cluster', compare: 'log2ratio',
      compareAB: ['x', 'x'], pinned: { chrom: 'chr1', start: 10.4, end: 5 }, size: { sizeBin: 999, ratio: ['a', 'b'] },
    });
    expect(p).toMatchObject({ id: 'plot-a', name: 'Mine', type: 'size-enrichment', source: 'fire', where: 'view', groupBy: 'cluster', compare: 'log2ratio', compareAB: null, pinned: null });
    expect(p.size.sizeBin).toBe(200);
    expect(p.size.ratio).toBeNull();
    const pinned = normalizePlot({ pinned: { chrom: 'chr1', start: 10.4, end: 2000.6, genome: '' } });
    expect(pinned.pinned).toEqual({ chrom: 'chr1', start: 10, end: 2001, genome: null });
    expect(followsView(pinned)).toBe(false);
    expect(normalizePlot(null).id).toMatch(/^plot-/);
  });

  it('the request settings take source, grouping and the log2(A/B) pair from the plot', () => {
    const p = newPlot({ source: 'tf', groupBy: 'cluster', compare: 'log2ratio' });
    expect(effectiveSizeSettings(p, ['a', 'b'])).toMatchObject({ layer: 'tf', groupBy: 'clusters', ratio: ['a', 'b'] });
    expect(effectiveSizeSettings({ ...p, compare: 'off' }, ['a', 'b']).ratio).toBeNull();
    expect(effectiveSizeSettings(newPlot()).groupBy).toBe('datasets');
  });

  it('names, descriptions and duplicates', () => {
    const p = newPlot();
    expect(describePlot(p)).toBe('Size enrichment · All footprints · current view · by dataset');
    expect(plotDisplayName(p)).toBe(describePlot(p));
    expect(describePlot({ ...p, compare: 'log2ratio' })).toContain('log2 ratio');
    const named = { ...p, name: 'Promoter sizes' };
    const copy = duplicatePlot(named);
    expect(copy.id).not.toBe(named.id);
    expect(copy.name).toBe('Promoter sizes (copy)');
    expect(copy.size).toEqual(named.size);
    expect(copy.size).not.toBe(named.size);
    expect(formatLocus({ chrom: 'chr19', start: 1000, end: 3000 })).toBe('chr19:1,001–3,000');
    expect(formatLocus(null)).toBe('—');
  });
});
