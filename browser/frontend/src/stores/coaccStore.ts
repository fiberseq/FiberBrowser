// ============================================================================
// Co-Accessibility Track Store
// ============================================================================

import { create } from 'zustand';
import { normalizeAnnotationLayer } from '../utils/layerAliases';
import { sameChrom } from '../utils/chromAliases';

export type CoaccTrackMode = 'heatmap' | 'arc' | 'virtual4c' | null;
export type CoaccNormalization = 'raw' | 'oe' | 'oe_distance' | 'correlation';
export type CoaccScaling = 'linear' | 'log' | 'sqrt';
export type CoaccSignalType = 'accessibility' | 'nucleosome' | 'small_fp' | 'linker' | 'all_fp';

/** A Virtual 4C viewpoint; `chrom` is the chromosome it was set on (absent on older ones). */
export interface CoaccViewpoint { genome?: string | null; start: number; end: number; label?: string; chrom?: string }

export interface SerializedCoaccSettings {
  coaccTrackMode: CoaccTrackMode;
  coaccSignalType: CoaccSignalType;
  coaccLayer: string | null;
  coaccNormalization: CoaccNormalization;
  coaccScaling: CoaccScaling;
  coaccColormap: string;
  coaccMinCoverage: number;
  coaccBinSize: number;
  coaccArcThreshold: number;
  coaccArcMaxArcs: number;
  coaccArcMinDistance: number;
  coaccV4cViewpoint: CoaccViewpoint | null;
}

interface CoaccStore {
  coaccTrackMode: CoaccTrackMode;
  coaccSignalType: CoaccSignalType;
  coaccLayer: string | null;
  coaccNormalization: CoaccNormalization;
  coaccScaling: CoaccScaling;
  coaccColormap: string;
  coaccMinCoverage: number;
  coaccBinSize: number; // 0 = auto
  coaccArcThreshold: number;
  coaccArcMaxArcs: number;
  coaccArcMinDistance: number;
  coaccV4cViewpoint: CoaccViewpoint | null;

  // Actions
  toggleCoaccTrackMode: (mode: 'heatmap' | 'arc' | 'virtual4c') => void;
  setCoaccTrackMode: (mode: CoaccTrackMode) => void;
  setCoaccSignalType: (signalType: CoaccSignalType) => void;
  setCoaccLayer: (layer: string | null) => void;
  setCoaccNormalization: (n: CoaccNormalization) => void;
  setCoaccScaling: (s: CoaccScaling) => void;
  setCoaccColormap: (c: string) => void;
  setCoaccMinCoverage: (v: number) => void;
  setCoaccBinSize: (v: number) => void;
  setCoaccArcThreshold: (v: number) => void;
  setCoaccArcMaxArcs: (v: number) => void;
  setCoaccArcMinDistance: (v: number) => void;
  setCoaccV4cViewpoint: (v: CoaccViewpoint | null) => void;
  clearCoaccV4cViewpoint: () => void;
}

/** A mode switch goes through null (so the track remounts); the pending second half. */
let pendingModeSwitch: ReturnType<typeof setTimeout> | null = null;

export const useCoaccStore = create<CoaccStore>((set) => ({
  coaccTrackMode: null,
  coaccSignalType: 'accessibility',
  coaccLayer: null,
  coaccNormalization: 'correlation',
  coaccScaling: 'linear',
  coaccColormap: 'fall',
  coaccMinCoverage: 20,
  coaccBinSize: 0,
  coaccArcThreshold: 1.5,
  coaccArcMaxArcs: 200,
  coaccArcMinDistance: 2,
  coaccV4cViewpoint: null,

  toggleCoaccTrackMode: (mode) => {
    // A switch pending from an earlier click is superseded by this one.
    if (pendingModeSwitch !== null) {
      clearTimeout(pendingModeSwitch);
      pendingModeSwitch = null;
    }
    const current = useCoaccStore.getState().coaccTrackMode;
    if (current === mode) {
      set({ coaccTrackMode: null });
    } else if (current !== null) {
      set({ coaccTrackMode: null });
      pendingModeSwitch = setTimeout(() => {
        pendingModeSwitch = null;
        set({ coaccTrackMode: mode });
      }, 0);
    } else {
      set({ coaccTrackMode: mode });
    }
  },
  setCoaccTrackMode: (coaccTrackMode) => {
    if (pendingModeSwitch !== null) {
      clearTimeout(pendingModeSwitch);
      pendingModeSwitch = null;
    }
    set({ coaccTrackMode });
  },
  setCoaccSignalType: (coaccSignalType) => set({ coaccSignalType }),
  setCoaccLayer: (coaccLayer) => set({ coaccLayer: normalizeAnnotationLayer(coaccLayer) }),
  setCoaccNormalization: (coaccNormalization) => set({ coaccNormalization }),
  setCoaccScaling: (coaccScaling) => set({ coaccScaling }),
  setCoaccColormap: (coaccColormap) => set({ coaccColormap }),
  setCoaccMinCoverage: (coaccMinCoverage) => set({ coaccMinCoverage }),
  setCoaccBinSize: (coaccBinSize) => set({ coaccBinSize }),
  setCoaccArcThreshold: (coaccArcThreshold) => set({ coaccArcThreshold }),
  setCoaccArcMaxArcs: (coaccArcMaxArcs) => set({ coaccArcMaxArcs }),
  setCoaccArcMinDistance: (coaccArcMinDistance) => set({ coaccArcMinDistance }),
  setCoaccV4cViewpoint: (coaccV4cViewpoint) => set({ coaccV4cViewpoint }),
  clearCoaccV4cViewpoint: () => set({ coaccV4cViewpoint: null }),
}));

function pickString<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function pickNullableTrackMode(value: unknown, fallback: CoaccTrackMode): CoaccTrackMode {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (value === 'heatmap' || value === 'arc' || value === 'virtual4c') return value;
  return fallback;
}

function pickNullableString(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value !== null && typeof value !== 'string') return null;
  return normalizeAnnotationLayer(value);
}

function pickFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pickV4cViewpoint(value: unknown, fallback: SerializedCoaccSettings['coaccV4cViewpoint']): SerializedCoaccSettings['coaccV4cViewpoint'] {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.start !== 'number' || typeof v.end !== 'number') return null;
  return {
    start: v.start,
    end: v.end,
    ...(typeof v.label === 'string' ? { label: v.label } : {}),
    ...(typeof v.chrom === 'string' && v.chrom ? { chrom: v.chrom } : {}),
    ...(v.genome === null || typeof v.genome === 'string' ? { genome: v.genome } : {}),
  };
}

export function serializeCoaccSettings(): SerializedCoaccSettings {
  const s = useCoaccStore.getState();
  return {
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
  };
}

export function applyCoaccSettings(settings: unknown): void {
  if (!settings || typeof settings !== 'object') return;
  const current = useCoaccStore.getState();
  const s = settings as Partial<SerializedCoaccSettings>;
  useCoaccStore.setState({
    coaccTrackMode: pickNullableTrackMode(s.coaccTrackMode, current.coaccTrackMode),
    coaccSignalType: pickString(
      s.coaccSignalType,
      ['accessibility', 'nucleosome', 'small_fp', 'linker', 'all_fp'] as const,
      current.coaccSignalType,
    ),
    coaccLayer: pickNullableString(s.coaccLayer, current.coaccLayer),
    coaccNormalization: pickString(
      s.coaccNormalization,
      ['raw', 'oe', 'oe_distance', 'correlation'] as const,
      current.coaccNormalization,
    ),
    coaccScaling: pickString(
      s.coaccScaling,
      ['linear', 'log', 'sqrt'] as const,
      current.coaccScaling,
    ),
    coaccColormap: typeof s.coaccColormap === 'string' ? s.coaccColormap : current.coaccColormap,
    coaccMinCoverage: pickFiniteNumber(s.coaccMinCoverage, current.coaccMinCoverage),
    coaccBinSize: pickFiniteNumber(s.coaccBinSize, current.coaccBinSize),
    coaccArcThreshold: pickFiniteNumber(s.coaccArcThreshold, current.coaccArcThreshold),
    coaccArcMaxArcs: pickFiniteNumber(s.coaccArcMaxArcs, current.coaccArcMaxArcs),
    coaccArcMinDistance: pickFiniteNumber(s.coaccArcMinDistance, current.coaccArcMinDistance),
    coaccV4cViewpoint: pickV4cViewpoint(s.coaccV4cViewpoint, current.coaccV4cViewpoint),
  });
}

/**
 * The Virtual 4C viewpoint position for a window: a clicked viewpoint applies on
 * its own chromosome and inside the window (one saved before viewpoints
 * recorded a chromosome counts as this one's); otherwise the window's centre,
 * never the same number on another chromosome.
 */
export function coaccViewpointPosition(vp: CoaccViewpoint | null, chrom: string, start: number, end: number, genome: string | null = null): number {
  if (vp && (vp.genome === undefined || vp.genome === genome) && (!vp.chrom || sameChrom(vp.chrom, chrom))) {
    const pos = Math.round((vp.start + vp.end) / 2);
    if (pos >= start && pos <= end) return pos;
  }
  return Math.round((start + end) / 2);
}
