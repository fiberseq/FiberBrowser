import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getConsensusSchema: vi.fn(),
  getConsensusJobs: vi.fn(),
  getConsensusJob: vi.fn(),
  startConsensus: vi.fn(),
  getConsensusCatalog: vi.fn(),
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
 * Usability round 1 (FP-5): after a run the settings fold into one summary line with Edit settings (round 2, N21: Find again is the one rerun); the
 * deprecated staged engine is chosen under Advanced, not in the main engine row.
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
  api.getConsensusCatalog.mockReset().mockImplementation(() => new Promise(() => {}));
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

const DONE = { job_id: 'done1', status: 'complete', stage: 'complete', message: '', created_at: 1, finished_at: 2, filters: {},
  request: { dataset_ids: ['a'], chrom: 'chr19', start: 47_517_000, end: 47_521_000, chemistry_overrides: { a: 'ddda' },
    parameters: { cr: { engine: 'lattice_recaller', enabled: true }, recaller: { stringency: 0.85 } } } };

describe('Find classes: the settings fold after a run', () => {
  it('shows a summary with Edit settings (one rerun action: Find again, N21); the engine choice lives under Advanced', async () => {
    api.getConsensusJobs.mockResolvedValue({ jobs: [DONE], active_job: 'done1' });
    await mount();
    const summary = q('class-config-summary')!;
    expect(summary.textContent).toContain('Lattice recaller');
    expect(summary.textContent).toContain('stringency 0.85');
    expect(q('family-workflow')!.hidden).toBe(true);
    // the deprecated engine is not in the main row
    expect(q('family-engine-name')!.textContent).toContain('Lattice recaller');
    expect(q('family-engine')!.closest('details')!.getAttribute('data-testid')).toBe('states-advanced');
    await act(async () => { q('class-config-edit')!.click(); });
    expect(q('class-config-summary')).toBeNull();
    expect(q('family-workflow')!.hidden).toBe(false);
    await act(async () => { q('class-config-collapse')!.click(); });
    expect(q('family-workflow')!.hidden).toBe(true);
    // one rerun action: the header's Find again (the summary's duplicate Run again is gone)
    expect(q('class-config-run-again')).toBeNull();
    expect(q('automatic-family-mode')!.textContent).toBe('Find again');
    await act(async () => { q('run-lattice-consensus')!.click(); });
    expect(api.startConsensus).toHaveBeenCalledTimes(1);
    expect(api.startConsensus.mock.calls[0][0].parameters.recaller.stringency).toBe(0.85);
  });

  it('stays open before any run', async () => {
    await mount();
    expect(q('class-config-summary')).toBeNull();
    expect(q('family-workflow')!.hidden).toBe(false);
  });
});


it('restores caps and sends them to a supporting engine', async () => {
  const caps={max_discovery_molecules:2000,max_quantification_molecules:1500,sample_seed:7};
  localStorage.setItem('fiberhmm-consensus-parameters-v2',JSON.stringify({recaller:caps}));
  api.getConsensusSchema.mockResolvedValue({groups:{recaller:[STRINGENCY,...Object.keys(caps).map(name=>({...STRINGENCY,name,type:'int',default:name==='sample_seed'?1:0}))]},display_defaults:{}});
  await mount();
  expect((q('consensus-max-discovery-molecules') as HTMLInputElement).value).toBe('2000');
  const button=[...host.querySelectorAll('button')].find(b=>b.textContent==='Find footprint classes')!;
  await act(async()=>button.click());
  expect(api.startConsensus).toHaveBeenCalledWith(expect.objectContaining({parameters:expect.objectContaining({recaller:expect.objectContaining(caps)})}));
});

it('never sends saved caps to an older engine', async () => {
  localStorage.setItem('fiberhmm-consensus-parameters-v2',JSON.stringify({recaller:{max_discovery_molecules:2000,sample_seed:7}}));
  await mount();
  expect(q('consensus-read-depth')?.textContent).toContain('Update FiberHMM');
  expect(q('consensus-max-discovery-molecules')).toBeNull();
  const button=[...host.querySelectorAll('button')].find(b=>b.textContent==='Find footprint classes')!;
  await act(async()=>button.click());
  expect(api.startConsensus.mock.calls[0][0].parameters.recaller).not.toHaveProperty('max_discovery_molecules');
});

it('shows the exact capped denominator of an imported or restored run', async () => {
  api.getConsensusJobs.mockResolvedValue({jobs:[{...DONE,loader_sampling:[{dataset_id:'a',reads_seen:25000,eligible_reads:20000,reads_decoded:3000}],molecule_sampling:[{max_discovery_molecules:2000,strata:[{stratum:'a::CT',available:2734,discovery:2000,quantification:null}]}]}],active_job:'done1'});
  await mount();
  expect(q('consensus-read-depth-notes')?.textContent).toContain('decoded 3,000 of 20,000 eligible reads');
  expect(q('consensus-read-depth-notes')?.textContent).toContain('Used 2,000 of 2,734 eligible reads in the decoded subset in a (CT)');
});
