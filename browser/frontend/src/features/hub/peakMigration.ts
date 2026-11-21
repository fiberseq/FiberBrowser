/** Stable peak identities and the legacy index projection. Geometry is scoped to its rule and reference. */
import { sameChrom } from '../../utils/chromAliases';
import type { FirePeak } from '../../types';
import type { BrowserState } from '../../stores/browserStore';

export interface PeakSelection { selected: string[]; modes: Record<string, string> }
export function peakHitId(p: FirePeak, ruleId: string, chrom: string): string {
  return p.hitId ?? `peak:${JSON.stringify([ruleId, p.chrom ?? chrom, p.genome ?? null, p.start, p.end,
    p.memberPanelId ?? null, p.match?.label ?? null, p.correspondenceId ?? null, p.graph ? [p.graph.kind, p.graph.label, p.graph.carriers, p.graph.frame_peaks] : null])}`;
}
export function identifyPeaks(peaks: Record<string, FirePeak[]>, chrom: string): Record<string, FirePeak[]> {
  return Object.fromEntries(Object.entries(peaks).map(([rule, rows]) => [rule,
    rows.every(p => p.hitId && p.ruleId === rule) ? rows : rows.map(p => p.hitId && p.ruleId === rule ? p : ({ ...p, ruleId: rule, hitId: peakHitId(p, rule, chrom) }))]));
}
export function capturePeakSelection(peaks: Record<string, FirePeak[]>, chrom: string,
  selected: Iterable<number>, modes: Record<number, string>,
  regions: Array<{ start: number; end: number; chrom?: string; genome?: string; mode?: string }> = []): PeakSelection {
  const byIndex = new Map(Object.entries(peaks).flatMap(([rule, rows]) => rows.map(p => [p.index, peakHitId(p, rule, chrom)] as const)));
  const indices = new Set(selected), allModes = { ...modes };
  for (const region of regions) {
    const peak = Object.values(peaks).flat().find(p => p.start === region.start && p.end === region.end
      && sameChrom(p.chrom ?? chrom, region.chrom ?? chrom) && (p.genome ?? null) === (region.genome ?? null));
    if (peak) { indices.add(peak.index); if (region.mode) allModes[peak.index] = region.mode; }
  }
  return { selected: [...indices].flatMap(i => byIndex.has(i) ? [byIndex.get(i)!] : []),
    modes: Object.fromEntries(Object.entries(allModes).flatMap(([i, mode]) => byIndex.has(Number(i)) ? [[byIndex.get(Number(i))!, mode]] : [])) };
}
export function projectPeakSelection(peaks: Record<string, FirePeak[]>, chrom: string, saved: PeakSelection) {
  const byId = new Map(Object.entries(peaks).flatMap(([rule, rows]) => rows.map(p => [peakHitId(p, rule, chrom), p.index] as const)));
  return { selectedPeaks: new Set(saved.selected.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])),
    peakModes: Object.fromEntries(Object.entries(saved.modes).flatMap(([id, mode]) => byId.has(id) ? [[byId.get(id)!, mode]] : [])) as BrowserState['peakModes'] };
}

/** Nodes retain the stable identity even when a hit disappears; its old index must never select a neighbour. */
export function migratePeakOwners<T extends { selectedPeakIndices: number[]; peakModes: Record<number, string>; peakSelection?: PeakSelection; peakRegions?: Array<{ start: number; end: number; chrom?: string; mode?: string }> }>(
  owners: Record<string, T>, old: Record<string, FirePeak[]>, next: Record<string, FirePeak[]>, chrom: string,
): Record<string, T> {
  return Object.fromEntries(Object.entries(owners).map(([key, owner]) => {
    const peakSelection = owner.peakSelection ?? capturePeakSelection(old, chrom, owner.selectedPeakIndices ?? [], owner.peakModes ?? {}, owner.peakRegions);
    const projected = projectPeakSelection(next, chrom, peakSelection);
    return [key, { ...owner, peakSelection, selectedPeakIndices: [...projected.selectedPeaks], peakModes: projected.peakModes }];
  }));
}

/** Atomic current selection + tree + saved clustering update. History keeps each snapshot's own geometry.
 * Rescans preserve selection by identity; deliberate resets supply the selection for the resulting peak set.
 */
export function peakTransaction(state: BrowserState, next: Record<string, FirePeak[]>,
  selectionOverride?: Pick<BrowserState, 'selectedPeaks' | 'peakModes'>): Partial<BrowserState> {
  const peaksByRule = identifyPeaks(next, state.chrom);
  const selection = capturePeakSelection(state.peaksByRule, state.chrom, state.selectedPeaks, state.peakModes);
  const projected = projectPeakSelection(peaksByRule, state.chrom, selection);
  const known = new Set(Object.values(state.peaksByRule).flat().map(p => p.index));
  for (const i of state.selectedPeaks) if (!known.has(i)) projected.selectedPeaks.add(i);
  for (const [i, mode] of Object.entries(state.peakModes)) if (!known.has(Number(i))) projected.peakModes[Number(i)] = mode;
  return { peaksByRule, ...(selectionOverride ?? projected),
    clusterTreeNodes: migratePeakOwners(state.clusterTreeNodes, state.peaksByRule, peaksByRule, state.chrom),
    savedClusters: migrateSavedPeakOwners(state, peaksByRule) };
}

/** Historical states use their own peak cache, never the currently displayed indices. */
export function migratePeakSnapshot<T extends Record<string, unknown>>(saved: T): T {
  if (!saved.peaksByRule || typeof saved.peaksByRule !== 'object') return saved;
  const chrom = typeof saved.chrom === 'string' ? saved.chrom : '';
  const peaks = identifyPeaks(saved.peaksByRule as Record<string, FirePeak[]>, chrom);
  const hub = (saved.featureHub ?? {}) as Record<string, unknown>;
  const selection = capturePeakSelection(peaks, chrom,
    Array.isArray(saved.selectedPeaks) ? saved.selectedPeaks : [], (saved.peakModes ?? {}) as Record<number, string>);
  return { ...saved, peaksByRule: peaks, featureHub: { ...hub, peakSelection: selection },
    ...(saved.clusterTreeNodes ? { clusterTreeNodes: migratePeakOwners(saved.clusterTreeNodes as BrowserState['clusterTreeNodes'], peaks, peaks, chrom) } : {}),
    ...(Array.isArray(saved.savedClusters) ? { savedClusters: migrateSavedPeakOwners({ savedClusters: saved.savedClusters as BrowserState['savedClusters'], peaksByRule: peaks, chrom, start: Number(saved.start), end: Number(saved.end) }, peaks) } : {}) };
}


/** A saved clustering at another viewport owns a different peak cache; its numeric fallback stays there. */
export function migrateSavedPeakOwners(state: Pick<BrowserState, 'savedClusters' | 'peaksByRule' | 'chrom' | 'start' | 'end'>,
  next: Record<string, FirePeak[]>): BrowserState['savedClusters'] {
  return state.savedClusters.map(owner => sameChrom(owner.chrom, state.chrom) && owner.start === state.start && owner.end === state.end
    ? migratePeakOwners({ owner }, state.peaksByRule, next, state.chrom).owner : owner);
}
