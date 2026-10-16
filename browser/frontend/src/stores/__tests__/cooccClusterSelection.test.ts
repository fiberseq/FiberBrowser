import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore, ensureBuiltinPanelsRegistered } from './helpers';
import { serializeState } from '../historySlice';
import { SESSION_PRE_VIEWPORT_KEYS } from '../../api/session';

let store: ReturnType<typeof createTestStore>;
beforeEach(() => {
  localStorage.clear();
  ensureBuiltinPanelsRegistered();
  store = createTestStore();
});

describe('Co-occupancy: the footprints to cluster by, per locus', () => {
  it('is remembered per locus, replacing the choice at the same place', () => {
    store.getState().setCooccClusterSelection({ chrom: 'chr19', start: 100, end: 300, groupIds: ['a', 'b'] });
    store.getState().setCooccClusterSelection({ chrom: 'chr19', start: 9000, end: 9100, groupIds: ['x'] });
    store.getState().setCooccClusterSelection({ chrom: 'chr19', start: 120, end: 310, groupIds: ['b'] });
    expect(store.getState().cooccClusterSelections).toEqual([
      { chrom: 'chr19', start: 9000, end: 9100, groupIds: ['x'] },
      { chrom: 'chr19', start: 120, end: 310, groupIds: ['b'] },
    ]);
  });

  it('is saved with the session and restored with a snapshot', () => {
    expect(SESSION_PRE_VIEWPORT_KEYS).toContain('cooccClusterSelections');
    store.getState().setCooccClusterSelection({ chrom: 'chr19', start: 100, end: 300, groupIds: ['a'] });
    expect(serializeState(store.getState()).cooccClusterSelections).toEqual([{ chrom: 'chr19', start: 100, end: 300, groupIds: ['a'] }]);
    store.getState().pushSnapshot('Chosen', { kind: 'layout' });
    store.getState().setCooccClusterSelection({ chrom: 'chr19', start: 100, end: 300, groupIds: ['b'] });
    const index = store.getState()._historyStack.findIndex(s => s.label === 'Chosen');
    store.getState().restoreSnapshot(index, { restoreViewport: true });
    expect(store.getState().cooccClusterSelections[0].groupIds).toEqual(['a']);
  });
});
