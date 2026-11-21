/**
 * The nucleosome array lane of a read row (nucleosome panel DESIGN §7.1): a thin strip at the bottom of the row,
 * coloured by segment state, with disruption events over it. Rows come from the read's `nucseg` layer
 * (utils/nucLayers.ts); coordinates are view-relative like `intervals`.
 *
 * Only fillRect, plain paths and line dashes are used, so figure export records the lane as vectors.
 */
import {
  NUC_EVENT_MISSING,
  NUC_EVENT_UNDERSIZED,
  NUC_SEG_LOW_INFORMATION,
  nucMissingTriangle,
  nucSegColor,
  nucSegLaneGeometry,
  nucUndersizedBar,
  type NucSegRow,
  type NucSegRows,
} from '../../../utils/nucLayers';

type Ctx = CanvasRenderingContext2D;

export interface NucSegLaneOptions {
  /** Top of the read row's drawn body and its height (rowHeight - rowGap). */
  y: number;
  bodyH: number;
  linkedOffset: number;
  regionWidth: number;
  toX: (rel: number) => number;
  /** The read's ground colour: gaps in the lane and the strip under dotted stretches. */
  ground: string;
  dark: boolean;
}

/** A row's span in canvas x, clipped to the view (null when outside it). */
function rowSpan(row: NucSegRow, o: NucSegLaneOptions): { x: number; w: number; cx: number } | null {
  const a = Math.max(0, row.start + o.linkedOffset);
  const b = Math.min(o.regionWidth, row.end + o.linkedOffset);
  if (b <= a) return null;
  const pa = o.toX(a), pb = o.toX(b);
  return { x: Math.min(pa, pb), w: Math.max(1, Math.abs(pb - pa)), cx: (pa + pb) / 2 };
}

/** Draw the lane; returns the number of rows drawn. */
export function drawNucSegLane(ctx: Ctx, rows: NucSegRows, o: NucSegLaneOptions): number {
  const lane = nucSegLaneGeometry(o.y, o.bodyH);
  if (!lane) return 0;
  let drawn = 0;
  ctx.save();
  ctx.globalAlpha = 1;
  for (const row of rows.segments) {
    const span = rowSpan(row, o);
    if (!span) continue;
    drawn++;
    if (lane.gapAbove) {
      ctx.fillStyle = o.ground;
      ctx.fillRect(span.x, lane.y - 1, span.w, 1);
    }
    const color = nucSegColor(row.code, o.dark);
    if (row.code === NUC_SEG_LOW_INFORMATION) {
      // Low information: a pale strip with a dotted line through it.
      ctx.fillStyle = o.ground;
      ctx.fillRect(span.x, lane.y, span.w, lane.h);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = color;
      ctx.fillRect(span.x, lane.y, span.w, lane.h);
      ctx.globalAlpha = 1;
      if (span.w >= 3) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = lane.h;
        ctx.setLineDash([1.5, 1.5]);
        ctx.beginPath();
        ctx.moveTo(span.x, lane.y + lane.h / 2);
        ctx.lineTo(span.x + span.w, lane.y + lane.h / 2);
        ctx.stroke();
        ctx.restore();
      }
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(span.x, lane.y, span.w, lane.h);
    }
  }
  for (const row of rows.events) {
    const span = rowSpan(row, o);
    if (!span) continue;
    drawn++;
    const color = nucSegColor(row.code, o.dark);
    if (row.code === NUC_EVENT_UNDERSIZED) {
      const bar = nucUndersizedBar(lane);
      ctx.fillStyle = color;
      ctx.fillRect(span.x, bar.y, span.w, bar.h);
    } else if (row.code === NUC_EVENT_MISSING) {
      // A gap in the lane where the grid predicts a nucleosome, and a triangle over its centre.
      const triangle = nucMissingTriangle(lane, span.cx);
      ctx.fillStyle = triangle ? o.ground : color;
      ctx.fillRect(span.x, lane.y, span.w, lane.h);
      if (triangle) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(triangle[0][0], triangle[0][1]);
        ctx.lineTo(triangle[1][0], triangle[1][1]);
        ctx.lineTo(triangle[2][0], triangle[2][1]);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(span.x, lane.y, span.w, lane.h);
    }
  }
  ctx.restore();
  return drawn;
}
