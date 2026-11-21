/**
 * Codex C2-1: a fit's molecule metric cohort is kept with its patterns or centroids (and sent back with them for
 * dynamic assignment), through cluster-tree nodes, undo snapshots, saved clusterings and sessions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';
import { deserializeSavedState, serializeState } from '../historySlice';
import { SESSION_POST_VIEWPORT_KEYS } from '../../api/session';
import type { BrowserState } from '../browserStore';
import type { ClusterMetricCohort } from '../../types';

let store: ReturnType<typeof createTestStore>;
const COHORT: ClusterMetricCohort = { 'nuc.nrl': { values: [180, 190, 200, 210], counts: [1, 1, 1, 1] } };
const OTHER: ClusterMetricCohort = { 'nuc.nrl': { values: [150, 160], counts: [3, 1] } };

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
  store.setState({ chrom: '2R', start: 1000, end: 2000, datasets: [{ id: 'ds1', label: 'D1' }] } as never);
});

describe('the fitted metric cohort goes with the model', () => {
  it('a non-empty model sets it; clearing the other half of the model leaves it', () => {
    const s = () => store.getState();
    expect(s().clusterMetricCohort).toEqual({});
    // A k-means fit (Browser.tsx order: patterns cleared, then centroids with the cohort).
    s().setClusterPatterns({});
    s().setClusterCentroids({ 0: [0.25], 1: [0.75] }, [1], COHORT);
    expect(s().clusterMetricCohort).toEqual(COHORT);
    // A combinatorial fit (patterns with the cohort, then centroids cleared).
    s().setClusterPatterns({ 0: [0], 1: [1] }, OTHER);
    s().setClusterCentroids({}, []);
    expect(s().clusterMetricCohort).toEqual(OTHER);
    // Patterns from elsewhere (no metric columns): no cohort, so assignment ranks as before.
    s().setClusterPatterns({ 0: [1] });
    expect(s().clusterMetricCohort).toEqual({});
  });

  it('comes back with a cluster-tree node', () => {
    store.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 1 } }, clusterOrder: { ds1: [0, 1] },
      clusterPeakRegions: [{ start: 1100, end: 1200, mode: 'cluster_rule:m' }], dynamicClustering: true,
    } as never);
    store.getState().setClusterCentroids({ 0: [0.25], 1: [0.75] }, [1], COHORT);
    const nodeId = store.getState().captureActiveClusterTreeNode({ name: 'Root run' })!;
    expect(store.getState().clusterTreeNodes[nodeId].metricCohort).toEqual(COHORT);
    store.setState({ clusterCentroids: {}, clusterPeakWidths: [], clusterMetricCohort: {} } as never);
    store.getState().applyClusterTreeNode(nodeId);
    expect(store.getState().clusterCentroids).toEqual({ 0: [0.25], 1: [0.75] });
    expect(store.getState().clusterMetricCohort).toEqual(COHORT);
    // A new fit on the active node replaces the node's cohort too.
    store.getState().setClusterPatterns({ 0: [0], 1: [1] }, OTHER);
    expect(store.getState().clusterTreeNodes[nodeId].metricCohort).toEqual(OTHER);
  });

  it('is part of undo snapshots and sessions (older snapshots: none)', () => {
    store.getState().setClusterPatterns({ 0: [0], 1: [1] }, COHORT);
    const saved = serializeState(store.getState() as BrowserState);
    expect(saved.clusterMetricCohort).toEqual(COHORT);
    expect(deserializeSavedState(saved).clusterMetricCohort).toEqual(COHORT);
    const { clusterMetricCohort: _drop, ...older } = saved;
    expect(deserializeSavedState(older as typeof saved).clusterMetricCohort).toEqual({});
    expect(SESSION_POST_VIEWPORT_KEYS).toContain('clusterMetricCohort');
  });

  it('comes back with a saved clustering', () => {
    store.setState({
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, layoutRow: 0 }],
      clusterAssignments: { ds1: { r1: 0, r2: 1 } }, clusterOrder: { ds1: [0, 1] },
    } as never);
    store.getState().setClusterPatterns({ 0: [0], 1: [1] }, COHORT);
    store.getState().saveCurrentClustering('nrl split');
    const savedId = store.getState().savedClusters[0].id;
    expect(store.getState().savedClusters[0].metricCohort).toEqual(COHORT);
    store.getState().setClusterPatterns({ 0: [1] });
    store.getState().restoreSavedCluster(savedId);
    expect(store.getState().clusterPatterns).toEqual({ 0: [0], 1: [1] });
    expect(store.getState().clusterMetricCohort).toEqual(COHORT);
  });
});
