/**
 * Live-lift rows (DESIGN_LIVE_LIFT.md §5.4): a read drawn on the main genome through a graphlift map.
 *
 * The row's body is its segments minus its connectors, whatever the SV display says: a connector (a target-only
 * gap of the map, < G_split) is a dashed line, a badge (source sequence with no target here: an insertion of the
 * source assembly, a dissimilar bubble, a part mapped elsewhere) a notch with its molecular bp, and a segment on a
 * '-' piece (the source runs reversed here) gets a chevron edge. Coordinates are view-relative like `intervals`.
 */
import type { CompactRead, LiveLiftRow } from './types';
import { labelFits, rowLabelFontPx } from './svDrawing';

type Ctx = CanvasRenderingContext2D;

/** A badge with fewer molecular bp is a thin tick without a label (the maps' 1-3 bp indels would crowd every row). */
export const BADGE_LABEL_MIN_BP = 50;

export const LIVE_LIFT_COLORS = {
  connector: '#0e7490',
  badge: '#0e7490',
  elsewhere: '#b45309',
  reversed: '#0e7490',
} as const;

/** Badge reasons as people read them. */
export const BADGE_REASONS: Record<string, string> = {
  source_insertion: 'sequence of the source assembly only (not in this genome)',
  target_insertion: 'sequence of this genome only',
  aligned_indel: 'an indel between the assemblies',
  dissimilar: 'a dissimilar stretch (no base-to-base correspondence)',
  too_big: 'a difference too big to align',
  conflict: 'a structural conflict (aligned elsewhere)',
  uncovered: 'source sequence the graph does not cover',
  outside_chains: 'no chain covers this source sequence',
  elsewhere: 'maps elsewhere on this genome',
  unknown: 'no correspondence',
};

/** View-relative body spans: segments minus connectors, sorted. */
export function liveLiftBodySpans(ll: LiveLiftRow): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const cons = [...(ll.connectors ?? [])].sort((a, b) => a[0] - b[0]);
  for (const seg of ll.segments ?? []) {
    let pos = seg[0];
    for (const [c0, c1] of cons) {
      if (c1 <= seg[0] || c0 >= seg[1]) continue;
      if (c0 > pos) out.push([pos, c0]);
      pos = Math.max(pos, c1);
    }
    if (seg[1] > pos) out.push([pos, seg[1]]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Pixel rectangles of a lifted row's body (reverse-aware, clipped to the view). */
export function liveLiftBodyRects(
  ll: LiveLiftRow,
  linkedOffset: number,
  regionWidth: number,
  toX: (rel: number) => number,
): Array<{ x: number; w: number }> {
  const rects: Array<{ x: number; w: number }> = [];
  for (const [s, e] of liveLiftBodySpans(ll)) {
    const a = Math.max(0, s + linkedOffset);
    const b = Math.min(regionWidth, e + linkedOffset);
    if (b <= a) continue;
    const x1 = toX(a);
    const x2 = toX(b);
    rects.push({ x: Math.min(x1, x2), w: Math.max(1, Math.abs(x2 - x1)) });
  }
  return rects;
}

/** The segment (and its strand) at a view-relative position, or null (a connector, a gap between segments). */
export function liveLiftSegmentAt(ll: LiveLiftRow, pos: number): { strand: '+' | '-'; chain: number } | null {
  for (const [s, e] of liveLiftBodySpans(ll)) {
    if (pos >= s && pos < e) {
      const seg = (ll.segments ?? []).find(g => pos >= g[0] && pos < g[1]);
      return seg ? { strand: seg[3], chain: seg[2] } : null;
    }
  }
  return null;
}

/** "+2.4 kb" / "+80 bp" for a badge's molecular bases. */
export function formatBadgeBp(bp: number): string {
  if (bp >= 10_000) return `+${Math.round(bp / 1000)} kb`;
  if (bp >= 1000) return `+${(bp / 1000).toFixed(1)} kb`;
  return `+${bp} bp`;
}

export interface LiveLiftMarkOptions {
  y: number;
  rowHeight: number;
  linkedOffset: number;
  regionWidth: number;
  toX: (rel: number) => number;
  isReversed: boolean;
  /** Behind badge labels. */
  backgroundColor: string;
}

/** Connectors, reversed-segment edges and badges of a lifted row, over its (already drawn) body. */
export function drawLiveLiftMarks(ctx: Ctx, ll: LiveLiftRow, o: LiveLiftMarkOptions): void {
  const { y, rowHeight, toX, linkedOffset, regionWidth } = o;
  if (rowHeight <= 0) return;
  const midY = y + rowHeight / 2;
  const inView = (p: number) => p + linkedOffset >= 0 && p + linkedOffset <= regionWidth;
  // Connectors: dashed, so a target-only gap never reads as a deletion of the molecule.
  ctx.save();
  ctx.strokeStyle = LIVE_LIFT_COLORS.connector;
  ctx.lineWidth = 1;
  ctx.setLineDash?.([3, 2]);
  for (const [c0, c1] of ll.connectors ?? []) {
    const a = Math.max(0, c0 + linkedOffset);
    const b = Math.min(regionWidth, c1 + linkedOffset);
    if (b <= a) continue;
    ctx.beginPath();
    ctx.moveTo(toX(a), midY);
    ctx.lineTo(toX(b), midY);
    ctx.stroke();
  }
  ctx.restore();
  // Reversed segments: a chevron rule along the top edge.
  for (const seg of ll.segments ?? []) {
    if (seg[3] !== '-') continue;
    const a = Math.max(0, seg[0] + linkedOffset);
    const b = Math.min(regionWidth, seg[1] + linkedOffset);
    if (b <= a) continue;
    const x1 = Math.min(toX(a), toX(b));
    const x2 = Math.max(toX(a), toX(b));
    ctx.fillStyle = LIVE_LIFT_COLORS.reversed;
    ctx.fillRect(x1, y, x2 - x1, Math.max(1, Math.min(2, rowHeight / 4)));
    if (rowHeight >= 6 && x2 - x1 >= 14) {
      // Chevrons point the way the source runs (left on screen, or right in a reversed panel).
      const dir = o.isReversed ? 1 : -1;
      for (let x = x1 + 6; x < x2 - 3; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x + 2 * dir, y + 1);
        ctx.lineTo(x - 2 * dir, y + 3);
        ctx.lineTo(x + 2 * dir, y + 5);
        ctx.strokeStyle = LIVE_LIFT_COLORS.reversed;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
  // Badges: a notch with the molecule's bases that have no target here.
  const fontPx = rowLabelFontPx(rowHeight);
  for (const badge of ll.badges ?? []) {
    const [pos, kind, molBp] = badge;
    if (!inView(pos)) continue;
    const x = toX(pos + linkedOffset);
    const color = kind === 'elsewhere' ? LIVE_LIFT_COLORS.elsewhere : LIVE_LIFT_COLORS.badge;
    ctx.fillStyle = color;
    const h = Math.max(2, rowHeight);
    if (molBp < BADGE_LABEL_MIN_BP && kind !== 'elsewhere') {
      ctx.globalAlpha = 0.6;
      ctx.fillRect(x - 0.5, y, 1, h);
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(x - 3, y);
    ctx.lineTo(x + 3, y);
    ctx.lineTo(x, y + Math.min(5, h / 2));
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(x - 0.5, y, 1, h);
    const text = formatBadgeBp(molBp);
    if (fontPx > 0 && labelFits(text, 60, fontPx * 0.56)) {
      ctx.font = `${fontPx}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const w = (ctx.measureText?.(text)?.width ?? text.length * fontPx * 0.56) + 4;
      ctx.fillStyle = o.backgroundColor;
      ctx.fillRect(x + 3, midY - fontPx / 2 - 1, w, fontPx + 2);
      ctx.fillStyle = color;
      ctx.fillText(text, x + 5, midY);
    }
  }
}

/** Whether a read is a live-lift row. */
export function isLiveLiftRow(read: Pick<CompactRead, 'live_lift'>): boolean {
  return Boolean(read.live_lift && Array.isArray(read.live_lift.segments));
}
