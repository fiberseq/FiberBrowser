import { useEffect, useRef, useState } from 'react';
import { getTracksBatch } from '../../api/tracks';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { setupHighDpiCanvas, useCanvasRenderVersion, useScheduledCanvasEffect } from '../../utils/canvasUtils';
import { useCanvasVisibility } from '../../hooks/useCanvasVisibility';
import { reduceSignalValues, shouldDrawSteppedSignal, signalPointLimit } from '../../utils/signalSampling';
import { AnnotationTrack } from './AnnotationTrack';
import { logPerfTiming, nowMs } from '../../utils/perfDebug';
import type { AnnotationTrackStyle } from '../../types/dataset';
import { drawTrackLabel } from '../../utils/trackLabels';
import { HoverHint, HoverLabel, useTrackLabels } from './TrackLabels';
import { TRACK_BACKGROUND } from './TrackContainerConstants';

const EMPTY_VALUES: number[] = [];
const EMPTY_INTERVALS: Parameters<typeof AnnotationTrack>[0]['intervals'] = [];

interface Props {
  width: number;
  height: number;
  label: string;
  trackIndex?: number;
  values?: number[];
  color?: string;
}

export function OrthogonalTrack({ width, height, label, trackIndex, values: valuesProp, color = '#2563eb' }: Props) {
  const trackLabels = useTrackLabels();
  const { isReversed } = useBrowserStore(useShallow(s => ({
    isReversed: s.isReversed,
  })));
  const storeValues = useBrowserStore(s =>
    trackIndex === undefined ? undefined : s.orthogonalTrackData[trackIndex]?.values
  );
  const values = valuesProp ?? storeValues ?? EMPTY_VALUES;
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasVisible = useCanvasVisibility(canvasRef, exportInProgress);
  const canvasRenderVersion = useCanvasRenderVersion();

  useScheduledCanvasEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvasVisible) return;

    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    const drawStarted = nowMs();
    const finish = (reason: string, drawnValues = 0) => {
      logPerfTiming('orthogonal.draw', nowMs() - drawStarted, {
        reason,
        label,
        values: values.length,
        drawnValues,
        width,
        height,
      }, 25);
    };

    // Clear
    ctx.fillStyle = TRACK_BACKGROUND.signal;
    ctx.fillRect(0, 0, width, height);

    if (!values || values.length === 0) {
      ctx.fillStyle = '#999';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      drawTrackLabel(ctx, 'No data', width / 2, height / 2, { ...trackLabels, pill: false });
      finish('empty');
      return;
    }

    const padding = 4;
    const plotTop = padding + 12; // Leave room for label
    const plotBottom = height - padding;
    const plotHeight = Math.max(plotBottom - plotTop, 1);

    // Compute data range, anchored to zero so negatives render below the baseline.
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const v of values) {
      if (v == null || isNaN(v)) continue;
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    }
    if (!isFinite(dataMin)) { dataMin = 0; dataMax = 0; }
    const minVal = Math.min(0, dataMin);
    const maxVal = Math.max(0, dataMax);
    const range = Math.max(maxVal - minVal, 1e-9);
    const yFor = (v: number) => plotBottom - ((v - minVal) / range) * plotHeight;
    const baselineY = yFor(0);
    const drawValues = reduceSignalValues(values, signalPointLimit(width), isReversed);
    const drawLen = drawValues.length;
    const stepped = shouldDrawSteppedSignal(drawLen, width);
    const smoothDenom = Math.max(drawLen - 1, 1);

    // Draw label
    ctx.fillStyle = '#666';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    drawTrackLabel(ctx, label, 6, 11, trackLabels);

    // Zero baseline (only visible when negatives push it off the bottom edge)
    if (dataMin < 0) {
      ctx.strokeStyle = '#bbb';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(0, baselineY);
      ctx.lineTo(width, baselineY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw signal fill (anchored to zero baseline so +/- bars fill the right side)
    ctx.fillStyle = color + '30';  // 30 = ~19% opacity
    ctx.beginPath();
    ctx.moveTo(0, baselineY);

    for (let i = 0; i < drawLen; i++) {
      const val = drawValues[i] ?? 0;
      const y = yFor(val);
      if (stepped) {
        const x0 = (i / drawLen) * width;
        const x1 = ((i + 1) / drawLen) * width;
        ctx.lineTo(x0, y);
        ctx.lineTo(x1, y);
      } else {
        const x = (i / smoothDenom) * width;
        ctx.lineTo(x, y);
      }
    }

    ctx.lineTo(width, baselineY);
    ctx.closePath();
    ctx.fill();

    // Draw signal line
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let i = 0; i < drawLen; i++) {
      const val = drawValues[i] ?? 0;
      const y = yFor(val);
      if (stepped) {
        const x0 = (i / drawLen) * width;
        const x1 = ((i + 1) / drawLen) * width;
        if (i === 0) {
          ctx.moveTo(x0, y);
        } else {
          ctx.lineTo(x0, y);
        }
        ctx.lineTo(x1, y);
      } else {
        const x = (i / smoothDenom) * width;
        if (i === 0) {
          ctx.moveTo(0, y);
          continue;
        }
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    finish('standard', drawLen);

  }, [values, width, height, label, color, isReversed, canvasVisible, canvasRenderVersion, trackLabels], exportInProgress);

  return (
    <div style={{ width, height, overflow: 'hidden', position: 'relative' }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="block"
      />
      <HoverLabel>{label}</HoverLabel>
      {(!values || values.length === 0) && <HoverHint>No data</HoverHint>}
    </div>
  );
}

interface AnnotationProps {
  width: number;
  height: number;
  label: string;
  trackIndex: number;
  color?: string;
  trackType?: string;
  annotationStyle?: AnnotationTrackStyle;
}

/**
 * An annotation track (a motif track) in a panel with a view of its own: a contig a plugin pack built (its contig's
 * sequence, the insert included), a split panel at another locus. Fetched for that view and reference;
 * the main view's data would be another place (or another sequence).
 */
export function OwnViewAnnotationTrack({ width, height, label, trackIndex, color, trackType, annotationStyle, view, genome }: AnnotationProps & {
  view: { chrom: string; start: number; end: number };
  genome?: string | null;
}) {
  const [intervals, setIntervals] = useState<Parameters<typeof AnnotationTrack>[0]['intervals']>(EMPTY_INTERVALS);
  const filters = useBrowserStore(s => s.trackFilters[trackIndex]);
  const generation = useBrowserStore(s => s.refreshGeneration);
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      getTracksBatch([trackIndex], view.chrom, Math.floor(view.start), Math.ceil(view.end), undefined,
        filters?.length ? { [trackIndex]: filters } : undefined, { signal: ctrl.signal }, genome)
        .then(res => { if (!ctrl.signal.aborted) setIntervals((res.tracks?.[0]?.intervals as typeof intervals | undefined) ?? EMPTY_INTERVALS); })
        .catch(() => { if (!ctrl.signal.aborted) setIntervals(EMPTY_INTERVALS); });
    }, 150);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [trackIndex, view.chrom, view.start, view.end, genome, filters, generation]);
  return (
    <AnnotationTrack width={width} height={height} label={label} intervals={intervals} color={color}
      trackType={trackType} annotationStyle={annotationStyle} viewport={view} />
  );
}

export function OrthogonalAnnotationTrack({ width, height, label, trackIndex, color, trackType, annotationStyle }: AnnotationProps) {
  const intervals = useBrowserStore(s => s.orthogonalTrackData[trackIndex]?.intervals ?? EMPTY_INTERVALS);
  return (
    <AnnotationTrack
      width={width}
      height={height}
      label={label}
      intervals={intervals}
      color={color}
      trackType={trackType}
      annotationStyle={annotationStyle}
    />
  );
}
