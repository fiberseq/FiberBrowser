/**
 * Reopening a saved session (fb-n2-sessions): the restored page is the history
 * baseline (M9), datasets are matched one to one (Codex 4), a dataset's
 * existing reference is kept only when it is the saved one (Codex 2), a genome
 * that fails to load is not installed by name (Codex 3), saved derived layers
 * come back or are reported (Codex 15), and exclusions come back (Codex 16).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/datasets', () => ({ getDatasets: vi.fn(), addDataset: vi.fn() }));
vi.mock('../../api/reference', () => ({ loadGenome: vi.fn(), loadFasta: vi.fn() }));
vi.mock('../../api/panelGenomes', () => ({ getPanelGenomes: vi.fn(), attachPanelGenome: vi.fn() }));
vi.mock('../../api/footprints', () => ({ loadDerivedLayers: vi.fn() }));
vi.mock('../../api/consensusWorkflow', () => ({ getConsensusJobs: vi.fn(), activateConsensus: vi.fn() }));

import { addDataset, getDatasets } from '../../api/datasets';
import { loadGenome } from '../../api/reference';
import { attachPanelGenome, getPanelGenomes } from '../../api/panelGenomes';
import { loadDerivedLayers } from '../../api/footprints';
import { activateConsensus, getConsensusJobs } from '../../api/consensusWorkflow';
import { collectFrontendState } from '../../api/session';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { serializeState, type SerializedState } from '../../stores/historySlice';
import { autoSaveHasWork, restoreDatasetReferences, restoreSnapshot, startHistoryAtRestoredState } from './CrashRecoveryBanner';

const mocked = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

function savedState(overrides: Partial<SerializedState>): SerializedState {
  return { ...collectFrontendState(), datasets: [], currentGenome: null, fastaPath: null, ...overrides } as unknown as SerializedState;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useReadActionsStore.getState().reset();
  useBrowserStore.setState({
    chrom: 'chr2R', start: 100, end: 200, datasets: [], panels: [], currentGenome: null, fastaPath: null,
    error: null, _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0,
  } as any);
  mocked(getPanelGenomes).mockResolvedValue({ main: { genome_id: null, fasta_path: null }, genomes: [], datasets: {} });
  mocked(getConsensusJobs).mockResolvedValue({ active_job: null, jobs: [] });
});

describe('the reopened session is where Undo stops (M9)', () => {
  it('drops the launch view from history: Undo has nothing to go back to', async () => {
    // The launch view and a navigation the page made before the reopen.
    useBrowserStore.getState().pushSnapshot('Before navigation', { kind: 'navigation' });
    useBrowserStore.setState({ chrom: 'chr19', start: 5, end: 50 } as any);
    useBrowserStore.getState().pushSnapshot('Navigate to chr19:5-50', { kind: 'navigation' });

    const saved = savedState({ chrom: 'chr3L', start: 1000, end: 2000, clusterAssignments: { ds1: { r1: 0 } } as any });
    await restoreSnapshot(saved);
    startHistoryAtRestoredState('Reopened last session');

    const s = useBrowserStore.getState();
    expect(s._historyStack.map(h => h.label)).toEqual(['Reopened last session']);
    expect(s.canUndo()).toBe(false);
    s.undo();
    expect(useBrowserStore.getState().chrom).toBe('chr3L');
    expect(Object.keys(useBrowserStore.getState().clusterAssignments)).toEqual(['ds1']);
    // The view-moved effect echoing the restore is not a step.
    useBrowserStore.getState().pushSnapshot('Navigate to chr3L:1000-2000', { kind: 'navigation' });
    expect(useBrowserStore.getState()._historyStack).toHaveLength(1);
  });
});

describe('exclusions are part of the saved session (Codex 16)', () => {
  it('come back with a reopened session, under the reopened dataset ids', async () => {
    useReadActionsStore.getState().excludeReads('old', ['r1', 'r2']);
    const saved = savedState({
      datasets: [{ id: 'old', label: 'A', paths: ['/data/A.bam'], color: '#000', data_type: 'bam' }],
      chrom: 'chr1', start: 0, end: 100,
    });
    expect(saved.excludedReadIds).toEqual({ old: ['r1', 'r2'] });
    expect(autoSaveHasWork(saved)).toBe(true);
    useReadActionsStore.getState().reset();

    mocked(getDatasets).mockResolvedValueOnce({ datasets: [] }).mockResolvedValue({ datasets: [{ id: 'new', paths: ['/data/A.bam'] }] });
    mocked(addDataset).mockResolvedValue({ success: true, dataset: { id: 'new', paths: ['/data/A.bam'] } });
    await restoreSnapshot(saved);
    expect([...useReadActionsStore.getState().excludedReadIds.new]).toEqual(['r1', 'r2']);
    expect(useReadActionsStore.getState().excludedReadIds.old).toBeUndefined();
  });
});

describe('datasets are matched one to one (Codex 4)', () => {
  it('opens a second copy for the second saved dataset of the same file', async () => {
    const saved = savedState({
      datasets: [
        { id: 'a', label: 'A', paths: ['/data/A.bam'], color: '#111', data_type: 'bam' },
        { id: 'a_1', label: 'A copy', paths: ['/data/A.bam'], color: '#222', data_type: 'bam' },
      ],
      filteredReadIds: { a: ['r1'], a_1: ['r2'] },
    });
    const loaded = [{ id: 'x', paths: ['/data/A.bam'] }];
    mocked(getDatasets).mockResolvedValueOnce({ datasets: loaded })
      .mockResolvedValue({ datasets: [...loaded, { id: 'y', paths: ['/data/A.bam'] }] });
    mocked(addDataset).mockResolvedValue({ success: true, dataset: { id: 'y', paths: ['/data/A.bam'] } });

    await restoreSnapshot(saved);
    expect(addDataset).toHaveBeenCalledTimes(1);
    const { filteredReadIds } = useBrowserStore.getState();
    expect([...(filteredReadIds.x ?? [])]).toEqual(['r1']);
    expect([...(filteredReadIds.y ?? [])]).toEqual(['r2']);
  });
});

describe("a dataset's reference is checked, not assumed (Codex 2)", () => {
  const dataset = {
    id: 'a', label: 'A', paths: ['/data/A.bam'], color: '#111', data_type: 'bam',
    reference: { key: 'dm6', source: { genome_id: 'dm6' } },
  };

  it('keeps the reference the dataset already has when it is the saved one', async () => {
    mocked(getPanelGenomes).mockResolvedValue({
      main: { genome_id: 'hg38', fasta_path: null },
      genomes: [{ key: 'dm6', kind: 'registry', genome_id: 'dm6' }],
      datasets: { a: 'dm6' },
    });
    expect(await restoreDatasetReferences([dataset], { a: 'a' })).toEqual({ dm6: 'dm6' });
    expect(attachPanelGenome).not.toHaveBeenCalled();
  });

  it('attaches the saved reference again when the dataset is on another one now', async () => {
    mocked(getPanelGenomes).mockResolvedValue({
      main: { genome_id: 'hg38', fasta_path: null },
      genomes: [{ key: 'fasta:other', kind: 'fasta', genome_id: null, fasta_path: '/ref/other.fa' }],
      datasets: { a: 'fasta:other' },
    });
    mocked(attachPanelGenome).mockResolvedValue({ success: true, genome: { key: 'dm6' } });
    expect(await restoreDatasetReferences([dataset], { a: 'a' })).toEqual({ dm6: 'dm6' });
    expect(attachPanelGenome).toHaveBeenCalledWith({ dataset_ids: ['a'], genome_id: 'dm6' });
  });

  it('a reference that is the main genome now: the dataset follows it, nothing renamed or reported', async () => {
    mocked(attachPanelGenome).mockResolvedValue({ success: true, genome: null, main: true });
    const problems: string[] = [];
    expect(await restoreDatasetReferences([dataset], { a: 'a' }, problems)).toEqual({});
    expect(problems).toEqual([]);
  });

  it('the main genome is restored before the datasets\' own references (Codex 1)', async () => {
    const order: string[] = [];
    mocked(getDatasets).mockResolvedValue({ datasets: [{ id: 'a', paths: ['/data/A.bam'] }] });
    mocked(loadGenome).mockImplementation(async () => { order.push('main'); return { success: true, genome_id: 'hg38', name: 'hg38' }; });
    mocked(attachPanelGenome).mockImplementation(async () => { order.push('own'); return { success: true, genome: { key: 'dm6' } }; });
    await restoreSnapshot(savedState({ currentGenome: 'hg38', datasets: [dataset], chrom: 'chr1', start: 0, end: 100 }));
    expect(order).toEqual(['main', 'own']);
  });

  it('reports a reference that cannot be attached', async () => {
    mocked(attachPanelGenome).mockResolvedValue({ success: false, error: 'download failed', genome: null });
    const problems: string[] = [];
    expect(await restoreDatasetReferences([dataset], { a: 'a' }, problems)).toEqual({});
    expect(problems.join(' ')).toContain('download failed');
  });
});

describe('a genome that does not load is not installed by name (Codex 3)', () => {
  it('keeps the loaded genome and says what to do', async () => {
    useBrowserStore.setState({ currentGenome: 'dm6' } as any);
    mocked(loadGenome).mockResolvedValue({ success: false, error: 'no network' });
    await restoreSnapshot(savedState({ currentGenome: 'hg38', chrom: 'chr1', start: 0, end: 100 }));
    expect(useBrowserStore.getState().currentGenome).toBe('dm6');
    expect(String(useBrowserStore.getState().error)).toContain('hg38');
    expect(String(useBrowserStore.getState().error)).toContain('genome menu');
  });

  it('installs the saved genome once it loaded', async () => {
    useBrowserStore.setState({ currentGenome: 'dm6' } as any);
    mocked(loadGenome).mockResolvedValue({ success: true, genome_id: 'hg38', name: 'hg38', fasta_loaded: true });
    await restoreSnapshot(savedState({ currentGenome: 'hg38', chrom: 'chr1', start: 0, end: 100 }));
    expect(useBrowserStore.getState().currentGenome).toBe('hg38');
    expect(useBrowserStore.getState().error).toBeNull();
  });
});

describe('saved derived layers come back or are reported (Codex 15)', () => {
  const dataset = {
    id: 'a', label: 'A', paths: ['/data/A.bam'], color: '#111', data_type: 'bam',
    derived_layers: {
      tf_rc: { kind: 'consensus-workflow', consensus_job_id: 'job1' },
      extra: { kind: 'bundle', bundle_path: '/layers/A.fiberlayers' },
    },
  };

  it('loads the bundles again and reports a class run the server no longer has', async () => {
    mocked(getDatasets).mockResolvedValue({ datasets: [{ id: 'a', paths: ['/data/A.bam'] }] });
    mocked(loadDerivedLayers).mockResolvedValue({ success: true });
    await restoreSnapshot(savedState({ datasets: [dataset], chrom: 'chr1', start: 0, end: 100 }));
    expect(loadDerivedLayers).toHaveBeenCalledWith('/layers/A.fiberlayers', ['a']);
    expect(activateConsensus).not.toHaveBeenCalled();
    expect(String(useBrowserStore.getState().error)).toContain('footprint classes of A');
  });

  it('shows a class run again when the server still has it, and the dataset gets its layers', async () => {
    const installed = { tf_rc: { kind: 'consensus-workflow', consensus_job_id: 'job1' }, extra: { kind: 'bundle', bundle_path: '/layers/A.fiberlayers' } };
    mocked(getDatasets)
      .mockResolvedValueOnce({ datasets: [{ id: 'a', paths: ['/data/A.bam'] }] })
      .mockResolvedValueOnce({ datasets: [{ id: 'a', paths: ['/data/A.bam'] }] })
      .mockResolvedValue({ datasets: [{ id: 'a', paths: ['/data/A.bam'], derived_layers: installed, available_layers: { tf_rc: true } }] });
    mocked(loadDerivedLayers).mockResolvedValue({ success: true });
    mocked(getConsensusJobs).mockResolvedValue({ active_job: null, jobs: [{ job_id: 'job1', status: 'complete' }] });
    mocked(activateConsensus).mockResolvedValue({ job_id: 'job1', status: 'complete' });
    await restoreSnapshot(savedState({ datasets: [dataset], chrom: 'chr1', start: 0, end: 100 }));
    expect(activateConsensus).toHaveBeenCalledWith('job1');
    expect(useBrowserStore.getState().error).toBeNull();
    expect((useBrowserStore.getState().datasets[0] as any).derived_layers).toEqual(installed);
  });

  it('a class run is not activated for a dataset that came back under another id (reported instead)', async () => {
    mocked(getDatasets).mockResolvedValueOnce({ datasets: [] }).mockResolvedValue({ datasets: [{ id: 'b', paths: ['/data/A.bam'] }] });
    mocked(addDataset).mockResolvedValue({ success: true, dataset: { id: 'b', paths: ['/data/A.bam'] } });
    mocked(loadDerivedLayers).mockResolvedValue({ success: true });
    mocked(getConsensusJobs).mockResolvedValue({ active_job: null, jobs: [{ job_id: 'job1', status: 'complete' }] });
    await restoreSnapshot(savedState({ datasets: [dataset], chrom: 'chr1', start: 0, end: 100 }));
    expect(loadDerivedLayers).toHaveBeenCalledWith('/layers/A.fiberlayers', ['b']);
    expect(activateConsensus).not.toHaveBeenCalled();
    expect(String(useBrowserStore.getState().error)).toContain('footprint classes of A');
  });
});

describe('the Sort selector choice is saved (L9)', () => {
  it('comes back with a reopened session', async () => {
    useBrowserStore.setState({ sortSelection: 'projection' } as any);
    const saved = savedState({ chrom: 'chr1', start: 0, end: 100 });
    expect(serializeState(useBrowserStore.getState()).sortSelection).toBe('projection');
    useBrowserStore.setState({ sortSelection: null } as any);
    await restoreSnapshot(saved);
    expect(useBrowserStore.getState().sortSelection).toBe('projection');
  });
});
