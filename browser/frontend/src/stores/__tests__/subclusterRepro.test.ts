import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore } from './helpers';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
});

const UNASSIGNED = -1;
const FULL = { r1: 0, r2: 0, r3: 1, r4: 1, r5: 2, r6: 2 };

describe('commitSubcluster (projection model)', () => {
  beforeEach(() => {
    store.setState({
      chrom: 'chr2L', start: 100, end: 500,
      clusterAssignments: { ds1: { ...FULL } },
      clusterOrder: { ds1: [0, 1, 2] },
    });
    store.getState().captureActiveClusterTreeNode({ name: 'All reads' });
  });

  it('projects the subset and hides the -1 dead bucket, leaving the parent intact', () => {
    const rootId = store.getState().activeClusterTreeNodeId!;
    // subcluster C0 (r1,r2) into sub-ids 0,1
    store.getState().commitSubcluster({ ds1: { r1: 0, r2: 1 } }, { sourceClusterIds: [0] });

    // live projection: subset has sub-ids, the rest fold into -1
    expect(store.getState().clusterAssignments.ds1).toEqual({
      r1: 0, r2: 1, r3: -1, r4: -1, r5: -1, r6: -1,
    });
    // -1 hidden by default (focus excludes it)
    expect(store.getState().clusterFocus.ds1).toEqual(new Set([0, 1]));
    // parent node untouched
    expect(store.getState().clusterTreeNodes[rootId].assignments.ds1).toEqual(FULL);
  });

  it('restores the full parent clustering on going back up the tree', () => {
    const rootId = store.getState().activeClusterTreeNodeId!;
    store.getState().commitSubcluster({ ds1: { r1: 0, r2: 1 } }, { sourceClusterIds: [0] });

    store.getState().applyClusterTreeNode(rootId);
    expect(store.getState().clusterAssignments.ds1).toEqual(FULL);
    // subcluster ids are gone; reads fold back to their parent clusters
    expect(store.getState().clusterFocus.ds1 ?? null).toBeNull();
  });

  it('preserves multiple sibling subclusters', () => {
    const rootId = store.getState().activeClusterTreeNodeId!;

    store.getState().commitSubcluster({ ds1: { r1: 0, r2: 1 } }, { sourceClusterIds: [0] });
    const child1 = store.getState().activeClusterTreeNodeId!;

    // go back to root, subcluster a different cluster
    store.getState().applyClusterTreeNode(rootId);
    store.getState().commitSubcluster({ ds1: { r5: 0, r6: 1 } }, { sourceClusterIds: [2] });
    const child2 = store.getState().activeClusterTreeNodeId!;

    const nodes = store.getState().clusterTreeNodes;
    expect(child1).not.toBe(child2);
    expect(nodes[child1].parentId).toBe(rootId);
    expect(nodes[child2].parentId).toBe(rootId);
    expect(store.getState().clusterTreeRootIds).toEqual([rootId]);
    // both branches retain their own subcluster assignment
    expect(nodes[child1].assignments.ds1).toEqual({ r1: 0, r2: 1, r3: -1, r4: -1, r5: -1, r6: -1 });
    expect(nodes[child2].assignments.ds1).toEqual({ r1: -1, r2: -1, r3: -1, r4: -1, r5: 0, r6: 1 });
    // root still pristine, and switching between branches is faithful
    store.getState().applyClusterTreeNode(child1);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 1, r3: -1, r4: -1, r5: -1, r6: -1 });
    store.getState().applyClusterTreeNode(child2);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: -1, r2: -1, r3: -1, r4: -1, r5: 0, r6: 1 });
    store.getState().applyClusterTreeNode(rootId);
    expect(store.getState().clusterAssignments.ds1).toEqual(FULL);
  });

  it('is atomic — never makes the parent active mid-commit, so it cannot be corrupted', () => {
    const rootId = store.getState().activeClusterTreeNodeId!;
    // The old bug: a detach-to-null let a React effect re-apply the parent so the
    // subset merge mirrored back into it. commitSubcluster does it in one set(),
    // so the parent node is never the active write target during the operation.
    store.getState().commitSubcluster({ ds1: { r1: 0, r2: 1 } }, { sourceClusterIds: [0] });
    // active is the child, not the parent
    expect(store.getState().activeClusterTreeNodeId).not.toBe(rootId);
    // parent assignment is exactly the original full clustering
    expect(store.getState().clusterTreeNodes[rootId].assignments.ds1).toEqual(FULL);
  });
});
