import { getClusterColor, getClusterLabel, UNASSIGNED_CLUSTER_ID } from '../components/tracks/read-track/constants';

/**
 * Which reads Read Stats describes: the selected reads, every read shown in
 * the dataset panels, or one cluster's reads.
 */
export type ReadStatsScope = 'selection' | 'shown' | `cluster:${number}`;

/** Most reads one request asks statistics for (the server caps at the same number). */
export const MAX_READ_STATS_READS = 5000;

export interface ReadStatsScopeOption {
  key: ReadStatsScope;
  label: string;
  count: number;
  color?: string;
}

type Assignments = Record<string, Record<string, number>>;

export function clusterOfScope(scope: ReadStatsScope): number | null {
  return scope.startsWith('cluster:') ? Number(scope.slice('cluster:'.length)) : null;
}

/** Clusters in display order: the panel's cluster order, then by id; unassigned last. */
export function sortClusters(clusters: number[], order?: number[]): number[] {
  const rank = new Map((order ?? []).map((c, i) => [c, i]));
  return [...clusters].sort((a, b) => {
    if (a === UNASSIGNED_CLUSTER_ID || b === UNASSIGNED_CLUSTER_ID) return a === b ? 0 : a === UNASSIGNED_CLUSTER_ID ? 1 : -1;
    const ra = rank.get(a), rb = rank.get(b);
    if (ra != null && rb != null) return ra - rb;
    if (ra != null || rb != null) return ra != null ? -1 : 1;
    return a - b;
  });
}

/** Cluster ids with their read counts over the given panels' assignments, in display order. */
export function clusterCounts(assignments: Assignments, stateKeys: string[], order?: number[]): Array<[number, number]> {
  const counts = new Map<number, number>();
  for (const sk of stateKeys) {
    for (const cluster of Object.values(assignments[sk] ?? {})) counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
  }
  return sortClusters([...counts.keys()], order).map(c => [c, counts.get(c)!]);
}

export function scopeOptions({
  selectionCount, shownByKey, assignments, stateKeys, clusterOrder, identityOf = sk => sk,
}: {
  selectionCount: number;
  shownByKey: Record<string, string[]>;
  assignments: Assignments;
  stateKeys: string[];
  clusterOrder?: number[];
  /** Panels showing the same reads (a dataset at one locus) share an identity: their reads count once. */
  identityOf?: (stateKey: string) => string;
}): ReadStatsScopeOption[] {
  const shown = new Set<string>();
  for (const sk of stateKeys) for (const id of shownByKey[sk] ?? []) shown.add(`${identityOf(sk)}\t${id}`);
  const byCluster = new Map<number, Set<string>>();
  for (const sk of stateKeys) {
    for (const [id, cluster] of Object.entries(assignments[sk] ?? {})) {
      if (!byCluster.has(cluster)) byCluster.set(cluster, new Set());
      byCluster.get(cluster)!.add(`${identityOf(sk)}\t${id}`);
    }
  }
  return [
    { key: 'selection', label: 'Selected reads', count: selectionCount },
    { key: 'shown', label: 'Reads shown', count: shown.size },
    ...sortClusters([...byCluster.keys()], clusterOrder).map(cluster => ({
      key: `cluster:${cluster}` as ReadStatsScope,
      label: getClusterLabel(cluster),
      count: byCluster.get(cluster)!.size,
      color: getClusterColor(cluster),
    })),
  ];
}

/** Read ids per panel (state key) for a scope, in the order the panels show them. */
export function idsForScope(
  scope: ReadStatsScope,
  {
    selectedByKey, shownByKey, assignments, stateKeys, orderAssigned,
  }: {
    selectedByKey: Record<string, string[]>;
    shownByKey: Record<string, string[]>;
    assignments: Assignments;
    stateKeys: string[];
    /** The panel's display order for a set of assigned reads. */
    orderAssigned: (stateKey: string, assignments: Record<string, number>) => string[];
  },
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (scope === 'selection') {
    for (const [sk, ids] of Object.entries(selectedByKey)) if (ids.length) out[sk] = ids;
    return out;
  }
  if (scope === 'shown') {
    for (const sk of stateKeys) if (shownByKey[sk]?.length) out[sk] = shownByKey[sk];
    return out;
  }
  const cluster = clusterOfScope(scope);
  for (const sk of stateKeys) {
    const members: Record<string, number> = {};
    for (const [id, c] of Object.entries(assignments[sk] ?? {})) if (c === cluster) members[id] = c;
    if (Object.keys(members).length) out[sk] = orderAssigned(sk, members);
  }
  return out;
}

interface RegionIds { read_ids_by_dataset: Record<string, string[]> }

/**
 * The first `max` reads of a request (the main view's reads, then each other
 * locus), in order, after panels showing the same reads were merged.
 */
export function capRequest<R extends RegionIds>(main: Record<string, string[]>, regions: R[], max = MAX_READ_STATS_READS): {
  main: Record<string, string[]>;
  regions: R[];
  total: number;
  truncated: boolean;
} {
  const total = [main, ...regions.map(r => r.read_ids_by_dataset)]
    .reduce((n, byDs) => n + Object.values(byDs).reduce((m, ids) => m + ids.length, 0), 0);
  if (total <= max) return { main, regions, total, truncated: false };
  let budget = max;
  const take = (byDs: Record<string, string[]>) => {
    const out: Record<string, string[]> = {};
    for (const [ds, ids] of Object.entries(byDs)) {
      if (budget <= 0) break;
      out[ds] = ids.slice(0, budget);
      budget -= out[ds].length;
    }
    return out;
  };
  const cappedMain = take(main);
  const cappedRegions = regions
    .map(r => ({ ...r, read_ids_by_dataset: take(r.read_ids_by_dataset) }))
    .filter(r => Object.keys(r.read_ids_by_dataset).length > 0);
  return { main: cappedMain, regions: cappedRegions, total, truncated: true };
}

export interface ClusterSummaryRow {
  cluster: number;
  label: string;
  color: string;
  n: number;
  meanAccessibility: number;
  meanFootprints: number;
  meanFootprintSize: number;
  meanModPct: number | null;
}

/** Per-cluster means over per-read statistics (the "By cluster" table). */
export function summarizeByCluster(
  rows: Array<{ read_id: string; dataset_id: string; accessibility_pct: number; footprint_count: number; avg_footprint_size: number; methyl_pct: number | null }>,
  clusterOf: (datasetId: string, readId: string) => number | undefined,
  order?: number[],
): ClusterSummaryRow[] {
  const acc = new Map<number, { n: number; a: number; f: number; s: number; sN: number; m: number; mN: number }>();
  for (const r of rows) {
    const c = clusterOf(r.dataset_id, r.read_id);
    if (c == null) continue;
    const e = acc.get(c) ?? { n: 0, a: 0, f: 0, s: 0, sN: 0, m: 0, mN: 0 };
    e.n += 1; e.a += r.accessibility_pct; e.f += r.footprint_count;
    if (r.footprint_count > 0) { e.s += r.avg_footprint_size; e.sN += 1; }
    if (r.methyl_pct != null) { e.m += r.methyl_pct; e.mN += 1; }
    acc.set(c, e);
  }
  return sortClusters([...acc.keys()], order).map(c => {
    const e = acc.get(c)!;
    return {
      cluster: c,
      label: getClusterLabel(c),
      color: getClusterColor(c),
      n: e.n,
      meanAccessibility: e.a / e.n,
      meanFootprints: e.f / e.n,
      meanFootprintSize: e.sN ? e.s / e.sN : 0,
      meanModPct: e.mN ? e.m / e.mN : null,
    };
  });
}
