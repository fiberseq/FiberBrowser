import { describe, expect, it } from 'vitest';
import type { ClusterTreeNode } from '../types';
import { clusterBranchDynamicScopeKey, isClusterBranchAtViewport } from './clusterBranches';

const node: ClusterTreeNode = {
  id: 'node-1',
  parentId: null,
  name: 'All reads',
  createdAt: 1,
  chrom: 'chr2L',
  start: 100,
  end: 500,
  sourceClusterIds: [],
  clusterMethod: 'combinatorial',
  clusterK: 4,
  subnucleosomalThreshold: 90,
  accessibilityThreshold: 0.5,
  peakRegions: [],
  selectedPeakIndices: [],
  peakModes: {},
  patterns: {},
  dynamicClustering: true,
  assignments: {},
  order: {},
  focus: {},
};

describe('isClusterBranchAtViewport', () => {
  it('matches the exact viewport where a branch snapshot was computed', () => {
    expect(isClusterBranchAtViewport(node, 'chr2L', 100, 500)).toBe(true);
  });

  it('treats navigation away from the branch viewport as a new dynamic assignment target', () => {
    expect(isClusterBranchAtViewport(node, 'chr2L', 101, 501)).toBe(false);
    expect(isClusterBranchAtViewport(node, 'chr3L', 100, 500)).toBe(false);
    expect(isClusterBranchAtViewport(null, 'chr2L', 100, 500)).toBe(false);
  });
});

describe('clusterBranchDynamicScopeKey', () => {
  it('ignores focus and order updates that should not rerun dynamic assignment', () => {
    const base = {
      ...node,
      parentId: 'parent',
      readScope: { ds1: ['r2', 'r1'] },
      focus: { ds1: [1] },
      order: { ds1: [1, 0] },
    };

    expect(clusterBranchDynamicScopeKey({
      ...base,
      focus: { ds1: [0] },
      order: { ds1: [0, 1] },
    })).toBe(clusterBranchDynamicScopeKey(base));
  });

  it('changes when branch identity, viewport, or child read scope changes', () => {
    const base = { ...node, parentId: 'parent', readScope: { ds1: ['r1'] } };
    const key = clusterBranchDynamicScopeKey(base);

    expect(clusterBranchDynamicScopeKey({ ...base, id: 'node-2' })).not.toBe(key);
    expect(clusterBranchDynamicScopeKey({ ...base, start: 101 })).not.toBe(key);
    expect(clusterBranchDynamicScopeKey({ ...base, readScope: { ds1: ['r2'] } })).not.toBe(key);
  });
});
