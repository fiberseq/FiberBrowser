import { foldedInShownGraph } from '../stores/graphMembership';
import type { AnalysisRuleScope, FirePeak, Gene, PanelConfig, PeakMode } from '../types';
import { annotationRegionScopes, type AnnotationRegionScope } from '../components/controls/annotation-panel/annotationScopes';
import { resolveClusterRuleRegions } from './analysisRules';
import { sameChrom } from './chromAliases';

/** One filter request: a region, its rule windows and peaks, and the panels showing it. */
export interface FilterRegionGroup extends AnnotationRegionScope {
  /** The main view (the rule's scope as it resolves there). */
  main: boolean;
  windows: Array<[number, number]>;
  peakRegions: number[][];
  peaks: FirePeak[];
}

/**
 * Group the target panels by the region each shows (its own locus, else the
 * main view) and resolve the rule's scope in each region, so a panel at another
 * locus is filtered there, not by the main view's read IDs.
 *
 * Main-view peaks carry no chromosome; elsewhere only peaks tagged with the
 * group's chromosome (or untagged ones when it is the main chromosome) inside
 * its region count.
 */
export function filterRegionGroups(args: {
  stateKeys: string[];
  stateKeyToDs: Record<string, string>;
  panels: PanelConfig[];
  main: { chrom: string; start: number; end: number };
  rule: { scope?: AnalysisRuleScope };
  allPeaks: FirePeak[];
  selectedPeaks: Iterable<number>;
  peakModes: Record<number, PeakMode>;
  selectedGenes: Gene[];
}): FilterRegionGroup[] {
  const { main } = args;
  const grouped = new Map<string, FilterRegionGroup>();
  // Equal loci can still have different selected features (independent copies
  // and correspondence members). Only identical feature scopes share a request.
  for (const sk of args.stateKeys) {
    const [scope] = annotationRegionScopes([sk], args.stateKeyToDs, args.panels, main);
    const panel = args.panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === sk);
    const isMain = !scope.genome && scope.chrom === main.chrom && scope.start === main.start && scope.end === main.end;
    const peaks = args.allPeaks.filter(p => (p.genome ?? null) === (scope.genome ?? null)
      && sameChrom(p.chrom ?? main.chrom, scope.chrom)
      && (isMain || p.end > scope.start && p.start < scope.end)
      && (!p.memberPanelId || p.match?.correspondenceId || p.memberPanelId === panel?.id)
      && (!p.match?.correspondenceId || !p.match.panelId || p.match.panelId === panel?.id
        || (panel?.regionPanelGroup?.id === p.match.correspondenceId && panel.regionPanelGroup.regionLabel === p.match.label)));
    const windows = resolveClusterRuleRegions(args.rule, {
      allPeaks: peaks,
      selectedPeaks: [...args.selectedPeaks],
      peakModes: args.peakModes,
      mode: 'accessibility',
      chrom: scope.chrom,
      viewportStart: scope.start,
      viewportEnd: scope.end,
      selectedGenes: args.selectedGenes,
    }).map(region => [region.start, region.end] as [number, number]);
    const key = JSON.stringify([scope.genome, scope.chrom, scope.start, scope.end,
      peaks.map(p => [p.index, p.start, p.end]), windows]);
    const existing = grouped.get(key);
    if (existing) {
      for (const ds of scope.datasetIds) {
        if (!existing.datasetIds.includes(ds)) existing.datasetIds.push(ds);
        (existing.stateKeysByDataset[ds] ??= []).push(...scope.stateKeysByDataset[ds]);
      }
    } else {
      grouped.set(key, { ...scope, main: isMain, windows, peaks, peakRegions: peaks.map(p => [p.start, p.end]) });
    }
  }
  return [...grouped.values()];
}

/** Whether every panel of a group still shows the group's region (on its reference). */
export function groupStillShown(
  group: AnnotationRegionScope,
  panels: PanelConfig[],
  main: { chrom: string; start: number; end: number },
): boolean {
  for (const keys of Object.values(group.stateKeysByDataset)) {
    for (const sk of keys) {
      const panel = panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === sk);
      // (A member folded into a shown graph is at its host's view.)
      const region = (panel && foldedInShownGraph(panel, panels) || panel)?.viewportOverride ?? main;
      if (region.chrom !== group.chrom || region.start !== group.start || region.end !== group.end) return false;
      if ((panel?.genome || undefined) !== group.genome) return false;
    }
  }
  return true;
}
