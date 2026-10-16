/**
 * The read map in Clusters › Overview (fb-n5-projection): pure decisions the
 * component makes, kept here so they can be tested without a canvas.
 */

/** How Overview shows the cluster profiles and the read map. */
export type OverviewMode = 'profiles' | 'map' | 'both';

/** Side by side needs room for the profile cards and a useful map. */
export const OVERVIEW_SIDE_BY_SIDE_MIN_WIDTH = 760;

/**
 * What Overview shows at this width: side by side only when it fits; a
 * narrow panel shows one at a time (a remembered "both" shows the profiles).
 */
export function effectiveOverviewMode(mode: OverviewMode, width: number): OverviewMode {
  if (mode === 'both' && width < OVERVIEW_SIDE_BY_SIDE_MIN_WIDTH) return 'profiles';
  return mode;
}

/** The modes the switch offers at this width. */
export function overviewModeOptions(width: number): OverviewMode[] {
  return width >= OVERVIEW_SIDE_BY_SIDE_MIN_WIDTH ? ['profiles', 'both', 'map'] : ['profiles', 'map'];
}

/** Widths of the two columns side by side (profiles left, map right). */
export function overviewColumns(width: number): { list: number; map: number } {
  const gap = 12;
  const list = Math.round(Math.min(440, Math.max(300, width * 0.36)));
  return { list, map: Math.max(240, width - list - gap) };
}

/** The map's size for the room it has (side by side: two maps share the width). */
export function mapSize(width: number, sideBySide: boolean, maxHeight = 680): { width: number; height: number } {
  const w = Math.max(240, Math.floor(width));
  if (sideBySide) {
    const each = Math.floor((w - 8) / 2);
    return { width: each, height: Math.max(220, Math.min(maxHeight, each)) };
  }
  return { width: w, height: Math.max(260, Math.min(maxHeight, Math.round(w * 0.78))) };
}

/**
 * The cluster focus after a click on the map or its legend: a click focuses
 * that cluster alone (a click on the only focused one clears the focus);
 * ⇧-click adds it to the focus or takes it out. All clusters focused is no
 * focus (null), as elsewhere.
 */
export function nextMapFocus(
  current: ReadonlySet<number> | null | undefined,
  cluster: number,
  additive: boolean,
  allClusters: readonly number[],
): Set<number> | null {
  if (!additive) {
    if (current && current.size === 1 && current.has(cluster)) return null;
    return new Set([cluster]);
  }
  const next = new Set(current ?? []);
  if (next.has(cluster)) next.delete(cluster);
  else next.add(cluster);
  if (next.size === 0) return null;
  if (allClusters.length > 0 && allClusters.every(c => next.has(c))) return null;
  return next;
}

/** "C3, C5 focused" / null — the legend's status line. */
export function focusSummary(focus: ReadonlySet<number> | null | undefined, label: (c: number) => string): string | null {
  if (!focus || focus.size === 0) return null;
  const ids = [...focus].sort((a, b) => a - b);
  return `${ids.slice(0, 4).map(label).join(', ')}${ids.length > 4 ? ` +${ids.length - 4}` : ''} focused`;
}
