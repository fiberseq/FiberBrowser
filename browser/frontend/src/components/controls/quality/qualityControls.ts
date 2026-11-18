import type { LayerQualityFilter } from '../../../types';

/** Footprint-class support score (0-255): the meaningful one to filter on. */
export const STATE_SCORE = 'q0';

/** Layers in view that carry a class support score. */
/** Class layers made by a class run in this browser (tf_cr, tf_cr_manual, ...):
 * their assignments are set by Assignment stringency, not a support cutoff. */
export function isBrowserClassLayer(layer: string): boolean {
  return /(^|_)(cr|rc)(_|$)/.test(layer);
}

export function stateScoreLayers(available: Record<string, string[]>): string[] {
  return Object.entries(available)
    .filter(([layer, names]) => names.includes(STATE_SCORE) && !isBrowserClassLayer(layer))
    .map(([layer]) => layer).sort();
}

/** The active state-support cutoff (lowest across state layers), or null when off. */
export function stateSupportCutoff(filters: LayerQualityFilter[]): number | null {
  const values = filters.filter(f => f.enabled && f.qualityName === STATE_SCORE && f.minValue > 0).map(f => f.minValue);
  return values.length ? Math.min(...values) : null;
}

/** Set (or clear, with null) one state-support cutoff on every state layer; other filters are kept. */
export function withStateSupportCutoff(filters: LayerQualityFilter[], layers: string[], cutoff: number | null): LayerQualityFilter[] {
  const others = filters.filter(f => f.qualityName !== STATE_SCORE);
  if (cutoff == null || cutoff <= 0) return others;
  return [...others, ...layers.map(layer => ({ layer, qualityName: STATE_SCORE, minValue: Math.round(cutoff), enabled: true }))];
}

const PLAIN_NAMES: Record<string, string> = {
  q0: 'class support', q1: 'class left edge', q2: 'class right edge', fq: 'class geometry',
  aq: 'score', lq: 'left edge', rq: 'right edge', el: 'TF left edge', er: 'TF right edge',
  nq: 'nuc call score', tq: 'TF call score', op: 'opportunities',
};

export function qualityLabel(name: string): string {
  const plain = PLAIN_NAMES[name];
  return plain ? `${plain} (${name})` : name;
}

/** The FIRE accessibility filter: MSP score aq (= 255 x FIRE precision). */
export const FIRE_LAYER = 'fire';
export const FIRE_SCORE = 'aq';

/** FDR presets offered beside the FIRE threshold slider. */
export const FIRE_FDR_PRESETS = [0.05, 0.1, 0.2] as const;

/** aq cutoff for a FIRE false-discovery rate (aq = 255 x precision): 5% -> 242, 10% -> 230, 20% -> 204. */
export function fireAqForFdr(fdr: number): number {
  return Math.round(255 * (1 - fdr));
}

/** FIRE false-discovery rate (0-1) at an aq cutoff. */
export function fireFdrForAq(aq: number): number {
  return Math.max(0, Math.min(1, 1 - aq / 255));
}

/** "10%": the FDR at an aq cutoff, as a whole percent. */
export function fireFdrLabel(aq: number): string {
  return `${Math.round(100 * fireFdrForAq(aq))}%`;
}

/** Index of the FIRE filter row (layer fire, score aq) in the full list, or -1. */
export function fireFilterIndex(filters: LayerQualityFilter[]): number {
  return filters.findIndex(f => f.layer === FIRE_LAYER && f.qualityName === FIRE_SCORE);
}

/** Whether a filter row is a FIRE filter row (Labeling can add several). */
export function isFireFilter(f: LayerQualityFilter): boolean {
  return f.layer === FIRE_LAYER && f.qualityName === FIRE_SCORE;
}

/**
 * All FIRE rows read as one filter: on when any is on, at the strictest
 * cutoff in effect (every enabled row applies), else the first row's.
 */
export function fireFilterState(filters: LayerQualityFilter[]): { present: boolean; on: boolean; minValue: number | null } {
  const rows = filters.filter(isFireFilter);
  const active = rows.filter(f => f.enabled && f.minValue > 0);
  if (active.length) return { present: true, on: true, minValue: Math.max(...active.map(f => f.minValue)) };
  const first = rows.find(f => f.minValue > 0);
  return { present: rows.length > 0, on: false, minValue: first ? first.minValue : null };
}

/** Set the FIRE filter: duplicate FIRE rows collapse to one (where the first was), or one is added. */
export function withFireFilter(filters: LayerQualityFilter[], next: { minValue: number; enabled: boolean }): LayerQualityFilter[] {
  const row: LayerQualityFilter = { layer: FIRE_LAYER, qualityName: FIRE_SCORE, minValue: Math.round(next.minValue), enabled: next.enabled };
  const at = filters.findIndex(isFireFilter);
  if (at < 0) return [...filters, row];
  return filters.flatMap((f, i) => (i === at ? [row] : isFireFilter(f) ? [] : [f]));
}
