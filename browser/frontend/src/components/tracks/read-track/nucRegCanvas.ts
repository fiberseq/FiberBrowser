/**
 * The regularity lane of a read row (FiberHMM `nucreg` tiles, utils/nucLayers.ts): a colour strip over the top of the
 * row, interpolated between tile centres on one continuous ramp (pale at the dataset's random-packing reference
 * median, deep blue at its observed 95th percentile). The footprints stay drawn below it in the read-track colours;
 * with `full` the lane fills the whole row instead.
 *
 * Gaps: inside the window grid's reach a position without a score had too few calls and is hatched (thin grey
 * stripes); beyond the reach (read ends no window covers) the lane is left empty.
 *
 * Only fillRect is used (no gradients), so figure export records the lane as vectors: each stretch between two tile
 * centres is drawn as a few narrow rects of interpolated colour.
 */
import { nucRegInReach, nucRegRampColor, nucRegScaleT, nucRegScoreAt, type NucRegRows } from '../../../utils/nucLayers';

export const NUC_REG_HATCH = 'rgba(120,120,120,0.45)';

type Ctx = CanvasRenderingContext2D;

export interface NucRegLaneOptions {
  /** Top of the read row's drawn body and its height (rowHeight - rowGap). */
  y: number;
  bodyH: number;
  linkedOffset: number;
  regionWidth: number;
  toX: (rel: number) => number;
  /** The lane fills the whole row (no footprints under it). */
  full: boolean;
  /** Canvas px per drawn colour step (default 3). */
  pxStep?: number;
}

/** The lane's strip in a row whose drawn body is [y, y + bodyH): its top ~55 % (at least 2 px), or all of it. */
export function nucRegLaneGeometry(y: number, bodyH: number, full: boolean): { y: number; h: number } | null {
  if (!Number.isFinite(bodyH) || bodyH < 1) return null;
  if (full || bodyH < 4) return { y, h: bodyH };
  return { y, h: Math.max(2, Math.round(bodyH * 0.55)) };
}

const LEVELS = 96;
const colorCache: string[] = [];
function levelColor(t: number): string {
  const k = Math.max(0, Math.min(LEVELS, Math.round(t * LEVELS)));
  return colorCache[k] ??= nucRegRampColor(k / LEVELS);
}

/** Draw the lane; returns the number of tiles it covers. */
export function drawNucRegLane(ctx: Ctx, rows: NucRegRows, o: NucRegLaneOptions): number {
  const lane = nucRegLaneGeometry(o.y, o.bodyH, o.full);
  if (!lane || !rows.tiles.length) return 0;
  const first = rows.tiles[0], last = rows.tiles[rows.tiles.length - 1];
  const a = Math.max(0, Math.min(first.start, rows.reach[0]) + o.linkedOffset);
  const b = Math.min(o.regionWidth, Math.max(last.end, rows.reach[1]) + o.linkedOffset);
  if (b <= a) return 0;
  const xa = o.toX(a), xb = o.toX(b);
  const left = Math.min(xa, xb), right = Math.max(xa, xb);
  const bpPerPx = (b - a) / Math.max(1e-9, right - left);
  const reversed = xb < xa;
  const step = Math.max(1, o.pxStep ?? 3);
  ctx.save();
  ctx.globalAlpha = 1;
  let runX = -1, runColor = '';
  let k = 0;
  const flush = (x: number) => {
    if (runX >= 0 && x > runX) {
      ctx.fillStyle = runColor;
      ctx.fillRect(runX, lane.y, x - runX, lane.h);
    }
    runX = -1;
  };
  for (let x = left; x < right; x += step) {
    const mid = Math.min(right, x + step / 2);
    const rel = reversed ? b - (mid - left) * bpPerPx : a + (mid - left) * bpPerPx;
    const pos = rel - o.linkedOffset;
    const score = nucRegScoreAt(rows, pos, true);       // against each tile's own window width (ref_delta)
    if (score === null) {
      flush(x);
      // too few calls inside the reach: a stripe every other step (hatched); beyond it nothing
      if (nucRegInReach(rows, pos) && (k++ & 1) === 0) {
        ctx.fillStyle = NUC_REG_HATCH;
        ctx.fillRect(x, lane.y, Math.max(1, step / 2), lane.h);
      }
      continue;
    }
    const color = levelColor(nucRegScaleT(score, rows.scale));
    if (runX < 0) { runX = x; runColor = color; } else if (color !== runColor) { flush(x); runX = x; runColor = color; }
  }
  flush(right);
  ctx.restore();
  return rows.tiles.length;
}
