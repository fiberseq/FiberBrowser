/**
 * Codex review of H4: the "untouched default" flag of Min footprints must
 * survive undo/session save and restore; a restored value without it is the
 * user's (a saved, deliberately chosen 5 must never switch itself off).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from './browserStore';
import { serializeState } from './historySlice';
import { minFootprintsNoticeApplies } from './uiSlice';
import { applyImportedState } from '../api/session';

describe('Min footprints auto flag across saves', () => {
  beforeEach(() => {
    useBrowserStore.setState({ minFootprints: 5, minFootprintsAuto: true } as any);
  });

  it('is part of the saved state', () => {
    expect(serializeState(useBrowserStore.getState()).minFootprintsAuto).toBe(true);
    useBrowserStore.getState().setMinFootprints(5);
    expect(serializeState(useBrowserStore.getState()).minFootprintsAuto).toBe(false);
  });

  it('a session saved without it restores the value as the user\'s', () => {
    applyImportedState({ frontend: { minFootprints: 5 } });
    expect(useBrowserStore.getState().minFootprintsAuto).toBe(false);
    expect(useBrowserStore.getState().relaxDefaultMinFootprints({ datasetId: 'd', label: 'd', hidden: 100 })).toBe(false);
  });

  it('a session saved with the untouched default keeps it', () => {
    useBrowserStore.setState({ minFootprintsAuto: false } as any);
    applyImportedState({ frontend: { minFootprints: 5, minFootprintsAuto: true } });
    expect(useBrowserStore.getState().minFootprintsAuto).toBe(true);
  });
});

// Codex integration review (fb24, L5): after the auto-off, going back through the
// history restored Min footprints = 5 but kept "Min footprints is off" on the reads.
describe('Min footprints notice across history', () => {
  const notice = { datasetId: 'd', label: 'd', hidden: 100 };

  it('is cleared when a restore turns Min footprints back on', () => {
    const store = useBrowserStore;
    store.setState({ minFootprints: 5, minFootprintsAuto: true, minFootprintsNotice: null, start: 100, end: 200 } as any);
    store.getState().pushSnapshot('Navigate to the long-read locus', { kind: 'navigation' });
    const index = store.getState()._historyStack.length - 1;
    store.setState({ start: 5000, end: 5200 } as any);
    expect(store.getState().relaxDefaultMinFootprints(notice)).toBe(true);
    expect(store.getState().minFootprintsNotice).toEqual(notice);
    store.getState().restoreSnapshot(index, { restoreViewport: true });
    expect(store.getState().minFootprints).toBe(5);
    expect(store.getState().minFootprintsNotice).toBeNull();
  });

  it('a restore that keeps it off keeps the notice', () => {
    const store = useBrowserStore;
    store.getState().clearHistory();
    // (a push just after a restore is taken for its echo and dropped)
    store.setState({ minFootprints: 0, minFootprintsAuto: false, minFootprintsNotice: notice, _lastRestoreTime: 0 } as any);
    store.getState().pushSnapshot('Navigate', { kind: 'navigation' });
    expect(store.getState()._historyStack.at(-1)?.state.minFootprints).toBe(0);
    store.getState().restoreSnapshot(store.getState()._historyStack.length - 1);
    expect(store.getState().minFootprintsNotice).toEqual(notice);
  });

  it('shows only while Min footprints is off, on its own dataset', () => {
    expect(minFootprintsNoticeApplies(notice, 'd', 0)).toBe(true);
    expect(minFootprintsNoticeApplies(notice, 'd', 5)).toBe(false);
    expect(minFootprintsNoticeApplies(notice, 'other', 0)).toBe(false);
    expect(minFootprintsNoticeApplies(null, 'd', 0)).toBe(false);
  });
});
