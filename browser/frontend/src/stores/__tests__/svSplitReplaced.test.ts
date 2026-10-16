/**
 * An SV allele split's names (Carriers / Reference ...) and definition go when another grouping replaces that
 * panel's groups: a saved clustering restored, or a subclustering (Codex review of f9ee5558). Saved > Prevalence
 * and the Clusters panel take a split's names first, so stale ones would rename the new groups.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore } from './helpers';
import type { BrowserState } from '../browserStore';

let store: ReturnType<typeof createTestStore>;
const SV = { ds1: { 0: 'Carriers', 1: 'Reference', 2: 'Not informative' } };
const svDef = { chrom: 'chr2L', start: 100, end: 200 } as never;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
  store.setState({ chrom: 'chr2L', start: 100, end: 500,
    clusterAssignments: { ds1: { r1: 0, r2: 0, r3: 1, r4: 1 } }, clusterOrder: { ds1: [0, 1] } } as Partial<BrowserState>);
});

describe('an SV split replaced by another grouping loses its names', () => {
  it('restoring a saved clustering in the same view', () => {
    store.getState().saveCurrentClustering('k-means');
    const saved = store.getState().savedClusters[0];
    store.getState().setClusterAssignments('ds1', { r1: 1, r2: 0, r3: 0, r4: 2 }, { svSplit: true });
    store.getState().setSvSplit('ds1', svDef, SV.ds1);
    expect(store.getState().clusterGroupLabels.ds1).toEqual(SV.ds1);
    store.getState().restoreSavedCluster(saved.id);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 0, r3: 1, r4: 1 });
    expect(store.getState().clusterGroupLabels.ds1).toBeUndefined();
    expect(store.getState().svSplits.ds1).toBeUndefined();
  });

  it('a subclustering', () => {
    store.getState().captureActiveClusterTreeNode({ name: 'All reads' });
    store.getState().setSvSplit('ds1', svDef, SV.ds1);
    store.getState().commitSubcluster({ ds1: { r1: 0, r2: 1 } }, { sourceClusterIds: [0] });
    expect(store.getState().clusterGroupLabels.ds1).toBeUndefined();
    expect(store.getState().svSplits.ds1).toBeUndefined();
  });

  it('re-applying a branch with other groups drops the names', () => {
    store.getState().captureActiveClusterTreeNode({ name: 'All reads' });
    const root = store.getState().activeClusterTreeNodeId!;
    store.setState({ activeClusterTreeNodeId: null } as Partial<BrowserState>);
    store.getState().setClusterAssignments('ds1', { r1: 1, r2: 0, r3: 0, r4: 2 }, { svSplit: true });
    store.getState().setSvSplit('ds1', svDef, SV.ds1);
    store.getState().applyClusterTreeNode(root);
    expect(store.getState().svSplits.ds1).toBeUndefined();
    expect(store.getState().clusterGroupLabels.ds1).toBeUndefined();
  });
});

describe('re-applying the branch that holds the split itself keeps it (integ/fb40)', () => {
  it('the Clusters panel re-applies the root after a split into panels', () => {
    store.getState().setClusterAssignments('ds1', { r1: 0, r2: 1, r3: 1, r4: 2 }, { svSplit: true });
    store.getState().setSvSplit('ds1', svDef, SV.ds1);
    store.getState().captureActiveClusterTreeNode({ name: 'All reads' });
    const root = store.getState().activeClusterTreeNodeId!;
    store.setState({ activeClusterTreeNodeId: null } as Partial<BrowserState>);
    store.getState().applyClusterTreeNode(root, { keepSameSvSplits: true });
    expect(store.getState().svSplits.ds1).toBeDefined();
    expect(store.getState().clusterGroupLabels.ds1).toEqual(SV.ds1);
  });

  it('a branch the user picks drops the split even with the same groups (Codex, integ/fb40)', () => {
    store.getState().setClusterAssignments('ds1', { r1: 0, r2: 1, r3: 1, r4: 2 }, { svSplit: true });
    store.getState().setSvSplit('ds1', svDef, SV.ds1);
    store.getState().captureActiveClusterTreeNode({ name: 'All reads' });
    const root = store.getState().activeClusterTreeNodeId!;
    store.getState().applyClusterTreeNode(root);
    expect(store.getState().svSplits.ds1).toBeUndefined();
    expect(store.getState().clusterGroupLabels.ds1).toBeUndefined();
  });
});
