import type { ContactArc } from '../types/dafc';
import type { FirePeak } from '../types';

export function selectMicrocResolution(viewportSize: number, availableResolutions: number[]): number {
  if (availableResolutions.length === 0) return 1000;

  const sorted = [...availableResolutions].sort((a, b) => a - b);
  const maxBins = 2000;
  const minResolution = viewportSize / maxBins;
  return sorted.find(res => res >= minResolution) ?? sorted[sorted.length - 1];
}

export function getArcColor(strength: number): string {
  if (strength < 0.5) {
    const t = strength * 2;
    const r = Math.round(30 + t * 225);
    const g = Math.round(136 + t * 119);
    const b = Math.round(229 - t * 179);
    return `rgb(${r}, ${g}, ${b})`;
  }

  const t = (strength - 0.5) * 2;
  const r = 255;
  const g = Math.round(255 - t * 205);
  const b = Math.round(50 - t * 50);
  return `rgb(${r}, ${g}, ${b})`;
}

export function getOEColor(oe: number): string {
  if (oe < 1) {
    const t = Math.max(0, Math.min(1, oe));
    const r = Math.round(100 + 155 * t);
    const g = Math.round(150 + 105 * t);
    const b = 255;
    return `rgb(${r}, ${g}, ${b})`;
  }

  const logOE = Math.log2(oe);
  const t = Math.min(1, logOE / 2);
  const r = 255;
  const g = Math.round(220 * (1 - t));
  const b = Math.round(50 * (1 - t));
  return `rgb(${r}, ${g}, ${b})`;
}

export function overlapsSelectedPeaks(
  position: number,
  peaks: FirePeak[],
  selectedIndices: Set<number>,
  resolution: number,
): boolean {
  const binStart = position;
  const binEnd = position + resolution;

  for (const peak of peaks) {
    if (!selectedIndices.has(peak.index)) continue;
    if (binStart < peak.end && binEnd > peak.start) return true;
  }
  return false;
}

export function mergeArcs(arcs: ContactArc[], binSize: number): ContactArc[] {
  if (arcs.length === 0 || binSize <= 0) return arcs;

  const bins = new Map<string, { totalCount: number; totalStrength: number; arcs: ContactArc[] }>();
  for (const arc of arcs) {
    const startBin = Math.floor(arc.start / binSize);
    const endBin = Math.floor(arc.end / binSize);
    const key = `${startBin}:${endBin}`;
    const existing = bins.get(key);

    if (existing) {
      existing.totalCount += arc.count;
      existing.totalStrength += arc.strength * arc.count;
      existing.arcs.push(arc);
    } else {
      bins.set(key, {
        totalCount: arc.count,
        totalStrength: arc.strength * arc.count,
        arcs: [arc],
      });
    }
  }

  const merged: ContactArc[] = [];
  for (const [, bin] of bins) {
    if (bin.totalCount === 0) continue;

    let weightedStart = 0;
    let weightedEnd = 0;
    for (const arc of bin.arcs) {
      weightedStart += arc.start * arc.count;
      weightedEnd += arc.end * arc.count;
    }

    const avgStart = Math.round(weightedStart / bin.totalCount);
    const avgEnd = Math.round(weightedEnd / bin.totalCount);
    merged.push({
      start: avgStart,
      end: avgEnd,
      count: bin.totalCount,
      strength: bin.totalStrength / bin.totalCount,
      distance: avgEnd - avgStart,
    });
  }

  return merged;
}

export interface ArcGeometryOptions {
  start: number;
  end: number;
  sidebarWidth: number;
  trackWidth: number;
  height: number;
  isReversed: boolean;
  isStableMode: boolean;
}

export interface ArcStrengthScale {
  minVisibleStrength: number;
  maxVisibleStrength: number;
  strengthRange: number;
}

export interface ArcCurveGeometry {
  x1: number;
  x2: number;
  midX: number;
  baselineY: number;
  controlY: number;
  normalizedStrength: number;
}

export function visibleArcsInViewport(arcs: ContactArc[], start: number, end: number): ContactArc[] {
  return arcs.filter(arc => arc.end >= start && arc.start <= end);
}

export function getArcStrengthScale(
  arcs: ContactArc[],
  start: number,
  end: number,
  isStableMode: boolean,
): ArcStrengthScale {
  if (isStableMode) {
    return { minVisibleStrength: 1, maxVisibleStrength: 4, strengthRange: 3 };
  }

  const visibleArcs = visibleArcsInViewport(arcs, start, end);
  const maxVisibleStrength = visibleArcs.length > 0
    ? Math.max(...visibleArcs.map(arc => arc.strength))
    : 1;
  const minVisibleStrength = visibleArcs.length > 0
    ? Math.min(...visibleArcs.map(arc => arc.strength))
    : 0;
  return {
    minVisibleStrength,
    maxVisibleStrength,
    strengthRange: maxVisibleStrength - minVisibleStrength || 1,
  };
}

export function genomeToMicrocScreen(
  pos: number,
  start: number,
  end: number,
  sidebarWidth: number,
  trackWidth: number,
  isReversed: boolean,
): number {
  const viewportSize = end - start || 1;
  const frac = (pos - start) / viewportSize;
  return sidebarWidth + (isReversed ? (1 - frac) : frac) * trackWidth;
}

export function normalizedArcStrength(
  arc: ContactArc,
  scale: ArcStrengthScale,
  isStableMode: boolean,
): number {
  if (isStableMode) {
    const oe = Math.max(0.5, arc.strength);
    const logOE = oe >= 1 ? Math.log2(oe) : -(1 - oe);
    return 0.2 + 0.8 * Math.max(0, Math.min(1, logOE / 2));
  }

  return 0.2 + 0.8 * (arc.strength - scale.minVisibleStrength) / scale.strengthRange;
}

export function getArcCurveGeometry(
  arc: ContactArc,
  options: ArcGeometryOptions,
  scale: ArcStrengthScale,
): ArcCurveGeometry {
  const baselineY = options.height - 5;
  const maxArcHeight = options.height - 15;
  const x1 = genomeToMicrocScreen(
    arc.start,
    options.start,
    options.end,
    options.sidebarWidth,
    options.trackWidth,
    options.isReversed,
  );
  const x2 = genomeToMicrocScreen(
    arc.end,
    options.start,
    options.end,
    options.sidebarWidth,
    options.trackWidth,
    options.isReversed,
  );
  const normalizedStrength = normalizedArcStrength(arc, scale, options.isStableMode);
  const arcHeight = normalizedStrength * maxArcHeight;
  return {
    x1,
    x2,
    midX: (x1 + x2) / 2,
    baselineY,
    controlY: baselineY - arcHeight,
    normalizedStrength,
  };
}

export function distanceToArcCurve(
  point: { x: number; y: number },
  curve: ArcCurveGeometry,
  samples = 20,
): number {
  let closestDistance = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const bx = (1 - t) * (1 - t) * curve.x1 + 2 * (1 - t) * t * curve.midX + t * t * curve.x2;
    const by = (1 - t) * (1 - t) * curve.baselineY + 2 * (1 - t) * t * curve.controlY + t * t * curve.baselineY;
    const dist = Math.sqrt((point.x - bx) ** 2 + (point.y - by) ** 2);
    if (dist < closestDistance) closestDistance = dist;
  }
  return closestDistance;
}

export function findClosestArc(
  arcs: ContactArc[],
  point: { x: number; y: number },
  options: ArcGeometryOptions,
  samples = 20,
): { arc: ContactArc; distance: number } | null {
  const scale = getArcStrengthScale(arcs, options.start, options.end, options.isStableMode);
  let closestArc: ContactArc | null = null;
  let closestDistance = Infinity;

  for (const arc of arcs) {
    if (arc.end < options.start || arc.start > options.end) continue;
    const curve = getArcCurveGeometry(arc, options, scale);
    const dist = distanceToArcCurve(point, curve, samples);
    if (dist < closestDistance) {
      closestDistance = dist;
      closestArc = arc;
    }
  }

  return closestArc ? { arc: closestArc, distance: closestDistance } : null;
}

export function applyVirtual4CThreshold(profile: number[], minCount: number): number[] {
  if (minCount <= 0) return [...profile];
  return profile.map(value => (value >= minCount ? value : 0));
}

export function smoothVirtual4CProfile(profile: number[], smoothingWindow: number): number[] {
  if (smoothingWindow <= 1 || profile.length === 0) return [...profile];

  const smoothed = new Array(profile.length).fill(0);
  const halfWindow = Math.floor(smoothingWindow / 2);
  for (let i = 0; i < profile.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(profile.length - 1, i + halfWindow); j++) {
      sum += profile[j];
      count++;
    }
    smoothed[i] = sum / count;
  }
  return smoothed;
}

export function prepareVirtual4CProfile(
  rawProfile: number[],
  minCount: number,
  smoothingWindow: number,
): number[] {
  return smoothVirtual4CProfile(
    applyVirtual4CThreshold(rawProfile, minCount),
    smoothingWindow,
  );
}

export function normalizeVirtual4CProfile(profile: number[]): { maxValue: number; normalized: number[] } {
  const maxValue = profile.length > 0 ? Math.max(...profile) : 0;
  return {
    maxValue,
    normalized: maxValue > 0 ? profile.map(value => value / maxValue) : profile.map(() => 0),
  };
}

export function getViewpointScreenRange(
  viewpointStart: number,
  viewpointEnd: number,
  start: number,
  end: number,
  sidebarWidth: number,
  trackWidth: number,
  isReversed: boolean,
): { x1: number; x2: number; width: number } {
  const startX = genomeToMicrocScreen(viewpointStart, start, end, sidebarWidth, trackWidth, isReversed);
  const endX = genomeToMicrocScreen(viewpointEnd, start, end, sidebarWidth, trackWidth, isReversed);
  const x1 = Math.min(startX, endX);
  const x2 = Math.max(startX, endX);
  return { x1, x2, width: x2 - x1 };
}

export function getMatrixValueRange(matrix: number[][]): { minValue: number; maxValue: number; range: number } {
  let minValue = Infinity;
  let maxValue = -Infinity;
  for (const row of matrix) {
    for (const value of row) {
      if (value < minValue) minValue = value;
      if (value > maxValue) maxValue = value;
    }
  }
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return { minValue: 0, maxValue: 0, range: 1 };
  }
  return { minValue, maxValue, range: maxValue - minValue || 1 };
}

export function getApaHeatmapColor(value: number, minValue: number, range: number): string {
  const normalized = Math.max(0, Math.min(1, (value - minValue) / (range || 1)));

  if (normalized < 0.5) {
    const t = normalized * 2;
    return `rgb(255, 255, ${Math.round(255 * (1 - t))})`;
  }

  const t = (normalized - 0.5) * 2;
  return `rgb(255, ${Math.round(255 * (1 - t))}, 0)`;
}
