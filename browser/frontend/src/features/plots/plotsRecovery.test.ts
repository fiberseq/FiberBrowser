/** 3.1.0 audit: autosave keeps the Plots Gallery and the builder, and crash recovery restores both (an undo step
 *  still leaves the builder alone). */
import '../testSetup';
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

import { saveAutoSave } from '../../stores/historyStorage';
import { addDataset, getDatasets } from '../../api/datasets';
import { autoSaveNow } from '../../hooks/useAutoSave';
import { restoreSnapshot } from '../../components/controls/CrashRecoveryBanner';
import { useBrowserStore } from '../../stores/browserStore';
import { setLaunchUi } from '../../utils/launchSession';
import { newPlot } from './plotModel';
import { emptyPlotsWorkspace } from './plotsState';
import { emptyGallery, keepEntry, recordInGallery, useGalleryStore, type GalleryInput } from './gallery';
import type { SerializedState } from '../../stores/historySlice';

const mocked = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const sizeData = { matrix: [[1, 2]], size_min: 10, size_max: 30, size_bin: 10, pos_bin: 10, mode: 'span', normalization: 'row',
  row_min_footprints: 20, sigma_size_bp: 10, sigma_pos_bp: 20, group_by: 'all', n_reads: 5, n_footprints: 50 } as never;
const input = (): GalleryInput => ({ plot: newPlot({ name: 'Kept plot' }), computedFor: { chrom: 'chr1', start: 100, end: 2100, genome: null },
  requestKey: 'k1', byPanel: { p1: { '-1': sizeData } }, items: [{ id: 'p1|all', title: 'D1' }], thumb: '', datasets: ['D1'] });

describe('Plots in autosave and crash recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLaunchUi({ restoring: false });
    useGalleryStore.setState(emptyGallery(), true);
    useBrowserStore.setState({ plotsWorkspace: emptyPlotsWorkspace(), datasets: [] } as never);
  });

  it('autosave carries the Gallery and the builder; recovery puts both back', async () => {
    const recorded = recordInGallery(emptyGallery(), input(), { chrom: 'chr1' });
    const kept = keepEntry(recorded.gallery, recorded.entry!.id).gallery;
    useGalleryStore.setState(kept, true);
    const builder = { ...emptyPlotsWorkspace(), current: newPlot({ name: 'Builder plot' }), followDelayMs: 2500 };
    useBrowserStore.getState().setPlotsWorkspace(builder);

    await autoSaveNow();
    const saved = mocked(saveAutoSave).mock.calls[0][0] as SerializedState;
    expect((saved.plotsGallery as { entries: unknown[] }).entries.length).toBe(kept.entries.length);
    expect(kept.entries.some(e => e.status === 'kept')).toBe(true);

    // A fresh page: nothing in the Gallery, a default builder.
    useGalleryStore.setState(emptyGallery(), true);
    useBrowserStore.setState({ plotsWorkspace: emptyPlotsWorkspace() } as never);
    await restoreSnapshot(JSON.parse(JSON.stringify(saved)));
    expect(useGalleryStore.getState().entries.filter(e => e.status === 'kept').map(e => e.name))
      .toEqual(kept.entries.filter(e => e.status === 'kept').map(e => e.name));
    const ws = useBrowserStore.getState().plotsWorkspace;
    expect(ws.current.name).toBe('Builder plot');
    expect(ws.followDelayMs).toBe(2500);
  });

  it('a dataset reopened under a new id: the cards keep their data and names, their states follow the new id', async () => {
    const recorded = recordInGallery(emptyGallery(), { ...input(), datasets: ['a'] }, { panels: [{ id: 'p1', datasetId: 'a' }],
      datasets: [{ id: 'a', label: 'a', paths: ['/data/a.bam'] }], clusterAssignments: { a: { r1: 1 } } });
    const kept = keepEntry(recorded.gallery, recorded.entry!.id).gallery;
    useGalleryStore.setState(kept, true);
    useBrowserStore.setState({ datasets: [{ id: 'a', label: 'a', paths: ['/data/a.bam'], color: '#111', data_type: 'bam' }] } as never);
    await autoSaveNow();
    const saved = JSON.parse(JSON.stringify(mocked(saveAutoSave).mock.calls[0][0])) as SerializedState;
    useGalleryStore.setState(emptyGallery(), true);
    mocked(getDatasets).mockResolvedValueOnce({ datasets: [] }).mockResolvedValue({ datasets: [{ id: 'a_new', paths: ['/data/a.bam'] }] });
    mocked(addDataset).mockResolvedValue({ success: true, dataset: { id: 'a_new', paths: ['/data/a.bam'] } });
    await restoreSnapshot(saved);
    const g = useGalleryStore.getState();
    const card = g.entries.find(e => e.status === 'kept')!;
    expect(card.datasets).toEqual(['a']);
    expect(Object.keys(card.data)).toEqual(Object.keys(kept.entries.find(e => e.status === 'kept')!.data));
    expect(card.items.map(i => i.id)).toEqual(['p1|all']);
    expect(JSON.stringify(g.states[card.stateId])).toContain('"datasetId":"a_new"');
    // The state's own dataset list and dataset-keyed records follow the new id too (each state remapped whole).
    const st = g.states[card.stateId] as { datasets: Array<{ id: string }>; clusterAssignments: Record<string, unknown> };
    expect(st.datasets.map(d => d.id)).toEqual(['a_new']);
    expect(Object.keys(st.clusterAssignments)).toEqual(['a_new']);
    expect(Object.keys(g.states)).toEqual(Object.keys(kept.states));
  });
});
