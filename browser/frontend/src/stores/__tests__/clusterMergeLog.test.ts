import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';
import {
  clusteringSignature,
  mergeLogStatus,
  mergedClusters,
  normalizeMergeLog,
  recordMergeStep,
  restoreMergeLog,
  splitBackCluster,
  toggleMerge,
} from '../clusterMergeLog';
import { remapDatasetIds, serializeState } from '../historySlice';
import { restoredMergeLog } from '../clusterSlice';
import type { BrowserState } from '../browserStore';

/**
 * fb-n5-projection: merges (Merge, Merge similar clusters, Delete) are
 * reversible in one step and can be switched back and forth without
 * recomputing; one merged-away cluster can be split back on its own.
 */

const original = {
  a: { r1: 0, r2: 0, r3: 1, r4: 1, r5: 2, r6: 2, r7: 3 },
};
const order = { a: [3, 2, 1, 0] };

function merge(assignments: Record<string, number>, from: number, to: number) {
  return Object.fromEntries(Object.entries(assignments).map(([id, c]) => [id, c === from ? to : c]));
}

describe('clusterMergeLog (pure)', () => {
  it('records a merge and switches to the original and back without recomputing', () => {
    const merged = { a: merge(original.a, 1, 0) };
    const log = recordMergeStep(null, { assignments: original, order }, { assignments: merged, order: { a: [3, 2, 0] } }, ['a'], { label: 'Merge C0, C1', kind: 'manual' })!;
    expect(log.steps).toHaveLength(1);
    expect(log.steps[0].removed).toEqual([1]);
    expect(log.originalCount).toBe(4);
    expect(log.mergedCount).toBe(3);
    expect(mergeLogStatus(log, merged)).toBe('merged');
    expect(mergeLogStatus(log, original)).toBe('original');

    const unmerged = toggleMerge(log, { assignments: merged, order: { a: [3, 2, 0] } })!;
    expect(unmerged.assignments.a).toEqual(original.a);
    expect(unmerged.order.a).toEqual([3, 2, 1, 0]);
    expect(unmerged.log.showing).toBe('original');

    const again = toggleMerge(unmerged.log, { assignments: unmerged.assignments, order: unmerged.order })!;
    expect(again.assignments.a).toEqual(merged.a);
    expect(again.order.a).toEqual([3, 2, 0]);
    expect(again.log.showing).toBe('merged');
  });

  it('chains merges; a new clustering makes the log stale', () => {
    const step1 = { a: merge(original.a, 1, 0) };
    const step2 = { a: merge(step1.a, 3, 2) };
    let log = recordMergeStep(null, { assignments: original, order }, { assignments: step1, order }, ['a'], { label: 'Merge C0, C1', kind: 'manual' });
    log = recordMergeStep(log, { assignments: step1, order }, { assignments: step2, order }, ['a'], { label: 'Delete C3', kind: 'dissolve' })!;
    expect(log.steps).toHaveLength(2);
    expect(log.originalCount).toBe(4);
    expect(log.mergedCount).toBe(2);
    const back = toggleMerge(log, { assignments: step2, order })!;
    expect(back.assignments.a).toEqual(original.a);
    // Another clustering: neither of the two.
    expect(mergeLogStatus(log, { a: { r1: 5, r2: 6 } })).toBeNull();
    expect(toggleMerge(log, { assignments: { a: { r1: 5 } }, order })).toBeNull();
  });

  it('splits one merged cluster back and keeps the other merges', () => {
    const step1 = { a: merge(original.a, 1, 0) };
    const step2 = { a: merge(step1.a, 3, 2) };
    let log = recordMergeStep(null, { assignments: original, order }, { assignments: step1, order: { a: [3, 2, 0] } }, ['a'], { label: 'Merge C0, C1', kind: 'manual' });
    log = recordMergeStep(log, { assignments: step1, order: { a: [3, 2, 0] } }, { assignments: step2, order: { a: [2, 0] } }, ['a'], { label: 'Merge similar clusters', kind: 'similar' })!;
    const merged = mergedClusters(log);
    expect(merged.map(m => [m.cluster, m.target, m.reads])).toEqual([[1, 0, 2], [3, 2, 1]]);

    const split = splitBackCluster(log, { assignments: step2, order: { a: [2, 0] } }, log.steps[0].id, 1)!;
    expect(split.assignments.a).toEqual({ ...step2.a, r3: 1, r4: 1 });
    // Back where it was before the merges (after C0 there... C1 followed C2 in the original order).
    expect(split.order.a).toEqual([2, 1, 0]);
    expect(split.log!.steps).toHaveLength(1);
    expect(mergeLogStatus(split.log, split.assignments)).toBe('merged');
    // Unmerge now undoes only the remaining merge.
    const unmerged = toggleMerge(split.log!, { assignments: split.assignments, order: split.order })!;
    expect(unmerged.assignments.a).toEqual(original.a);

    // Splitting the last one leaves nothing merged.
    const last = splitBackCluster(split.log!, { assignments: split.assignments, order: split.order }, split.log!.steps[0].id, 3)!;
    expect(last.log).toBeNull();
    expect(last.assignments.a).toEqual(original.a);
  });

  it('ignores a merge that moved no read, and survives JSON (sessions)', () => {
    expect(recordMergeStep(null, { assignments: original, order }, { assignments: original, order }, ['a'], { label: 'x', kind: 'manual' })).toBeNull();
    const merged = { a: merge(original.a, 2, 3) };
    const log = recordMergeStep(null, { assignments: original, order }, { assignments: merged, order }, ['a'], {
      label: 'Merge similar clusters', kind: 'similar', settings: { strategy: 'difference', threshold: 0.2, minFraction: 0.05 },
    })!;
    const back = normalizeMergeLog(JSON.parse(JSON.stringify(log)))!;
    expect(back).toEqual(log);
    expect(mergeLogStatus(back, JSON.parse(JSON.stringify(merged)))).toBe('merged');
    expect(normalizeMergeLog({ nonsense: true })).toBeNull();
  });

  it('a cluster merged away in one panel but kept in another can still be split back there', () => {
    const before = { a: { r1: 0, r2: 1 }, b: { s1: 1, s2: 2 } };
    const after = { a: { r1: 0, r2: 0 }, b: { s1: 1, s2: 1 } };
    const log = recordMergeStep(null, { assignments: before, order: {} }, { assignments: after, order: {} }, ['a', 'b'], { label: 'Merge', kind: 'manual' })!;
    expect(log.steps[0].removed).toEqual([1, 2]);
    const split = splitBackCluster(log, { assignments: after, order: {} }, log.steps[0].id, 1)!;
    expect(split.assignments.a).toEqual({ r1: 0, r2: 1 });
    expect(split.assignments.b).toEqual({ s1: 1, s2: 1 });
  });

  it('signatures ignore key order and see any changed read', () => {
    const x = { a: { r2: 1, r1: 0 } };
    const y = { a: { r1: 0, r2: 1 } };
    expect(clusteringSignature(x, ['a'])).toBe(clusteringSignature(y, ['a']));
    expect(clusteringSignature(x, ['a'])).not.toBe(clusteringSignature({ a: { r1: 0, r2: 2 } }, ['a']));
  });

  it('two panels swapping their clusterings is another clustering (fb-n6-integ, Codex)', () => {
    // Two copies of one dataset, clustered on their own: a merge in both.
    const before = { a: { r1: 0, r2: 1, r3: 2 }, b: { r1: 2, r2: 1, r3: 0 } };
    const after = { a: { r1: 0, r2: 0, r3: 2 }, b: { r1: 2, r2: 2, r3: 0 } };
    const log = recordMergeStep(null, { assignments: before, order: {} }, { assignments: after, order: {} }, ['a', 'b'], { label: 'Merge', kind: 'manual' })!;
    expect(mergeLogStatus(log, after)).toBe('merged');
    // The panels now show each other's clustering (a restore, another run): the log's moves would land on the wrong reads.
    const swapped = { a: after.b, b: after.a };
    expect(mergeLogStatus(log, swapped)).toBeNull();
    expect(toggleMerge(log, { assignments: swapped, order: {} })).toBeNull();
    expect(mergeLogStatus(log, { a: before.b, b: before.a })).toBeNull();
  });
});

describe('Unmerge in the store', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    localStorage.clear();
    store = createTestStore();
    store.setState({
      clusterAssignments: { a: { ...original.a } },
      clusterOrder: { a: [0, 1, 2, 3] },
      selectedClusters: { a: new Set([0, 1]) },
    } as Partial<BrowserState>);
  });

  it('Merge records a step; Unmerge / Merge again switch, one undo step each', () => {
    expect(store.getState().mergeSelectedClusters(['a'])).toBe(1);
    const merged = store.getState().clusterAssignments.a;
    expect(new Set(Object.values(merged))).toEqual(new Set([0, 2, 3]));
    expect(mergeLogStatus(store.getState().clusterMergeLog, store.getState().clusterAssignments)).toBe('merged');

    const depth = store.getState()._historyStack.length;
    expect(store.getState().toggleClusterMerge()).toBe(true);
    expect(store.getState().clusterAssignments.a).toEqual(original.a);
    expect(store.getState().clusterOrder.a).toEqual([0, 1, 2, 3]);
    expect(store.getState().dynamicClustering).toBe(false);
    expect(store.getState()._historyStack.length).toBe(depth + 1);
    expect(store.getState()._historyStack.at(-1)?.label).toBe('Unmerge clusters');

    expect(store.getState().toggleClusterMerge()).toBe(true);
    expect(store.getState().clusterAssignments.a).toEqual(merged);
    expect(store.getState()._historyStack.at(-1)?.label).toBe('Merge clusters again');

    // Undo goes back to the unmerged clustering, with the log saying so.
    store.getState().undo();
    expect(store.getState().clusterAssignments.a).toEqual(original.a);
    expect(mergeLogStatus(store.getState().clusterMergeLog, store.getState().clusterAssignments)).toBe('original');
    store.getState().undo();
    expect(store.getState().clusterAssignments.a).toEqual(merged);
    expect(mergeLogStatus(store.getState().clusterMergeLog, store.getState().clusterAssignments)).toBe('merged');
  });

  it('Split back is one undo step; focus and selection keep only clusters that exist', () => {
    store.getState().mergeSelectedClusters(['a']);
    store.setState({ clusterFocus: { a: new Set([0]) } } as Partial<BrowserState>);
    const info = mergedClusters(store.getState().clusterMergeLog)[0];
    expect(info.cluster).toBe(1);
    expect(store.getState().splitBackMergedCluster(info.stepId, 1)).toBe(true);
    expect(store.getState().clusterAssignments.a).toEqual(original.a);
    expect(store.getState().clusterMergeLog).toBeNull();
    expect(store.getState()._historyStack.at(-1)?.label).toBe('Split C1 back');
    expect([...(store.getState().clusterFocus.a ?? [])]).toEqual([0]);
  });

  it('the log and the merge settings go into undo steps and sessions, keyed by state key', () => {
    store.getState().setMergeSettings({ strategy: 'difference', threshold: 0.3 });
    store.getState().mergeSelectedClusters(['a']);
    const saved = serializeState(store.getState() as BrowserState);
    expect(saved.mergeStrategy).toBe('difference');
    expect(saved.mergeThresholds).toEqual({ difference: 0.3 });
    const log = normalizeMergeLog(saved.clusterMergeLog)!;
    expect(log.steps[0].moved.a).toBeDefined();
    // A reopened dataset under another id: the log follows it.
    const renamed = remapDatasetIds(saved, { a: 'b' });
    const moved = normalizeMergeLog(renamed.clusterMergeLog)!;
    expect(moved.stateKeys).toEqual(['b']);
    expect(Object.keys(moved.steps[0].moved)).toEqual(['b']);
    expect(Object.keys(moved.otherOrder)).toEqual(['b']);
    // ...and Unmerge still works on the renamed panel (Codex review).
    const assignments = remapDatasetIds({ clusterAssignments: saved.clusterAssignments }, { a: 'b' }).clusterAssignments;
    expect(mergeLogStatus(moved, assignments)).toBe('merged');
    expect(toggleMerge(moved, { assignments, order: { b: [0, 2, 3] } })!.assignments.b).toEqual(original.a);
  });

  it('merge settings: each strategy keeps its own threshold; cosine is mergeMaxSimilarity', () => {
    const s = () => store.getState();
    s().setMergeSettings({ strategy: 'js', threshold: 0.2 });
    s().setMergeSettings({ strategy: 'cosine', threshold: 0.9 });
    expect(s().mergeMaxSimilarity).toBe(0.9);
    expect(s().mergeThresholds.js).toBe(0.2);
    s().setMergeSettings({ strategy: 'js' });
    expect(s().mergeStrategy).toBe('js');
    // Out of range: clamped.
    s().setMergeSettings({ threshold: 5 });
    expect(s().mergeThresholds.js).toBe(0.6);
  });
});

describe('saved clusterings keep their merges (fb-n6-integ, Codex)', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    localStorage.clear();
    store = createTestStore();
    store.setState({
      clusterAssignments: { a: { ...original.a } },
      clusterOrder: { a: [0, 1, 2, 3] },
      selectedClusters: { a: new Set([0, 1]) },
    } as Partial<BrowserState>);
  });
  const status = () => mergeLogStatus(store.getState().clusterMergeLog, store.getState().clusterAssignments);

  it('merge, snapshot, merge again, restore: the snapshot can be unmerged and split back', () => {
    store.getState().mergeSelectedClusters(['a']);
    const mergedOnce = store.getState().clusterAssignments.a;
    store.getState().saveCurrentClustering('C0+C1');
    const saved = store.getState().savedClusters[0];
    expect(saved.mergeLog?.steps).toHaveLength(1);

    store.setState({ selectedClusters: { a: new Set([2, 3]) } } as Partial<BrowserState>);
    store.getState().mergeSelectedClusters(['a']);
    expect(store.getState().clusterMergeLog?.steps).toHaveLength(2);

    store.getState().restoreSavedCluster(saved.id);
    expect(store.getState().clusterAssignments.a).toEqual(mergedOnce);
    expect(status()).toBe('merged');
    expect(store.getState().clusterMergeLog?.steps).toHaveLength(1);
    expect(store.getState().toggleClusterMerge()).toBe(true);
    expect(store.getState().clusterAssignments.a).toEqual(original.a);
    expect(store.getState().toggleClusterMerge()).toBe(true);
    const info = mergedClusters(store.getState().clusterMergeLog)[0];
    expect(store.getState().splitBackMergedCluster(info.stepId, info.cluster)).toBe(true);
    expect(store.getState().clusterAssignments.a).toEqual(original.a);
  });

  it('a clustering saved without merges comes back without later, unrelated ones', () => {
    store.getState().saveCurrentClustering('first run');
    expect(store.getState().savedClusters[0].mergeLog).toBeUndefined();
    // Another run, then a merge in it.
    store.getState().setClusterAssignments('a', { r1: 5, r2: 5, r3: 6, r4: 6, r5: 7, r6: 7, r7: 8 });
    store.setState({ selectedClusters: { a: new Set([5, 6]) } } as Partial<BrowserState>);
    store.getState().mergeSelectedClusters(['a']);
    expect(store.getState().clusterMergeLog).not.toBeNull();
    store.getState().restoreSavedCluster(store.getState().savedClusters[0].id);
    expect(store.getState().clusterAssignments.a).toEqual(original.a);
    expect(store.getState().clusterMergeLog).toBeNull();
  });

  it('restoring the clustering from before the merges can merge again', () => {
    store.getState().saveCurrentClustering('before merging');
    store.getState().mergeSelectedClusters(['a']);
    const merged = store.getState().clusterAssignments.a;
    // The merged clustering in an order of the user's.
    store.getState().setClusterOrder('a', [3, 2, 0]);
    store.getState().restoreSavedCluster(store.getState().savedClusters[0].id);
    expect(status()).toBe('original');
    // The log says which side is on show (Codex review), so a save of it keeps it.
    expect(store.getState().clusterMergeLog?.showing).toBe('original');
    store.getState().saveCurrentClustering('restored, unmerged');
    const resaved = store.getState().savedClusters[1];
    expect(resaved.mergeLog?.showing).toBe('original');
    // An unrelated run, then that save restored: Merge again still works, in the user's order.
    store.getState().setClusterAssignments('a', { r1: 9, r2: 9, r3: 9, r4: 9, r5: 9, r6: 9, r7: 9 });
    store.setState({ clusterMergeLog: null } as Partial<BrowserState>);
    store.getState().restoreSavedCluster(resaved.id);
    expect(status()).toBe('original');
    expect(store.getState().toggleClusterMerge()).toBe(true);
    expect(store.getState().clusterAssignments.a).toEqual(merged);
    expect(store.getState().clusterOrder.a).toEqual([3, 2, 0]);
  });

  it('the saved log follows a renamed dataset in undo steps and sessions', () => {
    store.getState().mergeSelectedClusters(['a']);
    store.getState().saveCurrentClustering('C0+C1');
    const saved = serializeState(store.getState() as BrowserState);
    const renamed = remapDatasetIds(saved, { a: 'b' }) as typeof saved;
    const log = normalizeMergeLog((renamed.savedClusters as Array<{ mergeLog: unknown }>)[0].mergeLog)!;
    expect(log.stateKeys).toEqual(['b']);
    expect(Object.keys(log.steps[0].moved)).toEqual(['b']);
    expect(Object.keys(log.otherOrder)).toEqual(['b']);
  });

  it('a saved log over two panels is renamed once when their ids swap (Codex review)', () => {
    store.setState({
      clusterAssignments: { a: { ...original.a }, b: { s1: 4, s2: 5 } },
      clusterOrder: { a: [0, 1, 2, 3], b: [4, 5] },
      selectedClusters: { a: new Set([0, 1]), b: new Set([4, 5]) },
    } as Partial<BrowserState>);
    store.getState().mergeSelectedClusters(['a', 'b']);
    store.getState().saveCurrentClustering('both');
    const saved = serializeState(store.getState() as BrowserState);
    const swapped = remapDatasetIds(saved, { a: 'b', b: 'a' }) as typeof saved;
    const live = normalizeMergeLog(swapped.clusterMergeLog)!;
    const kept = normalizeMergeLog((swapped.savedClusters as Array<{ mergeLog: unknown }>)[0].mergeLog)!;
    for (const log of [live, kept]) {
      expect(log.stateKeys).toEqual(['b', 'a']);
      expect(Object.keys(log.steps[0].moved).sort()).toEqual(['a', 'b']);
      expect(Object.keys(log.steps[0].moved.a)).toEqual(['s2']);
      expect(Object.keys(log.otherOrder).sort()).toEqual(['a', 'b']);
      expect(mergeLogStatus(log, swapped.clusterAssignments as Record<string, Record<string, number>>)).toBe('merged');
    }
  });
});

describe('restoreMergeLog (pure)', () => {
  const before = { a: { r1: 0, r2: 1 }, b: { s1: 4, s2: 5 } };
  const after = { a: { r1: 0, r2: 0 }, b: { s1: 4, s2: 4 } };
  const log = recordMergeStep(null, { assignments: before, order: {} }, { assignments: after, order: {} }, ['a', 'b'], { label: 'Merge', kind: 'manual' })!;

  it('keeps a log whose panels show its clusterings as it is', () => {
    expect(restoreMergeLog(log, { ...after, other: { z: 1 } })).toBe(log);
  });

  it('follows a clustering restored to another panel, and drops a panel showing another clustering', () => {
    const now = { a: { r1: 9, r2: 9 }, c: after.b };
    const moved = restoreMergeLog(log, now)!;
    expect(moved.stateKeys).toEqual(['c']);
    expect(Object.keys(moved.steps[0].moved)).toEqual(['c']);
    expect(mergeLogStatus(moved, now)).toBe('merged');
    expect(toggleMerge(moved, { assignments: now, order: {} })!.assignments).toEqual({ a: { r1: 9, r2: 9 }, c: before.b });
  });

  it('shown before the merges: the merged clustering is rebuilt for the panels kept', () => {
    const unmerged = toggleMerge(log, { assignments: after, order: {} })!;
    const kept = restoreMergeLog(unmerged.log, { a: before.a, b: { s1: 7, s2: 7 } })!;
    expect(kept.stateKeys).toEqual(['a']);
    expect(mergeLogStatus(kept, { a: before.a })).toBe('original');
    expect(mergeLogStatus(kept, { a: after.a })).toBe('merged');
  });

  it('only into the panels allowed, and none left: no log', () => {
    expect(restoreMergeLog(log, after, new Set(['b']))!.stateKeys).toEqual(['b']);
    expect(restoreMergeLog(log, { a: { r1: 1 } })).toBeNull();
    expect(restoreMergeLog(null, after)).toBeNull();
  });
});

describe('restoredMergeLog: a partial restore (fb-n6-integ)', () => {
  it('keeps the live merges of panels the restore left as they were, drops the restored ones', () => {
    const before = { a: { r1: 0, r2: 1 }, b: { s1: 4, s2: 5 } };
    const after = { a: { r1: 0, r2: 0 }, b: { s1: 4, s2: 4 } };
    const live = recordMergeStep(null, { assignments: before, order: {} }, { assignments: after, order: {} }, ['a', 'b'], { label: 'Merge', kind: 'manual' })!;
    // A saved clustering without merges restored to panel a; panel b (another locus) kept.
    const restored = { a: { r1: 3, r2: 3 }, b: after.b };
    const log = restoredMergeLog({}, { clusterAssignments: after, clusterMergeLog: live }, restored)!;
    expect(log.stateKeys).toEqual(['b']);
    expect(mergeLogStatus(log, restored)).toBe('merged');
    // Panel a restored to the very clustering the live log merged: the whole log still describes what is on show.
    expect(restoredMergeLog({}, { clusterAssignments: after, clusterMergeLog: live }, { a: { ...after.a }, b: after.b })).toBe(live);
  });
});
