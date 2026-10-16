import { useRef, useEffect, useCallback } from 'react';
import { ChartSaveButton } from './ChartSaveButton';
import { ChartMaximizeButton } from './ChartMaximizeButton';
import { wilsonInterval } from '../../utils/statistics';
import { formatDonutChartTsv } from '../../utils/analysisExport';

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  width?: number;
  height?: number;
  innerRadiusFraction?: number; // 0.55 = donut, 0 = pie
  title?: string;
  filename?: string;
  /** Show read-level Wilson intervals for each mutually exclusive segment. */
  showConfidenceIntervals?: boolean;
}

export function drawDonut(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  segments: DonutSegment[],
  innerRadiusFraction: number,
  title: string | undefined,
) {
  ctx.clearRect(0, 0, width, height);

  // NaN / negative values would break the angles.
  segments = segments.map(seg => (Number.isFinite(seg.value) && seg.value > 0 ? seg : { ...seg, value: 0 }));
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const titleH = title ? 16 : 0;
  // The legend goes only when it leaves the ring room (a canvas arc with a
  // negative radius throws).
  const MIN_RADIUS = 16;
  const fullLegendH = segments.length <= 8 ? segments.length * 13 + 6 : 0;
  const radiusFor = (legend: number) => Math.min(width, height - titleH - legend) / 2 - 20;
  const legendH = fullLegendH > 0 && radiusFor(fullLegendH) >= MIN_RADIUS ? fullLegendH : 0;
  const chartArea = height - titleH - legendH;
  const cx = width / 2;
  const cy = titleH + chartArea / 2;
  const radius = Math.max(1, radiusFor(legendH));
  const innerRadius = radius * Math.min(Math.max(innerRadiusFraction, 0), 0.95);

  if (title) {
    ctx.fillStyle = '#666';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, cx, 11);
  }

  let angle = -Math.PI / 2;
  for (const seg of segments) {
    if (seg.value === 0) continue;
    const sweep = (seg.value / total) * Math.PI * 2;

    ctx.beginPath();
    ctx.moveTo(
      cx + innerRadius * Math.cos(angle),
      cy + innerRadius * Math.sin(angle),
    );
    ctx.arc(cx, cy, radius, angle, angle + sweep);
    ctx.arc(cx, cy, innerRadius, angle + sweep, angle, true);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();

    if (sweep > 0.25) {
      const mid = angle + sweep / 2;
      const lx = cx + (radius + 12) * Math.cos(mid);
      const ly = cy + (radius + 12) * Math.sin(mid);
      ctx.fillStyle = '#555';
      ctx.font = '9px sans-serif';
      ctx.textAlign = mid > Math.PI / 2 || mid < -Math.PI / 2 ? 'right' : 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(seg.label, lx, ly);
    }

    angle += sweep;
  }

  ctx.fillStyle = '#333';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total.toLocaleString(), cx, cy);

  if (legendH > 0) {
    let ly = height - legendH + 10;
    ctx.textBaseline = 'middle';
    for (const seg of segments) {
      ctx.fillStyle = seg.color;
      ctx.fillRect(8, ly - 4, 8, 8);
      ctx.fillStyle = '#666';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${seg.label}: ${seg.value}`, 20, ly);
      ly += 13;
    }
  }
}

export function DonutChart({
  segments,
  width = 200,
  height = 200,
  innerRadiusFraction = 0.55,
  title,
  filename = 'composition',
  showConfidenceIntervals = false,
}: DonutChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawDonut(ctx, w, h, segments, innerRadiusFraction, title);
  }, [segments, innerRadiusFraction, title]);

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
        dataTsv={() => formatDonutChartTsv(segments)}
      />
      <ChartMaximizeButton
        title={title || 'Donut Chart'}
        filename={filename}
        renderChart={(w, h) => (
          <DonutChart segments={segments} width={w} height={h}
            innerRadiusFraction={innerRadiusFraction} title={title} filename={filename}
            showConfidenceIntervals={showConfidenceIntervals} />
        )}
      />
      {showConfidenceIntervals && total > 0 && (
        <div className="mt-1 space-y-0.5 text-[11px] leading-tight text-gray-500 dark:text-gray-400">
          {segments.filter(segment => segment.value > 0).map(segment => {
            const ci = wilsonInterval(segment.value, total);
            return (
              <div key={segment.label} className="flex items-center justify-between gap-2">
                <span className="truncate">{segment.label}</span>
                <span className="whitespace-nowrap tabular-nums">
                  {((segment.value / total) * 100).toFixed(1)}% [{(ci.low * 100).toFixed(1)}–{(ci.high * 100).toFixed(1)}]
                </span>
              </div>
            );
          })}
          <div className="italic text-gray-400">95% Wilson CI; reads are the observation unit.</div>
        </div>
      )}
    </div>
  );
}
