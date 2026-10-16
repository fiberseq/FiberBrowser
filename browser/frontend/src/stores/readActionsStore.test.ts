/**
 * "Exclude selected" and "Show" are undo steps (Codex 16 / audit M9): Undo
 * brings excluded reads back, Redo hides them again, Reset view's Undo too.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from './browserStore';
import { applyExcludedReads, serializeExcludedReads, useReadActionsStore } from './readActionsStore';
import { excludeReadsUndoably, showExcludedUndoably } from '../components/tracks/read-track/ReadTrackActions';
import { resetViewUndoably } from '../utils/resetView';

const excluded = () => Object.fromEntries(Object.entries(useReadActionsStore.getState().excludedReadIds).map(([k, v]) => [k, [...v].sort()]));

beforeEach(() => {
  useReadActionsStore.getState().reset();
  useBrowserStore.setState({
    _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0,
    selectedReadIds: { ds1: new Set(['r1', 'r2']) },
  } as any);
});

describe('exclusions in snapshots', () => {
  it('serialize sorted and apply back; absent clears', () => {
    useReadActionsStore.getState().excludeReads('ds1', ['b', 'a']);
    expect(serializeExcludedReads()).toEqual({ ds1: ['a', 'b'] });
    applyExcludedReads({ ds2: ['c'] });
    expect(excluded()).toEqual({ ds2: ['c'] });
    applyExcludedReads(undefined);
    expect(excluded()).toEqual({});
  });

  it('keep the same object when nothing changed (no refetch)', () => {
    applyExcludedReads({ ds1: ['a'] });
    const before = useReadActionsStore.getState().excludedReadIds;
    applyExcludedReads({ ds1: ['a'] });
    expect(useReadActionsStore.getState().excludedReadIds).toBe(before);
  });
});

describe('Exclude selected is an undo step', () => {
  it('Undo shows the reads again, Redo hides them again', () => {
    excludeReadsUndoably('ds1', ['r1', 'r2']);
    expect(excluded()).toEqual({ ds1: ['r1', 'r2'] });
    expect(useBrowserStore.getState().selectedReadIds.ds1?.size ?? 0).toBe(0);
    const labels = useBrowserStore.getState().getHistoryLabels().map(h => h.label);
    expect(labels[labels.length - 1]).toBe('Exclude 2 selected reads');

    useBrowserStore.getState().undo();
    expect(excluded()).toEqual({});
    useBrowserStore.getState().redo();
    expect(excluded()).toEqual({ ds1: ['r1', 'r2'] });
  });

  it('Show is a step too', () => {
    excludeReadsUndoably('ds1', ['r1']);
    showExcludedUndoably('ds1');
    expect(excluded()).toEqual({});
    useBrowserStore.getState().undo();
    expect(excluded()).toEqual({ ds1: ['r1'] });
  });

  it("Reset view's Undo brings the exclusions back", () => {
    excludeReadsUndoably('ds1', ['r1']);
    resetViewUndoably();
    expect(excluded()).toEqual({});
    useBrowserStore.getState().undo();
    expect(excluded()).toEqual({ ds1: ['r1'] });
  });
});
