/**
 * A profile chart: one line per group along position (metaprofiles), or a comparison (A − B, log2 A/B) drawn as a
 * line with the area above 0 in red and below in blue (RdBu ends) around a zero line. Canvas with a `drawFn`, so the
 * shared export (ChartSaveButton) gives vector SVG / PDF, PNG and the data TSV; a hover readout of every series.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartSaveButton } from './ChartSaveButton';
import { formatGenomic, formatRelativeBp, formatTick, niceTicks } from '../../utils/niceTicks';

export interface ProfileSeries {
  id: string;
  label: string;
  color: string;
  values: (number | null)[];
  /** A dash pattern (datasets within one colour, readable in print and greyscale); solid when absent. */
  dash?: number[];
}

/** Dash patterns told apart in print and greyscale: solid, long dash, dotted, dash-dot, then repeat. */
export const SERIES_DASHES: number[][] = [[], [7, 3], [2, 2.5], [8, 3, 2, 3]];

export interface ProfileLinesChartProps {
  series: ProfileSeries[];
  /** Genomic position of the first bin's start (0-based) and the bin width (bp). */
  start: number;
  binBp: number;
  width: number;
  height: number;
  title?: string;
  subtitle?: string;
  yLabel: string;
  /** Comparison: signed values around 0, filled red above and blue below. */
  signed?: boolean;
  /** y range; null: from the data (signed: symmetric). */
  yRange?: [number, number] | null;
  filename: string;
  dataTsv?: () => string;
  dark?: boolean;
  testId?: string;
  onPositionClick?: (pos: number) => void;
  /** The x axis is footprint size, not position (size histograms): bin starts as sizes, this label. */
  xLabel?: string;
  /** The three x tick labels (left, middle, right) instead of numbers (scale-regions). */
  xTicks?: [string, string, string];
  /** x of each value when they are not evenly spaced (supplied series: e.g. spectral periods); else bins from start. */
  xs?: number[];
  /** Vertical dashed guide lines at these x values (in the axis' units: bp from start, or xs units). */
  guides?: number[];
}

const LEFT = 46;
const RIGHT = 10;
const POS = '#b2182b';  // RdBu red end
const NEG = '#2166ac';  // RdBu blue end

function layout(w: number, h: number, title: boolean, subtitle: boolean, legend: boolean | number) {
  const top = (title ? 16 : 6) + (subtitle ? 12 : 0) + (legend === true ? 14 : typeof legend === 'number' ? legend * 13 + 1 : 0);
  return { top, plotW: Math.max(10, w - LEFT - RIGHT), plotH: Math.max(10, h - top - 30) };
}

export function profileRange(series: ProfileSeries[], signed = false): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.values) if (v != null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return signed ? [-1, 1] : [0, 1];
  if (signed) { const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-9); return [-m, m]; }
  if (lo >= 0) lo = 0;
  if (hi <= lo) hi = lo + 1;
  return [lo, hi + (hi - lo) * 0.05];
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));

export function drawProfileLines(ctx: CanvasRenderingContext2D, w: number, h: number, p: ProfileLinesChartProps): void {
  const { series, start, binBp, title, subtitle, dark = false, signed = false } = p;
  ctx.fillStyle = dark ? '#1f1f1e' : '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const ink = dark ? '#c3c2b7' : '#52514e';
  const legend = series.length > 1;
  // The legend wraps onto as many rows as it needs (no entry is ever dropped).
  ctx.font = '9px sans-serif';
  const rows: Array<Array<{ s: ProfileSeries; x: number }>> = [[]];
  if (legend) {
    let x = LEFT;
    for (const s of series) {
      const wEntry = 26 + ctx.measureText(s.label).width;
      if (x + wEntry > w - RIGHT && rows[rows.length - 1].length) { rows.push([]); x = LEFT; }
      rows[rows.length - 1].push({ s, x });
      x += wEntry;
    }
  }
  const { top, plotW, plotH } = layout(w, h, !!title, !!subtitle, legend ? rows.length : false);
  if (title) { ctx.fillStyle = dark ? '#f0efec' : '#1f1f1e'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(title, LEFT, 12); }
  if (subtitle) { ctx.fillStyle = ink; ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(subtitle, LEFT, title ? 24 : 12); }
  if (legend) {
    const y0 = (title ? 16 : 6) + (subtitle ? 12 : 0) + 9;
    ctx.font = '9px sans-serif';
    rows.forEach((row, ri) => {
      const y = y0 + ri * 13;
      for (const { s, x } of row) {
        ctx.save();
        ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.setLineDash(s.dash ?? []);
        ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 16, y - 5); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.fillText(s.label, x + 19, y - 3);
      }
    });
  }
  const [lo, hi] = p.yRange ?? profileRange(series, signed);
  const n = series[0]?.values.length ?? 0;
  const xs = p.xs && p.xs.length === n && n > 1 ? p.xs : null;
  const xLo = xs ? Math.min(...xs) : 0, xHi = xs ? Math.max(...xs) : 1;
  const xOf = (i: number) => (xs ? LEFT + ((xs[i] - xLo) / (xHi - xLo || 1)) * plotW : LEFT + ((i + 0.5) / Math.max(1, n)) * plotW);
  const yOf = (v: number) => top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  // Axes and grid.
  ctx.strokeStyle = dark ? 'rgba(240,239,236,0.15)' : 'rgba(31,31,30,0.12)';
  ctx.lineWidth = 1;
  ctx.font = '9px sans-serif'; ctx.fillStyle = ink; ctx.textAlign = 'right';
  const yt = niceTicks(lo, hi, plotH, 45);
  for (const v of yt.major) {
    const y = yOf(v);
    ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(LEFT + plotW, y); ctx.stroke();
    ctx.fillText(formatTick(v, yt.step), LEFT - 3, y + 3);
  }
  ctx.save(); ctx.translate(9, top + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(p.yLabel, 0, 0); ctx.restore();
  const end = start + n * binBp;
  const axisY = top + plotH + 12;
  const sizes = Boolean(p.xLabel);
  if (p.xTicks) {
    const ticks = p.xTicks;
    ctx.textAlign = 'left'; ctx.fillText(ticks[0], LEFT, axisY);
    ctx.textAlign = 'center'; ctx.fillText(ticks[1], LEFT + plotW / 2, axisY);
    ctx.textAlign = 'right'; ctx.fillText(ticks[2], LEFT + plotW, axisY);
  } else {
    drawXTicks(ctx, { lo: xs ? xLo : start, hi: xs ? xHi : end, left: LEFT, width: plotW, y: top + plotH, ink,
      kind: xs || sizes ? 'value' : start < 0 ? 'relative' : 'genomic' });
  }
  ctx.textAlign = 'center'; ctx.fillText(p.xLabel ?? `Position (${binBp} bp bins)`, LEFT + plotW / 2, axisY + 11);
  if (signed) {
    const y0 = yOf(0);
    ctx.strokeStyle = dark ? 'rgba(240,239,236,0.55)' : 'rgba(31,31,30,0.5)';
    ctx.beginPath(); ctx.moveTo(LEFT, y0); ctx.lineTo(LEFT + plotW, y0); ctx.stroke();
    for (const s of series) {
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v == null || !Number.isFinite(v)) continue;
        ctx.fillStyle = v >= 0 ? POS : NEG;
        ctx.globalAlpha = 0.35;
        const x0 = xs ? (i > 0 ? (xOf(i - 1) + xOf(i)) / 2 : xOf(i)) : LEFT + (i / n) * plotW;
        const x1 = xs ? (i < n - 1 ? (xOf(i) + xOf(i + 1)) / 2 : xOf(i)) : LEFT + ((i + 1) / n) * plotW;
        ctx.fillRect(x0, Math.min(y0, yOf(v)), Math.max(0.5, x1 - x0), Math.abs(yOf(v) - y0));
        ctx.globalAlpha = 1;
      }
    }
  }
  if (p.guides?.length) {
    ctx.save();
    ctx.strokeStyle = dark ? 'rgba(240,239,236,0.45)' : 'rgba(31,31,30,0.4)';
    ctx.setLineDash([3, 3]);
    for (const g of p.guides) {
      const x = xs ? LEFT + ((g - xLo) / (xHi - xLo || 1)) * plotW : LEFT + ((g - start) / Math.max(1e-9, n * binBp)) * plotW;
      if (x < LEFT || x > LEFT + plotW) continue;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
    }
    ctx.restore();
  }
  for (const s of series) {
    ctx.strokeStyle = signed ? (dark ? '#f0efec' : '#1f1f1e') : s.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(s.dash ?? []);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v == null || !Number.isFinite(v)) { pen = false; continue; }
      if (!pen) { ctx.moveTo(xOf(i), yOf(v)); pen = true; } else ctx.lineTo(xOf(i), yOf(v));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function ProfileLinesChart(props: ProfileLinesChartProps) {
  const { width, height, filename, dataTsv, testId } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => drawProfileLines(ctx, w, h, props),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.series, props.start, props.binBp, props.title, props.subtitle, props.yLabel, props.signed, props.yRange, props.dark, props.xLabel, props.xTicks, props.xs, props.guides]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFn(ctx, width, height);
  }, [drawFn, width, height]);
  const binAt = (clientX: number, rect: DOMRect) => {
    const n = props.series[0]?.values.length ?? 0;
    const { plotW } = layout(width, height, !!props.title, !!props.subtitle, props.series.length > 1);
    const x = clientX - rect.left;
    if (!n || x < LEFT || x >= LEFT + plotW) return -1;
    const xs = props.xs && props.xs.length === n && n > 1 ? props.xs : null;
    if (xs) {
      // Nearest value by its x.
      const lo = Math.min(...xs), hi = Math.max(...xs), v = lo + ((x - LEFT) / plotW) * (hi - lo);
      let best = 0;
      for (let i = 1; i < n; i++) if (Math.abs(xs[i] - v) < Math.abs(xs[best] - v)) best = i;
      return best;
    }
    return Math.min(n - 1, Math.floor(((x - LEFT) / plotW) * n));
  };
  return (
    <div className="group relative" data-testid={testId ?? 'profile-lines-chart'}>
      <canvas ref={canvasRef} style={{ width, height, cursor: props.onPositionClick ? 'pointer' : undefined }}
        onMouseMove={e => {
          const rect = e.currentTarget.getBoundingClientRect();
          const i = binAt(e.clientX, rect);
          if (i < 0) { setHover(null); return; }
          const pos = props.start + i * props.binBp + (props.xLabel ? 0 : 1);
          const vals = props.series.map(s => `${s.label} ${s.values[i] == null ? '—' : fmt(s.values[i] as number)}`).join(' · ');
          const at = props.xs ? `${+props.xs[i].toPrecision(6)}` : props.xLabel ? `${pos}–${pos + props.binBp - 1} bp` : pos.toLocaleString();
          setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: `${at}: ${vals}` });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={props.onPositionClick ? e => {
          const i = binAt(e.clientX, e.currentTarget.getBoundingClientRect());
          if (i >= 0) props.onPositionClick!(Math.round(props.start + (i + 0.5) * props.binBp));
        } : undefined} />
      {hover && (
        <div className="pointer-events-none absolute z-20 max-w-[420px] truncate rounded bg-gray-900/90 px-1.5 py-0.5 text-[10px] text-white"
          style={{ left: Math.min(hover.x + 10, Math.max(0, width - 300)), top: Math.max(0, hover.y - 22) }} data-testid="profile-hover">{hover.text}</div>
      )}
      <ChartSaveButton canvasRef={canvasRef} filename={filename} drawFn={drawFn} width={width} height={height} dataTsv={dataTsv} />
    </div>
  );
}

/** Nice x ticks under a plot (utils/niceTicks): majors labelled, minors as short marks; the end labels kept inside. */
export function drawXTicks(ctx: CanvasRenderingContext2D, o: { lo: number; hi: number; left: number; width: number; y: number; ink: string; kind: 'value' | 'relative' | 'genomic'; targetPx?: number }): void {
  const t = niceTicks(o.lo, o.hi, o.width, o.targetPx ?? 70);
  const X = (v: number) => o.left + ((v - o.lo) / (o.hi - o.lo || 1)) * o.width;
  const label = (v: number) => (o.kind === 'relative' ? formatRelativeBp(v, t.step) : o.kind === 'genomic' ? formatGenomic(v, t.step) : formatTick(v, t.step));
  ctx.save();
  ctx.strokeStyle = o.ink; ctx.lineWidth = 0.6; ctx.fillStyle = o.ink; ctx.font = '9px sans-serif';
  for (const v of t.minor) { const x = X(v); ctx.beginPath(); ctx.moveTo(x, o.y); ctx.lineTo(x, o.y + 2); ctx.stroke(); }
  // Labels never overlap: one that would touch the last drawn is left out (its tick mark stays).
  let lastRight = -Infinity;
  for (const v of t.major) {
    const x = X(v);
    ctx.beginPath(); ctx.moveTo(x, o.y); ctx.lineTo(x, o.y + 4); ctx.stroke();
    const text = label(v);
    const w = ctx.measureText(text).width;
    const lx = Math.min(o.left + o.width - w, Math.max(o.left - 2, x - w / 2));
    if (lx < lastRight + 6) continue;
    ctx.textAlign = 'left';
    ctx.fillText(text, lx, o.y + 12);
    lastRight = lx + w;
  }
  ctx.restore();
}
