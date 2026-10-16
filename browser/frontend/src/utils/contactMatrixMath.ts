import { sameChrom } from './chromAliases';
export interface MatrixViewport {
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
}

export interface MatrixPoint {
  x: number;
  y: number;
}

export interface MatrixBufferBounds extends MatrixViewport {
  chrom: string;
  resolution: number;
}

export function formatContactDistance(bp: number): string {
  const abs = Math.abs(bp);
  if (abs >= 1e6) return `${(bp / 1e6).toFixed(1)}Mb`;
  if (abs >= 1e3) return `${(bp / 1e3).toFixed(1)}kb`;
  return `${bp}bp`;
}

export function selectMatrixResolution(viewSize: number, resolutions: number[], targetBins = 800): number {
  if (resolutions.length === 0) return 10000;
  const idealResolution = viewSize / targetBins;
  const sorted = [...resolutions].sort((a, b) => a - b);
  return sorted.find(res => res >= idealResolution) ?? sorted[sorted.length - 1] ?? 10000;
}

export function getOverscanBounds(viewport: MatrixViewport, overscan = 0.5): MatrixViewport {
  const xPad = (viewport.xEnd - viewport.xStart) * overscan;
  const yPad = (viewport.yEnd - viewport.yStart) * overscan;
  return {
    xStart: Math.max(0, Math.round(viewport.xStart - xPad)),
    xEnd: Math.round(viewport.xEnd + xPad),
    yStart: Math.max(0, Math.round(viewport.yStart - yPad)),
    yEnd: Math.round(viewport.yEnd + yPad),
  };
}

export function viewportFitsBuffer(
  viewport: MatrixViewport,
  buffer: MatrixBufferBounds | null | undefined,
  chrom: string,
  resolution: number,
): boolean {
  if (!buffer || buffer.chrom !== chrom || buffer.resolution !== resolution) return false;
  return (
    viewport.xStart >= buffer.xStart &&
    viewport.xEnd <= buffer.xEnd &&
    viewport.yStart >= buffer.yStart &&
    viewport.yEnd <= buffer.yEnd
  );
}

export function getPannedViewport(viewport: MatrixViewport, panOffset: MatrixPoint, matrixSize: number): MatrixViewport {
  const xSize = viewport.xEnd - viewport.xStart;
  const ySize = viewport.yEnd - viewport.yStart;
  const dx = -(panOffset.x / matrixSize) * xSize;
  const dy = -(panOffset.y / matrixSize) * ySize;
  return {
    xStart: viewport.xStart + dx,
    xEnd: viewport.xEnd + dx,
    yStart: viewport.yStart + dy,
    yEnd: viewport.yEnd + dy,
  };
}

export function pixelToGenome(pixel: number, start: number, end: number, matrixSize: number): number {
  return Math.round(start + (pixel / matrixSize) * (end - start));
}

export function clampTrackX(x: number, sidebarWidth: number, totalWidth: number): number {
  return Math.max(sidebarWidth, Math.min(totalWidth, x));
}

export function screenSelectionToGenomeRange(
  x1: number,
  x2: number,
  start: number,
  end: number,
  sidebarWidth: number,
  trackWidth: number,
  isReversed = false,
): { start: number; end: number } {
  const viewportSize = end - start;
  const safeTrackWidth = trackWidth || 1;
  const toGenome = (x: number) => {
    const frac = (clampTrackX(x, sidebarWidth, sidebarWidth + safeTrackWidth) - sidebarWidth) / safeTrackWidth;
    return isReversed ? end - frac * viewportSize : start + frac * viewportSize;
  };

  const a = toGenome(x1);
  const b = toGenome(x2);
  return {
    start: Math.round(Math.min(a, b)),
    end: Math.round(Math.max(a, b)),
  };
}

export function isMeaningfulMatrixSelection(start: MatrixPoint, end: MatrixPoint, minPixels = 4): boolean {
  return Math.abs(end.x - start.x) > minPixels && Math.abs(end.y - start.y) > minPixels;
}

/**
 * The matrix focus that applies to this view: none when it was drawn in another
 * panel, on another chromosome, or no longer overlaps (a focus saved before it
 * carried a panel and chromosome applies wherever it overlaps).
 */
export function matrixFocusForView<F extends { start: number; end: number; chrom?: string; panelId?: string }>(
  focus: F | null,
  panelId: string | undefined,
  chrom: string,
  start: number,
  end: number,
): F | null {
  if (!focus) return null;
  if (focus.panelId && panelId && focus.panelId !== panelId) return null;
  if (focus.chrom && !sameChrom(focus.chrom, chrom)) return null;
  if (focus.end <= start || focus.start >= end) return null;
  return focus;
}
