/**
 * The size plot's stale-state guard on screen: current numbers only for the locus they were computed for; while the
 * view moves (pending) or a recompute runs, the old panels are greyed, counts read "—", the header says "Updating…"
 * with the locus wanted; a late answer for a left locus is dropped.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchFootprintSizes: vi.fn() }));
vi.mock('../../api/clustering', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/clustering')>()),
  fetchFootprintSizes: api.fetchFootprintSizes,
}));
vi.mock('../../components/charts/SizeEnrichmentChart', () => ({
  drawSizeEnrichment: () => {},
  SizeEnrichmentChart: ({ title, subtitle, testId }: { title: string; subtitle: string; testId: string }) => (
    <div data-testid={testId}>{title}|{subtitle}</div>
  ),
}));

import { SizePlot } from './SizePlot';
import { newPlot } from './plotModel';

const matrix = (n: number) => ({
  matrix: [[1, 2], [null, 1]], size_min: 10, size_max: 30, size_bin: 10, pos_bin: 10, mode: 'span', normalization: 'row',
  row_min_footprints: 20, sigma_size_bp: 10, sigma_pos_bp: 20, group_by: 'all', n_reads: n, n_footprints: n * 10,
});
const target = (start: number) => ({ chrom: 'chrT', start, end: start + 20, genome: null, panels: [{ key: 'p1', datasetId: 'd1', label: 'Early' }] });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('SizePlot stale-state guard', () => {
  let container: HTMLDivElement;
  let root: Root;
  const plot = newPlot();
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const state = () => q('plots-size-plot')!.getAttribute('data-state');
  const flush = async (ms = 200) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const render = (start: number, pending = false, wanted: { chrom: string; start: number; end: number } | null = null) =>
    act(() => { root.render(<SizePlot plot={plot} target={target(start)} clusters={null} pending={pending} width={600} wanted={wanted} />); });

  beforeEach(() => {
    vi.useFakeTimers();
    api.fetchFootprintSizes.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

  it('shows numbers as current only for their locus; greys them with "—" while the view moves', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { '-1': matrix(100) } } });
    render(1000);
    await flush();
    expect(state()).toBe('current');
    expect(q('plots-computed-for')!.textContent).toContain('chrT:1,001–1,020');
    expect(q('plots-count')!.textContent).toContain('100 reads');
    expect(q('plots-size-panel')!.textContent).toContain('100 reads · 1,000 footprints');

    // The browser moved; the plot waits for it to settle (Follow).
    render(1000, true, { chrom: 'chrT', start: 2000, end: 2020 });
    expect(state()).toBe('updating');
    expect(q('plots-updating')!.textContent).toContain('chrT:2,001–2,020');
    expect(q('plots-computed-for')).toBeNull();
    expect(q('plots-count')!.textContent).toContain('— reads');
    expect(q('plots-count')!.textContent).not.toContain('100');
    expect(q('plots-size-panel')!.textContent).toContain('— reads · — footprints');
    expect(q('plots-size-panels')!.className).toContain('opacity-40');
    // No request while waiting.
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
  });

  it('drops a late answer for a locus the plot has left', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    api.fetchFootprintSizes.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(1000);
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
    render(5000);
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(2);
    // The answer for 1000 arrives after the plot moved to 5000: never shown.
    await act(async () => { first.resolve({ success: true, data: { d1: { '-1': matrix(111) } } }); });
    await flush();
    expect(state()).toBe('updating');
    expect(container.textContent).not.toContain('111 reads');
    await act(async () => { second.resolve({ success: true, data: { d1: { '-1': matrix(222) } } }); });
    await flush();
    expect(state()).toBe('current');
    expect(q('plots-computed-for')!.textContent).toContain('chrT:5,001–5,020');
    expect(q('plots-count')!.textContent).toContain('222 reads');
  });

  it('grouped by cluster with no clusters here: says so, requests nothing, never shows datasets instead', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { '-1': matrix(100) } } });
    act(() => { root.render(<SizePlot plot={newPlot({ groupBy: 'cluster' })} target={target(1000)} clusters={null} pending={false} width={600} />); });
    await flush();
    expect(state()).toBe('no-clusters');
    expect(q('plots-no-clusters')!.textContent).toContain('No clusters at chrT:1,001–1,020');
    expect(q('plots-size-panel')).toBeNull();
    expect(api.fetchFootprintSizes).not.toHaveBeenCalled();
  });

  it('hands each current result to the Gallery once; a stored result is drawn without a request and not repeated', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { '-1': matrix(100) } } });
    const onResult = vi.fn();
    act(() => { root.render(<SizePlot plot={plot} target={target(1000)} clusters={null} pending={false} width={600} onResult={onResult} />); });
    await flush();
    expect(onResult).toHaveBeenCalledTimes(1);
    const { entry, items } = onResult.mock.calls[0][0];
    expect(items).toEqual([{ id: 'p1|all', title: 'Early', color: undefined }]);
    act(() => { root.render(<SizePlot plot={plot} target={target(1000)} clusters={null} pending={false} width={600} onResult={onResult} />); });
    await flush();
    expect(onResult).toHaveBeenCalledTimes(1);
    // A fresh view seeded with that result: drawn at once, no request, not reported again.
    act(() => root.unmount());
    root = createRoot(container);
    api.fetchFootprintSizes.mockClear();
    const seeded = { ...entry, seeded: true };
    act(() => { root.render(<SizePlot plot={plot} target={target(1000)} clusters={null} pending={false} width={600} onResult={onResult} seed={seeded} />); });
    await flush();
    expect(state()).toBe('current');
    expect(api.fetchFootprintSizes).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(q('plots-computed-for')!.textContent).toContain('From the Gallery');
  });

  it('a stored result still answers a request that differs only by the refresh generation', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { '-1': matrix(100) } } });
    const onResult = vi.fn();
    act(() => { root.render(<SizePlot plot={plot} target={target(1000)} clusters={null} pending={false} width={600} settingsKey={'[3,false,80,[]]'} onResult={onResult} />); });
    await flush();
    const { entry } = onResult.mock.calls[0][0];
    act(() => root.unmount());
    root = createRoot(container);
    api.fetchFootprintSizes.mockClear();
    act(() => { root.render(<SizePlot plot={plot} target={target(1000)} clusters={null} pending={false} width={600} settingsKey={'[4,false,80,[]]'} seed={{ ...entry, seeded: true }} />); });
    await flush();
    expect(state()).toBe('current');
    expect(api.fetchFootprintSizes).not.toHaveBeenCalled();
    // Other quality filters: recomputed.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => { root.render(<SizePlot plot={plot} target={target(1000)} clusters={null} pending={false} width={600} settingsKey={'[4,true,80,[]]'} seed={{ ...entry, seeded: true }} />); });
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
  });

  it('a pinned plot (no pending) keeps its locus and makes no new request when re-rendered', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { '-1': matrix(100) } } });
    render(1000);
    await flush();
    render(1000);
    await flush(2000);
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
    expect(state()).toBe('current');
  });

  it('a comparison that comes back with one group (sampling) is never drawn as the plot (audit 3.1.1)', async () => {
    // Two datasets compared (counts requested); only one answers with footprints.
    const two = { chrom: 'chrT', start: 1000, end: 1020, genome: null, panels: [{ key: 'p1', datasetId: 'd1', label: 'Early' }, { key: 'p2', datasetId: 'd2', label: 'Late' }] };
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { '-1': { ...matrix(1), normalization: 'raw' } } } });
    const cmp = newPlot({ type: 'size-enrichment', compare: 'diff' });
    act(() => { root.render(<SizePlot plot={cmp} target={two} clusters={null} pending={false} width={600} wanted={null} />); });
    await flush();
    expect(q('plots-size-one-group')).not.toBeNull();
    expect(q('plots-size-panel')).toBeNull();
  });
});
