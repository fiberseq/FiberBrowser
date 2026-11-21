/**
 * Supplied series: a panel's values drawn by Plots exactly (counts, no smoothing), kept exactly in their Gallery card,
 * opened in Plots with the card's values as the seed; Compare works on them; sessions keep them.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { profileFigure } from './profileFigure';
import { openSuppliedPlot, suppliedGroups, suppliedPlotSpec, suppliedTsv, type SuppliedInput } from './supplied';
import { emptyGallery, normalizeGallery, useGalleryStore } from './gallery';
import { useGallerySeed } from './galleryActions';
import { useBrowserStore } from '../../stores/browserStore';
import { useWorkspaceStore } from './workspace';
import { SuppliedPlot } from './SuppliedPlot';
import { normalizePlot } from './plotModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const input: SuppliedInput = {
  type: 'nuc-spacing', name: 'Local repeat length', groupBy: 'dataset', datasets: ['Early', 'Late'],
  spec: { origin: 'Nucleosomes › Local repeat length', x0: 150, dx: 2.5, xLabel: 'Repeat length (bp)', yLabel: 'share of molecules' },
  series: [{ id: 'p1|all', title: 'Early', color: '#c00', values: [0.1, 0.123456789012, null, 0.5] }, { id: 'p2|all', title: 'Late', values: [0.2, 0.1, 0.3, null] }],
  locus: { chrom: 'chrT', start: 1000, end: 5000, genome: null },
};

describe('supplied series', () => {
  it('draw exactly the supplied values (null stays a gap)', () => {
    const fig = profileFigure(suppliedPlotSpec(input), suppliedGroups({ series: input.series }), input.spec.dx);
    expect(fig.series.map(s => s.values)).toEqual(input.series.map(s => s.values));
  });
  it('Compare A − B works on them', () => {
    const plot = { ...suppliedPlotSpec(input), compare: 'diff' as const, compareMode: 'a-vs-b' as const };
    const fig = profileFigure(plot, suppliedGroups({ series: input.series }), input.spec.dx);
    expect(fig.comparing).toBe(true);
    expect(fig.series[0].values.map(v => (v == null ? null : +v.toFixed(12)))).toEqual([-0.1, 0.023456789012, null, null]);
  });
  it('TSV keeps every digit', () => {
    expect(suppliedTsv('x', input.spec, { series: input.series }).split('\n').slice(4)).toEqual(['x\tEarly\tLate', '150\t0.1\t0.2', '152.5\t0.123456789012\t0.1', '155\tNA\t0.3', '157.5\t0.5\tNA']);
  });
  it('a panel opens them in Plots: a Gallery card with the exact values, the seed, the plot pinned to the run', () => {
    useGalleryStore.setState(emptyGallery(), true);
    useWorkspaceStore.setState({ view: 'browser' });
    const id = openSuppliedPlot(input)!;
    const card = useGalleryStore.getState().entries.find(e => e.id === id)!;
    expect(card.supplied).toEqual({ series: input.series });
    expect(useGallerySeed.getState().suppliedSeed).toEqual({ series: input.series });
    expect(useWorkspaceStore.getState().view).toBe('plots');
    const plot = useBrowserStore.getState().plotsWorkspace.current;
    expect(plot).toMatchObject({ type: 'nuc-spacing', supplied: { origin: input.spec.origin, dx: 2.5 }, pinned: input.locus });
    // The same values again: the same card.
    expect(openSuppliedPlot(input)).toBe(id);
    // Sessions keep the card's values exactly and the plot's axis.
    const back = normalizeGallery(JSON.parse(JSON.stringify(useGalleryStore.getState())));
    expect(back.entries.find(e => e.id === id)!.supplied).toEqual({ series: input.series });
    expect(normalizePlot(JSON.parse(JSON.stringify(plot))).supplied).toEqual(plot.supplied);
  });
  it('renders from the seed; without it says where the series came from', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const plot = suppliedPlotSpec(input);
    act(() => { root.render(<SuppliedPlot plot={plot} data={{ series: input.series }} width={600} />); });
    expect(container.querySelector('[data-testid="plots-supplied-plot"]')!.getAttribute('data-groups')).toBe('2');
    expect(container.querySelector('[data-testid="plots-supplied-chart"]')).not.toBeNull();
    act(() => { root.render(<SuppliedPlot plot={plot} data={null} width={600} />); });
    expect(container.textContent).toContain('came from Nucleosomes › Local repeat length');
    act(() => root.unmount());
    container.remove();
  });
});

describe('lines of points', () => {
  it('become one shared x axis with aligned values (gaps where a line has no point), kept exactly', async () => {
    const { linesToSupplied, suppliedXs } = await import('./supplied');
    const out = linesToSupplied([{ key: 'a', label: 'A', color: '#f00', points: [[160, 0.1], [180.5, 0.3]] }, { key: 'b', label: 'B', points: [[170, 0.2], [180.5, null]] }]);
    expect(out.xs).toEqual([160, 170, 180.5]);
    expect(out.series).toEqual([{ id: 'a', title: 'A', color: '#f00', values: [0.1, null, 0.3] }, { id: 'b', title: 'B', values: [null, 0.2, null] }]);
    expect(suppliedXs({ origin: 'o', x0: 0, dx: 1, xLabel: '', yLabel: '' }, out)).toEqual([160, 170, 180.5]);
  });
});

describe('supplied matrices (V-plots, heatmaps)', () => {
  const mat = (signed: boolean, kind: 'vplot' | 'heatmap'): SuppliedInput => ({
    type: kind === 'vplot' ? 'vplot' : 'heatmap', name: 'm', datasets: ['D'], series: [],
    spec: { origin: 'NFR › V-plots', x0: -300, dx: 10, xLabel: 'bp from the NFR', yLabel: '', measures: 'callable openings of the run, 10 bp bins',
      matrix: { kind, x0: -300, dx: 10, valueLabel: signed ? 'A − B' : 'openings', ...(signed ? { signed: true } : {}) } },
    matrices: [{ id: 'all', title: 'All', rows: [{ label: '60', values: [0, 1.5, null] }, { label: '70', values: [2, -0.25, 3] }] }],
    locus: { chrom: 'chrT', start: 0, end: 600, genome: null },
  });
  it('keep their cells exactly in the card and its session copy', () => {
    useGalleryStore.setState(emptyGallery(), true);
    const id = openSuppliedPlot(mat(false, 'vplot'))!;
    const card = useGalleryStore.getState().entries.find(e => e.id === id)!;
    expect(card.supplied!.matrices).toEqual(mat(false, 'vplot').matrices);
    expect(normalizeGallery(JSON.parse(JSON.stringify(useGalleryStore.getState()))).entries.find(e => e.id === id)!.supplied!.matrices).toEqual(mat(false, 'vplot').matrices);
    expect(useGallerySeed.getState().suppliedSeed!.matrices).toEqual(mat(false, 'vplot').matrices);
  });
  it('follow the colormap rule (signed RdBu, V-plot viridis, heatmap magma), the pick winning', async () => {
    const { suppliedMatrixColormap } = await import('./supplied');
    expect(suppliedMatrixColormap(suppliedPlotSpec(mat(true, 'heatmap')))).toMatchObject({ name: 'rdbu_r', signed: true });
    expect(suppliedMatrixColormap(suppliedPlotSpec(mat(false, 'vplot'))).name).toBe('viridis');
    const heat = suppliedPlotSpec(mat(false, 'heatmap'));
    expect(suppliedMatrixColormap(heat).name).toBe('magma');
    expect(suppliedMatrixColormap({ ...heat, size: { ...heat.size, colormaps: { ...heat.size.colormaps, enrichment: { name: 'cividis', reverse: false } } } }).name).toBe('cividis');
  });
  it('draw as a heatmap with what they measure in the header; TSV keeps every cell', async () => {
    const { suppliedMatricesTsv } = await import('./supplied');
    const input = mat(false, 'heatmap');
    expect(suppliedMatricesTsv('m', input.spec, { series: [], matrices: input.matrices }).split('\n').slice(-3)).toEqual(['row\t-300\t-290\t-280', '60\t0\t1.5\tNA', '70\t2\t-0.25\t3']);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => { root.render(<SuppliedPlot plot={suppliedPlotSpec(input)} data={{ series: [], matrices: input.matrices }} width={600} />); });
    expect(container.querySelector('[data-testid="plots-supplied-matrix"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plots-supplied-measures"]')!.textContent).toContain('callable openings of the run');
    act(() => root.unmount());
    container.remove();
  });
});
