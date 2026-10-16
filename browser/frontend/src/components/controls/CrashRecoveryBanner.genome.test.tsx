/**
 * Restore / Reopen must not load the saved genome when the server already has it with its FASTA (3.0.0 audit
 * HIGH-1): with the user's --fasta hg38.fa (genome id hg38 inferred from the name) the restore downloaded the
 * registry hg38 FASTA over it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/datasets', () => ({ getDatasets: vi.fn(), addDataset: vi.fn() }));
vi.mock('../../api/reference', () => ({ loadGenome: vi.fn(), loadFasta: vi.fn(), restoreGenomeDeclarations: vi.fn() }));
vi.mock('../../api/status', () => ({ getStatus: vi.fn() }));
vi.mock('../../api/panelGenomes', () => ({ getPanelGenomes: vi.fn(), attachPanelGenome: vi.fn() }));
vi.mock('../../api/footprints', () => ({ loadDerivedLayers: vi.fn() }));
vi.mock('../../api/consensusWorkflow', () => ({ getConsensusJobs: vi.fn(), activateConsensus: vi.fn() }));

import { getDatasets } from '../../api/datasets';
import { loadFasta, loadGenome, restoreGenomeDeclarations } from '../../api/reference';
import { getStatus } from '../../api/status';
import { attachPanelGenome, getPanelGenomes } from '../../api/panelGenomes';
import { getConsensusJobs } from '../../api/consensusWorkflow';
import { collectFrontendState } from '../../api/session';
import { useBrowserStore } from '../../stores/browserStore';
import type { SerializedState } from '../../stores/historySlice';
import { restoreSnapshot } from './CrashRecoveryBanner';

const mocked = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const USER_FASTA = '/data/reference/hg38.fa';

function saved(overrides: Partial<SerializedState> = {}): SerializedState {
  return { ...collectFrontendState(), datasets: [], chrom: 'chr6', start: 100, end: 200,
    currentGenome: 'hg38', fastaPath: USER_FASTA, ...overrides } as unknown as SerializedState;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useBrowserStore.setState({ datasets: [], panels: [], currentGenome: null, fastaPath: null, hasFasta: false, error: null } as any);
  mocked(getDatasets).mockResolvedValue({ datasets: [] });
  mocked(getPanelGenomes).mockResolvedValue({ main: { genome_id: null, fasta_path: null }, genomes: [], datasets: {} });
  mocked(getConsensusJobs).mockResolvedValue({ active_job: null, jobs: [] });
  mocked(loadGenome).mockResolvedValue({ success: true, genome_id: 'hg38', name: 'Human (hg38)', fasta_loaded: true });
});

describe('restoring a session whose genome the server already has', () => {
  it('keeps the loaded FASTA and never calls loadGenome', async () => {
    mocked(getStatus).mockResolvedValue({ has_fasta: true, current_genome: 'hg38', fasta_path: USER_FASTA });
    await restoreSnapshot(saved());
    expect(loadGenome).not.toHaveBeenCalled();
    expect(loadFasta).not.toHaveBeenCalled();
    const s = useBrowserStore.getState();
    expect([s.currentGenome, s.hasFasta, s.fastaPath]).toEqual(['hg38', true, USER_FASTA]);
    expect(s.chrom).toBe('chr6');
  });

  it('a second restore (another tab, Restore again) does not load it either', async () => {
    mocked(getStatus).mockResolvedValue({ has_fasta: true, current_genome: 'hg38', fasta_path: USER_FASTA });
    await restoreSnapshot(saved());
    await restoreSnapshot(saved());
    expect(loadGenome).not.toHaveBeenCalled();
  });

  it('loads the genome when the server has another one, or the id without a FASTA, or does not answer', async () => {
    mocked(getStatus).mockResolvedValueOnce({ has_fasta: true, current_genome: 'mm10', fasta_path: '/x/mm10.fa' });
    await restoreSnapshot(saved());
    mocked(getStatus).mockResolvedValueOnce({ has_fasta: false, current_genome: 'hg38' });
    await restoreSnapshot(saved());
    mocked(getStatus).mockRejectedValueOnce(new Error('offline'));
    await restoreSnapshot(saved());
    expect(loadGenome).toHaveBeenCalledTimes(3);
    expect(mocked(loadGenome).mock.calls.every(([id]) => id === 'hg38')).toBe(true);
  });
});

describe('genome declarations come back with the session (Codex MED, fb62)', () => {
  it('puts the saved declarations back before the datasets\' own references and analyses', async () => {
    mocked(getStatus).mockResolvedValue({ has_fasta: true, current_genome: 'hg38', fasta_path: USER_FASTA });
    const order: string[] = [];
    mocked(restoreGenomeDeclarations).mockImplementation(async () => { order.push('declarations'); return { success: true, changed: true }; });
    mocked(getDatasets).mockResolvedValue({ datasets: [{ id: 'ins', paths: ['/data/ins.bam'], label: 'ins' }] });
    mocked(getPanelGenomes).mockImplementation(async () => { order.push('dataset references'); return { main: { genome_id: null, fasta_path: null }, genomes: [], datasets: {} }; });
    mocked(attachPanelGenome).mockResolvedValue({ success: true, genome: { key: 'k' } });
    const declarations = [{ fasta_path: '/data/custom_reference.fa', genome: 'dm6' }];
    await restoreSnapshot(saved({
      genomeDeclarations: declarations,
      datasets: [{ id: 'ins', paths: ['/data/ins.bam'], label: 'ins', color: '#000',
        reference: { key: 'k', source: { fasta_path: '/data/custom_reference.fa' } } }] as never,
    }));
    expect(restoreGenomeDeclarations).toHaveBeenCalledWith(declarations);
    expect(order[0]).toBe('declarations');
    expect(order).toContain('dataset references');
  });

  it('a session without declarations sends none', async () => {
    mocked(getStatus).mockResolvedValue({ has_fasta: true, current_genome: 'hg38', fasta_path: USER_FASTA });
    await restoreSnapshot(saved());
    expect(restoreGenomeDeclarations).not.toHaveBeenCalled();
  });
});
