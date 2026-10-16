import { useRef, useEffect, useCallback } from 'react';
import { ChartSaveButton } from './ChartSaveButton';
import type { FirePeak } from '../../types';
import { formatSignalProfileTsv } from '../../utils/analysisExport';

interface SignalProfileChartProps {
  signal: number[];
  thresholds: [number, number, number, number];
  thresholdLabels?: string[];
  peaks?: FirePeak[];
  color: string;
  width?: number;
  height?: number;
  filename?: string;
  /** Viewport start (genomic coords) — needed to map peak coords to signal bins */
  viewStart?: number;
  /** Viewport end (genomic coords) */
  viewEnd?: number;
}

const DEFAULT_THRESHOLD_LABELS = ['Strong', 'Medium', 'Weak', 'Rare'];

function drawSignalProfile(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  signal: number[],
  thresholds: [number, number, number, number],
  peaks: FirePeak[],
  color: string,
  viewStart: number,
  viewEnd: number | undefined,
) {
  ctx.clearRect(0, 0, width, height);

  if (!signal || signal.length === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No signal data', width / 2, height / 2);
    return;
  }

  const padL = 30;
  const padR = 4;
  const padT = 6;
  const padB = 16;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  let maxVal = 0;
  for (const v of signal) {
    if (v > maxVal) maxVal = v;
  }
  if (maxVal === 0) maxVal = 1;
  const maxThreshold = Math.max(...thresholds);
  if (maxVal < maxThreshold * 1.1) maxVal = maxThreshold * 1.1;

  const scaleX = plotW / signal.length;
  const scaleY = plotH / maxVal;

  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH);
  for (let i = 0; i < signal.length; i++) {
    const x = padL + i * scaleX;
    const y = padT + plotH - signal[i] * scaleY;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(padL + (signal.length - 1) * scaleX, padT + plotH);
  ctx.closePath();
  ctx.fillStyle = color + '22';
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < signal.length; i++) {
    const x = padL + i * scaleX;
    const y = padT + plotH - signal[i] * scaleY;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const thresholdColors = ['#ef4444', '#f59e0b', '#3b82f6', '#94a3b8'];
  for (let i = 0; i < thresholds.length; i++) {
    const tVal = thresholds[i];
    if (tVal > maxVal) continue;
    const y = padT + plotH - tVal * scaleY;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.strokeStyle = thresholdColors[i];
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = thresholdColors[i];
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'right';
    const pct = `${Math.round(tVal * 100)}%`;
    ctx.fillText(pct, padL - 2, y + 3);
  }

  ctx.fillStyle = '#666';
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(maxVal >= 1 ? maxVal.toFixed(1) : maxVal.toFixed(2), padL - 2, padT + 7);

  const barH = 5;
  const barY = height - padB + 3;
  const regionWidth = (viewEnd ?? signal.length) - viewStart;
  for (const peak of peaks) {
    const fracStart = (peak.start - viewStart) / regionWidth;
    const fracEnd = (peak.end - viewStart) / regionWidth;
    const x1 = padL + fracStart * plotW;
    const x2 = padL + fracEnd * plotW;
    const pw = Math.max(x2 - x1, 2);

    const layerOpacity = [0.8, 0.6, 0.45, 0.3][Math.min(peak.layer ?? 0, 3)];
    ctx.fillStyle = color + Math.round(layerOpacity * 255).toString(16).padStart(2, '0');
    ctx.fillRect(x1, barY, pw, barH);
  }
}

export function SignalProfileChart({
  signal,
  thresholds,
  thresholdLabels: _thresholdLabels = DEFAULT_THRESHOLD_LABELS,
  peaks = [],
  color,
  width = 300,
  height = 140,
  filename = 'signal_profile',
  viewStart = 0,
  viewEnd,
}: SignalProfileChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawSignalProfile(ctx, w, h, signal, thresholds, peaks, color, viewStart, viewEnd);
  }, [signal, thresholds, peaks, color, viewStart, viewEnd]);

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
        dataTsv={() => formatSignalProfileTsv({
          signal,
          thresholds,
          thresholdLabels: _thresholdLabels,
          peaks,
          viewStart,
          viewEnd,
        })}
      />
    </div>
  );
}
