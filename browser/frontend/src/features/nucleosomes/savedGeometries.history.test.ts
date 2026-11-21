/** Undoing or redoing a saved geometry's star changes only the saved list: no read repaint, nothing else replaced. */
import { describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { deserializeSavedState, restoreDelta, sameRestoredValue, serializeState } from '../../stores/historySlice';
import { registerSavedGeometries } from './savedGeometries';

describe('restoreDelta', () => {
  it('keeps only the fields that differ, Sets and Maps compared by content', () => {
    const state = { a: new Set(['x']), b: new Map([['k', [1, 2]]]), c: { d: [1] }, e: 1, refreshGeneration: 0 } as never;
    const same = restoreDelta({ a: new Set(['x']), b: new Map([['k', [1, 2]]]), c: { d: [1] }, e: 1 } as never, state, new Set());
    expect(same).toEqual({ patch: {}, refresh: false });
    const changed = restoreDelta({ a: new Set(['y']), e: 1 } as never, state, new Set());
    expect(Object.keys(changed.patch)).toEqual(['a']);
    expect(changed.refresh).toBe(true);
    expect(restoreDelta({ e: 2 } as never, state, new Set(['e'])).refresh).toBe(false);
    expect(sameRestoredValue(new Set([1]), [1])).toBe(false);
    expect(sameRestoredValue({ a: undefined }, {})).toBe(false);
  });
});

describe('saved geometry undo', () => {
  it('restores the saved list alone, without bumping refreshGeneration', () => {
    vi.useFakeTimers();
    try {
      registerSavedGeometries();
      const store = useBrowserStore;
      store.getState().clearHistory?.();
      store.setState({ savedNucGeometries: [] } as never);
      // The state as a restore gives it back (a running app's state after its first restore or session load).
      store.setState(deserializeSavedState(serializeState(store.getState())) as never);
      store.getState().pushSnapshot('Before', { kind: 'analysis', explicit: true } as never);
      vi.advanceTimersByTime(5000);
      store.getState().addSavedNucGeometry({ label: 'G1', kind: 'high', chrom: 'chrX', start: 1000, end: 5000,
        openLeft: false, openRight: false, color: '#e11d48', shares: {}, tolBp: 0 } as never);
      store.getState().pushSnapshot('Save geometry', { kind: 'analysis', explicit: true } as never);
      expect(store.getState()._historyStack.length).toBeGreaterThanOrEqual(2);
      const before = store.getState();
      const generation = before.refreshGeneration;
      store.getState().undo();
      const after = store.getState();
      expect(after.savedNucGeometries).toEqual([]);
      expect(after.refreshGeneration).toBe(generation);
      expect(after.panels).toBe(before.panels);
      expect(after.datasets).toBe(before.datasets);
      expect(after.enabledModTypes).toBe(before.enabledModTypes);
      store.getState().redo();
      expect(store.getState().savedNucGeometries).toHaveLength(1);
      expect(store.getState().refreshGeneration).toBe(generation);
    } finally {
      vi.useRealTimers();
      useBrowserStore.setState({ savedNucGeometries: [] } as never);
    }
  });
});
