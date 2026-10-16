/**
 * The cluster order after navigation reassigns reads to existing clusters.
 * Clusters keep the order they had (from clustering, or as the user arranged
 * them); clusters not in it yet (e.g. the unassigned group) go after them,
 * largest first. With no order yet, largest first. Null when nothing changes.
 */
export function mergeClusterOrder(current: number[] | undefined, counts: Array<[number, number]>): number[] | null {
  const bySize = [...counts].sort(([, a], [, b]) => b - a).map(([id]) => id);
  if (!current || current.length === 0) return bySize.length > 0 ? bySize : null;
  const known = new Set(current);
  const added = bySize.filter(id => !known.has(id));
  return added.length > 0 ? [...current, ...added] : null;
}
