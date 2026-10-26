import type { BrowserState } from '../stores/browserStore';
import type { ClusterTreeNode, FirePeak } from '../types';
import { clusterAssignmentForRead } from '../components/tracks/read-track/readFilter';
import { branchScopesPanel } from './readScopes';
import { idSetHas, qnameOfId, recordKey } from './recordKeys';
import { filterRegionGroups, type FilterRegionGroup } from './filterScopes';

export interface ResolveSortRequestScopeOptions {
  datasetIds: string[];
  sortKeyMap: Record<string, string[]>;
  clusterAssignments: Record<string, Record<string, number>>;
  selectedClusters: Record<string, Set<number> | null>;
  clusterFocus: Record<string, Set<number> | null>;
  filteredReadIds: Record<string, Set<string> | null>;
  activeClusterTreeNodeId: string | null;
  clusterTreeNodes: Record<string, ClusterTreeNode>;
  /** Explicit panel membership (split panels); never the display sample. */
  panelReadIds?: Record<string, string[]>;
}

export interface SortRequestScope {
  readIds: Record<string, string[]>;
  clusterAssignments: Record<string, Record<string, number>>;
}

export function resolveSortRequestScope(options: ResolveSortRequestScopeOptions): SortRequestScope {
  const readIds: Record<string, string[]> = {};
  const clusterAssignmentsByDataset: Record<string, Record<string, number>> = {};

  const hasNonEmptyAssignments = (stateKey: string): boolean => {
    const assignments = options.clusterAssignments[stateKey];
    return !!assignments && Object.keys(assignments).length > 0;
  };

  for (const dsId of options.datasetIds) {
    const stateKeys = options.sortKeyMap[dsId] ?? [dsId];
    const stateKey = stateKeys.find(hasNonEmptyAssignments)
      ?? stateKeys.find(sk => (options.filteredReadIds[sk]?.size ?? 0) > 0)
      ?? stateKeys[0]
      ?? dsId;

    const assignments = options.clusterAssignments[stateKey] ?? {};
    // Even an unclustered panel must override the server's last clustering.
    clusterAssignmentsByDataset[dsId] = assignments;
    const selected = options.selectedClusters[stateKey];
    const focus = options.clusterFocus[stateKey];
    const activeNode = options.activeClusterTreeNodeId
      ? options.clusterTreeNodes[options.activeClusterTreeNodeId]
      : null;
    const scopes: string[][] = [];
    if (selected?.size) scopes.push(Object.keys(assignments).filter(id => selected.has(assignments[id])));
    if (focus?.size) scopes.push(Object.keys(assignments).filter(id => focus.has(assignments[id])));
    if (branchScopesPanel(activeNode, stateKey)) scopes.push(Object.keys(assignments));
    const filtered = options.filteredReadIds[stateKey];
    if (filtered != null) scopes.push([...filtered]);
    const panelIds = options.panelReadIds?.[stateKey];
    if (panelIds !== undefined) scopes.push(panelIds);
    if (scopes.length) {
      const [first, ...rest] = scopes;
      const sets = rest.map(ids => new Set(ids));
      // By identity (QNAME, cohort identity, record key: a graph run's labels are record keys; graph features review).
      readIds[dsId] = first.filter(id => sets.every(ids => idSetHas(ids, [id, qnameOfId(id)], recordKey(id))));
    }
  }

  return { readIds, clusterAssignments: clusterAssignmentsByDataset };
}

export function selectedPeakWindowsForSort<T extends { index: number; start: number; end: number }>(
  allPeaks: T[],
  selectedPeaks: Set<number>,
): number[][] | undefined {
  if (selectedPeaks.size === 0) return undefined;
  const selected = allPeaks.filter(p => selectedPeaks.has(p.index))
    .map(p => [p.start, p.end])
    .filter((span, index, all) => all.findIndex(other => other[0] === span[0] && other[1] === span[1]) === index);
  return selected.length > 0 ? selected : undefined;
}

/**
 * Sort requests in rounds, each with at most one panel (state key) per dataset:
 * a request carries one clustering per dataset, so two independently clustered
 * copies of a dataset go in separate rounds.
 */
export function sortRounds(datasetIds: string[], keyMap: Record<string, string[]>): Array<Record<string, string>> {
  const rounds: Array<Record<string, string>> = [];
  for (const dsId of datasetIds) {
    const keys = keyMap[dsId]?.length ? keyMap[dsId] : [dsId];
    keys.forEach((key, i) => {
      if (!rounds[i]) rounds[i] = {};
      rounds[i][dsId] = key;
    });
  }
  return rounds;
}

/**
 * A round's split lifted panels' haplotypes by dataset (graph features): a round has one state key per dataset, so a
 * MAT or PAT panel sorts only its own haplotype's rows. Pooled lifted panels and native panels send none.
 */
export function liftHapsForRound(round: Record<string, string>,
  panels: readonly { datasetId?: string | null; stateKey?: string | null; liftHap?: string | null; readSubset?: { rule: { liftHap?: string | null } } | null }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [dsId, key] of Object.entries(round)) {
    const p = panels.find(q => q.datasetId === dsId && (q.stateKey ?? q.datasetId) === key);
    const hap = p?.liftHap ?? p?.readSubset?.rule.liftHap;
    if (hap) out[dsId] = hap;
  }
  return out;
}

/** One sort request's view: a region on a reference, the panels showing it, its peaks and rule windows. */
export interface SortViewGroup extends FilterRegionGroup {
  /** The peaks of this view (its reference and chromosome; at another locus, inside it). */
  peaks: FirePeak[];
}

/**
 * Sort requests grouped by the view each target panel shows (fb-n4-integ):
 * its own locus and reference, else the main view. A panel moved on its own
 * (Each panel navigates) is sorted on its own reads, with the peaks and rule
 * scope of its view, instead of being skipped. Without a rule, `windows` is
 * unused (the selected peaks of the group's view decide the sort scope).
 */
export function sortViewGroups(args: Omit<Parameters<typeof filterRegionGroups>[0], 'rule'> & {
  rule?: Parameters<typeof filterRegionGroups>[0]['rule'];
}): SortViewGroup[] {
  return filterRegionGroups({ ...args, rule: args.rule ?? {} });
}

/** Reorder a subset in its existing slots, retaining the order of everything outside it. */
export function mergeScopedSortOrder<T extends string | number>(previous: T[], sorted: T[], scoped: boolean): T[] {
  if (!scoped) return sorted;
  const incoming = new Set(sorted);
  const existing = new Set(previous);
  const placed = sorted.filter(id => existing.has(id));
  let next = 0;
  return [...previous.map(id => incoming.has(id) ? placed[next++] : id), ...sorted.filter(id => !existing.has(id))];
}

/** A response must still belong to the same reads, filters and clustering. Display refetches don't invalidate it. */
export function sortStateStillCurrent(before: BrowserState, now: BrowserState, key: string): boolean {
  return before.spanningOnly === now.spanningOnly
    && before.signalFilters === now.signalFilters
    && before._lastRestoreTime === now._lastRestoreTime
    && before.clusterOrder[key] === now.clusterOrder[key]
    && before.clusterAssignments[key] === now.clusterAssignments[key]
    && before.filteredReadIds[key] === now.filteredReadIds[key]
    && before.selectedClusters[key] === now.selectedClusters[key]
    && before.clusterFocus[key] === now.clusterFocus[key]
    && before.readSortOrder[key] === now.readSortOrder[key]
    && before.jupyterReadOrder[key] === now.jupyterReadOrder[key]
    && before.panels.filter(p => (p.stateKey ?? p.datasetId) === key).every(p => {
      const current = now.panels.find(n => n.id === p.id);
      return current?.readSubset === p.readSubset && current?.strand === p.strand && current?.collapsed === p.collapsed;
    });
}

/** Whether the new ranks move any of the currently drawn rows (sampling preserves this relative order). */
export function sortMovesVisibleReads(ids: string[], reads: string[], clusters: number[], assignments: Record<string, number>): boolean {
  const readRank = new Map(reads.map((id, i) => [id, i]));
  const clusterRank = new Map(clusters.map((id, i) => [id, i]));
  const hasClusters = Object.keys(assignments).length > 0 && clusters.length > 0;
  const compare = (a: string, b: string) => {
    if (hasClusters) {
      const ca = clusterAssignmentForRead(assignments, a), cb = clusterAssignmentForRead(assignments, b);
      const diff = (ca == null ? Infinity : clusterRank.get(ca) ?? Infinity) - (cb == null ? Infinity : clusterRank.get(cb) ?? Infinity);
      if (diff) return diff;
    }
    return (readRank.get(a) ?? Infinity) - (readRank.get(b) ?? Infinity);
  };
  return ids.some((id, i) => i > 0 && compare(ids[i - 1], id) > 0);
}
