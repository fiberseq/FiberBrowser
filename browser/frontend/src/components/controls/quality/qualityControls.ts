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
