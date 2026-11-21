/**
 * Clusters › Footprint sizes: with no clusters, one plot per dataset from all reads (one request, group_by 'all',
 * the panels' datasets); the view choice, the per-axis Gaussian sigmas in bp and the normalisation are settings that
 * go into the request; the read-count note, the log2 ratio and the TSV export.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { DEFAULT_FOOTPRINT_SIZE_SETTINGS } from '../../../utils/footprintSizeSettings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchFootprintSizes: vi.fn() }));
vi.mock('../../../api/clustering', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/clustering')>()),
  fetchFootprintSizes: api.fetchFootprintSizes,
}));
const download = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/analysisExport', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../utils/analysisExport')>()),
  downloadTextFile: download,
}));
vi.mock('../../charts/SizeEnrichmentChart', () => ({
  SizeEnrichmentChart: ({ title, subtitle, scale, testId }: { title: string; subtitle: string; scale: { kind: string; colormap?: string; reverse?: boolean }; testId: string }) => (
    <div data-testid={testId} data-scale={scale.kind} data-colormap={scale.colormap} data-reverse={String(!!scale.reverse)}>{title}|{subtitle}</div>
  ),
}));

import { FootprintSizesView } from './FootprintSizesView';

const matrix = (n: number, value: number) => ({
  matrix: [[value, value], [null, value]], size_min: 10, size_max: 30, size_bin: 10, pos_bin: 10, mode: 'span',
  normalization: 'row', row_min_footprints: 20, sigma_size_bp: 10, sigma_pos_bp: 20, group_by: 'all',
  n_reads: n, n_footprints: n * 10,
});

const allReads = {
  chrom: 'chrT', start: 1000, end: 1020, genome: null,
  panels: [
    { key: 'p1', datasetId: 'd1', label: 'Early', color: '#111111' },
    { key: 'p2', datasetId: 'd2', label: 'Late', color: '#222222' },
    // A second panel of the first dataset: shown once.
    { key: 'p3', datasetId: 'd1', label: 'Early', color: '#111111' },
  ],
};

describe('FootprintSizesView', () => {
  let container: HTMLDivElement;
  let root: Root;
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(400); }); };

  beforeEach(() => {
    vi.useFakeTimers();
    useBrowserStore.setState({ footprintSizeSettings: DEFAULT_FOOTPRINT_SIZE_SETTINGS } as never);
    api.fetchFootprintSizes.mockReset().mockResolvedValue({ success: true, data: { d1: { '-1': matrix(1000, 2) }, d2: { '-1': matrix(200, 0.5) } } });
    download.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('plots each dataset from all its reads with no clusters, side by side on one diverging scale', async () => {
    act(() => root.render(<FootprintSizesView allReads={allReads} clusters={null} chartWidth={800} />));
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
    const [chrom, start, end, opts] = api.fetchFootprintSizes.mock.calls[0];
    expect([chrom, start, end]).toEqual(['chrT', 1000, 1020]);
    expect(opts).toMatchObject({ groupBy: 'all', datasetIds: ['d1', 'd2'], mode: 'span', normalization: 'row', minFootprints: 20 });
    expect(opts.clusterAssignments).toBeUndefined();
    const plots = [...container.querySelectorAll('[data-testid="footprint-sizes-plot"]')];
    expect(plots.map(p => p.textContent)).toEqual(['Early|1,000 reads · 10,000 footprints', 'Late|200 reads · 2,000 footprints']);
    expect(plots.every(p => p.getAttribute('data-scale') === 'diverging')).toBe(true);
    expect(q('footprint-sizes')?.getAttribute('data-view')).toBe('enrichment');
    // No Per cluster / Per dataset choice without clusters.
    expect(q('footprint-sizes-group')).toBeNull();
    // 1,000 against 200 reads: said.
    expect(q('footprint-sizes-density-note')?.textContent).toMatch(/5\.0-fold/);
  });

  it('switches views in one click and sends the Gaussian sigmas in bp per axis', async () => {
    act(() => root.render(<FootprintSizesView allReads={allReads} clusters={null} chartWidth={800} />));
    await flush();
    act(() => (q('footprint-sizes-view-vplot') as HTMLButtonElement).click());
    expect(useBrowserStore.getState().footprintSizeSettings).toMatchObject({ view: 'vplot', mode: 'midpoint', normalization: 'raw' });
    expect(q('footprint-sizes-view-vplot')?.getAttribute('aria-pressed')).toBe('true');
    await flush();
    expect(api.fetchFootprintSizes.mock.calls.at(-1)![3]).toMatchObject({ mode: 'midpoint', normalization: 'raw' });
    expect(container.querySelector('[data-testid="footprint-sizes-plot"]')?.getAttribute('data-scale')).toBe('sequential');

    const setInput = (id: string, value: string) => {
      const input = q(id) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    setInput('footprint-sizes-sigma-size', '0');
    setInput('footprint-sizes-sigma-pos', '45');
    await flush();
    expect(api.fetchFootprintSizes.mock.calls.at(-1)![3]).toMatchObject({ sigmaSizeBp: 0, sigmaPosBp: 45 });
    // Both sigma controls sit side by side, in bp.
    expect(q('footprint-sizes-gaussian')?.textContent).toMatch(/Gaussian σ\s*size\s*bp\s*position\s*bp/);

    act(() => (q('footprint-sizes-view-enrichment') as HTMLButtonElement).click());
    expect(useBrowserStore.getState().footprintSizeSettings).toMatchObject({ view: 'enrichment', mode: 'span', normalization: 'row' });
  });

  it('adds a log2 ratio of two plots and exports every matrix as TSV with its settings', async () => {
    act(() => root.render(<FootprintSizesView allReads={allReads} clusters={null} chartWidth={800} />));
    await flush();
    act(() => (q('footprint-sizes-ratio-toggle') as HTMLInputElement).click());
    expect(useBrowserStore.getState().footprintSizeSettings.ratio).toEqual(['p1|all', 'p2|all']);
    expect(q('footprint-sizes-ratio')?.textContent).toMatch(/^Early \/ Late\|log2 ratio of enrichment/);
    act(() => (q('footprint-sizes-export-tsv') as HTMLButtonElement).click());
    expect(download).toHaveBeenCalledTimes(1);
    const [text, name] = download.mock.calls[0];
    expect(name).toBe('footprint_size_enrichment_chrT_1001-1020.tsv');
    expect(text).toMatch(/# FiberBrowser footprint size plot: Early/);
    expect(text).toMatch(/# FiberBrowser footprint size plot: Late/);
    expect(text).toMatch(/# FiberBrowser footprint size plot: log2 ratio Early \/ Late/);
    expect(text).toMatch(/# gaussian_sigma_position_bp: 20/);
  });

  it('single plots default to magma (V-plot: viridis), the log2 ratio to RdBu; each keeps its pick; no refetch', async () => {
    act(() => root.render(<FootprintSizesView allReads={allReads} clusters={null} chartWidth={800} />));
    await flush();
    const calls = api.fetchFootprintSizes.mock.calls.length;
    const plots = () => [...container.querySelectorAll('[data-testid="footprint-sizes-plot"]')];
    expect(plots().every(p => p.getAttribute('data-colormap') === 'magma')).toBe(true);
    const more = [...container.querySelectorAll('button[aria-expanded]')].find(b => /More settings/.test(b.textContent ?? '')) as HTMLButtonElement;
    act(() => more.click());
    const select = () => q('footprint-sizes-colormap')!.querySelector('select') as HTMLSelectElement;
    expect([...select().options].map(o => o.value)).toEqual(['magma', 'viridis', 'inferno', 'plasma', 'cividis', 'greys', 'rdbu_r', 'fall', 'hot', 'red', 'blues']);
    expect(select().value).toBe('magma');
    act(() => { select().value = 'cividis'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => (q('footprint-sizes-colormap-reverse') as HTMLInputElement).click());
    expect(useBrowserStore.getState().footprintSizeSettings.colormaps.enrichment).toEqual({ name: 'cividis', reverse: true });
    expect(plots().every(p => p.getAttribute('data-colormap') === 'cividis' && p.getAttribute('data-reverse') === 'true')).toBe(true);
    // The log2 ratio: a comparison, RdBu by default, with its own picker.
    act(() => (q('footprint-sizes-ratio-toggle') as HTMLInputElement).click());
    expect(q('footprint-sizes-ratio')?.getAttribute('data-colormap')).toBe('rdbu_r');
    const ratioSelect = q('footprint-sizes-ratio-colormap')!.querySelector('select') as HTMLSelectElement;
    expect(ratioSelect.value).toBe('rdbu_r');
    act(() => { ratioSelect.value = 'plasma'; ratioSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(q('footprint-sizes-ratio')?.getAttribute('data-colormap')).toBe('plasma');
    expect(plots().every(p => p.getAttribute('data-colormap') === 'cividis')).toBe(true);
    await flush();
    expect(api.fetchFootprintSizes.mock.calls.length).toBe(calls);  // display only
    act(() => (q('footprint-sizes-export-tsv') as HTMLButtonElement).click());
    expect(download.mock.calls[0][0]).toMatch(/# colormap: cividis \(sequential\), reversed/);
    expect(download.mock.calls[0][0]).toMatch(/# colormap: plasma \(sequential\)/);
    // V-plot: its own default, viridis; back to Size enrichment restores the pick.
    act(() => (q('footprint-sizes-view-vplot') as HTMLButtonElement).click());
    await flush();
    expect(select().value).toBe('viridis');
    expect(plots().every(p => p.getAttribute('data-colormap') === 'viridis' && p.getAttribute('data-reverse') === 'false')).toBe(true);
    act(() => (q('footprint-sizes-view-enrichment') as HTMLButtonElement).click());
    await flush();
    expect(select().value).toBe('cividis');
  });

  it('the Layer choices are All footprints plus the loaded layers; choosing one refetches with its key', async () => {
    useBrowserStore.setState({ datasets: [{ id: 'd1', label: 'Early', available_layers: { nuc: true, tf: true, fire: true, m6a: true } }] } as never);
    act(() => root.render(<FootprintSizesView allReads={allReads} clusters={null} chartWidth={800} />));
    await flush();
    const more = [...container.querySelectorAll('button[aria-expanded]')].find(b => /More settings/.test(b.textContent ?? '')) as HTMLButtonElement;
    act(() => more.click());
    const chips = [...q('footprint-sizes-layer')!.querySelectorAll('button[data-layer]')] as HTMLButtonElement[];
    expect(chips.map(b => b.dataset.layer)).toEqual(['all_footprints', 'nuc', 'fire', 'tf']);
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');
    expect(chips.map(b => b.textContent)).not.toContain('HMM calls (ns/nl)');
    act(() => chips[1].click());
    expect(useBrowserStore.getState().footprintSizeSettings.layer).toBe('nuc');
    await flush();
    expect(api.fetchFootprintSizes.mock.calls.at(-1)![3]).toMatchObject({ layer: 'nuc' });
  });

  it('with clusters: one plot per cluster by default, or per dataset from all reads', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { 0: matrix(50, 1), 1: matrix(60, 1) } } });
    const clusters = {
      chrom: 'chrT', start: 1000, end: 1020, genome: null,
      panels: [{ key: 'p1', datasetId: 'd1', label: 'Early' }],
      rounds: [{ keyByDataset: { d1: 'p1' }, assignments: { d1: { r1: 0, r2: 1 } } }],
      visible: [{ cluster: 0, color: '#a00', counts: [1], totalCount: 1 }, { cluster: 1, color: '#0a0', counts: [1], totalCount: 1 }],
    };
    act(() => root.render(<FootprintSizesView allReads={allReads} clusters={clusters} chartWidth={800} />));
    await flush();
    expect(api.fetchFootprintSizes.mock.calls[0][3]).toMatchObject({ groupBy: 'cluster', clusterAssignments: { d1: { r1: 0, r2: 1 } } });
    expect(container.querySelectorAll('[data-testid="footprint-sizes-plot"]').length).toBe(2);
    expect(q('footprint-sizes')?.getAttribute('data-group')).toBe('clusters');
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { '-1': matrix(1000, 2) }, d2: { '-1': matrix(900, 2) } } });
    act(() => (q('footprint-sizes-group-datasets') as HTMLButtonElement).click());
    await flush();
    expect(api.fetchFootprintSizes.mock.calls.at(-1)![3]).toMatchObject({ groupBy: 'all' });
    expect(container.querySelectorAll('[data-testid="footprint-sizes-plot"]').length).toBe(2);
    expect(q('footprint-sizes-density-note')).toBeNull();
  });

  it('refetches per-cluster plots when reads change cluster at the same count (merge, branch switch)', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { 0: matrix(50, 1), 1: matrix(60, 1) } } });
    const base = {
      chrom: 'chrT', start: 1000, end: 1020, genome: null,
      panels: [{ key: 'p1', datasetId: 'd1', label: 'Early' }],
      visible: [{ cluster: 0, color: '#a00', counts: [1], totalCount: 1 }, { cluster: 1, color: '#0a0', counts: [1], totalCount: 1 }],
    };
    const a = { ...base, rounds: [{ keyByDataset: { d1: 'p1' }, assignments: { d1: { r1: 0, r2: 1 } } }], assignmentSignature: 'sigA' };
    act(() => root.render(<FootprintSizesView allReads={allReads} clusters={a} chartWidth={800} />));
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
    const b = { ...base, rounds: [{ keyByDataset: { d1: 'p1' }, assignments: { d1: { r1: 1, r2: 0 } } }], assignmentSignature: 'sigB' };
    act(() => root.render(<FootprintSizesView allReads={allReads} clusters={b} chartWidth={800} />));
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(2);
    expect(api.fetchFootprintSizes.mock.calls[1][3].clusterAssignments).toEqual({ d1: { r1: 1, r2: 0 } });
  });

  it('titles all-reads plots by dataset, not by a split panel\'s group', async () => {
    const split = { ...allReads, panels: [
      { key: 'p1:carriers', datasetId: 'd1', label: 'Early · Carriers', datasetLabel: 'Early', color: '#111111' },
      { key: 'p2', datasetId: 'd2', label: 'Late', datasetLabel: 'Late', color: '#222222' },
    ] };
    act(() => root.render(<FootprintSizesView allReads={split} clusters={null} chartWidth={800} />));
    await flush();
    const titles = [...container.querySelectorAll('[data-testid="footprint-sizes-plot"]')].map(p => p.textContent!.split('|')[0]);
    expect(titles).toEqual(['Early', 'Late']);
  });
});
