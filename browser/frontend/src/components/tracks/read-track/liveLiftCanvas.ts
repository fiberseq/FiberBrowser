/**
 * Live-lift rows (DESIGN_LIVE_LIFT.md §5.4): a read drawn on the main genome through a graphlift map.
 *
 * The row's body is its segments minus its connectors, whatever the SV display says: a connector (a target-only
 * gap of the map, < G_split) is a dashed line, a badge (source sequence with no target here: an insertion of the
 * source assembly, a dissimilar bubble, a part mapped elsewhere) a notch with its molecular bp, and a segment on a
 * '-' piece (the source runs reversed here) gets a chevron edge. Coordinates are view-relative like `intervals`.
 */
import type { CompactRead, LiveLiftRow, SvEvent } from './types';
import { labelFits, rowLabelFontPx } from './svDrawing';
import { liveLiftHaplotypeColor } from '../../../features/liveLift/palette';

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
  substitution: 'bases differ between HG002 and GRCh38',
  aligned: 'an approximately aligned bubble (may contain indels)',
  inversion: 'source sequence runs in reverse relative to GRCh38',
  no_correspondence: 'GRCh38 sequence with no primary HG002 correspondence',
  read_mismatch: 'a read-specific mismatch (read evidence)',
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
  /** Per-read insertion badges (Differences options): none, a tick without text (default), or ticks with their size. */
  badgeMode?: LiveLiftBadgeMode;
}

export type LiveLiftBadgeMode = 'off' | 'ticks' | 'labels';
/** The smallest drawn badge, whatever the row height (rows a few px tall still show where an insertion is). */
export const BADGE_MIN_NOTCH = { w: 6, h: 4 } as const;

export type LiveLiftBadge = NonNullable<LiveLiftRow['badges']>[number];
interface PixelRect { x: number; y: number; w: number; h: number }
export interface LiveLiftBadgeGeometry {
  badge: LiveLiftBadge;
  x: number;
  notch: PixelRect;
  label: (PixelRect & { text: string; fontPx: number }) | null;
}

/**
 * Shared drawn and interactive geometry. Coordinates include the linked origin and the panel's reversed mapping;
 * badges remain anchored to that mapping while their text always reads left-to-right. Fixed label advances reserve
 * the same box in canvas and mouse code, without a second font-measuring canvas on every mouse move.
 */
export function liveLiftBadgeGeometry(ll: LiveLiftRow, o: Omit<LiveLiftMarkOptions, 'backgroundColor' | 'isReversed'>): LiveLiftBadgeGeometry[] {
  const { y, rowHeight, linkedOffset, regionWidth, toX } = o;
  const h = Math.max(2, rowHeight);
  const mode = o.badgeMode ?? 'labels';
  if (mode === 'off') return [];
  // Labels need rows of at least 7 px (rowLabelFontPx); thinner rows keep their tick.
  const fontPx = mode === 'labels' ? rowLabelFontPx(rowHeight) : 0;
  const badges: LiveLiftBadgeGeometry[] = [];
  for (const badge of ll.badges ?? []) {
    const [pos, kind, molBp] = badge;
    if (pos + linkedOffset < 0 || pos + linkedOffset > regionWidth) continue;
    const x = toX(pos + linkedOffset);
    const text = formatBadgeBp(molBp);
    const labelled = (molBp >= BADGE_LABEL_MIN_BP || kind === 'elsewhere')
      && fontPx > 0 && labelFits(text, 60, fontPx * 0.56);
    badges.push({ badge, x, notch: { x: x - BADGE_MIN_NOTCH.w / 2, y, w: BADGE_MIN_NOTCH.w, h: Math.max(BADGE_MIN_NOTCH.h, h) },
      label: labelled ? { x: x + 3, y: y + rowHeight / 2 - fontPx / 2 - 1,
        w: text.length * fontPx * 0.56 + 4, h: fontPx + 2, text, fontPx } : null });
  }
  return badges;
}

/** Dense maps put tiny ticks inside a labelled insertion's notch. Prefer a
 * labelled hit, then the nearest notch centre, then the larger molecular span;
 * array order must never decide which insertion a person opens. */
export function liveLiftHitAt(ll: LiveLiftRow, x: number, y: number,
  options: Parameters<typeof liveLiftBadgeGeometry>[1]): { badge?: LiveLiftBadge } | null {
  const inside = (r: PixelRect) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  const hits = liveLiftBadgeGeometry(ll, options).filter(b => inside(b.notch) || (b.label && inside(b.label)));
  const labelled = hits.filter(b => b.label);
  const nearest = (labelled.length ? labelled : hits).sort((a, b) => Math.abs(x - a.x) - Math.abs(x - b.x)
    || b.badge[2] - a.badge[2])[0];
  if (nearest) return { badge: nearest.badge };
  const bodies = liveLiftBodyRects(ll, options.linkedOffset, options.regionWidth, options.toX);
  return bodies.some(rect => inside({ ...rect, y: options.y, h: Math.max(1, options.rowHeight) })) ? {} : null;
}

/** Map-marker interaction uses the same row-relative frame as its connectors
 * and badges, independently of native SV visibility and display thresholds. */
export function liveLiftMapEventAt(ll: LiveLiftRow | undefined, pos: number, tolBp: number): Extract<SvEvent, { t: 'D' | 'I' }> | null {
  let best: Extract<SvEvent, { t: 'D' | 'I' }> | null = null;
  let distance = Infinity;
  for (const g of ll?.gap_observations ?? []) {
    if (Math.max(g.ref_bp, g.alt_bp) < 10) continue;
    if (g.kind === 'insertion' ? g.coverage.mol_bp < 10 : !g.coverage.full) continue;
    const d = Math.max(g.pos - pos, pos - g.pos - g.ref_bp, 0);
    if (d > tolBp || d >= distance) continue;
    distance = d;
    best = { t: g.alt_bp >= g.ref_bp ? 'I' : 'D', ref: g.t_start, ref_end: g.t_end, q: 0,
      len: g.kind === 'insertion' ? g.coverage.mol_bp : Math.max(g.ref_bp, g.alt_bp),
      ref_len: g.ref_bp, alt_len: g.alt_bp, source: 'assembly', display_only: true,
      difference_id: g.id, method: 'assembly_projection' };
  }
  return best;
}

/** Only pooled rows need the parental identity at their leftmost visible body edge (also in a reversed panel). */
export function drawLiveLiftHaplotypeStripe(ctx: Ctx, ll: LiveLiftRow,
  options: Parameters<typeof liveLiftBadgeGeometry>[1], liftHap?: string | null, dark = false): void {
  if (liftHap) return;
  const bodies = liveLiftBodyRects(ll, options.linkedOffset, options.regionWidth, options.toX);
  const left = bodies.reduce<{ x: number; w: number } | null>((a, b) => !a || b.x < a.x ? b : a, null);
  if (!left) return;
  ctx.fillStyle = liveLiftHaplotypeColor(ll.hap_label ?? ll.hap, dark);
  ctx.fillRect(left.x, options.y, Math.min(3, left.w), Math.max(1, options.rowHeight));
}

/** Connectors, reversed-segment edges and badges of a lifted row, over its (already drawn) body. */
export function drawLiveLiftMarks(ctx: Ctx, ll: LiveLiftRow, o: LiveLiftMarkOptions): void {
  const { y, rowHeight, toX, linkedOffset, regionWidth } = o;
  if (rowHeight <= 0) return;
  const midY = y + rowHeight / 2;
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
  for (const { badge, x, label } of liveLiftBadgeGeometry(ll, o)) {
    const [, kind, molBp] = badge;
    const color = kind === 'elsewhere' ? LIVE_LIFT_COLORS.elsewhere : LIVE_LIFT_COLORS.badge;
    ctx.fillStyle = color;
    const h = Math.max(2, rowHeight);
    if (molBp < BADGE_LABEL_MIN_BP && kind !== 'elsewhere') {
      ctx.globalAlpha = 0.6;
      ctx.fillRect(x - 0.5, y, 1, h);
      ctx.globalAlpha = 1;
      continue;
    }
    // A notch of fixed minimum size, outlined in the row's ground so it stays visible on dense, thin rows.
    const notchH = Math.max(3, Math.min(5, h / 2));
    ctx.beginPath();
    ctx.moveTo(x - 3, y);
    ctx.lineTo(x + 3, y);
    ctx.lineTo(x, y + notchH);
    ctx.closePath();
    ctx.strokeStyle = o.backgroundColor;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fill();
    ctx.fillRect(x - 0.5, y, 1, Math.max(BADGE_MIN_NOTCH.h, h));
    if (label) {
      ctx.font = `${label.fontPx}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = o.backgroundColor;
      ctx.fillRect(label.x, label.y, label.w, label.h);
      ctx.fillStyle = color;
      ctx.fillText(label.text, x + 5, midY, label.w - 4);
    }
  }
}

/** Whether a read is a live-lift row. */
export function isLiveLiftRow(read: Pick<CompactRead, 'live_lift'>): boolean {
  return Boolean(read.live_lift && Array.isArray(read.live_lift.segments));
}
