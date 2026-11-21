/**
 * Co-accessibility in Plots: the panel's endpoint per dataset (the second on the first's grid), the matrices drawn as
 * returned, A − B cell by cell (the panel's subtractCoacc), the colormap rule (signed RdBu, else magma, the pick
 * winning), and the Gallery card keeping the cells exactly so Open draws without a request.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ getCoaccMatrixData: vi.fn() }));
const scope = vi.hoisted(() => ({ byDataset: undefined as Record<string, string[]> | undefined }));
vi.mock('../../components/controls/co-accessibility/useCoaccScope', () => ({
  useCoaccScope: () => ({ effectiveReadIdsByDataset: scope.byDataset, effectiveReadIds: scope.byDataset ? Object.values(scope.byDataset).flat() : undefined }),
}));
vi.mock('../../api/coaccessibility', async importOriginal => ({ ...(await importOriginal<typeof import('../../api/coaccessibility')>()), getCoaccMatrixData: api.getCoaccMatrixData }));

import { CoaccPlot, coaccChart, coaccFigure, coaccFromSupplied, coaccRequestKey, coaccSupplied, coaccTsv, coverageText, maskedFraction, scaleCoaccMatrix, type CoaccEntry } from './CoaccPlot';
import { newPlot } from './plotModel';
import { subtractCoacc } from '../../utils/coaccDifference';

const md = (ds: string, m: (number | null)[][], bin = 100) => ({ matrix: m, coverage: [], chrom: 'chrT', start: 1000, end: 1000 + m.length * bin, bin_size: bin, n_bins: m.length, n_reads: ds === 'd1' ? 40 : 55, normalization: 'correlation', marginal_accessibility: [] });
const target = { chrom: 'chrT', start: 1000, end: 1300, genome: null, panels: [{ key: 'p1', datasetId: 'd1', label: 'Early' }, { key: 'p2', datasetId: 'd2', label: 'Late' }] };
const A = [[null, 0.5, -0.2], [0.5, null, 0.1], [-0.2, 0.1, null]];
const B = [[null, 0.25, 0.3], [0.25, null, null], [0.3, null, null]];

describe('co-accessibility figure', () => {
  const plot = newPlot({ type: 'co-accessibility' });
  const blocks = [{ id: 'd1', title: 'Early', data: md('d1', A) }, { id: 'd2', title: 'Late', data: md('d2', B) }];
  it('draws the matrices as returned; correlation is signed (RdBu), raw on magma, the pick wins', () => {
    const f = coaccFigure(plot, blocks);
    expect(f.blocks.map(b => b.matrix)).toEqual([A, B]);
    expect(coaccChart(plot, f, 600)!).toMatchObject({ colormap: 'rdbu_r', signed: true });
    const raw = { ...plot, coacc: { ...plot.coacc, normalization: 'raw' as const } };
    expect(coaccChart(raw, coaccFigure(raw, blocks), 600)!).toMatchObject({ colormap: 'magma', signed: false });
    const pick = { ...raw, size: { ...raw.size, colormaps: { ...raw.size.colormaps, enrichment: { name: 'cividis' as const, reverse: false } } } };
    expect(coaccChart(pick, coaccFigure(pick, blocks), 600)!.colormap).toBe('cividis');
  });
  it('A − B is the panel\'s cell-by-cell difference', () => {
    const f = coaccFigure({ ...plot, compare: 'diff' }, blocks);
    const d = subtractCoacc(blocks[0].data, blocks[1].data) as { matrix: (number | null)[][] };
    expect(f.signed).toBe(true);
    expect(f.blocks[0].matrix).toEqual(d.matrix);
    expect(f.blocks[0].title).toBe('Early − Late');
  });
  it('a card keeps the cells exactly and gives them back', () => {
    const entry: CoaccEntry = { key: 'k', locus: { chrom: 'chrT', start: 1000, end: 1300, genome: null }, blocks };
    const back = coaccFromSupplied('k', entry.locus, JSON.parse(JSON.stringify(coaccSupplied(entry))))!;
    expect(back.blocks.map(b => [b.data.matrix, b.data.bin_size, b.data.start, b.data.n_reads])).toEqual(blocks.map(b => [b.data.matrix, 100, 1000, b.data.n_reads]));
  });
});

describe('the plot', () => {
  it('asks per dataset (the second on the first\'s bins) and draws; a seed draws without a request', async () => {
    vi.useFakeTimers();
    api.getCoaccMatrixData.mockReset();
    api.getCoaccMatrixData.mockImplementation(async (_c: string, _s: number, _e: number, o: { datasetIds: string[]; binSize?: number }) => md(o.datasetIds[0], o.datasetIds[0] === 'd1' ? A : B, o.binSize ?? 100));
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root = createRoot(container);
    const plot = newPlot({ type: 'co-accessibility' });
    const onResult = vi.fn();
    act(() => { root.render(<CoaccPlot plot={plot} target={target} pending={false} width={600} sampleSeed="s" settingsKey="[1]" onResult={onResult} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.getCoaccMatrixData.mock.calls.map(c => [c[3].datasetIds, c[3].binSize, c[3].normalization, c[3].minCoverage])).toEqual([[['d1'], undefined, 'correlation', 20], [['d2'], 100, 'correlation', 20]]);
    const el = container.querySelector('[data-testid="plots-coacc-plot"]')!;
    expect([el.getAttribute('data-state'), el.getAttribute('data-blocks'), el.getAttribute('data-signed')]).toEqual(['current', '2', 'true']);
    expect(onResult).toHaveBeenCalledTimes(1);
    const r = onResult.mock.calls[0][0];
    act(() => root.unmount());
    api.getCoaccMatrixData.mockReset();
    root = createRoot(container);
    // Recorded under an older refresh generation: still answers.
    const seed = coaccFromSupplied(coaccRequestKey(plot, target, 's', '[0]'), r.entry.locus, r.supplied)!;
    act(() => { root.render(<CoaccPlot plot={plot} target={target} pending={false} width={600} sampleSeed="s" settingsKey="[1]" seed={seed} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.getCoaccMatrixData).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="plots-coacc-plot"]')!.getAttribute('data-seeded')).toBe('true');
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
});

describe('the panel\'s controls in Plots (parity)', () => {
  it('log and sqrt scaling as the panel drew them: pseudocount the smallest positive value, negatives at the low end', () => {
    const m = [[null, 0.5, -0.2], [0.5, 2, 0]];
    const log = scaleCoaccMatrix(m, 'log');
    expect(log[0][0]).toBeNull();
    expect(log[0][1]).toBeCloseTo(Math.log(0.5 + 0.5));
    expect(log[0][2]).toBeCloseTo(Math.log(0 + 0.5));
    expect(log[1][1]).toBeCloseTo(Math.log(2.5));
    expect(scaleCoaccMatrix(m, 'sqrt')[1][1]).toBeCloseTo(Math.SQRT2);
    expect(scaleCoaccMatrix(m, 'sqrt')[0][2]).toBe(0);
    expect(scaleCoaccMatrix(m, 'linear')).toBe(m);
    // Scaled signed values are no longer centred on 0.
    const plot = newPlot({ type: 'co-accessibility', coacc: { ...newPlot().coacc, scaling: 'log' } });
    expect(coaccChart(plot, coaccFigure(plot, [{ id: 'd1', title: 'Early', data: md('d1', A) }]), 600)!.signed).toBe(false);
  });
  it('the run summary\'s numbers: masked share and coverage range; TSV bin by bin with NA blanks', () => {
    expect(maskedFraction(A)).toBeCloseTo(3 / 9);
    expect(coverageText([[null, 3, 40], [40, 120, null]])).toBe('coverage 3–120 (median 40) · ');
    const tsv = coaccTsv([{ id: 'd1', title: 'Early', data: md('d1', A) }]).split('\n');
    expect(tsv[0]).toBe('# Early · correlation · 40 reads');
    expect(tsv[1]).toBe('bin\tchrT:1000-1100\tchrT:1100-1200\tchrT:1200-1300');
    expect(tsv[2]).toBe('chrT:1000-1100\tNA\t0.5\t-0.2');
  });
  it('asks with the layer and the panels\' read scope (cluster focus / read filter) per dataset; scaling never asks again', async () => {
    vi.useFakeTimers();
    api.getCoaccMatrixData.mockReset();
    api.getCoaccMatrixData.mockImplementation(async (_c: string, _s: number, _e: number, o: { datasetIds: string[]; binSize?: number }) => md(o.datasetIds[0], A, o.binSize ?? 100));
    scope.byDataset = { d1: ['r1', 'r2'] };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const plot = newPlot({ type: 'co-accessibility', coacc: { ...newPlot().coacc, layer: 'nuc' } });
    act(() => { root.render(<CoaccPlot plot={plot} target={target} pending={false} width={600} sampleSeed="s" settingsKey="[1]" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const calls = api.getCoaccMatrixData.mock.calls.map(c => c[3]);
    expect(calls.map(o => [o.datasetIds, o.layer, o.readIdsByDataset])).toEqual([[['d1'], 'nuc', { d1: ['r1', 'r2'] }], [['d2'], 'nuc', undefined]]);
    expect(container.querySelector('[data-testid="plots-coacc-summary"]')!.textContent).toContain('read filter / cluster focus applied');
    for (const id of ['plots-coacc-refresh', 'plots-coacc-export-json', 'plots-coacc-export-tsv', 'plots-coacc-copy-python']) expect(container.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    // Display scaling: no new request.
    act(() => { root.render(<CoaccPlot plot={{ ...plot, coacc: { ...plot.coacc, scaling: 'sqrt' } }} target={target} pending={false} width={600} sampleSeed="s" settingsKey="[1]" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.getCoaccMatrixData).toHaveBeenCalledTimes(2);
    // Refresh asks again.
    act(() => { (container.querySelector('[data-testid="plots-coacc-refresh"]') as HTMLButtonElement).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.getCoaccMatrixData).toHaveBeenCalledTimes(4);
    scope.byDataset = undefined;
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
});
