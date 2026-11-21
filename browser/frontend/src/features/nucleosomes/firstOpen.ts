/**
 * A fresh view in the nucleosome panel: the datasets whose molecules have no nucleosome calls yet (every series scored
 * nothing and some molecules await analysis). The Regularity view's auto-Analyse setting decides what happens then
 * (`autoAnalyseAction`). The same rule the Clusters view's regularity uses (cluster-detail/useClusterRegularity).
 */
import type { NucAutoAnalyse, NucRegularityObservation } from './types';

export function datasetsToAnalyse(observations: readonly NucRegularityObservation[]): string[] {
  const by = new Map<string, NucRegularityObservation[]>();
  for (const o of observations) if (!o.error) by.set(o.datasetId, [...(by.get(o.datasetId) ?? []), o]);
  return [...by].filter(([, obs]) => obs.every(o => (o.scored ?? 0) === 0) && obs.some(o => (o.notComputed ?? 0) > 0)).map(([d]) => d);
}

/** Default of the Regularity view's auto-Analyse setting (provisional). */
export const DEFAULT_AUTO_ANALYSE: NucAutoAnalyse = 'first';
/** 'every': the view must stay put this long (ms) before an Analyse starts by itself. */
export const AUTO_SETTLE_MS = 1000;

export const AUTO_ANALYSE_OPTIONS: Array<[NucAutoAnalyse, string, string]> = [
  ['off', 'off', 'Never start Analyse by itself: an unanalysed view offers an "Analyse this view" button'],
  ['first', 'first open', 'Start Analyse once, when the Regularity view first opens for this panel; afterwards an unanalysed view offers a button'],
  ['every', 'every view', 'Start Analyse on every unanalysed view once it has settled for a second; moving on cancels the automatic Analyse of the view left'],
];

/** Panels whose 'first open' automatic Analyse is used up (this page). */
const FIRST_SEEN = new Set<string>();

/**
 * What an answer of the Regularity view calls for: 'run' the panel's Analyse for `todo`, 'offer' an "Analyse this
 * view" button, or 'none' (the view is analysed). Pure: nothing is used up here. 'first' is used up
 * (`consumeAutoAnalyse`) when the automatic Analyse actually starts, or by an answer for an analysed view, so
 * panning later never starts one; an answer that could not start it (another Analyse running, the mode changed
 * meanwhile) leaves it for the next.
 */
export function autoAnalyseAction(mode: NucAutoAnalyse, panelKey: string, todo: readonly string[]): 'run' | 'offer' | 'none' {
  if (!todo.length) return 'none';
  const run = mode === 'every' || (mode === 'first' && !FIRST_SEEN.has(panelKey));
  return run ? 'run' : 'offer';
}

/** Use up 'first' for this panel (its automatic Analyse started, or its view is analysed already). */
export function consumeAutoAnalyse(mode: NucAutoAnalyse, panelKey: string): void {
  if (mode === 'first') FIRST_SEEN.add(panelKey);
}

/** Tests: forget which panels have opened. */
export function resetAutoAnalyse(): void { FIRST_SEEN.clear(); }
