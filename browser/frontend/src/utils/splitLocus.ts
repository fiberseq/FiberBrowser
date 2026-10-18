/**
 * A split panel away from where it was split (utils/splitPanels.ts): its reads were classified in the
 * view the split was made in (an SV, a feature pattern there), so elsewhere none of the reads in
 * view belong to a group. The panel says so and offers Go back, Show all reads here, Close split
 * (components/tracks/read-track/SplitAwayBanner.tsx), never an empty panel without a reason.
 */
import { useBrowserStore } from '../stores/browserStore';
import type { PanelConfig, ReadSubset } from '../types';
import { formatCoordinates } from './coordinates';
import { sameChrom } from './chromAliases';
import { panelTraits } from './panelExtensions';

export interface View { chrom: string; start: number; end: number }

/** Whether a split panel's view has left its split's locus (no overlap, or another chromosome). */
export function splitAway(subset: ReadSubset | undefined, view: View, panel?: PanelConfig): boolean {
  if (subset?.rule?.liftHap) return false;
  const locus = subset?.locus;
  if (!locus || panelTraits(panel).ownContig) return false;  // a panel on a contig of its own (an insert expanded)
  return !sameChrom(view.chrom, locus.chrom) || view.end <= locus.start || view.start >= locus.end;
}

/**
 * A split panel pinned to a contig of its own (an insert-expanded Carriers panel) whose split has gone elsewhere: the
 * view its split's other panels show (theirs, else the main view) has left the split's locus (audit bug 4 / SV-2).
 */
export function splitPinnedAway(subset: ReadSubset | undefined, panel: PanelConfig | undefined, panels: PanelConfig[], main: View): boolean {
  if (!subset?.locus || !panel || !panelTraits(panel).ownContig) return false;
  const peer = panels.find(p => p.id !== panel.id && p.readSubset?.groupId === subset.groupId && !panelTraits(p).ownContig);
  return splitAway(subset, peer?.viewportOverride ?? main, peer);
}

/** Away and showing every read here (not the split's). */
export function splitShowsAll(subset: ReadSubset | undefined, view: View, panel?: PanelConfig): boolean {
  return Boolean(subset?.showAllAway) && splitAway(subset, view, panel);
}

/** "INS 9.2 kb at chr2L:9,467,038" (a label that names its place), else "N5 at chr2L:9,400,000-9,500,000". */
export function splitLocusText(subset: ReadSubset): string {
  const l = subset.locus!;
  const label = l.label.replace(' @ ', ' at ');
  return / at [^ ]+:\d/.test(label) ? label : `${label ? `${label} at ` : ''}${formatCoordinates(l.chrom, l.start, l.end)}`;
}

/** "Show all reads here" (true) or back to the split's reads (false), for every panel of the split. */
export function setSplitShowAll(groupId: string, on: boolean): void {
  useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.readSubset?.groupId === groupId ? { ...p, readSubset: { ...p.readSubset, showAllAway: on || undefined } } : p)),
  }));
}

/** "Go back": the split's panels (the main view, or a panel's own view) to where the split was made. */
export function goToSplitLocus(panel: PanelConfig): void {
  const locus = panel.readSubset?.locus;
  if (!locus) return;
  const store = useBrowserStore.getState();
  // A panel on its own contig stays there: its split's other panels (their own views, or the main view) go back.
  const peer = panelTraits(panel).ownContig
    ? store.panels.find(p => p.id !== panel.id && p.readSubset?.groupId === panel.readSubset!.groupId && !panelTraits(p).ownContig)
    : panel;
  if (peer?.viewportOverride) {
    const groupId = panel.readSubset!.groupId;
    useBrowserStore.setState(s => ({
      panels: s.panels.map(p => (p.readSubset?.groupId === groupId && p.viewportOverride && !panelTraits(p).ownContig
        ? { ...p, viewportOverride: { chrom: locus.chrom, start: locus.start, end: locus.end } } : p)),
    }));
    return;
  }
  store.setViewport(locus.chrom, locus.start, locus.end);
}
