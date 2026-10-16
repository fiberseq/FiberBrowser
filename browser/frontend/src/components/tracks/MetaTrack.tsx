import { logicalOffset } from '../../utils/scaledCoordinates';
import { useRef, useEffect, useState, useCallback } from 'react';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { DEBUG } from '../../stores/utils';
import { getLayerColor } from '../../utils/layerColors';
import { logPerfTiming, nowMs } from '../../utils/perfDebug';
import { drawTrackLabel } from '../../utils/trackLabels';
import { HoverLabel, useTrackLabels } from './TrackLabels';

interface Props {
  width: number;
  height: number;
  datasetId?: string;
  profileKey?: string;  // the panel's state key: where ReadTrack stored its profile
  datasetLabel?: string;
  datasetTitle?: string;
  datasetColor?: string;
  sidebarWidth?: number;  // Width of cluster sidebar in ReadTrack (for alignment)
  /** A panel with its own view (a copy at another locus): draw and zoom it, not the main view. */
  viewport?: { chrom: string; start: number; end: number };
  onViewportChange?: (start: number, end: number) => void;
}

export function MetaTrack({ width, height, datasetId: datasetIdProp, profileKey, datasetLabel, datasetTitle, datasetColor, sidebarWidth = 0, viewport, onViewportChange }: Props) {
  const trackLabels = useTrackLabels();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRenderVersion = useCanvasRenderVersion();
  const datasetProfiles = useBrowserStore(s => s.datasetProfiles);
  const storeChrom = useBrowserStore(s => s.chrom);
  const storeStart = useBrowserStore(s => s.start);
  const storeEnd = useBrowserStore(s => s.end);
  const chrom = viewport?.chrom ?? storeChrom;
  const start = viewport?.start ?? storeStart;
  const end = viewport?.end ?? storeEnd;
  const loading = useBrowserStore(s => s.loading);
  const enabledMetaProfiles = useBrowserStore(s => s.enabledMetaProfiles);
  const activeColormap = useBrowserStore(s => s.activeColormap);
  const datasets = useBrowserStore(s => s.datasets);
  const isReversed = useBrowserStore(s => s.isReversed);

  // Derive datasetId from props or use first dataset from store
  const datasetId = datasetIdProp ?? datasets[0]?.id ?? 'default';

  // Get per-dataset profiles (new dynamic format)
  const dsProfiles = datasetProfiles[profileKey ?? datasetId] ?? { mod: [], fire: [], rules: {}, layers: {} };
  const modProfile = enabledMetaProfiles['mod'] ? (dsProfiles.mod ?? []) : [];
  const hasLayerFireProfile = Boolean(dsProfiles.layers?.fire?.length || dsProfiles.layers?.msp?.length);
  const fireProfile = enabledMetaProfiles['fire'] && !hasLayerFireProfile ? (dsProfiles.fire ?? []) : [];

  // Build list of enabled rule profiles with their colors
  const enabledRuleProfiles: { id: string; color: string; profile: number[] }[] = [];
  for (const rule of activeColormap.rules) {
    if (enabledMetaProfiles[rule.id] && dsProfiles.rules?.[rule.id]?.length > 0) {
      enabledRuleProfiles.push({ id: rule.id, color: rule.color, profile: dsProfiles.rules[rule.id] });
    }
  }
  // Per-layer profiles (one per data layer the dataset exposes — nuc, tf, FIRE/internal msp,
  // arbitrary custom). Coloring uses the canonical layer color.
  const enabledLayerProfiles: { name: string; color: string; profile: number[] }[] = [];
  if (dsProfiles.layers) {
    for (const [layerName, profile] of Object.entries(dsProfiles.layers)) {
      if (!profile || profile.length === 0) continue;
      const displayLayerName = layerName === 'msp' ? 'fire' : layerName;
      // For ns/nl primary footprints we expose either a 'nuc' or 'footprint'
      // layer toggle but never both — gate by whichever toggle the user sees.
      const toggleKey = (displayLayerName === 'footprint' && enabledMetaProfiles['nuc'] !== undefined)
        ? 'nuc' : displayLayerName;
      if (!enabledMetaProfiles[toggleKey]) continue;
      enabledLayerProfiles.push({
        name: displayLayerName,
        color: getLayerColor(displayLayerName),
        profile,
      });
    }
  }
  const hasAnyProfile =
    modProfile.length > 0 ||
    fireProfile.length > 0 ||
    enabledRuleProfiles.length > 0 ||
    enabledLayerProfiles.length > 0;
  
  // Drag-to-zoom state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartX, setDragStartX] = useState<number | null>(null);
  const [dragEndX, setDragEndX] = useState<number | null>(null);
  const canvasRectRef = useRef<DOMRect | null>(null);

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
        const regionSize = end - start;
        // Positions are drawn right of the cluster gutter.
        const plotWidth = Math.max(1, width - sidebarWidth);
        const leftFrac = Math.max(0, Math.min(1, (left - sidebarWidth) / plotWidth));
        const rightFrac = Math.max(0, Math.min(1, (right - sidebarWidth) / plotWidth));
        const g1 = Math.round(start + (isReversed ? 1 - rightFrac : leftFrac) * regionSize);
        const g2 = Math.round(start + (isReversed ? 1 - leftFrac : rightFrac) * regionSize);
        const newStart = Math.min(g1, g2);
        const newEnd = Math.max(g1, g2);

        // Minimum zoom region of 3bp
        if (newEnd - newStart >= 3) {
          if (onViewportChange) onViewportChange(newStart, newEnd);
          else useBrowserStore.getState().setViewport(chrom, newStart, newEnd);
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
  }, [isDragging, dragStartX, dragEndX, start, end, width, chrom, sidebarWidth, isReversed, onViewportChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    const drawStarted = nowMs();
    const finish = (reason: string) => {
      logPerfTiming('meta.draw', nowMs() - drawStarted, {
        reason,
        datasetId,
        width,
        height,
        ruleProfiles: enabledRuleProfiles.length,
        layerProfiles: enabledLayerProfiles.length,
        hasMod: modProfile.length > 0,
        hasFire: fireProfile.length > 0,
      }, 25);
    };

    // Clear
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, width, height);

    // Draw dataset label header if provided
    const headerHeight = datasetLabel ? 14 : 0;
    if (datasetLabel) {
      ctx.fillStyle = datasetColor || '#666';
      ctx.fillRect(0, 0, width, headerHeight - 2);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'left';
      drawTrackLabel(ctx, datasetLabel, 4, 10, { ...trackLabels, pill: false });
    }

    if (!hasAnyProfile) {
      finish('empty');
      return;
    }

    const padding = 4;
    const plotHeight = height - padding * 2 - headerHeight;

    // Calculate track width (excluding sidebar) to align with reads
    const trackWidth = width - sidebarWidth;

    if (DEBUG) console.log(`[META-TRACK ${datasetId}] Rendering: loading=${loading}, rules=${enabledRuleProfiles.length}, sidebarWidth=${sidebarWidth}`);

    // Helper to draw a profile line
    const drawProfile = (profile: number[], color: string) => {
      if (profile.length === 0) return;
      const maxVal = Math.max(...profile, 0.01);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const len = profile.length;
      for (let i = 0; i < len; i++) {
        const binIdx = isReversed ? (len - 1 - i) : i;
        const x = sidebarWidth + (i / (len - 1)) * trackWidth;
        const y = headerHeight + padding + plotHeight * (1 - profile[binIdx] / maxVal);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    // Draw each enabled rule profile with the rule's color
    for (const { color, profile } of enabledRuleProfiles) {
      drawProfile(profile, color);
    }

    // Draw enabled per-layer profiles (nuc, tf, FIRE/internal msp, custom) using the
    // canonical layer color so they match the read-track overlay colors.
    for (const { color, profile } of enabledLayerProfiles) {
      drawProfile(profile, color);
    }

    // Draw mod (orange)
    drawProfile(modProfile, '#e67e22');

    // Draw FIRE (bright orange)
    drawProfile(fireProfile, '#f97316');

    // Draw drag selection overlay (screen coords, no pan offset)
    if (isDragging && dragStartX !== null && dragEndX !== null) {
      const left = Math.min(dragStartX, dragEndX);
      const right = Math.max(dragStartX, dragEndX);
      
      // Semi-transparent blue selection
      ctx.fillStyle = 'rgba(59, 130, 246, 0.3)';
      ctx.fillRect(left, 0, right - left, height);
      
      // Border lines
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, 0);
      ctx.lineTo(left, height);
      ctx.moveTo(right, 0);
      ctx.lineTo(right, height);
      ctx.stroke();
    }
    finish('standard');
  }, [modProfile, fireProfile, enabledRuleProfiles, enabledLayerProfiles, hasAnyProfile, width, height, datasetLabel, datasetColor, isDragging, dragStartX, dragEndX, loading, datasetId, sidebarWidth, isReversed, canvasRenderVersion, trackLabels]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    canvasRectRef.current = rect;
    const x = logicalOffset(e.clientX - rect.left, e.currentTarget.clientWidth, rect.width);
    setIsDragging(true);
    setDragStartX(x);
    setDragEndX(x);
    e.preventDefault();
  }, []);

  return (
    <div style={{ width, height, overflow: 'hidden', position: 'relative' }}>
      {datasetLabel && <HoverLabel title={datasetTitle}>{datasetLabel}</HoverLabel>}
      <canvas
        ref={canvasRef}
        title={datasetTitle || datasetLabel}
        width={width}
        height={height}
        className="block cursor-crosshair"
        onMouseDown={handleMouseDown}
        draggable={false}
        style={{ userSelect: 'none' }}
      />
    </div>
  );
}
