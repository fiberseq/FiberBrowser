import type { LiveLiftInsertion } from './types';
import type { LiftAxis } from '../../../features/liveLift/axis';
import { MOD_COLORS } from './constants';
import { getLayerColor } from '../../../utils/layerColors';

/** Insertion-local coordinates are in display order already, including minus
 * rows. Only the *panel's* reversed axis is applied here; mirroring the payload
 * a second time would move every footprint to the wrong end of the molecule. */
export function insertionPayloadRects(payload: LiveLiftInsertion, id: string, axis: LiftAxis, sidebar = 0) {
  const x = (p: number) => sidebar + axis.toX(0, { ins_id: id, offset: p });
  return payload.intervals.filter(i => i[2] > 0).flatMap(([a, b, size]) => {
    const lo = Math.max(a, payload.covered[0]), hi = Math.min(b, payload.covered[1]);
    return hi <= lo ? [] : [{ x: Math.min(x(lo), x(hi)), w: Math.abs(x(hi) - x(lo)), size }];
  });
}

export function drawInsertionPayload(ctx: CanvasRenderingContext2D, payload: LiveLiftInsertion, id: string,
  axis: LiftAxis, options: { y: number; h: number; sidebar: number; background: string;
    enabled: Record<string, boolean>; layerColors?: Record<string, string>;
    color: (a: number, b: number, size: number, layer?: string) => string }): number {
  const { y, h, sidebar, enabled } = options;
  const x = (p: number) => sidebar + axis.toX(0, { ins_id: id, offset: p });
  const a = x(payload.covered[0]), b = x(payload.covered[1]);
  ctx.save();
  ctx.beginPath(); ctx.rect(Math.min(a, b), y, Math.abs(b - a), h); ctx.clip();
  ctx.fillStyle = options.background;
  ctx.fillRect(Math.min(a, b), y, Math.abs(b - a), h);
  let calls = 0;
  const intervals = (items: [number, number, number][], layer: string, primary = false) => {
    if (enabled[layer === 'msp' ? 'fire' : layer] === false) return;
    for (const [lo, hi, size] of items) {
      if (size <= 0 || hi <= payload.covered[0] || lo >= payload.covered[1]) continue;
      const p = x(Math.max(lo, payload.covered[0])), q = x(Math.min(hi, payload.covered[1]));
      ctx.fillStyle = primary ? options.color(lo, hi, size, layer) : options.layerColors?.[layer] ?? getLayerColor(layer);
      ctx.fillRect(Math.min(p, q), y, Math.max(1, Math.abs(q - p)), h); calls++;
    }
  };
  intervals(payload.layers?.nuc?.intervals ?? payload.intervals, payload.layers?.nuc ? 'nuc' : 'footprint', true);
  for (const [name, layer] of Object.entries(payload.layers ?? {})) {
    if (name !== 'nuc' && name !== 'footprint') intervals(layer.intervals, name);
  }
  if (payload.fire && !payload.layers?.fire) intervals(payload.fire, 'fire');
  const points = (ps: number[] | undefined, color: string, top = 0, height = h) => {
    ctx.fillStyle = color;
    for (const p of ps ?? []) {
      if (p < payload.covered[0] || p >= payload.covered[1]) continue;
      ctx.fillRect(x(p) - .5, y + top, Math.max(1, axis.pxPerBp * .8), height);
    }
  };
  if (enabled.m6a !== false && enabled.mod !== false) points(payload.methyl_m6a, MOD_COLORS.m6a);
  if (enabled.m5c) points(payload.methyl_m5c, MOD_COLORS.m5c);
  if (enabled.deam) for (const [p, kind] of payload.deam ?? []) points([p], kind === 1 ? MOD_COLORS.deam_y : MOD_COLORS.deam_r);
  if (enabled.possible_deam_ct) points(payload.possible_deam_ct, MOD_COLORS.deam_possible_ct, 0, Math.min(2, h));
  if (enabled.possible_deam_ga) points(payload.possible_deam_ga, MOD_COLORS.deam_possible_ga, Math.max(0, h - 2), Math.min(2, h));
  ctx.restore();
  return calls;
}
