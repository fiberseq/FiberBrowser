import { useRef, useEffect, useCallback } from 'react';
import { ChartSaveButton } from './ChartSaveButton';
import { ChartMaximizeButton } from './ChartMaximizeButton';
import { formatProfileChartTsv } from '../../utils/analysisExport';

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
) {
  ctx.clearRect(0, 0, width, height);

  const validSeries = series.filter(s => s.data && s.data.length > 0);
  if (validSeries.length === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No profile data', width / 2, height / 2);
    return;
  }

  let globalMax = 0;
  for (const s of validSeries) {
    for (const v of s.data) {
      if (v > globalMax) globalMax = v;
    }
    for (const v of s.ciHigh ?? []) {
      if (v > globalMax) globalMax = v;
    }
  }
  if (!(globalMax > 0)) globalMax = 1;

  const leftPad = noAxes ? 4 : (yLabel ? 36 : 26);
  const bottomPad = noAxes ? 4 : (windowBp != null ? (caption ? 30 : 16) : 6);
  const topPad = 4;
  // The legend gets its own column(s) right of the plot, so no curve runs under its labels.
  const legend = layoutLegend(ctx, showLegend && validSeries.length > 1 ? validSeries : [], width, height, topPad);
  const rightPad = 4 + legend.width;
  const plotW = Math.max(1, width - leftPad - rightPad);
  const plotH = Math.max(1, height - topPad - bottomPad);

  for (const s of validSeries) {
    const n = s.data.length;
    if (n === 0) continue;

    const hasConfidenceBand = s.ciLow?.length === n && s.ciHigh?.length === n;
    if (hasConfidenceBand) {
      const low = s.ciLow!;
      const high = s.ciHigh!;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const binIdx = isReversed ? (n - 1 - i) : i;
        const x = leftPad + (i / Math.max(1, n - 1)) * plotW;
        const y = topPad + plotH - (Math.max(0, high[binIdx]) / globalMax) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = n - 1; i >= 0; i--) {
        const binIdx = isReversed ? (n - 1 - i) : i;
        const x = leftPad + (i / Math.max(1, n - 1)) * plotW;
        const y = topPad + plotH - (Math.max(0, low[binIdx]) / globalMax) * plotH;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = s.color + '30';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(leftPad, topPad + plotH);
    for (let i = 0; i < n; i++) {
      const binIdx = isReversed ? (n - 1 - i) : i;
      const x = leftPad + (i / Math.max(1, n - 1)) * plotW;
      const y = topPad + plotH - (s.data[binIdx] / globalMax) * plotH;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(leftPad + plotW, topPad + plotH);
    ctx.closePath();
    ctx.fillStyle = s.color + (hasConfidenceBand ? '12' : '26');
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const binIdx = isReversed ? (n - 1 - i) : i;
      const x = leftPad + (i / Math.max(1, n - 1)) * plotW;
      const y = topPad + plotH - (s.data[binIdx] / globalMax) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
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
    ctx.fillText(fmt(globalMax), leftPad - 3, topPad + 2);
    ctx.fillText('0', leftPad - 3, topPad + plotH);
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

  if (legend.entries.length > 0) {
    if (legend.inside) {
      // Too many layers for a column beside a narrow plot: over it, on a backing so curves stay behind the labels.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(legend.box.x, legend.box.y, legend.box.w, legend.box.h);
    }
    ctx.font = LEGEND_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const { series: s, x, y } of legend.entries) {
      ctx.fillStyle = s.color;
      ctx.fillRect(x, y - 4, 8, 8);
      ctx.fillStyle = '#666';
      ctx.fillText(s.label, x + 11, y);
    }
  }
}

const LEGEND_FONT = '9px sans-serif';
const LEGEND_ROW = 12;

/** Legend entries stacked in columns at the right edge (a new column when the chart is too short). */
function layoutLegend(ctx: CanvasRenderingContext2D, series: ProfileSeries[], width: number, height: number, topPad: number) {
  const box = { x: 0, y: 0, w: 0, h: 0 };
  if (series.length === 0) return { width: 0, inside: false, box, entries: [] as { series: ProfileSeries; x: number; y: number }[] };
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
  const shown = series.slice(0, shownColumns * rows);
  if (inside) Object.assign(box, { x: left - 2, y: topPad, w: legendWidth, h: Math.min(shown.length, rows) * LEGEND_ROW });
  return {
    width: inside ? 0 : legendWidth,
    inside,
    box,
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
}: OverlayProfileChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawOverlayProfile(ctx, w, h, series, showLegend, isReversed, windowBp, yLabel, noAxes, caption);
  }, [series, showLegend, isReversed, windowBp, yLabel, noAxes, caption]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFn(ctx, width, height);
  }, [drawFn, width, height]);

  return (
    <div className="relative group">
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="block"
      />
      <ChartSaveButton
        canvasRef={canvasRef}
        filename={filename}
        drawFn={drawFn}
        width={width}
        height={height}
        dataTsv={() => formatProfileChartTsv(series, { windowBp, isReversed })}
      />
      <ChartMaximizeButton
        title="Overlay Profile"
        filename={filename}
        renderChart={(w, h) => (
          <OverlayProfileChart series={series} width={w} height={h}
            showLegend={showLegend} filename={filename} isReversed={isReversed}
            windowBp={windowBp} yLabel={yLabel} noAxes={noAxes} caption={caption} />
        )}
      />
    </div>
  );
}
