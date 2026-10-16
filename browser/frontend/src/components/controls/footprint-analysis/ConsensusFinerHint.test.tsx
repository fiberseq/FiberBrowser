import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getConsensusSchema: vi.fn(),
  getConsensusJobs: vi.fn(),
  getConsensusJob: vi.fn(),
  startConsensus: vi.fn(),
}));
vi.mock('../../../api/consensusWorkflow', async (orig) => ({ ...(await orig<typeof import('../../../api/consensusWorkflow')>()), ...api }));

import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { useRegionCatalogStore } from '../../../stores/regionCatalogStore';
import { useClassRegionOutlineStore } from '../../../stores/classRegionOutlineStore';
import { DEFAULT_CLASS_REGION_MODE } from '../../../utils/classRegion';
import { ConsensusTools } from './ConsensusTools';
import type { PanelConfig } from '../../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * fb-n9-finerhint: under the Stringency slider, a short hint points users who miss a class they can see to
 * Finer (0.80), and applies it in one click. It is not shown once the slider is at 0.80 or finer.
 */
const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000', data_type: 'bam', consensus_chemistry: 'ddda' });
const panel = (id: string, datasetId: string) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }) as PanelConfig;
const STRINGENCY = { name: 'stringency', default: 0.9, type: 'float', minimum: 0.05, maximum: 1, step: 0.05, label: 'k-means stringency', help: '' };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  api.getConsensusSchema.mockReset().mockResolvedValue({ schema: 'x', cr_mode: 'lattice_recaller', groups: { recaller: [STRINGENCY] }, layers: {}, display_defaults: {} });
  api.getConsensusJobs.mockReset().mockResolvedValue({ jobs: [], active_job: null });
  api.getConsensusJob.mockReset().mockImplementation(() => new Promise(() => {}));
  api.startConsensus.mockReset().mockImplementation(async (request: Record<string, unknown>) => ({
    job_id: 'j1', status: 'queued', request: { ...request, chemistry_overrides: {} }, filters: {}, created_at: 1 }));
  usePanelGenomeStore.setState({ genomes: {}, assignments: {} });
  useRegionCatalogStore.setState({ catalogs: {}, sync: {}, fingerprints: {} } as never);
  useClassRegionOutlineStore.setState({ outline: null, heldForJob: null });
  useBrowserStore.setState({
    chrom: 'chr19', start: 47_517_000, end: 47_521_000, currentGenome: 'hg38', datasets: [ds('a')] as never,
    selectedDatasets: new Set(['pa']), panels: [panel('pa', 'a')], classRegionMode: DEFAULT_CLASS_REGION_MODE,
    _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0,
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount() {
  await act(async () => { root.render(<div data-panel-content-type="footprint-analysis"><ConsensusTools datasetIds={['a']} peaks={[]} /></div>); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const slider = () => q('recaller-stringency') as HTMLInputElement;

describe('Find classes: the Finer hint', () => {
  it('is shown at the default stringency and sets Finer (0.80) for the next run', async () => {
    await mount();
    expect(slider().value).toBe('0.9');
    expect(q('recaller-finer-hint')!.textContent).toBe(
      'Missing a class you can see? Try Finer (0.80): more, smaller classes, at the cost of near-duplicates.');
    await act(async () => { q('recaller-finer-hint-apply')!.click(); });
    expect(slider().value).toBe('0.8');
    expect(q('recaller-finer-hint')).toBeNull();
    await act(async () => { q('run-lattice-consensus')!.click(); });
    expect(api.startConsensus.mock.calls[0][0].parameters.recaller.stringency).toBe(0.8);
  });

  it('is hidden at 0.80 or finer and shown again when the slider goes coarser', async () => {
    await mount();
    const set = async (v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setter.call(slider(), v); slider().dispatchEvent(new Event('input', { bubbles: true })); });
    };
    await set('0.7');
    expect(q('recaller-finer-hint')).toBeNull();
    await set('0.85');
    expect(q('recaller-finer-hint')).not.toBeNull();
  });
});
