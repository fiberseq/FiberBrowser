/**
 * One footprint size plot: size (y) by position (x), each cell coloured on a centred scale (log2: 0; linear: 1x)
 * (enrichment, ratios) or a sequential one (counts), with its colour bar, blank cells hatched, a hover readout and
 * PNG / SVG / PDF / TSV export (ChartSaveButton).
 */
import { drawXTicks } from './ProfileLinesChart';
import { formatTick, niceTicks } from '../../utils/niceTicks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartSaveButton } from './ChartSaveButton';
import { axisLabelX } from './VPlotChart';
import { scaleRgb, type ColorScale, type SizeMatrix } from '../../utils/footprintSizeMatrix';

export interface SizeEnrichmentChartProps {
  /** Display values (log2 / log1p already applied), null = blank. */
  matrix: SizeMatrix;
  /** The values before display transforms (the hover readout and TSV): same shape. */
  rawMatrix?: SizeMatrix;
  sizeMin: number;
  sizeMax: number;
  sizeBin: number;
  posBin: number;
  /** First position of the window (genomic, 0-based). */
  start: number;
  scale: ColorScale;
  width: number;
  height: number;
  title?: string;
  /** Under the title: e.g. "1,234 reads · 56,789 footprints". */
  subtitle?: string;
  /** Accent swatch beside the title (dataset or cluster colour). */
  accent?: string;
  filename: string;
  dataTsv?: () => string;
  dark?: boolean;
  /** Reference sizes drawn as dashed lines (bp). */
  guides?: number[];
  testId?: string;
  /** What a hovered value is ("enrichment", "footprints", "log2 ratio"). */
  valueLabel?: string;
  /** A click on the cells: the genomic position under it (0-based, the bin's centre). */
  onPositionClick?: (pos: number) => void;
}

const LEFT = 40;
const BAR_W = 8;

function layout(width: number, height: number, hasTitle: boolean, hasSubtitle: boolean) {
  const top = (hasTitle ? 16 : 6) + (hasSubtitle ? 12 : 0);
  const bottom = 26;
  const right = 46;
  return { top, bottom, right, plotW: Math.max(10, width - LEFT - right), plotH: Math.max(10, height - top - bottom) };
}

export function drawSizeEnrichment(ctx: CanvasRenderingContext2D, w: number, h: number, p: SizeEnrichmentChartProps): void {
  const { matrix, sizeMin, sizeMax, sizeBin, posBin, start, scale, title, subtitle, dark = false, guides = [] } = p;
  ctx.clearRect(0, 0, w, h);
  const ink = dark ? '#c3c2b7' : '#52514e';
  const { top, plotW, plotH } = layout(w, h, !!title, !!subtitle);
  if (title) {
    if (p.accent) { ctx.fillStyle = p.accent; ctx.fillRect(LEFT, 4, 8, 8); }
    ctx.fillStyle = dark ? '#f0efec' : '#1f1f1e';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(title, LEFT + (p.accent ? 12 : 0), 12);
  }
  if (subtitle) {
    ctx.fillStyle = ink;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(subtitle, LEFT, title ? 24 : 12);
  }
  const nRows = matrix.length;
  const nCols = matrix[0]?.length ?? 0;
  if (!nRows || !nCols) {
    ctx.fillStyle = ink; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No footprints in this window', LEFT + plotW / 2, top + plotH / 2);
    return;
  }
  const cw = plotW / nCols;
  const ch = plotH / nRows;
  // Rows: smallest size at the bottom (size axis increases upward).
  const rowY = (r: number) => top + (nRows - 1 - r) * ch;
  const blanks: Array<[number, number, number]> = [];  // row, first col, last col (exclusive)
  for (let r = 0; r < nRows; r++) {
    let runStart = -1;
    for (let c = 0; c <= nCols; c++) {
      const v = c < nCols ? matrix[r][c] : 0;
      if (c < nCols && v == null) { if (runStart < 0) runStart = c; continue; }
      if (runStart >= 0) { blanks.push([r, runStart, c]); runStart = -1; }
      if (c === nCols || v == null) continue;
      const [cr, cg, cb] = scaleRgb(v, scale, dark);
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fillRect(LEFT + c * cw, rowY(r), Math.ceil(cw) + 0.5, Math.ceil(ch) + 0.5);
    }
  }
  // Blank cells (too few footprints): hatched, so they read as "no estimate", never as a colour on the scale.
  if (blanks.length) {
    ctx.save();
    ctx.strokeStyle = dark ? 'rgba(195,194,183,0.35)' : 'rgba(82,81,78,0.28)';
    ctx.lineWidth = 1;
    for (const [r, c0, c1] of blanks) {
      const x0 = LEFT + c0 * cw, x1 = LEFT + c1 * cw, y0 = rowY(r), y1 = y0 + ch;
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      ctx.beginPath();
      for (let x = x0 - (y1 - y0); x < x1; x += 5) { ctx.moveTo(x, y1); ctx.lineTo(x + (y1 - y0), y0); }
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
  // Reference sizes.
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = dark ? 'rgba(240,239,236,0.45)' : 'rgba(31,31,30,0.35)';
  for (const g of guides) {
    if (g <= sizeMin || g >= sizeMax) continue;
    const y = top + plotH - ((g - sizeMin) / (sizeMax - sizeMin)) * plotH;
    ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(LEFT + plotW, y); ctx.stroke();
  }
  ctx.restore();
  // Size axis.
  ctx.fillStyle = ink;
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  const range = Math.max(1, sizeMax - sizeMin);
  const st = niceTicks(sizeMin, sizeMax, plotH, 45);
  for (const v of st.major) {
    const y = top + plotH - ((v - sizeMin) / range) * plotH;
    ctx.fillText(formatTick(v, st.step), LEFT - 3, Math.max(top + 7, y + 3));
  }
  ctx.save();
  ctx.translate(9, top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('Footprint size (bp)', 0, 0);
  ctx.restore();
  // Position axis: start, middle, end of the window.
  const end = start + nCols * posBin;
  const mid = Math.round((start + end) / 2);
  const axisY = top + plotH + 12;
  void mid; void axisLabelX;
  drawXTicks(ctx, { lo: start, hi: end, left: LEFT, width: plotW, y: top + plotH, ink, kind: start < 0 ? 'relative' : 'genomic' });
  ctx.textAlign = 'center';
  ctx.fillText(`Position (${sizeBin} x ${posBin} bp bins)`, LEFT + plotW / 2, axisY + 11);
  // Colour bar.
  const bx = LEFT + plotW + 6;
  const n = Math.max(2, Math.round(plotH));
  for (let i = 0; i < n; i++) {
    const t = 1 - i / (n - 1);
    let v: number;
    if (scale.kind === 'diverging' && scale.mid === 1) v = 2 ** (Math.log2(scale.hi) * (2 * t - 1));
    else v = scale.lo + (scale.hi - scale.lo) * t;
    const [cr, cg, cb] = scaleRgb(v, scale, dark);
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(bx, top + (i * plotH) / n, BAR_W, plotH / n + 0.5);
  }
  ctx.fillStyle = ink;
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(scale.hiLabel, bx + BAR_W + 2, top + 7);
  if (scale.midLabel) ctx.fillText(scale.midLabel, bx + BAR_W + 2, top + plotH / 2 + 3);
  ctx.fillText(scale.loLabel, bx + BAR_W + 2, top + plotH);
  // The unit of a log2 bar (its labels are -L / 0 / +L), so an exported plot says what they are.
  if (scale.kind === 'diverging' && scale.mid === 0 && top >= 10) ctx.fillText(scale.label?.startsWith('A − B') ? 'A − B' : 'log2', bx, top - 3);
}

export function SizeEnrichmentChart(props: SizeEnrichmentChartProps) {
  const { width, height, filename, dataTsv, testId } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => drawSizeEnrichment(ctx, w, h, props),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.matrix, props.scale, props.title, props.subtitle, props.dark, props.sizeMin, props.sizeMax, props.sizeBin, props.posBin, props.start, props.accent, props.guides]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFn(ctx, width, height);
  }, [drawFn, width, height]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { top, plotW, plotH } = layout(width, height, !!props.title, !!props.subtitle);
    const nRows = props.matrix.length;
    const nCols = props.matrix[0]?.length ?? 0;
    if (!nRows || !nCols || x < LEFT || x >= LEFT + plotW || y < top || y >= top + plotH) { setHover(null); return; }
    const c = Math.floor(((x - LEFT) / plotW) * nCols);
    const r = nRows - 1 - Math.floor(((y - top) / plotH) * nRows);
    const v = (props.rawMatrix ?? props.matrix)[r]?.[c];
    const size = props.sizeMin + r * props.sizeBin;
    const pos = props.start + c * props.posBin + 1;
    const value = v == null ? 'blank (too few footprints)' : `${props.valueLabel ?? 'value'} ${(+v.toPrecision(3)).toLocaleString()}`;
    setHover({ x, y, text: `${size}-${size + props.sizeBin - 1} bp at ${pos.toLocaleString()}: ${value}` });
  };

  const onClick = props.onPositionClick ? (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const { plotW } = layout(width, height, !!props.title, !!props.subtitle);
    const nCols = props.matrix[0]?.length ?? 0;
    if (!nCols || x < LEFT || x >= LEFT + plotW) return;
    const c = Math.floor(((x - LEFT) / plotW) * nCols);
    props.onPositionClick!(Math.round(props.start + (c + 0.5) * props.posBin));
  } : undefined;

  return (
    <div className="relative group" data-testid={testId ?? 'size-enrichment-chart'}>
      <canvas ref={canvasRef} style={{ width, height, cursor: onClick ? 'pointer' : undefined }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        onClick={onClick} />
      {hover && (
        <div className="pointer-events-none absolute z-20 whitespace-nowrap rounded bg-gray-900/90 px-1.5 py-0.5 text-[10px] text-white"
          style={{ left: Math.min(hover.x + 10, Math.max(0, width - 200)), top: Math.max(0, hover.y - 22) }} data-testid="size-enrichment-hover">
          {hover.text}
        </div>
      )}
      <ChartSaveButton canvasRef={canvasRef} filename={filename} drawFn={drawFn} width={width} height={height} dataTsv={dataTsv} />
    </div>
  );
}
