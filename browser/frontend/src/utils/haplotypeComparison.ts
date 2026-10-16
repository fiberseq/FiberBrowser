import type { PanelConfig, PeakMode } from '../types';
import type { MatchedClusterResponse } from '../api/clustering';
import { sameChrom } from './chromAliases';

/**
 * The two views of an open haplotype comparison (View 1 on chrom1, View 2 on
 * chrom2) and what the comparison-clustering controls send and show for them.
 */

export interface ComparisonViewPanel {
  panelId: string;
  datasetId: string;
  /** The panel's own state key: its clusters and filters live under it. */
  stateKey: string;
  strand?: 'CT' | 'GA';
}

export interface ComparisonView {
  /** 'view1' | 'view2' */
  id: string;
  side: 1 | 2;
  label: string;
  chrom: string;
  start: number;
  end: number;
  panels: ComparisonViewPanel[];
}

type ComparisonPanel = Pick<PanelConfig, 'id' | 'contentType' | 'datasetId' | 'stateKey' | 'collapsed'
  | 'viewportOverride' | 'haplotypeGroup' | 'haplotypeSide' | 'layoutColumn' | 'strand'>;

/** A comparison panel's view: its haplotypeSide, else (older sessions) its column. */
function panelSide(panel: ComparisonPanel): 1 | 2 {
  if (panel.haplotypeSide === 1 || panel.haplotypeSide === 2) return panel.haplotypeSide;
  return (panel.layoutColumn ?? 0) >= 1 ? 2 : 1;
}

/** The two views of the open haplotype comparison, or [] when there isn't one with datasets on both sides. */
export function comparisonViews(panels: ComparisonPanel[]): ComparisonView[] {
  const bySide = new Map<1 | 2, ComparisonView>();
  for (const panel of panels) {
    const viewport = panel.viewportOverride;
    if (!panel.haplotypeGroup || panel.contentType !== 'dataset' || !panel.datasetId || !viewport) continue;
    const side = panelSide(panel);
    const view = bySide.get(side) ?? {
      id: `view${side}`, side, label: `View ${side}`,
      chrom: viewport.chrom, start: viewport.start, end: viewport.end, panels: [],
    };
    // Stacked panels of one view share its locus; the first one defines it.
    view.panels.push({
      panelId: panel.id,
      datasetId: panel.datasetId,
      stateKey: panel.stateKey ?? panel.datasetId,
      ...(panel.strand ? { strand: panel.strand } : {}),
    });
    bySide.set(side, view);
  }
  const views = [bySide.get(1), bySide.get(2)].filter((view): view is ComparisonView => Boolean(view));
  return views.length === 2 ? views : [];
}

export interface ComparisonPeak { start: number; end: number; chrom?: string; mode?: PeakMode | string }
export interface ViewFeature { start: number; end: number; mode: PeakMode | string }

/**
 * A view's features: the selected peaks inside its window, left to right. A
 * peak without a chromosome was selected in the main view (mainChrom).
 */
export function viewFeatures(view: Pick<ComparisonView, 'chrom' | 'start' | 'end'>, peaks: ComparisonPeak[], mainChrom: string): ViewFeature[] {
  return peaks
    .filter(peak => sameChrom(peak.chrom ?? mainChrom, view.chrom) && peak.start < view.end && peak.end > view.start)
    .map(peak => ({ start: Math.max(peak.start, view.start), end: Math.min(peak.end, view.end), mode: peak.mode ?? 'accessibility' }))
    .filter(peak => peak.end > peak.start && peak.mode !== 'off')
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Feature i of View 1 is matched with feature i of View 2 (or the i-th from the right when View 2 is reversed). */
export function matchedFeaturePairs(features1: ViewFeature[], features2: ViewFeature[], reverse2: boolean): Array<[ViewFeature, ViewFeature]> {
  const ordered2 = reverse2 ? [...features2].reverse() : features2;
  return features1.slice(0, ordered2.length).map((feature, index) => [feature, ordered2[index]]);
}

export interface ComparisonSummaryRow {
  label: number;
  /** C0, C1, ... or the open (O) / closed (C) pattern for combinatorial states. */
  name: string;
  counts: [number, number];
  fractions: [number, number];
  /** View 2 minus View 1, in percentage points; null when the views' states are not shared. */
  shiftPp: number | null;
}

/** Each state's share of the reads in each view, and how it changed from View 1 to View 2. */
export function summarizeComparison(response: Pick<MatchedClusterResponse, 'results' | 'label_space' | 'cluster_patterns'>, views: ComparisonView[]): ComparisonSummaryRow[] {
  const counts = new Map<number, [number, number]>();
  const totals: [number, number] = [0, 0];
  for (const result of Object.values(response.results)) {
    const sideIndex = views.findIndex(view => view.id === result.view_id);
    if (sideIndex < 0) continue;
    for (const label of Object.values(result.assignments)) {
      const row = counts.get(label) ?? [0, 0];
      row[sideIndex] += 1;
      counts.set(label, row);
      totals[sideIndex] += 1;
    }
  }
  const shared = response.label_space === 'shared';
  const patterns = response.cluster_patterns ?? null;
  return [...counts.entries()].sort(([a], [b]) => a - b).map(([label, [n1, n2]]) => {
    const f1 = totals[0] ? n1 / totals[0] : 0;
    const f2 = totals[1] ? n2 / totals[1] : 0;
    const pattern = patterns?.[label];
    return {
      label,
      name: pattern ? pattern.map(bit => (bit ? 'O' : 'C')).join('') : `C${label}`,
      counts: [n1, n2],
      fractions: [f1, f2],
      shiftPp: shared ? (f2 - f1) * 100 : null,
    };
  });
}

/** Above this normalized mutual information the states may separate samples or views for technical reasons. */
export const TECHNICAL_SEPARATION_NMI = 0.3;
