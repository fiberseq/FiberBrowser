/**
 * A rows × position heatmap (Plots: reads × position over the view, features × position for selected features or,
 * later, BED regions): rows in blocks (one per group, labelled with its colour at the left), cells coloured on a
 * sequential map (magma by default) from 0, or on RdBu_r centred on 0 for comparisons. Canvas with a `drawFn` (vector
 * export via ChartSaveButton), a colour bar, and a hover readout of row and value; a click reports the row and position.
 * `square`: position × position matrices (co-accessibility), each block a square of 1:1 cells, never stretched.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartSaveButton } from './ChartSaveButton';
import { drawXTicks } from './ProfileLinesChart';
import { formatTick, niceTicks } from '../../utils/niceTicks';
import { colormapRgb, type FootprintSizeColormap } from '../../utils/footprintSizeColormaps';

export interface HeatmapBlock {
  id: string;
  title: string;
  color?: string;
  rows: Array<{ label: string; values: (number | null)[] }>;
}

export interface HeatmapRowsChartProps {
  blocks: HeatmapBlock[];
  /** First bin's start on the x axis and the bin width (bp); `relative`: positions around a centre (features). */
  start: number;
  binBp: number;
  relative?: boolean;
  width: number;
  height: number;
  title?: string;
  subtitle?: string;
  valueLabel: string;
  colormap: FootprintSizeColormap;
  reverse?: boolean;
  /** Comparison: values centred on 0 (symmetric range). */
  signed?: boolean;
  /** Colour range; null: 0..max (or symmetric for signed). */
  range?: [number, number] | null;
  filename: string;
  dataTsv?: () => string;
  dark?: boolean;
  testId?: string;
  onCellClick?: (block: number, row: number, pos: number) => void;
  /** The three x tick labels and the axis label instead of positions (BED scale-regions, anchors). */
  xTicks?: [string, string, string];
  xLabel?: string;
  /**
   * Square matrices (co-accessibility: x and y cover the same positions): each block a square of 1:1 cells, side by side
   * on one shared scale, sized by the shorter of the available width and height, centred, the colour bar beside them.
   */
  square?: boolean;
  /** Square: genes drawn along the bottom edge (genomic coordinates; `region` is the matrix's span). */
  edgeGenes?: Array<{ start: number; end: number; name: string; strand?: string }>;
  region?: [number, number];
  /** Square: the panel shows this locus reversed (both axes run high to low). */
  reversed?: boolean;
  /** The subtitle only in exports (the page shows it as an HTML header line already). */
  subtitleInExportOnly?: boolean;
  /** The metaprofile drawn on top on the same x axis (deepTools-style profile + heatmap). */
  profile?: { lines: Array<{ id: string; title: string; color?: string; dash?: number[]; values: (number | null)[] }>; yLabel: string } | null;
}

/** The profile strip's height (with its legend row) when a profile is drawn on top. */
export const PROFILE_STRIP = 112;

function drawProfileStrip(ctx: CanvasRenderingContext2D, p: HeatmapRowsChartProps, top: number, plotW: number, ink: string, dark: boolean): void {
  const lines = p.profile?.lines ?? [];
  if (!lines.length) return;
  const h = PROFILE_STRIP - 26;
  const y0 = top + 14;
  let lo = Infinity, hi = -Infinity;
  for (const l of lines) for (const v of l.values) if (v != null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (lo > 0) lo = 0;
  if (hi <= lo) hi = lo + 1;
  ctx.strokeStyle = dark ? '#57534e' : '#d6d3d1'; ctx.lineWidth = 0.5;
  ctx.strokeRect(LEFT, y0, plotW, h);
  const n = Math.max(1, lines[0].values.length);
  const X = (i: number) => LEFT + ((i + 0.5) / n) * plotW;
  const Y = (v: number) => y0 + h - ((v - lo) / (hi - lo)) * h;
  if (lo < 0) { ctx.strokeStyle = dark ? '#78716c' : '#a8a29e'; ctx.beginPath(); ctx.moveTo(LEFT, Y(0)); ctx.lineTo(LEFT + plotW, Y(0)); ctx.stroke(); }
  for (const l of lines) {
    ctx.strokeStyle = l.color ?? ink; ctx.lineWidth = 1.4;
    ctx.setLineDash(l.dash ?? []);
    ctx.beginPath();
    let pen = false;
    l.values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) { pen = false; return; }
      if (!pen) { ctx.moveTo(X(i), Y(v)); pen = true; } else ctx.lineTo(X(i), Y(v));
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = ink; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
  const yt = niceTicks(lo, hi, h, 40);
  for (const v of yt.major) ctx.fillText(formatTick(v, yt.step), LEFT - 4, Math.min(y0 + h, Math.max(y0 + 7, Y(v) + 3)));
  ctx.save(); ctx.translate(LEFT - 30, y0 + h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(p.profile!.yLabel, 0, 0); ctx.restore();
  // Legend row above the strip.
  let x = LEFT;
  ctx.textAlign = 'left';
  for (const l of lines.slice(0, 12)) {
    const label = l.title.length > 22 ? `${l.title.slice(0, 21)}…` : l.title;
    const w = ctx.measureText(label).width + 18;
    if (x + w > LEFT + plotW) break;
    ctx.strokeStyle = l.color ?? ink; ctx.lineWidth = 2; ctx.setLineDash(l.dash ?? []);
    ctx.beginPath(); ctx.moveTo(x, top + 6); ctx.lineTo(x + 12, top + 6); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = ink; ctx.fillText(label, x + 14, top + 9);
    x += w;
  }
}

const LEFT = 92;
const RIGHT = 46;
const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));

export function heatmapRange(blocks: HeatmapBlock[], signed = false): [number, number] {
  let hi = 0;
  const vals: number[] = [];
  for (const b of blocks) for (const r of b.rows) for (const v of r.values) if (v != null && Number.isFinite(v)) vals.push(signed ? Math.abs(v) : v);
  if (vals.length) {
    vals.sort((a, b) => a - b);
    hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))];
  }
  if (!(hi > 0)) hi = 1;
  return signed ? [-hi, hi] : [0, hi];
}

const SQ_GAP = 14;
const SQ_BAR = 52;
const SQ_LEFT = 14;

/** Square layout: the side of each block's square, the x of each square, and the top of the squares. */
export function squareGeometry(p: Pick<HeatmapRowsChartProps, 'blocks' | 'title' | 'subtitle'>, w: number, h: number): { side: number; xs: number[]; top: number } {
  const k = Math.max(1, p.blocks.length);
  const top = (p.title ? 16 : 6) + (p.subtitle ? 12 : 0) + 14;  // block titles above the squares
  const availW = Math.max(10, w - SQ_LEFT * 2 - SQ_BAR - SQ_GAP * (k - 1));
  const availH = Math.max(10, h - top - 30);
  const side = Math.max(10, Math.floor(Math.min(availW / k, availH)));
  const total = side * k + SQ_GAP * (k - 1) + SQ_BAR;
  const x0 = Math.max(SQ_LEFT, Math.round((w - total) / 2));
  return { side, xs: Array.from({ length: k }, (_, i) => x0 + i * (side + SQ_GAP)), top };
}

/** The height a square chart needs at this width (the side capped at `maxSide`). */
export function squareChartHeight(p: Pick<HeatmapRowsChartProps, 'blocks' | 'title' | 'subtitle'>, width: number, maxSide = 640): number {
  const k = Math.max(1, p.blocks.length);
  const top = (p.title ? 16 : 6) + (p.subtitle ? 12 : 0) + 14;
  const side = Math.max(10, Math.floor(Math.min((width - SQ_LEFT * 2 - SQ_BAR - SQ_GAP * (k - 1)) / k, maxSide)));
  return top + side + 30;
}

function drawSquare(ctx: CanvasRenderingContext2D, w: number, h: number, p: HeatmapRowsChartProps, colour: (v: number) => string, lo: number, hi: number, ink: string): void {
  const { side, xs, top } = squareGeometry(p, w, h);
  ctx.font = '9px sans-serif';
  p.blocks.forEach((block, bi) => {
    const x0 = xs[bi];
    const n = Math.max(1, block.rows.length, block.rows[0]?.values.length ?? 0);
    const cell = side / n;
    if (block.color) { ctx.fillStyle = block.color; ctx.fillRect(x0, top - 12, 4, 9); }
    ctx.fillStyle = ink; ctx.textAlign = 'left';
    const maxChars = Math.max(6, Math.floor(side / 5.2));
    ctx.fillText(block.title.length > maxChars ? `${block.title.slice(0, maxChars - 1)}…` : block.title, x0 + (block.color ? 7 : 0), top - 4);
    const flip = (k: number) => (p.reversed ? n - 1 - k : k);
    block.rows.forEach((row, i) => row.values.forEach((v, j) => {
      if (v == null || !Number.isFinite(v)) return;
      ctx.fillStyle = colour(v);
      ctx.fillRect(x0 + flip(j) * cell, top + flip(i) * cell, cell + 0.3, cell + 0.3);
    }));
    ctx.strokeStyle = ink; ctx.lineWidth = 0.5; ctx.strokeRect(x0, top, side, side);
    const end = p.start + n * p.binBp;
    // Genes along the bottom edge, inside the square (as the panel drew them): + blue, − red.
    if (p.edgeGenes?.length) {
      const [r0, r1] = p.region ?? [p.start, end];
      const span = Math.max(1, r1 - r0);
      const px = (g: number) => { const u = (Math.min(r1, Math.max(r0, g)) - r0) / span; return x0 + (p.reversed ? 1 - u : u) * side; };
      ctx.font = '8px sans-serif';
      for (const g of p.edgeGenes) {
        if (g.end <= r0 || g.start >= r1) continue;
        const a = px(g.start), b = px(g.end);
        const lo = Math.min(a, b), w2 = Math.max(1, Math.abs(b - a));
        ctx.fillStyle = g.strand === '-' ? '#dc2626' : '#2563eb';
        ctx.fillRect(lo, top + side - 4, w2, 1);
        if (w2 > 24) { ctx.textAlign = 'left'; ctx.fillText(`${(g.strand === '+') !== !!p.reversed ? '\u25B8' : '\u25C2'}${g.name}`.slice(0, Math.floor(w2 / 5)), lo + 1, top + side - 6); }
      }
      ctx.font = '9px sans-serif';
    }
    const axisY = top + side + 12;
    ctx.fillStyle = ink;
    if (p.reversed) {
      const [leftTick, rightTick] = [end.toLocaleString(), (p.start + 1).toLocaleString()];
      ctx.textAlign = 'left'; ctx.fillText(leftTick, x0, axisY);
      ctx.textAlign = 'right'; ctx.fillText(rightTick, x0 + side, axisY);
    } else {
      drawXTicks(ctx, { lo: p.start, hi: end, left: x0, width: side, y: top + side, ink, kind: 'genomic', targetPx: 80 });
    }
    if (bi === 0) { ctx.textAlign = 'center'; ctx.fillText(p.xLabel ?? `Position (${p.binBp} bp bins)`, x0 + side / 2, axisY + 11); }
  });
  // The colour bar beside the last square, as tall as the squares.
  const bx = xs[xs.length - 1] + side + 8;
  const steps = Math.max(2, Math.round(side));
  for (let i = 0; i < steps; i++) {
    const v = hi - ((hi - lo) * i) / (steps - 1);
    ctx.fillStyle = colour(v);
    ctx.fillRect(bx, top + (i * side) / steps, 8, side / steps + 0.5);
  }
  ctx.fillStyle = ink; ctx.textAlign = 'left';
  ctx.fillText(`${p.signed && hi > 0 ? '+' : ''}${fmt(hi)}`, bx + 10, top + 7);
  if (p.signed) ctx.fillText('0', bx + 10, top + side / 2 + 3);
  ctx.fillText(fmt(lo), bx + 10, top + side);
}

function geometry(p: HeatmapRowsChartProps, w: number, h: number) {
  const head = (p.title ? 16 : 6) + (p.subtitle ? 12 : 0);
  const top = head + (p.profile?.lines.length ? PROFILE_STRIP : 0);
  const plotW = Math.max(10, w - LEFT - RIGHT);
  const plotH = Math.max(10, h - top - 30);
  const nRows = p.blocks.reduce((n, b) => n + b.rows.length, 0);
  const gap = p.blocks.length > 1 ? 3 : 0;
  const rowH = Math.max(0.2, (plotH - gap * (p.blocks.length - 1)) / Math.max(1, nRows));
  return { top, plotW, plotH, nRows, gap, rowH };
}

export function drawHeatmapRows(ctx: CanvasRenderingContext2D, w: number, h: number, p: HeatmapRowsChartProps): void {
  const dark = p.dark ?? false;
  ctx.fillStyle = dark ? '#1f1f1e' : '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const ink = dark ? '#c3c2b7' : '#52514e';
  const { top, plotW, plotH, gap, rowH } = geometry(p, w, h);
  if (p.title) { ctx.fillStyle = dark ? '#f0efec' : '#1f1f1e'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(p.title, LEFT, 12); }
  if (p.subtitle) { ctx.fillStyle = ink; ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(p.subtitle, LEFT, p.title ? 24 : 12); }
  const [lo, hi] = p.range ?? heatmapRange(p.blocks, p.signed);
  const colour = (v: number) => {
    let u = (v - lo) / (hi - lo || 1);
    if (p.reverse) u = 1 - u;
    const [r, g, b] = colormapRgb(p.colormap, u);
    return `rgb(${r},${g},${b})`;
  };
  if (p.square) { drawSquare(ctx, w, h, p, colour, lo, hi, ink); return; }
  if (p.profile?.lines.length) drawProfileStrip(ctx, p, top - PROFILE_STRIP, plotW, ink, dark);
  const n = p.blocks[0]?.rows[0]?.values.length ?? 0;
  const cw = plotW / Math.max(1, n);
  let y = top;
  ctx.font = '9px sans-serif';
  for (const block of p.blocks) {
    const bh = block.rows.length * rowH;
    if (block.color) { ctx.fillStyle = block.color; ctx.fillRect(LEFT - 6, y, 4, Math.max(1, bh)); }
    ctx.fillStyle = ink; ctx.textAlign = 'right';
    ctx.fillText(block.title.length > 14 ? `${block.title.slice(0, 13)}…` : block.title, LEFT - 9, y + Math.min(bh, 12) - 2);
    if (bh > 22) ctx.fillText(`${block.rows.length} rows`, LEFT - 9, y + 22);
    block.rows.forEach((row, i) => {
      const ry = y + i * rowH;
      row.values.forEach((v, j) => {
        if (v == null || !Number.isFinite(v)) return;
        ctx.fillStyle = colour(v);
        ctx.fillRect(LEFT + j * cw, ry, Math.ceil(cw) + 0.3, Math.max(0.6, rowH + 0.3));
      });
    });
    y += bh + gap;
  }
  // x axis.
  const end = p.start + n * p.binBp;
  const label = (x: number) => (p.relative ? `${x > 0 ? '+' : ''}${Math.round(x).toLocaleString()}` : (Math.round(x) + 1).toLocaleString());
  const axisY = top + plotH + 12;
  ctx.fillStyle = ink;
  if (p.xTicks) {
    const ticks = p.xTicks;
    ctx.textAlign = 'left'; ctx.fillText(ticks[0], LEFT, axisY);
    ctx.textAlign = 'center'; ctx.fillText(ticks[1], LEFT + plotW / 2, axisY);
    ctx.textAlign = 'right'; ctx.fillText(ticks[2], LEFT + plotW, axisY);
  } else {
    void label;
    drawXTicks(ctx, { lo: p.start, hi: end, left: LEFT, width: plotW, y: top + plotH, ink, kind: p.relative ? 'relative' : 'genomic' });
  }
  ctx.textAlign = 'center'; ctx.fillText(p.xLabel ?? (p.relative ? `bp from the feature centre (${p.binBp} bp bins)` : `Position (${p.binBp} bp bins)`), LEFT + plotW / 2, axisY + 11);
  // Colour bar.
  const bx = LEFT + plotW + 6;
  const steps = Math.max(2, Math.round(plotH));
  for (let i = 0; i < steps; i++) {
    const v = hi - ((hi - lo) * i) / (steps - 1);
    ctx.fillStyle = colour(v);
    ctx.fillRect(bx, top + (i * plotH) / steps, 8, plotH / steps + 0.5);
  }
  ctx.fillStyle = ink; ctx.textAlign = 'left';
  const ct = niceTicks(lo, hi, plotH, 40);
  for (const v of ct.major) ctx.fillText(`${p.signed && v > 0 ? '+' : ''}${formatTick(v, ct.step)}`, bx + 10, Math.min(top + plotH, Math.max(top + 7, top + plotH - ((v - lo) / (hi - lo || 1)) * plotH + 3)));
}

export function HeatmapRowsChart(props: HeatmapRowsChartProps) {
  const { width, height, filename, dataTsv, testId } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => drawHeatmapRows(ctx, w, h, props),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.blocks, props.start, props.binBp, props.title, props.subtitle, props.colormap, props.reverse, props.signed, props.range, props.dark, props.relative, props.xTicks, props.xLabel, props.square, props.edgeGenes, props.region, props.reversed, props.profile]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (props.subtitleInExportOnly) drawHeatmapRows(ctx, width, height, { ...props, subtitle: undefined });
    else drawFn(ctx, width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawFn, width, height, props.subtitleInExportOnly]);
  const cellAt = (clientX: number, clientY: number, rect: DOMRect) => {
    const x = clientX - rect.left, y = clientY - rect.top;
    if (props.square) {
      const sq = squareGeometry(props.subtitleInExportOnly ? { ...props, subtitle: undefined } : props, width, height);
      const b = sq.xs.findIndex(x0 => x >= x0 && x < x0 + sq.side);
      if (b < 0 || y < sq.top || y >= sq.top + sq.side) return null;
      const n = Math.max(1, props.blocks[b].rows.length);
      const f = (k: number) => (props.reversed ? n - 1 - k : k);
      return { b, r: f(Math.floor(((y - sq.top) / sq.side) * n)), c: f(Math.floor(((x - sq.xs[b]) / sq.side) * n)) };
    }
    const { top, plotW, gap, rowH } = geometry(props.subtitleInExportOnly ? { ...props, subtitle: undefined } : props, width, height);
    const n = props.blocks[0]?.rows[0]?.values.length ?? 0;
    if (!n || x < LEFT || x >= LEFT + plotW || y < top) return null;
    let yy = top;
    for (let b = 0; b < props.blocks.length; b++) {
      const bh = props.blocks[b].rows.length * rowH;
      if (y < yy + bh) {
        const r = Math.floor((y - yy) / rowH);
        const c = Math.min(n - 1, Math.floor(((x - LEFT) / plotW) * n));
        return { b, r, c };
      }
      yy += bh + gap;
    }
    return null;
  };
  return (
    <div className="group relative" data-testid={testId ?? 'heatmap-rows-chart'}>
      <canvas ref={canvasRef} style={{ width, height, cursor: props.onCellClick ? 'pointer' : undefined }}
        onMouseMove={e => {
          const rect = e.currentTarget.getBoundingClientRect();
          const cell = cellAt(e.clientX, e.clientY, rect);
          if (!cell) { setHover(null); return; }
          const row = props.blocks[cell.b].rows[cell.r];
          const v = row?.values[cell.c];
          const pos = props.start + cell.c * props.binBp;
          setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top,
            text: `${props.blocks[cell.b].title} · ${row?.label ?? ''} · ${props.relative ? `${pos > 0 ? '+' : ''}${pos}` : (pos + 1).toLocaleString()}: ${v == null ? '—' : `${props.valueLabel} ${fmt(v)}`}` });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={props.onCellClick ? e => {
          const cell = cellAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
          if (cell) props.onCellClick!(cell.b, cell.r, Math.round(props.start + (cell.c + 0.5) * props.binBp));
        } : undefined} />
      {hover && (
        <div className="pointer-events-none absolute z-20 max-w-[420px] truncate rounded bg-gray-900/90 px-1.5 py-0.5 text-[10px] text-white"
          style={{ left: Math.min(hover.x + 10, Math.max(0, width - 300)), top: Math.max(0, hover.y - 22) }} data-testid="heatmap-hover">{hover.text}</div>
      )}
      <ChartSaveButton canvasRef={canvasRef} filename={filename} drawFn={drawFn} width={width} height={height} dataTsv={dataTsv} />
    </div>
  );
}
