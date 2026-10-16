import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCoaccMatrixImageUrl, getCoaccMetadata, type CoaccMetadata } from '../../../api/coaccessibility';
import { useBrowserStore } from '../../../stores/browserStore';
import type { Gene } from '../../../types';
import { buildCoaccMatrixRequestKey } from '../../../utils/coaccRequestKey';
import { ChartMaximizeButton } from '../../charts/ChartMaximizeButton';
import { ChartSaveButton } from '../../charts/ChartSaveButton';
import { AnalysisStatus } from '../shared';
import { useAnalysisSettingsKey } from '../../../hooks/useAnalysisSettingsKey';

export type MatrixRequestState =
  | { phase: 'success' }
  | { phase: 'empty'; message: string }
  | { phase: 'error'; message: string };

interface MatrixCanvasProps {
  genome?: string | null;
  reversed?: boolean;
  chrom: string;
  start: number;
  end: number;
  datasetIds: string[];
  normalization: string;
  scaling: string;
  colormap: string;
  minCoverage: number;
  binSize: number;
  readIds?: string[];
  readIdsByDataset?: Record<string, string[]>;
  signalType: string;
  layer?: string | null;
  maxSize: number;
  genes: Gene[];
  refreshKey?: number;
  onMetadata?: (meta: CoaccMetadata) => void;
  onRequestState?: (state: MatrixRequestState) => void;
}

function formatBp(bp: number): string {
  if (bp >= 1e6) return `${(bp / 1e6).toFixed(1)}Mb`;
  if (bp >= 1e3) return `${(bp / 1e3).toFixed(1)}kb`;
  return `${bp}bp`;
}

/** Format position labels that are distinguishable within a region. */
function formatRegionPos(pos: number, regionStart: number, regionEnd: number): string {
  const span = regionEnd - regionStart;
  if (span <= 10000) {
    if (pos >= 1e6) {
      const mb = Math.floor(pos / 1e6);
      const remainder = pos - mb * 1e6;
      if (remainder >= 1e3) return `${mb}.${Math.round(remainder / 100)}Mb`;
      return `${mb}Mb+${remainder}`;
    }
    if (pos >= 1e3) {
      const kb = Math.floor(pos / 1e3);
      const remainder = pos - kb * 1e3;
      return remainder > 0 ? `${kb}.${Math.round(remainder / 100)}kb` : `${kb}kb`;
    }
    return `${pos}`;
  }
  if (span < 100000) {
    if (pos >= 1e6) return `${(pos / 1e6).toFixed(2)}Mb`;
    if (pos >= 1e3) return `${(pos / 1e3).toFixed(1)}kb`;
    return `${pos}`;
  }
  return formatBp(pos);
}

/** Append a short tag of the analysis settings to an image URL (the server ignores it). */
function withSettingsTag(url: string, analysisKey: string): string {
  let hash = 0;
  for (let i = 0; i < analysisKey.length; i += 1) hash = (hash * 31 + analysisKey.charCodeAt(i)) | 0;
  return `${url}${url.includes('?') ? '&' : '?'}settings=${(hash >>> 0).toString(36)}`;
}

export function MatrixCanvas({
  chrom, start, end, genome, reversed = false, datasetIds, normalization, scaling, colormap,
  minCoverage, binSize, readIds, readIdsByDataset, signalType, layer, maxSize, genes, refreshKey = 0, onMetadata, onRequestState,
}: MatrixCanvasProps) {
  const analysisKey = useAnalysisSettingsKey();
  const sampleSeed = useBrowserStore(s => s.analysisSampleSeed);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRenderedMatrix, setHasRenderedMatrix] = useState(false);
  const hasRenderedMatrixRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingIndicatorRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const requestSeqRef = useRef(0);
  const onMetadataRef = useRef(onMetadata);
  const onRequestStateRef = useRef(onRequestState);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const regionWidth = end - start;
  const datasetIdsKey = datasetIds.join('\u0001');
  const readIdsKey = readIds?.join('\u0001') ?? '';
  const readIdsByDatasetKey = useMemo(
    () => JSON.stringify(readIdsByDataset ?? {}),
    [readIdsByDataset],
  );
  const requestDatasetIds = useMemo(
    () => datasetIdsKey ? datasetIdsKey.split('\u0001') : [],
    [datasetIdsKey],
  );
  const requestReadIds = useMemo(
    () => readIdsKey ? readIdsKey.split('\u0001') : undefined,
    [readIdsKey],
  );
  const requestReadIdsByDataset = useMemo(() => {
    if (!readIdsByDatasetKey || readIdsByDatasetKey === '{}') return undefined;
    return JSON.parse(readIdsByDatasetKey) as Record<string, string[]>;
  }, [readIdsByDatasetKey]);

  useEffect(() => {
    hasRenderedMatrixRef.current = hasRenderedMatrix;
  }, [hasRenderedMatrix]);

  useEffect(() => {
    onMetadataRef.current = onMetadata;
  }, [onMetadata]);

  useEffect(() => {
    onRequestStateRef.current = onRequestState;
  }, [onRequestState]);

  const clearPendingLoadArtifacts = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (imageTimeoutRef.current) {
      clearTimeout(imageTimeoutRef.current);
      imageTimeoutRef.current = null;
    }
    if (loadingIndicatorRef.current) {
      clearTimeout(loadingIndicatorRef.current);
      loadingIndicatorRef.current = null;
    }
    if (imageRef.current) {
      imageRef.current.onload = null;
      imageRef.current.onerror = null;
      imageRef.current = null;
    }
  }, []);

  const finishLoading = useCallback((requestSeq: number) => {
    if (requestSeqRef.current !== requestSeq) return;
    if (loadingIndicatorRef.current) {
      clearTimeout(loadingIndicatorRef.current);
      loadingIndicatorRef.current = null;
    }
    setLoading(false);
    setShowLoading(false);
  }, []);

  const imageUrl = useMemo(() => {
    if (!chrom || regionWidth <= 0) return null;
    // The settings tag makes a new URL when quality filters change, so the
    // browser can't hand back the image it cached for the old ones.
    return withSettingsTag(getCoaccMatrixImageUrl(chrom, start, end, {
      panelGenome: genome,
      binSize: binSize || undefined,
      datasetIds: requestDatasetIds.length > 0 ? requestDatasetIds : undefined,
      normalization: normalization as any,
      scaling: scaling as any,
      colormap,
      minCoverage,
      readIds: requestReadIds,
      readIdsByDataset: requestReadIdsByDataset,
      signalType,
      layer,
      sampleSeed,
    }), analysisKey);
  }, [genome, chrom, start, end, binSize, requestDatasetIds, normalization, scaling, colormap, minCoverage, requestReadIds, requestReadIdsByDataset, signalType, layer, sampleSeed, regionWidth, analysisKey]);

  const requestKey = useMemo(() => buildCoaccMatrixRequestKey({
    chrom,
    start,
    end,
    datasetIds: requestDatasetIds,
    normalization,
    scaling,
    colormap,
    minCoverage,
    binSize,
    readIds: requestReadIds,
    readIdsByDataset: requestReadIdsByDataset,
    signalType,
    layer,
    sampleSeed,
    maxSize,
    genes,
    refreshKey,
    // Quality filters and layer inference change the reads the server uses.
    analysisKey: `${analysisKey}|${genome ?? ""}|${reversed}`,
  }), [genome, reversed,
    chrom,
    start,
    end,
    requestDatasetIds,
    normalization,
    scaling,
    colormap,
    minCoverage,
    binSize,
    requestReadIds,
    requestReadIdsByDataset,
    signalType,
    layer,
    sampleSeed,
    maxSize,
    genes,
    refreshKey,
    analysisKey,
  ]);

  useEffect(() => {
    const requestSeq = ++requestSeqRef.current;
    const controller = new AbortController();
    const isCurrentRequest = () => requestSeqRef.current === requestSeq;
    clearPendingLoadArtifacts();
    if (!chrom || regionWidth <= 0) {
      setLoading(false);
      setShowLoading(false);
      setError(null);
      setHasRenderedMatrix(false);
      clearCanvas();
      return () => {
        controller.abort();
        if (isCurrentRequest()) requestSeqRef.current += 1;
      };
    }
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      if (!isCurrentRequest()) return;
      setLoading(true);
      if (loadingIndicatorRef.current) clearTimeout(loadingIndicatorRef.current);
      loadingIndicatorRef.current = setTimeout(() => {
        if (requestSeqRef.current === requestSeq) setShowLoading(true);
      }, hasRenderedMatrixRef.current ? 500 : 150);
      setError(null);
      try {
        const meta = await getCoaccMetadata(chrom, start, end, {
          panelGenome: genome,
          binSize: binSize || undefined,
          datasetIds: requestDatasetIds.length > 0 ? requestDatasetIds : undefined,
          minCoverage,
          readIds: requestReadIds,
          readIdsByDataset: requestReadIdsByDataset,
          signalType,
          layer,
          normalization: normalization as any,
          sampleSeed,
          signal: controller.signal,
        });
        if (requestSeqRef.current !== requestSeq) return;
        onMetadataRef.current?.(meta);

        if (meta.n_reads === 0) {
          clearCanvas();
          setHasRenderedMatrix(false);
          const message = 'No reads';
          setError(message);
          onRequestStateRef.current?.({ phase: 'empty', message });
          finishLoading(requestSeq);
          return;
        }

        if (imageUrl) {
          const img = new Image();
          imageRef.current = img;
          imageTimeoutRef.current = setTimeout(() => {
            if (requestSeqRef.current !== requestSeq) return;
            imageTimeoutRef.current = null;
            if (imageRef.current === img) {
              img.onload = null;
              img.onerror = null;
              imageRef.current = null;
            }
            const message = 'Image load timed out';
            setError(message);
            onRequestStateRef.current?.({ phase: 'error', message });
            finishLoading(requestSeq);
            requestSeqRef.current += 1;
          }, 60000);
          const clearImageTimeout = () => {
            if (imageTimeoutRef.current) {
              clearTimeout(imageTimeoutRef.current);
              imageTimeoutRef.current = null;
            }
          };
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            clearImageTimeout();
            if (requestSeqRef.current !== requestSeq) return;
            if (imageRef.current === img) imageRef.current = null;
            try {
              const canvas = canvasRef.current;
              if (!canvas) {
                onRequestStateRef.current?.({ phase: 'error', message: 'Canvas unavailable' });
                finishLoading(requestSeq);
                return;
              }
              // Drawn at the screen's pixel density so a large matrix and its
              // labels stay sharp on high-DPI displays.
              const dpr = Math.max(1, Math.min(3, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));
              canvas.width = Math.round(maxSize * dpr);
              canvas.height = Math.round(maxSize * dpr);
              const ctx = canvas.getContext('2d');
              if (!ctx) {
                onRequestStateRef.current?.({ phase: 'error', message: 'Canvas unavailable' });
                finishLoading(requestSeq);
                return;
              }
              ctx.setTransform?.(dpr, 0, 0, dpr, 0, 0);
              ctx.imageSmoothingEnabled = false;
              ctx.clearRect(0, 0, maxSize, maxSize);
              ctx.save();
              if (reversed) { ctx.translate(maxSize, maxSize); ctx.scale(-1, -1); }
              ctx.drawImage(img, 0, 0, maxSize, maxSize);
              ctx.restore();
              drawAxisLabels(ctx, maxSize, meta.n_bins, meta.bin_size, start, end, genes, reversed);
              setHasRenderedMatrix(true);
              onRequestStateRef.current?.({ phase: 'success' });
            } catch (drawError) {
              const message = drawError instanceof Error ? drawError.message : 'Failed to draw matrix';
              setError(message);
              onRequestStateRef.current?.({ phase: 'error', message });
            } finally {
              finishLoading(requestSeq);
            }
          };
          img.onerror = () => {
            clearImageTimeout();
            if (requestSeqRef.current !== requestSeq) return;
            if (imageRef.current === img) imageRef.current = null;
            const message = 'Failed to load';
            setError(message);
            onRequestStateRef.current?.({ phase: 'error', message });
            finishLoading(requestSeq);
          };
          img.src = imageUrl;
        } else {
          clearCanvas();
          setHasRenderedMatrix(false);
          onRequestStateRef.current?.({ phase: 'empty', message: 'No image URL' });
          finishLoading(requestSeq);
        }
      } catch (e) {
        if (requestSeqRef.current !== requestSeq) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        const message = e instanceof Error ? e.message : 'Failed';
        setError(message);
        onRequestStateRef.current?.({ phase: 'error', message });
        finishLoading(requestSeq);
      }
    }, 300);
    return () => {
      controller.abort();
      clearPendingLoadArtifacts();
      if (isCurrentRequest()) requestSeqRef.current += 1;
      setLoading(false);
      setShowLoading(false);
    };
  }, [clearCanvas, clearPendingLoadArtifacts, finishLoading, requestKey, regionWidth, chrom]);

  return (
    <div data-testid="coacc-matrix" className="relative group flex flex-col items-center">
      {showLoading && loading && !hasRenderedMatrix && (
        <AnalysisStatus
          kind="loading"
          compact
          center
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 shadow-sm bg-white/90 dark:bg-gray-950/90"
        >
          Computing matrix...
        </AnalysisStatus>
      )}
      {showLoading && loading && hasRenderedMatrix && (
        <AnalysisStatus
          kind="loading"
          compact
          className="absolute top-1 left-1 z-10 shadow-sm bg-white/90 dark:bg-gray-950/90"
        >
          Updating...
        </AnalysisStatus>
      )}
      {error && !loading && (
        <AnalysisStatus kind="error" compact center className="mb-1">
          {error}
        </AnalysisStatus>
      )}
      <canvas
        data-testid="coacc-matrix-canvas"
        ref={canvasRef}
        className="border border-gray-200 dark:border-gray-700"
        // A dataset with no reads (or an error) shows its message, not an
        // empty bordered square the size of a matrix.
        style={{ width: maxSize, height: maxSize, display: error && !loading && !hasRenderedMatrix ? 'none' : undefined }}
      />
      <ChartSaveButton canvasRef={canvasRef} filename="coacc_matrix" />
      <ChartMaximizeButton
        title="Co-Accessibility Matrix"
        filename="coacc_matrix"
        renderChart={(w, h) => {
          const sz = Math.min(w, h);
          return (
            <MatrixCanvas
              chrom={chrom}
              start={start}
              end={end}
              datasetIds={datasetIds}
              normalization={normalization}
              scaling={scaling}
              colormap={colormap}
              minCoverage={minCoverage}
              binSize={binSize}
              readIds={readIds}
              readIdsByDataset={readIdsByDataset}
              signalType={signalType}
              layer={layer}
              maxSize={sz}
              genes={genes}
            />
          );
        }}
      />
    </div>
  );
}

/** Draw genomic coordinate labels and gene annotations along both edges. */
function drawAxisLabels(
  ctx: CanvasRenderingContext2D, size: number,
  nBins: number, binSize: number, regionStart: number,
  regionEnd: number, genes: Gene[], reversed = false,
) {
  if (nBins <= 0) return;

  const pixPerBin = size / nBins;
  ctx.save();

  // Labels grow a little with the matrix (9 px at 400 px, 11 px from 500 px).
  const labelFont = Math.max(9, Math.min(11, Math.round(size / 45)));
  ctx.font = `${labelFont}px sans-serif`;
  ctx.fillStyle = '#888';

  const step = Math.max(1, Math.floor(nBins / 4));
  // The corner (bin 0) is skipped: its top and left labels would overlap,
  // and the top one would be cut at the left edge.
  for (let i = step; i < nBins; i += step) {
    const pos = regionStart + (reversed ? nBins - 1 - i : i) * binSize;
    const label = formatRegionPos(pos, regionStart, regionEnd);
    const px = i * pixPerBin;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, px + pixPerBin / 2, 1);

    ctx.save();
    ctx.translate(2, px + pixPerBin / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  if (genes.length > 0) {
    const regionWidth = regionEnd - regionStart;
    const geneFont = Math.max(8, Math.min(11, Math.floor(size / 45)));
    ctx.font = `${geneFont}px sans-serif`;
    const geneMargin = 3;
    const visibleGenes = genes.filter(g => g.end > regionStart && g.start < regionEnd);

    for (const gene of visibleGenes) {
      const name = gene.name || gene.id;
      if (!name) continue;

      const gStart = Math.max(0, gene.start - regionStart);
      const gEnd = Math.min(regionWidth, gene.end - regionStart);
      const gMid = (gStart + gEnd) / 2;
      const px = (reversed ? 1 - gMid / regionWidth : gMid / regionWidth) * size;

      const gStartPx = (reversed ? 1 - gEnd / regionWidth : gStart / regionWidth) * size;
      const gEndPx = (reversed ? 1 - gStart / regionWidth : gEnd / regionWidth) * size;
      const strandArrow = (gene.strand === '+') !== reversed ? '\u25B8' : '\u25C2';

      ctx.save();
      ctx.fillStyle = gene.strand === '+' ? '#2563eb' : '#dc2626';
      ctx.globalAlpha = 0.7;
      ctx.fillRect(gStartPx, size - geneMargin - 1, gEndPx - gStartPx, 1);
      // Names sit just inside the edge, above (and left of) the gene's line,
      // so they are not cut off by the canvas edge.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.globalAlpha = 0.85;
      const truncName = name.length > 8 ? name.slice(0, 7) + '\u2026' : name;
      ctx.fillText(`${strandArrow}${truncName}`, px, size - geneMargin - 2);
      ctx.restore();

      ctx.save();
      ctx.fillStyle = gene.strand === '+' ? '#2563eb' : '#dc2626';
      ctx.globalAlpha = 0.7;
      ctx.fillRect(size - geneMargin - 1, gStartPx, 1, gEndPx - gStartPx);
      ctx.translate(size - geneMargin - 2, px);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.globalAlpha = 0.85;
      ctx.fillText(`${strandArrow}${truncName}`, 0, 0);
      ctx.restore();
    }
  }

  ctx.restore();
}
