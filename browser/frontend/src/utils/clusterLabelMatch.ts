/**
 * Cluster labels that stay put when a preview is refined. A Cluster run shows a preview fitted on the reads drawn,
 * then refits on the full active subset: k-means numbers its clusters arbitrarily, so the refit's C0 could be the
 * preview's C2 and every colour, label and profile would swap under the user. The refit's clusters are renamed to
 * the preview cluster they share most reads with (greedy on the overlap table); a refit cluster with no preview
 * counterpart keeps its own number when free, else takes the smallest free one. Sizes still change (the refit sees
 * more reads): that is the data, not a relabelling.
 *
 * Only for fits whose numbers carry no meaning (not combinatorial patterns, whose label is the pattern). Negative
 * labels (unassigned, hidden buckets) are never renamed.
 */
import type { ClusterResponse } from '../types';

type Assignments = Record<string, Record<string, number>>;

export function matchRefinedLabels(preview: Assignments, refined: Assignments): Map<number, number> {
  const before = new Map<string, number>();
  for (const byRead of Object.values(preview)) for (const [id, c] of Object.entries(byRead ?? {})) if (c >= 0) before.set(id, c);
  const overlap = new Map<string, number>();     // `${refined}|${preview}` -> shared reads
  const refinedLabels = new Set<number>();
  for (const byRead of Object.values(refined)) for (const [id, c] of Object.entries(byRead ?? {})) {
    if (c < 0) continue;
    refinedLabels.add(c);
    const p = before.get(id);
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
