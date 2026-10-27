import { idSetHas, recordKey } from './recordKeys';

export type ReadIdSets = Record<string, Set<string> | null | undefined>;
export type StateKeyMap = Record<string, string[]>;
export type ClusterFocusSet = Set<number> | null | undefined;
export type ClusterAssignments = Record<string, number>;

export function hasActiveClusterFocus(focus: ClusterFocusSet): focus is Set<number> {
  return focus != null && focus.size > 0;
}

/**
 * Whether a child cluster branch limits this panel's reads to the branch's
 * reads. Only panels the branch was computed for (it has assignments under
 * their state key) take part; a panel copied afterwards keeps all its reads.
 */
export function branchScopesPanel(
  branch: { parentId: string | null; assignments?: Record<string, unknown>; refinement?: boolean } | null | undefined,
  stateKey: string,
): boolean {
  // (A refinement within carriers keeps every read of its parent: not a subset branch.)
  return Boolean(branch?.parentId && !branch.refinement && branch.assignments && stateKey in branch.assignments);
}

export function readIdsForClusterFocus(
  assignments: ClusterAssignments | null | undefined,
  focus: ClusterFocusSet,
): string[] | null {
  if (!hasActiveClusterFocus(focus)) return null;
  const ids: string[] = [];
  for (const [readId, cluster] of Object.entries(assignments ?? {})) {
    if (focus.has(cluster)) ids.push(readId);
  }
  return ids;
}

export function readIdSetForClusterRenderScope(
  assignments: ClusterAssignments | null | undefined,
  focus: ClusterFocusSet,
  includeAllAssigned: boolean,
): Set<string> | null {
  const ids = readIdsForClusterFocus(assignments, focus);
  if (ids) return new Set(ids);
  if (!includeAllAssigned) return null;
  return new Set(Object.keys(assignments ?? {}));
}

export function computeEffectiveReadIdsByStateKey(
  targetStateKeys: string[],
  focusedReadIdSets: ReadIdSets,
  filteredReadIds: ReadIdSets,
): Record<string, string[]> | null {
  const result: Record<string, string[]> = {};
  let hasAnyScope = false;

  for (const stateKey of targetStateKeys) {
    const clusterSet = focusedReadIdSets[stateKey];
    const filterSet = filteredReadIds[stateKey];
    let ids: string[] | null = null;

    if (clusterSet && filterSet) {
      ids = [];
      for (const id of clusterSet) {
        if (idSetHas(filterSet, [id], recordKey(id))) ids.push(id);   // record-keyed filters too
      }
    } else if (clusterSet) {
      ids = Array.from(clusterSet);
    } else if (filterSet) {
      // An applied filter that matched nothing scopes to no reads.
      ids = Array.from(filterSet);
    }

    if (ids) {
      hasAnyScope = true;
      result[stateKey] = ids;
    }
  }

  return hasAnyScope ? result : null;
}

export function flattenScopedReadIds(
  scopedByStateKey: Record<string, string[]> | null | undefined,
  stateKeys: string[],
  options: { preserveEmptyScope?: boolean } = {},
): string[] | undefined {
  if (!scopedByStateKey) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  let sawExplicitScope = false;
  for (const stateKey of stateKeys) {
    const scopedIds = scopedByStateKey[stateKey];
    if (!scopedIds) continue;
    sawExplicitScope = true;
    for (const id of scopedIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  if (out.length === 0 && sawExplicitScope && options.preserveEmptyScope) return [];
  return out.length > 0 ? out : undefined;
}

export function flattenScopedReadIdsForDataset(
  scopedByStateKey: Record<string, string[]> | null | undefined,
  stateKeyMap: StateKeyMap,
  datasetId: string,
  options: { preserveEmptyScope?: boolean } = {},
): string[] | undefined {
  return flattenScopedReadIds(scopedByStateKey, stateKeyMap[datasetId] ?? [datasetId], options);
}

export function mapScopedReadIdsToDatasetIds(
  scopedByStateKey: Record<string, string[]> | null | undefined,
  stateKeyMap: StateKeyMap,
  options: { preserveEmptyScope?: boolean } = { preserveEmptyScope: true },
): Record<string, string[]> | null {
  if (!scopedByStateKey) return null;
  const datasetIds = new Set<string>(Object.keys(stateKeyMap));
  for (const stateKey of Object.keys(scopedByStateKey)) {
    if (!Object.values(stateKeyMap).some(keys => keys.includes(stateKey))) {
      datasetIds.add(stateKey);
    }
  }

  const result: Record<string, string[]> = {};
  for (const datasetId of datasetIds) {
    const ids = flattenScopedReadIdsForDataset(scopedByStateKey, stateKeyMap, datasetId, options);
    if (ids !== undefined) result[datasetId] = ids;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function readScopeSignature(
  scopedByStateKey: Record<string, string[]> | null | undefined,
): string {
  if (!scopedByStateKey) return 'none';
  const parts = Object.entries(scopedByStateKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stateKey, ids]) => {
      const sortedIds = [...ids].sort();
      return `${stateKey}:${sortedIds.length}:${sortedIds.join('\u0002')}`;
    });
  return parts.length > 0 ? parts.join('\u0001') : 'none';
}
