import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { ChartSaveButton } from './ChartSaveButton';
import { ChartMaximizeButton } from './ChartMaximizeButton';
import { formatProfileChartTsv } from '../../utils/analysisExport';
import { domainOf, formatAxisValue, type YDomain } from '../../utils/plotSetYScale';
import { legendSignature, type PlotLegendItem } from '../../utils/plotSetLegend';

export interface ProfileSeries {
  data: number[];
  color: string;
  label: string;
  /** Optional pointwise confidence band, on the same scale as data. */
  ciLow?: number[];
  ciHigh?: number[];
  n?: number;
}

interface OverlayProfileChartProps {
  series: ProfileSeries[];
  width?: number;
  height?: number;
  showLegend?: boolean;
  filename?: string;
  isReversed?: boolean;
  /** If supplied, draws ±window / 0 ticks on the x-axis and a dashed
   *  center line. The chart is symmetric about the middle column. */
  windowBp?: number;
  /** Optional rotated y-axis title (e.g. "Pileup", "Coverage"). */
  yLabel?: string;
  /** Suppress axis chrome — falls back to the old bare polyline look.
   *  Default false: every caller gets readable ticks unless they opt out. */
  noAxes?: boolean;
  /** Optional one-line caption under the x-axis tick row. */
  caption?: string;
  /** A fixed y domain (a shared range across a set of plots); values outside it are clipped. Default: autoscale. */
  yDomain?: YDomain;
  /** A dashed reference line at this value (an enrichment baseline: 100%, ratio 1, log2 0); kept inside the domain. */
  refLine?: number;
  /** With noAxes: write the top of the y range in the plot's corner (a set of plots each on its own scale). */
  cornerMax?: boolean;
  /** What the values are (written into the TSV export's header). */
  valueLabel?: string;
  /** The full legend of the set this chart belongs to (utils/plotSetLegend): drawn instead of the series' own, so
   *  every chart in the set gives its legend the same room; entries without data here are drawn hollow. */
  legendItems?: PlotLegendItem[];
  /** Drawn over the chart, given the plot area (the quantification window band). */
  overlay?: (geom: OverlayPlotGeometry) => React.ReactNode;
  /** Drawn under the chart (in flow), given the plot area: an x-axis strip (relative coordinates). */
  footer?: (geom: OverlayPlotGeometry) => React.ReactNode;
  /** The footer as drawn into an export (SVG, PDF, PNG): `height` px under the chart, drawn given the plot area and its top. */
  exportFooter?: { height: number; draw: (ctx: CanvasRenderingContext2D, geom: OverlayPlotGeometry, top: number) => void };
}

/** The plot area inside the chart, in CSS px: x of bin i = left + i / (n − 1) · width. */
export interface OverlayPlotGeometry { left: number; width: number; top: number; height: number }

/** The y domain a chart draws: the given one, else its series' own (always holding 0, signed when values are negative). */
export function overlayProfileDomain(series: ProfileSeries[], yDomain?: YDomain, refLine?: number): YDomain {
  if (yDomain && Number.isFinite(yDomain.min) && Number.isFinite(yDomain.max) && yDomain.max > yDomain.min) {
    return refLine != null && Number.isFinite(refLine)
      ? { min: Math.min(yDomain.min, refLine), max: Math.max(yDomain.max, refLine) } : yDomain;
  }
  const d = domainOf(series.filter(s => s.data && s.data.length > 0).flatMap(s => [s.data, s.ciHigh ?? [], s.ciLow ?? []]));
  if (refLine != null && Number.isFinite(refLine)) return { min: Math.min(d.min, refLine), max: Math.max(d.max, refLine) };
  return d;
}

type LegendEntry = Pick<PlotLegendItem, 'label' | 'color' | 'missing' | 'title'>;

/** Where the plot and the legend go: one layout for the drawing, the export and the DOM hover boxes. */
export function overlayProfileLayout(
  ctx: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
  width: number,
  height: number,
  o: { series: ProfileSeries[]; showLegend: boolean; legendItems?: LegendEntry[]; noAxes: boolean; yLabel?: string; windowBp?: number; caption?: string },
) {
  const validSeries = o.series.filter(s => s.data && s.data.length > 0);
  const items: LegendEntry[] = o.legendItems ?? validSeries.map(s => ({ label: s.label, color: s.color }));
  const leftPad = o.noAxes ? 4 : (o.yLabel ? 36 : 26);
  const bottomPad = o.noAxes ? 4 : (o.windowBp != null ? (o.caption ? 30 : 16) : 6);
  const topPad = 4;
  // The legend gets its own column(s) right of the plot, so no curve runs under its labels.
  const legend = layoutLegend(ctx, o.showLegend && items.length > 1 ? items : [], width, height, topPad);
  const rightPad = 4 + legend.width;
  const plotW = Math.max(1, width - leftPad - rightPad);
  const plotH = Math.max(1, height - topPad - bottomPad);
  return { validSeries, leftPad, topPad, bottomPad, plotW, plotH, legend };
}

function drawLegend(ctx: CanvasRenderingContext2D, legend: ReturnType<typeof layoutLegend>) {
  if (legend.entries.length === 0) return;
  if (legend.inside) {
    // Too many layers for a column beside a narrow plot: over it, on a backing so curves stay behind the labels.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(legend.box.x, legend.box.y, legend.box.w, legend.box.h);
  }
  ctx.font = LEGEND_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const { series: s, x, y } of legend.entries) {
    if (s.missing) {
      // No data for this entry in this plot: a hollow swatch in its colour and a muted label.
      if (typeof ctx.strokeRect === 'function') {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y - 3.5, 7, 7);
      }
      ctx.fillStyle = '#b0b0b0';
    } else {
      ctx.fillStyle = s.color;
      ctx.fillRect(x, y - 4, 8, 8);
      ctx.fillStyle = '#666';
    }
    ctx.fillText(s.label, x + 11, y);
  }
}

export function drawOverlayProfile(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  series: ProfileSeries[],
  showLegend: boolean,
  isReversed: boolean,
  windowBp: number | undefined,
  yLabel: string | undefined,
  noAxes: boolean,
  caption: string | undefined,
  yDomain?: YDomain,
  refLine?: number,
  cornerMax?: boolean,
  legendItems?: PlotLegendItem[],
): OverlayPlotGeometry | null {
  ctx.clearRect(0, 0, width, height);

  const { validSeries, leftPad, topPad, plotW, plotH, legend } = overlayProfileLayout(ctx, width, height,
    { series, showLegend, legendItems, noAxes, yLabel, windowBp, caption });
  if (validSeries.length === 0) {
    if (legendItems) {
      // A plot of a set with nothing to draw keeps the set's legend (and so its plot area).
      ctx.fillStyle = '#999';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No profile data', leftPad + plotW / 2, topPad + plotH / 2);
      drawLegend(ctx, legend);
      return { left: leftPad, width: plotW, top: topPad, height: plotH };
    }
    ctx.fillStyle = '#999';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No profile data', width / 2, height / 2);
    return null;
  }

  // The vertical domain always holds 0; a channel with negative values (a log2 regularity score) gets a signed domain
  // with its zero line inside the plot. Non-finite values are gaps (no measurement), never drawn as 0.
  // A fixed domain (shared across a set of plots) replaces the autoscale; curves above it are clipped to the plot.
  const finite = (v: number | undefined) => typeof v === 'number' && Number.isFinite(v);
  const domain = overlayProfileDomain(validSeries, yDomain, refLine);
  const globalMax = domain.max, globalMin = domain.min;
  const span = globalMax - globalMin || 1;

  const yOf = (v: number) => topPad + plotH - ((v - globalMin) / span) * plotH;
  const zeroY = yOf(0);

  ctx.save();
  // A fixed (shared) domain can be lower than a series excluded from it: clip the curves to the plot.
  if (typeof ctx.rect === 'function' && typeof ctx.clip === 'function') {
    ctx.beginPath();
    ctx.rect(leftPad, topPad - 1, plotW, plotH + 2);
    ctx.clip();
  }
  if (refLine != null && Number.isFinite(refLine)) {
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(107, 114, 128, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad, yOf(refLine));
    ctx.lineTo(leftPad + plotW, yOf(refLine));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const s of validSeries) {
    const n = s.data.length;
    if (n === 0) continue;
    const xOf = (i: number) => leftPad + (i / Math.max(1, n - 1)) * plotW;
    const at = (arr: number[], i: number) => arr[isReversed ? (n - 1 - i) : i];
    // Contiguous runs of measured bins: each is drawn (and filled to the zero line) on its own.
    const runs: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      if (!finite(at(s.data, i))) continue;
      if (runs.length && runs[runs.length - 1][1] === i - 1) runs[runs.length - 1][1] = i;
      else runs.push([i, i]);
    }

    const hasConfidenceBand = s.ciLow?.length === n && s.ciHigh?.length === n;
    if (hasConfidenceBand) {
      const low = s.ciLow!;
      const high = s.ciHigh!;
      for (const [a, b] of runs) {
        ctx.beginPath();
        for (let i = a; i <= b; i++) {
          const v = at(high, i);
          const y = yOf(finite(v) ? v : at(s.data, i));
          if (i === a) ctx.moveTo(xOf(i), y); else ctx.lineTo(xOf(i), y);
        }
        for (let i = b; i >= a; i--) {
          const v = at(low, i);
          ctx.lineTo(xOf(i), yOf(finite(v) ? v : at(s.data, i)));
        }
        ctx.closePath();
        ctx.fillStyle = s.color + '30';
        ctx.fill();
      }
    }

    for (const [a, b] of runs) {
      ctx.beginPath();
      ctx.moveTo(xOf(a), zeroY);
      for (let i = a; i <= b; i++) ctx.lineTo(xOf(i), yOf(at(s.data, i)));
      ctx.lineTo(xOf(b), zeroY);
      ctx.closePath();
      ctx.fillStyle = s.color + (hasConfidenceBand ? '12' : '26');
      ctx.fill();
    }

    ctx.beginPath();
    for (const [a, b] of runs) {
      ctx.moveTo(xOf(a), yOf(at(s.data, a)));
      for (let i = a + 1; i <= b; i++) ctx.lineTo(xOf(i), yOf(at(s.data, i)));
      if (a === b) ctx.lineTo(xOf(a) + 0.5, yOf(at(s.data, a)));
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();

  if (noAxes && cornerMax) {
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const text = `max ${formatAxisValue(globalMax)}`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fillRect(leftPad + plotW - tw - 3, topPad, tw + 3, 10);
    ctx.fillStyle = '#6b7280';
    ctx.fillText(text, leftPad + plotW - 1, topPad);
  }

  if (!noAxes) {
    const fmt = (v: number) => {
      if (v === 0) return '0';
      if (v >= 100) return v.toFixed(0);
      if (v >= 10) return v.toFixed(1);
      return v.toFixed(2);
    };
    ctx.fillStyle = '#6b7280';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const fmtSigned = (v: number) => (v < 0 ? `−${fmt(-v)}` : fmt(v));
    if (globalMax > 0) ctx.fillText(fmt(globalMax), leftPad - 3, topPad + 2);
    // the '0' label only where it clears the top and bottom labels (a domain like [-0.02, 2.5] puts zero on the bottom)
    const zeroLabelY = Math.min(topPad + plotH, Math.max(topPad + 2, zeroY));
    const clearTop = !(globalMax > 0) || zeroLabelY - (topPad + 2) >= 10;
    const clearBottom = !(globalMin < 0) || (topPad + plotH) - zeroLabelY >= 10;
    if (clearTop && clearBottom) ctx.fillText('0', leftPad - 3, zeroLabelY);
    if (globalMin < 0) {
      ctx.fillText(fmtSigned(globalMin), leftPad - 3, topPad + plotH);
      // the zero line of a signed domain
      ctx.strokeStyle = 'rgba(107, 114, 128, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(leftPad, zeroY);
      ctx.lineTo(leftPad + plotW, zeroY);
      ctx.stroke();
    }
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad, topPad);
    ctx.lineTo(leftPad, topPad + plotH);
    ctx.stroke();

    if (yLabel) {
      ctx.save();
      ctx.translate(10, topPad + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#6b7280';
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();
    }

    if (windowBp != null) {
      const centerX = leftPad + plotW / 2;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(107, 114, 128, 0.35)';
      ctx.beginPath();
      ctx.moveTo(centerX, topPad);
      ctx.lineTo(centerX, topPad + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#6b7280';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`-${windowBp}`, leftPad, topPad + plotH + 2);
      ctx.fillText('0', centerX, topPad + plotH + 2);
      ctx.fillText(`+${windowBp}`, leftPad + plotW, topPad + plotH + 2);

      if (caption) {
        ctx.fillStyle = '#9ca3af';
        ctx.font = 'italic 9px sans-serif';
        ctx.fillText(caption, centerX, topPad + plotH + 15);
      }
    }
  }

  drawLegend(ctx, legend);
  return { left: leftPad, width: plotW, top: topPad, height: plotH };
}

const LEGEND_FONT = '9px sans-serif';
const LEGEND_ROW = 12;

/** Legend entries stacked in columns at the right edge (a new column when the chart is too short). */
function layoutLegend(ctx: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>, series: LegendEntry[], width: number, height: number, topPad: number) {
  const box = { x: 0, y: 0, w: 0, h: 0 };
  if (series.length === 0) return { width: 0, inside: false, box, columnWidth: 0, entries: [] as { series: LegendEntry; x: number; y: number }[] };
  ctx.font = LEGEND_FONT;
  const labelWidth = Math.ceil(Math.max(...series.map(s => ctx.measureText(s.label).width)));
  const columnWidth = labelWidth + 15; // 8 px swatch + 3 px gap + label + 4 px between columns
  const rows = Math.max(1, Math.floor((height - topPad) / LEGEND_ROW));
  const columns = Math.ceil(series.length / rows);
  // Beside the plot unless that would take more than 40% of the chart; then over the plot,
  // with only the columns that fit the chart's width.
  const inside = columns * columnWidth + 2 > width * 0.4;
  const shownColumns = inside ? Math.max(1, Math.min(columns, Math.floor((width - 2) / columnWidth))) : columns;
  const legendWidth = shownColumns * columnWidth + 2;
  const left = Math.max(2, width - legendWidth + 2);
  // Too many to show: the plot's own series first, then entries it lacks (a hollow "missing" entry never pushes out a
  // real one); the shown ones keep their order.
  const capacity = shownColumns * rows;
  const keep = series.length <= capacity ? null
    : new Set([...series.map((s, i) => [s, i] as const).filter(([s]) => !s.missing), ...series.map((s, i) => [s, i] as const).filter(([s]) => s.missing)]
      .slice(0, capacity).map(([, i]) => i));
  // Hollow entries the plot lacks never cost it a label of its own: when the full set doesn't fit, it is laid out as
  // the plot's own series alone (as before full legends).
  if (keep && series.some(s => s.missing)) return layoutLegend(ctx, series.filter(s => !s.missing), width, height, topPad);
  const shown = keep ? series.filter((_, i) => keep.has(i)) : series;
  if (inside) Object.assign(box, { x: left - 2, y: topPad, w: legendWidth, h: Math.min(shown.length, rows) * LEGEND_ROW });
  return {
    width: inside ? 0 : legendWidth,
    inside,
    box,
    columnWidth,
    entries: shown.map((s, i) => ({
      series: s,
      x: left + Math.floor(i / rows) * columnWidth,
      y: topPad + 6 + (i % rows) * LEGEND_ROW,
    })),
  };
}

export function OverlayProfileChart({
  series,
  width = 300,
  height = 120,
  showLegend = true,
  filename = 'profile',
  isReversed = false,
  windowBp,
  yLabel,
  noAxes = false,
  caption,
  yDomain,
  refLine,
  cornerMax = false,
  valueLabel,
  legendItems,
  overlay,
  footer,
  exportFooter,
}: OverlayProfileChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [geom, setGeom] = useState<OverlayPlotGeometry | null>(null);

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawOverlayProfile(ctx, w, h, series, showLegend, isReversed, windowBp, yLabel, noAxes, caption, yDomain, refLine, cornerMax, legendItems);
  }, [series, showLegend, isReversed, windowBp, yLabel, noAxes, caption, yDomain, refLine, cornerMax, legendItems]);
  // Exports draw the footer (the relative x-axis) under the chart, so a saved figure keeps its axis.
  const exportHeight = height + (exportFooter?.height ?? 0);
  const exportDrawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const fh = exportFooter?.height ?? 0;
    const g = drawOverlayProfile(ctx, w, h - fh, series, showLegend, isReversed, windowBp, yLabel, noAxes, caption, yDomain, refLine, cornerMax, legendItems);
    if (exportFooter && g) exportFooter.draw(ctx, g, h - fh);
  }, [series, showLegend, isReversed, windowBp, yLabel, noAxes, caption, yDomain, refLine, cornerMax, legendItems, exportFooter]);
  const shownDomain = overlayProfileDomain(series, yDomain, refLine);
  // The same layout as the drawing: the plot's place (for tests lining up a set) and hover boxes over the legend.
  const layout = useMemo(() => overlayProfileLayout(measureContext(), width, height,
    { series, showLegend, legendItems, noAxes, yLabel, windowBp, caption }),
  [series, showLegend, legendItems, noAxes, yLabel, windowBp, caption, width, height]);
  const legendShown = layout.legend.entries.map(e => e.series);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = drawOverlayProfile(ctx, width, height, series, showLegend, isReversed, windowBp, yLabel, noAxes, caption, yDomain, refLine, cornerMax, legendItems);
    if (overlay || footer) setGeom(prev => (g && prev && prev.left === g.left && prev.width === g.width && prev.top === g.top && prev.height === g.height ? prev : g));
  }, [drawFn, width, height]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative group" data-y-max={formatAxisValue(shownDomain.max)} data-y-min={formatAxisValue(shownDomain.min)}
      data-y-fixed={yDomain ? 'true' : 'false'} data-y-label={yLabel ?? valueLabel ?? ''}
      data-plot-left={layout.leftPad} data-plot-width={Math.round(layout.plotW * 10) / 10} data-legend={legendSignature(legendShown)}>
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="block"
      />
      {legendItems && layout.legend.entries.map(({ series: s, x, y }, i) => (
        <span key={i} className="absolute" data-testid={s.missing ? 'plot-legend-missing' : 'plot-legend-item'}
          title={s.title ?? s.label} aria-label={s.title ?? s.label}
          style={{ left: x, top: y - LEGEND_ROW / 2, width: layout.legend.columnWidth - 4, height: LEGEND_ROW }} />
      ))}
      {overlay && geom && overlay(geom)}
      {footer && geom && footer(geom)}
      <ChartSaveButton
        canvasRef={canvasRef}
        filename={filename}
        drawFn={exportFooter ? exportDrawFn : drawFn}
        width={width}
        height={exportFooter ? exportHeight : height}
        pngFromDrawFn={!!exportFooter}
        dataTsv={() => formatProfileChartTsv(series, { windowBp, isReversed, valueLabel })}
      />
      <ChartMaximizeButton
        title="Overlay Profile"
        filename={filename}
        exportDrawFn={exportFooter ? exportDrawFn : undefined}
        exportExtraHeight={exportFooter?.height}
        renderChart={(w, h) => (
          <OverlayProfileChart series={series} width={w} height={h}
            showLegend={showLegend} filename={filename} isReversed={isReversed}
            windowBp={windowBp} yLabel={yLabel} noAxes={noAxes} caption={caption}
            yDomain={yDomain} refLine={refLine} cornerMax={cornerMax} valueLabel={valueLabel} legendItems={legendItems}
            overlay={overlay} footer={footer} exportFooter={exportFooter} />
        )}
      />
    </div>
  );
}

let measureCtx: Pick<CanvasRenderingContext2D, 'font' | 'measureText'> | null = null;
/** A 2D context for measuring legend labels outside a draw (an estimate where no canvas is available). */
function measureContext(): Pick<CanvasRenderingContext2D, 'font' | 'measureText'> {
  if (measureCtx) return measureCtx;
  let ctx: CanvasRenderingContext2D | null = null;
  try { ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null; } catch { ctx = null; }
  measureCtx = ctx ?? { font: '', measureText: (t: string) => ({ width: t.length * 5 }) as TextMetrics };
  return measureCtx;
}
