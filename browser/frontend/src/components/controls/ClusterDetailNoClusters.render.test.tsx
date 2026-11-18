/**
 * Clusters › Footprint sizes without clustering: the empty Clusters panel offers Footprint size enrichment, which
 * plots every dataset in view from all its reads (group_by 'all'); a request from one panel (the read menu's "here")
 * plots that panel's view.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchFootprintSizes: vi.fn() }));
vi.mock('../../api/clustering', async (orig) => ({ ...(await orig<typeof import('../../api/clustering')>()), ...api }));

import { useBrowserStore } from '../../stores/browserStore';
import { ClusterDetailPanel } from './ClusterDetailPanel';
import { useFootprintSizesInvokedFrom } from '../../utils/footprintSizeEntry';
import { DEFAULT_FOOTPRINT_SIZE_SETTINGS, withView } from '../../utils/footprintSizeSettings';
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
  useFootprintSizesInvokedFrom.getState().set(null);
  useBrowserStore.setState({
    chrom: 'chrT', start: 1000, end: 3000, currentGenome: null, navigationMode: 'linked', selectedDatasets: new Set(),
    datasets: [ds('a'), ds('b')] as never,
    panels: [panel('pa', 'a'), panel('pb', 'b')],
    clusterAssignments: {}, savedClusters: [],
    footprintSizeSettings: withView(DEFAULT_FOOTPRINT_SIZE_SETTINGS, 'vplot'),
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(600); }); };

describe('Clusters panel without clusters', () => {
  it('offers Footprint size enrichment, which plots every dataset from all its reads', async () => {
    await act(async () => { root.render(<ClusterDetailPanel />); });
    expect(host.textContent).toContain('No clusters computed');
    await act(async () => { (q('cluster-detail-open-footprint-sizes') as HTMLButtonElement).click(); });
    await settle();
    expect(q('footprint-sizes')?.getAttribute('data-view')).toBe('enrichment');
    expect(q('footprint-sizes')?.getAttribute('data-group')).toBe('datasets');
    expect(host.textContent).toContain('no clustering needed');
    expect(api.fetchFootprintSizes).toHaveBeenCalledTimes(1);
    const [chrom, start, end, opts] = api.fetchFootprintSizes.mock.calls[0];
    expect([chrom, start, end]).toEqual(['chrT', 1000, 3000]);
    expect(opts).toMatchObject({ groupBy: 'all', datasetIds: ['a', 'b'], normalization: 'row', mode: 'span' });
  });

  it('a request from one panel ("here") plots that panel\'s view', async () => {
    useBrowserStore.setState({
      navigationMode: 'perPanel',
      panels: [panel('pa', 'a', { navOwn: true, viewportOverride: { chrom: 'chrT', start: 5000, end: 6000 } } as never), panel('pb', 'b')],
    } as never);
    sessionStorage.setItem('fiberbrowser_cluster_detail_tab', 'vplot');
    useFootprintSizesInvokedFrom.getState().set('pa');
    await act(async () => { root.render(<ClusterDetailPanel />); });
    await settle();
    const [chrom, start, end, opts] = api.fetchFootprintSizes.mock.calls.at(-1)!;
    expect([chrom, start, end]).toEqual(['chrT', 5000, 6000]);
    expect(opts.datasetIds).toEqual(['a']);
    expect(q('footprint-sizes-note')?.textContent).toMatch(/1 panel showing another locus/);
  });
});
