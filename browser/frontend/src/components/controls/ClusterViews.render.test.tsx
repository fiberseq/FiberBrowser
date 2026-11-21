import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchClusterProjection: vi.fn(),
  fetchClusterVPlot: vi.fn(),
  fetchClusterMolecules: vi.fn(),
}));
vi.mock('../../api/clustering', async (orig) => ({ ...(await orig<typeof import('../../api/clustering')>()), ...api }));

import { useBrowserStore } from '../../stores/browserStore';
import { DEFAULT_CLUSTER_VIEW_SETTINGS } from '../../utils/clusterViewSettings';
import { ClusterDetailPanel } from './ClusterDetailPanel';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Cluster views: the metaprofile channel and the map's colour switch the display only; the map's features
 * refetch the map alone. */

const fills = new Map<HTMLCanvasElement, string[]>();
function fakeContext(canvas: HTMLCanvasElement) {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'canvas') return canvas;
      if (prop === 'arc') return (_x: number, _y: number, r: number) => { if (r === 3) fills.get(canvas)!.push(String(target.fillStyle)); };
      if (prop === 'clearRect') return () => { fills.set(canvas, []); };
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000000', data_type: 'bam', available_layers: { nuc: true, tf: true, m6a: true } });
const panel = (id: string, datasetId: string) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }) as PanelConfig;
const projection = {
  coords_x: [0, 0.1, 5, 10], coords_y: [0, 0.2, 5, 10], read_ids: ['r1', 'r2', 'r3', 'r4'], dataset_ids: ['napa', 'napa', 'napa', 'napa'],
  labels_before: [0, 0, 1, 2], labels_after: null, cluster_centroids_before: {}, cluster_centroids_after: null, dissolved: [],
  method: 'tsne', variance_explained: null, feature_dim: 2, n_reads: 4,
};
const prof = (v: number) => Array.from({ length: 10 }, (_, i) => v * (i + 1) / 10);
// The molecules' summaries (from /api/cluster_molecules, not the read panels): four densities, four nuc shares.
const molecules = (position?: number | null) => ({
  layers: ['nuc', 'tf'], position: position ?? null,
  molecules: { napa: Object.fromEntries(['r1', 'r2', 'r3', 'r4'].map((id, i) => [id, {
    span: 1000 * (i + 1), m6a: (i + 1) * 10, m6a_per_kb: (i + 1) * 10, frac: { nuc: 0.2 * (i + 1), tf: 0.05 },
    ...(position != null ? { state: ['nuc', 'tf', 'linker', null][i] } : {}),
  }])) },
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* none */ }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!fills.has(this)) fills.set(this, []);
    return fakeContext(this) as never;
  });
  api.fetchClusterProjection.mockReset().mockResolvedValue(projection);
  api.fetchClusterVPlot.mockReset().mockResolvedValue({ success: true, data: {} });
  api.fetchClusterMolecules.mockReset().mockImplementation(async (...args: any[]) => molecules(args[5]?.position));
  useBrowserStore.setState({
    chrom: 'chr2R', start: 9_969_319, end: 9_989_319,
    navigationMode: 'linked', selectedDatasets: new Set(),
    datasets: [ds('napa')] as never,
    panels: [panel('p1', 'napa')],
    clusterAssignments: { napa: { r1: 0, r2: 0, r3: 1, r4: 2 } },
    clusterOrder: { napa: [0, 1, 2] },
    clusterFocus: {},
    selectedClusters: {},
    clusterMergeLog: null,
    clusterPeakRegions: [{ start: 9_975_000, end: 9_975_400, mode: 'accessibility' }],
    enabledMetaProfiles: { nuc: true },
    clusterProfiles: { napa: { 0: { nuc: prof(1), tf: prof(0.2) }, 1: { nuc: prof(0.5), tf: prof(0.4) }, 2: { nuc: prof(0.2), tf: prof(0.1) } } },
    clusterViewSettings: DEFAULT_CLUSTER_VIEW_SETTINGS,
  } as never);
  // No reads in the panels (as in full view): the map's colours don't need them.
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function openOverview(tab: 'overview' | 'projection' = 'overview') {
  await act(async () => { root.render(<ClusterDetailPanel />); });
  await act(async () => { window.dispatchEvent(new CustomEvent('fiberbrowser:open-cluster-detail-tab', { detail: { tab } })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
}
const mapDots = () => {
  const el = host.querySelector('[data-testid="projection-map-canvas"]') as HTMLCanvasElement | null;
  return el ? fills.get(el) ?? [] : [];
};

describe('Cluster views', () => {
  it('switch the metaprofile channel without re-clustering or refetching the map', async () => {
    await openOverview();
    const picker = host.querySelector('[data-testid="cluster-profile-channels"]');
    expect(picker).not.toBeNull();
    expect(host.querySelector('[data-testid="cluster-profile-channel-default"]')?.getAttribute('aria-pressed')).toBe('true');
    const options = [...host.querySelectorAll('[data-testid^="cluster-profile-channel-"]')].map(b => b.getAttribute('data-testid'));
    expect(options).toEqual(expect.arrayContaining(['cluster-profile-channel-nuc', 'cluster-profile-channel-tf', 'cluster-profile-channel-nucreg.score']));
    const calls = api.fetchClusterProjection.mock.calls.length;
    const assignments = useBrowserStore.getState().clusterAssignments;
    await act(async () => { (host.querySelector('[data-testid="cluster-profile-channel-tf"]') as HTMLButtonElement).click(); });
    expect(useBrowserStore.getState().clusterViewSettings.profileChannels).toEqual(['tf']);
    expect(host.querySelector('[data-testid="cluster-profile-channel-tf"]')?.getAttribute('aria-pressed')).toBe('true');
    // Two channels: stacked small profiles per cluster.
    await act(async () => { (host.querySelector('[data-testid="cluster-profile-channel-nuc"]') as HTMLButtonElement).click(); });
    expect(host.querySelectorAll('[data-testid="cluster-stacked-profile"]').length).toBe(6);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(api.fetchClusterProjection.mock.calls.length).toBe(calls);
    expect(useBrowserStore.getState().clusterAssignments).toBe(assignments);
    await act(async () => { (host.querySelector('[data-testid="cluster-profile-channel-default"]') as HTMLButtonElement).click(); });
    expect(useBrowserStore.getState().clusterViewSettings.profileChannels).toBeNull();
  });

  it('colour the map by a molecule value without refetching it; the features refetch the map only', async () => {
    await openOverview('projection');
    const before = mapDots();
    expect(before).toHaveLength(4);
    const calls = api.fetchClusterProjection.mock.calls.length;
    const select = host.querySelector('[data-testid="projection-color-by"]') as HTMLSelectElement;
    expect(select.value).toBe('cluster');
    // Colour "cluster" asks for no molecule summaries.
    expect(api.fetchClusterMolecules).not.toHaveBeenCalled();
    await act(async () => { select.value = 'm6a'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.fetchClusterMolecules).toHaveBeenCalledTimes(1);
    expect(api.fetchClusterMolecules.mock.calls[0][5]).toMatchObject({ position: null, clusterAssignments: { napa: { r1: 0, r2: 0, r3: 1, r4: 2 } } });
    const after = mapDots();
    expect(after).toHaveLength(4);
    expect(new Set(after).size).toBe(4);           // four densities, four ramp colours
    expect(after).not.toEqual(before);
    expect(host.querySelector('[data-testid="projection-color-legend"]')?.textContent).toContain('m6A per kb');
    // Layer share and span: the same summaries (cached), no new request.
    await act(async () => { select.value = 'frac:nuc'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(new Set(mapDots()).size).toBe(4);
    await act(async () => { select.value = 'span'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(new Set(mapDots()).size).toBe(4);
    expect(api.fetchClusterMolecules).toHaveBeenCalledTimes(1);
    // The layer at a position: one request with the position; three states and one read not covering it.
    await act(async () => { select.value = 'state'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.fetchClusterMolecules).toHaveBeenCalledTimes(2);
    expect(api.fetchClusterMolecules.mock.calls[1][5].position).toBe(Math.floor((9_969_319 + 9_989_319) / 2));
    expect(host.querySelector('[data-testid="projection-color-legend"]')?.textContent).toContain('1 not covering');
    // Back to m6A: cached.
    await act(async () => { select.value = 'm6a'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(api.fetchClusterMolecules).toHaveBeenCalledTimes(2);
    expect(new Set(mapDots()).size).toBe(4);
    expect(api.fetchClusterProjection.mock.calls.length).toBe(calls);

    const features = host.querySelector('[data-testid="projection-features"]') as HTMLSelectElement;
    await act(async () => { features.value = 'nuc'; features.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(api.fetchClusterProjection.mock.calls.length).toBe(calls + 1);
    expect(api.fetchClusterProjection.mock.calls.at(-1)![7]).toMatchObject({ featureMode: 'nuc' });
    // The default request carries no feature mode.
    expect(api.fetchClusterProjection.mock.calls[0][7].featureMode ?? null).toBeNull();
  });
});
