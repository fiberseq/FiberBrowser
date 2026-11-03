/** The autosave keeps the session's genome declarations (Codex MED, fb62). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/historyStorage', () => ({
  saveAutoSave: vi.fn(async () => {}), loadAutoSave: vi.fn(async () => null), hasRestoredWork: () => true,
}));
vi.mock('../api/reference', () => ({ getGenomeDeclarations: vi.fn() }));
vi.mock('../utils/launchSession', async (orig) => ({
  ...(await orig<typeof import('../utils/launchSession')>()),
  getLaunchInfo: vi.fn(async () => ({ boot_id: 'run', previous_exit: 'none', previous_boot_id: null })),
  launchOfferPending: () => false,
}));

import { saveAutoSave } from '../stores/historyStorage';
import { getGenomeDeclarations } from '../api/reference';
import { autoSaveNow } from './useAutoSave';
import { setLaunchUi } from '../utils/launchSession';
import { useBrowserStore } from '../stores/browserStore';

const mocked = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

describe('autosave and genome declarations', () => {
  beforeEach(() => { vi.clearAllMocks(); setLaunchUi({ restoring: false }); });

  it('saves the declarations the server has', async () => {
    const declarations = [{ fasta_path: '/data/custom_reference.fa', genome: 'dm6' }];
    mocked(getGenomeDeclarations).mockResolvedValue(declarations);
    await autoSaveNow();
    expect(mocked(saveAutoSave).mock.calls[0][0].genomeDeclarations).toEqual(declarations);
  });

  it('required update saves propagate storage and reference errors and refuse half-restored work', async () => {
    mocked(getGenomeDeclarations).mockResolvedValue([]);
    mocked(saveAutoSave).mockRejectedValueOnce(new Error('Storage full'));
    await expect(autoSaveNow({ required: true })).rejects.toThrow('Storage full');
    mocked(getGenomeDeclarations).mockRejectedValueOnce(new Error('Reference offline'));
    await expect(autoSaveNow({ required: true })).rejects.toThrow('Reference offline');
    setLaunchUi({ restoring: true });
    await expect(autoSaveNow({ required: true })).rejects.toThrow('finish reopening');
  });

  it('saves without them when there are none or the server does not answer', async () => {
    mocked(getGenomeDeclarations).mockResolvedValueOnce([]);
    await autoSaveNow();
    mocked(getGenomeDeclarations).mockRejectedValueOnce(new Error('offline'));
    await autoSaveNow();
    expect(mocked(saveAutoSave)).toHaveBeenCalledTimes(2);
    for (const [state] of mocked(saveAutoSave).mock.calls) expect(state.genomeDeclarations).toBeUndefined();
  });

  it('drains older saves before capturing and committing the required update save', async () => {
    let release!: (value: []) => void;
    mocked(getGenomeDeclarations).mockImplementationOnce(() => new Promise<[]>(resolve => { release = resolve; }))
      .mockResolvedValue([]);
    const commits: number[] = [];
    mocked(saveAutoSave).mockImplementation(async state => { commits.push(state.start); });

    useBrowserStore.setState({ start: 10 });
    const older = autoSaveNow();
    await vi.waitFor(() => expect(getGenomeDeclarations).toHaveBeenCalledTimes(1));
    useBrowserStore.setState({ start: 20 });
    const final = autoSaveNow({ required: true });
    // Edits while the old save drains must be in the final snapshot too.
    useBrowserStore.setState({ start: 30 });
    release([]);
    await Promise.all([older, final]);

    expect(commits).toEqual([10, 30]);
    expect(mocked(saveAutoSave).mock.calls.map(call => call[3])).toEqual([false, true]);
  });

  it('serializes background saves through storage completion too', async () => {
    mocked(getGenomeDeclarations).mockResolvedValue([]);
    let release!: () => void;
    mocked(saveAutoSave).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }))
      .mockResolvedValue(undefined);
    useBrowserStore.setState({ start: 10 });
    const older = autoSaveNow();
    await vi.waitFor(() => expect(saveAutoSave).toHaveBeenCalledTimes(1));
    useBrowserStore.setState({ start: 20 });
    const next = autoSaveNow();
    useBrowserStore.setState({ start: 30 });
    release();
    await Promise.all([older, next]);

    expect(mocked(saveAutoSave).mock.calls.map(call => call[0].start)).toEqual([10, 30]);
  });
});
