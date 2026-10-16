import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fpApi = vi.hoisted(() => ({ analyzeFootprints: vi.fn() }));
vi.mock('../../api/footprints', async (orig) => ({ ...(await orig<typeof import('../../api/footprints')>()), ...fpApi }));
vi.mock('../../api/consensusWorkflow', async (orig) => ({
  ...(await orig<typeof import('../../api/consensusWorkflow')>()),
  getConsensusSchema: vi.fn(async () => ({ schema: 'x', cr_mode: 'lattice_recaller', groups: {}, layers: {}, display_defaults: {} })),
  getConsensusJobs: vi.fn(async () => ({ jobs: [], active_job: null })),
}));

import { useBrowserStore } from '../../stores/browserStore';
import { FootprintAnalysisPanel } from './FootprintAnalysisPanel';
import type { FootprintGroup, PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * fb-r2-integ (1, audit): co-occupancy of saved footprints looks at the region
 * the targeted panels show, not the main view; panels at two regions ask which.
 */
const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000', data_type: 'bam', consensus_chemistry: 'ddda' });
const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;
const group = (id: string, chrom = 'chr2'): FootprintGroup => ({
  id, name: id, color: '#f00', layer: 'tf', sizeMin: 0, sizeMax: null, overlapFraction: 0, enabled: true, sourceIndex: -1,
  referenceChrom: chrom, referenceAbsStart: 150, referenceAbsEnd: 170,
} as unknown as FootprintGroup);

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  fpApi.analyzeFootprints.mockReset().mockResolvedValue({ success: true, footprints: [], overlap_stats: {}, co_occupancy: {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount() {
  await act(async () => { root.render(<FootprintAnalysisPanel />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const coocCalls = () => fpApi.analyzeFootprints.mock.calls.filter(call => call[6]?.coocc);

describe('co-occupancy region', () => {
  it('runs at the region of the panel navigating on its own', async () => {
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('a')] as never, selectedDatasets: new Set(),
      panels: [panel('pa', 'a', { navOwn: true, viewportOverride: { chrom: 'chr2', start: 1_000, end: 2_000 } })],
      footprintGroups: [group('g1')], selectedFootprints: [],
    } as never);
    await mount();
    expect(coocCalls().map(call => call.slice(0, 3))).toContainEqual(['chr2', 1_000, 2_000]);
    expect(coocCalls().some(call => call[0] === 'chr1')).toBe(false);
  });

  it('panels at two regions: no silent default, the user picks one', async () => {
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('a'), ds('b')] as never, selectedDatasets: new Set(),
      panels: [
        panel('pa', 'a', { navOwn: true, viewportOverride: { chrom: 'chr2', start: 1_000, end: 2_000 } }),
        panel('pb', 'b', { navOwn: true, viewportOverride: { chrom: 'chr3', start: 5_000, end: 6_000 } }),
      ],
      // A definition at the (stale) main view's coordinates: it used to be analysed there.
      footprintGroups: [group('g1', 'chr1')], selectedFootprints: [],
    } as never);
    await mount();
    expect(coocCalls()).toHaveLength(0);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('fiberbrowser:open-footprint-analysis-tab', { detail: { tab: 'co-occ' } }));
    });
    const options = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="analysis-region-option"]')];
    expect(options.map(o => o.textContent)).toEqual(['chr2:1,000-2,000 · a', 'chr3:5,000-6,000 · b']);
    await act(async () => { options[1].click(); });
    expect([...useBrowserStore.getState().selectedDatasets]).toEqual(['pb']);
  });

  it('a request in flight when the panels come to show two regions is dropped (review)', async () => {
    let signal: AbortSignal | undefined;
    fpApi.analyzeFootprints.mockImplementation((...args: unknown[]) => {
      const options = args[6] as { coocc?: boolean; signal?: AbortSignal };
      if (options?.coocc) signal = options.signal;
      return new Promise(() => {});
    });
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('a'), ds('b')] as never, selectedDatasets: new Set(),
      panels: [panel('pa', 'a'), panel('pb', 'b')],
      footprintGroups: [group('g1', 'chr1')], selectedFootprints: [],
    } as never);
    await mount();
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      useBrowserStore.setState({ panels: [panel('pa', 'a'), panel('pb', 'b', { viewportOverride: { chrom: 'chr3', start: 5_000, end: 6_000 } })] });
    });
    expect(signal?.aborted).toBe(true);
  });
});
