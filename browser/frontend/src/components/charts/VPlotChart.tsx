import { useRef, useEffect, useCallback } from 'react';
import { viridisRgb } from './viridis';
import { ChartSaveButton } from './ChartSaveButton';
import { ChartMaximizeButton } from './ChartMaximizeButton';
import { formatVPlotChartTsv } from '../../utils/analysisExport';

interface VPlotChartProps {
  matrix: number[][];     // rows=size bins, cols=position bins, values in [0,1]
  sizeMin: number;
  sizeMax: number;
  windowBp: number;
  sizeBin: number;
  posBin: number;
  width?: number;
  height?: number;
  title?: string;
  filename?: string;
  xLabels?: [string, string, string];  // Override X-axis labels: [left, center, right]
  /** One-line caption under the x-axis explaining what "0" or the center
   *  represents — "centered on viewport midpoint", "centered on selected
   *  footprint", etc. Helps readers disambiguate the different V-plot
   *  contexts in the app. */
  centerCaption?: string;
  /** When true, draw right-edge labels for the TF/small-FP/nuc size bands
   *  at the 35/80/90 bp reference lines. Off by default to keep small
   *  thumbnails clean; the full-size / maximized chart turns it on. */
  bandLabels?: boolean;
  /** How the matrix was made, written as `# key: value` lines at the top of the data export. */
  exportNotes?: Record<string, string | number | boolean>;
  /** Dashed reference sizes (bp). Default: the 35 / 80 / 90-bp footprint lines; [] for none (e.g. open-region sizes). */
  guides?: number[];
  /** Genomic position of the first column (data export): absolute coordinates instead of the default -windowBp. */
  positionOrigin?: number;
  /** Larger axis text in a mid-grey that reads on light and dark panels, and a colour scale (low to high) on the
   * right. Off by default (the other V-plots keep their look). */
  readable?: boolean;
  /** Replace the built-in maximise (a caller with its own viewer, e.g. one that steps through several V-plots). */
  onMaximize?: () => void;
}

/** Where to centre an axis label of `labelWidth` at `tickX` so it isn't cut by either canvas edge. */
export function axisLabelX(tickX: number, labelWidth: number, canvasWidth: number, pad = 2): number {
  const half = labelWidth / 2;
  return Math.min(Math.max(tickX, half + pad), canvasWidth - half - pad);
}

function drawVPlot(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  matrix: number[][],
  sizeMin: number,
  sizeMax: number,
  windowBp: number,
  sizeBin: number,
  title: string | undefined,
  xLabels: [string, string, string] | undefined,
  centerCaption: string | undefined,
  bandLabels: boolean,
  guides?: number[],
  readable = false,
) {
  ctx.clearRect(0, 0, width, height);

  if (!matrix || matrix.length === 0) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No V-plot data', width / 2, height / 2);
    return;
  }

  const topPad = title ? 20 : 8;
  const bottomPad = centerCaption ? 38 : 24;
  const leftPad = 40;
  const rightPad = readable ? 30 : bandLabels ? 44 : 16;
  const ink = readable ? '#8b93a1' : '#6b7280';
  const axisFont = readable ? '10px sans-serif' : '9px sans-serif';
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;

  const nRows = matrix.length;
  const nCols = matrix[0]?.length || 0;
  if (nRows === 0 || nCols === 0) return;

  const cellW = plotWidth / nCols;
  const cellH = plotHeight / nRows;

  if (title) {
    ctx.fillStyle = readable ? ink : '#374151';
    ctx.font = readable ? 'bold 11px sans-serif' : '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, width / 2, 14);
  }

  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const v = matrix[r][c];
      const [cr, cg, cb] = viridisRgb(v);
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fillRect(leftPad + c * cellW, topPad + r * cellH, Math.ceil(cellW), Math.ceil(cellH));
    }
  }

  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;

  if (!xLabels) {
    const centerCol = nCols / 2;
    const centerX = leftPad + centerCol * cellW;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.moveTo(centerX, topPad);
    ctx.lineTo(centerX, topPad + plotHeight);
    ctx.stroke();
  }

  if (guides) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    for (const g of guides) {
      const row = (g - sizeMin) / sizeBin;
      if (row < 0 || row >= nRows) continue;
      const yy = topPad + row * cellH;
      ctx.beginPath(); ctx.moveTo(leftPad, yy); ctx.lineTo(leftPad + plotWidth, yy); ctx.stroke();
    }
    bandLabels = false;
  }
  const tfLow = (guides ? -1e9 : 35 - sizeMin) / sizeBin;
  const tfHigh = (guides ? -1e9 : 80 - sizeMin) / sizeBin;
  const nucLine = (guides ? -1e9 : 90 - sizeMin) / sizeBin;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  if (tfLow >= 0 && tfLow < nRows) {
    const yy = topPad + tfLow * cellH;
    ctx.beginPath(); ctx.moveTo(leftPad, yy); ctx.lineTo(leftPad + plotWidth, yy); ctx.stroke();
  }
  if (tfHigh >= 0 && tfHigh < nRows) {
    const yy = topPad + tfHigh * cellH;
    ctx.beginPath(); ctx.moveTo(leftPad, yy); ctx.lineTo(leftPad + plotWidth, yy); ctx.stroke();
  }
  if (nucLine >= 0 && nucLine < nRows) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    const yy = topPad + nucLine * cellH;
    ctx.beginPath(); ctx.moveTo(leftPad, yy); ctx.lineTo(leftPad + plotWidth, yy); ctx.stroke();
  }

  ctx.setLineDash([]);

  if (bandLabels) {
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#6b7280';
    const labelX = leftPad + plotWidth + 4;
    const rowToY = (r: number) => topPad + r * cellH;
    const clampRow = (r: number) => Math.max(0, Math.min(nRows, r));
    const bands: Array<{ lo: number; hi: number; label: string }> = [
      { lo: clampRow(tfLow),  hi: clampRow(tfHigh), label: 'TF' },
      { lo: clampRow(tfHigh), hi: clampRow(nucLine), label: 'small FP' },
      { lo: clampRow(nucLine), hi: nRows,            label: 'nuc' },
    ];
    for (const b of bands) {
      if (b.hi <= b.lo) continue;
      const yMid = (rowToY(b.lo) + rowToY(b.hi)) / 2 + 3;
      ctx.fillText(b.label, labelX, yMid);
    }
  }

  ctx.fillStyle = ink;
  ctx.font = axisFont;
  ctx.textAlign = 'right';
  const targetTicks = readable ? Math.max(3, Math.min(7, Math.round(plotHeight / 28))) : 7;
  const sizeRange = Math.max(1, sizeMax - sizeMin);
  const rawStep = sizeRange / targetTicks;
  const niceSteps = [10, 20, 25, 50, 100, 200, 250, 500];
  const niceStep = niceSteps.find(s => s >= rawStep) ?? 500;
  const firstLabel = Math.ceil(sizeMin / niceStep) * niceStep;
  for (let label = firstLabel; label <= sizeMax; label += niceStep) {
    const r = (label - sizeMin) / sizeBin;
    if (r < 0 || r > nRows) continue;
    ctx.fillText(String(label), leftPad - 3, topPad + r * cellH + 3);
  }
  ctx.save();
  ctx.translate(10, topPad + plotHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('Size (bp)', 0, 0);
  ctx.restore();

  ctx.textAlign = 'center';
  const [leftLabel, midLabel, rightLabel] = xLabels ?? [`-${windowBp}`, '0', `+${windowBp}`];
  const axisY = topPad + plotHeight + 14;
  // Centred under its tick, but slid inward so a long coordinate at either end stays on the canvas.
  ctx.fillText(leftLabel, axisLabelX(leftPad, ctx.measureText(leftLabel).width, width), axisY);
  ctx.fillText(midLabel, leftPad + plotWidth / 2, axisY);
  ctx.fillText(rightLabel, axisLabelX(leftPad + plotWidth, ctx.measureText(rightLabel).width, width), axisY);

  if (readable) {
    // colour scale: low (bottom) to high (top), beside the plot
    const bx = leftPad + plotWidth + 8, bw = 7;
    for (let i = 0; i < plotHeight; i++) {
      const [cr, cg, cb] = viridisRgb(1 - i / Math.max(1, plotHeight - 1));
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fillRect(bx, topPad + i, bw, 1.5);
    }
    ctx.fillStyle = ink; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('hi', bx + bw + 2, topPad + 7);
    ctx.fillText('lo', bx + bw + 2, topPad + plotHeight);
  }

  if (centerCaption) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = 'italic 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(centerCaption, leftPad + plotWidth / 2, topPad + plotHeight + 28);
  }
}

export function VPlotChart({
  matrix,
  sizeMin,
  sizeMax,
  windowBp,
  sizeBin,
  posBin,
  width = 300,
  height = 200,
  title,
  filename = 'vplot',
  xLabels,
  centerCaption,
  bandLabels = false,
  exportNotes,
  guides,
  positionOrigin,
  readable = false,
  onMaximize,
}: VPlotChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawVPlot(ctx, w, h, matrix, sizeMin, sizeMax, windowBp, sizeBin, title, xLabels, centerCaption, bandLabels, guides, readable);
  }, [matrix, sizeMin, sizeMax, windowBp, sizeBin, title, xLabels, centerCaption, bandLabels, guides, readable]);

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
      <canvas ref={canvasRef} style={{ width, height }} />
      <ChartSaveButton
        canvasRef={canvasRef}
        filename={filename}
        drawFn={drawFn}
        width={width}
        height={height}
        dataTsv={() => formatVPlotChartTsv(matrix, { sizeMin, sizeBin, windowBp, posBin, notes: exportNotes, positionOrigin })}
      />
      {onMaximize ? (
        <button type="button" onClick={e => { e.stopPropagation(); onMaximize(); }} title="Maximize (← / → step through)" data-testid="vplot-maximize"
          className="absolute top-1 right-7 z-10 flex h-5 w-5 items-center justify-center rounded bg-black/40 text-[11px] leading-none text-white opacity-0 transition-opacity hover:bg-black/60 group-hover:opacity-100">⤢</button>
      ) : <ChartMaximizeButton
        title={title || 'V-Plot'}
        filename={filename}
        renderChart={(w, h) => (
          <VPlotChart matrix={matrix} sizeMin={sizeMin} sizeMax={sizeMax}
            windowBp={windowBp} sizeBin={sizeBin} posBin={posBin}
            width={w} height={h} title={title} filename={filename}
            xLabels={xLabels}
            centerCaption={centerCaption}
            exportNotes={exportNotes}
            guides={guides}
            positionOrigin={positionOrigin}
            readable={readable}
            bandLabels /* always show band labels on the maximized chart */ />
        )}
      />}
    </div>
  );
}
