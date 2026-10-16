/**
 * Locked sites: panels with their own view (viewportOverride) whose lock is
 * on move together with each other and with the main view. A pan or zoom in
 * one moves the others by the same number of bases and the same zoom factor
 * around their own centres, so sites at different coordinates (another
 * haplotype, a paralog, an enhancer elsewhere) stay aligned.
 */

export interface Span { chrom: string; start: number; end: number }

let suppressDepth = 0;

/** Run fn without passing its viewport changes on to locked sites (the caller already did). */
export function withSiteLockSuppressed<T>(fn: () => T): T {
  suppressDepth += 1;
  try {
    return fn();
  } finally {
    suppressDepth -= 1;
  }
}

export function siteLockSuppressed(): boolean {
  return suppressDepth > 0;
}

/** A pan or zoom rather than a jump: same chromosome, and the new view overlaps or neighbours the old one. */
export function isPanOrZoom(prev: Span, next: Span): boolean {
  if (prev.chrom !== next.chrom) return false;
  const span = Math.max(1, prev.end - prev.start);
  return next.start <= prev.end + span && next.end >= prev.start - span;
}

/** Move target the way prev became next. */
export function moveLikewise(target: Span, prev: Span, next: Span): Span {
  const factor = (next.end - next.start) / Math.max(1, prev.end - prev.start);
  const shift = (next.start + next.end) / 2 - (prev.start + prev.end) / 2;
  const width = Math.max(3, Math.round((target.end - target.start) * factor));
  const centre = (target.start + target.end) / 2 + shift;
  const start = Math.max(0, Math.round(centre - width / 2));
  return { chrom: target.chrom, start, end: start + width };
}

/** Older sessions: haplotype comparisons synced by group; they are locked sites now. */
export function migrateSitePanels<T extends { haplotypeGroup?: string; siteLocked?: boolean }>(panels: T[]): T[] {
  return panels.map(p => (p && p.haplotypeGroup && p.siteLocked === undefined ? { ...p, siteLocked: true } : p));
}
