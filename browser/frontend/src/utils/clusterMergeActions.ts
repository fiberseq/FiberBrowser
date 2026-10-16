/**
 * What every merge site shares (fb-n5-projection): the settings Merge similar
 * clusters runs with (the Clusters panel, the toolbar's button and Copilot all
 * use the stored ones, so what the map previews is what merges), and the
 * Unmerge record of a merge just applied (stores/clusterMergeLog.ts).
 */
import { useBrowserStore } from '../stores/browserStore';
import type { ClusterMergeKind } from '../stores/clusterMergeLog';
import type { MergeByOptions } from '../api/clustering';
import { currentMergeSettings, describeMergeSettings, type MergeSettings } from './mergeStrategies';

/** The stored Merge similar clusters settings, with what the request sends as "Merge by". */
export function storedMergeSettings(): MergeSettings & { mergeBy: MergeByOptions; summary: string } {
  const settings = currentMergeSettings(useBrowserStore.getState());
  return {
    ...settings,
    mergeBy: { strategy: settings.strategy, threshold: settings.threshold },
    summary: describeMergeSettings(settings),
  };
}

/** The clustering as it is now: taken before a merge, for its Unmerge record. */
export function clusteringBeforeMerge(): { assignments: Record<string, Record<string, number>>; order: Record<string, number[]> } {
  const s = useBrowserStore.getState();
  // Assignment maps are replaced, never edited in place: holding them is a snapshot.
  return { assignments: s.clusterAssignments, order: s.clusterOrder };
}

/** Record a merge just applied (call before its undo step is pushed). */
export function recordAppliedMerge(
  before: ReturnType<typeof clusteringBeforeMerge>,
  stateKeys: string[],
  info: { label: string; kind: ClusterMergeKind; settings?: MergeSettings },
): void {
  const { settings, ...rest } = info;
  useBrowserStore.getState().recordClusterMerge(before, stateKeys, {
    ...rest,
    ...(settings ? { settings: { strategy: settings.strategy, threshold: settings.threshold, minFraction: settings.minFraction } } : {}),
  });
}
