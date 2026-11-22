/**
 * The Clusters panel's footprint sizes live in Plots (3.1.1: the Footprint sizes tab and its size buttons are gone):
 * the empty panel offers one "Footprint sizes → Plots" action, which opens Plots on Size enrichment by dataset; a
 * remembered or requested 'vplot' tab (older links, tour steps) opens Overview; a read-menu "here" request from a
 * panel at its own locus pins the plot there.
 */
import '../../features/testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchFootprintSizes: vi.fn() }));
vi.mock('../../api/clustering', async (orig) => ({ ...(await orig<typeof import('../../api/clustering')>()), ...api }));

import { useBrowserStore } from '../../stores/browserStore';
import { ClusterDetailPanel } from './ClusterDetailPanel';
import { openFootprintSizes } from '../../utils/footprintSizeEntry';
import { closePlots, useWorkspaceStore } from '../../features/plots/workspace';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ds = (id: string) => ({ id, label: id.toUpperCase(), path: `/d/${id}.bam`, color: '#123456', data_type: 'bam' });
const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

beforeEach(() => {
  vi.useFakeTimers();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* none */ }
  api.fetchFootprintSizes.mockReset().mockResolvedValue({ success: true, data: {} });
  closePlots();
  useBrowserStore.setState({
    chrom: 'chrT', start: 1000, end: 3000, currentGenome: null, navigationMode: 'linked', selectedDatasets: new Set(),
    datasets: [ds('a'), ds('b')] as never,
    panels: [panel('pa', 'a'), panel('pb', 'b')],
    clusterAssignments: {}, savedClusters: [],
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('Clusters panel without clusters', () => {
  it('has no Footprint sizes tab or size buttons; one action opens Plots on Size enrichment by dataset', async () => {
    await act(async () => { root.render(<ClusterDetailPanel />); });
    expect(host.textContent).toContain('No clusters computed');
    expect(q('cluster-detail-open-footprint-sizes')).toBeNull();
    expect(q('footprint-sizes')).toBeNull();
    expect(host.querySelector('[data-analysis-tab="vplot"]')).toBeNull();
    const action = q('cluster-detail-sizes-in-plots') as HTMLButtonElement;
    expect(action.textContent).toMatch(/Footprint sizes\s*→\s*Plots/);
    await act(async () => { action.click(); });
    expect(useWorkspaceStore.getState().view).toBe('plots');
    expect(useBrowserStore.getState().plotsWorkspace.current).toMatchObject({ type: 'size-enrichment', where: 'view', groupBy: 'dataset', pinned: null });
    // Nothing is fetched by the Clusters panel itself.
    expect(api.fetchFootprintSizes).not.toHaveBeenCalled();
  });

  it('a requested \'vplot\' tab (older links and tour steps) opens Overview, not an empty panel', async () => {
    useBrowserStore.setState({ clusterAssignments: { a: { r1: 0, r2: 1 } } } as never);
    sessionStorage.setItem('fiberbrowser_cluster_detail_tab', 'vplot');
    await act(async () => { root.render(<ClusterDetailPanel />); });
    expect(host.querySelector('[data-analysis-tab="overview"][aria-selected="true"], [data-analysis-tab="overview"][aria-pressed="true"]')
      ?? host.querySelector('[data-analysis-tab="overview"]')).not.toBeNull();
    expect(host.querySelector('[data-analysis-tab="vplot"]')).toBeNull();
    expect(q('cluster-detail-sizes-in-plots')).not.toBeNull();
    await act(async () => { window.dispatchEvent(new CustomEvent('fiberbrowser:open-cluster-detail-tab', { detail: { tab: 'vplot' } })); });
    expect(host.querySelector('[data-analysis-tab="vplot"]')).toBeNull();
    expect(q('cluster-detail-sizes-in-plots')).not.toBeNull();
  });

  it('a request from one panel ("here") at its own locus pins the plot to that panel\'s view', () => {
    useBrowserStore.setState({
      navigationMode: 'perPanel',
      panels: [panel('pa', 'a', { navOwn: true, viewportOverride: { chrom: 'chrT', start: 5000, end: 6000 } } as never), panel('pb', 'b')],
    } as never);
    openFootprintSizes({ panelId: 'pa' });
    expect(useBrowserStore.getState().plotsWorkspace.current).toMatchObject({ groupBy: 'dataset', pinned: { chrom: 'chrT', start: 5000, end: 6000 } });
  });
});
