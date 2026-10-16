/**
 * Names for cluster ids that a group source gave them (the SV allele split's
 * "Carriers" / "Reference" / "Not informative"), read by getClusterLabel at
 * its ~20 call sites. Kept in step with the store's `clusterGroupLabels` by a
 * subscription in browserStore.ts. A name applies when every panel that names
 * the id agrees on it.
 */
let current: Map<number, string> = new Map();

export function setClusterGroupLabelSource(
  byStateKey: Record<string, Record<number, string>> | null | undefined,
  /** Every panel's clusters: an id another panel uses unnamed ("Cluster 0") is never renamed. */
  assignments?: Record<string, Record<string, number>> | null,
): void {
  const next = new Map<number, string>();
  const conflicted = new Set<number>();
  for (const [stateKey, map] of Object.entries(assignments ?? {})) {
    if (byStateKey?.[stateKey]) continue;
    for (const id of new Set(Object.values(map ?? {}))) conflicted.add(id);
  }
  for (const labels of Object.values(byStateKey ?? {})) {
    for (const [rawId, label] of Object.entries(labels ?? {})) {
      const id = Number(rawId);
      if (!Number.isFinite(id) || !label) continue;
      const have = next.get(id);
      if (have !== undefined && have !== label) conflicted.add(id);
      else next.set(id, label);
    }
  }
  for (const id of conflicted) next.delete(id);
  current = next;
}

export function clusterGroupLabel(cluster: number): string | undefined {
  return current.get(cluster);
}
