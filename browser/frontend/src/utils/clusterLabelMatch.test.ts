import { describe, expect, it } from 'vitest';
import { carryPreviewClusterState, matchRefinedLabels, refitTakesPreviewNumbers, relabelClusterResponse } from './clusterLabelMatch';

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

  it('k-means refits keep the server\'s canonical numbers (as a full-only run), even when the preview ranked sizes otherwise', () => {
    // 3.1.1: the preview's majority (C0) is the full fit's minority; the refit keeps the full fit's numbers, so a
    // full-only rerun of the same reads draws the same colours. Methods with meaningless numbers still follow the preview.
    expect(refitTakesPreviewNumbers('kmeans', {})).toBe(false);
    expect(refitTakesPreviewNumbers('minibatch', {})).toBe(false);
    expect(refitTakesPreviewNumbers('combinatorial', {})).toBe(false);
    expect(refitTakesPreviewNumbers('hdbscan', { cluster_patterns: { 0: [1] } })).toBe(false);
    expect(refitTakesPreviewNumbers('hdbscan', {})).toBe(true);
    expect(refitTakesPreviewNumbers('agglom', {})).toBe(true);
    expect(refitTakesPreviewNumbers('graph', {})).toBe(true);
  });

  it('a k-means refit whose sizes rank otherwise than the preview carries the preview\'s order, focus and selection', () => {
    // Preview: C0 = {a,b,c} (its majority), C1 = {d,e}. Full fit (canonical): the d/e cluster is now the larger, C0.
    const preview = { p: { a: 0, b: 0, c: 0, d: 1, e: 1 } };
    const refined = { p: { a: 1, b: 1, c: 1, d: 0, e: 0, f: 0, g: 0 } };
    const state = { clusterOrder: { p: [1, 0], q: [0, 1] }, clusterFocus: { p: new Set([0]) }, selectedClusters: { p: new Set([1]) } };
    const out = carryPreviewClusterState(state, ['p'], preview, refined);
    expect(out.clusterOrder).toEqual({ p: [0, 1], q: [0, 1] });
    expect([...out.clusterFocus!.p!]).toEqual([1]);       // the a/b/c cluster the user focused, now numbered 1
    expect([...out.selectedClusters!.p]).toEqual([0]);
    // Same ranking: nothing moves.
    expect(carryPreviewClusterState(state, ['p'], preview, { p: { a: 0, b: 0, c: 0, d: 1, e: 1 } })).toEqual({});
  });

  it('matches a read by its window and name: the same read names in two windows never move a window\'s focus', () => {
    // Codex R23: windows A and B hold the same three read names, in C0 and C1; the full fit keeps both labels.
    const preview = { A: { r1: 0, r2: 0, r3: 0 }, B: { r1: 1, r2: 1, r3: 1 } };
    const refined = { A: { r1: 0, r2: 0, r3: 0 }, B: { r1: 1, r2: 1, r3: 1 } };
    const state = { clusterOrder: {}, clusterFocus: { A: new Set([0]), B: new Set([1]) }, selectedClusters: { A: new Set([0]) } };
    expect(carryPreviewClusterState(state, ['A', 'B'], preview, refined)).toEqual({});
    expect([...matchRefinedLabels(preview, refined)]).toEqual([[0, 0], [1, 1]]);
  });
});
