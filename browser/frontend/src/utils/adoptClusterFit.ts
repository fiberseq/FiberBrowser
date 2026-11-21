import { useBrowserStore } from '../stores/browserStore';
import { adoptFitMetricCohort } from '../actions/browserActions';
import type { ClusterMetricCohort } from '../types';

/** Keep the fitted model and its ranking cohort together, including a fit with no reassignment model. */
export function adoptClusterFit(res: { cluster_patterns?: Record<number, number[]>; cluster_centroids?: Record<number, number[]>;
  cluster_peak_widths?: number[]; cluster_metric_cohort?: ClusterMetricCohort }, method: string,
  peaks: Array<{ start: number; end: number; mode?: string }>): boolean {
  const s = useBrowserStore.getState();
  let dynamic = false;
  if (res.cluster_patterns && Object.keys(res.cluster_patterns).length > 0 && method === 'combinatorial') {
    s.setClusterPatterns(res.cluster_patterns, res.cluster_metric_cohort);
    s.setClusterCentroids({}, []);
    dynamic = true;
  } else if (res.cluster_centroids && Object.keys(res.cluster_centroids).length) {
    s.setClusterPatterns({});
    s.setClusterCentroids(res.cluster_centroids, res.cluster_peak_widths ?? [], res.cluster_metric_cohort);
    dynamic = true;
  } else {
    s.setClusterPatterns({});
    s.setClusterCentroids({}, []);
    adoptFitMetricCohort(res.cluster_metric_cohort);
  }
  s.setClusterPeakRegions(peaks);
  s.setDynamicClustering(dynamic);
  return dynamic;
}
