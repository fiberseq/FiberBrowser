import { describe, expect, it } from 'vitest';
import type { ContactArc } from '../types/dafc';
import {
  applyVirtual4CThreshold,
  findClosestArc,
  genomeToMicrocScreen,
  getArcColor,
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
  smoothVirtual4CProfile,
} from './microcMath';

describe('Micro-C math helpers', () => {
  it('selects the finest resolution that keeps bin count bounded', () => {
    expect(selectMicrocResolution(20_000, [100, 1_000, 5_000])).toBe(100);
    expect(selectMicrocResolution(5_000_000, [100, 1_000, 5_000])).toBe(5_000);
    expect(selectMicrocResolution(10_000, [])).toBe(1_000);
  });

  it('generates stable color strings for normalized and O/E arc values', () => {
    expect(getArcColor(0)).toBe('rgb(30, 136, 229)');
    expect(getArcColor(0.5)).toBe('rgb(255, 255, 50)');
    expect(getArcColor(1)).toBe('rgb(255, 50, 0)');
    expect(getOEColor(1)).toBe('rgb(255, 220, 50)');
    expect(getOEColor(4)).toBe('rgb(255, 0, 0)');
  });

  it('tests bin overlap against selected peak indices', () => {
    const peaks = [
      { index: 0, start: 100, end: 200 },
      { index: 1, start: 500, end: 550 },
    ] as any;
    expect(overlapsSelectedPeaks(90, peaks, new Set([0]), 20)).toBe(true);
    expect(overlapsSelectedPeaks(250, peaks, new Set([0]), 20)).toBe(false);
    expect(overlapsSelectedPeaks(510, peaks, new Set([0]), 20)).toBe(false);
    expect(overlapsSelectedPeaks(510, peaks, new Set([1]), 20)).toBe(true);
  });

  it('merges nearby arcs with count-weighted centroids and strengths', () => {
    const arcs: ContactArc[] = [
      { start: 100, end: 1000, count: 2, strength: 0.4, distance: 900 },
      { start: 140, end: 1040, count: 6, strength: 0.8, distance: 900 },
      { start: 900, end: 2000, count: 1, strength: 0.2, distance: 1100 },
    ];

    const merged = mergeArcs(arcs, 500);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      start: 130,
      end: 1030,
      count: 8,
      distance: 900,
    });
    expect(merged[0].strength).toBeCloseTo(0.7);
    expect(merged[1]).toMatchObject({ start: 900, end: 2000, count: 1, strength: 0.2 });
  });

  it('maps genomic positions to Micro-C screen coordinates in both orientations', () => {
    expect(genomeToMicrocScreen(100, 0, 1000, 10, 100, false)).toBe(20);
    expect(genomeToMicrocScreen(100, 0, 1000, 10, 100, true)).toBe(100);
    expect(genomeToMicrocScreen(900, 0, 1000, 10, 100, true)).toBe(20);
  });

  it('computes local and stable arc strength scales', () => {
    const arcs: ContactArc[] = [
      { start: 100, end: 400, count: 1, strength: 0.25, distance: 300 },
      { start: 600, end: 900, count: 1, strength: 0.75, distance: 300 },
      { start: 1200, end: 1600, count: 1, strength: 0.95, distance: 400 },
    ];

    expect(getArcStrengthScale(arcs, 0, 1000, false)).toEqual({
      minVisibleStrength: 0.25,
      maxVisibleStrength: 0.75,
      strengthRange: 0.5,
    });
    expect(getArcStrengthScale(arcs, 0, 1000, true)).toEqual({
      minVisibleStrength: 1,
      maxVisibleStrength: 4,
      strengthRange: 3,
    });
  });

  it('finds the closest arc using the shared curve geometry', () => {
    const arcs: ContactArc[] = [
      { start: 100, end: 900, count: 4, strength: 0.5, distance: 800 },
      { start: 200, end: 700, count: 2, strength: 1.0, distance: 500 },
    ];
    const options = {
      start: 0,
      end: 1000,
      sidebarWidth: 10,
      trackWidth: 100,
      height: 60,
      isReversed: false,
      isStableMode: false,
    };
    const scale = getArcStrengthScale(arcs, 0, 1000, false);
    const curve = getArcCurveGeometry(arcs[0], options, scale);

    const closest = findClosestArc(
      arcs,
      { x: curve.midX, y: (curve.baselineY + curve.controlY) / 2 },
      options,
    );
    expect(closest?.arc).toBe(arcs[0]);
    expect(closest?.distance).toBeLessThan(1);
  });

  it('finds closest arcs in reversed viewports', () => {
    const arcs: ContactArc[] = [
      { start: 100, end: 250, count: 4, strength: 0.5, distance: 150 },
      { start: 750, end: 900, count: 4, strength: 0.5, distance: 150 },
    ];
    const options = {
      start: 0,
      end: 1000,
      sidebarWidth: 0,
      trackWidth: 100,
      height: 60,
      isReversed: true,
      isStableMode: false,
    };
    const scale = getArcStrengthScale(arcs, 0, 1000, false);
    const curve = getArcCurveGeometry(arcs[0], options, scale);

    const closest = findClosestArc(
      arcs,
      { x: curve.midX, y: (curve.baselineY + curve.controlY) / 2 },
      options,
    );
    expect(closest?.arc).toBe(arcs[0]);
  });

  it('thresholds, smooths, and normalizes Virtual 4C profiles reproducibly', () => {
    const thresholded = applyVirtual4CThreshold([0, 2, 4, 8], 3);
    expect(thresholded).toEqual([0, 0, 4, 8]);

    const smoothed = smoothVirtual4CProfile(thresholded, 3);
    expect(smoothed[0]).toBeCloseTo(0);
    expect(smoothed[1]).toBeCloseTo(4 / 3);
    expect(smoothed[2]).toBeCloseTo(4);
    expect(smoothed[3]).toBeCloseTo(6);

    const prepared = prepareVirtual4CProfile([0, 2, 4, 8], 3, 3);
    expect(prepared).toEqual(smoothed);

    const normalized = normalizeVirtual4CProfile([0, 3, 6]);
    expect(normalized.maxValue).toBe(6);
    expect(normalized.normalized).toEqual([0, 0.5, 1]);
    expect(normalizeVirtual4CProfile([])).toEqual({ maxValue: 0, normalized: [] });
  });

  it('computes Virtual 4C viewpoint highlight bounds in both orientations', () => {
    expect(getViewpointScreenRange(100, 200, 0, 1000, 10, 100, false)).toEqual({
      x1: 20,
      x2: 30,
      width: 10,
    });
    expect(getViewpointScreenRange(100, 200, 0, 1000, 10, 100, true)).toEqual({
      x1: 90,
      x2: 100,
      width: 10,
    });
  });

  it('computes APA matrix ranges and heatmap colors', () => {
    expect(getMatrixValueRange([[2, 4], [6, 8]])).toEqual({
      minValue: 2,
      maxValue: 8,
      range: 6,
    });
    expect(getMatrixValueRange([[5, 5]])).toEqual({
      minValue: 5,
      maxValue: 5,
      range: 1,
    });
    expect(getMatrixValueRange([])).toEqual({
      minValue: 0,
      maxValue: 0,
      range: 1,
    });

    expect(getApaHeatmapColor(0, 0, 10)).toBe('rgb(255, 255, 255)');
    expect(getApaHeatmapColor(5, 0, 10)).toBe('rgb(255, 255, 0)');
    expect(getApaHeatmapColor(10, 0, 10)).toBe('rgb(255, 0, 0)');
    expect(getApaHeatmapColor(15, 0, 10)).toBe('rgb(255, 0, 0)');
  });
});
