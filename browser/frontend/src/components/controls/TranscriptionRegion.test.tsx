import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tApi = vi.hoisted(() => ({ filterByTranscriptionState: vi.fn() }));
vi.mock('../../api/transcription', async (orig) => ({ ...(await orig<typeof import('../../api/transcription')>()), ...tApi }));

import { useBrowserStore } from '../../stores/browserStore';
import { TranscriptionStatePanel } from './TranscriptionStatePanel';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** fb-r2-integ (1, audit): transcription states of the targeted panel's region and reference, not the main view's. */
const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000', data_type: 'bam' });
const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  tApi.filterByTranscriptionState.mockReset().mockResolvedValue({ results: {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount() {
  await act(async () => { root.render(<TranscriptionStatePanel />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

describe('transcription-state region', () => {
  it('a panel on its own reference is analysed at its locus there', async () => {
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('fly')] as never, selectedDatasets: new Set(),
      panels: [panel('pf', 'fly', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 1_000, end: 2_000 } })],
      selectedGenes: [{ id: 'g1', name: 'flyGene', chrom: 'chr2L', start: 1_100, end: 1_900, strand: '+' }],
    } as never);
    await mount();
    const call = tApi.filterByTranscriptionState.mock.calls[0];
    expect(call.slice(0, 3)).toEqual(['chr2L', 1_000, 2_000]);
    expect(call[8]).toMatchObject({ genome: 'dm6' });
  });

  it('panels at two regions: no request until one is chosen', async () => {
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('a'), ds('b')] as never, selectedDatasets: new Set(),
      panels: [panel('pa', 'a'), panel('pb', 'b', { viewportOverride: { chrom: 'chr3', start: 5_000, end: 6_000 } })],
      selectedGenes: [{ id: 'g1', name: 'G', chrom: 'chr1', start: 120, end: 180, strand: '+' }],
    } as never);
    await mount();
    expect(tApi.filterByTranscriptionState).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[data-testid="analysis-region-option"]')).toHaveLength(2);
  });
});
