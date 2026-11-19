import { describe, expect, it } from 'vitest';
import { applyImportedState, collectFrontendState } from './session';
import { useBrowserStore } from '../stores/browserStore';
import { deserializeSavedState, serializeState } from '../stores/historySlice';
import { DEFAULT_MIN_FOOTPRINTS, MIN_FOOTPRINTS_ALL_READS } from '../stores/uiSlice';

const session = { datasets: [], overlays: [], has_fasta: false, viewport: { chrom: 'chr1', start: 0, end: 500 } };

describe('Min footprints "All reads, including uncalled" in sessions and history', () => {
  it('saves and restores the choice like the threshold', () => {
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    const saved = collectFrontendState();
    expect(saved.minFootprints).toBe(MIN_FOOTPRINTS_ALL_READS);
    useBrowserStore.getState().setMinFootprints(3);
    applyImportedState({ ...session, frontend: saved });
    expect(useBrowserStore.getState().minFootprints).toBe(MIN_FOOTPRINTS_ALL_READS);
  });

  it('a session that saved 0 loads as 0 (every called read), not the last choice', () => {
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    applyImportedState({ ...session, frontend: { minFootprints: 0 } });
    expect(useBrowserStore.getState().minFootprints).toBe(0);
  });

  it('a session without a saved value keeps uncalled reads hidden', () => {
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    applyImportedState({ ...session, frontend: {} });
    expect(useBrowserStore.getState().minFootprints).toBe(DEFAULT_MIN_FOOTPRINTS);
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    applyImportedState(session);
    expect(useBrowserStore.getState().minFootprints).not.toBe(MIN_FOOTPRINTS_ALL_READS);
    // A threshold the open session set stays when the imported one has none (as before).
    useBrowserStore.getState().setMinFootprints(7);
    applyImportedState({ ...session, frontend: {} });
    expect(useBrowserStore.getState().minFootprints).toBe(7);
  });

  it('round-trips through history snapshots', () => {
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    const snapshot = serializeState(useBrowserStore.getState());
    expect(snapshot.minFootprints).toBe(MIN_FOOTPRINTS_ALL_READS);
    expect(deserializeSavedState(snapshot).minFootprints).toBe(MIN_FOOTPRINTS_ALL_READS);
    expect('hideUncalledReads' in snapshot).toBe(false);
    useBrowserStore.getState().setMinFootprints(DEFAULT_MIN_FOOTPRINTS);
  });
});

describe('the threshold "All reads, including uncalled" returns to', () => {
  it('is saved and restored with the session: 7 → All reads → save/reopen → leave returns 7', () => {
    useBrowserStore.getState().setMinFootprints(7);
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    const saved = collectFrontendState();
    expect(saved.minFootprintsBeforeAllReads).toBe(7);
    // Another session in between leaves its own value behind.
    useBrowserStore.getState().setMinFootprints(2);
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    applyImportedState({ ...session, frontend: saved });
    expect(useBrowserStore.getState().minFootprints).toBe(MIN_FOOTPRINTS_ALL_READS);
    useBrowserStore.getState().leaveAllReadsMinFootprints();
    expect(useBrowserStore.getState().minFootprints).toBe(7);
  });

  it('a session without it never takes another session\'s value', () => {
    useBrowserStore.getState().setMinFootprints(2);
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    applyImportedState({ ...session, frontend: { minFootprints: MIN_FOOTPRINTS_ALL_READS } });
    useBrowserStore.getState().leaveAllReadsMinFootprints();
    expect(useBrowserStore.getState().minFootprints).toBe(DEFAULT_MIN_FOOTPRINTS);
    applyImportedState({ ...session, frontend: { minFootprints: 9 } });
    expect(useBrowserStore.getState().minFootprintsBeforeAllReads).toBe(9);
  });

  it('round-trips through history snapshots (older snapshots: the saved threshold)', () => {
    useBrowserStore.getState().setMinFootprints(6);
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    const snapshot = serializeState(useBrowserStore.getState());
    expect(deserializeSavedState(snapshot).minFootprintsBeforeAllReads).toBe(6);
    const older = { ...snapshot, minFootprints: 4 } as Record<string, unknown>;
    delete older.minFootprintsBeforeAllReads;
    expect(deserializeSavedState(older as unknown as typeof snapshot).minFootprintsBeforeAllReads).toBe(4);
    useBrowserStore.getState().setMinFootprints(DEFAULT_MIN_FOOTPRINTS);
  });
});
