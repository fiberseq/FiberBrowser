import { useContigCoordinates } from './axisCoordinates';
import { crosshairBottomAt, logicalOffset } from '../../utils/scaledCoordinates';
import { useRef, useEffect, useCallback, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { usePanelChroms } from '../../stores/panelGenomeStore';
import { useEphemeralStore } from '../../stores/ephemeralStore';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { formatRelativePosition } from '../../utils/coordinates';
import { findChromInfo, sameChrom } from '../../utils/chromAliases';
import { usePanOffsetTransform } from '../../hooks/usePanOffsetTransform';
import { TRACK_BACKGROUND } from './TrackContainerConstants';
import { primerTargetOverlayVisible } from '../controls/primer-design/primerTargetOverlay';
import { highlightRegion } from '../../utils/highlightActions';

interface Props {
  width: number;
  height: number;
  // Viewport override props for split view
  overrideChrom?: string;
  overrideStart?: number;
  overrideEnd?: number;
  // Custom viewport change handler for split view
  onViewportChange?: (start: number, end: number) => void;
  /** The panel's own reference (PanelConfig.genome): its chromosome sizes and topology. */
  genome?: string;
}

function formatPosition(bp: number, regionSize: number): string {
  // For small regions (< 100kb), show full numbers with commas
  if (regionSize < 100_000) {
    return bp.toLocaleString();
  }
  // For medium regions (100kb - 1Mb), show kb with 1 decimal
  if (regionSize < 1_000_000) {
    return `${(bp / 1_000).toFixed(1)}kb`;
  }
  // For large regions (1Mb - 10Mb), show Mb with 2 decimals
  if (regionSize < 10_000_000) {
    return `${(bp / 1_000_000).toFixed(2)}Mb`;
  }
  // For very large regions, show Mb with 1 decimal
  return `${(bp / 1_000_000).toFixed(1)}Mb`;
}

function calculateTickStep(size: number, pixelWidth: number): number {
  // Ensure minimum ~80px between ticks so labels don't overlap
  const minPixelSpacing = 80;
  const maxTicks = Math.max(2, Math.floor(pixelWidth / minPixelSpacing));
  const targetTicks = Math.min(6, maxTicks);

  const rawStep = size / targetTicks;

  // Round to a nice number (1, 2, 5, 10, 20, 50, 100, etc.)
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;

  let niceStep: number;
  if (normalized <= 1.5) niceStep = 1;
  else if (normalized <= 3) niceStep = 2;
  else if (normalized <= 7) niceStep = 5;
  else niceStep = 10;

  return niceStep * magnitude;
}

function circularRegionLabel(chrom: string, start: number, end: number, size: number, regionSize: number, compact = false): string {
  const normalize = (pos: number) => ((Math.round(pos) % size) + size) % size;
  // The end is exclusive: a view ending at the contig's length ends at `size`, not 0.
  const endPos = normalize(end - 1) + 1;
  const startLabel = compact ? formatPosition(normalize(start), regionSize) : normalize(start).toLocaleString();
  const endLabel = compact ? formatPosition(endPos, regionSize) : endPos.toLocaleString();
  const wraps = size > 0 && (start < 0 || end > size || Math.floor(start / size) !== Math.floor((end - 1) / size));
  return wraps ? `${chrom}:${startLabel}..${endLabel} (wrap)` : `${chrom}:${startLabel}-${endLabel} circular`;
}

export function AxisTrack({ width, height, overrideChrom, overrideStart, overrideEnd, onViewportChange, genome }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRenderVersion = useCanvasRenderVersion();
  const {
    storeStart, storeEnd, storeChrom, setViewport,
    primer, primerPanelOpen,
    isReversed, showRelativeCoords, relativeTSS, relativeGene,
  } = useBrowserStore(useShallow(s => ({
    storeStart: s.start, storeEnd: s.end, storeChrom: s.chrom, setViewport: s.setViewport,
    primer: s.primer, primerPanelOpen: primerTargetOverlayVisible(s.panels),
    isReversed: s.isReversed, showRelativeCoords: s.showRelativeCoords, relativeTSS: s.relativeTSS, relativeGene: s.relativeGene,
  })));
  // The panel's reference (its own on another assembly): circular contigs label as such.
  const chroms = usePanelChroms(genome);
  const setCrosshair = useEphemeralStore(s => s.setCrosshair);
  const useOverride = overrideStart !== undefined && overrideEnd !== undefined;
  usePanOffsetTransform(canvasRef, { enabled: !useOverride });
  
  // Use override values if provided (for split view)
  const start = overrideStart ?? storeStart;
  const end = overrideEnd ?? storeEnd;
  const chrom = overrideChrom ?? storeChrom;
  const chromInfo = findChromInfo(chroms, chrom);
  // A contig a plugin pack built: its own readouts.
  const contig = useContigCoordinates(chrom);
  const isCircular = Boolean(chromInfo?.circular);
  const chromSize = chromInfo?.size ?? 0;
  const normalizeCircular = useCallback((pos: number) => {
    if (!isCircular || chromSize <= 0) return pos;
    return ((Math.round(pos) % chromSize) + chromSize) % chromSize;
  }, [isCircular, chromSize]);
  
  // Drag-to-zoom state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartX, setDragStartX] = useState<number | null>(null);
  const [dragEndX, setDragEndX] = useState<number | null>(null);
  const canvasRectRef = useRef<DOMRect | null>(null);
  // Highlight instead of zoom: the toolbar's Highlight mode, or Shift held at the start of the drag.
  const highlightDrawMode = useBrowserStore(s => s.highlightDrawMode);
  const [highlightDrag, setHighlightDrag] = useState(false);

  const genomeToScreen = useCallback((pos: number) => {
    const frac = (pos - start) / (end - start);
    return isReversed ? (1 - frac) * width : frac * width;
  }, [start, end, width, isReversed]);
  const screenToGenome = useCallback((x: number) => {
    const frac = x / width;
    return Math.round(start + (isReversed ? 1 - frac : frac) * (end - start));
  }, [start, end, width, isReversed]);

  // Mouse handlers for drag-to-zoom
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    canvasRectRef.current = rect;
    const x = logicalOffset(e.clientX - rect.left, e.currentTarget.clientWidth, rect.width);
    setIsDragging(true);
    setHighlightDrag(highlightDrawMode || e.shiftKey);
    setDragStartX(x);
    setDragEndX(x);
    e.preventDefault();
  }, [highlightDrawMode]);

  // Document-level mouse handlers for drag continuation
  useEffect(() => {
    if (!isDragging) return;
    
    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!canvasRectRef.current) return;
      const x = logicalOffset(e.clientX - canvasRectRef.current.left, width, canvasRectRef.current.width);
      // Clamp to canvas bounds for visual feedback
      const clampedX = Math.max(0, Math.min(width, x));
      setDragEndX(clampedX);
    };
    
    const handleDocumentMouseUp = (e: MouseEvent) => {
      if (!canvasRectRef.current || dragStartX === null || dragEndX === null) {
        setIsDragging(false);
        setDragStartX(null);
        setDragEndX(null);
        return;
      }
      
      const x = logicalOffset(e.clientX - canvasRectRef.current.left, width, canvasRectRef.current.width);
      const clampedX = Math.max(0, Math.min(width, x));
      
      const left = Math.min(dragStartX, clampedX);
      const right = Math.max(dragStartX, clampedX);
      
      // Only zoom if drag distance is significant (> 5 pixels)
      if (right - left > 5) {
        const g1 = screenToGenome(left);
        const g2 = screenToGenome(right);
        const newStart = Math.min(g1, g2);
        const newEnd = Math.max(g1, g2);

        if (highlightDrag) {
          // A highlight on this panel's reference, shown in every panel on it.
          if (newEnd > newStart) highlightRegion({ chrom, start: newStart, end: newEnd, genome: genome ?? null });
        } else if (newEnd - newStart >= 3) {
          // Minimum zoom region of 3bp
          // Use custom handler if provided (split view), otherwise use global
          if (onViewportChange) {
            onViewportChange(newStart, newEnd);
          } else {
            setViewport(chrom, newStart, newEnd);
          }
        }
      }
      
      setIsDragging(false);
      setDragStartX(null);
      setDragEndX(null);
    };
    
    document.addEventListener('mousemove', handleDocumentMouseMove);
    document.addEventListener('mouseup', handleDocumentMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleDocumentMouseMove);
      document.removeEventListener('mouseup', handleDocumentMouseUp);
    };
  }, [isDragging, dragStartX, dragEndX, start, end, width, chrom, setViewport, onViewportChange, highlightDrag, genome]);

  // Track mouse position for crosshair
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = logicalOffset(e.clientX - rect.left, e.currentTarget.clientWidth, rect.width);

    // Set crosshair for coordinate display
    if (!isDragging) {
      const pos = screenToGenome(x);
      const useRelative = showRelativeCoords && relativeTSS !== null;
      const label = contig
        ? contig.positionLabel(pos)
        : useRelative
        ? formatRelativePosition(pos, relativeTSS!, relativeGene?.strand === '-')
        : `${chrom}:${normalizeCircular(pos).toLocaleString()}${isCircular ? ' circular' : ''}`;

      // Find TrackContainer for correct crosshair positioning across all panels
      const container = e.currentTarget.closest('[data-export-container]') ?? document.querySelector('[data-export-container]');
      const containerX = container
        ? logicalOffset(e.clientX - container.getBoundingClientRect().left, container.clientWidth, container.getBoundingClientRect().width)
        : x;

      // The line ends with the panels under the pointer (not at the window's bottom).
      setCrosshair(containerX, label, pos, container ? crosshairBottomAt(container, e.clientX) : null);
    }
  }, [screenToGenome, isDragging, showRelativeCoords, relativeTSS, relativeGene, chrom, normalizeCircular, isCircular, setCrosshair, contig]);

  const handleMouseLeave = useCallback(() => {
    setCrosshair(null, null, null);
  }, [setCrosshair]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    ctx.fillStyle = TRACK_BACKGROUND.axis;
    ctx.fillRect(0, 0, width, height);

    const size = end - start;
    const step = calculateTickStep(size, width);

    // Draw axis line
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();

    const useRelative = showRelativeCoords && relativeTSS !== null;

    // The locus at the left and the width at the right come first: tick labels
    // that would run into them are left out (audit L1: the locus crowded the first tick).
    let regionText: string;
    if (useRelative && relativeGene) {
      regionText = `${relativeGene.name} TSS ±${Math.round(size / 2000)}kb`;
    } else if (width < 250) {
      // Abbreviated format for narrow panels
      regionText = isCircular && chromSize > 0
        ? circularRegionLabel(chrom, start, end, chromSize, size, true)
        : `${chrom}:${formatPosition(start, size)}-${formatPosition(end, size)}`;
    } else {
      const dirIndicator = isReversed ? ' ◄ 3\'→5\'' : '';
      const regionLabel = isCircular && chromSize > 0
        ? circularRegionLabel(chrom, start, end, chromSize, size)
        : `${chrom}:${start.toLocaleString()}-${end.toLocaleString()}`;
      regionText = `${regionLabel}${dirIndicator}`;
    }
    if (contig) {
      // A pack's contig: where the view starts and ends in its own coordinates, and its decoration.
      regionText = contig.regionText(start, end);
      contig.decorate?.(ctx, { genomeToScreen, width, height, regionText });
    }
    const sizeStr = size >= 1000 ? `${(size/1000).toFixed(1)}kb` : `${size}bp`;
    ctx.font = 'bold 10px sans-serif';
    const regionRight = 4 + ctx.measureText(regionText).width;
    ctx.font = '9px sans-serif';
    const sizeLeft = width - 4 - ctx.measureText(sizeStr).width;

    // Draw ticks and labels
    ctx.fillStyle = '#666';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';

    let effectiveStep = step;
    if (useRelative) {
      // Pick from clean step sizes for relative coords, width-aware
      const niceSteps = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
      const targetTicks = Math.min(20, Math.max(2, Math.floor(width / 50)));
      const idealStep = size / targetTicks;
      effectiveStep = niceSteps.find(s => s >= idealStep) ?? niceSteps[niceSteps.length - 1];
    }

    // Align ticks to TSS in relative mode, otherwise to genome coordinates
    const tickBase = useRelative ? relativeTSS! : contig ? contig.tickBase : 0;
    const first = tickBase + Math.ceil((start - tickBase) / effectiveStep) * effectiveStep;
    for (let pos = first; pos < end; pos += effectiveStep) {
      const frac = (pos - start) / (end - start);
      const x = isReversed ? (1 - frac) * width : frac * width;

      // Skip if too close to edges
      if (x < 30 || x > width - 30) continue;

      // Tick
      ctx.beginPath();
      ctx.moveTo(x, height - 6);
      ctx.lineTo(x, height - 1);
      ctx.stroke();

      // Label, unless it would touch the locus or the width label
      const label = contig
        ? contig.tickLabel(pos, p => formatPosition(p, size))
        : useRelative
        ? formatRelativePosition(pos, relativeTSS!, relativeGene?.strand === '-')
        : formatPosition(normalizeCircular(pos), size);
      const half = ctx.measureText(label).width / 2;
      if (x - half < regionRight + 6 || x + half > sizeLeft - 6) continue;
      ctx.fillText(label, x, height - 10);
    }

    // Region info on left
    ctx.textAlign = 'left';
    ctx.fillStyle = '#333';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(regionText, 4, 12);

    // Region size on right
    ctx.textAlign = 'right';
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#666';
    ctx.fillText(sizeStr, width - 4, 12);
    
    // Draw primer target region (if set), only while the Primers panel is open.
    // A target can start at 0 (the first base of a contig or plasmid).
    if (primerPanelOpen && primer.targetStart != null && primer.targetEnd != null && primer.targetEnd > primer.targetStart
      && sameChrom(primer.targetChrom ?? storeChrom, chrom)) {
      // Screen left/right (a reversed view flips start and end).
      const [x1, x2] = [genomeToScreen(primer.targetStart), genomeToScreen(primer.targetEnd)].sort((a, b) => a - b);
      ctx.fillStyle = 'rgba(147, 51, 234, 0.2)'; // Purple
      ctx.fillRect(x1, 14, x2 - x1, height - 15);
      ctx.strokeStyle = '#9333ea';
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, 14, x2 - x1, height - 15);
    }

    // Draw designed primer (on the chromosome it was designed on)
    if (primer.pair && (!primer.pair.designChrom || sameChrom(primer.pair.designChrom, chrom))) {
      // An arrow from tail to tip on screen: points whichever way the view
      // runs (a reversed view flips it), with a 5 px head.
      const arrow = (tail: number, tip: number, color: string) => {
        const head = tip - 5 * Math.sign(tip - tail || 1);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(tail, 18);
        ctx.lineTo(head, 18);
        ctx.lineTo(head, 15);
        ctx.lineTo(tip, 21);
        ctx.lineTo(head, 27);
        ctx.lineTo(head, 24);
        ctx.lineTo(tail, 24);
        ctx.closePath();
        ctx.fill();
      };
      // Forward primer: 5'->3' toward its end (green); reverse primer toward its start (red).
      arrow(genomeToScreen(primer.pair.fwd_start), genomeToScreen(primer.pair.fwd_end), '#22c55e');
      arrow(genomeToScreen(primer.pair.rev_end), genomeToScreen(primer.pair.rev_start), '#ef4444');
    }
    // Draw drag-to-zoom selection overlay (screen coords, no pan offset)
    if (isDragging && dragStartX !== null && dragEndX !== null) {
      const left = Math.min(dragStartX, dragEndX);
      const right = Math.max(dragStartX, dragEndX);
      
      // Semi-transparent selection: blue to zoom, the Highlight action's teal to highlight
      ctx.fillStyle = highlightDrag ? 'rgba(15, 118, 110, 0.25)' : 'rgba(59, 130, 246, 0.3)';
      ctx.fillRect(left, 0, right - left, height);
      
      // Border lines
      ctx.strokeStyle = highlightDrag ? 'rgba(15, 118, 110, 0.85)' : 'rgba(59, 130, 246, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, 0);
      ctx.lineTo(left, height);
      ctx.moveTo(right, 0);
      ctx.lineTo(right, height);
      ctx.stroke();
      
      // Show bp range being selected
      const leftBp = screenToGenome(left);
      const rightBp = screenToGenome(right);
      const selectedSize = Math.abs(rightBp - leftBp);  // reversed view: left is the higher position
      if (selectedSize > 0) {
        ctx.fillStyle = highlightDrag ? '#0f766e' : '#3b82f6';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        const sizeStr = selectedSize >= 1000 ? `${(selectedSize/1000).toFixed(1)}kb` : `${selectedSize}bp`;
        ctx.fillText(`${highlightDrag ? 'Highlight' : 'Zoom to'} ${sizeStr}`, (left + right) / 2, height / 2 + 3);
      }
    }

  }, [start, end, chrom, width, height, primer, primerPanelOpen, genomeToScreen, isDragging, dragStartX, dragEndX, screenToGenome, isReversed, showRelativeCoords, relativeTSS, relativeGene, normalizeCircular, isCircular, canvasRenderVersion, highlightDrag, contig]);

  return (
    <div style={{ width, height, overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className={`block ${highlightDrawMode ? 'cursor-cell' : 'cursor-crosshair'}`}
        data-testid="axis-ruler"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        draggable={false}
        style={{ userSelect: 'none' }}
      />
    </div>
  );
}
