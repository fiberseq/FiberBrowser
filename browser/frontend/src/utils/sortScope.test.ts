import { describe, expect, it } from 'vitest';
import type { ClusterTreeNode } from '../types';
import { resolveSortRequestScope, selectedPeakWindowsForSort, sortRounds, mergeScopedSortOrder, sortStateStillCurrent, sortMovesVisibleReads } from './sortScope';

const emptyTree: Record<string, ClusterTreeNode> = {};

describe('sort request scope helpers', () => {
  it('uses the non-empty state key when an empty assignment map comes first', () => {
    const scope = resolveSortRequestScope({
      datasetIds: ['ds1'],
      sortKeyMap: { ds1: ['panel-empty', 'panel-clustered'] },
      clusterAssignments: {
        'panel-empty': {},
        'panel-clustered': { read_a: 1, read_b: 2 },
      },
      selectedClusters: { 'panel-clustered': new Set([2]) },
      clusterFocus: {},
      filteredReadIds: {},
      activeClusterTreeNodeId: null,
      clusterTreeNodes: emptyTree,
    });

    expect(scope.clusterAssignments.ds1).toEqual({ read_a: 1, read_b: 2 });
    expect(scope.readIds.ds1).toEqual(['read_b']);
  });

  it('preserves filtered read scopes even when a dataset is not clustered', () => {
    const scope = resolveSortRequestScope({
      datasetIds: ['ds1'],
      sortKeyMap: { ds1: ['ds1'] },
      clusterAssignments: {},
      selectedClusters: {},
      clusterFocus: {},
      filteredReadIds: { ds1: new Set(['read_a', 'read_c']) },
      activeClusterTreeNodeId: null,
      clusterTreeNodes: emptyTree,
    });

    expect(scope.clusterAssignments).toEqual({ ds1: {} });
    expect(scope.readIds.ds1).toEqual(['read_a', 'read_c']);
  });

  it('scopes active subcluster branches to their assignment members', () => {
    const scope = resolveSortRequestScope({
      datasetIds: ['ds1'],
      sortKeyMap: { ds1: ['ds1'] },
      clusterAssignments: { ds1: { read_a: 0, read_b: 1 } },
      selectedClusters: {},
      clusterFocus: {},
      filteredReadIds: {},
      activeClusterTreeNodeId: 'child',
      clusterTreeNodes: {
        child: {
          id: 'child',
          parentId: 'root',
          name: 'Subcluster',
          createdAt: 1,
          chrom: 'chr1',
          start: 0,
          end: 100,
          sourceClusterIds: [1],
          clusterMethod: 'kmeans',
          clusterK: 2,
          subnucleosomalThreshold: 0.5,
          accessibilityThreshold: 0.5,
          assignments: { ds1: { read_a: 0, read_b: 1 } },
          order: { ds1: [0, 1] },
          patterns: {},
        },
      },
    });

    expect(scope.readIds.ds1).toEqual(['read_a', 'read_b']);
  });

  it('builds selected peak windows independently of cluster state', () => {
    const windows = selectedPeakWindowsForSort(
      [
        { index: 1, start: 100, end: 150 },
        { index: 2, start: 300, end: 350 },
      ],
      new Set([2]),
    );

    expect(windows).toEqual([[300, 350]]);
  });
});

describe('sortRounds', () => {
  it('puts independently clustered copies of a dataset in separate rounds', () => {
    expect(sortRounds(['a', 'b'], { a: ['a', 'copy'], b: ['b'] })).toEqual([{ a: 'a', b: 'b' }, { a: 'copy' }]);
    expect(sortRounds(['a'], {})).toEqual([{ a: 'a' }]);
  });
});

const baseScope = { datasetIds: ['ds'], sortKeyMap: { ds: ['panel'] }, clusterAssignments: {},
  selectedClusters: {}, clusterFocus: {}, filteredReadIds: {}, activeClusterTreeNodeId: null, clusterTreeNodes: {} };

it('sends an empty cluster override after reset or for an unclustered copy', () => {
  expect(resolveSortRequestScope(baseScope).clusterAssignments).toEqual({ ds: {} });
});

it('intersects selection, focus, filter and split membership, including empty scopes', () => {
  const input = { ...baseScope, clusterAssignments: { panel: { a: 0, b: 0, c: 1, d: 1 } },
    selectedClusters: { panel: new Set([0, 1]) }, clusterFocus: { panel: new Set([0]) },
    filteredReadIds: { panel: new Set(['b', 'c']) }, panelReadIds: { panel: ['a', 'b', 'd'] } };
  expect(resolveSortRequestScope(input).readIds).toEqual({ ds: ['b'] });
  expect(resolveSortRequestScope({ ...input, filteredReadIds: { panel: new Set<string>() } }).readIds).toEqual({ ds: [] });
  expect(resolveSortRequestScope({ ...baseScope, filteredReadIds: { panel: new Set<string>() } }).readIds).toEqual({ ds: [] });
  expect(resolveSortRequestScope({ ...input, panelReadIds: { panel: [] } }).readIds).toEqual({ ds: [] });
});

it('sorting a selected cluster preserves all other clusters and their read order', () => {
  expect(mergeScopedSortOrder([0, 1, 2], [1], true)).toEqual([0, 1, 2]);
  expect(mergeScopedSortOrder([0, 1, 2, 3], [3, 1], true)).toEqual([0, 3, 2, 1]);
  expect(mergeScopedSortOrder(['a', 'b', 'c', 'd'], ['c', 'b'], true)).toEqual(['a', 'c', 'b', 'd']);
  expect(mergeScopedSortOrder(['a', 'b'], ['x', 'b'], true)).toEqual(['a', 'b', 'x']);
});

it('ignores display loads but rejects changes to the read scope while sorting', async () => {
  const { useBrowserStore } = await import('../stores/browserStore');
  const before = useBrowserStore.getState();
  expect(sortStateStillCurrent(before, { ...before, activeReadIds: { panel: ['a'] } }, 'panel')).toBe(true);
  for (const field of ['clusterAssignments', 'clusterOrder', 'filteredReadIds', 'selectedClusters', 'clusterFocus', 'readSortOrder', 'jupyterReadOrder'] as const) {
    expect(sortStateStillCurrent(before, { ...before, [field]: { panel: {} } } as any, 'panel')).toBe(false);
  }
});

it('recognises an unchanged display sample and honours cluster grouping', () => {
  expect(sortMovesVisibleReads(['b','c'], ['a','b','c'], [], {})).toBe(false);
  expect(sortMovesVisibleReads(['c','b'], ['a','b','c'], [], {})).toBe(true);
  expect(sortMovesVisibleReads(['b','c'], ['c','b'], [0,1], { b: 0, c: 1 })).toBe(false);
  expect(sortMovesVisibleReads(['b','c'], ['b','c'], [1,0], { b: 0, c: 1 })).toBe(true);
});

it('a newly opened panel is not scoped to another panel’s child branch', () => {
  const scope = resolveSortRequestScope({ ...baseScope, activeClusterTreeNodeId: 'child',
    clusterTreeNodes: { child: { parentId: 'root', assignments: { other: { a: 0 } } } as any } });
  expect(scope.readIds).toEqual({});
  expect(scope.clusterAssignments).toEqual({ ds: {} });
});


it('sorts every selected correspondence window even when partners share one selection index', () => {
  expect(selectedPeakWindowsForSort([
    { index: 2, start: 100, end: 150 }, { index: 2, start: 300, end: 350 },
    { index: 2, start: 100, end: 150 }, { index: 3, start: 500, end: 550 },
  ], new Set([2]))).toEqual([[100, 150], [300, 350]]);
});

it('rejects a pending sort after signal filters or undo change its cohort', async () => {
  const { useBrowserStore } = await import('../stores/browserStore');
  const before = useBrowserStore.getState();
  expect(sortStateStillCurrent(before, { ...before, signalFilters: { ...before.signalFilters, hideBackground: !before.signalFilters.hideBackground } }, 'panel')).toBe(false);
  expect(sortStateStillCurrent(before, { ...before, _lastRestoreTime: before._lastRestoreTime + 1 }, 'panel')).toBe(false);
  // Recording an unrelated panel's navigation is not an undo or redo.
  expect(sortStateStillCurrent(before, { ...before, _historyPointer: before._historyPointer + 1 }, 'panel')).toBe(true);
});
