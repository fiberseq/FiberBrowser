import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchClusterProjection: vi.fn(),
  fetchClusterVPlot: vi.fn(),
}));
vi.mock('../../api/clustering', async (orig) => ({ ...(await orig<typeof import('../../api/clustering')>()), ...api }));

import { useBrowserStore } from '../../stores/browserStore';
import { useRunResultStore } from '../../stores/runResultStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { ClusterDetailPanel } from './ClusterDetailPanel';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * fb-n3-clusters (audit H2): in Per panel mode (switched on by "Open with dm6
 * in its own panel") the main locus is stale; the charts read it, so the
 * clustered panel was "left out", Projection said "run clustering first" and
 * no projection or V-plot was requested. They read the clustered panel's view.
 */
const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000', data_type: 'bam' });
const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;
const projection = { coords_x: [0, 1], coords_y: [0, 1], read_ids: ['r1', 'r2'], dataset_ids: ['napa', 'napa'], labels_before: [0, 1],
  labels_after: null, cluster_centroids_before: {}, cluster_centroids_after: null, dissolved: [], method: 'tsne',
  variance_explained: null, feature_dim: 2, n_reads: 2 };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  try { localStorage.clear(); } catch { /* none */ }
  useRunResultStore.setState({ showSummaries: false, results: { cluster: { tone: 'note', text: 'The clusters largely separate the regions (NMI 0.75).', run: 1, at: 1 } } });
  api.fetchClusterProjection.mockReset().mockResolvedValue(projection);
  api.fetchClusterVPlot.mockReset().mockResolvedValue({ success: true, data: {} });
  usePanelGenomeStore.setState({ genomes: {}, assignments: { flyamp: 'dm6' } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

async function openTab(tab: string) {
  await act(async () => { window.dispatchEvent(new CustomEvent('fiberbrowser:open-cluster-detail-tab', { detail: { tab } })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
}

describe('Clusters charts in Per panel mode', () => {
  it.each([
    ['napa', ['chr19', 47_514_262, 47_519_210], undefined],
    ['flyamp', ['chr2L', 6_356_793, 6_357_648], 'dm6'],
  ])('the clustered %s panel is plotted at its own locus and reference', async (clustered, locus, genome) => {
    useBrowserStore.setState({
      // Stale main locus.
      chrom: 'chr19', start: 47_514_037, end: 47_518_985, currentGenome: 'hg38',
      navigationMode: 'perPanel', selectedDatasets: new Set(),
      datasets: [ds('napa'), ds('flyamp')] as never,
      panels: [
        panel('ph', 'napa', { navOwn: true, viewportOverride: { chrom: 'chr19', start: 47_514_262, end: 47_519_210 } }),
        panel('pf', 'flyamp', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 } }),
      ],
      clusterAssignments: { [clustered]: { r1: 0, r2: 1 } },
      clusterPeakRegions: clustered === 'napa'
        ? [{ start: 47_515_000, end: 47_515_200, mode: 'accessibility' }]
        : [{ start: 6_356_930, end: 6_357_166, mode: 'accessibility', chrom: 'chr2L', genome: 'dm6' }],
    } as never);
    await act(async () => { root.render(<ClusterDetailPanel />); });

    expect(host.querySelector('[data-testid="cluster-detail-run-note"]')?.textContent).toContain('NMI 0.75');
    await openTab('projection');
    expect(host.querySelector('[data-testid="cluster-detail-off-locus-note"]')).toBeNull();
    expect(api.fetchClusterProjection).toHaveBeenCalledTimes(1);
    const [chrom, start, end, datasetIds, peaks, , , options] = api.fetchClusterProjection.mock.calls[0];
    expect([chrom, start, end]).toEqual(locus);
    expect(datasetIds).toEqual([clustered]);
    expect(peaks).toHaveLength(1);
    expect(options.panelGenome ?? undefined).toBe(genome);
    expect(host.textContent).not.toContain('run clustering first');

    await openTab('vplot');
    expect(api.fetchClusterVPlot).toHaveBeenCalledTimes(1);
    const [vChrom, vStart, vEnd, vOptions] = api.fetchClusterVPlot.mock.calls[0];
    expect([vChrom, vStart, vEnd]).toEqual(locus);
    expect(Object.keys(vOptions.clusterAssignments)).toEqual([clustered]);
    expect(vOptions.panelGenome ?? undefined).toBe(genome);
  });
});
