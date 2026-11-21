/**
 * The regularity-patch lane of a read row (FiberHMM `nucpatch`, utils/nucLayers.ts): one bar per patch, coloured by
 * the shared geometry it belongs to (folded geometries take their parent's colour; high-regularity geometries in warm
 * hues, low-regularity ones in cool hues; red / navy: a high / low patch in no geometry). With focused geometries
 * (`focused`: `${kind}:${root}` keys) the other patches dim and the focused ones get a dark underline. The bar
 * sits on the lower edge of the regularity strip (or the top of the row without it); open ends are drawn as a
 * notch so a patch cut by the read end reads as open. fillRect only (figure export stays vector).
 */
import { nucPatchColor, type NucPatch } from '../../../utils/nucLayers';

type Ctx = CanvasRenderingContext2D;

export interface NucPatchLaneOptions {
  y: number;
  bodyH: number;
  linkedOffset: number;
  regionWidth: number;
  toX: (rel: number) => number;
  /** The regularity strip is drawn above (the bar goes to its lower edge). */
  withRegLane: boolean;
  /** Focused geometries (`${kind}:${root}`); empty or absent: none. */
  focused?: ReadonlySet<string>;
}

export function nucPatchLaneGeometry(y: number, bodyH: number, withRegLane: boolean): { y: number; h: number } | null {
  if (!Number.isFinite(bodyH) || bodyH < 1) return null;
  const h = Math.max(1, Math.min(4, Math.round(bodyH * 0.3)));
  if (!withRegLane || bodyH < 4) return { y, h };
  const reg = Math.max(2, Math.round(bodyH * 0.55));
  return { y: y + Math.max(0, reg - h), h };
}

/** The open-end notch row: above the bar when that is still inside the row, else just below it; null when neither fits. */
export function notchY(lane: { y: number; h: number }, rowY: number, bodyH: number): number | null {
  if (lane.y - 1 >= rowY) return lane.y - 1;
  if (lane.y + lane.h < rowY + bodyH) return lane.y + lane.h;
  return null;
}

/** Draw the lane; returns the number of patches drawn. */
export function drawNucPatchLane(ctx: Ctx, patches: NucPatch[], o: NucPatchLaneOptions): number {
  const lane = nucPatchLaneGeometry(o.y, o.bodyH, o.withRegLane);
  if (!lane || !patches.length) return 0;
  let n = 0;
  ctx.save();
  ctx.globalAlpha = 1;
  for (const p of patches) {
    const a0 = p.start + o.linkedOffset, b0 = p.end + o.linkedOffset;
    const a = Math.max(0, a0), b = Math.min(o.regionWidth, b0);
    if (b <= a) continue;
    const xa = o.toX(a), xb = o.toX(b);
    const left = Math.min(xa, xb), w = Math.max(1, Math.abs(xb - xa));
    const focus = o.focused && o.focused.size > 0;
    const on = focus && p.root > 0 && o.focused!.has(`${p.kind}:${p.root}`);
    ctx.globalAlpha = focus && !on ? 0.22 : 1;
    ctx.fillStyle = nucPatchColor(p);
    ctx.fillRect(left, lane.y, w, lane.h);
    if (on) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(left, lane.y + lane.h, w, 1);
      ctx.fillStyle = nucPatchColor(p);
    }
    // A 2 px notch at an open end: only where that end is drawn (an end cut by the view is not the read's end),
    // and inside the row (above the bar on the regularity strip, else just below it).
    const reversed = xb < xa;
    const ny = notchY(lane, o.y, o.bodyH);
    if (ny != null) {
      if (p.openStart && a0 >= 0) ctx.fillRect(reversed ? left + w - 2 : left, ny, 2, 1);
      if (p.openEnd && b0 <= o.regionWidth) ctx.fillRect(reversed ? left : left + w - 2, ny, 2, 1);
    }
    n += 1;
  }
  ctx.restore();
  return n;
}
