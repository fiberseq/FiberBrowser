import { useRef, useEffect, useCallback } from 'react';
import { viridisRgb } from './viridis';
import { ChartSaveButton } from './ChartSaveButton';
import { ChartMaximizeButton } from './ChartMaximizeButton';
import { formatHeatmapChartTsv } from '../../utils/analysisExport';

interface HeatmapChartProps {
  matrix: number[][]; // rows x cols, values in [0,1]
  colormap: 'grayscale' | 'viridis' | 'red-blue';
  width?: number;
  height?: number;
  rowLabels?: string[];
  colLabels?: string[];
  showValues?: boolean;
  /** Optional unscaled values to print while matrix controls cell color. */
  valueMatrix?: number[][];
  title?: string;
  colorbarLabel?: string;
  filename?: string;
  /** Optional richer table when the chart has row metadata or test results. */
  dataTsv?: string | (() => string);
}

function mapColor(v: number, colormap: string): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, v));
  if (colormap === 'viridis') {
    return viridisRgb(clamped);
  } else if (colormap === 'red-blue') {
    const r = Math.round(255 * (1 - clamped * 0.6));
    const g = Math.round(255 * (1 - clamped * 0.8));
    const b = Math.round(255 * (1 - clamped * 0.3));
    return [r, g, b];
  }
  const g = Math.round(255 * (1 - clamped));
  return [g, g, g];
}

function drawHeatmap(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  matrix: number[][],
  colormap: 'grayscale' | 'viridis' | 'red-blue',
  rowLabels: string[] | undefined,
  colLabels: string[] | undefined,
  showValues: boolean,
  valueMatrix: number[][] | undefined,
  title: string | undefined,
  colorbarLabel: string | undefined,
) {
  ctx.clearRect(0, 0, width, height);

  const nRows = matrix.length;
  if (nRows === 0) return;
  const nCols = matrix[0].length;
  if (nCols === 0) return;

  const titleH = title ? 16 : 0;
  // Row and column labels at a readable size. Column labels that fit over
  // their column are written level (a 3x3 state matrix); only long or many
  // labels are slanted, and then the top margin makes room for them.
  const labelFont = 11;
  const measure = (text: string) => {
    ctx.font = `${labelFont}px sans-serif`;
    const m = typeof ctx.measureText === 'function' ? ctx.measureText(text).width : NaN;
    return Number.isFinite(m) && m > 0 ? m : text.length * labelFont * 0.6;
  };
  const rowLabelW = rowLabels && rowLabels.length ? Math.max(...rowLabels.map(measure)) : 0;
  const leftPad = rowLabels ? Math.min(Math.ceil(rowLabelW) + 8, Math.round(width * 0.35)) : 4;
  const colorbarW = colorbarLabel ? 30 : 14;
  const plotWEarly = width - leftPad - (colorbarW + 8);
  const colLabelW = colLabels && colLabels.length ? Math.max(...colLabels.map(measure)) : 0;
  const levelColLabels = !!colLabels && colLabels.length > 0 && colLabelW + 4 <= plotWEarly / colLabels.length;
  const topPad = titleH + (colLabels ? (levelColLabels ? labelFont + 8 : Math.min(Math.ceil(colLabelW * 0.72) + 10, Math.round(height * 0.35))) : 4);
  const rightPad = colorbarW + 8;
  const bottomPad = 4;
  const plotW = width - leftPad - rightPad;
  const plotH = height - topPad - bottomPad;

  const cellW = plotW / nCols;
  const cellH = plotH / nRows;

  if (title) {
    ctx.fillStyle = '#666';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, width / 2, 11);
  }

  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const v = matrix[r][c];
      const [cr, cg, cb] = mapColor(v, colormap);
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fillRect(leftPad + c * cellW, topPad + r * cellH, cellW + 0.5, cellH + 0.5);

      if (showValues && nRows <= 8 && nCols <= 8) {
        const rawVal = valueMatrix?.[r]?.[c] ?? v;
        ctx.fillStyle = v > 0.5 ? '#fff' : '#333';
        ctx.font = `${Math.max(9, Math.min(12, cellW / 3, cellH / 2))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          Number.isInteger(rawVal)
            ? rawVal.toString()
            : rawVal >= 100 ? Math.round(rawVal).toString() : rawVal.toFixed(rawVal < 10 ? 1 : 0),
          leftPad + (c + 0.5) * cellW,
          topPad + (r + 0.5) * cellH,
        );
      }
    }
  }

  if (rowLabels) {
    ctx.fillStyle = '#666';
    ctx.font = `${labelFont}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < Math.min(nRows, rowLabels.length); r++) {
      ctx.fillText(rowLabels[r], leftPad - 4, topPad + (r + 0.5) * cellH);
    }
  }

  if (colLabels && levelColLabels) {
    ctx.fillStyle = '#666';
    ctx.font = `${labelFont}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let c = 0; c < Math.min(nCols, colLabels.length); c++) {
      ctx.fillText(colLabels[c], leftPad + (c + 0.5) * cellW, topPad - 4);
    }
  } else if (colLabels) {
    ctx.fillStyle = '#666';
    ctx.font = `${labelFont}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    for (let c = 0; c < Math.min(nCols, colLabels.length); c++) {
      ctx.save();
      ctx.translate(leftPad + (c + 0.5) * cellW, topPad - 4);
      ctx.rotate(-Math.PI / 4);
      ctx.fillText(colLabels[c], 0, 0);
      ctx.restore();
    }
  }

  const cbX = width - colorbarW - 4;
  const cbH = Math.min(plotH, 80);
  const cbY = topPad + (plotH - cbH) / 2;
  const cbW = 8;
  for (let i = 0; i < cbH; i++) {
    const v = 1 - i / cbH;
    const [cr, cg, cb] = mapColor(v, colormap);
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(cbX, cbY + i, cbW, 1.5);
  }
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(cbX, cbY, cbW, cbH);

  ctx.fillStyle = '#999';
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('1', cbX + cbW + 2, cbY);
  ctx.textBaseline = 'bottom';
  ctx.fillText('0', cbX + cbW + 2, cbY + cbH);

  if (colorbarLabel) {
    ctx.save();
    ctx.translate(cbX + cbW + 14, cbY + cbH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(colorbarLabel, 0, 0);
    ctx.restore();
  }
}

export function HeatmapChart({
  matrix,
  colormap,
  width = 300,
  height = 300,
  rowLabels,
  colLabels,
  showValues = false,
  valueMatrix,
  title,
  colorbarLabel,
  filename = 'heatmap',
  dataTsv,
}: HeatmapChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawHeatmap(ctx, w, h, matrix, colormap, rowLabels, colLabels, showValues, valueMatrix, title, colorbarLabel);
  }, [matrix, colormap, rowLabels, colLabels, showValues, valueMatrix, title, colorbarLabel]);

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
        dataTsv={dataTsv ?? (() => formatHeatmapChartTsv(matrix, { valueMatrix, rowLabels, colLabels }))}
      />
      <ChartMaximizeButton
        title={title || 'Heatmap'}
        filename={filename}
        renderChart={(w, h) => (
          <HeatmapChart matrix={matrix} colormap={colormap} width={w} height={h}
            rowLabels={rowLabels} colLabels={colLabels} showValues={showValues}
            valueMatrix={valueMatrix}
            title={title} colorbarLabel={colorbarLabel} filename={filename} dataTsv={dataTsv} />
        )}
      />
    </div>
  );
}
