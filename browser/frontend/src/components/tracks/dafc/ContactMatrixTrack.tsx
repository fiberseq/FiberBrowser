import { useRef, useEffect, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDafcStore } from '../../../stores/dafcStore';
import { useBrowserStore } from '../../../stores/browserStore';
import {
  getDafcMatrixImageUrl,
  getDafcMatrixData,
  selectDafcRegion,
} from '../../../api/dafc';
import { searchGene } from '../../../api/reference';
import { parseCoordinates, formatCoordinates } from '../../../utils/coordinates';
import {
  formatContactDistance,
  getOverscanBounds,
  getPannedViewport,
  isMeaningfulMatrixSelection,
  pixelToGenome,
  selectMatrixResolution,
  viewportFitsBuffer,
} from '../../../utils/contactMatrixMath';
import type { Gene } from '../../../types';
import { sameChrom } from '../../../utils/chromAliases';
import { downloadTextFile, exportTimestamp, formatContactMatrixTsv, safeFilenamePart } from '../../../utils/analysisExport';
import { X } from '../../ui/Icons';

interface Props {
  width: number;
  height: number;
  onOpenRegions?: (selection: { chrom: string; x_start: number; x_end: number; y_start: number; y_end: number; contacts: number; n_ligated_reads: number; read_ids: string[]; contact_mode?: string }) => void;
}

type InteractionMode = 'select' | 'pan';

// Layout constants
const TOOLBAR_HEIGHT = 40;
const HOVER_BAR_HEIGHT = 18;
const SELECTION_BAR_HEIGHT = 32;
const GENE_LABEL_GUTTER = 30;

// Image load debounce (ms)
const LOAD_DEBOUNCE = 150;

// Overscan: fetch 50% extra on each side (total 2x viewport)
const OVERSCAN = 0.5;

/** Overscan image buffer — stores a larger-than-viewport image for smooth panning */
interface ImageBuffer {
  img: HTMLImageElement;
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
  chrom: string;
  resolution: number;
  /** The contact map load it came from (another map at the same coordinates is a different image). */
  generation: number;
}

export function ContactMatrixTrack({ width, height, onOpenRegions }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const bufferRef = useRef<ImageBuffer | null>(null);
  const requestIdRef = useRef(0);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const {
    dafcLoaded,
    dafcChrom, dafcStart, dafcEnd, dafcResolution, dafcResolutions,
    dafcXStart, dafcXEnd, dafcYStart, dafcYEnd,
    setDafcViewport, setDafcMatrixViewport, setDafcResolution,
    dafcSelection, setDafcSelection,
    dafcFollowBrowser, setDafcFollowBrowser,
    splitViewMode, setSplitViewMode,
    dafcGenes, showGeneAnnotations,
    matrixScaling, matrixColormap, matrixNormalization,
    setMatrixScaling, setMatrixColormap, setMatrixNormalization,
    matrixValueMin, matrixValueMax, setMatrixValueMin, setMatrixValueMax,
  } = useDafcStore(useShallow(s => ({
    dafcLoaded: s.dafcLoaded,
    dafcChrom: s.dafcChrom,
    dafcStart: s.dafcStart,
    dafcEnd: s.dafcEnd,
    dafcResolution: s.dafcResolution,
    dafcResolutions: s.dafcResolutions,
    dafcXStart: s.dafcXStart,
    dafcXEnd: s.dafcXEnd,
    dafcYStart: s.dafcYStart,
    dafcYEnd: s.dafcYEnd,
    setDafcViewport: s.setDafcViewport,
    setDafcMatrixViewport: s.setDafcMatrixViewport,
    setDafcResolution: s.setDafcResolution,
    dafcSelection: s.dafcSelection,
    setDafcSelection: s.setDafcSelection,
    dafcFollowBrowser: s.dafcFollowBrowser,
    setDafcFollowBrowser: s.setDafcFollowBrowser,
    splitViewMode: s.splitViewMode,
    setSplitViewMode: s.setSplitViewMode,
    dafcGenes: s.dafcGenes,
    showGeneAnnotations: s.showGeneAnnotations,
    matrixScaling: s.matrixScaling,
    matrixColormap: s.matrixColormap,
    matrixNormalization: s.matrixNormalization,
    setMatrixScaling: s.setMatrixScaling,
    setMatrixColormap: s.setMatrixColormap,
    setMatrixNormalization: s.setMatrixNormalization,
    matrixValueMin: s.matrixValueMin,
    matrixValueMax: s.matrixValueMax,
    setMatrixValueMin: s.setMatrixValueMin,
    setMatrixValueMax: s.setMatrixValueMax,
  })));
  const dafcLoadGeneration = useDafcStore(s => s.dafcLoadGeneration);

  const browserChrom = useBrowserStore(s => s.chrom);
  const browserStart = useBrowserStore(s => s.start);
  const browserEnd = useBrowserStore(s => s.end);

  const [loading, setLoading] = useState(false);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<InteractionMode>('select');
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number; genomicXStart: number; genomicYStart: number } | null>(null);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [imageVersion, setImageVersion] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showRange, setShowRange] = useState(false);
  const [showViewportRect, setShowViewportRect] = useState(true);
  const [toolbarHeight, setToolbarHeight] = useState(TOOLBAR_HEIGHT);
  const [exportingData, setExportingData] = useState(false);

  // Measure actual toolbar height (changes when controls wrap)
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setToolbarHeight(Math.ceil(entry.contentRect.height + 8)); // +8 for py-1 padding
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Square matrix sizing — selection bar only takes space when active
  const selectionBarHeight = dafcSelection ? SELECTION_BAR_HEIGHT : 0;
  const availW = width - GENE_LABEL_GUTTER;
  const availH = height - toolbarHeight - GENE_LABEL_GUTTER - HOVER_BAR_HEIGHT - selectionBarHeight;
  const matrixSize = Math.max(100, Math.min(availW, availH));

  // Canvas includes matrix + gene gutters
  const canvasWidth = matrixSize + GENE_LABEL_GUTTER;
  const canvasHeight = matrixSize + GENE_LABEL_GUTTER;

  // X and Y view sizes
  const xViewSize = dafcXEnd - dafcXStart;
  const yViewSize = dafcYEnd - dafcYStart;

  // ── Buffer management ──────────────────────────────────────────────

  /** Check if a viewport fits entirely within the current buffer */
  const viewportInBuffer = useCallback((xS: number, xE: number, yS: number, yE: number): boolean => {
    if (bufferRef.current && bufferRef.current.generation !== dafcLoadGeneration) return false;
    return viewportFitsBuffer(
      { xStart: xS, xEnd: xE, yStart: yS, yEnd: yE },
      bufferRef.current,
      dafcChrom,
      dafcResolution,
    );
  }, [dafcChrom, dafcResolution, dafcLoadGeneration]);

  const clearPendingImage = useCallback(() => {
    if (!imageRef.current) return;
    imageRef.current.onload = null;
    imageRef.current.onerror = null;
    imageRef.current = null;
  }, []);

  const invalidatePendingRequest = useCallback((clearLoading = true) => {
    requestIdRef.current += 1;
    clearPendingImage();
    if (clearLoading) setLoading(false);
  }, [clearPendingImage]);

  useEffect(() => () => {
    invalidatePendingRequest(false);
  }, [invalidatePendingRequest]);

  /** Fetch an overscan buffer image covering the given viewport + padding */
  const fetchBuffer = useCallback((xS: number, xE: number, yS: number, yE: number) => {
    if (!dafcLoaded) {
      invalidatePendingRequest();
      return;
    }

    const bounds = getOverscanBounds({ xStart: xS, xEnd: xE, yStart: yS, yEnd: yE }, OVERSCAN);

    clearPendingImage();
    const currentId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const img = new Image();
    imageRef.current = img;
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (requestIdRef.current !== currentId) return;
      if (imageRef.current === img) imageRef.current = null;
      bufferRef.current = {
        img,
        xStart: bounds.xStart,
        xEnd: bounds.xEnd,
        yStart: bounds.yStart,
        yEnd: bounds.yEnd,
        chrom: dafcChrom, resolution: dafcResolution,
        generation: dafcLoadGeneration,
      };
      setLoading(false);
      setImageVersion(v => v + 1);
    };
    img.onerror = () => {
      if (requestIdRef.current !== currentId) return;
      if (imageRef.current === img) imageRef.current = null;
      setLoading(false);
      setError('Failed to load matrix image');
    };

    const offDiag = { xStart: bounds.xStart, xEnd: bounds.xEnd, yStart: bounds.yStart, yEnd: bounds.yEnd };
    const diagStart = Math.min(bounds.xStart, bounds.yStart);
    const diagEnd = Math.max(bounds.xEnd, bounds.yEnd);
    img.src = getDafcMatrixImageUrl(dafcChrom, diagStart, diagEnd, dafcResolution, offDiag, {
      scaling: matrixScaling,
      colormap: matrixColormap,
      normalization: matrixNormalization,
      vmin: matrixValueMin,
      vmax: matrixValueMax,
    }) + `&map=${dafcLoadGeneration}`;
  }, [dafcLoaded, dafcLoadGeneration, dafcChrom, dafcResolution, matrixScaling, matrixColormap, matrixNormalization, matrixValueMin, matrixValueMax, clearPendingImage, invalidatePendingRequest]);

  // Viewport change: check buffer, fetch if needed
  useEffect(() => {
    if (!dafcLoaded) return;

    if (viewportInBuffer(dafcXStart, dafcXEnd, dafcYStart, dafcYEnd)) {
      // Already in buffer — just trigger redraw
      setImageVersion(v => v + 1);
      return;
    }

    // Need new buffer — invalidate any in-flight image immediately, then debounce the next fetch.
    bufferRef.current = null;
    invalidatePendingRequest();
    const timer = setTimeout(() => {
      fetchBuffer(dafcXStart, dafcXEnd, dafcYStart, dafcYEnd);
    }, LOAD_DEBOUNCE);

    return () => clearTimeout(timer);
  }, [dafcLoaded, dafcLoadGeneration, dafcChrom, dafcXStart, dafcXEnd, dafcYStart, dafcYEnd, dafcResolution, viewportInBuffer, invalidatePendingRequest]);

  // Settings change: force refetch (buffer is stale when colormap/scaling/norm/clamp change)
  const settingsRef = useRef({ matrixScaling, matrixColormap, matrixNormalization, matrixValueMin, matrixValueMax });
  useEffect(() => {
    const prev = settingsRef.current;
    const changed = prev.matrixScaling !== matrixScaling || prev.matrixColormap !== matrixColormap ||
      prev.matrixNormalization !== matrixNormalization || prev.matrixValueMin !== matrixValueMin ||
      prev.matrixValueMax !== matrixValueMax;
    settingsRef.current = { matrixScaling, matrixColormap, matrixNormalization, matrixValueMin, matrixValueMax };
    if (!changed || !dafcLoaded) return;
    bufferRef.current = null; // invalidate buffer
    invalidatePendingRequest();
    const timer = setTimeout(() => {
      fetchBuffer(dafcXStart, dafcXEnd, dafcYStart, dafcYEnd);
    }, LOAD_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [matrixScaling, matrixColormap, matrixNormalization, matrixValueMin, matrixValueMax, dafcLoaded, invalidatePendingRequest]);

  // ── Effective viewport (accounts for live pan offset) ──────────────

  /** Get the viewport the user currently sees (shifted during pan) */
  const getEffectiveViewport = useCallback(() => {
    if (isPanning && panStart) {
      return getPannedViewport({
        xStart: panStart.genomicXStart,
        xEnd: panStart.genomicXStart + xViewSize,
        yStart: panStart.genomicYStart,
        yEnd: panStart.genomicYStart + yViewSize,
      }, panOffset, matrixSize);
    }
    return { xStart: dafcXStart, xEnd: dafcXEnd, yStart: dafcYStart, yEnd: dafcYEnd };
  }, [isPanning, panStart, panOffset, matrixSize, xViewSize, yViewSize, dafcXStart, dafcXEnd, dafcYStart, dafcYEnd]);

  // ── Draw canvas ────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const buf = bufferRef.current;
    if (!buf || buf.chrom !== dafcChrom) {
      // Placeholder
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(GENE_LABEL_GUTTER, 0, matrixSize, matrixSize);
      ctx.fillStyle = '#6b7280';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        loading ? 'Loading...' : (dafcLoaded ? 'Loading matrix...' : 'No contact data loaded'),
        GENE_LABEL_GUTTER + matrixSize / 2,
        matrixSize / 2
      );
      return;
    }

    // Compute effective viewport (shifted during pan)
    const ev = getEffectiveViewport();

    // Map effective viewport onto buffer image coordinates
    const bufXSize = buf.xEnd - buf.xStart;
    const bufYSize = buf.yEnd - buf.yStart;
    const imgW = buf.img.naturalWidth;
    const imgH = buf.img.naturalHeight;

    const srcX = ((ev.xStart - buf.xStart) / bufXSize) * imgW;
    const srcY = ((ev.yStart - buf.yStart) / bufYSize) * imgH;
    const srcW = ((ev.xEnd - ev.xStart) / bufXSize) * imgW;
    const srcH = ((ev.yEnd - ev.yStart) / bufYSize) * imgH;

    // Clamp source rect to image bounds (handles edge-of-buffer during large pans)
    const cSrcX = Math.max(0, srcX);
    const cSrcY = Math.max(0, srcY);
    const cSrcR = Math.min(imgW, srcX + srcW);
    const cSrcB = Math.min(imgH, srcY + srcH);
    const cSrcW = Math.max(0, cSrcR - cSrcX);
    const cSrcH = Math.max(0, cSrcB - cSrcY);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (cSrcW > 0 && cSrcH > 0) {
      // Compute destination rect (adjust if source was clamped)
      const dstX = GENE_LABEL_GUTTER + (srcX < 0 ? (-srcX / srcW) * matrixSize : 0);
      const dstY = srcY < 0 ? (-srcY / srcH) * matrixSize : 0;
      const dstW = (cSrcW / srcW) * matrixSize;
      const dstH = (cSrcH / srcH) * matrixSize;

      ctx.drawImage(buf.img, cSrcX, cSrcY, cSrcW, cSrcH, dstX, dstY, dstW, dstH);
    }

    // Draw browser viewport indicator rectangle
    if (showViewportRect && sameChrom(dafcChrom, browserChrom) && (ev.xEnd - ev.xStart) > (browserEnd - browserStart)) {
      const vx1 = GENE_LABEL_GUTTER + ((browserStart - ev.xStart) / (ev.xEnd - ev.xStart)) * matrixSize;
      const vx2 = GENE_LABEL_GUTTER + ((browserEnd - ev.xStart) / (ev.xEnd - ev.xStart)) * matrixSize;
      const vy1 = ((browserStart - ev.yStart) / (ev.yEnd - ev.yStart)) * matrixSize;
      const vy2 = ((browserEnd - ev.yStart) / (ev.yEnd - ev.yStart)) * matrixSize;
      // Clamp to matrix bounds
      const cx1 = Math.max(GENE_LABEL_GUTTER, Math.min(GENE_LABEL_GUTTER + matrixSize, vx1));
      const cx2 = Math.max(GENE_LABEL_GUTTER, Math.min(GENE_LABEL_GUTTER + matrixSize, vx2));
      const cy1 = Math.max(0, Math.min(matrixSize, vy1));
      const cy2 = Math.max(0, Math.min(matrixSize, vy2));
      if (cx2 > cx1 && cy2 > cy1) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
        ctx.fillRect(cx1, cy1, cx2 - cx1, cy2 - cy1);
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(cx1, cy1, cx2 - cx1, cy2 - cy1);
        ctx.setLineDash([]);
      }
    }

    // Draw selection rectangle during drag
    if (dragStart && dragEnd && mode === 'select') {
      const x = Math.min(dragStart.x, dragEnd.x);
      const y = Math.min(dragStart.y, dragEnd.y);
      const w = Math.abs(dragEnd.x - dragStart.x);
      const h = Math.abs(dragEnd.y - dragStart.y);

      ctx.fillStyle = 'rgba(59, 130, 246, 0.3)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    }

    // Draw crosshairs when not dragging
    if (mousePos && !dragStart && !isPanning) {
      if (mousePos.x >= GENE_LABEL_GUTTER && mousePos.x < GENE_LABEL_GUTTER + matrixSize && mousePos.y >= 0 && mousePos.y < matrixSize) {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        ctx.beginPath();
        ctx.moveTo(mousePos.x, 0);
        ctx.lineTo(mousePos.x, matrixSize);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(GENE_LABEL_GUTTER, mousePos.y);
        ctx.lineTo(GENE_LABEL_GUTTER + matrixSize, mousePos.y);
        ctx.stroke();

        ctx.setLineDash([]);
      }
    }

    // Draw confirmed selection (only when not panning — coordinates are relative to store viewport)
    if (dafcSelection && !dragStart && !isPanning) {
      const x1 = GENE_LABEL_GUTTER + ((dafcSelection.x_start - ev.xStart) / (ev.xEnd - ev.xStart)) * matrixSize;
      const x2 = GENE_LABEL_GUTTER + ((dafcSelection.x_end - ev.xStart) / (ev.xEnd - ev.xStart)) * matrixSize;
      const y1 = ((dafcSelection.y_start - ev.yStart) / (ev.yEnd - ev.yStart)) * matrixSize;
      const y2 = ((dafcSelection.y_end - ev.yStart) / (ev.yEnd - ev.yStart)) * matrixSize;

      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 3;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

    // Draw gene annotations on axes
    if (showGeneAnnotations && dafcGenes.length > 0) {
      drawGeneAnnotations(ctx, dafcGenes, ev.xStart, ev.xEnd, ev.yStart, ev.yEnd, matrixSize, GENE_LABEL_GUTTER);
    }
  }, [canvasWidth, canvasHeight, matrixSize, dafcLoaded, dafcChrom, loading, dragStart, dragEnd, mousePos, dafcSelection, dafcXStart, dafcXEnd, dafcYStart, dafcYEnd, dafcResolution, mode, isPanning, imageVersion, showGeneAnnotations, dafcGenes, panOffset, getEffectiveViewport, browserChrom, browserStart, browserEnd, showViewportRect]);

  // ── Coordinate helpers ─────────────────────────────────────────────

  const pixelToGenomeX = useCallback((pixel: number) => {
    return pixelToGenome(pixel, dafcXStart, dafcXEnd, matrixSize);
  }, [matrixSize, dafcXStart, dafcXEnd]);

  const pixelToGenomeY = useCallback((pixel: number) => {
    return pixelToGenome(pixel, dafcYStart, dafcYEnd, matrixSize);
  }, [matrixSize, dafcYStart, dafcYEnd]);

  const getMatrixCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = canvasWidth / rect.width;
    const scaleY = canvasHeight / rect.height;
    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top) * scaleY;
    return { canvasX, canvasY };
  }, [canvasWidth, canvasHeight]);

  // ── Selection ──────────────────────────────────────────────────────

  // A selection answer counts only while nothing has superseded it: a newer
  // selection, a cleared one (navigation clears it), another map or
  // chromosome, or the track closing.
  const selectionSeqRef = useRef(0);
  // Any move of the X/Y view drops a pending selection too: navigation clears
  // the selection, but clearing one that was never set changes nothing to see.
  useEffect(() => { selectionSeqRef.current += 1; }, [dafcChrom, dafcLoadGeneration, dafcXStart, dafcXEnd, dafcYStart, dafcYEnd]);
  useEffect(() => { if (!dafcSelection) selectionSeqRef.current += 1; }, [dafcSelection]);
  useEffect(() => () => { selectionSeqRef.current += 1; }, []);

  const completeSelection = useCallback(async (start: { x: number; y: number }, end: { x: number; y: number }) => {
    if (!isMeaningfulMatrixSelection(start, end)) return;
    const seq = ++selectionSeqRef.current;

    const sx = start.x - GENE_LABEL_GUTTER;
    const ex = end.x - GENE_LABEL_GUTTER;
    const sy = start.y;
    const ey = end.y;

    const x1 = pixelToGenomeX(Math.min(sx, ex));
    const x2 = pixelToGenomeX(Math.max(sx, ex)) + dafcResolution;
    const y1 = pixelToGenomeY(Math.min(sy, ey));
    const y2 = pixelToGenomeY(Math.max(sy, ey)) + dafcResolution;

    try {
      const sel = await selectDafcRegion(dafcChrom, x1, x2, y1, y2);
      if (seq !== selectionSeqRef.current) return;
      setDafcSelection(sel);
    } catch {
      if (seq === selectionSeqRef.current) setError('Failed to query selection');
    }
  }, [pixelToGenomeX, pixelToGenomeY, dafcResolution, dafcChrom, setDafcSelection]);

  // ── Auto-resolution ────────────────────────────────────────────────

  const autoSetResolution = useCallback((viewSize: number) => {
    if (dafcResolutions.length === 0) return;
    const optimal = selectMatrixResolution(viewSize, dafcResolutions);
    if (optimal !== dafcResolution) {
      setDafcResolution(optimal);
    }
  }, [dafcResolutions, dafcResolution, setDafcResolution]);

  // ── Mouse handlers ─────────────────────────────────────────────────

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { canvasX, canvasY } = getMatrixCoords(e);
    setMousePos({ x: canvasX, y: canvasY });

    if (mode === 'select' && dragStart) {
      setDragEnd({ x: canvasX, y: canvasY });
    }

    // Client-side panning: update pan offset — draw effect crops buffer accordingly
    if (isPanning && panStart) {
      setPanOffset({
        x: canvasX - panStart.x,
        y: canvasY - panStart.y,
      });
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { canvasX, canvasY } = getMatrixCoords(e);

    if (canvasX < GENE_LABEL_GUTTER || canvasX >= GENE_LABEL_GUTTER + matrixSize || canvasY >= matrixSize) return;

    if (e.button === 1 || (e.button === 0 && e.shiftKey) || mode === 'pan') {
      e.preventDefault();
      setIsPanning(true);
      setPanStart({
        x: canvasX,
        y: canvasY,
        genomicXStart: dafcXStart,
        genomicYStart: dafcYStart,
      });
      setPanOffset({ x: 0, y: 0 });
    } else if (mode === 'select') {
      setDragStart({ x: canvasX, y: canvasY });
      setDragEnd({ x: canvasX, y: canvasY });
    }
  };

  /** Finalize pan: compute final viewport from pan offset, update store ONCE */
  const completePan = useCallback(() => {
    if (!panStart) return;

    const genomicDeltaX = -(panOffset.x / matrixSize) * xViewSize;
    const genomicDeltaY = -(panOffset.y / matrixSize) * yViewSize;

    const newXStart = Math.max(0, Math.round(panStart.genomicXStart + genomicDeltaX));
    const newXEnd = newXStart + xViewSize;
    const newYStart = Math.max(0, Math.round(panStart.genomicYStart + genomicDeltaY));
    const newYEnd = newYStart + yViewSize;

    if (dafcFollowBrowser) setDafcFollowBrowser(false);
    setDafcMatrixViewport(dafcChrom, newXStart, Math.round(newXEnd), newYStart, Math.round(newYEnd));
    autoSetResolution(Math.max(newXEnd - newXStart, newYEnd - newYStart));
  }, [panStart, panOffset, matrixSize, xViewSize, yViewSize, dafcFollowBrowser, setDafcFollowBrowser, dafcChrom, setDafcMatrixViewport, autoSetResolution]);

  // Document-level mouseup to catch releases outside canvas
  useEffect(() => {
    const handleDocumentMouseUp = async () => {
      if (isPanning) {
        completePan();
        setIsPanning(false);
        setPanStart(null);
        setPanOffset({ x: 0, y: 0 });
        return;
      }

      if (dragStart && dragEnd) {
        await completeSelection(dragStart, dragEnd);
        setDragStart(null);
        setDragEnd(null);
      }
    };

    document.addEventListener('mouseup', handleDocumentMouseUp);
    return () => document.removeEventListener('mouseup', handleDocumentMouseUp);
  }, [dragStart, dragEnd, isPanning, completeSelection, completePan]);

  const handleMouseLeave = () => {
    setMousePos(null);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  // ── Zoom ───────────────────────────────────────────────────────────

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { canvasX, canvasY } = getMatrixCoords(e as unknown as React.MouseEvent<HTMLCanvasElement>);

    if (canvasX < GENE_LABEL_GUTTER || canvasX >= GENE_LABEL_GUTTER + matrixSize || canvasY >= matrixSize) return;

    const mx = canvasX - GENE_LABEL_GUTTER;
    const my = canvasY;
    const factor = e.deltaY > 0 ? 1.2 : 0.8;

    const cursorFracX = mx / matrixSize;
    const cursorGenomeX = dafcXStart + cursorFracX * xViewSize;
    const newXSize = Math.floor(xViewSize * factor);
    const newXStart = Math.max(0, Math.floor(cursorGenomeX - newXSize * cursorFracX));

    const cursorFracY = my / matrixSize;
    const cursorGenomeY = dafcYStart + cursorFracY * yViewSize;
    const newYSize = Math.floor(yViewSize * factor);
    const newYStart = Math.max(0, Math.floor(cursorGenomeY - newYSize * cursorFracY));

    if (dafcFollowBrowser) setDafcFollowBrowser(false);
    setDafcMatrixViewport(dafcChrom, newXStart, newXStart + newXSize, newYStart, newYStart + newYSize);
    autoSetResolution(Math.max(newXSize, newYSize));
  };

  const handleZoom = (factor: number) => {
    const centerX = (dafcXStart + dafcXEnd) / 2;
    const centerY = (dafcYStart + dafcYEnd) / 2;
    const newXSize = Math.floor(xViewSize * factor);
    const newYSize = Math.floor(yViewSize * factor);
    if (dafcFollowBrowser) setDafcFollowBrowser(false);
    const newXStart = Math.max(0, Math.floor(centerX - newXSize / 2));
    const newYStart = Math.max(0, Math.floor(centerY - newYSize / 2));
    setDafcMatrixViewport(dafcChrom, newXStart, newXStart + newXSize, newYStart, newYStart + newYSize);
    autoSetResolution(Math.max(newXSize, newYSize));
  };

  // ── Navigation ─────────────────────────────────────────────────────

  const handleSnapToBrowser = () => {
    setDafcFollowBrowser(true);
    setDafcViewport(browserChrom, browserStart, browserEnd);
    autoSetResolution(browserEnd - browserStart);
  };

  const handleExportMatrixData = async () => {
    setExportingData(true);
    setError(null);
    try {
      const result = await getDafcMatrixData(
        dafcChrom,
        dafcXStart,
        dafcXEnd,
        dafcYStart,
        dafcYEnd,
        dafcResolution,
        matrixNormalization,
      );
      downloadTextFile(
        formatContactMatrixTsv({
          matrix: result.matrix,
          chrom: result.chrom,
          xStart: result.x_start,
          xEnd: result.x_end,
          yStart: result.y_start,
          yEnd: result.y_end,
          resolution: result.resolution,
          normalization: result.normalization,
        }),
        `contact_matrix_${safeFilenamePart(result.chrom)}_${result.x_start}-${result.x_end}_${result.y_start}-${result.y_end}_${exportTimestamp()}.tsv`,
        'text/tab-separated-values',
      );
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Failed to export matrix data');
    } finally {
      setExportingData(false);
    }
  };

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = searchInput.trim();
    if (!input) return;

    const coords = parseCoordinates(input);
    if (coords) {
      setDafcFollowBrowser(false);
      setDafcViewport(coords.chrom, coords.start, coords.end);
      autoSetResolution(coords.end - coords.start);
      setSearchError(null);
      setSearchInput('');
      return;
    }

    try {
      const result = await searchGene(input);
      if (result.found && result.chrom && result.start != null && result.end != null) {
        const pad = Math.max(1000, Math.floor((result.end - result.start) * 0.2));
        const newStart = Math.max(0, result.start - pad);
        const newEnd = result.end + pad;
        setDafcFollowBrowser(false);
        setDafcViewport(result.chrom, newStart, newEnd);
        autoSetResolution(newEnd - newStart);
        setSearchError(null);
        setSearchInput('');
      } else {
        setSearchError(result.message || 'Gene not found');
      }
    } catch {
      setSearchError('Search failed');
    }
  };

  // ── Render ─────────────────────────────────────────────────────────

  const isMoleculeLinked = splitViewMode === 'molecule_linked';
  const readTypeLabel = isMoleculeLinked ? 'Molecule-linked Reads' : 'Independent Region Reads';

  return (
    <div className="flex flex-col h-full">
      {/* Compact toolbar — wraps into rows when narrow */}
      <div ref={toolbarRef} className="flex flex-wrap items-center gap-1 px-2 py-1 bg-gray-50 border-b text-xs" style={{ minHeight: TOOLBAR_HEIGHT }}>
        {/* Navigation group: title, resolution, zoom */}
        <div className="flex items-center gap-1">
          <span className="font-medium text-gray-700 whitespace-nowrap">Contact Matrix</span>
          {dafcResolutions.length > 0 && (
            <select
              value={dafcResolution}
              onChange={(e) => setDafcResolution(parseInt(e.target.value))}
              className="px-1 py-0.5 border rounded text-[11px] bg-white"
            >
              {dafcResolutions.map((r: number) => (
                <option key={r} value={r}>{(r / 1000).toLocaleString()}kb</option>
              ))}
            </select>
          )}
          <button onClick={() => handleZoom(0.8)} className="px-1.5 py-0.5 bg-gray-200 rounded hover:bg-gray-300 text-[11px]" title="Zoom in">+</button>
          <button onClick={() => handleZoom(1.25)} className="px-1.5 py-0.5 bg-gray-200 rounded hover:bg-gray-300 text-[11px]" title="Zoom out">-</button>
          <button
            onClick={handleExportMatrixData}
            disabled={exportingData}
            className="px-1.5 py-0.5 bg-gray-200 rounded hover:bg-gray-300 text-[11px] disabled:opacity-50"
            title="Download the numeric matrix for this X/Y viewport"
          >
            {exportingData ? 'TSV…' : 'TSV'}
          </button>
        </div>

        {/* Display group: scaling, colormap, normalization, range */}
        <div className="flex items-center gap-1 pl-1.5 border-l border-gray-300">
          <select value={matrixScaling} onChange={(e) => setMatrixScaling(e.target.value as typeof matrixScaling)} className="px-1 py-0.5 border rounded text-[11px] bg-white" title="Value scaling">
            <option value="log">Log</option>
            <option value="sqrt">Sqrt</option>
            <option value="linear">Linear</option>
          </select>
          <select value={matrixColormap} onChange={(e) => setMatrixColormap(e.target.value as typeof matrixColormap)} className="px-1 py-0.5 border rounded text-[11px] bg-white" title="Colormap">
            <option value="fall">Fall</option>
            <option value="red">Red</option>
            <option value="hot">Hot</option>
            <option value="viridis">Viridis</option>
            <option value="blues">Blues</option>
          </select>
          <select value={matrixNormalization} onChange={(e) => setMatrixNormalization(e.target.value as typeof matrixNormalization)} className="px-1 py-0.5 border rounded text-[11px] bg-white" title="Normalization">
            <option value="none">Raw</option>
            <option value="balanced">Balanced</option>
            <option value="oe">O/E</option>
            <option value="oe_global">O/E Global</option>
          </select>
          <div className="relative">
            <button onClick={() => setShowRange(v => !v)} className={`px-1.5 py-0.5 rounded text-[11px] ${showRange ? 'bg-blue-500 text-white' : 'bg-gray-200 hover:bg-gray-300'}`} title="Color scale range">Range</button>
            {showRange && (
              <div className="absolute top-full left-0 mt-1 bg-white border rounded shadow-lg p-1.5 z-10 flex items-center gap-1 whitespace-nowrap">
                <input
                  type="number"
                  step="any"
                  placeholder="min"
                  value={matrixValueMin ?? ''}
                  onChange={(e) => setMatrixValueMin(e.target.value === '' ? null : parseFloat(e.target.value))}
                  className="w-14 px-1 py-0.5 border rounded text-[11px]"
                  title="Min value"
                />
                <span className="text-gray-400">-</span>
                <input
                  type="number"
                  step="any"
                  placeholder="max"
                  value={matrixValueMax ?? ''}
                  onChange={(e) => setMatrixValueMax(e.target.value === '' ? null : parseFloat(e.target.value))}
                  className="w-14 px-1 py-0.5 border rounded text-[11px]"
                  title="Max value"
                />
              </div>
            )}
          </div>
        </div>

        {/* Interaction + split-view semantics group */}
        <div className="flex items-center gap-1 pl-1.5 border-l border-gray-300">
          <button onClick={() => setMode('select')} className={`px-1.5 py-0.5 rounded text-[11px] ${mode === 'select' ? 'bg-blue-500 text-white' : 'bg-gray-200 hover:bg-gray-300'}`} title="Select region">Select</button>
          <button onClick={() => setMode('pan')} className={`px-1.5 py-0.5 rounded text-[11px] ${mode === 'pan' ? 'bg-blue-500 text-white' : 'bg-gray-200 hover:bg-gray-300'}`} title="Pan view">Pan</button>
          <span className="w-px h-4 bg-gray-300" />
          <button onClick={() => setSplitViewMode('region_independent')} className={`px-1.5 py-0.5 rounded text-[11px] ${!isMoleculeLinked ? 'bg-purple-500 text-white' : 'bg-gray-200 hover:bg-gray-300'}`} title="Independent per-region reads; rows do not represent the same molecule">Independent</button>
          <button onClick={() => setSplitViewMode('molecule_linked')} className={`px-1.5 py-0.5 rounded text-[11px] ${isMoleculeLinked ? 'bg-purple-500 text-white' : 'bg-gray-200 hover:bg-gray-300'}`} title="Molecule-linked reads; row N in each panel is the same molecule">Linked</button>
        </div>

        {/* Viewport sync group: follow, snap, viewport rect */}
        <div className="flex items-center gap-1 pl-1.5 border-l border-gray-300">
          <button
            onClick={() => { if (!dafcFollowBrowser) handleSnapToBrowser(); else setDafcFollowBrowser(false); }}
            className={`px-1.5 py-0.5 rounded text-[11px] flex items-center gap-0.5 ${dafcFollowBrowser ? 'bg-green-500 text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'}`}
            title={dafcFollowBrowser ? 'Following browser viewport (click to unlink)' : 'Independent viewport (click to follow browser)'}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              {dafcFollowBrowser
                ? <path d="M4.5 3A1.5 1.5 0 003 4.5v.793c.026.009.051.02.076.032L7.674 8 3.076 10.675A1.693 1.693 0 003 10.708v.792A1.5 1.5 0 004.5 13h7a1.5 1.5 0 001.5-1.5v-.792a1.693 1.693 0 00-.076-.033L8.326 8l4.598-2.675A1.693 1.693 0 0013 5.293V4.5A1.5 1.5 0 0011.5 3h-7z" />
                : <path d="M1.5 1a.5.5 0 00-.5.5v4a.5.5 0 01-1 0v-4A1.5 1.5 0 011.5 0h4a.5.5 0 010 1h-4zM10 .5a.5.5 0 01.5-.5h4A1.5 1.5 0 0116 1.5v4a.5.5 0 01-1 0v-4a.5.5 0 00-.5-.5h-4a.5.5 0 01-.5-.5zM.5 10a.5.5 0 01.5.5v4a.5.5 0 00.5.5h4a.5.5 0 010 1h-4A1.5 1.5 0 010 14.5v-4a.5.5 0 01.5-.5zm15 0a.5.5 0 01.5.5v4a1.5 1.5 0 01-1.5 1.5h-4a.5.5 0 010-1h4a.5.5 0 00.5-.5v-4a.5.5 0 01.5-.5z" />
              }
            </svg>
            Follow
          </button>
          {!dafcFollowBrowser && (
            <button onClick={handleSnapToBrowser} className="px-1.5 py-0.5 rounded text-[11px] bg-green-100 text-green-700 hover:bg-green-200" title="Snap to current browser viewport">Snap</button>
          )}
          <button
            onClick={() => setShowViewportRect(v => !v)}
            className={`px-1.5 py-0.5 rounded text-[11px] ${showViewportRect ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 hover:bg-gray-300 text-gray-500'}`}
            title={showViewportRect ? 'Hide browser viewport rectangle' : 'Show browser viewport rectangle'}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="10" height="10" strokeDasharray="3 2" />
            </svg>
          </button>
        </div>

        {/* Search group */}
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-1 pl-1.5 border-l border-gray-300 flex-1 min-w-[140px]">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => { setSearchInput(e.target.value); setSearchError(null); }}
            placeholder={formatCoordinates(dafcChrom, dafcXStart, dafcXEnd)}
            className={`px-1.5 py-0.5 border rounded text-[11px] w-full min-w-[100px] max-w-[200px] bg-white ${searchError ? 'border-red-300' : ''}`}
            title="Enter coordinates (chr:start-end) or gene name"
          />
          <button type="submit" className="px-1.5 py-0.5 bg-gray-200 rounded hover:bg-gray-300 text-[11px] whitespace-nowrap">Go</button>
          {searchError && <span className="text-red-500 text-[11px] whitespace-nowrap">{searchError}</span>}
        </form>
      </div>

      {/* Canvas area — full width, no sidebar */}
      <div className="flex-1 relative flex flex-col items-center overflow-hidden" style={{ minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={canvasHeight}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseLeave={handleMouseLeave}
          onContextMenu={handleContextMenu}
          onWheel={handleWheel}
          className={mode === 'pan' || isPanning ? 'cursor-grab' : 'cursor-crosshair'}
          style={{ cursor: isPanning ? 'grabbing' : undefined, maxWidth: '100%', maxHeight: '100%' }}
        />
        {/* Hover coordinate bar */}
        <div className="w-full flex-shrink-0 bg-gray-50 border-t px-2 flex items-center font-mono text-[11px] text-gray-500" style={{ height: HOVER_BAR_HEIGHT }}>
          {mousePos && mousePos.x >= GENE_LABEL_GUTTER && mousePos.x < GENE_LABEL_GUTTER + matrixSize && mousePos.y >= 0 && mousePos.y < matrixSize ? (() => {
            const gx = pixelToGenomeX(mousePos.x - GENE_LABEL_GUTTER);
            const gy = pixelToGenomeY(mousePos.y);
            const dist = Math.abs(gx - gy);
            return (
              <span>
                X: {dafcChrom}:{gx.toLocaleString()}&ensp;Y: {dafcChrom}:{gy.toLocaleString()}&ensp;Dist: {formatContactDistance(dist)}
              </span>
            );
          })() : <span>&nbsp;</span>}
        </div>

        {/* Selection bar — only appears when a selection is active */}
        {dafcSelection && (
          <div className="w-full flex-shrink-0 bg-gray-50 border-t px-3 flex items-center gap-3 text-xs" style={{ height: SELECTION_BAR_HEIGHT }}>
            <span className="text-gray-500 font-medium">Selection</span>
            <span className="font-mono text-[11px] text-gray-600">
              X: {dafcSelection.x_start.toLocaleString()}-{dafcSelection.x_end.toLocaleString()}
            </span>
            <span className="font-mono text-[11px] text-gray-600">
              Y: {dafcSelection.y_start.toLocaleString()}-{dafcSelection.y_end.toLocaleString()}
            </span>
            <span className="text-blue-600 font-semibold">{dafcSelection.contacts.toLocaleString()} contacts</span>
            <span className="text-green-600 font-semibold">{dafcSelection.n_ligated_reads.toLocaleString()} {readTypeLabel}</span>

            {dafcSelection.n_ligated_reads > 0 && onOpenRegions && (
              <button
                data-tour="contacts-open-regions"
                onClick={() => onOpenRegions(dafcSelection)}
                className="px-2 py-0.5 bg-green-500 text-white rounded hover:bg-green-600 text-[11px] font-medium"
              >
                Open Regions
              </button>
            )}

            <button
              onClick={() => setDafcSelection(null)}
              className="ml-auto rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10"
              title="Clear selection"
              aria-label="Clear selection"
            ><X size={12} /></button>
          </div>
        )}

        {error && (
          <div className="w-full flex-shrink-0 bg-red-50 border-t border-red-200 px-3 py-1 text-xs text-red-600">{error}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Draw gene name labels along the bottom (X-axis) and left (Y-axis) of the matrix.
 * Supports independent X and Y ranges for off-diagonal views.
 */
function drawGeneAnnotations(
  ctx: CanvasRenderingContext2D,
  genes: Gene[],
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number,
  matrixSize: number,
  gutter: number,
) {
  const xLen = xEnd - xStart;
  const yLen = yEnd - yStart;
  if (xLen <= 0 || yLen <= 0 || genes.length === 0) return;

  const namedGenes = genes.filter(g => g.name);
  if (namedGenes.length === 0) return;

  ctx.save();
  ctx.font = '9px sans-serif';

  for (const gene of namedGenes) {
    const geneMid = (gene.start + gene.end) / 2;
    const color = gene.strand === '+' ? '#2563eb' : '#dc2626';

    const yFrac = (geneMid - yStart) / yLen;
    if (yFrac >= 0 && yFrac <= 1) {
      const yPos = yFrac * matrixSize;
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(gene.name!, gutter - 3, yPos);
    }

    const xFrac = (geneMid - xStart) / xLen;
    if (xFrac >= 0 && xFrac <= 1) {
      const xPos = gutter + xFrac * matrixSize;
      ctx.save();
      ctx.translate(xPos, matrixSize + 3);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(gene.name!, 0, 0);
      ctx.restore();
    }
  }

  ctx.restore();
}
