/**
 * The footprint size data hook the Plots size plots rest on (ported from the retired Clusters › Footprint sizes
 * view's tests): one all-reads request per view with each dataset once; per-cluster requests carry the assignments
 * and refetch when reads change cluster at the same count; all-reads plots are titled by dataset.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FOOTPRINT_SIZE_SETTINGS } from '../../../utils/footprintSizeSettings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchFootprintSizes: vi.fn() }));
vi.mock('../../../api/clustering', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/clustering')>()),
  fetchFootprintSizes: api.fetchFootprintSizes,
}));

import { footprintSizePlots, useFootprintSizeData, type FootprintSizesClusters, type FootprintSizesTarget } from './useFootprintSizeData';

const matrix = (n: number, value: number) => ({
  matrix: [[value, value], [null, value]], size_min: 10, size_max: 30, size_bin: 10, pos_bin: 10, mode: 'span',
  normalization: 'row', row_min_footprints: 20, sigma_size_bp: 10, sigma_pos_bp: 20, group_by: 'all',
  n_reads: n, n_footprints: n * 10,
});

const allReads: FootprintSizesTarget = {
  chrom: 'chrT', start: 1000, end: 1020, genome: null,
  panels: [
    { key: 'p1', datasetId: 'd1', label: 'Early', color: '#111111' },
    { key: 'p2', datasetId: 'd2', label: 'Late', color: '#222222' },
    // A second panel of the first dataset: shown once.
    { key: 'p3', datasetId: 'd1', label: 'Early', color: '#111111' },
  ],
};

function Harness({ target, clusters }: { target: FootprintSizesTarget; clusters?: FootprintSizesClusters | null }) {
  const useClusters = !!clusters;
  const { entry, requestKey } = useFootprintSizeData({ target: clusters ?? target, useClusters, clusters, settings: DEFAULT_FOOTPRINT_SIZE_SETTINGS, hideUncalled: true });
  const byPanel = entry?.key === requestKey ? entry.byPanel : null;
  const plots = footprintSizePlots(byPanel, (clusters ?? target).panels, useClusters, clusters?.visible ?? []);
  return <div>{plots.map(p => <div key={p.id} data-testid="plot">{p.title}|{p.data.n_reads}</div>)}</div>;
}

describe('useFootprintSizeData', () => {
  let container: HTMLDivElement;
  let root: Root;
  const titles = () => [...container.querySelectorAll('[data-testid="plot"]')].map(p => p.textContent);
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(400); }); };

  beforeEach(() => {
    vi.useFakeTimers();
    api.fetchFootprintSizes.mockReset().mockResolvedValue({ success: true, data: { d1: { '-1': matrix(1000, 2) }, d2: { '-1': matrix(200, 0.5) } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('all reads: one request for the view, each dataset once, one plot per dataset', async () => {
    act(() => root.render(<Harness target={allReads} />));
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
    const [chrom, start, end, opts] = api.fetchFootprintSizes.mock.calls[0];
    expect([chrom, start, end]).toEqual(['chrT', 1000, 1020]);
    expect(opts).toMatchObject({ groupBy: 'all', datasetIds: ['d1', 'd2'], mode: 'span', normalization: 'row' });
    expect(opts.clusterAssignments).toBeUndefined();
    expect(titles()).toEqual(['Early|1000', 'Late|200']);
  });

  it('per cluster: sends the assignments and refetches when reads change cluster at the same count', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { 0: matrix(50, 1), 1: matrix(60, 1) } } });
    const base = {
      chrom: 'chrT', start: 1000, end: 1020, genome: null,
      panels: [{ key: 'p1', datasetId: 'd1', label: 'Early' }],
      visible: [{ cluster: 0, color: '#a00', counts: [1], totalCount: 1 }, { cluster: 1, color: '#0a0', counts: [1], totalCount: 1 }],
    };
    const a = { ...base, rounds: [{ keyByDataset: { d1: 'p1' }, assignments: { d1: { r1: 0, r2: 1 } } }], assignmentSignature: 'sigA' } as unknown as FootprintSizesClusters;
    act(() => root.render(<Harness target={allReads} clusters={a} />));
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
    expect(api.fetchFootprintSizes.mock.calls[0][3]).toMatchObject({ groupBy: 'cluster', clusterAssignments: { d1: { r1: 0, r2: 1 } } });
    expect(titles()).toHaveLength(2);
    const b = { ...base, rounds: [{ keyByDataset: { d1: 'p1' }, assignments: { d1: { r1: 1, r2: 0 } } }], assignmentSignature: 'sigB' } as unknown as FootprintSizesClusters;
    act(() => root.render(<Harness target={allReads} clusters={b} />));
    await flush();
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(2);
    expect(api.fetchFootprintSizes.mock.calls[1][3].clusterAssignments).toEqual({ d1: { r1: 1, r2: 0 } });
  });

  it('titles all-reads plots by dataset, not by a split panel\'s group', async () => {
    const split: FootprintSizesTarget = { ...allReads, panels: [
      { key: 'p1:carriers', datasetId: 'd1', label: 'Early · Carriers', datasetLabel: 'Early', color: '#111111' },
      { key: 'p2', datasetId: 'd2', label: 'Late', datasetLabel: 'Late', color: '#222222' },
    ] };
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { '-1': matrix(1000, 2) }, d2: { '-1': matrix(200, 0.5) } } });
    act(() => root.render(<Harness target={split} />));
    await flush();
    expect(titles().map(t => t!.split('|')[0])).toEqual(['Early', 'Late']);
  });

  it('a dataset that fails fails the per-cluster plot: no partial result drawn as the whole (audit 3.1.1)', async () => {
    api.fetchFootprintSizes.mockResolvedValue({ success: true, data: { d1: { '0': matrix(10, 1) }, d2: { error: 'boom' } } });
    const c = { chrom: 'chrT', start: 1000, end: 1020, genome: null, panels: [allReads.panels[0], allReads.panels[1]], visible: [{ cluster: 0, color: '#f00' }],
      rounds: [{ keyByDataset: { d1: 'p1', d2: 'p2' }, assignments: { d1: { r1: 0 }, d2: { r2: 0 } } }], assignmentSignature: 'sigE' } as unknown as FootprintSizesClusters;
    act(() => root.render(<Harness target={allReads} clusters={c} />));
    await flush();
    expect(titles()).toEqual([]);
  });
});
