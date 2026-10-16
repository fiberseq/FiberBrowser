/**
 * Links into the NFR (Accessibility) panel: the Footprints panel's classes, the NFR channel and the arcs open it at an
 * NFR of a run. NFR shape (stable openings) and footprints (transient binding inside them) are complementary views of
 * the same molecules; these links keep the two panels on the same run and region.
 */
import { useBrowserStore } from '../../stores/browserStore';

export const FOCUS_NFR_EVENT = 'fiberbrowser:focus-nfr';

export interface FocusNfrDetail {
  jobId: string; nfrId: string; saved?: boolean;
  /** A variant of the NFR to bring into view (its row). */
  variantId?: string;
  /** A footprint class (its id) to point at: the card opens on its Footprints view with that class marked, and
   * nothing is computed again (the views keep their answers). */
  classId?: string;
  /** The Find classes run of that class: a card whose classes come from another run says so instead of marking one. */
  classJob?: string;
}

/** Open the Accessibility panel at an NFR of a run: its card opens in place and comes into view (a starred NFR of
 * another run: in Earlier). ``saved`` is kept for callers; the card is found either way. */
export function showNfr(jobId: string, nfrId: string, saved = false, variantId?: string, classId?: string, classJob?: string): void {
  useBrowserStore.getState().openAnalysisPanel('accessibility');
  window.setTimeout(() => window.dispatchEvent(new CustomEvent<FocusNfrDetail>(FOCUS_NFR_EVENT, {
    detail: { jobId, nfrId, saved, ...(variantId ? { variantId } : {}), ...(classId ? { classId } : {}), ...(classJob ? { classJob } : {}) },
  })), 50);
}

/** Saved NFRs whose window overlaps a span (same chromosome, ignoring a chr prefix). */
export function savedNfrsOver(chrom: string | null | undefined, start: number, end: number) {
  const bare = (c: string) => c.replace(/^chr/i, '');
  return useBrowserStore.getState().savedNfrVariants.filter(e => !!chrom && bare(e.chrom) === bare(chrom)
    && Math.min(e.nfrStart, ...e.variants.map(v => v.start)) < end && Math.max(e.nfrEnd, ...e.variants.map(v => v.end)) > start);
}
