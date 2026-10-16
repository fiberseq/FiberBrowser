import { logicalOffset } from '../../utils/scaledCoordinates';
import { setupHighDpiCanvas } from '../../utils/canvasUtils';
// ============================================================================
// MicroCTrack - Micro-C/Hi-C contact visualization track
// ============================================================================
// Unified track component with three display modes:
// - matrix: Triangular heatmap showing contacts within viewport
// - arc: Curved arcs connecting interacting regions
// - virtual4c: 1D profile of contact frequency from viewport center

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { sameChrom } from '../../utils/chromAliases';
import { useDafcStore } from '../../stores/dafcStore';
import { getMicrocMatrixStripUrl, getMicrocArcs, getVirtual4C, precomputeExpected, getAPA, getDafcMatrixData } from '../../api/dafc';
import type { APAResponse } from '../../types/dafc';
import type { ContactArc } from '../../types/dafc';
import { clampTrackX, matrixFocusForView, screenSelectionToGenomeRange } from '../../utils/contactMatrixMath';
import {
  getArcColor,
  findClosestArc,
  getArcCurveGeometry,
  getArcStrengthScale,
  getApaHeatmapColor,
  getMatrixValueRange,
  getOEColor,
  getViewpointScreenRange,
  mergeArcs,
  normalizeVirtual4CProfile,
  overlapsSelectedPeaks,
  prepareVirtual4CProfile,
  selectMicrocResolution,
  visibleArcsInViewport,
} from '../../utils/microcMath';
import { downloadTextFile, exportTimestamp, formatContactMatrixTsv, formatTsv, safeFilenamePart } from '../../utils/analysisExport';

interface MicroCTrackProps {
  width: number;
  height: number;
  sidebarWidth?: number;  // Width of cluster sidebar in ReadTrack (for alignment)
  overrideChrom?: string;
  overrideStart?: number;
  overrideEnd?: number;
  onViewportChange?: (start: number, end: number) => void;
  /** The panel this track is in: a matrix focus applies only in the panel it was drawn in. */
  panelId?: string;
}

export function MicroCTrack({
  width,
  height,
  sidebarWidth = 0,
  overrideChrom,
  overrideStart,
  overrideEnd,
  onViewportChange,
  panelId,
}: MicroCTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { chrom: storeChrom, start: storeStart, end: storeEnd, setViewport, getAllPeaks, selectedPeaks, isReversed, darkMode } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end, setViewport: s.setViewport, getAllPeaks: s.getAllPeaks, selectedPeaks: s.selectedPeaks, isReversed: s.isReversed, darkMode: s.darkMode,
  })));
  const chrom = overrideChrom ?? storeChrom;
  const start = overrideStart ?? storeStart;
  const end = overrideEnd ?? storeEnd;
  // Bumped whenever a contact map loads: a new map at the same view refetches.
  const dafcLoadGeneration = useDafcStore(s => s.dafcLoadGeneration);
  const {
    dafcLoaded,
    microcTrackMode,
    microcMinDistance,  // Minimum interaction distance
    microcMaxDistance,
    microcResolution,  // User-selected resolution (null = auto)
    arcStrengthFilter,  // Minimum arc strength to display
    arcStrengthFilterMax,  // Maximum arc strength to display
    dafcResolutions,  // Available resolutions from mcool
    filterByPeaks,  // Filter arcs to show only those overlapping selected peaks
    matrixScaling,  // Value scaling: linear, log, sqrt
    matrixColormap,  // Colormap: red, fall, hot, viridis, blues
    matrixNormalization,  // Matrix normalization: none, balanced, oe
    matrixFocusRegion: storedFocusRegion,  // Focus region for matrix zoom (any panel's)
    setMatrixFocusRegion,
    clearMatrixFocusRegion,
    arcDisplayMode,  // Arc display: individual, merged, or opacity
    arcMergeBinSize,  // Bin size for merging arcs
    arcNormalization,  // Arc normalization: none, oe (local), or oe_global
    arcMinCount,  // Minimum raw count filter (0 = use strength threshold)
    arcOEFloor,  // Minimum O/E ratio to display (only for O/E modes, 0 = show all)
    arcAccCorrect,  // Apply accessibility correction from fiber-seq
    arcAccLog,  // Use log-space accessibility correction
    v4cNormalization,  // Virtual 4C normalization: none or oe
    v4cSmoothing,  // Smoothing window size
    v4cMinCount,  // Minimum value threshold
    v4cViewpoint,  // Custom viewpoint for Virtual 4C
    clearV4cViewpoint,  // Clear custom viewpoint
  } = useDafcStore(useShallow(s => ({
    dafcLoaded: s.dafcLoaded,
    microcTrackMode: s.microcTrackMode,
    microcMinDistance: s.microcMinDistance,
    microcMaxDistance: s.microcMaxDistance,
    microcResolution: s.microcResolution,
    arcStrengthFilter: s.arcStrengthFilter,
    arcStrengthFilterMax: s.arcStrengthFilterMax,
    dafcResolutions: s.dafcResolutions,
    filterByPeaks: s.filterByPeaks,
    matrixScaling: s.matrixScaling,
    matrixColormap: s.matrixColormap,
    matrixNormalization: s.matrixNormalization,
    matrixFocusRegion: s.matrixFocusRegion,
    setMatrixFocusRegion: s.setMatrixFocusRegion,
    clearMatrixFocusRegion: s.clearMatrixFocusRegion,
    arcDisplayMode: s.arcDisplayMode,
    arcMergeBinSize: s.arcMergeBinSize,
    arcNormalization: s.arcNormalization,
    arcMinCount: s.arcMinCount,
    arcOEFloor: s.arcOEFloor,
    arcAccCorrect: s.arcAccCorrect,
    arcAccLog: s.arcAccLog,
    v4cNormalization: s.v4cNormalization,
    v4cSmoothing: s.v4cSmoothing,
    v4cMinCount: s.v4cMinCount,
    v4cViewpoint: s.v4cViewpoint,
    clearV4cViewpoint: s.clearV4cViewpoint,
  })));
  // A focus drawn in another panel, on another chromosome, or no longer in view
  // doesn't apply here (a focus saved before scoping applies wherever it overlaps).
  const matrixFocusRegion = useMemo(
    () => matrixFocusForView(storedFocusRegion, panelId, chrom, start, end),
    [storedFocusRegion, panelId, chrom, start, end],
  );

  // Track width excluding sidebar (to align with reads)
  const trackWidth = width - sidebarWidth;

  // A clicked viewpoint belongs to its chromosome: elsewhere (after navigating,
  // or in a panel on another chromosome) the view's centre is used instead.
  // One set before viewpoints recorded a chromosome was set in the main view.
  const activeViewpoint = useMemo(() => (
    v4cViewpoint && sameChrom(v4cViewpoint.chrom ?? storeChrom, chrom) ? v4cViewpoint : null
  ), [v4cViewpoint, storeChrom, chrom]);

  // Combine auto-detected and custom peaks for filtering
  // getAllPeaks is a stable function: recompute when the peaks themselves change.
  const peakRules = useBrowserStore(s => s.peakRules);
  const peaksByRule = useBrowserStore(s => s.peaksByRule);
  const allPeaks = useMemo(() => getAllPeaks(), [getAllPeaks, peakRules, peaksByRule]);
  // Selected peaks on this track's chromosome (a peak without one is on the main view's).
  const localSelectedPeaks = useMemo(() => new Set(allPeaks
    .filter(p => selectedPeaks.has(p.index) && sameChrom(p.chrom ?? storeChrom, chrom))
    .map(p => p.index)), [allPeaks, selectedPeaks, storeChrom, chrom]);

  // Select resolution: use user selection if set, otherwise auto-select
  const viewportSize = end - start;
  const autoResolution = useMemo(
    () => selectMicrocResolution(viewportSize, dafcResolutions),
    [viewportSize, dafcResolutions]
  );
  const effectiveResolution = microcResolution ?? autoResolution;

  const [allArcs, setAllArcs] = useState<ContactArc[]>([]);  // Unfiltered arcs
  const [arcActualNorm, setArcActualNorm] = useState<string>('none');  // What server actually used for arcs
  const [virtual4cData, setVirtual4cData] = useState<{
    profile: number[];
    resolution: number;
    viewpointStart: number;
    viewpointEnd: number;
  } | null>(null);
  const [matrixImageUrl, setMatrixImageUrl] = useState<string | null>(null);
  const [matrixFetchId, setMatrixFetchId] = useState(0);  // Increments on each fetch to force img remount
  const [apaData, setApaData] = useState<APAResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportingData, setExportingData] = useState(false);

  // Matrix drag-to-zoom state
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragCurrent, setDragCurrent] = useState<number | null>(null);
  const matrixRef = useRef<HTMLDivElement>(null);

  // Arc hover state for tooltip
  const [hoveredArc, setHoveredArc] = useState<ContactArc | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);

  // Filter arcs client-side based on strength range and peak overlap
  // Use useMemo instead of useEffect+useState to ensure filtering is always synchronous
  // When using global O/E with server-side merge, skip client-side processing for consistency
  const useServerMerge = arcNormalization === 'oe_global' && arcDisplayMode === 'merged';

  const arcs = useMemo(() => {
    const hasPeakFilter = filterByPeaks && localSelectedPeaks.size > 0;

    let filtered = allArcs;

    // Apply strength filters (only for non-stable mode where strength is 0-1)
    // In stable mode (global O/E), strength is actual O/E ratio
    if (!useServerMerge) {
      const hasMinFilter = arcStrengthFilter > 0;
      const hasMaxFilter = arcStrengthFilterMax < 1;
      if (hasMinFilter || hasMaxFilter) {
        filtered = filtered.filter(arc =>
          arc.strength >= arcStrengthFilter && arc.strength <= arcStrengthFilterMax
        );
      }
    }

    // Apply peak filter based on number of selected peaks:
    // - 1 peak: show arcs where at least one end overlaps (contacts FROM that peak)
    // - 2+ peaks: show arcs where both ends overlap selected peaks (contacts BETWEEN peaks)
    if (hasPeakFilter) {
      const startOverlaps = (arc: ContactArc) =>
        overlapsSelectedPeaks(arc.start, allPeaks, localSelectedPeaks, effectiveResolution);
      const endOverlaps = (arc: ContactArc) =>
        overlapsSelectedPeaks(arc.end, allPeaks, localSelectedPeaks, effectiveResolution);

      if (localSelectedPeaks.size === 1) {
        // Single peak: show all contacts from/to that peak
        filtered = filtered.filter(arc => startOverlaps(arc) || endOverlaps(arc));
      } else {
        // Multiple peaks: show contacts between peaks
        filtered = filtered.filter(arc => startOverlaps(arc) && endOverlaps(arc));
      }
    }

    // Client-side merging only when NOT using server-side merge
    if (arcDisplayMode === 'merged' && !useServerMerge && filtered.length > 0) {
      filtered = mergeArcs(filtered, arcMergeBinSize);
      // Re-normalize strengths after merging (based on merged counts)
      const maxCount = Math.max(...filtered.map(a => a.count));
      if (maxCount > 0) {
        filtered = filtered.map(arc => ({
          ...arc,
          strength: arc.count / maxCount,  // Normalize by count for merged arcs
        }));
      }
    }

    return filtered;
  }, [allArcs, arcStrengthFilter, arcStrengthFilterMax, filterByPeaks, localSelectedPeaks, allPeaks, effectiveResolution, arcDisplayMode, arcMergeBinSize, useServerMerge]);

  // Fetch data based on mode
  useEffect(() => {
    if (!dafcLoaded || !microcTrackMode) return;

    setLoading(true);
    let timeoutId: number | undefined;
    let cancelled = false;

    if (microcTrackMode === 'matrix') {
      // For matrix mode, we just set the image URL
      // Use trackWidth (excluding sidebar) for the image
      // Loading state will be cleared by onLoad handler on the image
      const url = getMicrocMatrixStripUrl(
        chrom,
        start,
        end,
        microcMaxDistance,
        trackWidth,
        height,
        effectiveResolution,
        matrixScaling,
        matrixColormap,
        matrixNormalization,
        matrixFocusRegion
      ) + `&map=${dafcLoadGeneration}`;
      setMatrixImageUrl(url);
      setMatrixFetchId(id => id + 1);  // Force img remount even if URL is identical
      // Timeout fallback: if image doesn't load in 15s, clear loading state
      timeoutId = window.setTimeout(() => setLoading(false), 15000);
    } else if (microcTrackMode === 'arc') {
      // Fetch arcs data - use server-side merge if in merged mode
      const useServerMerge = arcDisplayMode === 'merged';
      const useStableStrength = arcNormalization === 'oe_global';

      getMicrocArcs(chrom, start, end, {
        minDistance: microcMinDistance,
        maxDistance: microcMaxDistance,
        threshold: useStableStrength ? 1.0 : 0.02,  // For stable mode, threshold is O/E min (1.0 = above expected)
        maxArcs: 500,
        resolution: effectiveResolution,
        normalization: arcNormalization,
        minCount: arcMinCount,
        mergeBin: useServerMerge ? arcMergeBinSize : 0,  // Server-side merge
        stableStrength: useStableStrength,  // Return raw O/E for consistent coloring
        oeFloor: arcOEFloor,  // Minimum O/E ratio to display (server-side filter)
        accCorrect: arcAccCorrect,  // Apply accessibility correction from fiber-seq
        accLog: arcAccLog,  // Use log-space correction
      })
        .then((data) => {
          if (cancelled) return;  // a newer region's request owns the track now
          setAllArcs(data.arcs);
          setArcActualNorm(data.normalization || 'none');
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setAllArcs([]);
          setArcActualNorm('none');
          setLoading(false);
        });
    } else if (microcTrackMode === 'virtual4c') {
      // Use custom viewpoint if set, otherwise center of viewport
      let viewpointStart: number;
      let viewpointEnd: number;

      if (activeViewpoint) {
        // Use custom viewpoint (e.g., from clicking a peak)
        viewpointStart = activeViewpoint.start;
        viewpointEnd = activeViewpoint.end;
      } else {
        // Default: center of viewport
        const center = Math.round((start + end) / 2);
        const viewpointSize = Math.max(1000, Math.round(viewportSize * 0.02)); // 2% of viewport or 1kb min
        viewpointStart = center - Math.round(viewpointSize / 2);
        viewpointEnd = center + Math.round(viewpointSize / 2);
      }

      getVirtual4C(chrom, viewpointStart, viewpointEnd, start, end, effectiveResolution, v4cNormalization)
        .then((data) => {
          if (cancelled) return;
          setVirtual4cData({ profile: data.profile, resolution: data.resolution, viewpointStart, viewpointEnd });
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setVirtual4cData(null);
          setLoading(false);
        });
    } else if (microcTrackMode === 'apa') {
      // APA mode - aggregate peak analysis for selected peaks
      // Get all selected peaks from the combined peak list
      // Selection holds peak indices (rules are offset), not array positions.
      const selectedPeaksList = allPeaks.filter(p => localSelectedPeaks.has(p.index));

      if (selectedPeaksList.length < 2) {
        setApaData(null);
        setLoading(false);
        return;
      }

      // Convert peaks to simple {start, end} format
      const peakCoords = selectedPeaksList.map(p => ({ start: p.start, end: p.end }));

      getAPA(chrom, peakCoords, {
        window: 10000,  // 10kb window around each peak
        resolution: effectiveResolution,
        normalization: 'oe',  // Use O/E by default for better visualization
      })
        .then((data) => {
          if (cancelled) return;
          setApaData(data);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setApaData(null);
          setLoading(false);
        });
    }

    // Cleanup: clear timeout if set, and ignore this run's late responses
    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [dafcLoaded, dafcLoadGeneration, microcTrackMode, chrom, start, end, microcMinDistance, microcMaxDistance, trackWidth, height, effectiveResolution, viewportSize, matrixScaling, matrixColormap, matrixNormalization, matrixFocusRegion, arcNormalization, arcMinCount, arcOEFloor, arcAccCorrect, arcAccLog, arcDisplayMode, arcMergeBinSize, v4cNormalization, activeViewpoint, localSelectedPeaks, allPeaks]);

  // Precompute chromosome-wide expected values when using O/E global normalization
  // This runs in the background so values are cached before they're needed
  useEffect(() => {
    if (!dafcLoaded || arcNormalization !== 'oe_global') return;
    // Trigger background precomputation for current chromosome
    precomputeExpected(chrom, effectiveResolution);
  }, [dafcLoaded, dafcLoadGeneration, chrom, effectiveResolution, arcNormalization]);


  // Render arcs on canvas
  const renderArcs = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || microcTrackMode !== 'arc') return;

    // HiDPI and recorded for SVG/PDF figures, like the other tracks (fb-n11-tracks audit).
    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = darkMode ? '#1c1c1e' : '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (arcs.length === 0) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No significant arcs in viewport', width / 2, height / 2);
      return;
    }

    // Check if we're using stable O/E mode
    const isStableMode = arcNormalization === 'oe_global';

    // Visible arcs for rendering
    const visibleArcs = visibleArcsInViewport(arcs, start, end);
    const strengthScale = getArcStrengthScale(arcs, start, end, isStableMode);
    const geometryOptions = {
      start,
      end,
      sidebarWidth,
      trackWidth,
      height,
      isReversed,
      isStableMode,
    };
    const baselineY = height - 5;

    // For opacity mode: reduce base opacity when many arcs are present
    // Scale from 0.8 (few arcs) to 0.15 (many arcs)
    const arcCount = visibleArcs.length;
    const opacityModeBaseAlpha = arcDisplayMode === 'opacity'
      ? Math.max(0.15, Math.min(0.8, 1.0 - Math.log10(Math.max(1, arcCount)) * 0.35))
      : 1;  // Not used in other modes

    // Draw arcs - use trackWidth and offset by sidebarWidth
    for (const arc of arcs) {
      // Skip arcs entirely outside viewport
      if (arc.end < start || arc.start > end) continue;

      const curve = getArcCurveGeometry(arc, geometryOptions, strengthScale);

      // Skip if both ends are outside visible area
      if ((curve.x1 < sidebarWidth && curve.x2 < sidebarWidth) || (curve.x1 > width && curve.x2 > width)) continue;

      // Color based on mode - use O/E color scale for stable mode
      ctx.strokeStyle = isStableMode ? getOEColor(arc.strength) : getArcColor(arc.strength);

      if (arcDisplayMode === 'opacity') {
        // Opacity mode: reduced opacity, uniform line width
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = opacityModeBaseAlpha * (0.3 + curve.normalizedStrength * 0.7);
      } else if (arcDisplayMode === 'merged') {
        // Merged mode: line width based on count (log scale), opacity based on O/E
        const countFactor = Math.min(1, Math.log10(Math.max(1, arc.count)) / 2);  // 1->0, 10->0.5, 100->1
        ctx.lineWidth = 1.5 + countFactor * 3 + curve.normalizedStrength * 1.5;
        ctx.globalAlpha = 0.5 + curve.normalizedStrength * 0.5;
      } else {
        // Individual mode (default)
        ctx.lineWidth = 1 + curve.normalizedStrength * 2;
        ctx.globalAlpha = 0.4 + curve.normalizedStrength * 0.6;
      }

      // Draw quadratic bezier arc
      ctx.beginPath();
      ctx.moveTo(Math.max(sidebarWidth, Math.min(width, curve.x1)), baselineY);
      ctx.quadraticCurveTo(curve.midX, curve.controlY, Math.max(sidebarWidth, Math.min(width, curve.x2)), baselineY);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    // Draw baseline
    ctx.strokeStyle = darkMode ? '#4b5563' : '#d1d5db';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sidebarWidth, baselineY);
    ctx.lineTo(width, baselineY);
    ctx.stroke();
  }, [arcs, width, height, start, end, sidebarWidth, trackWidth, arcDisplayMode, arcNormalization, isReversed, darkMode]);

  // Handle click on arc to zoom to the contact region
  const handleArcClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || microcTrackMode !== 'arc' || arcs.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = logicalOffset(e.clientX - rect.left, canvas.clientWidth, rect.width);
    const clickY = logicalOffset(e.clientY - rect.top, canvas.clientHeight, rect.height);

    const closest = findClosestArc(arcs, { x: clickX, y: clickY }, {
      start,
      end,
      sidebarWidth,
      trackWidth,
      height,
      isReversed,
      isStableMode: arcNormalization === 'oe_global',
    });

    // If click is close enough to an arc (within 15 pixels), zoom to it
    if (closest && closest.distance < 15) {
      const closestArc = closest.arc;
      const arcSpan = closestArc.end - closestArc.start;
      const padding = Math.max(arcSpan * 0.2, 1000); // 20% padding or at least 1kb
      const newStart = Math.max(0, closestArc.start - padding);
      const newEnd = closestArc.end + padding;

      if (onViewportChange) onViewportChange(Math.round(newStart), Math.round(newEnd));
      else setViewport(chrom, Math.round(newStart), Math.round(newEnd));
    }
  }, [arcs, height, start, end, chrom, setViewport, onViewportChange, sidebarWidth, trackWidth, isReversed, arcNormalization]);

  // Handle mouse move on arc canvas to show tooltip
  const handleArcMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || microcTrackMode !== 'arc' || arcs.length === 0) {
      setHoveredArc(null);
      setHoverPosition(null);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const mouseX = logicalOffset(e.clientX - rect.left, canvas.clientWidth, rect.width);
    const mouseY = logicalOffset(e.clientY - rect.top, canvas.clientHeight, rect.height);

    const closest = findClosestArc(arcs, { x: mouseX, y: mouseY }, {
      start,
      end,
      sidebarWidth,
      trackWidth,
      height,
      isReversed,
      isStableMode: arcNormalization === 'oe_global',
    });

    // Show tooltip if close enough (within 10 pixels)
    if (closest && closest.distance < 10) {
      setHoveredArc(closest.arc);
      setHoverPosition({ x: mouseX, y: mouseY });
    } else {
      setHoveredArc(null);
      setHoverPosition(null);
    }
  }, [arcs, height, start, end, sidebarWidth, trackWidth, isReversed, arcNormalization]);

  const handleArcMouseLeave = useCallback(() => {
    setHoveredArc(null);
    setHoverPosition(null);
  }, []);

  const handleExportData = useCallback(async () => {
    if (!microcTrackMode) return;
    setExportingData(true);
    try {
      let content = '';
      if (microcTrackMode === 'matrix') {
        const result = await getDafcMatrixData(
          chrom, start, end, start, end, effectiveResolution, matrixNormalization,
        );
        content = formatContactMatrixTsv({
          matrix: result.matrix,
          chrom: result.chrom,
          xStart: result.x_start,
          xEnd: result.x_end,
          yStart: result.y_start,
          yEnd: result.y_end,
          resolution: result.resolution,
          normalization: result.normalization,
        });
      } else if (microcTrackMode === 'arc') {
        content = formatTsv([
          ['chrom', 'arc_index', 'start', 'end', 'distance', 'strength', 'count', 'oe_ratio', 'normalization', 'display_mode', 'resolution'],
          ...arcs.map((arc, index) => [
            chrom, index, arc.start, arc.end, arc.distance, arc.strength, arc.count,
            arc.oe_ratio, arcActualNorm, arcDisplayMode, effectiveResolution,
          ]),
        ]);
      } else if (microcTrackMode === 'virtual4c' && virtual4cData) {
        const prepared = prepareVirtual4CProfile(virtual4cData.profile, v4cMinCount, v4cSmoothing);
        const normalized = normalizeVirtual4CProfile(prepared).normalized;
        content = formatTsv([
          ['chrom', 'source_index', 'display_index', 'bin_start', 'bin_end', 'raw_value', 'prepared_value', 'display_normalized_value', 'viewpoint_start', 'viewpoint_end', 'resolution', 'normalization', 'smoothing', 'minimum'],
          ...virtual4cData.profile.map((rawValue, sourceIndex) => {
            const displayIndex = isReversed ? virtual4cData.profile.length - 1 - sourceIndex : sourceIndex;
            return [
              chrom, sourceIndex, displayIndex,
              start + sourceIndex * virtual4cData.resolution,
              Math.min(end, start + (sourceIndex + 1) * virtual4cData.resolution),
              rawValue, prepared[sourceIndex], normalized[sourceIndex],
              virtual4cData.viewpointStart, virtual4cData.viewpointEnd,
              virtual4cData.resolution, v4cNormalization, v4cSmoothing, v4cMinCount,
            ];
          }),
        ]);
      } else if (microcTrackMode === 'apa' && apaData) {
        const center = Math.floor(apaData.matrix_size / 2);
        content = formatTsv([
          ['row_index', 'row_offset_bp', 'column_index', 'column_offset_bp', 'value', 'apa_score', 'center_value', 'corner_mean', 'n_pairs', 'window', 'resolution', 'normalization'],
          ...apaData.matrix.flatMap((row, rowIndex) => row.map((value, columnIndex) => [
            rowIndex, (rowIndex - center) * apaData.resolution,
            columnIndex, (columnIndex - center) * apaData.resolution,
            value, apaData.apa_score, apaData.center_value, apaData.corner_mean,
            apaData.n_pairs, apaData.window, apaData.resolution, apaData.normalization,
          ])),
        ]);
      }
      if (content) {
        downloadTextFile(
          content,
          `contact_${microcTrackMode}_${safeFilenamePart(chrom)}_${start}-${end}_${exportTimestamp()}.tsv`,
          'text/tab-separated-values',
        );
      }
    } catch (error) {
      console.error('Contact-map TSV export failed:', error);
    } finally {
      setExportingData(false);
    }
  }, [apaData, arcActualNorm, arcDisplayMode, arcs, chrom, effectiveResolution, end, isReversed,
      matrixNormalization, microcTrackMode, start, v4cMinCount, v4cNormalization, v4cSmoothing, virtual4cData]);

  // Render virtual 4C on canvas
  const renderVirtual4C = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || microcTrackMode !== 'virtual4c' || !virtual4cData) return;

    // HiDPI and recorded for SVG/PDF figures, like the other tracks (fb-n11-tracks audit).
    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = darkMode ? '#1c1c1e' : '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const { profile: rawProfile, resolution, viewpointStart, viewpointEnd } = virtual4cData;

    if (rawProfile.length === 0) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No 4C data available', width / 2, height / 2);
      return;
    }

    const profile = prepareVirtual4CProfile(rawProfile, v4cMinCount, v4cSmoothing);

    // Draw viewpoint highlight (account for sidebarWidth)
    const viewpointRange = getViewpointScreenRange(
      viewpointStart,
      viewpointEnd,
      start,
      end,
      sidebarWidth,
      trackWidth,
      isReversed,
    );

    ctx.fillStyle = 'rgba(147, 51, 234, 0.2)';
    ctx.fillRect(viewpointRange.x1, 0, viewpointRange.width, height);

    // Normalize profile for display
    const { maxValue, normalized: normalizedProfile } = normalizeVirtual4CProfile(profile);
    if (maxValue === 0) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No signal above threshold', width / 2, height / 2);
      return;
    }

    // Draw profile line (offset by sidebarWidth, use trackWidth)
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const binWidth = trackWidth / profile.length;
    const margin = 10;
    const plotHeight = height - margin * 2;

    let started = false;
    for (let i = 0; i < profile.length; i++) {
      const srcIdx = isReversed ? (profile.length - 1 - i) : i;
      const x = sidebarWidth + i * binWidth + binWidth / 2;
      const y = margin + (1 - normalizedProfile[srcIdx]) * plotHeight;

      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Fill under curve
    ctx.fillStyle = 'rgba(147, 51, 234, 0.1)';
    ctx.beginPath();
    ctx.moveTo(sidebarWidth + binWidth / 2, height - margin);
    for (let i = 0; i < profile.length; i++) {
      const srcIdx = isReversed ? (profile.length - 1 - i) : i;
      const x = sidebarWidth + i * binWidth + binWidth / 2;
      const y = margin + (1 - normalizedProfile[srcIdx]) * plotHeight;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(sidebarWidth + trackWidth - binWidth / 2, height - margin);
    ctx.closePath();
    ctx.fill();

    // Label - show viewpoint info and settings
    ctx.fillStyle = '#7c3aed';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    const oeLabel = v4cNormalization === 'oe' ? ' [O/E]' : '';
    const smoothLabel = v4cSmoothing > 1 ? `, ${v4cSmoothing}pt smooth` : '';
    const threshLabel = v4cMinCount > 0 ? `, min=${v4cMinCount}` : '';
    const viewpointLabel = activeViewpoint?.label
      ? `Virtual 4C${oeLabel}: ${activeViewpoint.label}${smoothLabel}${threshLabel} (dbl-click to reset)`
      : `Virtual 4C${oeLabel}${smoothLabel}${threshLabel} (click peak to set viewpoint)`;
    ctx.fillText(viewpointLabel, 5, 12);
  }, [virtual4cData, width, height, start, end, sidebarWidth, trackWidth, activeViewpoint, v4cNormalization, v4cSmoothing, v4cMinCount, isReversed, darkMode]);

  // Render APA heatmap on canvas
  const renderAPA = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || microcTrackMode !== 'apa') return;

    // HiDPI and recorded for SVG/PDF figures, like the other tracks (fb-n11-tracks audit).
    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = darkMode ? '#1c1c1e' : '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (!apaData || !apaData.matrix || apaData.matrix.length === 0) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      const msg = localSelectedPeaks.size < 2
        ? 'Select at least 2 peaks for APA'
        : apaData?.error || 'No APA data';
      ctx.fillText(msg, width / 2, height / 2);
      return;
    }

    const { matrix, apa_score, n_pairs, matrix_size } = apaData;

    // Calculate cell size to fit the matrix in a square aspect ratio
    const margin = 40;  // Space for labels
    const availableSize = Math.min(trackWidth - margin, height - margin);
    const cellSize = availableSize / matrix_size;

    // Center the matrix horizontally
    const offsetX = sidebarWidth + (trackWidth - matrix_size * cellSize) / 2;
    const offsetY = (height - matrix_size * cellSize) / 2;

    const { minValue, range } = getMatrixValueRange(matrix);

    // Draw the heatmap
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) {
        ctx.fillStyle = getApaHeatmapColor(matrix[i][j], minValue, range);
        ctx.fillRect(
          offsetX + j * cellSize,
          offsetY + i * cellSize,
          cellSize + 0.5,  // Slight overlap to avoid gaps
          cellSize + 0.5
        );
      }
    }

    // Draw center crosshair
    const centerIdx = Math.floor(matrix_size / 2);
    const centerX = offsetX + centerIdx * cellSize + cellSize / 2;
    const centerY = offsetY + centerIdx * cellSize + cellSize / 2;

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(centerX, offsetY);
    ctx.lineTo(centerX, offsetY + matrix_size * cellSize);
    ctx.moveTo(offsetX, centerY);
    ctx.lineTo(offsetX + matrix_size * cellSize, centerY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw border
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(offsetX, offsetY, matrix_size * cellSize, matrix_size * cellSize);

    // Draw labels
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`APA Score: ${apa_score.toFixed(2)}`, 5, 14);
    ctx.font = '10px sans-serif';
    ctx.fillText(`${n_pairs} peak pairs, ${localSelectedPeaks.size} peaks selected`, 5, 26);

    // Draw axis labels
    ctx.fillStyle = '#6b7280';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Peak i', offsetX + matrix_size * cellSize / 2, height - 5);
    ctx.save();
    ctx.translate(15, offsetY + matrix_size * cellSize / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Peak j', 0, 0);
    ctx.restore();

  }, [apaData, width, height, sidebarWidth, trackWidth, localSelectedPeaks, darkMode]);

  // Render based on mode
  useEffect(() => {
    if (microcTrackMode === 'arc') {
      renderArcs();
    } else if (microcTrackMode === 'virtual4c') {
      renderVirtual4C();
    } else if (microcTrackMode === 'apa') {
      renderAPA();
    }
  }, [microcTrackMode, renderArcs, renderVirtual4C, renderAPA]);

  // Matrix drag-to-zoom handlers
  const handleMatrixMouseDown = useCallback((e: React.MouseEvent) => {
    if (!matrixRef.current) return;
    const rect = matrixRef.current.getBoundingClientRect();
    const x = clampTrackX(logicalOffset(e.clientX - rect.left, width, rect.width), sidebarWidth, width);
    setDragStart(x);
    setDragCurrent(x);
  }, [sidebarWidth, width]);

  const handleMatrixMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragStart === null || !matrixRef.current) return;
    const rect = matrixRef.current.getBoundingClientRect();
    const x = clampTrackX(logicalOffset(e.clientX - rect.left, width, rect.width), sidebarWidth, width);
    setDragCurrent(x);
  }, [dragStart, sidebarWidth, width]);

  const handleMatrixMouseUp = useCallback(() => {
    if (dragStart === null || dragCurrent === null) {
      setDragStart(null);
      setDragCurrent(null);
      return;
    }

    const minX = Math.min(dragStart, dragCurrent);
    const maxX = Math.max(dragStart, dragCurrent);
    const selWidth = maxX - minX;

    // Only set focus if selection is at least 10 pixels wide
    if (selWidth >= 10) {
      setMatrixFocusRegion({
        ...screenSelectionToGenomeRange(minX, maxX, start, end, sidebarWidth, trackWidth, isReversed),
        chrom,
        ...(panelId ? { panelId } : {}),
      });
    }

    setDragStart(null);
    setDragCurrent(null);
  }, [dragStart, dragCurrent, start, end, chrom, panelId, trackWidth, sidebarWidth, isReversed, setMatrixFocusRegion]);

  const handleMatrixMouseLeave = useCallback(() => {
    // Cancel drag if mouse leaves the element
    setDragStart(null);
    setDragCurrent(null);
  }, []);

  const handleMatrixDoubleClick = useCallback(() => {
    // Double-click clears the focus region
    clearMatrixFocusRegion();
  }, [clearMatrixFocusRegion]);

  // Handle double-click on virtual 4C to clear custom viewpoint
  const handleV4cDoubleClick = useCallback(() => {
    if (v4cViewpoint) {
      clearV4cViewpoint();
    }
  }, [v4cViewpoint, clearV4cViewpoint]);

  // Calculate selection overlay position
  const selectionLeft = dragStart !== null && dragCurrent !== null
    ? Math.min(dragStart, dragCurrent)
    : 0;
  const selectionWidth = dragStart !== null && dragCurrent !== null
    ? Math.abs(dragCurrent - dragStart)
    : 0;

  // Don't render if no mode selected or no cooler loaded
  if (!dafcLoaded || !microcTrackMode) {
    return null;
  }

  // Calculate focus region overlay position (if set) - account for sidebarWidth
  // (reversed view: the region's end is on the left)
  const focusOverlay = matrixFocusRegion ? {
    left: sidebarWidth + ((isReversed ? end - matrixFocusRegion.end : matrixFocusRegion.start - start) / (end - start)) * trackWidth,
    width: ((matrixFocusRegion.end - matrixFocusRegion.start) / (end - start)) * trackWidth,
  } : null;

  // Matrix mode - render image directly with drag-to-focus
  if (microcTrackMode === 'matrix') {
    return (
      <div
        ref={matrixRef}
        className={`relative border-b select-none ${darkMode ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'}`}
        style={{ width, height, cursor: 'crosshair' }}
        onMouseDown={handleMatrixMouseDown}
        onMouseMove={handleMatrixMouseMove}
        onMouseUp={handleMatrixMouseUp}
        onMouseLeave={handleMatrixMouseLeave}
        onDoubleClick={handleMatrixDoubleClick}
      >
        {/* Always render the image if URL exists - use onLoad/onError to track loading */}
        {/* key prop forces new img element when URL changes, ensuring onLoad fires */}
        {matrixImageUrl && (
          <img
            key={`${matrixImageUrl}:${matrixFetchId}`}
            src={matrixImageUrl}
            alt="Contact matrix strip"
            draggable={false}
            onLoad={() => setLoading(false)}
            onError={() => setLoading(false)}
            style={{
              position: 'absolute',
              left: sidebarWidth,
              top: 0,
              width: trackWidth,
              height,
              display: 'block',
              imageRendering: 'auto',
              pointerEvents: 'none',
              opacity: loading ? 0 : 1,
              transition: 'opacity 0.15s',
              // The server draws it forward; mirror it like the other tracks in a reversed view.
              transform: isReversed ? 'scaleX(-1)' : undefined,
            }}
          />
        )}
        {/* Loading overlay */}
        {loading && (
          <div className={`absolute inset-0 flex items-center justify-center ${darkMode ? 'bg-gray-900' : 'bg-gray-50'}`}>
            <span className="text-gray-400 text-sm">Loading matrix...</span>
          </div>
        )}
        {/* Selection overlay while dragging */}
        {dragStart !== null && selectionWidth > 0 && (
          <div
            className="absolute top-0 bottom-0 bg-blue-500/30 border-x-2 border-blue-500"
            style={{
              left: selectionLeft,
              width: selectionWidth,
            }}
          />
        )}
        {/* Focus region indicator (when not dragging) */}
        {focusOverlay && dragStart === null && (
          <div
            className="absolute top-0 bottom-0 border-x-2 border-green-500 pointer-events-none"
            style={{
              left: focusOverlay.left,
              width: focusOverlay.width,
            }}
          />
        )}
        <div className={`absolute top-1 left-2 text-xs px-1 rounded pointer-events-none ${darkMode ? 'text-gray-400 bg-gray-900/80' : 'text-gray-500 bg-white/80'}`}>
          Contact Matrix ({Math.round(microcMaxDistance / 1000)}kb max, {effectiveResolution >= 1000 ? `${effectiveResolution/1000}kb` : `${effectiveResolution}bp`} res)
          {matrixFocusRegion ? ' [focused - dbl-click to reset]' : ' - drag to focus'}
        </div>
        <button
          type="button"
          onClick={() => void handleExportData()}
          disabled={exportingData}
          className="absolute right-2 top-1 z-10 rounded bg-black/45 px-1.5 py-0.5 text-[11px] text-white hover:bg-black/65 disabled:opacity-50"
          title="Download the numeric matrix behind this track"
        >
          {exportingData ? 'TSV…' : 'TSV'}
        </button>
      </div>
    );
  }

  // Arc and Virtual 4C modes - render canvas
  return (
    <div
      className={`relative border-b ${darkMode ? 'bg-[#1c1c1e] border-gray-700' : 'bg-white border-gray-200'}`}
      style={{ width, height }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onClick={microcTrackMode === 'arc' ? handleArcClick : undefined}
        onDoubleClick={microcTrackMode === 'virtual4c' ? handleV4cDoubleClick : undefined}
        onMouseMove={microcTrackMode === 'arc' ? handleArcMouseMove : undefined}
        onMouseLeave={microcTrackMode === 'arc' ? handleArcMouseLeave : undefined}
        style={{
          display: 'block',
          cursor: microcTrackMode === 'arc' ? 'pointer' : (v4cViewpoint ? 'pointer' : 'default'),
        }}
        title={microcTrackMode === 'virtual4c' && v4cViewpoint ? 'Double-click to reset viewpoint' : undefined}
      />
      {loading && (
        <div className={`absolute inset-0 flex items-center justify-center ${darkMode ? 'bg-[#1c1c1e]/80' : 'bg-white/80'}`}>
          <span className="text-gray-400 text-sm">Loading...</span>
        </div>
      )}
      {microcTrackMode === 'arc' && (
        <div className={`absolute top-1 left-2 text-xs px-1 rounded ${darkMode ? 'text-gray-400 bg-gray-900/80' : 'text-gray-500 bg-white/80'}`}>
          Contact Arcs ({arcs.length}{(arcStrengthFilter > 0 || arcStrengthFilterMax < 1 || (filterByPeaks && localSelectedPeaks.size > 0)) ? `/${allArcs.length}` : ''}, {effectiveResolution >= 1000 ? `${effectiveResolution/1000}kb` : `${effectiveResolution}bp`} res{arcNormalization === 'oe_global' ? (arcActualNorm === 'oe_global' ? ', O/E(chr)' : ', O/E(local⚠)') : arcNormalization === 'oe' ? ', O/E' : ''}{arcMinCount > 0 ? `, n≥${arcMinCount}` : ''}{microcMinDistance > 0 ? `, >${microcMinDistance >= 1000 ? `${microcMinDistance/1000}kb` : `${microcMinDistance}bp`}` : ''}{filterByPeaks && localSelectedPeaks.size > 0 ? ', peaks' : ''})
        </div>
      )}
      <button
        type="button"
        onClick={() => void handleExportData()}
        disabled={exportingData || (microcTrackMode === 'virtual4c' && !virtual4cData) || (microcTrackMode === 'apa' && !apaData)}
        className="absolute right-2 top-1 z-10 rounded bg-black/45 px-1.5 py-0.5 text-[11px] text-white hover:bg-black/65 disabled:opacity-50"
        title="Download the exact numeric values behind this contact track"
      >
        {exportingData ? 'TSV…' : 'TSV'}
      </button>
      {/* Tooltip for hovered arc */}
      {hoveredArc && hoverPosition && (
        <div
          className="absolute bg-gray-900 text-white text-xs px-2 py-1 rounded shadow-lg pointer-events-none z-10"
          style={{
            left: Math.min(hoverPosition.x + 10, width - 150),
            top: Math.max(hoverPosition.y - 50, 5),
          }}
        >
          <div className="font-semibold">{hoveredArc.count} contacts</div>
          <div className="text-gray-300">
            {Math.round(hoveredArc.distance / 1000)}kb apart
          </div>
          {hoveredArc.oe_ratio != null && (
            <div className={`font-medium ${hoveredArc.oe_ratio > 1.5 ? 'text-yellow-400' : hoveredArc.oe_ratio > 1 ? 'text-gray-200' : 'text-blue-300'}`}>
              O/E: {hoveredArc.oe_ratio.toFixed(2)}
              {hoveredArc.oe_ratio > 2 && ' (enriched)'}
              {hoveredArc.oe_ratio < 0.5 && ' (depleted)'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
