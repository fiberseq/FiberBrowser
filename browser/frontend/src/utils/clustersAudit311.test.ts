/** Clusters → Plots (3.1.1 release audit): the "here" entries plot the asking panel; a new plot shows on the Plot tab;
 *  a retired tab opens Overview on a mounted panel; any size range; log2 ratio of enrichment; the reveal chain. */
import '../features/testSetup';
import { afterEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { openFootprintSizes } from './footprintSizeEntry';
import { closePlots, useWorkspaceStore } from '../features/plots/workspace';
import { normalizePlot } from '../features/plots/plotModel';
import { comparisons } from '../features/plots/compare';
import { comparesEnrichment, requestSettings } from '../features/plots/sizeFigure';
import { newPlot } from '../features/plots/plotModel';
import { showPanelTab } from './tutorialAnchors';
import anchors from '../data/tutorialAnchors.json';

const panel = (id: string, datasetId: string, viewportOverride?: { chrom: string; start: number; end: number }) =>
  ({ id, contentType: 'dataset', datasetId, stateKey: datasetId, ...(viewportOverride ? { viewportOverride } : {}) });

afterEach(() => { closePlots(); useBrowserStore.setState({ clusterAssignments: {} } as never); });

describe('"here" entries plot the panel they were asked from (audit #1)', () => {
  it('a clustered panel: by cluster, at that panel, and Plots is told which panel', () => {
    useBrowserStore.setState({ datasets: [{ id: 'A' }, { id: 'B' }], panels: [panel('pA', 'A'), panel('pB', 'B', { chrom: 'chrT', start: 5000, end: 6000 })],
      navigationMode: 'perPanel', chrom: 'chrT', start: 100, end: 900, clusterAssignments: { A: { r1: 0 }, B: { r2: 1 } } } as never);
    openFootprintSizes({ panelId: 'pB' });
    const plot = useBrowserStore.getState().plotsWorkspace.current;
    expect(plot).toMatchObject({ groupBy: 'cluster', panel: 'pB', pinned: { chrom: 'chrT', start: 5000, end: 6000 } });
  });
  it('an unclustered panel next to a clustered one: by dataset at that panel, never the clustered panel\'s locus', () => {
    useBrowserStore.setState({ datasets: [{ id: 'A' }, { id: 'B' }], panels: [panel('pA', 'A'), panel('pB', 'B', { chrom: 'chrT', start: 5000, end: 6000 })],
      navigationMode: 'perPanel', chrom: 'chrT', start: 100, end: 900, clusterAssignments: { A: { r1: 0 } } } as never);
    openFootprintSizes({ panelId: 'pB' });
    const plot = useBrowserStore.getState().plotsWorkspace.current;
    expect(plot).toMatchObject({ groupBy: 'dataset', panel: 'pB', pinned: { chrom: 'chrT', start: 5000, end: 6000 } });
  });
  it('the panel scope round-trips through a saved plot', () => {
    expect(normalizePlot({ type: 'size-enrichment', panel: 'pB' }).panel).toBe('pB');
    expect(normalizePlot({ type: 'size-enrichment' }).panel).toBeUndefined();
  });
});

describe('a new plot is shown, not the Gallery (audit #5)', () => {
  it('opening Plots with a plot selects the Plot tab', () => {
    useBrowserStore.setState({ datasets: [{ id: 'A' }], panels: [panel('pA', 'A')], clusterAssignments: {} } as never);
    useWorkspaceStore.setState({ plotsTab: 'gallery' });
    openFootprintSizes();
    expect(useWorkspaceStore.getState().plotsTab).toBe('plot');
  });
});

describe('retired Clusters tab on a mounted panel (audit #4)', () => {
  it('showPanelTab maps vplot to Overview', async () => {
    const host = document.createElement('div');
    host.setAttribute('data-panel-content-type', 'cluster-detail');
    const btn = document.createElement('button');
    btn.setAttribute('data-analysis-tab', 'overview');
    let clicked = 0;
    btn.addEventListener('click', () => { clicked++; });
    host.appendChild(btn);
    document.body.appendChild(host);
    // jsdom has no layout: make the button count as visible.
    Object.defineProperty(btn, 'offsetParent', { get: () => document.body });
    btn.getBoundingClientRect = () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    btn.getClientRects = () => [btn.getBoundingClientRect()] as unknown as DOMRectList;
    expect(await showPanelTab('cluster-detail', 'vplot', 200)).toBe(true);
    expect(clicked).toBe(1);
    host.remove();
  });
});

describe('log2 ratio of enrichment (audit #3)', () => {
  it('A vs B on the normalised matrices: the same row profile compares as 0, unlike the size shares', () => {
    // Per size row: A = [[800, 200], [100, 900]] and B = [[80, 20], [100, 900]] normalise to the same rows.
    const nA = [[1.6, 0.4], [0.2, 1.8]], nB = [[1.6, 0.4], [0.2, 1.8]];
    const enr = comparisons([{ id: 'a', title: 'A', panelKey: 'p', matrix: nA }, { id: 'b', title: 'B', panelKey: 'p', matrix: nB }], 'a-vs-b', ['a', 'b'], 'log2ratio', m => m)[0].matrix;
    for (const row of enr) for (const v of row) expect(v).toBeCloseTo(0, 12);
    const shares = comparisons([{ id: 'a', title: 'A', panelKey: 'p', matrix: [[800, 200], [100, 900]] }, { id: 'b', title: 'B', panelKey: 'p', matrix: [[80, 20], [100, 900]] }], 'a-vs-b', ['a', 'b'])[0].matrix;
    expect(shares[0][0]!).toBeGreaterThan(2);
    expect(normalizePlot({ type: 'size-enrichment', sizeCompareOn: 'enrichment' }).sizeCompareOn).toBe('enrichment');
    expect(normalizePlot({ type: 'size-enrichment', sizeCompareOn: 'x' }).sizeCompareOn).toBeUndefined();
  });
  it('requests the server-normalised matrices (its Min footprints guard) only for A vs B; rest / all read counts', () => {
    const ab = newPlot({ type: 'size-enrichment', compare: 'log2ratio', compareMode: 'a-vs-b', sizeCompareOn: 'enrichment' });
    expect(comparesEnrichment(ab, 3)).toBe(true);
    expect(requestSettings(ab, 3).normalization).toBe('row');
    expect(requestSettings(ab, 3).log).toBe(false);
    const rest = { ...ab, compareMode: 'each-vs-rest' as const };
    expect(comparesEnrichment(rest, 3)).toBe(false);
    expect(requestSettings(rest, 3).normalization).toBe('raw');
    expect(comparesEnrichment({ ...ab, sizeCompareOn: undefined }, 3)).toBe(false);
  });
});

describe('the size-settings reveal chain (audit #6)', () => {
  it('More options of a size plot only: another plot type\'s does not satisfy it', () => {
    const a = (anchors as unknown as { anchors: Array<{ id: string; selector: string }> }).anchors.find(x => x.id === 'plots-sizes-more-options')!;
    expect(a.selector).toContain('data-plot-type="size-enrichment"');
    expect(a.selector).toContain('data-plot-type="vplot"');
  });
});

describe('enrichment compare draws only what was fetched (audit 3.1.1 re-check)', () => {
  const data = (normalization: 'raw' | 'row', matrix: number[][]) => ({ matrix, size_min: 0, size_max: 20, size_bin: 10, pos_bin: 10, mode: 'span', normalization,
    row_min_footprints: 0, sigma_size_bp: 0, sigma_pos_bp: 0, group_by: 'all', n_reads: 1, n_footprints: 1 }) as never;
  const plotAB = newPlot({ type: 'size-enrichment', compare: 'log2ratio', compareMode: 'a-vs-b', compareAB: ['a', 'b'], sizeCompareOn: 'enrichment' });
  it('counts (a cached or count request) are never read as enrichment: shares then', async () => {
    const { sizeFigure } = await import('../features/plots/sizeFigure');
    const fig = sizeFigure({ plot: plotAB, start: 0, width: 200, height: 100,
      plots: [{ id: 'a', title: 'A', data: data('raw', [[800, 200]]) }, { id: 'b', title: 'B', data: data('raw', [[80, 20]]) }] as never });
    expect(fig.charts[0].subtitle).toBe('log2 ratio of footprint size distributions');
    const fig2 = sizeFigure({ plot: plotAB, start: 0, width: 200, height: 100,
      plots: [{ id: 'a', title: 'A', data: data('row', [[1.6, 0.4]]) }, { id: 'b', title: 'B', data: data('row', [[1.6, 0.4]]) }] as never });
    expect(fig2.charts[0].subtitle).toBe('log2 ratio of size enrichment');
    for (const v of fig2.charts[0].matrix[0]) expect(v).toBeCloseTo(0, 12);
  });
  it('a BED size result is keyed by the comparison it was finished for', async () => {
    const { bedSizesKey } = await import('../features/plots/BedSizePlot');
    const t = { chrom: 'c', start: 0, end: 10, genome: null, panels: [] } as never;
    const k1 = bedSizesKey({ ...plotAB, sizeCompareOn: undefined }, [], t, '1', 's');
    expect(bedSizesKey(plotAB, [], t, '1', 's')).not.toBe(k1);
    expect(bedSizesKey({ ...plotAB, compareMode: 'each-vs-rest' }, [], t, '1', 's')).not.toBe(bedSizesKey(plotAB, [], t, '1', 's'));
  });
});

describe('switching the compare operator never reuses incompatible matrices (audit 3.1.1 re-check 3)', () => {
  const data = (normalization: 'raw' | 'row', matrix: number[][]) => ({ matrix, size_min: 0, size_max: 20, size_bin: 10, pos_bin: 10, mode: 'span', normalization,
    row_min_footprints: 0, sigma_size_bp: 0, sigma_pos_bp: 0, group_by: 'all', n_reads: 1, n_footprints: 1 }) as never;
  it('the BED key changes with the operator; A − B on normalised matrices draws nothing (updating), never zeros', async () => {
    const { bedSizesKey } = await import('../features/plots/BedSizePlot');
    const { sizeFigure } = await import('../features/plots/sizeFigure');
    const p = newPlot({ type: 'size-enrichment', compare: 'log2ratio', compareMode: 'a-vs-b', compareAB: ['a', 'b'], sizeCompareOn: 'enrichment' });
    const t = { chrom: 'c', start: 0, end: 10, genome: null, panels: [] } as never;
    expect(bedSizesKey({ ...p, compare: 'diff' }, [], t, '1', 's')).not.toBe(bedSizesKey(p, [], t, '1', 's'));
    const fig = sizeFigure({ plot: { ...p, compare: 'diff' }, start: 0, width: 200, height: 100,
      plots: [{ id: 'a', title: 'A', data: data('row', [[1.6, 0.4]]) }, { id: 'b', title: 'B', data: data('row', [[1.6, 0.4]]) }] as never });
    expect(fig.charts[0].matrix.flat().every(v => v == null)).toBe(true);
    expect(fig.charts[0].subtitle).toBe('updating…');
    const ok = sizeFigure({ plot: { ...p, compare: 'diff' }, start: 0, width: 200, height: 100,
      plots: [{ id: 'a', title: 'A', data: data('raw', [[800, 200], [100, 900]]) }, { id: 'b', title: 'B', data: data('raw', [[80, 20], [100, 900]]) }] as never });
    expect(ok.charts[0].matrix[0][0]!).toBeCloseTo(800 / 2000 - 80 / 1100, 6);
  });
});

describe('a size panel never draws a matrix finished another way (audit 3.1.1 re-check 4)', () => {
  it('counts left over from a comparison are blank (updating), not drawn as enrichment', async () => {
    const { sizeFigure } = await import('../features/plots/sizeFigure');
    const d = (normalization: 'raw' | 'row') => ({ matrix: [[800, 200], [100, 900]], size_min: 0, size_max: 20, size_bin: 10, pos_bin: 10, mode: 'span', normalization,
      row_min_footprints: 0, sigma_size_bp: 0, sigma_pos_bp: 0, group_by: 'all', n_reads: 1, n_footprints: 1 }) as never;
    const plot = newPlot({ type: 'size-enrichment', compare: 'diff' });
    const bad = sizeFigure({ plot, start: 0, width: 200, height: 100, plots: [{ id: 'a', title: 'A', data: d('raw') }] as never });
    expect(bad.charts[0].matrix.flat().every(v => v == null)).toBe(true);
    expect(bad.charts[0].subtitle).toBe('updating…');
    const good = sizeFigure({ plot, start: 0, width: 200, height: 100, plots: [{ id: 'a', title: 'A', data: d('row') }] as never });
    expect(good.charts[0].matrix.flat().some(v => v != null)).toBe(true);
  });
});
