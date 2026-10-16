/**
 * Which saved footprints Co-occupancy's "Cluster reads by N footprints" uses:
 * the default choice, and the choice remembered per locus (in the session).
 * Pure helpers (no store import), shared by the panel, the store and Copilot's action.
 */
import type { FootprintGroup } from '../types';

/** More patterns than this (2^3) stop reading as clusters: the panel warns. */
export const MAX_READABLE_PATTERNS = 8;

/** How many membership patterns n footprints can produce (each present or absent). */
export function membershipPatternCount(footprints: number): number {
  return 2 ** footprints;
}

/** Which footprints to cluster by when nothing is remembered: all of up to three, else the first three. */
export function defaultClusterSelection(groupIds: string[]): string[] {
  return groupIds.slice(0, 3);
}

/** The footprints to cluster by, as remembered for one locus. */
export interface ClusterSelection {
  chrom: string;
  start: number;
  end: number;
  groupIds: string[];
}

/** At most this many loci are remembered (newest kept). */
export const MAX_REMEMBERED_SELECTIONS = 50;

type View = { chrom: string; start: number; end: number };

/** A saved footprint at this view: placed inside it, or not placed (Match anywhere, or one picked in the view). */
export function footprintInView(group: Pick<FootprintGroup, 'referenceAbsStart' | 'referenceAbsEnd'>, view: View): boolean {
  if (group.referenceAbsStart == null || group.referenceAbsEnd == null) return true;
  return group.referenceAbsStart < view.end && group.referenceAbsEnd > view.start;
}

/**
 * The locus a choice is remembered for: the span of the saved footprints placed
 * in this view (so panning or zooming around them keeps it), else the view itself
 * (footprints saved elsewhere on the chromosome don't stretch it).
 */
export function clusterSelectionLocus(groups: FootprintGroup[], view: View): View {
  const here = groups.filter(g => g.referenceAbsStart != null && g.referenceAbsEnd != null && footprintInView(g, view));
  if (here.length === 0) return { chrom: view.chrom, start: view.start, end: view.end };
  return {
    chrom: view.chrom,
    start: Math.min(...here.map(g => g.referenceAbsStart!)),
    end: Math.max(...here.map(g => g.referenceAbsEnd!)),
  };
}

const sameContig = (a: string, b: string) => a.replace(/^chr/i, '') === b.replace(/^chr/i, '');

/** The newest remembered selection at (overlapping) this locus. */
export function findClusterSelection(
  remembered: readonly ClusterSelection[] | undefined,
  locus: { chrom: string; start: number; end: number } | null,
): ClusterSelection | null {
  if (!remembered || !locus) return null;
  for (let i = remembered.length - 1; i >= 0; i--) {
    const entry = remembered[i];
    if (sameContig(entry.chrom, locus.chrom) && entry.start < Math.max(locus.end, locus.start + 1) && entry.end > locus.start) return entry;
  }
  return null;
}

/** Remember a choice for a locus, replacing the choices it overlaps. */
export function rememberClusterSelection(remembered: readonly ClusterSelection[] | undefined, entry: ClusterSelection): ClusterSelection[] {
  const others = (remembered ?? []).filter(e => !(sameContig(e.chrom, entry.chrom) && e.start < Math.max(entry.end, entry.start + 1) && e.end > entry.start));
  return [...others, { ...entry, groupIds: [...entry.groupIds] }].slice(-MAX_REMEMBERED_SELECTIONS);
}

/**
 * The footprints (by id, in the groups' order) to cluster by: the remembered
 * choice kept to the footprints offered; with none remembered (or none of them
 * offered any more), the default, taken from `preferredIds` (the ones in view)
 * when there are any.
 */
export function resolveClusterSelection(groupIds: string[], remembered: string[] | null | undefined, preferredIds?: string[]): string[] {
  if (remembered) {
    if (remembered.length === 0) return [];  // everything unticked on purpose
    const kept = groupIds.filter(id => remembered.includes(id));
    if (kept.length > 0) return kept;
  }
  const preferred = preferredIds ? groupIds.filter(id => preferredIds.includes(id)) : [];
  return defaultClusterSelection(preferred.length > 0 ? preferred : groupIds);
}

