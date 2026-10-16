import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchClusterProjection: vi.fn(),
  fetchClusterVPlot: vi.fn(),
  getCompactReads: vi.fn(),
}));
vi.mock('../../api/clustering', async (orig) => ({
  ...(await orig<typeof import('../../api/clustering')>()),
  fetchClusterProjection: api.fetchClusterProjection,
  fetchClusterVPlot: api.fetchClusterVPlot,
}));
vi.mock('../../api/readOperations', async (orig) => ({
  ...(await orig<typeof import('../../api/readOperations')>()),
  getCompactReads: api.getCompactReads,
}));
// Differences: what the chart is given (its scope), not its drawing.
vi.mock('./cluster-detail/EnrichmentTabContent', () => ({
  EnrichmentTabContent: ({ pickKeys, clusterData, allClusterData }: {
    pickKeys?: string[]; clusterData: Array<{ cluster: number }>; allClusterData?: Array<{ cluster: number }>;
  }) => (
    <div
      data-testid="differences-props"
      data-pick-keys={(pickKeys ?? []).join(',')}
      data-clusters={clusterData.map(c => c.cluster).join(',')}
      data-all-clusters={(allClusterData ?? []).map(c => c.cluster).join(',')}
    />
  ),
}));

import { useBrowserStore } from '../../stores/browserStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { setRunResult } from '../../stores/runResultStore';
import { ClusterDetailPanel } from './ClusterDetailPanel';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * fb-n6-integ (Codex, after merging the read map and the cluster charts): the
 * map, the V-plots and Differences read only their own panels (the map: the
 * first clustering of each dataset at the plotted view; the V-plots: every
 * panel at that view; Differences: one clustering per dataset). Clicking or
 * picking in them used every clustered panel instead, so a panel they leave
 * out (on another reference, at another locus, a copy clustered on its own)
 * was focused, unfocused or picked by clusters it doesn't share.
 */
const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000', data_type: 'bam' });
const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;
const projection = {
  coords_x: [0, 0.1, 5, 10], coords_y: [0, 0.2, 5, 10], read_ids: ['r1', 'r2', 'r3', 'r4'], dataset_ids: ['napa', 'napa', 'napa', 'napa'],
  labels_before: [0, 0, 1, 2], labels_after: null, cluster_centroids_before: {}, cluster_centroids_after: null, dissolved: [],
  method: 'tsne', variance_explained: null, feature_dim: 2, n_reads: 4,
};

// jsdom has no canvas: record where the dots are drawn (arc calls of radius 3).
const arcs = new Map<HTMLCanvasElement, Array<[number, number, number]>>();
function fakeContext(canvas: HTMLCanvasElement) {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'canvas') return canvas;
      if (prop === 'arc') return (x: number, y: number, r: number) => { arcs.get(canvas)!.push([x, y, r]); };
      if (prop === 'clearRect') return () => { arcs.set(canvas, []); };
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* none */ }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!arcs.has(this)) arcs.set(this, []);
    return fakeContext(this) as never;
  });
  api.fetchClusterProjection.mockReset().mockResolvedValue(projection);
  api.fetchClusterVPlot.mockReset().mockResolvedValue({ success: true, data: {} });
  api.getCompactReads.mockReset().mockResolvedValue({ reads: [] });
  usePanelGenomeStore.setState({ genomes: {}, assignments: { flyamp: 'dm6' } });
  const colormap = useBrowserStore.getState().activeColormap;
  useBrowserStore.setState({
    chrom: 'chr19', start: 47_514_037, end: 47_518_985, currentGenome: 'hg38',
    navigationMode: 'linked', selectedDatasets: new Set(),
    datasets: [ds('napa'), ds('flyamp')] as never,
    panels: [
      panel('p1', 'napa'),
      // A copy of napa at the same view, clustered on its own.
      panel('p2', 'napa', { stateKey: 'napa:copy' }),
      // Another assembly: its own locus, left out of the charts.
      panel('p3', 'flyamp', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 } }),
    ],
    clusterAssignments: {
      napa: { r1: 0, r2: 0, r3: 1, r4: 2 },
      'napa:copy': { r1: 1, r2: 0, r3: 0, r4: 3 },
      flyamp: { t1: 0, t2: 1, t3: 5 },
    },
    clusterOrder: { napa: [0, 1, 2], 'napa:copy': [0, 1, 3], flyamp: [0, 1, 5] },
    clusterFocus: { flyamp: new Set([5]) },
    selectedClusters: { flyamp: new Set([5]) },
    clusterMergeLog: null,
    clusterMatchedRun: null,
    clusterPeakRegions: [{ start: 47_515_000, end: 47_515_200, mode: 'accessibility' }],
    activeColormap: {
      ...colormap,
      rules: [{ id: 'pol2', name: 'Pol II', color: '#f00', sizeMin: 10, sizeMax: null, targetLayers: [], conditions: [], enabled: true }],
    },
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('offers Open as panels only for saved groups, not projected feature identifiers', async () => {
  const s = useBrowserStore.getState();
  s.upsertMatchedGroup({ id: 'saved', name: 'Saved group', regions: [{ index: 0, chrom: s.chrom, start: s.start, end: s.start + 100,
    match: { groupId: '', label: 'W1', length: 100, reversed: false, blocks: [{ frame: [0, 100], genomic: [s.start, s.start + 100] }] } }] });
  useBrowserStore.setState({ clusterMatchedRun: { groups: ['saved', 'saved:peak:0-100'], windows: [], assignments: {},
    panelAssignments: s.clusterAssignments, windowNmi: 0, referenceNmi: 0, lengths: [100], balancedFitReads: 1 } });
  setRunResult('cluster', { tone: 'note', text: 'Clustered shared features' });
  await act(async () => { root.render(<ClusterDetailPanel />); });
  expect(host.querySelector('[data-testid="cluster-open-panels-saved"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="cluster-open-panels-saved:peak:0-100"]')).toBeNull();
});

it('counts only the joint fit panels, leaving the folded source split out of its overview', async () => {
  const assignments = { napa: { r1: 0, r2: 1 }, 'napa:copy': { r1: 1, r2: 0 } };
  const s = useBrowserStore.getState();
  useBrowserStore.setState({
    panels: s.panels.map(p => p.id === 'p3' ? { ...p, collapsed: true } : p),
    clusterAssignments: { ...assignments, flyamp: { t1: 0, t2: 1, t3: 5 } },
    clusterOrder: { napa: [0, 1], 'napa:copy': [0, 1], flyamp: [0, 1, 5] },
    clusterMatchedRun: { groups: ['shared'], windows: [
      { key: 'a', stateKey: 'napa', panelId: 'p1', label: 'A', genome: null },
      { key: 'b', stateKey: 'napa:copy', panelId: 'p2', label: 'B', genome: null },
    ], assignments: { a: assignments.napa, b: assignments['napa:copy'] }, panelAssignments: assignments,
    windowNmi: 0, referenceNmi: 0, lengths: [100], balancedFitReads: 2 },
  });
  await act(async () => { root.render(<ClusterDetailPanel />); });
  expect(host.textContent).toContain('4 assigned reads');
  expect(host.textContent).toContain('2 dataset views');
  expect(host.querySelector('[data-copilot-anchor="cluster-row-5"]')).toBeNull();
  expect(host.querySelector('[data-copilot-anchor="cluster-row-0"]')?.textContent).toContain('(1/1)');
});

async function openTab(tab: string) {
  await act(async () => { window.dispatchEvent(new CustomEvent('fiberbrowser:open-cluster-detail-tab', { detail: { tab } })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
}
const focusOf = (key: string) => {
  const f = useBrowserStore.getState().clusterFocus[key];
  return f ? [...f].sort((a, b) => a - b) : null;
};
const pickOf = (key: string) => {
  const p = useBrowserStore.getState().selectedClusters[key];
  return p ? [...p].sort((a, b) => a - b) : null;
};

describe('Clusters: the map and charts change only their own panels', () => {
  it('the read map focuses, and clears, only the panels it plots; its legend is theirs', async () => {
    await act(async () => { root.render(<ClusterDetailPanel />); });
    await openTab('projection');
    expect(api.fetchClusterProjection).toHaveBeenCalledTimes(1);
    expect(api.fetchClusterProjection.mock.calls[0][3]).toEqual(['napa']);
    const legend = (c: number) => host.querySelector(`[data-testid="projection-legend-${c}"]`);
    expect(legend(1)).not.toBeNull();
    // The copy's C3 and the dm6 panel's C5 aren't on this map.
    expect(legend(3)).toBeNull();
    expect(legend(5)).toBeNull();

    const canvas = host.querySelector('[data-testid="projection-map-canvas"]') as HTMLCanvasElement;
    const [x, y] = (arcs.get(canvas) ?? []).filter(([, , r]) => r === 3)[2];
    await act(async () => { canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })); });
    expect(focusOf('napa')).toEqual([1]);
    expect(focusOf('napa:copy')).toBeNull();
    expect(focusOf('flyamp')).toEqual([5]);

    const showAll = [...host.querySelectorAll('button')].find(b => b.textContent === 'Show all') as HTMLButtonElement;
    await act(async () => { showAll.click(); });
    expect(focusOf('napa')).toBeNull();
    // The dm6 panel keeps its own focus.
    expect(focusOf('flyamp')).toEqual([5]);
  });

  it('V-plot picks go to the plotted panels only, from their clusters', async () => {
    await act(async () => { root.render(<ClusterDetailPanel />); });
    await openTab('vplot');
    const chip = (c: number) => host.querySelector(`[data-testid="vplot-picks-chip-${c}"]`) as HTMLButtonElement | null;
    expect(chip(3)).not.toBeNull(); // the copy is plotted
    expect(chip(5)).toBeNull(); // the dm6 panel isn't
    await act(async () => { chip(1)!.click(); });
    expect(pickOf('napa')).toEqual([1]);
    expect(pickOf('napa:copy')).toEqual([1]);
    expect(pickOf('flyamp')).toEqual([5]);
  });

  it('Differences picks from one clustering per dataset at the plotted view', async () => {
    await act(async () => { root.render(<ClusterDetailPanel />); });
    await openTab('enrichment');
    const props = host.querySelector('[data-testid="differences-props"]') as HTMLElement;
    expect(props).not.toBeNull();
    expect(props.dataset.pickKeys).toBe('napa');
    expect(props.dataset.allClusters).toBe('0,1,2');
    expect(props.dataset.clusters).toBe('0,1,2');
  });
});
