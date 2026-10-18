/**
 * Put read groups (a feature pattern split, a plugin pack's groupings) into the read panels through the cluster store,
 * the plumbing every clustering uses, so profiles, the cluster detail views, Footprints focus and read exports work
 * per group, and take them out again.
 *
 * Applying stashes the targeted panels' previous grouping first; Clear puts it back. Both are undo steps
 * ("Before …" baseline + the step), and the user's cluster tree is left alone (mirror: false), so the clustering a
 * split replaced is still the active tree node.
 */
import { useBrowserStore } from '../stores/browserStore';
import { seedHistoryBaseline } from '../stores/historySlice';
import type { SvSplitDef } from '../stores/svSlice';

export interface ReadGroupsInput {
  /** dataset id -> read name -> group id */
  byDataset: Record<string, Record<string, number>>;
  order: number[];
  patterns: Record<number, number[]>;
  regions: { start: number; end: number; mode?: string }[];
  /** Group names (group id -> "V1+V3", "N1 V2+ N2 V1−"): the read panels' legends, cluster detail and the cluster TSV's
   * group column show them (stores/svSlice.ts clusterGroupLabels). */
  labels?: Record<number, string>;
  svEvidenceLevels?: import('../stores/svSlice').SvCarrierEvidence;
}

interface KeyStash {
  assignments: Record<string, number> | undefined;
  order: number[] | undefined;
  focus: Set<number> | null | undefined;
  /** An SV allele split the groups replaced (its definition), put back by Clear. */
  svSplit?: SvSplitDef;
  svEvidenceLevels?: import('../stores/svSlice').SvCarrierEvidence;
  /** The group names the replaced grouping had (an SV split's, or another named grouping's). */
  svLabels?: Record<number, string>;
}

export interface GroupingStash {
  keys: Record<string, KeyStash>;
  patterns: Record<number, number[]>;
  centroids: Record<number, number[]>;
  peakWidths: number[];
  peakRegions: { start: number; end: number; mode?: string; chrom?: string; genome?: string }[];
  dynamicClustering: boolean;
}

export interface AppliedGrouping {
  label: string;
  /** The assignment maps written, per state key: still current while the store holds these very objects. */
  written: Record<string, Record<string, number>>;
  stash: GroupingStash;
}

/** state key -> the dataset's read groups (panels showing the same dataset each get them). */
function targets(byDataset: Record<string, Record<string, number>>, stateKeyMap: Record<string, string[]>) {
  const out: [string, Record<string, number>][] = [];
  // With panels targeted (the map names datasets), a dataset of the run that is not targeted is left as it is.
  const scoped = Object.keys(stateKeyMap).length > 0;
  for (const [dsId, assignments] of Object.entries(byDataset)) {
    if (scoped && !stateKeyMap[dsId]) continue;
    for (const key of stateKeyMap[dsId] ?? [dsId]) out.push([key, assignments]);
  }
  return out;
}

/** Group names per state key (null: none); the SV split's setter would also make it an SV split. */
function setLabels(byKey: Record<string, Record<number, string> | null>) {
  useBrowserStore.setState(state => {
    const clusterGroupLabels = { ...state.clusterGroupLabels };
    for (const [key, labels] of Object.entries(byKey)) {
      if (labels && Object.keys(labels).length) clusterGroupLabels[key] = labels; else delete clusterGroupLabels[key];
    }
    return { clusterGroupLabels };
  });
}

/** Cluster focus without setClusterFocus, which records an undo step of its own (the split is one step). */
function setFocus(focus: Record<string, Set<number> | null>) {
  useBrowserStore.setState(state => ({ clusterFocus: { ...state.clusterFocus, ...focus } }));
}

export function applyReadGroups(input: ReadGroupsInput, stateKeyMap: Record<string, string[]>, label: string): AppliedGrouping {
  const before = useBrowserStore.getState();
  const pairs = targets(input.byDataset, stateKeyMap);
  const stash: GroupingStash = {
    keys: Object.fromEntries(pairs.map(([key]) => [key, {
      assignments: before.clusterAssignments[key], order: before.clusterOrder[key], focus: before.clusterFocus[key],
      svSplit: before.svSplits?.[key], svEvidenceLevels: before.svCarrierEvidence?.[key], svLabels: before.clusterGroupLabels?.[key],
    }])),
    patterns: before.clusterPatterns,
    centroids: before.clusterCentroids,
    peakWidths: before.clusterPeakWidths,
    peakRegions: before.clusterPeakRegions,
    dynamicClustering: before.dynamicClustering,
  };
  seedHistoryBaseline(before, `Before ${label.charAt(0).toLowerCase()}${label.slice(1)}`, 'clustering');
  const store = useBrowserStore.getState();
  for (const [key, assignments] of pairs) {
    store.setClusterAssignments(key, { ...assignments }, { mirror: false });
    store.setClusterOrder(key, input.order, { mirror: false });
    store.clearClusterSelection(key);
    store.setSvCarrierEvidence(key, input.svEvidenceLevels);
  }
  // The groups' names, after the assignments (a non-SV write drops the key's previous names).
  if (input.labels && Object.keys(input.labels).length) setLabels(Object.fromEntries(pairs.map(([key]) => [key, { ...input.labels }])));
  setFocus(Object.fromEntries(pairs.map(([key]) => [key, null])));
  // These groups are not peak patterns: never re-derive them on pan. The live fields only: the setters would
  // also write them into the active cluster-tree node (the user's clustering, kept as it was).
  useBrowserStore.setState({ dynamicClustering: false, clusterPatterns: input.patterns, clusterCentroids: {}, clusterPeakWidths: [],
    clusterPeakRegions: input.regions });
  store.pushSnapshot(label, { kind: 'clustering' });
  const after = useBrowserStore.getState();
  return { label, written: Object.fromEntries(pairs.map(([key]) => [key, after.clusterAssignments[key]])), stash };
}

function sameAssignments(a: Record<string, number> | undefined, b: Record<string, number>): boolean {
  if (a === b) return true;
  if (!a) return false;
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  return keys.every(k => a[k] === b[k]);
}

/** True while the read panels hold these groups (also when undo/redo brought them back as copies). */
export function groupingIsCurrent(applied: AppliedGrouping | null): boolean {
  if (!applied) return false;
  const state = useBrowserStore.getState();
  return Object.entries(applied.written).every(([key, map]) => sameAssignments(state.clusterAssignments[key], map));
}

/**
 * True while the read panel at this state key holds the groups this grouping wrote to it: one panel at a time, so a
 * grouping on two panels still names the one left as it was when the other is split some other way.
 */
export function groupingIsCurrentOn(applied: AppliedGrouping | null | undefined, key: string): boolean {
  const map = applied?.written[key];
  return !!map && sameAssignments(useBrowserStore.getState().clusterAssignments[key], map);
}

/** Put back the grouping a split replaced (an undo step of its own). */
export function restoreReadGroups(applied: AppliedGrouping, label = 'Clear read groups'): void {
  const store = useBrowserStore.getState();
  const { stash } = applied;
  for (const [key, prev] of Object.entries(stash.keys)) {
    // The very object it replaced (assignment maps are never mutated): a split applied before this one is then
    // current again, and its Clear works in turn.
    // An SV allele split comes back as a split (its names, and its re-classification on pan), not as bare clusters.
    store.setClusterAssignments(key, prev.assignments ?? {}, { mirror: false, svSplit: Boolean(prev.svSplit) });
    store.setClusterOrder(key, prev.order ?? [], { mirror: false });
    store.clearClusterSelection(key);
    if (prev.svSplit) store.setSvSplit(key, prev.svSplit, prev.svLabels ?? null);
    else if (prev.svLabels) setLabels({ [key]: prev.svLabels });
    store.setSvCarrierEvidence(key, prev.svEvidenceLevels);
  }
  setFocus(Object.fromEntries(Object.entries(stash.keys).map(([key, prev]) => [key, prev.focus ?? null])));
  useBrowserStore.setState({ clusterPatterns: stash.patterns, clusterCentroids: stash.centroids, clusterPeakWidths: stash.peakWidths,
    clusterPeakRegions: stash.peakRegions, dynamicClustering: stash.dynamicClustering });
  store.pushSnapshot(label, { kind: 'clustering' });
}
