/**
 * Compare as a primary choice of the builder, and what it does to the summary across groups:
 * - The builder shows Compare next to Group by, for the types that have it; with one group its A − B / log2 pills are
 *   disabled with the reason (Off stays, so an old plot can always turn it off). The group count comes from the plot
 *   as drawn (reportGroupCount), keyed by the grouping it was drawn for; unknown (still loading) counts as "may work".
 * - Summary across groups with Compare on: profiles and histograms summarise each comparison (A − B or log2 ratio of
 *   the two sides' summaries, with the seeded bootstrap); the size maps cannot (their box-mean bootstrap runs per
 *   group on the server), so their Summary is disabled with a one-line reason while comparing. Never a control that
 *   silently does nothing. The disabled state is derived, never written: the plot's summary.on is kept, so turning
 *   Compare off brings the summary back and saved plots round-trip unchanged.
 * - One state line under the plot's header says what is shown ("Comparing A vs B · A − B · summary of the difference,
 *   centre ±100 bp").
 */
import { create } from 'zustand';
import type { ResolvedCompareMode } from './compare';
import { compareAvailable, isSizeType, PLOT_COMPARE, type PlotCompare, type PlotGroupBy, type PlotSpec, type PlotType } from './plotModel';

/** The grouping a group count belongs to: a count drawn for another grouping says nothing about this one. */
export const groupingKey = (plot: Pick<PlotSpec, 'id' | 'type' | 'where' | 'groupBy' | 'bed'> & { supplied?: unknown; profile?: Partial<PlotSpec['profile']> }): string =>
  [plot.id, plot.type, plot.where, plot.groupBy, plot.where === 'bed' ? plot.bed.setIds.join(',') : '', plot.supplied ? 'supplied' : '',
    // Settings that split the drawn groups under the same Group by (size bands, state at the anchor, excluded reads).
    String(plot.profile?.band ?? ''), (plot.profile?.bandEdges ?? []).join(','), plot.profile?.conditionOn ? 'cond' : '',
    plot.where === 'bed' && plot.bed?.showExcluded && plot.bed?.occlusionRead !== 'off' ? 'excl' : ''].join('|');

interface GroupCountState { key: string | null; n: number | null }

export const useGroupCount = create<GroupCountState>(() => ({ key: null, n: null }));

/** The plot as drawn has `n` groups (called by each plot when its result is current). */
export function reportGroupCount(plot: Parameters<typeof groupingKey>[0], n: number | null): void {
  const key = groupingKey(plot);
  const cur = useGroupCount.getState();
  if (cur.key !== key || cur.n !== n) useGroupCount.setState({ key, n });
}

/** The drawn group count for this plot's grouping, or null when not known yet. */
export const knownGroupCount = (s: GroupCountState, plot: Parameters<typeof groupingKey>[0]): number | null => (s.key === groupingKey(plot) ? s.n : null);

/** Whether a type has any Compare (Differential compares on its own). */
export const typeHasCompare = (type: PlotType): boolean => PLOT_COMPARE.some(c => c.value !== 'off' && compareAvailable(c, type));

/** Why Compare can't apply to this grouping (the disabled pills' tooltip), or null. */
export function compareGroupBlocker(nGroups: number | null, groupBy: PlotGroupBy, where: PlotSpec['where']): string | null {
  if (nGroups == null || nGroups >= 2) return null;
  if (groupBy === 'cluster') return 'Compare needs at least two clusters here: cluster the reads into two or more groups.';
  if (groupBy === 'none') return where === 'bed'
    ? 'Compare needs two groups: Group by None pools every dataset into one line per BED set. Add a second BED set, or Group by dataset.'
    : 'Compare needs two groups: Group by None pools every dataset into one. Group by dataset, cluster or read groups.';
  if (groupBy === 'read-groups' || groupBy === 'classes') return 'Compare needs two groups: there is only one here. Split the reads into two or more panels, or select two classes.';
  if (where === 'bed') return 'Compare needs two groups: one BED set of one dataset. Add a second BED set or open a second dataset.';
  return 'Compare needs two groups: this view has one dataset. Open a second dataset, or Group by cluster to compare clusters.';
}

/** Compare is in effect: on, and not known to have fewer than two groups. */
export const comparingNow = (compare: PlotCompare, nGroups: number | null): boolean => compare !== 'off' && (nGroups == null || nGroups >= 2);

/** Summary across groups: whether the type offers it at all. */
export const typeHasSummary = (plot: Pick<PlotSpec, 'type' | 'where'>): boolean =>
  (plot.type === 'metaprofile' || plot.type === 'size-histogram' || isSizeType(plot.type)) && plot.where !== 'random';

export const SUMMARY_OFF_WHILE_COMPARING = 'Summary is off while comparing; turn Compare off to summarise each group.';

/** Why the summary can't be drawn in this state (the size maps while comparing), or null: it can. */
export function summaryBlocker(plot: Pick<PlotSpec, 'type' | 'compare'>, nGroups: number | null): string | null {
  return isSizeType(plot.type) && comparingNow(plot.compare, nGroups) ? SUMMARY_OFF_WHILE_COMPARING : null;
}

/** "Comparing Early vs Late · A − B · summary of the difference, centre ±100 bp" (null: not comparing). */
export function compareStateLine(o: {
  compare: PlotCompare; mode: ResolvedCompareMode | null; pairs: Array<{ label: string }>;
  /** null: no summary asked for; 'blocked': asked for but off while comparing; else the window it summarises. */
  summary: null | 'blocked' | { window: string };
}): string | null {
  if (o.compare === 'off' || !o.mode || !o.pairs.length) return null;
  const op = o.compare === 'diff' ? 'A − B' : 'log2(A / B)';
  const what = o.mode === 'a-vs-b' ? `Comparing ${o.pairs[0].label}` : o.mode === 'each-vs-all' ? 'Comparing each group vs all' : 'Comparing each group vs the rest';
  const summary = o.summary == null ? null : o.summary === 'blocked' ? 'summary off while comparing'
    : `summary of the ${o.compare === 'diff' ? 'difference' : 'log2 ratio'}, ${o.summary.window}`;
  return [what, op, summary].filter(Boolean).join(' · ');
}
