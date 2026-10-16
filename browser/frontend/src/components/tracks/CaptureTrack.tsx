import { useRef, useEffect, useCallback } from 'react';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { sameChrom } from '../../utils/chromAliases';
import { drawTrackLabel } from '../../utils/trackLabels';
import { HoverLabel, useTrackLabels } from './TrackLabels';
import { TRACK_BACKGROUND } from './TrackContainerConstants';

interface Props {
  width: number;
  height: number;
  overrideChrom?: string;
  overrideStart?: number;
  overrideEnd?: number;
}

export function CaptureTrack({ width, height, overrideChrom, overrideStart, overrideEnd }: Props) {
  const trackLabels = useTrackLabels();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRenderVersion = useCanvasRenderVersion();
  const storeChrom = useBrowserStore(s => s.chrom);
  const storeStart = useBrowserStore(s => s.start);
  const storeEnd = useBrowserStore(s => s.end);
  const isReversed = useBrowserStore(s => s.isReversed);
  const chrom = overrideChrom ?? storeChrom;
  const start = overrideStart ?? storeStart;
  const end = overrideEnd ?? storeEnd;
  const captureRegions = useBrowserStore(s => s.captureRegions);

  const regionWidth = end - start;
  const posToPixel = useCallback(
    (pos: number) => {
      const frac = (pos - start) / regionWidth;
      return (isReversed ? 1 - frac : frac) * width;
    },
    [start, regionWidth, width, isReversed],
  );

  // Regions on this chromosome overlapping the view
  const visibleRegions = captureRegions.filter(r => {
    if (r.chrom && !sameChrom(r.chrom, chrom)) return false;
    const p = r.padding ?? 0;
    const rStart = Math.max(0, r.start - p);
    const rEnd = r.end + p;
    return rEnd > start && rStart < end;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    // Background
    ctx.fillStyle = TRACK_BACKGROUND.capture; // indigo-50
    ctx.fillRect(0, 0, width, height);

    // Track label
    ctx.fillStyle = '#3730a3'; // indigo-800
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    drawTrackLabel(ctx, 'Capture', 4, 10, { ...trackLabels, pill: false });

    if (visibleRegions.length > 0) {
      ctx.fillStyle = '#6366f1'; // indigo-500
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'right';
      drawTrackLabel(ctx, `${captureRegions.length} region${captureRegions.length !== 1 ? 's' : ''}`, width - 4, 10, { ...trackLabels, pill: false });
    }

    const HEADER_H = 14;
    // The bars fill the row (fb-n11-tracks: a taller track was empty below a 12 px bar).
    const barH = Math.max(4, height - HEADER_H - 3);

    // Draw each capture region
    visibleRegions.forEach(r => {
      const rPad = r.padding ?? 0;
      // Left/right on screen (a reversed view flips start and end).
      const [coreX1, coreX2] = [posToPixel(r.start), posToPixel(r.end)].sort((a, b) => a - b);
      const [padX1, padX2] = [posToPixel(Math.max(0, r.start - rPad)), posToPixel(r.end + rPad)].sort((a, b) => a - b);
      const y = HEADER_H;

      // Padding extension (lighter)
      if (rPad > 0) {
        ctx.fillStyle = 'rgba(99, 102, 241, 0.15)'; // indigo-500 at 15%
        ctx.fillRect(padX1, y, padX2 - padX1, barH);
      }

      // Core region (solid indigo)
      ctx.fillStyle = 'rgba(99, 102, 241, 0.55)'; // indigo-500 at 55%
      ctx.fillRect(coreX1, y, Math.max(coreX2 - coreX1, 2), barH);

      // Border
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(coreX1, y, Math.max(coreX2 - coreX1, 2), barH);

      // Label if region is wide enough
      const coreW = coreX2 - coreX1;
      if (coreW > 30) {
        ctx.fillStyle = '#312e81'; // indigo-900
        const fontPx = Math.round(Math.min(12, Math.max(8, barH * 0.5)));
        ctx.font = `${fontPx}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.name, (coreX1 + coreX2) / 2, y + barH / 2);
        ctx.textBaseline = 'alphabetic';
      }
    });
  }, [width, height, start, end, visibleRegions, posToPixel, captureRegions.length, canvasRenderVersion, trackLabels]);

  return (
    <div style={{ width, height, position: 'relative' }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="block"
      />
      <HoverLabel style={{ top: 0, color: '#3730a3' }}>
        Capture{visibleRegions.length > 0 ? ` · ${captureRegions.length} region${captureRegions.length !== 1 ? 's' : ''}` : ''}
      </HoverLabel>
    </div>
  );
}
