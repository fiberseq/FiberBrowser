import { clusterWindows } from '../../../utils/clusterTargets';
import { useSplitPanelStore } from '../../../stores/splitPanelStore';
import { useMemo } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { useFocusedReadIds } from '../../../hooks/useFocusedReadIds';
import { computeEffectiveReadIdsByStateKey, flattenScopedReadIds, flattenScopedReadIdsForDataset } from '../../../utils/readScopes';

/**
 * The reads a position x position matrix counts (the Co-accessibility panel and the NFR pairs tab's Position
 * correlation): the targeted panels' datasets, with their cluster focus and read filters intersected per state key.
 * Combined requests keep dataset-scoped read IDs so repeated read names in different datasets cannot leak between
 * cohorts. `readIdsForDataset`: one dataset's scope (undefined: all its reads).
 */
export function useCoaccScope() {
  useSplitPanelStore(s => s.reads);
  const filteredReadIds = useBrowserStore(s => s.filteredReadIds);
  const { targetDatasetIds, targetStateKeys, stateKeyMap, focusedReadIdSets, hasClusterFocus } = useFocusedReadIds();
  const cohortKey = useBrowserStore(s => JSON.stringify(clusterWindows(s, targetDatasetIds).filter(w => targetStateKeys.includes(w.result_key))
    .filter(w => w.read_ids !== undefined).map(w => [w.result_key, w.read_ids])));
  const effectiveReadIdsByStateKey = useMemo(() => {
    const base = computeEffectiveReadIdsByStateKey(targetStateKeys, focusedReadIdSets, filteredReadIds) ?? {};
    for (const [key, ids] of JSON.parse(cohortKey) as [string, string[]][]) base[key] = base[key] ? ids.filter(id => base[key].includes(id)) : ids;
    return Object.keys(base).length ? base : null;
  }, [targetStateKeys, focusedReadIdSets, filteredReadIds, cohortKey]);
  const effectiveReadIds = useMemo(
    () => flattenScopedReadIds(effectiveReadIdsByStateKey, targetStateKeys, { preserveEmptyScope: true }),
    [effectiveReadIdsByStateKey, targetStateKeys],
  );
  const readIdsForDataset = useMemo(() => (datasetId: string) => flattenScopedReadIdsForDataset(
    effectiveReadIdsByStateKey, stateKeyMap, datasetId, { preserveEmptyScope: true },
  ), [effectiveReadIdsByStateKey, stateKeyMap]);
  const effectiveReadIdsByDataset = useMemo(() => {
    const scoped: Record<string, string[]> = {};
    for (const datasetId of targetDatasetIds) {
      const ids = readIdsForDataset(datasetId);
      if (ids !== undefined) scoped[datasetId] = ids;
    }
    return Object.keys(scoped).length > 0 ? scoped : undefined;
  }, [readIdsForDataset, targetDatasetIds]);
  return {
    targetDatasetIds, targetStateKeys, stateKeyMap, hasClusterFocus, filteredReadIds,
    effectiveReadIdsByStateKey, effectiveReadIds, effectiveReadIdsByDataset, readIdsForDataset,
  };
}
