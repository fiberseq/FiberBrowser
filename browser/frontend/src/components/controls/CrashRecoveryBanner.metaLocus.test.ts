/** 3.1.0 audit: the autosave keeps the open meta-locus (its pool's spec and working set) and crash recovery reopens
 *  its pool, with its datasets under their reopened ids; when the pool cannot come back the view falls back to the
 *  last real locus with a message instead of an empty meta contig. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/historyStorage', async (orig) => ({
  ...(await orig<typeof import('../../stores/historyStorage')>()),
  saveAutoSave: vi.fn(async () => {}), loadAutoSave: vi.fn(async () => null), hasRestoredWork: () => true,
}));
vi.mock('../../api/reference', async (orig) => ({ ...(await orig<typeof import('../../api/reference')>()), getGenomeDeclarations: vi.fn(async () => []) }));
vi.mock('../../utils/launchSession', async (orig) => ({
  ...(await orig<typeof import('../../utils/launchSession')>()),
  getLaunchInfo: vi.fn(async () => ({ boot_id: 'run', previous_exit: 'none', previous_boot_id: null })),
  launchOfferPending: () => false,
}));
vi.mock('../../api/datasets', async (orig) => ({ ...(await orig<typeof import('../../api/datasets')>()), getDatasets: vi.fn(async () => ({ datasets: [] })), addDataset: vi.fn() }));
vi.mock('../../api/panelGenomes', async (orig) => ({ ...(await orig<typeof import('../../api/panelGenomes')>()),
  getPanelGenomes: vi.fn(async () => ({ main: { genome_id: null, fasta_path: null }, genomes: [], datasets: {} })) }));
vi.mock('../../api/consensusWorkflow', async (orig) => ({ ...(await orig<typeof import('../../api/consensusWorkflow')>()),
  getConsensusJobs: vi.fn(async () => ({ active_job: null, jobs: [] })) }));
vi.mock('../../features/metaLocus/api', async (orig) => ({ ...(await orig<typeof import('../../features/metaLocus/api')>()), startMetaLocusPool: vi.fn(),
  setMetaLocusView: vi.fn(), probeMetaLocusPool: vi.fn(async () => ({ success: true, cached: false })) }));

import { saveAutoSave } from '../../stores/historyStorage';
import { autoSaveNow } from '../../hooks/useAutoSave';
import { setLaunchUi } from '../../utils/launchSession';
import { useBrowserStore } from '../../stores/browserStore';
import { probeMetaLocusPool, setMetaLocusView, startMetaLocusPool } from '../../features/metaLocus/api';
import { getDatasets } from '../../api/datasets';
import { resetMetaLocusForTests, useMetaLocusStore } from '../../features/metaLocus/metaLocusStore';
import { restoreMetaLocusAfterRecovery, restoreSnapshot } from './CrashRecoveryBanner';
import type { SerializedState } from '../../stores/historySlice';

const mocked = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const REAL = { chrom: 'chr2L', start: 1000, end: 5000 };

describe('meta-locus in autosave and crash recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLaunchUi({ restoring: false });
    resetMetaLocusForTests();
    useBrowserStore.setState({ chrom: 'chr2L', start: 1, end: 100, error: null, datasets: [] } as never);
  });

  it('the autosave carries the pool spec and working set', async () => {
    useMetaLocusStore.setState({ spec: { bed_path: '/beds/sites.bed', name: 'Sites', anchor: 'centre', flank_bp: 1500, dataset_ids: ['a'] },
      seed: 3, count: 40, lastRealLocus: REAL });
    await autoSaveNow();
    const saved = mocked(saveAutoSave).mock.calls[0][0] as SerializedState;
    expect(saved.metaLocus).toMatchObject({ bed_path: '/beds/sites.bed', flank_bp: 1500, dataset_ids: ['a'], seed: 3, count: 40, lastRealLocus: REAL });
  });

  it('recovery reopens the pool with the datasets under their reopened ids', async () => {
    mocked(startMetaLocusPool).mockResolvedValue({ status: 'error', error: 'the BED is gone' });
    useBrowserStore.setState({ chrom: 'meta:old-pool', start: 0, end: 3000 } as never);
    await restoreMetaLocusAfterRecovery({ bed_path: '/beds/sites.bed', anchor: 'centre', flank_bp: 1500, dataset_ids: ['a'],
      seed: 3, count: 40, extra_entries: [], lastRealLocus: REAL }, 'meta:old-pool', { a: 'a_new' });
    expect(mocked(startMetaLocusPool).mock.calls[0][0]).toMatchObject({ bed_path: '/beds/sites.bed', dataset_ids: ['a_new'] });
    // the pool did not come back: the last real locus, with the meta-locus notice (not a browser error)
    const s = useBrowserStore.getState();
    expect([s.chrom, s.start, s.end]).toEqual([REAL.chrom, REAL.start, REAL.end]);
    expect(useMetaLocusStore.getState().notice).toMatch(/meta-locus of this session could not be opened: the BED is gone/);
    expect(useMetaLocusStore.getState().error).toBeNull();
    expect(s.error).toBeNull();
  });

  it('recovered added reads (find more / refill) keep their read and site, under the reopened dataset ids', async () => {
    mocked(startMetaLocusPool).mockResolvedValue({ status: 'ready', pool_id: 'p2', spec: { bed_path: '/beds/sites.bed' } });
    mocked(setMetaLocusView).mockResolvedValue({ chrom: 'meta:p2', length: 3000, generation: 1, entries: 0 } as never);
    useBrowserStore.setState({ chrom: 'meta:old-pool', start: 0, end: 3000 } as never);
    await restoreMetaLocusAfterRecovery({ bed_path: '/beds/sites.bed', anchor: 'centre', flank_bp: 1500, dataset_ids: ['a', 'b'],
      seed: 3, count: 40, extra_entries: [['a', 'read1', 4], ['b', 'read2', 7], ['c', 'read3', 1]], lastRealLocus: REAL },
    'meta:old-pool', { a: 'a_new', b: 'b' });
    expect(mocked(setMetaLocusView).mock.calls[0][1]).toMatchObject({
      extra_entries: [['a_new', 'read1', 4], ['b', 'read2', 7], ['c', 'read3', 1]] });
  });

  it('an autosave on the meta contig without a pool falls back cleanly', async () => {
    useBrowserStore.setState({ chrom: 'meta:old-pool', start: 0, end: 3000 } as never);
    useMetaLocusStore.setState({ lastRealLocus: REAL });
    await restoreMetaLocusAfterRecovery(undefined, 'meta:old-pool', {});
    expect(startMetaLocusPool).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().chrom).toBe(REAL.chrom);
    expect(useBrowserStore.getState().error).toMatch(/meta-locus could not be reopened/);
  });

  it('a recovered page on the meta contig reopens its saved pool', async () => {
    mocked(startMetaLocusPool).mockResolvedValue({ status: 'error', error: 'offline' });
    useMetaLocusStore.setState({ spec: { bed_path: '/beds/sites.bed', anchor: 'centre', flank_bp: 1500 }, seed: 2, count: 30, lastRealLocus: REAL });
    useBrowserStore.setState({ chrom: 'meta:p1', start: 0, end: 3000 } as never);
    await autoSaveNow();
    const saved = JSON.parse(JSON.stringify(mocked(saveAutoSave).mock.calls[0][0])) as SerializedState;
    resetMetaLocusForTests();
    useBrowserStore.setState({ chrom: 'chr1', start: 0, end: 10 } as never);
    await restoreSnapshot(saved);
    // (Twice: the probe could not name the pool, so its contig is asked of the pool itself, then the restore reopens it.)
    await vi.waitFor(() => expect(startMetaLocusPool).toHaveBeenCalledTimes(2));
    for (const call of mocked(startMetaLocusPool).mock.calls) expect(call[0]).toMatchObject({ bed_path: '/beds/sites.bed', flank_bp: 1500 });
  });

  it('a pool reopened under another id (datasets under other ids) keeps the zoomed view, clusters and selections', async () => {
    // Saved with the dataset as `sample_1` (an earlier duplicate was open); it reopens as `sample`, so the pool id
    // (which follows the dataset ids) and its contig change.
    const ds = { id: 'sample_1', label: 'Sample', paths: ['/data/sample.bam'], color: '#123456', data_type: 'bam' };
    useMetaLocusStore.setState({ spec: { bed_path: '/beds/sites.bed', name: 'Sites', anchor: 'centre', flank_bp: 1500, dataset_ids: ['sample_1'] },
      seed: 2, count: 30, lastRealLocus: REAL, status: { status: 'ready', pool_id: 'p1', width: 3000, flank_bp: 1500 } as never });
    useBrowserStore.setState({ datasets: [ds], chrom: 'meta:p1', start: 500, end: 1500,
      clusterAssignments: { sample_1: { r1: 0, r2: 1, r3: 1 } }, selectedReadIds: { sample_1: new Set(['r2']) } } as never);
    await autoSaveNow();
    const saved = JSON.parse(JSON.stringify(mocked(saveAutoSave).mock.calls[0][0])) as SerializedState;
    expect(saved.chrom).toBe('meta:p1');

    resetMetaLocusForTests();
    useBrowserStore.setState({ chrom: 'chr1', start: 0, end: 10, datasets: [], clusterAssignments: {}, selectedReadIds: {} } as never);
    mocked(getDatasets).mockResolvedValue({ datasets: [{ ...ds, id: 'sample' }] });
    mocked(probeMetaLocusPool).mockResolvedValue({ success: true, cached: true, pool_id: 'p2' });
    mocked(startMetaLocusPool).mockResolvedValue({ status: 'ready', pool_id: 'p2', chrom: 'meta:p2', width: 3000, flank_bp: 1500,
      spec: { bed_path: '/beds/sites.bed' } });
    mocked(setMetaLocusView).mockResolvedValue({ chrom: 'meta:p2', length: 3000, generation: 1, entries: 0 } as never);
    await restoreSnapshot(saved);
    await vi.waitFor(() => expect(setMetaLocusView).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useMetaLocusStore.getState().busy).toBe(false));
    expect(mocked(probeMetaLocusPool).mock.calls[0][0]).toMatchObject({ bed_path: '/beds/sites.bed', flank_bp: 1500, dataset_ids: ['sample'] });
    expect(mocked(startMetaLocusPool).mock.calls[0][0]).toMatchObject({ dataset_ids: ['sample'] });
    const s = useBrowserStore.getState();
    expect([s.chrom, s.start, s.end]).toEqual(['meta:p2', 500, 1500]);
    expect(s.clusterAssignments).toEqual({ sample: { r1: 0, r2: 1, r3: 1 } });
    expect([...(s.selectedReadIds.sample ?? [])]).toEqual(['r2']);
    expect(s.restoredClusterViewport).toEqual({ chrom: 'meta:p2', start: 500, end: 1500 });
    expect(useMetaLocusStore.getState().status?.pool_id).toBe('p2');
  });

  // 3.1.1 (deferred MED): the contig comes from the pool the restore reopens, not only from the probe. A probe that
  // fails (transiently, or answers without a pool id) used to leave the old contig, and the reopen then moved to the
  // new one and cleared the restored analysis.
  const recoverWithProbe = async (probe: () => Promise<unknown>) => {
    const ds = { id: 'sample_1', label: 'Sample', paths: ['/data/sample.bam'], color: '#123456', data_type: 'bam' };
    useMetaLocusStore.setState({ spec: { bed_path: '/beds/sites.bed', name: 'Sites', anchor: 'centre', flank_bp: 1500, dataset_ids: ['sample_1'] },
      seed: 2, count: 30, lastRealLocus: REAL, status: { status: 'ready', pool_id: 'p1', width: 3000, flank_bp: 1500 } as never });
    useBrowserStore.setState({ datasets: [ds], chrom: 'meta:p1', start: 500, end: 1500,
      clusterAssignments: { sample_1: { r1: 0, r2: 1, r3: 1 } }, selectedReadIds: { sample_1: new Set(['r2']) } } as never);
    await autoSaveNow();
    const saved = JSON.parse(JSON.stringify(mocked(saveAutoSave).mock.calls[0][0])) as SerializedState;
    resetMetaLocusForTests();
    useBrowserStore.setState({ chrom: 'chr1', start: 0, end: 10, datasets: [], clusterAssignments: {}, selectedReadIds: {} } as never);
    mocked(getDatasets).mockResolvedValue({ datasets: [{ ...ds, id: 'sample' }] });
    mocked(probeMetaLocusPool).mockImplementation(probe);
    mocked(startMetaLocusPool).mockResolvedValue({ status: 'ready', pool_id: 'p2', chrom: 'meta:p2', width: 3000, flank_bp: 1500,
      spec: { bed_path: '/beds/sites.bed' } });
    mocked(setMetaLocusView).mockResolvedValue({ chrom: 'meta:p2', length: 3000, generation: 1, entries: 0 } as never);
    await restoreSnapshot(saved);
    await vi.waitFor(() => expect(setMetaLocusView).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useMetaLocusStore.getState().busy).toBe(false));
    const s = useBrowserStore.getState();
    expect([s.chrom, s.start, s.end]).toEqual(['meta:p2', 500, 1500]);
    expect(s.clusterAssignments).toEqual({ sample: { r1: 0, r2: 1, r3: 1 } });
    expect([...(s.selectedReadIds.sample ?? [])]).toEqual(['r2']);
    expect(mocked(startMetaLocusPool).mock.calls[0][0]).toMatchObject({ bed_path: '/beds/sites.bed', dataset_ids: ['sample'] });
  };

  it('a pool-id probe that fails transiently: the reopened pool names the contig and the analysis is kept', async () => {
    await recoverWithProbe(async () => { throw new Error('Failed to fetch'); });
  });

  it('a probe answering without a pool id: the reopened pool names the contig and the analysis is kept', async () => {
    await recoverWithProbe(async () => ({ success: true, cached: false }));
  });

  it('a pool that cannot be named before the restore but reopens elsewhere says the analysis was not kept', async () => {
    useMetaLocusStore.setState({ spec: { bed_path: '/beds/sites.bed', anchor: 'centre', flank_bp: 1500, dataset_ids: ['a'] },
      seed: 2, count: 30, lastRealLocus: REAL, status: { status: 'ready', pool_id: 'p1', width: 3000, flank_bp: 1500 } as never });
    useBrowserStore.setState({ chrom: 'meta:p1', start: 500, end: 1500, clusterAssignments: { a: { r1: 0 } } } as never);
    await autoSaveNow();
    const saved = JSON.parse(JSON.stringify(mocked(saveAutoSave).mock.calls[0][0])) as SerializedState;
    resetMetaLocusForTests();
    useBrowserStore.setState({ chrom: 'chr1', start: 0, end: 10, clusterAssignments: {} } as never);
    mocked(probeMetaLocusPool).mockRejectedValue(new Error('Failed to fetch'));
    mocked(startMetaLocusPool).mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue({ status: 'ready', pool_id: 'p2',
      chrom: 'meta:p2', width: 3000, flank_bp: 1500, spec: { bed_path: '/beds/sites.bed' } });
    mocked(setMetaLocusView).mockResolvedValue({ chrom: 'meta:p2', length: 3000, generation: 1, entries: 0 } as never);
    await restoreSnapshot(saved);
    await vi.waitFor(() => expect(setMetaLocusView).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useMetaLocusStore.getState().busy).toBe(false));
    expect(useBrowserStore.getState().chrom).toBe('meta:p2');
    expect(useMetaLocusStore.getState().notice).toMatch(/reopened as a different pool.*could not be kept/);
  });
});
