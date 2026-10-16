import { sameChrom } from '../../../utils/chromAliases';
import {
  activePanelView,
  panelView,
  viewLocusLabel,
  visibleDatasetPanels,
  type PanelScopeState,
  type PanelView,
} from '../../../utils/panelScope';
import { mainGenomeKey } from '../../../utils/regionNavigation';
import { clusterOperationRounds, roundStillCurrent, type ClusterOperationRound } from './clusterOperationRounds';
import type { FirePeak, PeakMode } from '../../../types';
import type { ClusterWindowPeaks } from '../../../types/clustering';
import { getClusterColor } from '../../tracks/read-track/constants';
import type { ClusterSummary } from './OverviewTabContent';

/**
 * The view the Clusters charts plot (fb-n3-clusters, audit H2).
 *
 * V-plots, the projection, enrichment, dissolve and merge read one region's
 * reads. They used the main locus, which goes stale in "Each panel navigates"
 * (and never is a panel on another assembly), so the clustered panel itself
 * was "left out" and the charts were empty. They now plot a panel's own view:
 * the panel the user is working in when it is clustered (panelScope's active
 * panel), else the first clustered panel; the clustered panels showing another
 * view (another locus or reference) are left out, with a note.
 */
export interface ClusterChartScope {
  /** The region (and reference: `genome`, null for the main genome) the charts read. */
  view: PanelView;
  /** The clustered state keys whose panel shows it, in the given order. */
  keys: string[];
  /** Clustered state keys left out (their panels show another view). */
  leftOut: number;
}

const viewId = (v: Pick<PanelView, 'genomeKey' | 'chrom' | 'start' | 'end'>) => `${v.genomeKey}|${v.chrom}:${v.start}-${v.end}`;

export function clusterChartScope(s: PanelScopeState, clusteredKeys: string[]): ClusterChartScope {
  const visible = new Set(visibleDatasetPanels(s).map(p => p.id));
  const main: PanelView = {
    chrom: s.chrom, start: s.start, end: s.end, panelId: null, genome: null,
    genomeKey: mainGenomeKey(s), panelIds: [], followsMain: true,
  };
  // Each clustered key's views: its panels' (on screen first); a key without a panel is the main view's.
  const viewsOf = new Map(clusteredKeys.map(key => {
    const panels = s.panels.filter(p => p.contentType === 'dataset' && !!p.datasetId && (p.stateKey ?? p.datasetId) === key);
    panels.sort((a, b) => Number(visible.has(b.id)) - Number(visible.has(a.id)));
    return [key, panels.length ? panels.map(p => panelView(s, p)) : [main]] as const;
  }));
  const active = activePanelView(s);
  const shows = (key: string, id: string) => (viewsOf.get(key) ?? []).some(v => viewId(v) === id);
  const firstKey = clusteredKeys[0];
  const view = clusteredKeys.some(key => shows(key, viewId(active)))
    ? active
    : (firstKey ? viewsOf.get(firstKey)![0] : active);
  const id = viewId(view);
  const keys = clusteredKeys.filter(key => shows(key, id));
  return { view, keys, leftOut: clusteredKeys.length - keys.length };
}

/** "1 panel at another locus or on another reference is left out: these plots use chr19:…'s reads." */
export function clusterChartScopeNote(scope: ClusterChartScope, referenceName: (key: string) => string): string | null {
  if (scope.leftOut === 0) return null;
  const n = scope.leftOut;
  const where = `${scope.view.genome ? `${referenceName(scope.view.genome)} ` : ''}${viewLocusLabel(scope.view)}`;
  return `${n} clustered panel${n !== 1 ? 's' : ''} at another locus or on another reference ${n !== 1 ? 'are' : 'is'} left out: `
    + `these plots use the reads at ${where}. Select a panel to plot its clusters.`;
}

/**
 * The clustering's peaks in the plotted view: those on its reference and
 * chromosome (a later run on another panel's reference doesn't lend its peaks).
 * A peak without a recorded reference is matched by its chromosome.
 */
export function clusterChartPeaks<P extends { start: number; end: number; chrom?: string | null; genome?: string | null }>(
  peaks: P[], view: Pick<PanelView, 'chrom' | 'genome'>, mainChrom: string,
): P[] {
  return peaks.filter(p => (p.genome == null || p.genome === (view.genome ?? null))
    && (p.genome != null || !view.genome || p.chrom != null)
    && sameChrom(p.chrom ?? mainChrom, view.chrom));
}

/**
 * Where a request's view is now, for roundStillCurrent: the same panel's
 * current locus (the main locus for a view without a panel). A panel gone or
 * on another reference since gives no locus, so the results are dropped.
 */
export function currentChartView<S extends PanelScopeState & { clusterAssignments: Record<string, Record<string, number> | undefined> }>(
  s: S, sent: Pick<PanelView, 'panelId' | 'genomeKey'>,
): { chrom: string; start: number; end: number; clusterAssignments: S['clusterAssignments'] } {
  const panel = sent.panelId ? s.panels.find(p => p.id === sent.panelId) : undefined;
  if (sent.panelId && !panel) return { chrom: '', start: -1, end: -1, clusterAssignments: s.clusterAssignments };
  const now = panel ? panelView(s, panel) : { chrom: s.chrom, start: s.start, end: s.end, genomeKey: mainGenomeKey(s) };
  if (now.genomeKey !== sent.genomeKey) return { chrom: '', start: -1, end: -1, clusterAssignments: s.clusterAssignments };
  return { chrom: now.chrom, start: now.start, end: now.end, clusterAssignments: s.clusterAssignments };
}

/**
 * Whether a dissolve/merge round may still be applied: every panel it covered
 * still shows the view it was sent for (not only the plotted one), and their
 * assignments are the ones sent (roundStillCurrent).
 */
export function chartRoundStillCurrent<S extends PanelScopeState & { clusterAssignments: Record<string, Record<string, number> | undefined> }>(
  round: ClusterOperationRound, sent: PanelView, s: S,
): boolean {
  if (!roundStillCurrent(round, sent, currentChartView(s, sent))) return false;
  const id = viewId(sent);
  return Object.values(round.keyByDataset).every(key => {
    const panels = s.panels.filter(p => p.contentType === 'dataset' && !!p.datasetId && (p.stateKey ?? p.datasetId) === key);
    if (panels.length === 0) return sent.followsMain && viewId({ genomeKey: mainGenomeKey(s), chrom: s.chrom, start: s.start, end: s.end }) === id;
    return panels.some(p => viewId(panelView(s, p)) === id);
  });
}

const regionsSignature = (regions: unknown) => JSON.stringify(Array.isArray(regions)
  ? regions.map((r: { start: number; end: number; mode?: string; chrom?: string | null; genome?: string | null }) =>
    [r.start, r.end, r.mode ?? 'accessibility', r.chrom ?? null, r.genome ?? null])
  : null);

/**
 * The peaks the plotted panels were clustered on: their own matched peaks when
 * the run went over panels at several loci (and that run's peaks are still the
 * clustering's), else the clustering's peaks on the view's reference and chromosome.
 */
export function clusterChartRunPeaks<P extends { start: number; end: number; mode?: string; chrom?: string | null; genome?: string | null }>(
  regions: P[],
  windowPeaks: {
    regions: unknown;
    byKey: Record<string, Array<{ start: number; end: number; mode?: string }>>;
    views?: Record<string, { chrom: string; genome: string | null }>;
  } | null,
  keys: string[], view: Pick<PanelView, 'chrom' | 'genome' | 'start' | 'end'>, mainChrom: string,
): Array<{ start: number; end: number; mode?: string }> {
  // The same peaks as that run (a branch, snapshot, saved clustering or
  // reopened session restores a copy of them), clustered on the plotted view's
  // reference and chromosome, and the panel's own peaks are in the plotted view.
  if (windowPeaks && regionsSignature(windowPeaks.regions) === regionsSignature(regions)) {
    const key = keys.find(k => windowPeaks.byKey[k]
      && (!windowPeaks.views?.[k] || ((windowPeaks.views[k].genome ?? null) === (view.genome ?? null)
        && sameChrom(windowPeaks.views[k].chrom, view.chrom))));
    const own = key ? windowPeaks.byKey[key] : undefined;
    if (own?.some(p => p.start < view.end && p.end > view.start)) return own;
  }
  return clusterChartPeaks(regions, view, mainChrom);
}

/** What the merge inputs read from the store (BrowserState has it all). */
export type ClusterMergeState = PanelScopeState & {
  clusterAssignments: Record<string, Record<string, number> | undefined>;
  clusterPeakRegions: Array<{ start: number; end: number; mode?: string; chrom?: string | null; genome?: string | null }>;
  clusterWindowPeaks: ClusterWindowPeaks | null;
  selectedPeaks: Set<number>;
  peakModes: Record<number, string | undefined>;
  getAllPeaks: () => FirePeak[];
};

/**
 * The peaks Merge similar clusters, Delete and the read map compare the
 * clusters on, for one view: the clustering's (its run's peaks in that view,
 * see clusterChartRunPeaks), else the selected peaks in that view; none: the
 * server's stored peaks. The map's preview and every merge use this list, so
 * the preview is what Merge does.
 */
export function clusterMergePeaks(
  s: Pick<ClusterMergeState, 'chrom' | 'clusterPeakRegions' | 'clusterWindowPeaks' | 'selectedPeaks' | 'peakModes' | 'getAllPeaks'>,
  keys: string[],
  view: Pick<PanelView, 'chrom' | 'genome' | 'start' | 'end'>,
): Array<{ start: number; end: number; mode: PeakMode }> {
  if (s.clusterPeakRegions.length > 0) {
    return clusterChartRunPeaks(s.clusterPeakRegions, s.clusterWindowPeaks, keys, view, s.chrom)
      .map(p => ({ start: p.start, end: p.end, mode: (p.mode || 'accessibility') as PeakMode }));
  }
  const allPeaks = s.getAllPeaks();
  const selected = Array.from(s.selectedPeaks)
    .map(idx => allPeaks.find(p => p.index === idx))
    .filter((p): p is FirePeak => p !== undefined);
  return clusterChartPeaks(selected, view, s.chrom)
    .map(p => ({ start: p.start, end: p.end, mode: (s.peakModes[p.index] || 'accessibility') as PeakMode }));
}

/**
 * Everything a merge (Merge similar clusters, Delete) sends, whichever button
 * or Copilot action runs it (fb-n6-integ): the clustered panels showing the
 * charts' view (clusterChartScope; the others are left out and counted), that
 * view's locus and reference (`view.genome` is the request's panel_genome),
 * its peaks (clusterMergePeaks), and the rounds to send (one panel per dataset
 * per request). Apply a round's answer only while chartRoundStillCurrent.
 */
export interface ClusterMergeInputs extends ClusterChartScope {
  peakRegions: Array<{ start: number; end: number; mode: PeakMode }>;
  rounds: ClusterOperationRound[];
}

export function clusterMergeInputs(
  s: ClusterMergeState,
  clusteredKeys: string[],
  stateKeyToDs: Record<string, string>,
): ClusterMergeInputs {
  const scope = clusterChartScope(s, clusteredKeys);
  return {
    ...scope,
    peakRegions: clusterMergePeaks(s, scope.keys, scope.view),
    rounds: clusterOperationRounds(scope.keys, stateKeyToDs, s.clusterAssignments),
  };
}

/**
 * The clusters of some panels (fb-n6-integ): each cluster with its read count
 * per panel (in `keys` order), in the first panel's cluster order; the focus
 * and the picked clusters of those panels. The read map, the V-plots and
 * Differences each read their own panels' (a panel they leave out, at another
 * locus or on another reference, is neither shown nor changed by them).
 */
export interface ScopedClusters {
  clusters: ClusterSummary[];
  /** The focused clusters (the first panel's; null: all shown). */
  focus: Set<number> | null;
  /** `clusters` within the focus. */
  visible: ClusterSummary[];
  /** The clusters picked in any of the panels. */
  selected: Set<number>;
}

export function scopedClusters(
  keys: string[],
  s: {
    clusterAssignments: Record<string, Record<string, number> | undefined>;
    clusterOrder: Record<string, number[] | undefined>;
    clusterFocus: Record<string, Set<number> | null | undefined>;
    selectedClusters: Record<string, Set<number> | undefined>;
  },
): ScopedClusters {
  const countsPerKey = keys.map(key => {
    const counts = new Map<number, number>();
    for (const cluster of Object.values(s.clusterAssignments[key] ?? {})) counts.set(cluster, (counts.get(cluster) || 0) + 1);
    return counts;
  });
  const all = new Set<number>();
  for (const counts of countsPerKey) for (const cluster of counts.keys()) all.add(cluster);
  const preferred = keys[0] ? s.clusterOrder[keys[0]] ?? [] : [];
  const order = [
    ...preferred.filter((cluster, index) => all.has(cluster) && preferred.indexOf(cluster) === index),
    ...[...all].filter(cluster => !preferred.includes(cluster)).sort((a, b) => a - b),
  ];
  const clusters = order.map(cluster => {
    const counts = countsPerKey.map(c => c.get(cluster) || 0);
    return { cluster, color: getClusterColor(cluster), counts, totalCount: counts.reduce((a, b) => a + b, 0) };
  });
  const focus = keys[0] ? s.clusterFocus[keys[0]] ?? null : null;
  const selected = new Set<number>();
  for (const key of keys) for (const cluster of s.selectedClusters[key] ?? []) selected.add(cluster);
  return {
    clusters,
    focus,
    visible: focus ? clusters.filter(cd => focus.has(cd.cluster)) : clusters,
    selected,
  };
}
