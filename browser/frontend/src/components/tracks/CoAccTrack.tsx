import { clusterWindows } from '../../utils/clusterTargets';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { logicalOffset } from '../../utils/scaledCoordinates';
import { setupHighDpiCanvas } from '../../utils/canvasUtils';
// ============================================================================
// CoAccTrack - Co-accessibility visualization track
// ============================================================================
// Three display modes mirroring MicroCTrack:
// - heatmap: Triangular strip showing co-accessibility within viewport
// - arc: Curved arcs connecting co-accessible bins
// - virtual4c: 1D profile from a viewpoint position

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { coaccViewpointPosition, useCoaccStore } from '../../stores/coaccStore';
import { getCoaccStripUrl, getCoaccArcs, getCoaccSlice, type CoaccArc, type CoaccSlice } from '../../api/coaccessibility';
import { useFocusedReadIds } from '../../hooks/useFocusedReadIds';
import { useAnalysisSettingsKey } from '../../hooks/useAnalysisSettingsKey';
import {
  computeEffectiveReadIdsByStateKey,
  flattenScopedReadIdsForDataset,
} from '../../utils/readScopes';
import { CoAccess, ContactMap, TrendingUp } from '../ui/Icons';

interface CoAccTrackProps {
  panelId?: string;
  width: number;
  height: number;
  sidebarWidth?: number;
}

// Teal color scale for arcs (matching panel accent)
function getArcColor(strength: number): string {
  // 0 = light teal, 1 = dark teal
  const t = Math.max(0, Math.min(1, strength));
  const r = Math.round(13 + (1 - t) * 200);
  const g = Math.round(148 + (1 - t) * 80);
  const b = Math.round(136 + (1 - t) * 80);
  return `rgb(${r}, ${g}, ${b})`;
}

export function CoAccTrack({ width, height, sidebarWidth = 0, panelId }: CoAccTrackProps) {
  // Quality filters and layer inference change the reads the server uses.
  const analysisKey = useAnalysisSettingsKey();
  const { chrom, start, end, genome, datasets, analysisSampleSeed, filteredReadIds, isReversed } = useBrowserStore(useShallow(s => ({
    isReversed: s.isReversed,
    chrom: s.panels.find(p => p.id === panelId)?.viewportOverride?.chrom ?? s.chrom,
    start: s.panels.find(p => p.id === panelId)?.viewportOverride?.start ?? s.start,
    end: s.panels.find(p => p.id === panelId)?.viewportOverride?.end ?? s.end,
    genome: s.panels.find(p => p.id === panelId)?.genome ?? null,
    datasets: s.datasets,
    analysisSampleSeed: s.analysisSampleSeed,
    filteredReadIds: s.filteredReadIds,
  })));

  const {
    coaccTrackMode, coaccNormalization, coaccScaling, coaccColormap,
    coaccSignalType, coaccLayer,
    coaccMinCoverage, coaccBinSize, coaccArcThreshold, coaccArcMaxArcs,
    coaccArcMinDistance, coaccV4cViewpoint, setCoaccV4cViewpoint,
  } = useCoaccStore(useShallow(s => ({
    coaccTrackMode: s.coaccTrackMode,
    coaccSignalType: s.coaccSignalType,
    coaccLayer: s.coaccLayer,
    coaccNormalization: s.coaccNormalization,
    coaccScaling: s.coaccScaling,
    coaccColormap: s.coaccColormap,
    coaccMinCoverage: s.coaccMinCoverage,
    coaccBinSize: s.coaccBinSize,
    coaccArcThreshold: s.coaccArcThreshold,
    coaccArcMaxArcs: s.coaccArcMaxArcs,
    coaccArcMinDistance: s.coaccArcMinDistance,
    coaccV4cViewpoint: s.coaccV4cViewpoint,
    setCoaccV4cViewpoint: s.setCoaccV4cViewpoint,
  })));

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  // The current arc / virtual-4C request failed: nothing from an older view is drawn.
  const [fetchFailed, setFetchFailed] = useState(false);
  const hasContentRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heatmapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingIndicatorRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);
  const heatmapImageRef = useRef<HTMLImageElement | null>(null);

  const trackWidth = width - sidebarWidth;
  const safeTrackWidth = Math.max(0, trackWidth);
  const regionWidth = end - start;
  const hasDatasets = datasets.length > 0;
  const { targetDatasetIds, targetStateKeys, stateKeyMap, focusedReadIdSets } = useFocusedReadIds();
  useSplitPanelStore(s => s.reads);
  const ownScopeKey = useBrowserStore(s => {
    const panel = s.panels.find(p => p.id === panelId && p.datasetId);
    if (!panel) return 'null';
    const w = clusterWindows({ ...s, panels: [panel], selectedDatasets: new Set() }, [panel.datasetId!])[0];
    return JSON.stringify({ datasetId: panel.datasetId, readIds: w?.read_ids });
  });
  const ownScope = useMemo(() => JSON.parse(ownScopeKey) as { datasetId: string; readIds?: string[] } | null, [ownScopeKey]);
  const requestDatasetIds = ownScope ? [ownScope.datasetId] : targetDatasetIds.length > 0 ? targetDatasetIds : datasets.map(d => d.id);
  const requestDatasetIdsKey = requestDatasetIds.join('\u0001');
  const effectiveReadIdsByStateKey = useMemo(
    () => computeEffectiveReadIdsByStateKey(targetStateKeys, focusedReadIdSets, filteredReadIds),
    [targetStateKeys, focusedReadIdSets, filteredReadIds],
  );
  const effectiveReadIdsByDataset = useMemo(() => {
    if (ownScope) return ownScope.readIds !== undefined ? { [ownScope.datasetId]: ownScope.readIds } : undefined;
    const scoped: Record<string, string[]> = {};
    for (const datasetId of requestDatasetIds) {
      const ids = flattenScopedReadIdsForDataset(
        effectiveReadIdsByStateKey,
        stateKeyMap,
        datasetId,
        { preserveEmptyScope: true },
      );
      if (ids !== undefined) scoped[datasetId] = ids;
    }
    return Object.keys(scoped).length > 0 ? scoped : undefined;
  }, [ownScope, effectiveReadIdsByStateKey, requestDatasetIdsKey, stateKeyMap]);

  // ── Heatmap mode ──
  const stripUrl = useMemo(() => {
    if (coaccTrackMode !== 'heatmap' || !chrom || regionWidth <= 0 || !hasDatasets || safeTrackWidth <= 0 || height <= 0) return null;
    return getCoaccStripUrl(chrom, start, end, {
      panelGenome: genome,
      width: Math.round(safeTrackWidth),
      height,
      binSize: coaccBinSize || undefined,
      datasetIds: requestDatasetIds.length > 0 ? requestDatasetIds : undefined,
      normalization: coaccNormalization,
      scaling: coaccScaling,
      colormap: coaccColormap,
      minCoverage: coaccMinCoverage,
      readIdsByDataset: effectiveReadIdsByDataset,
      signalType: coaccSignalType,
      layer: coaccLayer,
      sampleSeed: analysisSampleSeed,
    }) + `&settings=${encodeURIComponent(analysisKey)}`;
  }, [genome, coaccTrackMode, chrom, start, end, safeTrackWidth, height, coaccBinSize,
      requestDatasetIdsKey, coaccNormalization, coaccScaling, coaccColormap, coaccMinCoverage,
      effectiveReadIdsByDataset, coaccSignalType, coaccLayer, analysisSampleSeed, hasDatasets, regionWidth, analysisKey]);

  // ── Arc mode data ──
  const [arcs, setArcs] = useState<CoaccArc[]>([]);

  // ── Virtual 4C mode data ──
  const [sliceData, setSliceData] = useState<CoaccSlice | null>(null);

  useEffect(() => {
    hasContentRef.current = hasContent;
  }, [hasContent]);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // HiDPI and recorded for SVG/PDF figures (fb-n11-tracks audit).
    const ctx = setupHighDpiCanvas(canvas, safeTrackWidth, height);
    ctx?.clearRect(0, 0, safeTrackWidth, height);
  }, [height, safeTrackWidth]);

  const clearHeatmapRequest = useCallback(() => {
    if (heatmapTimeoutRef.current) {
      clearTimeout(heatmapTimeoutRef.current);
      heatmapTimeoutRef.current = null;
    }
    if (heatmapImageRef.current) {
      heatmapImageRef.current.onload = null;
      heatmapImageRef.current.onerror = null;
      heatmapImageRef.current = null;
    }
  }, []);

  const scheduleLoadingIndicator = useCallback((requestSeq: number) => {
    if (loadingIndicatorRef.current) clearTimeout(loadingIndicatorRef.current);
    loadingIndicatorRef.current = setTimeout(() => {
      if (requestSeqRef.current === requestSeq) setShowLoading(true);
    }, hasContentRef.current ? 500 : 150);
  }, []);

  const finishLoading = useCallback((requestSeq?: number) => {
    if (requestSeq !== undefined && requestSeqRef.current !== requestSeq) return;
    if (loadingIndicatorRef.current) {
      clearTimeout(loadingIndicatorRef.current);
      loadingIndicatorRef.current = null;
    }
    setLoading(false);
    setShowLoading(false);
  }, []);

  const resetTrackRequestState = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    clearHeatmapRequest();
    requestSeqRef.current += 1;
    setLoading(false);
    setShowLoading(false);
    setHasContent(false);
    setArcs([]);
    setSliceData(null);
    clearCanvas();
  }, [clearCanvas, clearHeatmapRequest]);

  // Fetch data based on mode
  const fetchData = useCallback(() => {
    if (!chrom || regionWidth <= 0 || !hasDatasets || safeTrackWidth <= 0 || height <= 0) {
      resetTrackRequestState();
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    const requestSeq = ++requestSeqRef.current;

    timerRef.current = setTimeout(async () => {
      if (requestSeqRef.current !== requestSeq) return;
      setLoading(true);
      setHasContent(false);
      setFetchFailed(false);
      scheduleLoadingIndicator(requestSeq);
      try {
        if (coaccTrackMode === 'arc') {
          setSliceData(null);
          const result = await getCoaccArcs(chrom, start, end, {
            panelGenome: genome,
            binSize: coaccBinSize || undefined,
            datasetIds: requestDatasetIds.length > 0 ? requestDatasetIds : undefined,
            normalization: coaccNormalization,
            minCoverage: coaccMinCoverage,
            threshold: coaccArcThreshold,
            maxArcs: coaccArcMaxArcs,
            minDistance: coaccArcMinDistance,
            readIdsByDataset: effectiveReadIdsByDataset,
            signalType: coaccSignalType,
            layer: coaccLayer,
            sampleSeed: analysisSampleSeed,
          });
          if (requestSeqRef.current === requestSeq) {
            setArcs(result.arcs);
            setHasContent(result.arcs.length > 0);
          }
        } else if (coaccTrackMode === 'virtual4c') {
          setArcs([]);
          const pos = coaccViewpointPosition(coaccV4cViewpoint, chrom, start, end, genome);
          const result = await getCoaccSlice(chrom, start, end, pos, {
            panelGenome: genome,
            binSize: coaccBinSize || undefined,
            datasetIds: requestDatasetIds.length > 0 ? requestDatasetIds : undefined,
            normalization: coaccNormalization,
            minCoverage: coaccMinCoverage,
            readIdsByDataset: effectiveReadIdsByDataset,
            signalType: coaccSignalType,
            layer: coaccLayer,
            sampleSeed: analysisSampleSeed,
          });
          if (requestSeqRef.current === requestSeq) {
            setSliceData(result);
            setHasContent(result.profile.length > 0);
          }
        }
      } catch {
        // The previous view's arcs / profile must not stay under this view's axis.
        if (requestSeqRef.current === requestSeq) {
          setArcs([]);
          setSliceData(null);
          setHasContent(false);
          setFetchFailed(true);
          clearCanvas();
        }
      } finally {
        finishLoading(requestSeq);
      }
    }, 300);
  }, [genome, chrom, start, end, regionWidth, hasDatasets, safeTrackWidth, height, coaccTrackMode, coaccBinSize,
      coaccNormalization, coaccMinCoverage, coaccArcThreshold, coaccArcMaxArcs,
      coaccArcMinDistance, coaccV4cViewpoint, requestDatasetIdsKey, effectiveReadIdsByDataset, coaccSignalType, coaccLayer, analysisSampleSeed,
      analysisKey, finishLoading, resetTrackRequestState, scheduleLoadingIndicator, clearCanvas]);

  useEffect(() => {
    if (coaccTrackMode === 'arc' || coaccTrackMode === 'virtual4c') {
      fetchData();
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      requestSeqRef.current += 1;
      finishLoading();
    };
  }, [fetchData, coaccTrackMode, finishLoading]);

  // ── Render heatmap strip ──
  useEffect(() => {
    if (coaccTrackMode !== 'heatmap' || !stripUrl) {
      clearHeatmapRequest();
      if (!coaccTrackMode || !stripUrl) {
        setHasContent(false);
        clearCanvas();
      }
      finishLoading();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      finishLoading();
      return;
    }

    const requestSeq = ++requestSeqRef.current;
    const img = new Image();
    heatmapImageRef.current = img;
    const clearHeatmapTimeout = () => {
      if (heatmapTimeoutRef.current) {
        clearTimeout(heatmapTimeoutRef.current);
        heatmapTimeoutRef.current = null;
      }
    };
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      clearHeatmapTimeout();
      if (requestSeqRef.current !== requestSeq) return;
      // HiDPI and recorded for SVG/PDF figures (fb-n11-tracks audit).
      const ctx = setupHighDpiCanvas(canvas, safeTrackWidth, height);
      try {
        if (!ctx) return;
        ctx.clearRect(0, 0, safeTrackWidth, height);
        ctx.drawImage(img, 0, 0, safeTrackWidth, height);
        setHasContent(true);
      } finally {
        finishLoading(requestSeq);
      }
    };
    img.onerror = () => {
      clearHeatmapTimeout();
      if (requestSeqRef.current === requestSeq) {
        setHasContent(false);
        clearCanvas();
      }
      finishLoading(requestSeq);
    };
    heatmapTimeoutRef.current = setTimeout(() => {
      if (requestSeqRef.current === requestSeq) {
        if (heatmapImageRef.current === img) {
          img.onload = null;
          img.onerror = null;
          heatmapImageRef.current = null;
        }
        setHasContent(false);
        clearCanvas();
        finishLoading(requestSeq);
        requestSeqRef.current += 1;
      }
      heatmapTimeoutRef.current = null;
    }, 60000);
    setLoading(true);
    setHasContent(false);
    setArcs([]);
    setSliceData(null);
    scheduleLoadingIndicator(requestSeq);
    img.src = stripUrl;

    return () => {
      clearHeatmapTimeout();
      if (requestSeqRef.current === requestSeq) requestSeqRef.current += 1;
      img.onload = null;
      img.onerror = null;
      if (heatmapImageRef.current === img) heatmapImageRef.current = null;
      finishLoading();
    };
  }, [stripUrl, safeTrackWidth, height, coaccTrackMode, clearCanvas, clearHeatmapRequest, finishLoading, scheduleLoadingIndicator]);

  // ── Render arcs ──
  useEffect(() => {
    if (coaccTrackMode !== 'arc') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // HiDPI and recorded for SVG/PDF figures (fb-n11-tracks audit).
    const ctx = setupHighDpiCanvas(canvas, safeTrackWidth, height);
    if (!ctx) return;
    ctx.clearRect(0, 0, safeTrackWidth, height);

    if (arcs.length === 0) return;

    // Normalize strengths for coloring
    const maxStr = Math.max(...arcs.map(a => a.strength), 1);

    for (const arc of arcs) {
      const x1 = ((arc.start - start) / regionWidth) * safeTrackWidth;
      const x2 = ((arc.end - start) / regionWidth) * safeTrackWidth;
      if (x2 < 0 || x1 > safeTrackWidth) continue;

      const midX = (x1 + x2) / 2;
      const span = x2 - x1;
      const arcHeight = Math.min(span * 0.4, height - 2);

      const normalized = arc.strength / maxStr;
      ctx.strokeStyle = getArcColor(normalized);
      ctx.lineWidth = Math.max(0.5, Math.min(2, normalized * 2));
      ctx.globalAlpha = 0.3 + normalized * 0.7;

      ctx.beginPath();
      ctx.moveTo(x1, height);
      ctx.quadraticCurveTo(midX, height - arcHeight, x2, height);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [arcs, coaccTrackMode, safeTrackWidth, height, start, regionWidth]);

  // ── Render virtual 4C ──
  useEffect(() => {
    if (coaccTrackMode !== 'virtual4c' || !sliceData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // HiDPI and recorded for SVG/PDF figures (fb-n11-tracks audit).
    const ctx = setupHighDpiCanvas(canvas, safeTrackWidth, height);
    if (!ctx) return;
    ctx.clearRect(0, 0, safeTrackWidth, height);

    const { profile, n_bins, viewpoint_bin } = sliceData;
    if (n_bins === 0) return;

    // Find max for y-axis (exclude nulls)
    const validVals = profile.filter((v): v is number => v !== null && v !== undefined);
    if (validVals.length === 0) return;
    const yMax = Math.max(...validVals, 0.001);

    const binWidth = safeTrackWidth / n_bins;

    // Draw fill
    ctx.fillStyle = 'rgba(13, 148, 136, 0.15)';
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < n_bins; i++) {
      const val = profile[i];
      const y = val != null ? height - (val / yMax) * (height - 4) : height;
      ctx.lineTo(i * binWidth + binWidth / 2, y);
    }
    ctx.lineTo(safeTrackWidth, height);
    ctx.closePath();
    ctx.fill();

    // Draw line
    ctx.strokeStyle = '#0d9488';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n_bins; i++) {
      const val = profile[i];
      if (val == null) { started = false; continue; }
      const x = i * binWidth + binWidth / 2;
      const y = height - (val / yMax) * (height - 4);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw viewpoint indicator
    const vpX = viewpoint_bin * binWidth + binWidth / 2;
    ctx.strokeStyle = '#0d9488';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(vpX, 0);
    ctx.lineTo(vpX, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [sliceData, coaccTrackMode, safeTrackWidth, height]);

  // ── Click handler for virtual 4C: set viewpoint ──
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (coaccTrackMode !== 'virtual4c') return;
    if (safeTrackWidth <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = logicalOffset(e.clientX - rect.left, e.currentTarget.clientWidth, rect.width);
    // The canvas is mirrored in a reversed view (below): its left edge is the region's end.
    const frac = x / safeTrackWidth;
    const pos = start + (isReversed ? 1 - frac : frac) * regionWidth;
    setCoaccV4cViewpoint({ start: Math.round(pos), end: Math.round(pos), chrom, genome });
  }, [genome, coaccTrackMode, chrom, start, safeTrackWidth, regionWidth, setCoaccV4cViewpoint, isReversed]);

  if (!coaccTrackMode || !hasDatasets) return null;

  return (
    <div style={{ position: 'relative', width, height }}>
      {/* Sidebar spacer */}
      {sidebarWidth > 0 && (
        <div style={{ position: 'absolute', left: 0, top: 0, width: sidebarWidth, height, background: 'transparent' }} />
      )}
      {/* Label */}
      <div
        style={{
          position: 'absolute',
          left: sidebarWidth + 2,
          top: 1,
          fontSize: 9,
          color: '#0d9488',
          opacity: 0.7,
          pointerEvents: 'none',
          zIndex: 2,
        }}
      >
        <span className="inline-flex items-center gap-1">
          Co-Acc
          {coaccTrackMode === 'heatmap' ? <ContactMap size={10} aria-label="heatmap" /> : coaccTrackMode === 'arc' ? <CoAccess size={10} aria-label="arcs" /> : <TrendingUp size={10} aria-label="virtual 4C" />}
        </span>
      </div>
      {fetchFailed && !loading && (coaccTrackMode === 'arc' || coaccTrackMode === 'virtual4c') && (
        <div
          style={{ position: 'absolute', right: 4, top: 1, fontSize: 9, color: '#dc2626', opacity: 0.8, pointerEvents: 'none', zIndex: 2 }}
        >
          Co-accessibility request failed
        </div>
      )}
      {showLoading && loading && !hasContent && (
        <div
          style={{
            position: 'absolute',
            right: 4,
            top: 1,
            fontSize: 9,
            color: '#999',
            opacity: 0.6,
          }}
        >
          ...
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={safeTrackWidth}
        height={height}
        style={{
          position: 'absolute',
          left: sidebarWidth,
          top: 0,
          width: safeTrackWidth,
          height,
          cursor: coaccTrackMode === 'virtual4c' ? 'crosshair' : 'default',
          // Heatmap, arcs and virtual 4C are all drawn forward; mirror them like
          // the other tracks when the view is reversed.
          transform: isReversed ? 'scaleX(-1)' : undefined,
        }}
        onClick={handleClick}
      />
    </div>
  );
}
