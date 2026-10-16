/**
 * The first view of newly opened data shows its reads (UI audit M4).
 *
 * When a dataset is added while no panel shows any read (a fresh workspace,
 * a genome loaded at its default locus), it is marked here with the view it
 * was added at. Its read track, once the reads for that view have arrived,
 * takes the mark: no reads there → go to its best-covered locus. Anything
 * that moves the view first (a session, the tour, a link, the user) cancels
 * it, so a deliberate locus is never overridden.
 */

interface PendingJump { datasetId: string; viewport: string }

let pending: PendingJump | null = null;

export const viewportKey = (chrom: string, start: number, end: number): string => `${chrom}:${start}-${end}`;

/** Mark `datasetId` to be shown at its reads if the view it was added at has none. */
export function markFirstReadsJump(datasetId: string, viewport: string): void {
  pending = { datasetId, viewport };
}

/**
 * The read track of `datasetId` has the reads for `viewport`: true when it
 * should go to the dataset's reads now (the mark is used up either way; a
 * moved view cancels it).
 */
export function takeFirstReadsJump(datasetId: string, viewport: string): boolean {
  if (!pending || pending.datasetId !== datasetId) return false;
  const sameView = pending.viewport === viewport;
  pending = null;
  return sameView;
}

/** The view moved or the dataset went away: forget the mark. */
export function cancelFirstReadsJump(datasetId?: string): void {
  if (!pending) return;
  if (datasetId === undefined || pending.datasetId === datasetId) pending = null;
}

/** Test helper. */
export function pendingFirstReadsJump(): PendingJump | null {
  return pending;
}
