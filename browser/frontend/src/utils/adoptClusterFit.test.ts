import { expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { adoptClusterFit } from './adoptClusterFit';

it('an empty combinatorial fit replaces its ranking cohort and disables reassignment', () => {
  const old = { 'nuc.nrl': { values: [100, 300], counts: [1, 1] } };
  const fitted = { 'nuc.nrl': { values: [180, 190], counts: [2, 2] } };
  useBrowserStore.setState({ clusterMetricCohort: old, clusterTreeNodes: {}, activeClusterTreeNodeId: null,
    clusterAssignments: { d: { synthetic: 0 } }, clusterOrder: { d: [0] }, dynamicClustering: true });
  useBrowserStore.getState().captureActiveClusterTreeNode({ name: 'Fit' });
  expect(adoptClusterFit({ cluster_patterns: {}, cluster_metric_cohort: fitted }, 'combinatorial', [])).toBe(false);
  const s = useBrowserStore.getState();
  expect(s.clusterMetricCohort).toEqual(fitted);
  expect(s.clusterTreeNodes[s.activeClusterTreeNodeId!].metricCohort).toEqual(fitted);
  expect(s.dynamicClustering).toBe(false);
  adoptClusterFit({ cluster_patterns: {} }, 'combinatorial', []);
  expect(useBrowserStore.getState().clusterMetricCohort).toEqual({});
});
