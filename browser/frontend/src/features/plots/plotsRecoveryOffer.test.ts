/** 3.1.0 audit (recheck): plots-only work (a kept Gallery card, a changed builder) makes no history step, yet it is
 *  work worth recovering after a crash: the recovery offer must count it (no restored work forced here). */
import '../testSetup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/historyStorage', async (orig) => ({
  ...(await orig<typeof import('../../stores/historyStorage')>()),
  saveAutoSave: vi.fn(async () => {}), loadAutoSave: vi.fn(async () => null),
}));
vi.mock('../../api/reference', async (orig) => ({ ...(await orig<typeof import('../../api/reference')>()), getGenomeDeclarations: vi.fn(async () => []) }));
vi.mock('../../utils/launchSession', async (orig) => ({
  ...(await orig<typeof import('../../utils/launchSession')>()),
  getLaunchInfo: vi.fn(async () => ({ boot_id: 'run', previous_exit: 'none', previous_boot_id: null })),
  launchOfferPending: () => false,
}));

import { hasRestoredWork, saveAutoSave } from '../../stores/historyStorage';
import { autoSaveNow } from '../../hooks/useAutoSave';
import { autoSaveHasWork } from '../../components/controls/CrashRecoveryBanner';
import { useBrowserStore } from '../../stores/browserStore';
import { decideLaunchOffer, setLaunchUi } from '../../utils/launchSession';
import { newPlot } from './plotModel';
import { emptyPlotsWorkspace } from './plotsState';
import { emptyGallery, keepEntry, recordInGallery, useGalleryStore, type GalleryInput } from './gallery';
import type { SerializedState } from '../../stores/historySlice';

const mocked = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const sizeData = { matrix: [[1, 2]], size_min: 10, size_max: 30, size_bin: 10, pos_bin: 10, mode: 'span', normalization: 'row',
  row_min_footprints: 20, sigma_size_bp: 10, sigma_pos_bp: 20, group_by: 'all', n_reads: 5, n_footprints: 50 } as never;
const input = (): GalleryInput => ({ plot: newPlot({ name: 'Kept plot' }), computedFor: { chrom: 'chr1', start: 100, end: 2100, genome: null },
  requestKey: 'k1', byPanel: { p1: { '-1': sizeData } }, items: [{ id: 'p1|all', title: 'D1' }], thumb: '', datasets: ['D1'] });
const CRASH = { boot_id: 'next', previous_exit: 'crash', previous_boot_id: 'run' } as never;

async function savedAfterCrash(): Promise<{ state: SerializedState; acted: boolean; bootId: string }> {
  await autoSaveNow();
  const [state, acted, bootId] = mocked(saveAutoSave).mock.calls.at(-1)!;
  return { state: JSON.parse(JSON.stringify(state)), acted, bootId };
}

describe('the crash-recovery offer counts plots-only work', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLaunchUi({ restoring: false });
    useGalleryStore.setState(emptyGallery(), true);
    // A CLI-loaded dataset, no history step.
    useBrowserStore.setState({ plotsWorkspace: emptyPlotsWorkspace(), _historyStack: [], _historyPointer: -1,
      datasets: [{ id: 'd1', label: 'D1', paths: ['/data/d1.bam'], color: '#111', data_type: 'bam' }] } as never);
    expect(hasRestoredWork()).toBe(false);
  });

  it('a page with nothing done is not offered back', async () => {
    const entry = await savedAfterCrash();
    expect(entry.acted).toBe(false);
    expect(decideLaunchOffer(entry, CRASH, { hasWork: autoSaveHasWork })).toBeNull();
  });

  it('a kept plot is offered back', async () => {
    const recorded = recordInGallery(emptyGallery(), input(), { chrom: 'chr1' });
    useGalleryStore.setState(keepEntry(recorded.gallery, recorded.entry!.id).gallery, true);
    const entry = await savedAfterCrash();
    expect(entry.acted).toBe(false);
    expect(decideLaunchOffer(entry, CRASH, { hasWork: autoSaveHasWork })).toBe('recover');
  });

  it('a working card alone is not; a changed builder is', async () => {
    useGalleryStore.setState(recordInGallery(emptyGallery(), input(), { chrom: 'chr1' }).gallery, true);
    expect(decideLaunchOffer(await savedAfterCrash(), CRASH, { hasWork: autoSaveHasWork })).toBeNull();
    useBrowserStore.getState().updateCurrentPlot({ name: 'My plot' });
    expect(decideLaunchOffer(await savedAfterCrash(), CRASH, { hasWork: autoSaveHasWork })).toBe('recover');
    useBrowserStore.getState().setPlotsWorkspace({ ...emptyPlotsWorkspace(), followDelayMs: 2500 });
    expect(decideLaunchOffer(await savedAfterCrash(), CRASH, { hasWork: autoSaveHasWork })).toBe('recover');
  });
});
