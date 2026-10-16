/**
 * The read window ("Show reads up to"): past it a read panel draws coverage, not reads.
 * Shared by the View settings and the zoomed-out read panel's card.
 */

/** The limits the View settings offer (bp). */
export const READ_LIMIT_OPTIONS = [50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000] as const;

/** A width in bp as the settings name it (100 kb, 1.5 Mb). */
export function formatLimitBp(bp: number): string {
  if (bp >= 1e6) return `${Number((bp / 1e6).toFixed(1))} Mb`;
  return `${Math.round(bp / 1e3)} kb`;
}

/** The smallest offered limit that shows a view this wide (null: wider than any). */
export function limitFor(width: number): number | null {
  return READ_LIMIT_OPTIONS.find(limit => limit >= width) ?? null;
}

/** The window of `limit` bp centred on the view (kept inside the contig's start). */
export function windowAtLimit(start: number, end: number, limit: number): { start: number; end: number } {
  const width = Math.min(limit, end - start);
  const centre = Math.round((start + end) / 2);
  const from = Math.max(0, centre - Math.floor(width / 2));
  return { start: from, end: from + width };
}

/** Above this many reads in view a full load takes long enough to say so. */
export const SLOW_LOAD_READS = 5_000;
