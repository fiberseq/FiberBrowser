/**
 * Drawing the graph panel: its own ruler (true target coordinates) and the thin topology preview's lanes. Every
 * position goes through the panel's GraphTransform; the canvas is set up in screen coordinates, so no linear
 * panel's insertion expansion, highlight or pan offset reaches it.
 */
import { liveLiftHaplotypeColor } from '../liveLift/palette';
import { TRACK_BACKGROUND } from '../../components/tracks/TrackContainerConstants';
import { formatBp, ticks, toX, type GraphTransform, type GraphViewport } from './coordinates';
import type { GraphPreview, PreviewLane, PreviewPiece } from './preview';

export const GRAPH_GUTTER = 52;
export const GRAPH_RULER_HEIGHT = 30;
export const GRAPH_LANE_HEIGHT = 28;
export const GRAPH_LANE_GAP = 4;
const TARGET_INK = '#334155';

export interface HitRegion {
  x0: number; x1: number; y0: number; y1: number;
  lane: PreviewLane;
  piece: PreviewPiece;
}

export function laneColor(lane: PreviewLane, dark = false): string {
  return lane.role === 'target' ? (dark ? '#cbd5e1' : TARGET_INK) : liveLiftHaplotypeColor(lane.label, dark);
}

export function laneTop(index: number, laneHeight = GRAPH_LANE_HEIGHT): number {
  return GRAPH_RULER_HEIGHT + GRAPH_LANE_GAP + index * (laneHeight + GRAPH_LANE_GAP);
}

export function drawRuler(ctx: CanvasRenderingContext2D, t: GraphTransform, view: GraphViewport, width: number): void {
  ctx.fillStyle = TRACK_BACKGROUND.axis;
  ctx.fillRect(0, 0, width, GRAPH_RULER_HEIGHT);
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(t.left, GRAPH_RULER_HEIGHT - 0.5);
  ctx.lineTo(t.left + t.width, GRAPH_RULER_HEIGHT - 0.5);
  ctx.stroke();
  const region = `${view.contig}:${view.start.toLocaleString('en-US')}-${view.end.toLocaleString('en-US')}${t.reversed ? " ◄ 3'→5'" : ''}`;
  const size = formatBp(view.end - view.start);
  ctx.font = 'bold 10px sans-serif';
  const regionRight = t.left + 4 + ctx.measureText(region).width;
  ctx.font = '9px sans-serif';
  const sizeLeft = width - 4 - ctx.measureText(size).width;
  ctx.fillStyle = '#666';
  ctx.textAlign = 'center';
  for (const pos of ticks(t).positions) {
    const x = toX(t, pos);
    if (x < t.left + 4 || x > t.left + t.width - 4) continue;
    ctx.beginPath();
    ctx.moveTo(x, GRAPH_RULER_HEIGHT - 6);
    ctx.lineTo(x, GRAPH_RULER_HEIGHT - 1);
    ctx.stroke();
    const label = pos.toLocaleString('en-US');
    const half = ctx.measureText(label).width / 2;
    if (x - half < regionRight + 6 || x + half > sizeLeft - 6) continue;
    ctx.fillText(label, x, GRAPH_RULER_HEIGHT - 10);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#333';
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText(region, t.left + 4, 12);
  ctx.textAlign = 'right';
  ctx.font = '9px sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText(size, width - 4, 12);
  ctx.textAlign = 'left';
}

function hatch(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let x = x0 - h; x < x0 + w; x += 5) {
    ctx.beginPath();
    ctx.moveTo(x, y0 + h);
    ctx.lineTo(x + h, y0);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw every lane; returns the hit regions (CSS px) for hover. */
export function drawLanes(ctx: CanvasRenderingContext2D, preview: GraphPreview, t: GraphTransform, width: number,
                          laneHeight = GRAPH_LANE_HEIGHT, dark = false): HitRegion[] {
  const hits: HitRegion[] = [];
  preview.lanes.forEach((lane, index) => {
    const top = laneTop(index, laneHeight);
    const mid = top + laneHeight / 2;
    const color = laneColor(lane, dark);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, top - GRAPH_LANE_GAP / 2, width, laneHeight + GRAPH_LANE_GAP);
    // Compact label in the gutter: the data starts right of it.
    ctx.fillStyle = color;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(lane.label, 6, mid + 3.5, GRAPH_GUTTER - 10);
    ctx.save();
    ctx.beginPath();
    ctx.rect(t.left, top - 2, t.width, laneHeight + 4);
    ctx.clip();
    // The lane's spine.
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(t.left, mid + 0.5);
    ctx.lineTo(t.left + t.width, mid + 0.5);
    ctx.stroke();
    let shade = 0;
    const markers: PreviewPiece[] = [];
    for (const piece of lane.pieces) {
      if (piece.kind === 'insertion') { markers.push(piece); continue; }
      const a = toX(t, piece.start), b = toX(t, piece.end);
      const x0 = Math.min(a, b), w = Math.max(1, Math.abs(b - a));
      if (piece.kind === 'node') {
        ctx.globalAlpha = shade++ % 2 ? 0.72 : 0.92;
        ctx.fillStyle = color;
        ctx.fillRect(x0, mid - 5, w, 10);
        ctx.globalAlpha = 1;
        if (piece.reverse && w >= 6) {
          // Opposite orientation to the target: chevrons pointing back.
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          for (let x = x0 + 4; x < x0 + w - 2; x += 8) {
            const dir = t.reversed ? 1 : -1;
            ctx.beginPath();
            ctx.moveTo(x - dir * 2, mid - 3);
            ctx.lineTo(x + dir * 2, mid);
            ctx.lineTo(x - dir * 2, mid + 3);
            ctx.stroke();
          }
        }
        hits.push({ x0, x1: x0 + w, y0: mid - 6, y1: mid + 6, lane, piece });
      } else if (piece.kind === 'unavailable') {
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(x0, mid - 6, w, 12);
        hatch(ctx, x0, mid - 6, w, 12, '#94a3b8');
        hits.push({ x0, x1: x0 + w, y0: mid - 6, y1: mid + 6, lane, piece });
      } else if (piece.kind === 'deletion') {
        // The alternate skips this target stretch: a bypass arc over it.
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(x0, mid - 5);
        ctx.quadraticCurveTo(x0 + w / 2, top + 1, x0 + w, mid - 5);
        ctx.stroke();
        if (w > 44) {
          ctx.fillStyle = color;
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`−${formatBp(piece.bp)}`, x0 + w / 2, mid + 12);
          ctx.textAlign = 'left';
        }
        hits.push({ x0, x1: x0 + w, y0: top, y1: top + laneHeight, lane, piece });
      } else if (piece.kind === 'divergent') {
        ctx.strokeStyle = color;
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, mid - 5.5, Math.max(1, w - 1), 11);
        ctx.setLineDash([]);
        if (w > 60) {
          ctx.fillStyle = color;
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`${formatBp(piece.bp)} / ${formatBp(piece.end - piece.start)}`, x0 + w / 2, mid + 3);
          ctx.textAlign = 'left';
        }
        hits.push({ x0, x1: x0 + w, y0: mid - 6, y1: mid + 6, lane, piece });
      }
    }
    ctx.restore();
    // Insertions last, over everything: a wedge at the boundary and the true length (a label that would overlap
    // the previous one is left out; hovering the wedge still says it).
    let labelRight = -Infinity;
    markers.sort((a, b) => toX(t, a.start) - toX(t, b.start));
    for (const piece of markers) {
      const x = toX(t, piece.start);
      if (x < t.left - 1 || x > t.left + t.width + 1) continue;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 5, top + 1);
      ctx.lineTo(x + 5, top + 1);
      ctx.lineTo(x, mid - 1);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - 0.75, mid - 6, 1.5, 12);
      const label = `+${formatBp(piece.bp)}`;
      ctx.font = 'bold 9px sans-serif';
      const lw = ctx.measureText(label).width;
      const right = x + 7 + lw < t.left + t.width;
      const x0 = right ? x + 7 : x - 7 - lw;
      if (x0 > labelRight + 3) {
        ctx.textAlign = right ? 'left' : 'right';
        ctx.fillText(label, right ? x + 7 : x - 7, top + 9);
        ctx.textAlign = 'left';
        labelRight = x0 + lw;
      }
      hits.push({ x0: x - 6, x1: x + 6, y0: top, y1: top + laneHeight, lane, piece });
    }
  });
  return hits;
}

export function hitAt(hits: HitRegion[], x: number, y: number): HitRegion | null {
  // Insertions are pushed last and are narrow: prefer the last match.
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
  }
  return null;
}

export function describeHit(hit: HitRegion): string {
  const p = hit.piece;
  const where = (n: number) => n.toLocaleString('en-US');
  switch (p.kind) {
    case 'node':
      return `${hit.lane.label} · node ${p.node}${p.reverse ? ' (reverse)' : ''} · ${where(p.start)}-${where(p.end)} on the target`;
    case 'insertion':
      return `${hit.lane.label} · insertion of ${formatBp(p.bp)} at target boundary ${where(p.start)}`
        + (p.source ? ` · source ${where(p.source.start)}-${where(p.source.end)}` : '');
    case 'deletion':
      return `${hit.lane.label} · skips ${formatBp(p.bp)} of the target (${where(p.start)}-${where(p.end)})`;
    case 'divergent':
      return `${hit.lane.label} · ${formatBp(p.bp)} of its own in place of target ${where(p.start)}-${where(p.end)} (${formatBp(p.end - p.start)})`;
    case 'unavailable':
      return `${hit.lane.label} · no named sequence ${where(p.start)}-${where(p.end)}`;
  }
}
