import { useRef, useEffect, useCallback, useState } from 'react';
import { ChartSaveButton } from './ChartSaveButton';
import { ChartMaximizeButton } from './ChartMaximizeButton';
import { formatHistogramChartTsv } from '../../utils/analysisExport';

export interface HistogramBar {
  label: string;
  value: number;
  color: string;
  /** Optional confidence limits on the same scale as value. */
  ciLow?: number;
  ciHigh?: number;
  /** Observation count used to derive the interval. */
  n?: number;
}

export interface HistogramGroup {
  label: string;
  bars: HistogramBar[];
}

interface HistogramChartProps {
  groups: HistogramGroup[];
  width?: number;
  height?: number;
  yLabel?: string;
  groupedLayout?: boolean; // true = side-by-side bars per group
  filename?: string;
  yFormat?: (value: number) => string;
  /** Shaded range of groups (inclusive indices), e.g. a chosen size range. */
  selection?: { from: number; to: number } | null;
  /** Drag across bars to choose a range; called with inclusive group indices. */
  onSelectRange?: (from: number, to: number) => void;
}

function defaultYFormat(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : Math.round(value).toString();
}

const HIST_PAD = { left: 36, right: 10, top: 10, bottom: 24 };

function histogramLayout(width: number, height: number) {
  return {
    leftPad: HIST_PAD.left,
    topPad: HIST_PAD.top,
    plotW: width - HIST_PAD.left - HIST_PAD.right,
    plotH: height - HIST_PAD.top - HIST_PAD.bottom,
  };
}

function drawHistogram(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  groups: HistogramGroup[],
  yLabel: string | undefined,
  groupedLayout: boolean,
  yFormat: (v: number) => string,
  selection: { from: number; to: number } | null = null,
) {
  ctx.clearRect(0, 0, width, height);
  if (groups.length === 0) return;

  const { leftPad, topPad, plotW, plotH } = histogramLayout(width, height);

  if (selection) {
    const lo = Math.max(0, Math.min(selection.from, selection.to));
    const hi = Math.min(groups.length - 1, Math.max(selection.from, selection.to));
    const gw = plotW / groups.length;
    ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
    ctx.fillRect(leftPad + lo * gw, topPad, (hi - lo + 1) * gw, plotH);
  }

  let maxVal = 0;
  for (const g of groups) {
    for (const b of g.bars) {
      if ((b.ciHigh ?? b.value) > maxVal) maxVal = b.ciHigh ?? b.value;
    }
  }
  if (maxVal === 0) maxVal = 1;

  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(leftPad, topPad);
  ctx.lineTo(leftPad, topPad + plotH);
  ctx.lineTo(leftPad + plotW, topPad + plotH);
  ctx.stroke();

  ctx.fillStyle = '#999';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  const yTicks = [0, maxVal / 2, maxVal];
  for (const tick of yTicks) {
    const y = topPad + plotH - (tick / maxVal) * plotH;
    ctx.fillText(yFormat(tick), leftPad - 4, y + 3);
    if (tick > 0) {
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = '#e5e5e5';
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(leftPad + plotW, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (yLabel) {
    ctx.save();
    ctx.fillStyle = '#999';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.translate(9, topPad + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }

  const nGroups = groups.length;
  const groupWidth = plotW / nGroups;
  const groupPadding = groupWidth * 0.15;

  const drawErrorBar = (bar: HistogramBar, centerX: number, capWidth: number) => {
    if (!Number.isFinite(bar.ciLow) || !Number.isFinite(bar.ciHigh)) return;
    const low = Math.max(0, bar.ciLow!);
    const high = Math.max(low, bar.ciHigh!);
    const lowY = topPad + plotH - (low / maxVal) * plotH;
    const highY = topPad + plotH - (high / maxVal) * plotH;
    const cap = Math.max(2, Math.min(6, capWidth * 0.65));
    ctx.save();
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX, highY);
    ctx.lineTo(centerX, lowY);
    ctx.moveTo(centerX - cap / 2, highY);
    ctx.lineTo(centerX + cap / 2, highY);
    ctx.moveTo(centerX - cap / 2, lowY);
    ctx.lineTo(centerX + cap / 2, lowY);
    ctx.stroke();
    ctx.restore();
  };

  for (let gi = 0; gi < nGroups; gi++) {
    const g = groups[gi];
    const groupX = leftPad + gi * groupWidth + groupPadding;
    const barAreaWidth = groupWidth - groupPadding * 2;

    if (groupedLayout && g.bars.length > 1) {
      const barWidth = Math.max(4, barAreaWidth / g.bars.length - 1);
      const barSpacing = (barAreaWidth - barWidth * g.bars.length) / Math.max(1, g.bars.length - 1);
      for (let bi = 0; bi < g.bars.length; bi++) {
        const b = g.bars[bi];
        const barH = (b.value / maxVal) * plotH;
        const bx = groupX + bi * (barWidth + barSpacing);
        const by = topPad + plotH - barH;
        ctx.fillStyle = b.color;
        ctx.fillRect(bx, by, barWidth, barH);
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(bx, by, barWidth, barH);
        drawErrorBar(b, bx + barWidth / 2, barWidth);
      }
    } else {
      const b = g.bars[0];
      if (b) {
        const barH = (b.value / maxVal) * plotH;
        const bx = groupX;
        const by = topPad + plotH - barH;
        ctx.fillStyle = b.color;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(bx, by, barAreaWidth, barH);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(bx, by, barAreaWidth, barH);
        drawErrorBar(b, bx + barAreaWidth / 2, barAreaWidth);
      }
    }

    ctx.fillStyle = '#666';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(g.label, groupX + barAreaWidth / 2, topPad + plotH + 14);
  }
}

export function HistogramChart({
  groups,
  width = 300,
  height = 140,
  yLabel,
  groupedLayout = false,
  filename = 'histogram',
  yFormat = defaultYFormat,
  selection = null,
  onSelectRange,
}: HistogramChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const shown = drag ?? selection;

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawHistogram(ctx, w, h, groups, yLabel, groupedLayout, yFormat, shown);
  }, [groups, yLabel, groupedLayout, yFormat, shown]);

  const groupAt = (clientX: number): number => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { leftPad, plotW } = histogramLayout(width, height);
    const x = (clientX - rect.left) * (width / rect.width) - leftPad;
    return Math.max(0, Math.min(groups.length - 1, Math.floor((x / plotW) * groups.length)));
  };
  const dragHandlers = onSelectRange && groups.length > 0 ? {
    onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const index = groupAt(event.clientX);
      setDrag({ from: index, to: index });
    },
    onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (drag) setDrag({ from: drag.from, to: groupAt(event.clientX) });
    },
    onPointerUp: () => {
      if (drag) onSelectRange(Math.min(drag.from, drag.to), Math.max(drag.from, drag.to));
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  } : {};

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
        style={{ width, height, cursor: onSelectRange ? 'crosshair' : undefined, touchAction: onSelectRange ? 'none' : undefined }}
        className="block"
        {...dragHandlers}
      />
      <ChartSaveButton
        canvasRef={canvasRef}
        filename={filename}
        drawFn={drawFn}
        width={width}
        height={height}
        dataTsv={() => formatHistogramChartTsv(groups)}
      />
      <ChartMaximizeButton
        title={yLabel || 'Histogram'}
        filename={filename}
        renderChart={(w, h) => (
          <HistogramChart groups={groups} width={w} height={h}
            yLabel={yLabel} groupedLayout={groupedLayout} filename={filename}
            yFormat={yFormat} />
        )}
      />
    </div>
  );
}
