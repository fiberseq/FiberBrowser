/**
 * Cluster labels that stay put when a preview is refined. A Cluster run shows a preview fitted on the reads drawn,
 * then refits on the full active subset: k-means numbers its clusters arbitrarily, so the refit's C0 could be the
 * preview's C2 and every colour, label and profile would swap under the user. The refit's clusters are renamed to
 * the preview cluster they share most reads with (greedy on the overlap table); a refit cluster with no preview
 * counterpart keeps its own number when free, else takes the smallest free one. Sizes still change (the refit sees
 * more reads): that is the data, not a relabelling.
 *
 * Only for fits whose numbers carry no meaning (not combinatorial patterns, whose label is the pattern; not k-means,
 * whose numbers are canonical since 3.1.1: largest cluster first, ties by the smallest read id, so a refit and a
 * full-only run of the same reads, and the Python client's cluster_all, carry the same numbers). Negative labels
 * (unassigned, hidden buckets) are never renamed.
 */
import type { ClusterResponse } from '../types';

/** Methods whose cluster numbers the server makes canonical (services/cluster_assignment.canonical_cluster_labels). */
export const CANONICAL_CLUSTER_METHODS: ReadonlySet<string> = new Set(['kmeans', 'minibatch']);

/** Whether a refit after a preview takes the preview's cluster numbers: only for fits whose numbers mean nothing. */
export function refitTakesPreviewNumbers(method: string, fitted: { cluster_patterns?: Record<string | number, unknown> }): boolean {
  return method !== 'combinatorial' && method !== 'binary' && !CANONICAL_CLUSTER_METHODS.has(method)
    && !Object.keys(fitted.cluster_patterns ?? {}).length;
}

type Assignments = Record<string, Record<string, number>>;

export function matchRefinedLabels(preview: Assignments, refined: Assignments): Map<number, number> {
  // A read is identified by its window (result key) and name: the same read name in two windows can sit in different
  // clusters. A refit window with no preview window of the same key falls back to the name alone.
  const before = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const [key, byRead] of Object.entries(preview)) for (const [id, c] of Object.entries(byRead ?? {})) {
    if (c < 0) continue;
    before.set(`${key}\u0000${id}`, c);
    byName.set(id, c);
  }
  const overlap = new Map<string, number>();     // `${refined}|${preview}` -> shared reads
  const refinedLabels = new Set<number>();
  for (const [key, byRead] of Object.entries(refined)) for (const [id, c] of Object.entries(byRead ?? {})) {
    if (c < 0) continue;
    refinedLabels.add(c);
    const p = key in preview ? before.get(`${key}\u0000${id}`) : byName.get(id);
    if (p === undefined) continue;
    const k = `${c}|${p}`;
    overlap.set(k, (overlap.get(k) ?? 0) + 1);
  }
  const pairs = [...overlap].map(([k, n]) => { const [r, p] = k.split('|').map(Number); return { r, p, n }; })
    .sort((a, b) => b.n - a.n || a.r - b.r || a.p - b.p);
  const map = new Map<number, number>();
  const taken = new Set<number>();
  for (const { r, p } of pairs) {
    if (map.has(r) || taken.has(p)) continue;
    map.set(r, p); taken.add(p);
  }
  const rest = [...refinedLabels].filter(r => !map.has(r)).sort((a, b) => a - b);
  for (const r of rest) {
    let label = r;
    if (taken.has(label)) { label = 0; while (taken.has(label)) label += 1; }
    map.set(r, label); taken.add(label);
  }
  return map;
}

const remapKeys = <T,>(rec: Record<number, T> | undefined, map: Map<number, number>): Record<number, T> | undefined =>
  rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [map.get(Number(k)) ?? Number(k), v])) as Record<number, T> : rec;

/** The refit's response with its clusters renamed (assignments, counts and centroids alike). */
export function relabelClusterResponse<R extends { results: Record<string, ClusterResponse>; cluster_centroids?: Record<number, number[]> }>(
  res: R, map: Map<number, number>): R {
  if (![...map].some(([a, b]) => a !== b)) return res;
  const results = Object.fromEntries(Object.entries(res.results).map(([key, r]) => [key, {
    ...r,
    assignments: Object.fromEntries(Object.entries(r.assignments ?? {}).map(([id, c]) => [id, c >= 0 ? (map.get(c) ?? c) : c])),
    cluster_counts: remapKeys(r.cluster_counts, map) ?? r.cluster_counts,
  }]));
  return { ...res, results, ...(res.cluster_centroids ? { cluster_centroids: remapKeys(res.cluster_centroids, map) } : {}) };
}

/** State keyed by cluster number that a user can set while a preview is shown (order, focus, selection). */
export interface ClusterNumberState {
  clusterOrder: Record<string, number[]>;
  clusterFocus: Record<string, Set<number> | null>;
  selectedClusters: Record<string, Set<number>>;
}

/**
 * A k-means refit keeps its canonical numbers (refitTakesPreviewNumbers), so when the preview ranked sizes
 * otherwise, what the user set on the preview's clusters follows each cluster to its refit number (the refit
 * cluster sharing most reads, matchRefinedLabels). ``keys``: the state keys the refit writes. Returns only the
 * changed maps (empty when every number stays).
 */
export function carryPreviewClusterState(state: ClusterNumberState, keys: string[],
  preview: Assignments, refined: Assignments): Partial<ClusterNumberState> {
  // Per state key: a key's focus, order and selection follow its own clusters (matched on its own reads), never a
  // cluster another window's reads point to.
  const out: Partial<ClusterNumberState> = {};
  for (const key of keys) {
    if (!preview[key] || !refined[key]) continue;
    const refitToPreview = matchRefinedLabels({ [key]: preview[key] }, { [key]: refined[key] });
    const toRefit = new Map<number, number>();
    for (const [r, p] of refitToPreview) if (r !== p) toRefit.set(p, r);
    if (!toRefit.size) continue;
    const move = (c: number) => (c >= 0 ? (toRefit.get(c) ?? c) : c);
    const order = state.clusterOrder[key];
    if (order) out.clusterOrder = { ...(out.clusterOrder ?? state.clusterOrder), [key]: order.map(move) };
    const focus = state.clusterFocus[key];
    if (focus) out.clusterFocus = { ...(out.clusterFocus ?? state.clusterFocus), [key]: new Set([...focus].map(move)) };
    const selected = state.selectedClusters[key];
    if (selected?.size) out.selectedClusters = { ...(out.selectedClusters ?? state.selectedClusters), [key]: new Set([...selected].map(move)) };
  }
  return out;
}
