/**
 * Coordinates on an insertion's alternate allele (services/alt_allele_align.py):
 *
 *   alt [0, FL)          reference [ref - FL, ref)     left flank
 *   alt [FL, FL + L)     insert positions 1..L         the insert consensus
 *   alt [FL + L, ...)    reference [ref, ...)          right flank
 *
 * Reference -> alt offsets positions after the insert by its length; alt ->
 * reference maps positions inside the insert to the breakpoint.
 */
import type { AltAlleleLayout } from './types';

export interface Span { chrom: string; start: number; end: number }

export type AltPosition =
  | { segment: 'left' | 'right'; ref: number; insert: null }
  | { segment: 'insert'; ref: null; insert: number };

/** Alt position of reference position g (0-based). */
export function refToAlt(layout: AltAlleleLayout, g: number): number {
  return g < layout.ref ? g - (layout.ref - layout.flank_left) : g - layout.ref + layout.insert_end;
}

/** Reference position of alt position a (0-based); inside the insert, the breakpoint. */
export function altToRef(layout: AltAlleleLayout, a: number): number {
  if (a < layout.insert_start) return a + layout.ref - layout.flank_left;
  if (a < layout.insert_end) return layout.ref;
  return a - layout.insert_end + layout.ref;
}

/** Both readouts of alt position a: its reference position (flanks) or its 1-based insert position. */
export function describeAltPosition(layout: AltAlleleLayout, a: number): AltPosition {
  if (a < layout.insert_start) return { segment: 'left', ref: a + layout.ref - layout.flank_left, insert: null };
  if (a < layout.insert_end) return { segment: 'insert', ref: null, insert: a - layout.insert_start + 1 };
  return { segment: 'right', ref: a - layout.insert_end + layout.ref, insert: null };
}

/** "chr2L:9,466,000" in a flank, "INS 1,234 / 9,184" inside the insert (1-based, like the locus box). */
export function altPositionLabel(layout: AltAlleleLayout, a: number): string {
  const d = describeAltPosition(layout, Math.floor(a));
  return d.segment === 'insert'
    ? `INS ${d.insert.toLocaleString()} / ${layout.insert_len.toLocaleString()}`
    : `${layout.chrom}:${(d.ref + 1).toLocaleString()}`;
}

/** The insertion, for titles: "+9,184 bp at chr2L:9,467,038". */
export function altAlleleName(layout: AltAlleleLayout): string {
  return `+${layout.insert_len.toLocaleString()} bp at ${layout.chrom}:${layout.ref.toLocaleString()}`;
}

/**
 * The alt view showing a reference view (both ends mapped: a view across the
 * breakpoint widens by the insert, so the insert shows in full). Null when it is
 * on another chromosome or misses the contig.
 */
export function mapSpanToAlt(layout: AltAlleleLayout, span: Span): Span | null {
  if (span.chrom !== layout.chrom) return null;
  const start = refToAlt(layout, span.start);
  // The end is exclusive: map its last base.
  const end = refToAlt(layout, Math.max(span.start, span.end - 1)) + 1;
  if (end <= 0 || start >= layout.length) return null;
  const s = Math.max(0, start);
  const e = Math.min(layout.length, end);
  return e - s >= 3 ? { chrom: layout.name, start: s, end: e } : null;
}

/**
 * The reference view showing an alt view: both ends mapped (inside the insert, the
 * breakpoint). A view wholly inside the insert keeps its width, centred on the breakpoint.
 */
export function mapSpanToRef(layout: AltAlleleLayout, span: Span): Span | null {
  if (span.chrom !== layout.name) return null;
  let start = altToRef(layout, span.start);
  let end = altToRef(layout, Math.max(span.start, span.end - 1)) + 1;
  const inside = span.start >= layout.insert_start && span.end <= layout.insert_end;
  if (inside || end - start < 3) {
    const width = Math.max(3, span.end - span.start);
    start = Math.max(0, Math.round(layout.ref - width / 2));
    end = start + width;
  }
  return { chrom: layout.chrom, start: Math.max(0, start), end };
}

/** The layout of an alt contig from the datasets (each alt dataset carries it), or null. */
export function altLayoutForContig(datasets: Array<{ alt_allele?: { layout?: AltAlleleLayout } }>, chrom: string | null | undefined): AltAlleleLayout | null {
  if (!chrom) return null;
  for (const d of datasets) {
    const layout = d.alt_allele?.layout;
    if (layout && layout.name === chrom) return layout;
  }
  return null;
}

// An alt panel moving the main view: the main view's move must not move it back.
let movingAltPanel: string | null = null;

export function withAltPanelMoving<T>(panelId: string, fn: () => T): T {
  const before = movingAltPanel;
  movingAltPanel = panelId;
  try {
    return fn();
  } finally {
    movingAltPanel = before;
  }
}

export function altPanelMoving(): string | null {
  return movingAltPanel;
}
