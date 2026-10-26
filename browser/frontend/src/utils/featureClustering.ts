/**
 * Read groups, sorts and filters from features (footprint classes, plugin packs' kinds): the main toolbar's Cluster
 * (combinatorial), Sort and Filter on selected features, and the groups "Split into panels" makes of them.
 *
 * Which grouping a selection gets in combinatorial mode: a plugin pack's own (registerCombinatorialPlanner) when it
 * takes the selection, else one group per pattern of the features' per-read states
 * (api/features.ts), with the reads not evaluated for all of them "Not informative".
 */
import { getFeatureStates, type FeatureStates } from '../api/features';
import { getStateKeyMap, getTargetDatasetIds, useBrowserStore } from '../stores/browserStore';
import { featureKindDef, featureKindWithActions, featureRegionMode, featureShortName, listedFeatureKinds, type FeatureRef } from '../stores/featureStore';
import { seedHistoryBaseline } from '../stores/historySlice';
import { useReadActionsStore } from '../stores/readActionsStore';
import { useSplitPanelStore, type SplitSource } from '../stores/splitPanelStore';
import { applyReadGroups, type ReadGroupsInput } from './readGroups';
import { sameChrom } from './chromAliases';
import { idSetHas, recordKey } from './recordKeys';
import { nextSortRequest, isCurrentSortRequest } from './sortRequests';
import { mergeScopedSortOrder, resolveSortRequestScope, sortStateStillCurrent } from './sortScope';
import { captureRunViews, runViewsStillCurrent } from './panelRunScope';

export const MAX_COMBINED_FEATURES = 8;

// ---------------------------------------------------------------- plugin packs' own groupings
/**
 * A plugin pack's grouping for a selection (its own runs' groups): undefined when the selection isn't one it groups
 * its own way (the per-read state patterns then).
 */
export interface CombinatorialPlanner {
  /** Cluster (combinatorial): the outcome (an error message, or null when applied). */
  cluster: (features: FeatureRef[], stateKeyMap: Record<string, string[]>, stillCurrent: () => boolean) => Promise<string | null> | undefined;
  /** "Split into panels": the source of the split. */
  splitSource: (features: FeatureRef[]) => SplitSource | undefined;
}

const planners: CombinatorialPlanner[] = [];

export function registerCombinatorialPlanner(planner: CombinatorialPlanner): void {
  planners.push(planner);
}

/** "footprint classes" (and plugin packs' kinds): the selectable kinds, as the hints name them. */
export function selectableKindsPhrase(): string {
  const names = featureKindNames();
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] ?? 'features';
}

/** Why a selection can't be clustered combinatorially (none, or too many), or null. */
export function combinatorialRefusal(features: FeatureRef[]): string | null {
  if (!features.length) return `Select ${selectableKindsPhrase()} first (shift-click them in the channels above the reads).`;
  if (features.length > MAX_COMBINED_FEATURES) {
    return `Choose up to ${MAX_COMBINED_FEATURES} features for a combinatorial clustering (${features.length} are selected): every pattern of them is a group.`;
  }
  return null;
}

/** The split a feature selection gets: a plugin pack's own (its planner), else the per-read state patterns. A string: why not. */
export function splitSourceForFeatures(features: FeatureRef[]): SplitSource | string {
  const refusal = combinatorialRefusal(features);
  if (refusal) return refusal;
  for (const planner of planners) {
    const source = planner.splitSource(features);
    if (source) return source;
  }
  return { kind: 'patterns', features };
}

// ---------------------------------------------------------------- groups from per-read states
export interface PatternGroup { id: number; key: string; label: string; count: number; pattern: number[] | null }

/**
 * One group per pattern of the features' states, over the reads evaluated for every feature that applies to their
 * dataset (a class applies to its own dataset only, as the Cart's co-occupancy does); the rest "Not informative".
 * Groups are numbered by size (largest 0), as the combination split numbers its patterns.
 */
export function patternGroups(states: FeatureStates, features: FeatureRef[]): ReadGroupsInput & { groups: PatternGroup[] } {
  const short = features.map(featureShortName);
  const counts = new Map<string, number>();
  const patternOf: Record<string, Record<string, string>> = {};
  const na: Record<string, string[]> = {};
  for (const [dataset, reads] of Object.entries(states.by_dataset)) {
    const applies = states.features.map((f, i) => (f.datasets.length ? f.datasets.includes(dataset) : (features[i].datasetId ?? dataset) === dataset));
    if (!applies.some(Boolean)) continue;
    for (const [name, s] of Object.entries(reads)) {
      const chars = [...s];
      if (chars.some((c, i) => applies[i] && c === '.')) { (na[dataset] ??= []).push(name); continue; }
      const key = chars.map((c, i) => (applies[i] ? c : '.')).join('');
      (patternOf[dataset] ??= {})[name] = key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const keys = [...counts.keys()].sort((a, b) => (counts.get(b)! - counts.get(a)!) || (a < b ? -1 : a > b ? 1 : 0));
  const idOf = new Map(keys.map((k, i) => [k, i]));
  const naId = keys.length;
  const naCount = Object.values(na).reduce((n, names) => n + names.length, 0);
  const groups: PatternGroup[] = keys.map((key, id) => ({
    id, key, count: counts.get(key)!, pattern: [...key].map(c => (c === '1' ? 1 : 0)),
    label: [...key].map((c, i) => (c === '.' ? '' : `${short[i]}${c === '1' ? '+' : '−'}`)).filter(Boolean).join(' '),
  }));
  if (naCount) groups.push({ id: naId, key: 'na', count: naCount, pattern: null, label: 'Not informative' });
  const byDataset: Record<string, Record<string, number>> = {};
  for (const [dataset, reads] of Object.entries(patternOf)) {
    byDataset[dataset] = Object.fromEntries(Object.entries(reads).map(([name, key]) => [name, idOf.get(key)!]));
  }
  for (const [dataset, names] of Object.entries(na)) for (const name of names) (byDataset[dataset] ??= {})[name] = naId;
  return {
    byDataset, groups,
    order: groups.map(g => g.id),
    patterns: Object.fromEntries(groups.filter(g => g.pattern).map(g => [g.id, g.pattern!])),
    regions: features.filter(f => f.start != null && f.end != null)
      .map(f => ({ start: Math.floor(f.start!), end: Math.ceil(f.end!), mode: featureRegionMode(f) ?? 'accessibility' })),
    labels: Object.fromEntries(groups.map(g => [g.id, g.label])),
  };
}

// ---------------------------------------------------------------- the main toolbar
/** The target panels' dataset -> state keys (selected panels, else every dataset panel). */
export function toolbarStateKeyMap(): Record<string, string[]> {
  const s = useBrowserStore.getState();
  return getStateKeyMap(s.selectedDatasets, s.panels, s.datasets);
}

/** The selected features on the main view's chromosome (a feature elsewhere is kept selected but not used). */
export function featuresInView(): { features: FeatureRef[]; elsewhere: number } {
  const s = useBrowserStore.getState();
  const features = s.selectedFeatures.filter(f => !f.chrom || sameChrom(f.chrom, s.chrom));
  return { features, elsewhere: s.selectedFeatures.length - features.length };
}

export function featureNames(features: FeatureRef[]): string {
  return features.map(featureShortName).join(', ');
}

function featureKindNames(): string[] {
  return listedFeatureKinds().map(def => def.pluralName ?? def.kind);
}

/**
 * The notes of the selected features' kinds only, each once (round 3, R6: Cluster's tooltip named every registered
 * kind's notes, also kinds the dataset doesn't have).
 */
export function selectedKindNotes(features: FeatureRef[], field: 'stateNote' | 'layerNote' | 'groupingNote'): string[] {
  const kinds = new Set(features.map(f => f.kind));
  return [...new Set([...kinds].map(kind => featureKindDef(kind)?.[field]).filter((n): n is string => Boolean(n)))];
}

/** The kinds' notes for Cluster's tooltip, in their order, each once ("classes: footprinted or not"). */
export function featureKindNotes(field: 'stateNote' | 'layerNote' | 'groupingNote'): string[] {
  return [...new Set(listedFeatureKinds().map(def => def[field]).filter((n): n is string => Boolean(n)))];
}

/**
 * Whether an answer still applies: the same session (an import resets the panels), main locus and undo position as
 * when the request was sent (undo / redo / navigation meanwhile put other reads or groups there), and no newer
 * request of the same kind.
 */
const latest: Record<string, number> = {};
export function requestGuard(kind: string): () => boolean {
  const n = (latest[kind] = (latest[kind] ?? 0) + 1);
  const sortRequest = kind === 'sort' ? nextSortRequest() : null;
  // The session: an import bumps the split panels' generation (api/session.ts).
  const a = useSplitPanelStore.getState().generation;
  const s = useBrowserStore.getState();
  const at = `${s.chrom}:${s.start}-${s.end}|${s._historyPointer}`;
  return () => {
    const now = useBrowserStore.getState();
    return now.signalFilters === s.signalFilters && (sortRequest == null || isCurrentSortRequest(sortRequest)) && latest[kind] === n && useSplitPanelStore.getState().generation === a && `${now.chrom}:${now.start}-${now.end}|${now._historyPointer}` === at;
  };
}
export const STALE = 'The view, the session or the undo history changed while this was computed, so it was not applied. Run it again.';

/** Cluster (combinatorial) on the selected features. Returns an error message, or null when the groups were applied. */
export async function clusterSelectedFeatures(): Promise<string | null> {
  const { features, elsewhere } = featuresInView();
  if (!features.length) {
    return elsewhere ? 'The selected features are on another chromosome.' : `Select ${selectableKindsPhrase()} first.`;
  }
  // A kind with actions of its own (a plugin pack's): its Cluster, on its features alone.
  const own = featureKindWithActions(features);
  if (own) {
    const mine = features.filter(f => f.kind === own.kind);
    if (mine.length !== features.length) return own.actions.mixed;
    return own.actions.cluster(mine);
  }
  const refusal = combinatorialRefusal(features);
  if (refusal) return refusal;
  const keyMap = toolbarStateKeyMap();
  const current = requestGuard('cluster');
  try {
    // A plugin pack's own grouping for this selection, if it has one.
    for (const planner of planners) {
      const outcome = planner.cluster(features, keyMap, current);
      if (outcome) return await outcome;
    }
    const states = await getFeatureStates(features);
    if (!current()) return STALE;
    const input = patternGroups(states, features);
    if (!input.groups.some(g => g.key !== 'na')) return `No read is evaluated for all of ${featureNames(features)}.`;
    applyReadGroups(input, keyMap, `Split reads by the pattern of ${featureNames(features)}`);
    return null;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

/** Reads ordered by their states at the features: members of more of them first, then by pattern (selection order). */
export function orderByStates(reads: Record<string, string>): string[] {
  const rank = (c: string) => (c === '1' ? 0 : c === '0' ? 1 : 2);
  const members = (s: string) => [...s].filter(c => c === '1').length;
  return Object.keys(reads).sort((a, b) => {
    const sa = reads[a], sb = reads[b];
    const d = members(sb) - members(sa);
    if (d) return d;
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      const r = rank(sa[i] ?? '.') - rank(sb[i] ?? '.');
      if (r) return r;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Sort the target panels' reads by membership at the selected features (an undo step). */
export async function sortBySelectedFeatures(): Promise<string | null> {
  const { features } = featuresInView();
  if (!features.length) return `Select ${selectableKindsPhrase()} first.`;
  const own = featureKindWithActions(features);
  if (own) return own.actions.sortFilter;
  const s0 = useBrowserStore.getState();
  const keyMap = getStateKeyMap(s0.selectedDatasets, s0.panels.filter(p => !p.collapsed), []);
  const targets = Object.keys(keyMap);
  if (!targets.length) return 'Choose a read panel to sort.';
  const views = captureRunViews(s0, Object.values(keyMap).flat());
  const panelReadIds = Object.fromEntries(Object.values(keyMap).flat().flatMap(key => {
    const ids = useSplitPanelStore.getState().reads[key]?.ids;
    return ids ? [[key, [...ids]]] : [];
  }));
  const current = requestGuard('sort');
  try {
    const states = await getFeatureStates(features);
    if (!current()) return STALE;
    const now = useBrowserStore.getState();
    let skipped = false;
    const writes = targets.filter(ds => states.by_dataset[ds]).flatMap(ds => (keyMap[ds] ?? [ds]).flatMap(key => {
      if (!sortStateStillCurrent(s0, now, key) || !runViewsStillCurrent(views.filter(v => v.stateKey === key), now)) {
        skipped = true;
        return [];
      }
      const scope = resolveSortRequestScope({ ...s0, datasetIds: [ds], sortKeyMap: { [ds]: [key] },
        panelReadIds });
      const ids = scope.readIds[ds] ? new Set(scope.readIds[ds]) : null;
      // States of lifted datasets are per record key: a panel's analysis_ids name them through idSetHas.
      const order = orderByStates(states.by_dataset[ds]).filter(id => !ids || idSetHas(ids, [id], recordKey(id)));
      return order.length ? [[key, mergeScopedSortOrder(now.readSortOrder[key] ?? [], order, !!ids)] as const] : [];
    }));
    if (!writes.length) return skipped ? STALE : `No read of the target panels is evaluated for ${featureNames(features)}.`;
    if (writes.every(([key, order]) => !now.jupyterReadOrder[key]?.length && order.length === now.readSortOrder[key]?.length
      && order.every((id, i) => now.readSortOrder[key][i] === id))) return skipped ? STALE : 'Reads are already in this order.';
    seedHistoryBaseline(useBrowserStore.getState(), 'Before sorting', 'sorting');
    for (const [key, order] of writes) {
      useBrowserStore.getState().setReadSortOrder(key, order);
      useBrowserStore.setState(s => ({ jupyterReadOrder: { ...s.jupyterReadOrder, [key]: [] } }));
    }
    useBrowserStore.setState({ sortSelection: FEATURE_SORT });
    useBrowserStore.getState().pushSnapshot(`Sort by membership at ${featureNames(features)}`);
    return skipped ? 'Some panels changed while sorting, so the sort was not applied there. Sort again on those panels.' : null;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

export const FEATURE_SORT = 'features';
export type FeatureFilterMode = 'all' | 'any' | 'none';
export const FEATURE_FILTERS: { value: `features:${FeatureFilterMode}`; label: string; title: string }[] = [
  { value: 'features:all', label: 'In every selected feature', title: 'Keep the reads that are members of every selected feature (a footprint class, or what a feature of another kind stands for) that applies to their dataset' },
  { value: 'features:any', label: 'In any selected feature', title: 'Keep the reads that are members of at least one selected feature' },
  { value: 'features:none', label: 'In no selected feature', title: 'Hide the members of the selected features as excluded reads (the read menu shows them again); every other read stays' },
];

/** Keep (or hide) reads by membership at the selected features in the target panels (an undo step). */
export async function filterBySelectedFeatures(mode: FeatureFilterMode): Promise<string | null> {
  const { features } = featuresInView();
  const own = featureKindWithActions(features);
  if (own) return own.actions.sortFilter;
  if (!features.length) return `Select ${selectableKindsPhrase()} first.`;
  const keyMap = toolbarStateKeyMap();
  const s0 = useBrowserStore.getState();
  const targets = getTargetDatasetIds(s0.selectedDatasets, s0.panels, s0.datasets);
  const current = requestGuard('filter');
  try {
    const states = await getFeatureStates(features);
    if (!current()) return STALE;
    const writes: [string, Set<string>][] = [];
    for (const ds of targets) {
      const reads = states.by_dataset[ds];
      if (!reads) continue;
      const applies = states.features.map(f => f.datasets.includes(ds));
      const member = (st: string, i: number) => applies[i] && st[i] === '1';
      for (const key of keyMap[ds] ?? [ds]) {
        let keep: Set<string>;
        if (mode === 'none') {
          // Hidden as excluded reads (the members): every other read stays, also reads not loaded yet.
          keep = new Set(Object.entries(reads).filter(([, st]) => [...st].some((_, i) => member(st, i))).map(([name]) => name));
        } else {
          keep = new Set(Object.entries(reads).filter(([, st]) => {
            const hits = applies.map((a, i) => (a ? member(st, i) : null)).filter(v => v !== null);
            return hits.length > 0 && (mode === 'all' ? hits.every(Boolean) : hits.some(Boolean));
          }).map(([name]) => name));
        }
        writes.push([key, keep]);
      }
    }
    if (!writes.length) return `No read of the target panels is evaluated for ${featureNames(features)}.`;
    if (mode === 'none') {
      if (writes.every(([, members]) => members.size === 0)) return `No read of the target panels is a member of ${featureNames(features)}.`;
      seedHistoryBaseline(useBrowserStore.getState(), 'Before excluding reads', 'analysis');
      for (const [key, members] of writes) if (members.size) useReadActionsStore.getState().excludeReads(key, [...members]);
      useBrowserStore.getState().pushSnapshot(`Hide the members of ${featureNames(features)}`, { kind: 'analysis' });
      return null;
    }
    if (writes.every(([, keep]) => keep.size === 0)) return `No read passes this filter at ${featureNames(features)}.`;
    const label = `Features > ${FEATURE_FILTERS.find(f => f.value === `features:${mode}`)!.label.toLowerCase()} (${featureNames(features)})`;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before read filter', 'filtering');
    for (const [key, keep] of writes) useBrowserStore.getState().setFilteredReadIds(key, keep, { target: 'analysis-filter', label });
    useBrowserStore.getState().pushSnapshot(`Filter: ${label}`);
    return null;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

/** The peak regions the non-combinatorial Cluster uses for selected features: each feature's span, on its own layer. */
export function featurePeakRegions(features: FeatureRef[]): { start: number; end: number; mode: string }[] {
  const datasets = useBrowserStore.getState().datasets;
  // A kind whose features are not regions to cluster on (regionMode null) is left out.
  const modeOf = (f: FeatureRef): string | null =>
    featureRegionMode(f, (datasets.find(d => d.id === f.datasetId)?.available_layers ?? {}) as Record<string, unknown>);
  return features.filter(f => f.start != null && f.end != null && f.end > f.start && modeOf(f) !== null)
    .map(f => ({ start: Math.floor(f.start!), end: Math.ceil(f.end!), mode: modeOf(f)! }));
}
