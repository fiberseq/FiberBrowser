import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Interval } from '../../stores/browserStore';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import type { AnnotationTrackStyle, AnnotationScoreScale } from '../../types/dataset';
import { setupHighDpiCanvas, useCanvasRenderVersion, useScheduledCanvasEffect } from '../../utils/canvasUtils';
import { useCanvasVisibility } from '../../hooks/useCanvasVisibility';
import { drawTrackLabel } from '../../utils/trackLabels';
import { HoverHint, HoverLabel, useTrackLabels } from './TrackLabels';
import { TRACK_BACKGROUND } from './TrackContainerConstants';

// Color palette for different annotation types
const ANNOTATION_COLORS: Record<string, string> = {
  gene: '#1e40af',
  bed: '#2563eb',
  bigBed: '#7c3aed',
  motif: '#db2777',
  custom_motif: '#db2777',
  rmsk: '#ea580c',
  narrowPeak: '#dc2626',
  genePred: '#1e40af',
  default: '#059669',
};

interface Props {
  width: number;
  height: number;
  label: string;
  intervals: Interval[];
  color?: string;
  trackType?: string;
  annotationStyle?: AnnotationTrackStyle;
  /** A panel with a view of its own (a contig of its own): its span, not the main view's. */
  viewport?: { start: number; end: number };
}

const DEFAULT_MOTIF_STYLE: Required<AnnotationTrackStyle> = {
  scoreMin: 0,
  scoreMax: 1,
  scoreScale: 'linear',
  strandMode: 'split',
  showScoreLegend: true,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function normalizedIntervalScore(iv: Interval): number {
  if (typeof iv.score !== 'number' || !Number.isFinite(iv.score)) return 0.7;
  return clamp01(iv.score <= 1 ? iv.score : iv.score / 1000);
}

function applyScoreScale(value: number, scale: AnnotationScoreScale): number {
  const t = clamp01(value);
  if (scale === 'sqrt') return Math.sqrt(t);
  if (scale === 'square') return t * t;
  if (scale === 'log') return Math.log1p(t * 9) / Math.log(10);
  return t;
}

function motifScoreIntensity(iv: Interval, style: Required<AnnotationTrackStyle>): number | null {
  const score = normalizedIntervalScore(iv);
  const min = clamp01(style.scoreMin);
  const max = Math.max(min + 0.001, clamp01(style.scoreMax));
  if (score < min) return null;
  return applyScoreScale((score - min) / (max - min), style.scoreScale);
}

function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

function drawMotifScoreLegend(
  ctx: CanvasRenderingContext2D,
  width: number,
  baseColor: string,
  style: Required<AnnotationTrackStyle>,
) {
  if (!style.showScoreLegend || width < 190) return;
  const legendWidth = 46;
  const legendX = width - legendWidth - 6;
  const legendY = 4;
  const legendHeight = 5;
  ctx.save();
  for (let i = 0; i < legendWidth; i++) {
    const intensity = applyScoreScale(i / Math.max(legendWidth - 1, 1), style.scoreScale);
    ctx.globalAlpha = 0.18 + intensity * 0.74;
    ctx.fillStyle = baseColor;
    ctx.fillRect(legendX + i, legendY, 1, legendHeight);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(legendX, legendY, legendWidth, legendHeight);
  ctx.fillStyle = '#777';
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('score', legendX - 3, legendY + legendHeight + 1);
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(clamp01(style.scoreMin) * 100)}%`, legendX, legendY + 15);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(clamp01(style.scoreMax) * 100)}%`, legendX + legendWidth, legendY + 15);
  ctx.restore();
}

export function AnnotationTrack({ width, height, label, intervals, color, trackType = 'bed', annotationStyle, viewport }: Props) {
  const trackLabels = useTrackLabels();
  const { isReversed, mainStart, mainEnd } = useBrowserStore(useShallow(s => ({
    isReversed: s.isReversed, mainStart: s.start, mainEnd: s.end,
  })));
  const viewStart = viewport?.start ?? mainStart;
  const viewEnd = viewport?.end ?? mainEnd;
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasVisible = useCanvasVisibility(canvasRef, exportInProgress);
  const canvasRenderVersion = useCanvasRenderVersion();
  const baseColor = color || ANNOTATION_COLORS[trackType] || ANNOTATION_COLORS.default;
  const isMotifTrack = trackType === 'motif' || trackType === 'custom_motif';
  const motifStyle: Required<AnnotationTrackStyle> = {
    ...DEFAULT_MOTIF_STYLE,
    ...(annotationStyle ?? {}),
  };

  useScheduledCanvasEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvasVisible) return;

    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    // Background
    ctx.fillStyle = TRACK_BACKGROUND.annotation;
    ctx.fillRect(0, 0, width, height);

    // Label
    ctx.fillStyle = '#666';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    drawTrackLabel(ctx, label, 6, 11, trackLabels);
    if (isMotifTrack) drawMotifScoreLegend(ctx, width, baseColor, motifStyle);

    const visibleIntervals = isMotifTrack
      ? intervals.filter(iv => motifScoreIntensity(iv, motifStyle) !== null)
      : intervals;

    if (visibleIntervals.length === 0) {
      ctx.fillStyle = '#999';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      drawTrackLabel(ctx, 'No annotations', width / 2, height / 2, { ...trackLabels, pill: false });
      return;
    }

    const viewSize = viewEnd - viewStart;
    const padding = 14; // top padding for label
    const trackHeight = height - padding - 2;
    const bpToX = (bp: number) => {
      const frac = (bp - viewStart) / viewSize;
      return isReversed ? width * (1 - frac) : width * frac;
    };

    // Row-pack intervals to avoid overlap. In motif split-strand mode, keep a
    // single logical row and let plus/minus hits overdraw within their fixed
    // lanes; stacking creates duplicated-looking strand pairs.
    const rows: Interval[][] = [];
    const sortedIntervals = [...visibleIntervals].sort((a, b) => a.start - b.start);
    const splitMotifStrands = isMotifTrack && motifStyle.strandMode === 'split';
    if (splitMotifStrands) {
      rows.push(sortedIntervals);
    } else {
      for (const iv of sortedIntervals) {
        let placed = false;
        for (const row of rows) {
          const last = row[row.length - 1];
          if (iv.start >= last.end) {
            row.push(iv);
            placed = true;
            break;
          }
        }
        if (!placed) {
          rows.push([iv]);
        }
      }
    }

    // A taller track shows more rows (fb-n11-tracks: 5 rows of 12 px left a resized track mostly empty).
    const maxRows = Math.min(rows.length, isMotifTrack ? 4 : Math.max(5, Math.floor(trackHeight / 10)));
    const gap = 1;
    const rowHeight = isMotifTrack
      ? Math.max(2, Math.floor((trackHeight - gap * Math.max(0, maxRows - 1)) / maxRows))
      : Math.min(Math.floor(trackHeight / maxRows), 20);

    for (let r = 0; r < maxRows; r++) {
      const row = rows[r];
      const y = padding + r * (rowHeight + gap);
      if (isMotifTrack && motifStyle.strandMode === 'split') {
        const midY = y + rowHeight / 2;
        ctx.strokeStyle = '#d1d5db';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();
      }

      for (const iv of row) {
        const x1 = bpToX(Math.max(iv.start, viewStart));
        const x2 = bpToX(Math.min(iv.end, viewEnd));
        const left = Math.min(x1, x2);
        const rectWidth = Math.max(Math.abs(x2 - x1), 1);

        // For genePred with blocks (exons), draw gene model
        if (iv.blocks && iv.blocks.length > 0 && trackType === 'genePred') {
          // Draw thin line for intron
          const midY = y + rowHeight / 2;
          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(left, midY);
          ctx.lineTo(left + rectWidth, midY);
          ctx.stroke();

          // Draw blocks (exons)
          for (const block of iv.blocks) {
            const bx1 = bpToX(Math.max(block.start, viewStart));
            const bx2 = bpToX(Math.min(block.start + block.size, viewEnd));
            const bLeft = Math.min(bx1, bx2);
            const bWidth = Math.max(Math.abs(bx2 - bx1), 1);

            // Thick bar for CDS, thin for UTR
            const isCDS = iv.cdsStart !== undefined && iv.cdsEnd !== undefined &&
              block.start + block.size > iv.cdsStart && block.start < iv.cdsEnd;
            const blockHeight = isCDS ? rowHeight : rowHeight * 0.5;
            const blockY = y + (rowHeight - blockHeight) / 2;

            ctx.fillStyle = baseColor;
            ctx.fillRect(bLeft, blockY, bWidth, blockHeight);
          }

          // Strand arrows
          if (iv.strand && rectWidth > 20) {
            ctx.fillStyle = '#fff';
            ctx.font = `${Math.min(rowHeight - 2, 10)}px sans-serif`;
            ctx.textAlign = 'center';
            // Points 5'->3' on screen (a reversed view flips it, as for motifs).
            const arrow = (iv.strand === '+') !== isReversed ? '>' : '<';
            const step = 30;
            for (let ax = left + step; ax < left + rectWidth - 5; ax += step) {
              ctx.fillText(arrow, ax, midY + 3);
            }
          }
        } else if (isMotifTrack) {
          const intensity = motifScoreIntensity(iv, motifStyle);
          if (intensity === null) continue;
          const alpha = 0.2 + intensity * 0.75;
          const markerWidth = Math.max(rectWidth, 3);
          const center = left + rectWidth / 2;
          const markerLeft = center - markerWidth / 2;
          const strand = iv.strand === '+' || iv.strand === '-' ? iv.strand : null;
          const splitStrands = motifStyle.strandMode === 'split' && strand !== null;
          const halfHeight = Math.max(2, Math.floor((rowHeight - 1) / 2));
          const laneY = splitStrands && strand === '-' ? y + Math.ceil(rowHeight / 2) : y;
          const laneHeight = splitStrands ? halfHeight : rowHeight;

          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = baseColor;
          fillRoundedRect(ctx, markerLeft, laneY, markerWidth, laneHeight, Math.min(3, laneHeight / 2));
          ctx.restore();
          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 0.75;
          ctx.beginPath();
          ctx.moveTo(center, laneY);
          ctx.lineTo(center, laneY + laneHeight);
          ctx.stroke();

          if (motifStyle.strandMode !== 'none' && strand && markerWidth >= 8 && laneHeight >= 7) {
            const arrow =
              strand === '+'
                ? (isReversed ? '\u25c2' : '\u25b8')
                : (isReversed ? '\u25b8' : '\u25c2');
            const arrowSize = Math.max(8, Math.min(laneHeight - 1, markerWidth > 16 ? 12 : 10));
            ctx.save();
            ctx.font = `700 ${arrowSize}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(0,0,0,0.28)';
            ctx.strokeText(arrow, center, laneY + laneHeight / 2 + 0.5);
            ctx.fillStyle = '#fff';
            ctx.fillText(arrow, center, laneY + laneHeight / 2 + 0.5);
            ctx.restore();
          }
        } else {
          // Simple rectangle for BED/rmsk/etc.
          ctx.fillStyle = baseColor + '80'; // 50% opacity
          ctx.fillRect(left, y, rectWidth, rowHeight);
          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 0.5;
          ctx.strokeRect(left, y, rectWidth, rowHeight);

          // Strand indicator
          if (iv.strand && rectWidth > 8) {
            ctx.fillStyle = baseColor;
            ctx.font = `${Math.min(rowHeight - 2, 9)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText((iv.strand === '+') !== isReversed ? '>' : '<', left + rectWidth / 2, y + rowHeight - 2);
          }
        }

        // Name label (when zoomed in enough)
        if (iv.name && rectWidth > (isMotifTrack ? 50 : 30)) {
          ctx.fillStyle = '#333';
          ctx.font = `${Math.min(rowHeight - 3, 9)}px sans-serif`;
          ctx.textAlign = 'left';
          ctx.save();
          ctx.beginPath();
          ctx.rect(left, y, rectWidth, rowHeight);
          ctx.clip();
          ctx.fillText(iv.name, left + 2, y + rowHeight - 2);
          ctx.restore();
        }
      }
    }

    // Overflow indicator
    if (rows.length > maxRows) {
      ctx.fillStyle = '#999';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'right';
      drawTrackLabel(ctx, `+${rows.length - maxRows} more rows`, width - 4, height - 2, { ...trackLabels, pill: false });
    }

  }, [intervals, width, height, label, baseColor, trackType, annotationStyle, isReversed, viewStart, viewEnd, canvasVisible, canvasRenderVersion, trackLabels], exportInProgress);

  const empty = (isMotifTrack ? intervals.filter(iv => motifScoreIntensity(iv, motifStyle) !== null) : intervals).length === 0;
  return (
    <div style={{ width, height, position: 'relative' }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="block"
      />
      <HoverLabel>{label}</HoverLabel>
      {empty && <HoverHint>No annotations</HoverHint>}
    </div>
  );
}
