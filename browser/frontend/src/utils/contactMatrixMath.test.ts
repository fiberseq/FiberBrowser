import { describe, expect, it } from 'vitest';
import {
  clampTrackX,
  matrixFocusForView,
  formatContactDistance,
  getOverscanBounds,
  getPannedViewport,
  isMeaningfulMatrixSelection,
  pixelToGenome,
  screenSelectionToGenomeRange,
  selectMatrixResolution,
  viewportFitsBuffer,
} from './contactMatrixMath';

describe('contact matrix math', () => {
  it('formats contact distances compactly', () => {
    expect(formatContactDistance(850)).toBe('850bp');
    expect(formatContactDistance(5_700)).toBe('5.7kb');
    expect(formatContactDistance(1_250_000)).toBe('1.3Mb');
  });

  it('selects bounded matrix resolutions', () => {
    expect(selectMatrixResolution(40_000, [10, 100, 1_000])).toBe(100);
    expect(selectMatrixResolution(9_000_000, [1_000, 5_000])).toBe(5_000);
    expect(selectMatrixResolution(10_000, [])).toBe(10_000);
  });

  it('computes overscan buffer bounds and containment', () => {
    const bounds = getOverscanBounds({ xStart: 100, xEnd: 200, yStart: 20, yEnd: 120 }, 0.5);
    expect(bounds).toEqual({ xStart: 50, xEnd: 250, yStart: 0, yEnd: 170 });
    expect(viewportFitsBuffer({ xStart: 100, xEnd: 200, yStart: 20, yEnd: 120 }, { ...bounds, chrom: 'chr2L', resolution: 1000 }, 'chr2L', 1000)).toBe(true);
    expect(viewportFitsBuffer({ xStart: 0, xEnd: 200, yStart: 20, yEnd: 120 }, { ...bounds, chrom: 'chr2L', resolution: 1000 }, 'chr2L', 1000)).toBe(false);
  });

  it('maps pan and pixel coordinates to genomic coordinates', () => {
    expect(getPannedViewport({ xStart: 100, xEnd: 300, yStart: 500, yEnd: 900 }, { x: 50, y: -25 }, 100))
      .toEqual({ xStart: 0, xEnd: 200, yStart: 600, yEnd: 1000 });
    expect(pixelToGenome(50, 100, 300, 100)).toBe(200);
  });

  it('clamps matrix strip selections to the track body', () => {
    expect(clampTrackX(5, 20, 120)).toBe(20);
    expect(clampTrackX(80, 20, 120)).toBe(80);
    expect(clampTrackX(180, 20, 120)).toBe(120);

    expect(screenSelectionToGenomeRange(10, 70, 1000, 2000, 20, 100)).toEqual({
      start: 1000,
      end: 1500,
    });
    expect(screenSelectionToGenomeRange(70, 10, 1000, 2000, 20, 100, true)).toEqual({
      start: 1500,
      end: 2000,
    });
  });

  it('ignores accidental click-size selections', () => {
    expect(isMeaningfulMatrixSelection({ x: 10, y: 10 }, { x: 13, y: 50 })).toBe(false);
    expect(isMeaningfulMatrixSelection({ x: 10, y: 10 }, { x: 50, y: 50 })).toBe(true);
  });
});

describe('matrixFocusForView', () => {
  const focus = { start: 100, end: 200, chrom: 'chr1', panelId: 'p1' };
  it('applies only in the panel and on the chromosome it was drawn on, while in view', () => {
    expect(matrixFocusForView(focus, 'p1', '1', 0, 1000)).toBe(focus);
    expect(matrixFocusForView(focus, 'p2', 'chr1', 0, 1000)).toBeNull();
    expect(matrixFocusForView(focus, 'p1', 'chr2', 0, 1000)).toBeNull();
    expect(matrixFocusForView(focus, 'p1', 'chr1', 5000, 6000)).toBeNull();
    expect(matrixFocusForView({ start: 100, end: 200 }, 'p2', 'chr9', 0, 1000)).toEqual({ start: 100, end: 200 });
  });
});
