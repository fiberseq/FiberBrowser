import { describe, expect, it } from 'vitest';
import { matchRefinedLabels, relabelClusterResponse } from './clusterLabelMatch';

describe('refined cluster labels follow the preview', () => {
  it('renames each refit cluster to the preview cluster it shares most reads with', () => {
    const preview = { p: { a: 0, b: 0, c: 1, d: 1, e: 2, f: -1 } };
    // The refit numbered the same groups differently (and saw a new read g).
    const refined = { p: { a: 2, b: 2, c: 0, d: 0, e: 1, g: 1, f: -1 } };
    const map = matchRefinedLabels(preview, refined);
    expect([...map].sort()).toEqual([[0, 1], [1, 2], [2, 0]]);
    const res = relabelClusterResponse({ results: { p: { assignments: refined.p, cluster_counts: { 0: 2, 1: 2, 2: 2 }, filtered_read_ids: [] } },
      cluster_centroids: { 0: [0.1], 1: [0.5], 2: [0.9] } }, map);
    expect(res.results.p.assignments).toEqual({ a: 0, b: 0, c: 1, d: 1, e: 2, g: 2, f: -1 });
    expect(res.cluster_centroids).toEqual({ 1: [0.1], 2: [0.5], 0: [0.9] });
    expect(res.results.p.cluster_counts).toEqual({ 1: 2, 2: 2, 0: 2 });
  });

  it('a refit cluster with no preview counterpart keeps its number when free, else the smallest free one', () => {
    const preview = { p: { a: 0, b: 1 } };
    const refined = { p: { a: 1, b: 0, c: 2, d: 3 } };
    const map = matchRefinedLabels(preview, refined);
    expect(map.get(1)).toBe(0);
    expect(map.get(0)).toBe(1);
    expect(map.get(2)).toBe(2);
    expect(map.get(3)).toBe(3);
    // Identity: the response is returned as it is.
    const res = { results: {} };
    expect(relabelClusterResponse(res, new Map([[0, 0]]))).toBe(res);
  });
});
