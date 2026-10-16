import { useMemo } from 'react';
import { useBrowserStore, getTargetDatasetIds, getStateKeyMap } from '../stores/browserStore';
import { hasActiveClusterFocus, readIdsForClusterFocus } from '../utils/readScopes';

/** Pure utility: build reverse map from stateKey → datasetId. */
export function buildStateKeyToDs(stateKeyMap: Record<string, string[]>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [dsId, sks] of Object.entries(stateKeyMap)) {
    for (const sk of sks) map[sk] = dsId;
  }
  return map;
}

/**
 * Derives the focused read IDs per stateKey from cluster assignments + cluster focus.
 * Used by analysis panels that need cluster-focus-aware filtering.
 *
 * Returns:
 *  - targetDatasetIds: string[] — dataset IDs resolved via linkGroup-aware helper
 *  - targetStateKeys: string[] — stateKeys for targeted panels (for state map lookups)
 *  - stateKeyMap: Record<string, string[]> — datasetId → stateKeys
 *  - focusedReadIdArrays: Record<string, string[]> | null — arrays per stateKey (for backend calls)
 *  - focusedReadIdSets: Record<string, Set<string> | null> — sets per stateKey (for frontend filtering)
 *  - hasClusterFocus: boolean — whether any stateKey has active cluster focus
 */
export function useFocusedReadIds() {
  const datasets = useBrowserStore(s => s.datasets);
  const selectedDatasets = useBrowserStore(s => s.selectedDatasets);
  const panels = useBrowserStore(s => s.panels);
  const clusterAssignments = useBrowserStore(s => s.clusterAssignments);
  const clusterFocus = useBrowserStore(s => s.clusterFocus);

  const targetDatasetIds = useMemo(() =>
    getTargetDatasetIds(selectedDatasets, panels, datasets),
    [selectedDatasets, panels, datasets]
  );

  const stateKeyMap = useMemo(() =>
    getStateKeyMap(selectedDatasets, panels, datasets),
    [selectedDatasets, panels, datasets]
  );

  // Flat list of all targeted state keys
  const targetStateKeys = useMemo(() => {
    const keys: string[] = [];
    for (const dsId of targetDatasetIds) {
      for (const sk of (stateKeyMap[dsId] ?? [dsId])) {
        if (!keys.includes(sk)) keys.push(sk);
      }
    }
    return keys;
  }, [targetDatasetIds, stateKeyMap]);

  // Array-based (for backend API calls, e.g. FootprintAnalysisPanel)
  const focusedReadIdArrays = useMemo(() => {
    const result: Record<string, string[]> = {};
    let hasAny = false;
    for (const sk of targetStateKeys) {
      const focus = clusterFocus[sk];
      const assignments = clusterAssignments[sk] || {};
      const ids = readIdsForClusterFocus(assignments, focus);
      if (ids === null) continue;
      hasAny = true;
      result[sk] = ids;
    }
    return hasAny ? result : null;
  }, [targetStateKeys, clusterFocus, clusterAssignments]);

  // Set-based (for frontend filtering, e.g. TranscriptionStatePanel)
  const focusedReadIdSets = useMemo(() => {
    const result: Record<string, Set<string> | null> = {};
    for (const sk of targetStateKeys) {
      const focus = clusterFocus[sk];
      const assignments = clusterAssignments[sk] || {};
      const ids = readIdsForClusterFocus(assignments, focus);
      if (ids === null) {
        result[sk] = null;
        continue;
      }
      result[sk] = new Set(ids);
    }
    return result;
  }, [targetStateKeys, clusterFocus, clusterAssignments]);

  const hasClusterFocus = useMemo(() =>
    targetStateKeys.some(sk => hasActiveClusterFocus(clusterFocus[sk])),
    [targetStateKeys, clusterFocus]
  );

  return { targetDatasetIds, targetStateKeys, stateKeyMap, focusedReadIdArrays, focusedReadIdSets, hasClusterFocus };
}
