import { useBrowserStore } from '../stores/browserStore';
import type { ReadTrackStatus } from '../stores/uiSlice';

/**
 * Whether the main view's reads have arrived: no read panel showing this view
 * is still loading it. Background analyses that follow the view (quality
 * counts, insertions in view) wait for this, so the reads load first and the
 * analyses then reuse what the server loaded for them.
 */
export function viewReadsReady(
  statuses: Record<string, ReadTrackStatus | undefined>, chrom: string, start: number, end: number,
): boolean {
  for (const status of Object.values(statuses)) {
    if (!status || status.chrom !== chrom || status.start !== start || status.end !== end) continue;
    if (status.loading || status.stale) return false;
  }
  return true;
}

export function useViewReadsReady(): boolean {
  return useBrowserStore(s => viewReadsReady(s.readTrackStatus ?? {}, s.chrom, s.start, s.end));
}
