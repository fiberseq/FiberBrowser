/**
 * Canvas painting for the FiberHMM variant layers on read rows: the allele mark at each site a read covers, and the
 * split-read links (pieces of one read on different rows; SA segments outside the view). Decisions are in model.ts.
 */
import { ALLELE_AMBIGUOUS, ALLELE_DELETED, alleleColor, splitLinks, type FiberhmmRead, type VariantMark } from './model';

type Ctx = CanvasRenderingContext2D;

export interface VariantMarkOptions {
  y: number;
  rowHeight: number;
  /** View-relative bp -> canvas x. */
  toX: (rel: number) => number;
  viewStart: number;
  viewEnd: number;
  /** px per bp */
  scale: number;
}

/** One mark per site: REF slate, ALT pink, another base dark; deleted a dark line; ambiguous (DAF) an amber outline. */
export function drawReadVariantMarks(ctx: Ctx, marks: VariantMark[] | undefined, o: VariantMarkOptions): void {
  if (!marks?.length) return;
  const h = Math.max(1, o.rowHeight);
  for (const [pos, refLen, allele] of marks) {
    if (pos + Math.max(1, refLen) <= o.viewStart || pos >= o.viewEnd) continue;
    const xa = o.toX(pos - o.viewStart);
    const xb = o.toX(pos + Math.max(1, refLen) - o.viewStart);
    const w = Math.max(3, Math.abs(xb - xa));
    const x = Math.min(xa, xb) - (w - Math.abs(xb - xa)) / 2;
    ctx.save();
    if (allele === ALLELE_AMBIGUOUS) {
      ctx.strokeStyle = alleleColor(allele);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, o.y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
    } else if (allele === ALLELE_DELETED) {
      ctx.strokeStyle = alleleColor(allele);
      ctx.lineWidth = Math.max(1, Math.min(2, h / 3));
      ctx.beginPath();
      ctx.moveTo(x, o.y + h / 2);
      ctx.lineTo(x + w, o.y + h / 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = alleleColor(allele);
      ctx.fillRect(x, o.y, w, h);
    }
    ctx.restore();
  }
}

export interface SplitLinkOptions {
  first: number;
  last: number;
  rowY: (index: number) => number;
  rowHeight: number;
  toX: (rel: number) => number;
  viewChrom: string;
  viewStart: number;
  viewEnd: number;
  /** Canvas x where the track starts (labels never go left of it). */
  left: number;
}

const LINK_COLOR = '#7c3aed';

/** Dashed connectors between rows of one read's pieces, and an arrow with the destination at a clip whose SA
 * segment is outside the view. */
export function drawSplitLinks(ctx: Ctx, rows: FiberhmmRead[], o: SplitLinkOptions): void {
  const { pairs, away } = splitLinks(rows, o.first, o.last, o.viewChrom, o.viewStart, o.viewEnd);
  if (!pairs.length && !away.length) return;
  const h = Math.max(1, o.rowHeight);
  const edge = (row: FiberhmmRead, side: 'start' | 'end'): number | null => {
    const iv = row.intervals ?? [];
    if (!iv.length) return null;
    return side === 'start' ? Math.min(...iv.map(i => i[0])) : Math.max(...iv.map(i => i[1]));
  };
  ctx.save();
  ctx.strokeStyle = LINK_COLOR;
  ctx.fillStyle = LINK_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 2]);
  for (const [a, b] of pairs) {
    const ra = rows[a], rb = rows[b];
    // From the primary's right end to the piece's left end (the order the read runs in, when it is collinear).
    const xa = edge(ra, 'end'), xb = edge(rb, 'start');
    if (xa == null || xb == null) continue;
    const x1 = o.toX(xa), x2 = o.toX(xb);
    const y1 = o.rowY(a) + h / 2, y2 = o.rowY(b) + h / 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1 + 12, y1, x2 - 12, y2, x2, y2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = `${Math.max(8, Math.min(10, h))}px sans-serif`;
  ctx.textBaseline = 'middle';
  for (const item of away) {
    if (item.ref < o.viewStart || item.ref > o.viewEnd) continue;
    const x = o.toX(item.ref - o.viewStart);
    const y = o.rowY(item.row) + h / 2;
    const dir = item.side === 'R' ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dir * 8, y);
    ctx.lineTo(x + dir * 5, y - 3);
    ctx.moveTo(x + dir * 8, y);
    ctx.lineTo(x + dir * 5, y + 3);
    ctx.stroke();
    if (h >= 7) {
      const text = `→ ${item.label}`;
      const w = ctx.measureText(text).width;
      const tx = dir > 0 ? x + 10 : Math.max(o.left, x - 10 - w);
      ctx.fillText(text, tx, y);
    }
  }
  ctx.restore();
}
