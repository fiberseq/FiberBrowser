/**
 * Volcano and MA plots of differential features, drawn on a canvas (the live plot, the Gallery thumbnail and the
 * exports use the same function). Colours follow the comparative rule (RdBu centred on 0): red = higher in A, blue =
 * higher in B, grey = not called. Shapes repeat the call for print and greyscale: up = filled circle, down = filled
 * square, not called = small hollow circle.
 */
import { formatTick, niceTicks } from '../../utils/niceTicks';
import { callOf, negLog10Q, Q_CAP, type DiffCall, type DiffRow } from './differentialData';

export const CALL_COLOURS: Record<DiffCall, string> = { up: '#b8302f', down: '#1c5cab', ns: '#9a9893', untested: '#c9c7c1' };

export interface DiffPoint { key: string; x: number; y: number; call: DiffCall }

export interface DiffChartOptions {
  width: number;
  height: number;
  qMax: number;
  deltaMin: number;
  dark?: boolean;
  title?: string;
  /** Keys drawn with a ring (the shared selection). */
  selected?: ReadonlySet<string>;
  /** The key under the pointer. */
  hover?: string | null;
}

const PAD = { l: 44, r: 10, t: 22, b: 34 };


function frame(ctx: CanvasRenderingContext2D, o: DiffChartOptions, xr: [number, number], yr: [number, number], xLabel: string, yLabel: string) {
  const { width: w, height: h, dark } = o;
  const ink = dark ? '#e6e4df' : '#3d3d3a', grid = dark ? 'rgba(255,255,255,0.08)' : '#eeede9';
  ctx.fillStyle = dark ? '#1f1f1e' : '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const X = (v: number) => PAD.l + ((v - xr[0]) / (xr[1] - xr[0] || 1)) * (w - PAD.l - PAD.r);
  const Y = (v: number) => h - PAD.b - ((v - yr[0]) / (yr[1] - yr[0] || 1)) * (h - PAD.t - PAD.b);
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  const xt = niceTicks(xr[0], xr[1], w - PAD.l - PAD.r, 70), yt = niceTicks(yr[0], yr[1], h - PAD.t - PAD.b, 45);
  for (const t of xt.major) {
    ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(X(t), PAD.t); ctx.lineTo(X(t), h - PAD.b); ctx.stroke();
    ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.fillText(formatTick(t, xt.step), X(t), h - PAD.b + 12);
  }
  for (const t of yt.major) {
    ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(PAD.l, Y(t)); ctx.lineTo(w - PAD.r, Y(t)); ctx.stroke();
    ctx.fillStyle = ink; ctx.textAlign = 'right'; ctx.fillText(formatTick(t, yt.step), PAD.l - 4, Y(t) + 3);
  }
  ctx.strokeStyle = ink;
  ctx.strokeRect(PAD.l + 0.5, PAD.t + 0.5, w - PAD.l - PAD.r - 1, h - PAD.t - PAD.b - 1);
  ctx.fillStyle = ink; ctx.textAlign = 'center';
  ctx.fillText(xLabel, PAD.l + (w - PAD.l - PAD.r) / 2, h - 6);
  ctx.save(); ctx.translate(11, PAD.t + (h - PAD.t - PAD.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, 0, 0); ctx.restore();
  if (o.title) { ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(o.title, PAD.l, 14); }
  return { X, Y };
}

function dashed(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, colour: string) {
  ctx.save(); ctx.strokeStyle = colour; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.restore();
}

function mark(ctx: CanvasRenderingContext2D, x: number, y: number, call: DiffCall, ring: boolean, hover: boolean, dark?: boolean) {
  const c = CALL_COLOURS[call];
  ctx.fillStyle = c; ctx.strokeStyle = c; ctx.lineWidth = 1;
  if (call === 'down') ctx.fillRect(x - 3, y - 3, 6, 6);
  else if (call === 'up') { ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill(); }
  else { ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.stroke(); }
  if (ring || hover) {
    ctx.strokeStyle = dark ? '#ffffff' : '#111111'; ctx.lineWidth = hover ? 2 : 1.4;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
  }
}

/** Volcano: delta (A − B) against −log10 q, with the q and |delta| thresholds. Returns the points (hit testing). */
export function drawVolcano(ctx: CanvasRenderingContext2D, rows: DiffRow[], o: DiffChartOptions): DiffPoint[] {
  const pts = rows.flatMap(r => {
    const y = negLog10Q(r.q);
    return r.delta != null && y ? [{ r, x: r.delta, y: y.y, capped: y.capped }] : [];
  });
  const yMax = Math.max(-Math.log10(o.qMax) * 1.3, ...pts.map(p => p.y), 1);
  const xMax = Math.max(o.deltaMin * 1.5, ...pts.map(p => Math.abs(p.x)), 0.05);
  const { X, Y } = frame(ctx, o, [-xMax * 1.05, xMax * 1.05], [0, yMax * 1.05], 'Δ fraction (A − B)', '−log10 q');
  const lineColour = o.dark ? '#8a8883' : '#7c7a75';
  dashed(ctx, PAD.l, Y(-Math.log10(o.qMax)), o.width - PAD.r, Y(-Math.log10(o.qMax)), lineColour);
  if (o.deltaMin > 0) for (const s of [-1, 1]) dashed(ctx, X(s * o.deltaMin), PAD.t, X(s * o.deltaMin), o.height - PAD.b, lineColour);
  const out: DiffPoint[] = [];
  const order = (c: DiffCall) => (c === 'ns' || c === 'untested' ? 0 : 1);
  const drawn = pts.map(p => ({ ...p, call: callOf(p.r, o.qMax, o.deltaMin) })).sort((a, b) => order(a.call) - order(b.call));
  for (const p of drawn) {
    const x = X(p.x), y = Y(p.y);
    mark(ctx, x, y, p.call, !!o.selected?.has(p.r.key), o.hover === p.r.key, o.dark);
    if (p.capped) { ctx.fillStyle = o.dark ? '#e6e4df' : '#3d3d3a'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('▲', x, y - 6); }
    out.push({ key: p.r.key, x, y, call: p.call });
  }
  if (pts.some(p => p.capped)) {
    ctx.fillStyle = o.dark ? '#e6e4df' : '#3d3d3a'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(`▲ q below 1e-${Q_CAP}`, o.width - PAD.r - 2, PAD.t + 10);
  }
  return out;
}

/** MA: the mean fraction of A and B against log2 OR (A over B), with the 0 line. */
export function drawMA(ctx: CanvasRenderingContext2D, rows: DiffRow[], o: DiffChartOptions): DiffPoint[] {
  const pts = rows.flatMap(r => (r.fracA != null && r.fracB != null && r.log2or != null ? [{ r, x: (r.fracA + r.fracB) / 2, y: r.log2or }] : []));
  const yMax = Math.max(1, ...pts.map(p => Math.abs(p.y)));
  const { X, Y } = frame(ctx, o, [0, 1], [-yMax * 1.05, yMax * 1.05], 'Mean fraction (A + B) / 2', 'log2 OR (A / B)');
  dashed(ctx, PAD.l, Y(0), o.width - PAD.r, Y(0), o.dark ? '#8a8883' : '#7c7a75');
  const out: DiffPoint[] = [];
  const order = (c: DiffCall) => (c === 'ns' || c === 'untested' ? 0 : 1);
  const drawn = pts.map(p => ({ ...p, call: callOf(p.r, o.qMax, o.deltaMin) })).sort((a, b) => order(a.call) - order(b.call));
  for (const p of drawn) {
    const x = X(p.x), y = Y(p.y);
    mark(ctx, x, y, p.call, !!o.selected?.has(p.r.key), o.hover === p.r.key, o.dark);
    out.push({ key: p.r.key, x, y, call: p.call });
  }
  return out;
}

/** The point nearest (x, y) within `radius` px, or null. */
export function nearestPoint(points: DiffPoint[], x: number, y: number, radius = 7): DiffPoint | null {
  let best: DiffPoint | null = null, bd = radius * radius;
  for (const p of points) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d <= bd) { bd = d; best = p; }
  }
  return best;
}

/** Both charts side by side with a legend (exports, thumbnails). */
export function diffFigureDraw(rows: DiffRow[], o: Omit<DiffChartOptions, 'width' | 'height'> & { chartWidth: number; chartHeight: number; heading?: string; labels: { A: string; B: string } }) {
  const gap = 10, head = o.heading ? 22 : 0, legend = 18;
  const w = o.chartWidth * 2 + gap, h = head + o.chartHeight + legend;
  const draw = (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = o.dark ? '#1f1f1e' : '#ffffff';
    ctx.fillRect(0, 0, w, h);
    if (o.heading) { ctx.fillStyle = o.dark ? '#f0efec' : '#1f1f1e'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(o.heading, 4, 15); }
    const base = { qMax: o.qMax, deltaMin: o.deltaMin, dark: o.dark, width: o.chartWidth, height: o.chartHeight, selected: o.selected };
    ctx.save(); ctx.translate(0, head); drawVolcano(ctx, rows, { ...base, title: 'Volcano' }); ctx.restore();
    ctx.save(); ctx.translate(o.chartWidth + gap, head); drawMA(ctx, rows, { ...base, title: 'MA' }); ctx.restore();
    drawLegend(ctx, 4, head + o.chartHeight + 12, o.labels, o.dark);
  };
  return { w, h, draw };
}

export function drawLegend(ctx: CanvasRenderingContext2D, x: number, y: number, labels: { A: string; B: string }, dark?: boolean) {
  const items: Array<[DiffCall, string]> = [['up', `higher in A (${labels.A})`], ['down', `higher in B (${labels.B})`], ['ns', 'not called']];
  ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
  let cx = x;
  for (const [call, text] of items) {
    mark(ctx, cx + 4, y - 3, call, false, false, dark);
    ctx.fillStyle = dark ? '#e6e4df' : '#3d3d3a';
    ctx.fillText(text, cx + 12, y);
    cx += 16 + ctx.measureText(text).width + 12;
  }
}

/** A small JPEG of the volcano (Gallery cards); '' where there is no canvas. */
export function diffThumbnail(rows: DiffRow[], qMax: number, deltaMin: number, w = 168, h = 104): string {
  if (typeof document === 'undefined') return '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    drawVolcano(ctx, rows, { width: w, height: h, qMax, deltaMin });
    const url = canvas.toDataURL('image/jpeg', 0.72);
    return url.startsWith('data:image/jpeg') ? url : '';
  } catch {
    return '';
  }
}
