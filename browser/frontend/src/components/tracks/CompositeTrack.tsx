import { logicalOffset } from '../../utils/scaledCoordinates';
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { setupHighDpiCanvas, useCanvasRenderVersion, useScheduledCanvasEffect } from '../../utils/canvasUtils';
import { useCanvasVisibility } from '../../hooks/useCanvasVisibility';
import { useResolvedSources } from '../../hooks/useSourceValues';
import { reduceSignalValues, shouldDrawSteppedSignal, signalPointLimit } from '../../utils/signalSampling';
import { logPerfTiming, nowMs } from '../../utils/perfDebug';
import type { CompositeTrack as CompositeTrackT, TrackSource } from '../../types/dataset';
import { drawTrackLabel } from '../../utils/trackLabels';
import { HoverHint, HoverLabel, useTrackLabels } from './TrackLabels';

interface Props {
  width: number;
  height: number;
  compositeId: string;
  datasetId?: string;       // panel context (used for metaprofile sources)
  stateKey?: string;        // the panel's state key (its own metaprofile)
  ownView?: boolean;        // the panel shows its own region (a copy at another locus)
  /** A panel with its own view (a copy at another locus): draw and zoom it, not the main view. */
  viewport?: { chrom: string; start: number; end: number };
  onViewportChange?: (start: number, end: number) => void;
  sidebarWidth?: number;    // align with reads track sidebar
}

/** Apply per-source negate + scale + (optional) log to a value. */
function transformValue(v: number, src: TrackSource, logScale: boolean): number {
  let x = v * (src.scale ?? 1);
  if (src.negate) x = -x;
  if (logScale) {
    // signed-log (IGV style): sign(x) * log10(|x|+1)
    const sign = x < 0 ? -1 : 1;
    x = sign * Math.log10(Math.abs(x) + 1);
  }
  return x;
}

/** Scan transformed values for [min,max], skipping NaN/null. */
function scanRange(values: number[], src: TrackSource, logScale: boolean): { min: number; max: number; any: boolean } {
  let mn = Infinity, mx = -Infinity, any = false;
  for (const raw of values) {
    if (raw == null || isNaN(raw)) continue;
    const v = transformValue(raw, src, logScale);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    any = true;
  }
  return { min: mn, max: mx, any };
}

interface ResolvedSource {
  source: TrackSource;
  values: number[];
  ready: boolean;
}

function CompositeTrackInner({
  composite, resolvedSources, width, height,
  sidebarWidth = 0, viewport, onViewportChange,
}: {
  composite: CompositeTrackT;
  resolvedSources: ResolvedSource[];
} & Omit<Props, 'compositeId'>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const storeChrom = useBrowserStore(s => s.chrom);
  const storeStart = useBrowserStore(s => s.start);
  const storeEnd = useBrowserStore(s => s.end);
  const chrom = viewport?.chrom ?? storeChrom;
  const start = viewport?.start ?? storeStart;
  const end = viewport?.end ?? storeEnd;
  const isReversed = useBrowserStore(s => s.isReversed);
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  const trackLabels = useTrackLabels();
  const canvasRenderVersion = useCanvasRenderVersion();
  const canvasVisible = useCanvasVisibility(canvasRef, exportInProgress);

  // Drag-to-zoom (ported from MetaTrack)
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartX, setDragStartX] = useState<number | null>(null);
  const [dragEndX, setDragEndX] = useState<number | null>(null);
  const canvasRectRef = useRef<DOMRect | null>(null);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      if (!canvasRectRef.current) return;
      const x = logicalOffset(e.clientX - canvasRectRef.current.left, width, canvasRectRef.current.width);
      setDragEndX(Math.max(0, Math.min(width, x)));
    };
    const onUp = (e: MouseEvent) => {
      if (!canvasRectRef.current || dragStartX === null || dragEndX === null) {
        setIsDragging(false); setDragStartX(null); setDragEndX(null);
        return;
      }
      const x = logicalOffset(e.clientX - canvasRectRef.current.left, width, canvasRectRef.current.width);
      const clamped = Math.max(0, Math.min(width, x));
      const left = Math.min(dragStartX, clamped);
      const right = Math.max(dragStartX, clamped);
      if (right - left > 5) {
        const regionSize = end - start;
        // Positions are drawn right of the cluster gutter.
        const plotWidth = Math.max(1, width - sidebarWidth);
        const leftFrac = Math.max(0, Math.min(1, (left - sidebarWidth) / plotWidth));
        const rightFrac = Math.max(0, Math.min(1, (right - sidebarWidth) / plotWidth));
        const g1 = Math.round(start + (isReversed ? 1 - rightFrac : leftFrac) * regionSize);
        const g2 = Math.round(start + (isReversed ? 1 - leftFrac : rightFrac) * regionSize);
        const newStart = Math.min(g1, g2);
        const newEnd = Math.max(g1, g2);
        if (newEnd - newStart >= 3) {
          if (onViewportChange) onViewportChange(newStart, newEnd);
          else useBrowserStore.getState().setViewport(chrom, newStart, newEnd);
        }
      }
      setIsDragging(false); setDragStartX(null); setDragEndX(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDragging, dragStartX, dragEndX, start, end, width, chrom, isReversed, sidebarWidth, onViewportChange]);

  // Render
  useScheduledCanvasEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvasVisible) return;
    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    const drawStarted = nowMs();
    const finish = (reason: string, sourceCount: number, valueCount: number) => {
      logPerfTiming('composite.draw', nowMs() - drawStarted, {
        reason,
        label: composite.label,
        sources: sourceCount,
        values: valueCount,
        scaleMode: composite.scaleMode,
        width,
        height,
      }, 25);
    };

    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, width, height);

    // Track label only — the panel header already shows the dataset label/color
    // above the whole panel; we don't redraw it on every track row. Drawn last,
    // over the profiles (on a pill; none in Clean view).
    const drawLabel = () => {
      ctx.fillStyle = '#666';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      drawTrackLabel(ctx, composite.label, 6, 11, trackLabels);
    };

    const visibleSources = resolvedSources.filter(rs => rs.source.visible && rs.values.length > 0);

    if (visibleSources.length === 0) {
      // "Computing..." or "No data" subdued state
      ctx.fillStyle = '#aaa';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      const someUnready = resolvedSources.some(rs => !rs.ready);
      drawTrackLabel(ctx, someUnready ? 'computing…' : 'No data', width / 2, height / 2, { ...trackLabels, pill: false });
      drawLabel();
      finish(someUnready ? 'computing' : 'empty', 0, 0);
      return;
    }
    const visibleValueCount = visibleSources.reduce((sum, source) => sum + source.values.length, 0);

    const padding = 4;
    const labelPad = 12;
    const plotTop = padding + labelPad;
    const plotBottom = height - padding;
    const plotHeight = Math.max(plotBottom - plotTop, 1);

    const trackWidth = width - sidebarWidth;
    ctx.save();

    if (composite.scaleMode === 'per-source') {
      // Each source gets its own range including zero: [0, max] for a positive
      // signal (anchored at the bottom, as MetaTrack), and a signed range for a
      // negated or negative one so it stays inside the plot.
      for (const { source, values } of visibleSources) {
        const r = scanRange(values, source, composite.logScale);
        const lo = r.any ? Math.min(0, r.min) : 0;
        let hi = r.any ? Math.max(0, r.max) : 0;
        if (hi - lo <= 0) hi = lo + 0.01;
        const yFor = (rawV: number) => {
          const v = transformValue(rawV, source, composite.logScale);
          return plotBottom - ((v - lo) / (hi - lo)) * plotHeight;
        };
        ctx.strokeStyle = source.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const drawValues = reduceSignalValues(values, signalPointLimit(trackWidth), isReversed);
        const len = drawValues.length;
        const stepped = shouldDrawSteppedSignal(len, trackWidth);
        const smoothDenom = Math.max(len - 1, 1);
        for (let i = 0; i < len; i++) {
          const raw = drawValues[i] ?? 0;
          const y = yFor(raw);
          if (stepped) {
            const x0 = sidebarWidth + (i / len) * trackWidth;
            const x1 = sidebarWidth + ((i + 1) / len) * trackWidth;
            if (i === 0) {
              ctx.moveTo(x0, y);
            } else {
              ctx.lineTo(x0, y);
            }
            ctx.lineTo(x1, y);
          } else {
            const x = sidebarWidth + (i / smoothDenom) * trackWidth;
            if (i === 0) {
              ctx.moveTo(sidebarWidth, y);
              continue;
            }
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
    } else {
      // Shared y-axis across all visible sources — anchor at zero.
      let dataMin = Infinity;
      let dataMax = -Infinity;
      if ((composite.scaleMode === 'manual' || composite.scaleMode === 'group')
          && composite.yMin != null && composite.yMax != null) {
        dataMin = composite.yMin;
        dataMax = composite.yMax;
      } else {
        // 'auto' (or 'group' before applyGroupAutoscale has stamped yMin/yMax — fallthrough to auto)
        for (const { source, values } of visibleSources) {
          const r = scanRange(values, source, composite.logScale);
          if (!r.any) continue;
          if (r.min < dataMin) dataMin = r.min;
          if (r.max > dataMax) dataMax = r.max;
        }
        if (!isFinite(dataMin)) { dataMin = 0; dataMax = 0; }
      }
      const minVal = Math.min(0, dataMin);
      const maxVal = Math.max(0, dataMax);
      const range = Math.max(maxVal - minVal, 1e-9);
      const yFor = (v: number) => plotBottom - ((v - minVal) / range) * plotHeight;
      const baselineY = yFor(0);

      // Zero baseline (only when negatives push it off the bottom)
      if (dataMin < 0) {
        ctx.strokeStyle = '#bbb';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(sidebarWidth, baselineY);
        ctx.lineTo(width, baselineY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      for (const { source, values } of visibleSources) {
        const drawValues = reduceSignalValues(values, signalPointLimit(trackWidth), isReversed);
        const len = drawValues.length;
        const stepped = shouldDrawSteppedSignal(len, trackWidth);
        const smoothDenom = Math.max(len - 1, 1);
        // Fill (anchored at zero baseline)
        ctx.fillStyle = source.color + '30';
        ctx.beginPath();
        ctx.moveTo(sidebarWidth, baselineY);
        for (let i = 0; i < len; i++) {
          const raw = drawValues[i] ?? 0;
          const v = transformValue(raw, source, composite.logScale);
          const y = yFor(v);
          if (stepped) {
            const x0 = sidebarWidth + (i / len) * trackWidth;
            const x1 = sidebarWidth + ((i + 1) / len) * trackWidth;
            ctx.lineTo(x0, y);
            ctx.lineTo(x1, y);
          } else {
            const x = sidebarWidth + (i / smoothDenom) * trackWidth;
            ctx.lineTo(x, y);
          }
        }
        ctx.lineTo(width, baselineY);
        ctx.closePath();
        ctx.fill();
        // Line
        ctx.strokeStyle = source.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
          const raw = drawValues[i] ?? 0;
          const v = transformValue(raw, source, composite.logScale);
          const y = yFor(v);
          if (stepped) {
            const x0 = sidebarWidth + (i / len) * trackWidth;
            const x1 = sidebarWidth + ((i + 1) / len) * trackWidth;
            if (i === 0) {
              ctx.moveTo(x0, y);
            } else {
              ctx.lineTo(x0, y);
            }
            ctx.lineTo(x1, y);
          } else {
            const x = sidebarWidth + (i / smoothDenom) * trackWidth;
            if (i === 0) {
              ctx.moveTo(sidebarWidth, y);
              continue;
            }
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
    }

    ctx.restore();

    // Drag-zoom overlay (screen coords)
    if (isDragging && dragStartX !== null && dragEndX !== null) {
      const left = Math.min(dragStartX, dragEndX);
      const right = Math.max(dragStartX, dragEndX);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.3)';
      ctx.fillRect(left, 0, right - left, height);
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, 0); ctx.lineTo(left, height);
      ctx.moveTo(right, 0); ctx.lineTo(right, height);
      ctx.stroke();
    }
    drawLabel();
    finish('standard', visibleSources.length, visibleValueCount);
  }, [composite, resolvedSources, width, height, sidebarWidth, isReversed, isDragging, dragStartX, dragEndX, canvasVisible, canvasRenderVersion, trackLabels], exportInProgress);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    canvasRectRef.current = rect;
    const x = logicalOffset(e.clientX - rect.left, e.currentTarget.clientWidth, rect.width);
    setIsDragging(true); setDragStartX(x); setDragEndX(x);
    e.preventDefault();
  }, []);

  const hasVisibleData = resolvedSources.some(rs => rs.source.visible && rs.values.length > 0);
  const emptyHint = hasVisibleData ? null : resolvedSources.some(rs => !rs.ready) ? 'computing…' : 'No data';
  return (
    <div style={{ width, height, overflow: 'hidden', position: 'relative' }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="block cursor-crosshair"
        onMouseDown={handleMouseDown}
        draggable={false}
        style={{ userSelect: 'none' }}
      />
      <HoverLabel>{composite.label}</HoverLabel>
      {emptyHint && <HoverHint>{emptyHint}</HoverHint>}
    </div>
  );
}

/**
 * Composite track renderer — one canvas, 1..N overlaid sources sharing a y-axis
 * (or per-source rescaling for metaprofile-style display). Replaces both
 * OrthogonalTrack (single bigwig) and MetaTrack (rule-based metaprofiles).
 */
export function CompositeTrack({ compositeId, ...rest }: Props) {
  const composite = useBrowserStore(useShallow(
    s => s.compositeTracks.find(c => c.id === compositeId)
  ));
  const sources = composite?.sources ?? [];
  // Single subscription resolves all source values together — stable hook
  // count when sources are added/removed.
  const refs = useMemo(() => sources.map(s => s.ref), [sources]);
  const resolved = useResolvedSources(refs, rest.datasetId, { stateKey: rest.stateKey, ownView: rest.ownView });
  const resolvedSources: ResolvedSource[] = useMemo(() => sources.map((src, i) => ({
    source: src,
    values: resolved[i]?.values ?? [],
    ready: resolved[i]?.ready ?? false,
  })), [sources, resolved]);

  if (!composite) return null;
  if (!composite.visible) return null;
  return (
    <CompositeTrackInner
      composite={composite}
      resolvedSources={resolvedSources}
      {...rest}
    />
  );
}
