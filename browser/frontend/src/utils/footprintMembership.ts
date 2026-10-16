/**
 * Cluster reads by which saved footprints they carry (e.g. +A +B, +A -B,
 * neither), from a co-occupancy result. Shared by the Footprints panel's
 * Cluster button and the `cluster_by_saved_footprints` browser action.
 */
import type { FootprintAnalysisResult } from '../api/footprints';
import type { FootprintGroup, SelectedFootprint } from '../types';
import { useBrowserStore } from '../stores/browserStore';

/**
 * The whole bases [start, end) covering a footprint or class span. Class edges
 * are medians of call edges and can be fractional (centre ± half a width);
 * anything sent to the backend as a genomic interval must be integers, and
 * flooring the start and ceiling the end keeps every base of the class inside.
 */
export function basesCovering(start: number, end: number): { start: number; end: number } {
  return { start: Math.floor(start), end: Math.ceil(end) };
}

/** Group definitions as /api/footprint/analyze expects them. */
export function cooccGroupParams(groups: FootprintGroup[]) {
  return groups.map(g => ({
    sourceIndex: g.sourceIndex,
    // Explicit reference coords let the backend resolve the group's reference
    // even after the footprint selection changes.
    referenceAbsStart: g.referenceAbsStart ?? null,
    referenceAbsEnd: g.referenceAbsEnd ?? null,
    // A class's fitted bounds: the backend matches on these first, as it does
    // for saved rules, so the panel and a reloaded rule agree.
    familyModelAbsStart: g.familyModelAbsStart ?? null,
    familyModelAbsEnd: g.familyModelAbsEnd ?? null,
    sizeMin: g.sizeMin,
    sizeMax: g.sizeMax,
    minFpCoverage: g.minFpCoverage ?? 0,
    minTargetCoverage: g.minTargetCoverage ?? 0,
    // Legacy fields for sessions saved before the coverage inputs.
    overlapMode: g.overlapMode,
    overlapFraction: g.overlapFraction,
    familyId: g.familyId ?? null,
    familyAnnotationName: g.familyAnnotationName ?? null,
    consensusStateId: g.consensusStateId ?? null,
    consensusJobId: g.consensusJobId ?? null,
    consensusStage: g.consensusStage ?? null,
    consensusStrand: g.consensusStrand ?? null,
    consensusTier: g.consensusTier ?? null,
    sourceDatasetId: g.sourceDatasetId ?? null,
    consensusDatasetId: g.consensusDatasetId ?? null,
    layer: g.layer ?? null,
    minFamilyConfidence: g.minFamilyConfidence ?? 0,
  }));
}

/**
 * A co-occupancy result reduced to some of its groups (per-group rows in the
 * order of `indices`). Pairwise rows are dropped: membership clustering uses
 * only the per-group read sets.
 */
export function subsetCoOccupancy(
  coOccupancy: NonNullable<FootprintAnalysisResult['co_occupancy']>,
  indices: number[],
): NonNullable<FootprintAnalysisResult['co_occupancy']> {
  return Object.fromEntries(Object.entries(coOccupancy).map(([dsId, value]) => {
    const perGroup = value?.per_group;
    if (!perGroup) return [dsId, value];
    // Rows for other definitions (an older result): leave the dataset out rather than mislabel it.
    const rows = indices.every(i => i >= 0 && i < perGroup.length) ? indices.map(i => perGroup[i]) : [];
    return [dsId, { ...value, per_group: rows, pairs: [] }];
  }));
}

export interface MembershipClusters {
  /** Per dataset: read id -> cluster id (most common pattern = 0). */
  byDataset: Record<string, Record<string, number>>;
  /** Patterns ('10' = has footprint 1, lacks 2), in cluster id order. */
  patterns: string[];
  legend: { id: number; count: number; label: string }[];
}

export function computeMembershipClusters(
  coOccupancy: NonNullable<FootprintAnalysisResult['co_occupancy']>,
  groups: FootprintGroup[],
  datasetIds: string[],
): MembershipClusters | null {
  const patternOf: Record<string, Record<string, string>> = {};
  const counts = new Map<string, number>();
  for (const dsId of datasetIds) {
    const perGroup = coOccupancy[dsId]?.per_group;
    if (!perGroup || perGroup.length !== groups.length) continue;
    const withSets = perGroup.map(group => new Set(group.ids_with ?? []));
    const eligible = perGroup.map(group => new Set([...(group.ids_with ?? []), ...(group.ids_without ?? [])]));
    // The footprints this dataset evaluates: position rules, and the classes saved from it
    // (a class saved from another dataset has no eligible reads here, which must not empty the clustering).
    const own = groups.map((group, gi) => (!group.sourceDatasetId || group.sourceDatasetId === dsId) && eligible[gi].size > 0);
    const used = eligible.filter((_, gi) => own[gi]);
    if (!used.length) continue;
    // Only reads evaluated for every one of them: absence elsewhere can mean
    // "not evaluated" (another cohort or strand), not "lacks it".
    const reads = [...used[0]].filter(id => used.every(set => set.has(id)));
    const byRead: Record<string, string> = {};
    for (const readId of reads) {
      const pattern = withSets.map((set, gi) => (!own[gi] ? '.' : set.has(readId) ? '1' : '0')).join('');
      byRead[readId] = pattern;
      counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
    }
    patternOf[dsId] = byRead;
  }
  if (counts.size === 0) return null;
  const patterns = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([pattern]) => pattern);
  const idOf = new Map(patterns.map((pattern, index) => [pattern, index]));
  const byDataset: Record<string, Record<string, number>> = {};
  for (const [dsId, byRead] of Object.entries(patternOf)) {
    byDataset[dsId] = Object.fromEntries(Object.entries(byRead).map(([readId, pattern]) => [readId, idOf.get(pattern)!]));
  }
  return {
    byDataset,
    patterns,
    legend: patterns.map((pattern, index) => ({
      id: index,
      count: counts.get(pattern) ?? 0,
      label: groups.map((group, gi) => pattern[gi] === '.' ? '' : `${pattern[gi] === '1' ? '+' : '−'}${group.name}`).filter(Boolean).join('  '),
    })),
  };
}

/** Put membership clusters in the store, as a normal clustering run would. */
export function applyMembershipClusters(
  clusters: MembershipClusters,
  groups: FootprintGroup[],
  stateKeyMap: Record<string, string[]>,
  viewStart: number,
  selectedFootprints: SelectedFootprint[] = [],
): void {
  const store = useBrowserStore.getState();
  const order = clusters.patterns.map((_, index) => index);
  for (const [dsId, assignments] of Object.entries(clusters.byDataset)) {
    for (const key of stateKeyMap[dsId] ?? [dsId]) {
      store.setClusterAssignments(key, assignments);
      store.setClusterOrder(key, order);
      // The old clusters' focus and selection name IDs these new clusters reuse.
      store.setClusterFocus(key, null);
      store.clearClusterSelection(key);
    }
  }
  // Membership patterns aren't accessibility patterns: don't re-derive them on pan.
  store.setDynamicClustering(false);
  // A footprint not evaluated for a cluster's dataset ('.') is stored as absent (the legend names only evaluated ones).
  store.setClusterPatterns(Object.fromEntries(clusters.patterns.map((pattern, index) => [index, [...pattern].map(c => (c === '1' ? 1 : 0))])));
  store.setClusterCentroids({}, []);
  // One region per footprint, so each pattern bit lines up with its position.
  // Absolute coordinates, as every other clustering stores them (dissolve and
  // merge send them to the backend as absolute peak regions).
  store.setClusterPeakRegions(groups.map(group => {
    const fp = group.sourceIndex >= 0 ? selectedFootprints[group.sourceIndex] : null;
    const absStart = group.referenceAbsStart ?? fp?.absStart ?? viewStart;
    const absEnd = group.referenceAbsEnd ?? fp?.absEnd ?? viewStart;
    return {
      // A class's span is the median of its calls' edges, so it can fall on a
      // half base (47515967.5); peak regions are whole bases (the backend's
      // PeakRegion is an int), widened to cover the whole class.
      ...basesCovering(absStart, absEnd),
      mode: (group.sizeMax !== null && group.sizeMax <= 80 ? 'tf' : 'accessibility') as 'tf' | 'accessibility',
    };
  }));
  store.pushSnapshot('Cluster by footprints');
}
