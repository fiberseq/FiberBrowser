/**
 * Which reads an export is about: the selected reads, the reads shown in the
 * view, the reads a filter kept, or one cluster's reads. Built from the same
 * pieces Read Stats uses (utils/readStatsScope.ts), over the dataset panels on
 * screen, in each panel's display order, and grouped by dataset and locus (a
 * panel navigated elsewhere has its reads at its own region).
 */
import type { BrowserState } from '../stores/browserStore';
import { orderAssignmentReadIds } from './clusterExport';
import { clusterOfScope, idsForScope, scopeOptions, type ReadStatsScope } from './readStatsScope';

export type ReadScopeKey = ReadStatsScope | 'filtered';

export interface ReadScopeOption {
  key: ReadScopeKey;
  label: string;
  count: number;
}

/** One dataset's reads at one region. */
export interface ReadScopeGroup {
  datasetId: string;
  stateKey: string;
  chrom: string;
  start: number;
  end: number;
  /** The panel's own reference (PanelConfig.genome, sent as panel_genome); absent: the main genome. */
  genome?: string;
  readIds: string[];
}

type ScopeState = Pick<BrowserState,
  'chrom' | 'start' | 'end' | 'panels' | 'datasets' | 'collapsedRows' | 'fullViewPanelId' | 'selectedReadIds'
  | 'activeReadIds' | 'clusterAssignments' | 'clusterOrder' | 'readSortOrder' | 'jupyterReadOrder' | 'filteredReadIds'>;

/** Dataset panels on screen, by state key: not minimized, not in a collapsed row, not behind a maximized panel. */
export function onScreenStateKeys(state: ScopeState): string[] {
  const datasetPanels = state.panels.filter(p => p.contentType === 'dataset' && p.datasetId);
  const maximized = datasetPanels.find(p => p.id === state.fullViewPanelId);
  const onScreen = maximized
    ? [maximized]
    : datasetPanels.filter(p => !p.collapsed && !state.collapsedRows?.has(p.layoutRow ?? 0));
  return [...new Set(onScreen.map(p => p.stateKey ?? p.datasetId!))];
}

function datasetOf(state: ScopeState, stateKey: string): string {
  const panel = state.panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === stateKey);
  return panel?.datasetId ?? stateKey;
}

/** Where a panel's reads are: its locus (its own, else the main one) and its own reference, if any. */
function regionOf(state: ScopeState, stateKey: string): { chrom: string; start: number; end: number; genome?: string } {
  const panel = state.panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === stateKey);
  const v = panel?.viewportOverride;
  const locus = v ? { chrom: v.chrom, start: v.start, end: v.end } : { chrom: state.chrom, start: state.start, end: state.end };
  return panel?.genome ? { ...locus, genome: panel.genome } : locus;
}

/** "dm6|chr2L:1-2" (a region on another reference is another region, at the same coordinates too). */
const regionKey = (r: { chrom: string; start: number; end: number; genome?: string }) =>
  `${r.genome ?? ''}|${r.chrom}:${r.start}-${r.end}`;

function orderOptions(state: ScopeState) {
  return {
    datasets: state.datasets, panels: state.panels, readSortOrder: state.readSortOrder,
    clusterOrder: state.clusterOrder, activeReadIds: state.activeReadIds, jupyterReadOrder: state.jupyterReadOrder,
  };
}

function selectedByKey(state: ScopeState, stateKeys: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const sk of stateKeys) {
    const ids = state.selectedReadIds[sk];
    if (!ids || ids.size === 0) continue;
    const members: Record<string, number> = {};
    for (const id of ids) members[id] = state.clusterAssignments[sk]?.[id] ?? 0;
    out[sk] = orderAssignmentReadIds(sk, members, orderOptions(state));
  }
  return out;
}

function filteredByKey(state: ScopeState, stateKeys: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const sk of stateKeys) {
    const kept = state.filteredReadIds[sk];
    if (!kept) continue;
    const members: Record<string, number> = {};
    for (const id of kept) members[id] = state.clusterAssignments[sk]?.[id] ?? 0;
    out[sk] = orderAssignmentReadIds(sk, members, orderOptions(state));
  }
  return out;
}

const countOf = (byKey: Record<string, string[]>, identity: (sk: string) => string) => {
  const seen = new Set<string>();
  for (const [sk, ids] of Object.entries(byKey)) for (const id of ids) seen.add(`${identity(sk)}\t${id}`);
  return seen.size;
};

/** The scopes to choose from, with their read counts (Selected, Shown, Filtered, then each cluster). */
export function readScopeOptions(state: ScopeState): ReadScopeOption[] {
  const stateKeys = onScreenStateKeys(state);
  const identity = (sk: string) => {
    return `${datasetOf(state, sk)}@${regionKey(regionOf(state, sk))}`;
  };
  const base = scopeOptions({
    selectionCount: countOf(selectedByKey(state, stateKeys), identity),
    shownByKey: state.activeReadIds,
    assignments: state.clusterAssignments,
    stateKeys,
    clusterOrder: state.clusterOrder[stateKeys[0] ?? ''],
    identityOf: identity,
  });
  const filtered: ReadScopeOption = { key: 'filtered', label: 'Filtered reads', count: countOf(filteredByKey(state, stateKeys), identity) };
  const [selection, shown, ...clusters] = base;
  return [
    { key: selection.key, label: selection.label, count: selection.count },
    { key: shown.key, label: 'Reads shown in the view', count: shown.count },
    filtered,
    ...clusters.map(c => ({ key: c.key, label: c.label, count: c.count })),
  ];
}

/** The default scope: the selection when there is one, else the reads shown. */
export function defaultReadScope(options: ReadScopeOption[]): ReadScopeKey {
  return (options.find(o => o.key === 'selection')?.count ?? 0) > 0 ? 'selection' : 'shown';
}

/** The scope's reads, per dataset and region, in display order (each read once per dataset and region). */
export function readScopeGroups(state: ScopeState, scope: ReadScopeKey): ReadScopeGroup[] {
  const stateKeys = onScreenStateKeys(state);
  let byKey: Record<string, string[]>;
  if (scope === 'filtered') byKey = filteredByKey(state, stateKeys);
  else if (scope === 'selection') byKey = selectedByKey(state, stateKeys);
  else {
    byKey = idsForScope(scope, {
      selectedByKey: {},
      shownByKey: state.activeReadIds,
      assignments: state.clusterAssignments,
      stateKeys,
      orderAssigned: (sk, members) => orderAssignmentReadIds(sk, members, orderOptions(state)),
    });
  }
  const groups = new Map<string, ReadScopeGroup>();
  for (const sk of stateKeys) {
    const ids = byKey[sk];
    if (!ids?.length) continue;
    const datasetId = datasetOf(state, sk);
    const region = regionOf(state, sk);
    const key = `${datasetId}@${regionKey(region)}`;
    let group = groups.get(key);
    if (!group) {
      group = { datasetId, stateKey: sk, ...region, readIds: [] };
      groups.set(key, group);
    }
    const seen = new Set(group.readIds);
    for (const id of ids) if (!seen.has(id)) { seen.add(id); group.readIds.push(id); }
  }
  return [...groups.values()];
}

/** "selected", "shown", "filtered", "cluster_3" for file names. */
export function readScopeSlug(scope: ReadScopeKey): string {
  const cluster = scope === 'filtered' ? null : clusterOfScope(scope);
  if (cluster != null) return `cluster_${cluster}`;
  return scope === 'selection' ? 'selected' : scope;
}

/** "the selected reads", "cluster 3's reads" for messages. */
export function describeReadScope(scope: ReadScopeKey, options: ReadScopeOption[]): string {
  const option = options.find(o => o.key === scope);
  if (scope === 'selection') return 'the selected reads';
  if (scope === 'shown') return 'the reads shown';
  if (scope === 'filtered') return 'the filtered reads';
  return `${option?.label ?? 'the cluster'}'s reads`;
}
