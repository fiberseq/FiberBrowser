import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchClusterProjection: vi.fn(),
  fetchClusterVPlot: vi.fn(),
  dissolveCluster: vi.fn(),
  autoCullClusters: vi.fn(),
}));
vi.mock('../../api/clustering', async (orig) => ({ ...(await orig<typeof import('../../api/clustering')>()), ...api }));

import { useBrowserStore } from '../../stores/browserStore';
import { ClusterDetailPanel } from './ClusterDetailPanel';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Stabilize 3, item 2: the Clusters panel's Delete and Merge similar clusters clear a focus on the clusters they
 * remove; that focus change recorded a step of its own before the action's, so one Undo left the new clusters in
 * place. Each is one undo step.
 */
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  api.fetchClusterProjection.mockReset().mockResolvedValue({ coords_x: [], coords_y: [], read_ids: [], dataset_ids: [], labels_before: [],
    labels_after: null, cluster_centroids_before: {}, cluster_centroids_after: null, dissolved: [], method: 'pca',
    variance_explained: null, feature_dim: 1, n_reads: 0 });
  api.fetchClusterVPlot.mockReset().mockResolvedValue({ success: true, data: {} });
  api.dissolveCluster.mockReset().mockResolvedValue({ results: { ds1: { assignments: { a: 0, b: 0, c: 2, d: 2 } } } });
  api.autoCullClusters.mockReset().mockResolvedValue({ results: { ds1: { assignments: { a: 0, b: 0, c: 2, d: 2 } } },
    dissolved: [{ cluster: 1, count: 1, reason: 'low abundance' }] });
  useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  useBrowserStore.setState({
    chrom: 'chr1', start: 1000, end: 2000, selectedDatasets: new Set(),
    datasets: [{ id: 'ds1', label: 'One', path: '/d/one.bam', color: '#000', data_type: 'bam' }] as never,
    panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 } as PanelConfig],
    clusterAssignments: { ds1: { a: 0, b: 1, c: 2, d: 2 } },
    clusterOrder: { ds1: [0, 1, 2] },
    clusterFocus: { ds1: new Set([1, 2]) },
    clusterPeakRegions: [{ start: 1100, end: 1200, mode: 'accessibility' }],
    _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0,
  } as never);
  useBrowserStore.getState().pushSnapshot('Cluster reads', { kind: 'clustering' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
// (A "Before …" baseline is the panel's own checkpoint of changes since the last step: opening it, picking a cluster.)
const labels = () => useBrowserStore.getState()._historyStack.map(x => x.label).filter(l => !l.startsWith('Before '));

describe('Clusters panel actions are one undo step (stabilize 3, item 2)', () => {
  it('Merge similar clusters', async () => {
    await act(async () => { root.render(<ClusterDetailPanel />); });
    const merge = button('Merge similar clusters');
    expect(merge).toBeTruthy();
    await act(async () => { merge!.click(); });
    expect(api.autoCullClusters).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual(['Cluster reads', 'Merge similar clusters']);
    useBrowserStore.getState().undo();
    const s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds1).toEqual({ a: 0, b: 1, c: 2, d: 2 });
    expect([...(s.clusterFocus.ds1 ?? [])].sort()).toEqual([1, 2]);
  });

  it('Delete (dissolve) of a focused cluster', async () => {
    await act(async () => { root.render(<ClusterDetailPanel />); });
    act(() => { useBrowserStore.getState().toggleClusterSelection('ds1', 1); });
    const del = button('Delete');
    expect(del).toBeTruthy();
    expect(del!.disabled).toBe(false);
    await act(async () => { del!.click(); });
    expect(api.dissolveCluster).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual(['Cluster reads', 'Dissolve cluster 1']);
    useBrowserStore.getState().undo();
    const s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds1).toEqual({ a: 0, b: 1, c: 2, d: 2 });
    expect([...(s.clusterFocus.ds1 ?? [])].sort()).toEqual([1, 2]);
  });
});
