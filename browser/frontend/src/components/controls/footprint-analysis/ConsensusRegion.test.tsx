import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getConsensusSchema: vi.fn(),
  getConsensusJobs: vi.fn(),
  startConsensus: vi.fn(),
}));
vi.mock('../../../api/consensusWorkflow', async (orig) => ({ ...(await orig<typeof import('../../../api/consensusWorkflow')>()), ...api }));

import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { ConsensusTools } from './ConsensusTools';
import type { PanelConfig } from '../../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * fb-r2-integ (1): Find classes takes its region from the targeted panels
 * (their own locus and reference), never silently from the main view.
 */
const ds = (id: string) => ({ id, label: id, path: `/d/${id}.bam`, color: '#000', data_type: 'bam', consensus_chemistry: 'ddda' });
const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  api.getConsensusSchema.mockReset().mockResolvedValue({ schema: 'x', cr_mode: 'lattice_recaller', groups: {}, layers: {}, display_defaults: {} });
  api.getConsensusJobs.mockReset().mockResolvedValue({ jobs: [], active_job: null });
  api.startConsensus.mockReset().mockImplementation(async (request: Record<string, unknown>) => ({
    job_id: 'j1', status: 'queued', request: { ...request, chemistry_overrides: {} }, filters: {}, created_at: 1 }));
  usePanelGenomeStore.setState({ genomes: {}, assignments: {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(datasetIds: string[]) {
  await act(async () => { root.render(<ConsensusTools datasetIds={datasetIds} peaks={[]} />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const runButton = () => host.querySelector<HTMLButtonElement>('[data-testid="run-lattice-consensus"]')!;

describe('Find classes region', () => {
  it('a selected panel navigating on its own is analysed at its locus, not the main view', async () => {
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('a')] as never, selectedDatasets: new Set(['pa']),
      panels: [panel('pa', 'a', { navOwn: true, viewportOverride: { chrom: 'chr2', start: 1_000, end: 2_000 } })],
    });
    await mount(['a']);
    expect(host.querySelector('[data-testid="consensus-region-choice"]')).toBeNull();
    await act(async () => { runButton().click(); });
    expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({ chrom: 'chr2', start: 1_000, end: 2_000 }));
  });

  it('targeted panels at different regions ask which one; no run until chosen', async () => {
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('a'), ds('b')] as never, selectedDatasets: new Set(),
      panels: [
        panel('pa', 'a', { navOwn: true, viewportOverride: { chrom: 'chr2', start: 1_000, end: 2_000 } }),
        panel('pb', 'b', { navOwn: true, viewportOverride: { chrom: 'chr3', start: 5_000, end: 6_000 } }),
      ],
    });
    await mount(['a', 'b']);
    const options = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="consensus-region-option"]')];
    expect(options.map(o => o.textContent)).toEqual(['chr2:1,000-2,000 · a', 'chr3:5,000-6,000 · b']);
    expect(runButton().disabled).toBe(true);
    await act(async () => { options[1].click(); });
    expect(host.querySelector('[data-testid="consensus-region-choice"]')).toBeNull();
    await act(async () => { runButton().click(); });
    expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({ chrom: 'chr3', start: 5_000, end: 6_000 }));
  });

  it('datasets on two references are not run together', async () => {
    usePanelGenomeStore.setState({ assignments: { b: 'dm6' } });
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('a'), ds('b')] as never, selectedDatasets: new Set(),
      panels: [panel('pa', 'a'), panel('pb', 'b', { genome: 'dm6', viewportOverride: { chrom: 'chr1', start: 100, end: 200 } })],
    });
    await mount(['a', 'b']);
    // Same coordinates, two assemblies: two regions, and nothing runs until one is chosen.
    expect(host.querySelectorAll('[data-testid="consensus-region-option"]')).toHaveLength(2);
    expect(runButton().disabled).toBe(true);
    // Unticking the dataset on the other reference by hand still leaves one region to analyse.
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .filter(box => box.closest('label')?.textContent?.trim() === 'b');
    expect(boxes).toHaveLength(1);
  });

  // fb-n3-clusters (audit M19): picking a region used to leave the dm6 datasets
  // ticked, so the run stayed blocked ("different references") and the assay
  // setup asked about them. The region's reference is the run's: the datasets
  // on the other assembly are unticked.
  it('choosing a region unticks the datasets on the other reference, and the run goes', async () => {
    usePanelGenomeStore.setState({ assignments: { b: 'dm6' } });
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('a'), { ...ds('b'), consensus_chemistry: '' }] as never, selectedDatasets: new Set(),
      panels: [panel('pa', 'a'), panel('pb', 'b', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 5_000, end: 6_000 } })],
    });
    await mount(['a', 'b']);
    const options = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="consensus-region-option"]')];
    expect(options.map(o => o.textContent)).toEqual(['chr1:100-200 · a', 'dm6 chr2L:5,000-6,000 · b']);
    await act(async () => { options[0].click(); });
    expect(host.querySelector('[data-testid="consensus-region-choice"]')).toBeNull();
    expect(host.querySelector('[data-testid="consensus-reference-problem"]')).toBeNull();
    // b (dm6, no assay set) no longer asks for its assay.
    expect(host.querySelector('[data-testid="automatic-family-mode"]')?.textContent).toBe('Find footprint classes');
    expect(runButton().disabled).toBe(false);
    await act(async () => { runButton().click(); });
    expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({ dataset_ids: ['a'], chrom: 'chr1', start: 100, end: 200 }));
  });

  it('choosing a region keeps the datasets on the same reference', async () => {
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 200, datasets: [ds('a'), ds('b')] as never, selectedDatasets: new Set(),
      panels: [
        panel('pa', 'a', { navOwn: true, viewportOverride: { chrom: 'chr2', start: 1_000, end: 2_000 } }),
        panel('pb', 'b', { navOwn: true, viewportOverride: { chrom: 'chr3', start: 5_000, end: 6_000 } }),
      ],
    });
    await mount(['a', 'b']);
    await act(async () => { host.querySelectorAll<HTMLButtonElement>('[data-testid="consensus-region-option"]')[1].click(); });
    await act(async () => { runButton().click(); });
    expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({ dataset_ids: ['a', 'b'], chrom: 'chr3' }));
  });
});
