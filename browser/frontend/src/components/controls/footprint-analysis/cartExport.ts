/**
 * Saved footprints can be pinned on another chromosome than the one in view:
 * sequence export fetches each chromosome's entries on that chromosome.
 */
export interface PinnedEntry {
  referenceChrom?: string | null;
  referenceAbsStart?: number | null;
  referenceAbsEnd?: number | null;
}

export interface ChromExportGroup<T extends PinnedEntry> {
  chrom: string;
  /** Region covering the group's entries (with flank), for the request. */
  start: number;
  end: number;
  /** Indices into the original entry list, in order. */
  indices: number[];
  entries: T[];
}

export function groupEntriesByChrom<T extends PinnedEntry>(entries: T[], currentChrom: string, flank = 0): ChromExportGroup<T>[] {
  const groups = new Map<string, ChromExportGroup<T>>();
  entries.forEach((entry, index) => {
    if (entry.referenceAbsStart == null || entry.referenceAbsEnd == null) return;
    const chrom = entry.referenceChrom || currentChrom;
    // Whole bases: a class's edges can fall on a half base, and the request's region is integers.
    const lo = Math.max(0, Math.floor(entry.referenceAbsStart) - flank);
    const hi = Math.ceil(entry.referenceAbsEnd) + flank;
    const group = groups.get(chrom);
    if (!group) {
      groups.set(chrom, { chrom, start: lo, end: hi, indices: [index], entries: [entry] });
    } else {
      group.start = Math.min(group.start, lo);
      group.end = Math.max(group.end, hi);
      group.indices.push(index);
      group.entries.push(entry);
    }
  });
  return [...groups.values()];
}
