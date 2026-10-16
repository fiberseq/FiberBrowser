import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  addDataset: vi.fn(),
  removeDataset: vi.fn(),
  getDatasets: vi.fn(),
}));
const layerApi = vi.hoisted(() => ({
  activateConsensus: vi.fn(),
  loadDerivedLayers: vi.fn(),
}));
const genomeApi = vi.hoisted(() => ({
  attachPanelGenome: vi.fn(),
  getPanelGenomes: vi.fn(),
  detachPanelGenome: vi.fn(),
}));
vi.mock('../api/panelGenomes', () => genomeApi);
vi.mock('../api/genomeCheck', () => ({ getGenomeCheck: vi.fn(async () => ({ datasets: [], reference: null })) }));
vi.mock('../api/datasets', async (orig) => ({ ...(await orig<typeof import('../api/datasets')>()), ...api }));
vi.mock('../api/consensusWorkflow', async (orig) => ({ ...(await orig<typeof import('../api/consensusWorkflow')>()), activateConsensus: layerApi.activateConsensus }));
vi.mock('../api/footprints', async (orig) => ({ ...(await orig<typeof import('../api/footprints')>()), loadDerivedLayers: layerApi.loadDerivedLayers }));

import { useBrowserStore } from '../stores/browserStore';
import { closedDatasetReference, usePanelGenomeStore } from '../stores/panelGenomeStore';
import { datasetChangesBetween, remapDatasetIds, serializeDataset } from '../stores/historySlice';
import '../plugins/builtinPanels';

const A = { id: 'a', label: 'napa_ddda', path: '/data/napa_ddda.bam', color: '#3b82f6', data_type: 'bam' };
const B = { id: 'b', label: 'napa_hia5', path: '/data/napa_hia5.bam', color: '#ef4444', data_type: 'bam' };

async function ticks() {
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
}

/** Wait until every reopen/close job has finished (the first dynamic import can be slow under load). */
async function settle() {
  const deadline = Date.now() + 5000;
  do { await ticks(); } while ((useBrowserStore.getState() as { _historyPaused: boolean })._historyPaused && Date.now() < deadline);
}

describe('undo of closing a dataset', () => {
  beforeEach(() => {
    api.addDataset.mockReset().mockImplementation(async (path: string, label?: string) => ({ success: true, dataset: { ...B, path, label: label ?? B.label } }));
    api.removeDataset.mockReset().mockResolvedValue({ success: true });
    api.getDatasets.mockReset().mockResolvedValue({ datasets: [] });
    layerApi.activateConsensus.mockReset().mockResolvedValue({});
    layerApi.loadDerivedLayers.mockReset().mockResolvedValue({ success: true });
    useBrowserStore.setState({ datasets: [], panels: [], _historyStack: [], _historyPointer: -1, reopeningDatasets: [] } as never);
    const s = useBrowserStore.getState();
    s.addDataset(A as never);
    s.addDataset(B as never);
  });
  afterEach(() => vi.useRealTimers());

  it('finds the closes crossed in either direction', () => {
    const stack = [{}, { closedDatasets: [serializeDataset(B)] }, {}] as never;
    expect(datasetChangesBetween(stack, 2, 0).reopen.map(d => d.id)).toEqual(['b']);
    expect(datasetChangesBetween(stack, 0, 2).close.map(d => d.id)).toEqual(['b']);
    expect(datasetChangesBetween(stack, 2, 1)).toEqual({ reopen: [], close: [] });
  });

  it('Undo reopens the dataset from its file with its panel; Redo closes it again', async () => {
    const s = useBrowserStore.getState();
    s.pushSnapshot('Before closing napa_hia5', { kind: 'layout' });
    const panelBefore = useBrowserStore.getState().panels.find(p => p.datasetId === 'b')!;
    useBrowserStore.getState().removeDataset('b');
    useBrowserStore.getState().pushSnapshot('Close napa_hia5', { kind: 'layout', coalesceKey: 'close-b', closedDatasets: [serializeDataset(B)] });
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['a']);

    useBrowserStore.getState().undo();
    expect(useBrowserStore.getState().reopeningDatasets).toEqual(['napa_hia5']);
    await settle();
    expect(api.addDataset).toHaveBeenCalledWith('/data/napa_hia5.bam', 'napa_hia5');
    const after = useBrowserStore.getState();
    expect(after.datasets.map(d => d.id)).toEqual(['a', 'b']);
    expect(after.panels.find(p => p.datasetId === 'b')?.id).toBe(panelBefore.id);
    expect(after.reopeningDatasets).toEqual([]);
    expect(after._historyPointer).toBe(0);

    useBrowserStore.getState().redo();
    await settle();
    expect(api.removeDataset).toHaveBeenCalledWith('b');
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['a']);
  });

  it('a dataset that cannot be reopened says so', async () => {
    api.addDataset.mockResolvedValue({ success: false, error: 'Not connected to fbtest' });
    useBrowserStore.getState().pushSnapshot('Before closing napa_hia5', { kind: 'layout' });
    useBrowserStore.getState().removeDataset('b');
    useBrowserStore.getState().pushSnapshot('Close napa_hia5', { kind: 'layout', coalesceKey: 'close-b2', closedDatasets: [serializeDataset(B)] });
    useBrowserStore.getState().undo();
    await settle();
    expect(useBrowserStore.getState().error).toMatch(/napa_hia5: Not connected to fbtest/);
    expect(useBrowserStore.getState().reopeningDatasets).toEqual([]);
  });
  it('Undo then Redo before the reopen finishes still ends with the dataset closed', async () => {
    let finishAdd: () => void = () => {};
    api.addDataset.mockImplementation((path: string, label?: string) => new Promise(resolve => {
      finishAdd = () => resolve({ success: true, dataset: { ...B, path, label: label ?? B.label } });
    }));
    useBrowserStore.getState().pushSnapshot('Before closing napa_hia5', { kind: 'layout' });
    useBrowserStore.getState().removeDataset('b');
    useBrowserStore.getState().pushSnapshot('Close napa_hia5', { kind: 'layout', coalesceKey: 'close-b3', closedDatasets: [serializeDataset(B)] });

    useBrowserStore.getState().undo();
    await vi.waitFor(() => expect(api.addDataset).toHaveBeenCalled(), { timeout: 5000 });
    useBrowserStore.getState().redo(); // the reopen is still waiting on the server
    expect(useBrowserStore.getState()._historyPointer).toBe(1);
    finishAdd();
    await settle();
    const s = useBrowserStore.getState();
    expect(s.datasets.map(d => d.id)).toEqual(['a']);
    expect(api.removeDataset).toHaveBeenCalledWith('b');
    expect(s.reopeningDatasets).toEqual([]);
    expect(s._historyPaused).toBe(false);
  });

  it('two copies of one file stay separate: only the closed copy comes back, and Redo closes only it', async () => {
    const B2 = { ...B, id: 'b_copy', label: 'napa_hia5 (2)' };
    useBrowserStore.getState().addDataset(B2 as never);
    api.addDataset.mockImplementation(async (path: string, label?: string) => ({ success: true, dataset: { ...B2, path, label: label ?? B2.label } }));
    useBrowserStore.getState().pushSnapshot('Before closing napa_hia5 (2)', { kind: 'layout' });
    useBrowserStore.getState().removeDataset('b_copy');
    useBrowserStore.getState().pushSnapshot('Close napa_hia5 (2)', { kind: 'layout', coalesceKey: 'close-b4', closedDatasets: [serializeDataset(B2)] });
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['a', 'b']);

    useBrowserStore.getState().undo();
    await settle();
    expect(api.addDataset).toHaveBeenCalledWith('/data/napa_hia5.bam', 'napa_hia5 (2)');
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['a', 'b', 'b_copy']);

    useBrowserStore.getState().redo();
    await settle();
    expect(api.removeDataset).toHaveBeenCalledTimes(1);
    expect(api.removeDataset).toHaveBeenCalledWith('b_copy');
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['a', 'b']);
  });

  it('a dataset that comes back under a new id is renamed in every history step', async () => {
    api.addDataset.mockImplementation(async (path: string, label?: string) => ({ success: true, dataset: { ...B, id: 'b_1', path, label: label ?? B.label } }));
    useBrowserStore.setState({ clusterFocus: { b: new Set([2]) } } as never);
    useBrowserStore.getState().pushSnapshot('Focus cluster 2 in napa_hia5', { kind: 'layout' });
    useBrowserStore.setState({ clusterFocus: {} } as never);
    useBrowserStore.getState().pushSnapshot('Clear focus', { kind: 'layout', coalesceKey: 'clear' });
    useBrowserStore.getState().removeDataset('b');
    useBrowserStore.getState().pushSnapshot('Close napa_hia5', { kind: 'layout', coalesceKey: 'close-b5', closedDatasets: [serializeDataset(B)] });

    useBrowserStore.getState().undo();
    await settle();
    let s = useBrowserStore.getState();
    expect(s.datasets.map(d => d.id)).toEqual(['a', 'b_1']);
    expect(s.panels.some(p => p.datasetId === 'b_1')).toBe(true);
    expect(s.panels.some(p => p.datasetId === 'b')).toBe(false);
    expect(s._historyStack.every(snap => (snap.state.datasets ?? []).every(d => d.id !== 'b'))).toBe(true);

    // An ordinary earlier step finds the reopened dataset under its new id.
    useBrowserStore.getState().undo();
    await settle();
    s = useBrowserStore.getState();
    expect(s.panels.some(p => p.datasetId === 'b_1')).toBe(true);
    expect(s.clusterFocus.b_1).toEqual(new Set([2]));
    expect(s.clusterFocus.b).toBeUndefined();

    // Redo across the close closes the dataset under its new id.
    useBrowserStore.getState().redo();
    useBrowserStore.getState().redo();
    await settle();
    expect(api.removeDataset).toHaveBeenCalledWith('b_1');
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['a']);
  });

  it('renames dataset ids only where they are ids: never field names, panel ids or read names', () => {
    const state = {
      datasets: [{ id: 'id', label: 'id' }],
      panels: [{ id: 'p1', datasetId: 'id', stateKey: 'id:g1:x' }],
      clusterFocus: { id: [2], 'id:g1:x': [3], other: [1] },
      clusterAssignments: { id: { id: 4, 'id:read': 5 } },
      peakSettings: { id: 1 },
      sessionName: 'id',
    };
    expect(remapDatasetIds(state as never, { id: 'id_1' })).toEqual({
      datasets: [{ id: 'id_1', label: 'id' }],
      panels: [{ id: 'p1', datasetId: 'id_1', stateKey: 'id_1:g1:x' }],
      clusterFocus: { id_1: [2], 'id_1:g1:x': [3], other: [1] },
      clusterAssignments: { id_1: { id: 4, 'id:read': 5 } },
      peakSettings: { id: 1 },
      sessionName: 'id',
    });
  });

  it('two files with one name, both closed: Undo twice reopens both, even when the ids trade places', async () => {
    const S1 = { id: 'sample', label: 'sample', path: '/a/sample.bam', color: '#111111', data_type: 'bam' };
    const S2 = { id: 'sample_1', label: 'sample', path: '/b/sample.bam', color: '#222222', data_type: 'bam' };
    useBrowserStore.setState({ datasets: [], panels: [], _historyStack: [], _historyPointer: -1 } as never);
    useBrowserStore.getState().addDataset(S1 as never);
    useBrowserStore.getState().addDataset(S2 as never);
    // The server hands out the first free id for the file name, like unique_dataset_id.
    api.addDataset.mockImplementation(async (path: string, label?: string) => {
      const open = useBrowserStore.getState().datasets.map(d => d.id);
      const id = !open.includes('sample') ? 'sample' : 'sample_1';
      return { success: true, dataset: { ...(path === S1.path ? S1 : S2), id, label: label ?? 'sample' } };
    });
    useBrowserStore.getState().pushSnapshot('Start', { kind: 'layout' });
    useBrowserStore.getState().removeDataset('sample');
    useBrowserStore.getState().pushSnapshot('Close sample (a)', { kind: 'layout', coalesceKey: 'c1', closedDatasets: [serializeDataset(S1)] });
    useBrowserStore.getState().removeDataset('sample_1');
    useBrowserStore.getState().pushSnapshot('Close sample (b)', { kind: 'layout', coalesceKey: 'c2', closedDatasets: [serializeDataset(S2)] });

    useBrowserStore.getState().undo(); // reopens /b, which now gets the id 'sample'
    await settle();
    useBrowserStore.getState().undo(); // must still reopen /a
    await settle();
    const s = useBrowserStore.getState();
    expect(api.addDataset).toHaveBeenCalledTimes(2);
    expect(s.datasets.map(d => d.path).sort()).toEqual(['/a/sample.bam', '/b/sample.bam']);
    expect(new Set(s.datasets.map(d => d.id)).size).toBe(2);
    expect(s.panels.filter(p => p.contentType === 'dataset').map(p => p.datasetId).sort()).toEqual(s.datasets.map(d => d.id).sort());
  });

  it('jumping back across both closes at once still reopens both files with one name', async () => {
    const S1 = { id: 'sample', label: 'sample', path: '/a/sample.bam', color: '#111111', data_type: 'bam' };
    const S2 = { id: 'sample_1', label: 'sample', path: '/b/sample.bam', color: '#222222', data_type: 'bam' };
    useBrowserStore.setState({ datasets: [], panels: [], _historyStack: [], _historyPointer: -1 } as never);
    useBrowserStore.getState().addDataset(S1 as never);
    useBrowserStore.getState().addDataset(S2 as never);
    api.addDataset.mockImplementation(async (path: string, label?: string) => {
      const open = useBrowserStore.getState().datasets.map(d => d.id);
      const id = !open.includes('sample') ? 'sample' : 'sample_1';
      return { success: true, dataset: { ...(path === S1.path ? S1 : S2), id, label: label ?? 'sample' } };
    });
    useBrowserStore.getState().pushSnapshot('Start', { kind: 'layout' });
    useBrowserStore.getState().removeDataset('sample');
    useBrowserStore.getState().pushSnapshot('Close sample (a)', { kind: 'layout', coalesceKey: 'd1', closedDatasets: [serializeDataset(S1)] });
    useBrowserStore.getState().removeDataset('sample_1');
    useBrowserStore.getState().pushSnapshot('Close sample (b)', { kind: 'layout', coalesceKey: 'd2', closedDatasets: [serializeDataset(S2)] });

    useBrowserStore.getState().restoreSnapshot(0); // one jump back across both closes
    await settle();
    const s = useBrowserStore.getState();
    expect(api.addDataset).toHaveBeenCalledTimes(2);
    expect(s.datasets.map(d => d.path).sort()).toEqual(['/a/sample.bam', '/b/sample.bam']);
    expect(new Set(s.datasets.map(d => d.id)).size).toBe(2);
  });

  it('cluster-tree branches keep their per-dataset results under the new id', () => {
    const state = {
      clusterTreeNodes: {
        n1: { id: 'n1', name: 'b', assignments: { b: { r1: 0 } }, order: { b: [0] }, focus: { 'b:g:x': [1] }, readScope: { b: ['r1'] }, patterns: { 0: [1] } },
      },
    };
    expect(remapDatasetIds(state as never, { b: 'b_1' })).toEqual({
      clusterTreeNodes: {
        n1: { id: 'n1', name: 'b', assignments: { b_1: { r1: 0 } }, order: { b_1: [0] }, focus: { 'b_1:g:x': [1] }, readScope: { b_1: ['r1'] }, patterns: { 0: [1] } },
      },
    });
  });

  // 2026-09-30 UI audit H6: Undo of Close brought the reads back without the footprint-class track.
  it('Undo of a close puts back the class-run layers and loaded layer bundles', async () => {
    const classLayers = {
      tf_rc: { id: 'tf_rc', label: 'Footprint classes', kind: 'consensus-workflow', consensus_job_id: 'job1' },
      tf_cr_manual: { id: 'tf_cr_manual', label: 'Manual footprint groups', kind: 'consensus-workflow', consensus_job_id: 'job1' },
      fp_bundle: { id: 'fp_bundle', label: 'Bundle', bundle_path: '/data/extra.fiberlayers.bb' },
    };
    const withLayers = { ...B, derived_layers: classLayers, available_layers: { tf_rc: true } };
    useBrowserStore.setState({ error: null } as never);
    useBrowserStore.getState().removeDataset('b');
    useBrowserStore.getState().addDataset(withLayers as never);
    // The reopened file brings no derived layers; the server has them once re-attached.
    api.addDataset.mockImplementation(async (path: string, label?: string) => ({ success: true, dataset: { ...B, path, label: label ?? B.label, derived_layers: {} } }));
    api.getDatasets.mockResolvedValue({ datasets: [{ ...B, derived_layers: classLayers, available_layers: { tf_rc: true } }] });
    useBrowserStore.getState().pushSnapshot('Before closing napa_hia5', { kind: 'layout' });
    useBrowserStore.getState().removeDataset('b');
    useBrowserStore.getState().pushSnapshot('Close napa_hia5', { kind: 'layout', coalesceKey: 'close-layers', closedDatasets: [serializeDataset(withLayers)] });

    useBrowserStore.getState().undo();
    await settle();
    expect(layerApi.activateConsensus).toHaveBeenCalledTimes(1);
    expect(layerApi.activateConsensus).toHaveBeenCalledWith('job1');
    expect(layerApi.loadDerivedLayers).toHaveBeenCalledWith('/data/extra.fiberlayers.bb', ['b']);
    const reopened = useBrowserStore.getState().datasets.find(d => d.id === 'b') as { derived_layers?: Record<string, unknown> };
    expect(Object.keys(reopened.derived_layers ?? {}).sort()).toEqual(['fp_bundle', 'tf_cr_manual', 'tf_rc']);
    expect(useBrowserStore.getState().error ?? null, String(useBrowserStore.getState().error)).toBeNull();
  });

  it('a newer class run stays: its layers are not replaced by the closed dataset\'s run', async () => {
    const withLayers = { ...B, derived_layers: { tf_rc: { id: 'tf_rc', kind: 'consensus-workflow', consensus_job_id: 'old' } } };
    useBrowserStore.setState({ datasets: [], panels: [], error: null, _lastRestoreTime: 0 } as never);
    useBrowserStore.getState().addDataset({ ...A, derived_layers: { tf_rc: { id: 'tf_rc', kind: 'consensus-workflow', consensus_job_id: 'new' } } } as never);
    useBrowserStore.getState().pushSnapshot('Start', { kind: 'layout' });
    useBrowserStore.getState().pushSnapshot('Close napa_hia5', { kind: 'layout', coalesceKey: 'close-old', closedDatasets: [serializeDataset(withLayers)] });
    useBrowserStore.getState().undo();
    await settle();
    expect(layerApi.activateConsensus).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().error).toMatch(/footprint classes not shown again/);
  });
});

describe('undo of closing a dataset with its own reference (fb-r2-integ 4)', () => {
  const dm6 = { key: 'dm6', label: 'dm6', kind: 'registry', genome_id: 'dm6', assembly: 'dm6', fasta_path: '/g/dm6.fa',
    gtf_path: null, has_fasta: true, has_gtf: true, gene_count: 10, n_chroms: 1, chroms: [{ name: 'chr2L', size: 23_513_712 }] };
  let serverAssignments: Record<string, string> = {};

  beforeEach(() => {
    serverAssignments = { b: 'dm6' };
    api.addDataset.mockReset().mockImplementation(async (path: string, label?: string) => ({ success: true, dataset: { ...B, id: 'b_1', path, label: label ?? B.label } }));
    api.removeDataset.mockReset().mockResolvedValue({ success: true });
    api.getDatasets.mockReset().mockResolvedValue({ datasets: [] });
    genomeApi.attachPanelGenome.mockReset().mockImplementation(async (req: { dataset_ids: string[] }) => {
      for (const id of req.dataset_ids) serverAssignments[id] = 'dm6';
      return { success: true, genome: dm6, loci: {} };
    });
    genomeApi.getPanelGenomes.mockReset().mockImplementation(async () => ({
      main: { genome_id: 'hg38', fasta_path: null },
      genomes: Object.keys(serverAssignments).length ? [dm6] : [],
      datasets: { ...serverAssignments },
    }));
    useBrowserStore.setState({ datasets: [], panels: [], _historyStack: [], _historyPointer: -1, reopeningDatasets: [],
      chrom: 'chr1', start: 1_000, end: 2_000 } as never);
    usePanelGenomeStore.setState({ genomes: { dm6: dm6 as never }, assignments: { b: 'dm6' }, ready: true });
    const s = useBrowserStore.getState();
    s.addDataset(A as never);
    s.addDataset(B as never);
    useBrowserStore.setState({ panels: useBrowserStore.getState().panels.map(p => p.datasetId === 'b'
      ? { ...p, genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 5_000, end: 6_000 } } : p) });
  });

  it('records the reference a closed dataset had', () => {
    expect(closedDatasetReference('b')).toEqual({ key: 'dm6', source: { genome_id: 'dm6' } });
    expect(closedDatasetReference('a')).toBeNull();
  });

  it('Undo gives the reopened dataset (under its new id) its reference again; its panel keeps it and its locus', async () => {
    useBrowserStore.getState().pushSnapshot('Before closing napa_hia5', { kind: 'layout' });
    const reference = closedDatasetReference('b');
    useBrowserStore.getState().removeDataset('b');
    // The server dropped the assignment (and the context) with the dataset.
    delete serverAssignments.b;
    usePanelGenomeStore.setState({ assignments: {} });
    useBrowserStore.getState().pushSnapshot('Close napa_hia5', { kind: 'layout', coalesceKey: 'close-b-ref',
      closedDatasets: [{ ...serializeDataset(B), ...(reference ? { reference } : {}) }] });

    useBrowserStore.getState().undo();
    await settle();
    expect(genomeApi.attachPanelGenome).toHaveBeenCalledWith(expect.objectContaining({ dataset_ids: ['b_1'], genome_id: 'dm6' }));
    expect(usePanelGenomeStore.getState().assignments).toEqual({ b_1: 'dm6' });
    // The panel sync (usePanelGenomeSync) keeps the restored panel on its reference.
    usePanelGenomeStore.getState().applyAssignments();
    const panel = useBrowserStore.getState().panels.find(p => p.datasetId === 'b_1')!;
    expect(panel.genome).toBe('dm6');
    expect(panel.viewportOverride).toEqual({ chrom: 'chr2L', start: 5_000, end: 6_000 });
  });

  it('a contigs-only reference follows its dataset\'s new id in history', () => {
    const state = { panels: [{ id: 'p1', datasetId: 'b', genome: 'contigs:b' }, { id: 'p2', datasetId: 'a', genome: 'dm6' }] };
    expect(remapDatasetIds(state, { b: 'b_1' }).panels).toEqual([
      { id: 'p1', datasetId: 'b_1', genome: 'contigs:b_1' }, { id: 'p2', datasetId: 'a', genome: 'dm6' }]);
  });

  it('a reference that comes back under another key keeps the panel on it and at its locus (review)', async () => {
    const refA = { ...dm6, key: 'fasta:ref-2', label: 'ref', kind: 'fasta', genome_id: null, fasta_path: '/refs/b/ref.fa' };
    const refNew = { ...refA, key: 'fasta:ref' };
    usePanelGenomeStore.setState({ genomes: { 'fasta:ref-2': refA as never }, assignments: { b: 'fasta:ref-2' } });
    useBrowserStore.setState({ panels: useBrowserStore.getState().panels.map(p => p.datasetId === 'b' ? { ...p, genome: 'fasta:ref-2' } : p) });
    genomeApi.attachPanelGenome.mockImplementation(async (req: { dataset_ids: string[] }) => {
      for (const id of req.dataset_ids) serverAssignments[id] = 'fasta:ref';
      return { success: true, genome: refNew, loci: {} };
    });
    genomeApi.getPanelGenomes.mockImplementation(async () => ({ main: { genome_id: 'hg38', fasta_path: null },
      genomes: [refNew], datasets: { ...serverAssignments } }));
    useBrowserStore.getState().pushSnapshot('Before closing napa_hia5', { kind: 'layout' });
    const reference = closedDatasetReference('b');
    expect(reference).toEqual({ key: 'fasta:ref-2', source: { fasta_path: '/refs/b/ref.fa' } });
    useBrowserStore.getState().removeDataset('b');
    serverAssignments = {};
    usePanelGenomeStore.setState({ assignments: {} });
    useBrowserStore.getState().pushSnapshot('Close napa_hia5', { kind: 'layout', coalesceKey: 'close-b-ref2',
      closedDatasets: [{ ...serializeDataset(B), ...(reference ? { reference } : {}) }] });

    useBrowserStore.getState().undo();
    await settle();
    usePanelGenomeStore.getState().applyAssignments();
    const panel = useBrowserStore.getState().panels.find(p => p.datasetId === 'b_1')!;
    expect(panel.genome).toBe('fasta:ref');
    expect(panel.viewportOverride).toEqual({ chrom: 'chr2L', start: 5_000, end: 6_000 });
  });
});
