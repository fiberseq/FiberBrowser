/**
 * The full legend of a set of plots (cluster metaprofile cards, the Profiles tab's charts): every plot in the set
 * lists every entry the set shows, in the same order, so every legend takes the same room and the plot areas line up
 * across the set. An entry a plot has no data for stays in its legend, drawn hollow, with a note saying so.
 */
export interface PlotLegendItem {
  key: string;
  label: string;
  color: string;
  /** No data for this entry in this plot: drawn hollow and muted. */
  missing?: boolean;
  /** Hover text (a missing entry: "no <layer> in this cluster"). */
  title?: string;
}

/** The set's entries for one plot: every entry in order, those this plot lacks marked missing with their note. */
export function fullSetLegend(
  entries: ReadonlyArray<{ key: string; label: string; color: string }>,
  has: (key: string) => boolean,
  missingTitle: (label: string) => string,
): PlotLegendItem[] {
  return entries.map(e => (has(e.key) ? { ...e } : { ...e, missing: true, title: missingTitle(e.label) }));
}

/** The legend's labels in order (a data attribute, so tests compare legends across a set). */
export const legendSignature = (items: ReadonlyArray<{ label: string }>): string => items.map(i => i.label).join('|');
