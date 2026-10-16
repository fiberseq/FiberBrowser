import { useCallback, useMemo } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';

/**
 * Picking clusters for the charts (fb-n5-charts).
 *
 * The charts read the app's one cluster selection (clusterSlice
 * `selectedClusters`, keyed by panel state key): a cluster picked in the read
 * panel, on the Overview cards or on the map is picked in Profiles,
 * Composition, V-plot and Differences too, and a pick made on a chart's
 * names shows up everywhere else. Nothing picked means every cluster is shown.
 */

/** The clusters picked in any of `keys` (the union, as the Overview reads it). */
export function pickedClusterIds(
  selected: Record<string, Set<number> | undefined>,
  keys: string[],
): Set<number> {
  const ids = new Set<number>();
  for (const key of keys) for (const cluster of selected[key] ?? []) ids.add(cluster);
  return ids;
}

/** The clusters a chart draws: the picked ones among `data`, or all when none of them is picked. */
export function pickedClusterData<T extends { cluster: number }>(data: T[], picked: Set<number>): T[] {
  if (picked.size === 0) return data;
  const kept = data.filter(item => picked.has(item.cluster));
  return kept.length > 0 ? kept : data;
}

/** The selection after clicking a cluster's name: it is added, or removed if already picked. */
export function togglePick(picked: Set<number>, cluster: number): Set<number> {
  const next = new Set(picked);
  if (next.has(cluster)) next.delete(cluster);
  else next.add(cluster);
  return next;
}

export interface ClusterPicks {
  picked: Set<number>;
  /** Add the cluster to the pick, or take it out. */
  toggle: (cluster: number) => void;
  /** Pick only these clusters. */
  pickOnly: (clusters: number[]) => void;
  /** Show every cluster again (clears the pick). */
  clear: () => void;
}

/** The shared pick for these panel state keys, applied to all of them at once. */
export function useClusterPicks(keys: string[]): ClusterPicks {
  const selectedClusters = useBrowserStore(s => s.selectedClusters);
  const setClusterSelection = useBrowserStore(s => s.setClusterSelection);
  const clearClusterSelection = useBrowserStore(s => s.clearClusterSelection);
  // Keyed by content: callers pass a fresh array each render.
  const keySignature = keys.join('\u0000');
  const stableKeys = useMemo(() => (keySignature ? keySignature.split('\u0000') : []), [keySignature]);
  const picked = useMemo(() => pickedClusterIds(selectedClusters, stableKeys), [selectedClusters, stableKeys]);
  const apply = useCallback((next: Set<number>) => {
    for (const key of stableKeys) {
      if (next.size === 0) clearClusterSelection(key);
      else setClusterSelection(key, new Set(next));
    }
  }, [stableKeys, setClusterSelection, clearClusterSelection]);
  const toggle = useCallback((cluster: number) => apply(togglePick(picked, cluster)), [apply, picked]);
  const pickOnly = useCallback((clusters: number[]) => apply(new Set(clusters)), [apply]);
  const clear = useCallback(() => apply(new Set()), [apply]);
  return { picked, toggle, pickOnly, clear };
}
