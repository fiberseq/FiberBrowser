import { keepMatched } from './matchedRegions';
import { useBrowserStore } from '../stores/browserStore';
import { computeRuleOffset } from '../stores/peakRuleSlice';
import type { FirePeak, PeakMode, PeakRule } from '../types';
import { sameChrom } from './chromAliases';
import type { ParsedPeakBedEntry } from './peakBed';

export interface ImportPeakEntriesOptions {
  entries: ParsedPeakBedEntry[];
  chrom?: string;
  label?: string;
  lock?: boolean;
  select?: boolean;
  replaceExisting?: boolean;
}

export interface ImportPeakEntriesResult {
  imported: number;
  skipped: number;
  chrom: string;
  locked: boolean;
}

function importedRuleName(entries: ParsedPeakBedEntry[], fallback: string): string {
  const named = entries.find(e => e.ruleName)?.ruleName;
  return named ? `${named} imported` : fallback;
}

function groupPeakEntries(entries: ParsedPeakBedEntry[]): Map<string, ParsedPeakBedEntry[]> {
  const grouped = new Map<string, ParsedPeakBedEntry[]>();
  for (const entry of entries) {
    const key = entry.ruleId || '__generic_bed__';
    grouped.set(key, [...(grouped.get(key) || []), entry]);
  }
  return grouped;
}

export function importPeakEntriesToBrowser({
  entries,
  chrom,
  label,
  lock = true,
  select = true,
  replaceExisting = false,
}: ImportPeakEntriesOptions): ImportPeakEntriesResult {
  const current = useBrowserStore.getState();
  const targetChrom = chrom || current.chrom;
  // BED files often name contigs differently (1 vs chr1): matched as aliases,
  // and stored under the browser's own name.
  const matchingEntries = entries.filter(entry => sameChrom(entry.chrom, targetChrom));

  if (matchingEntries.length === 0) {
    return {
      imported: 0,
      skipped: entries.length,
      chrom: targetChrom,
      locked: current.peaksLocked,
    };
  }

  const grouped = groupPeakEntries(matchingEntries);
  const importedRules: PeakRule[] = [];
  const importedPeaksByRule: Record<string, FirePeak[]> = {};
  const importedSelected = new Set<number>();
  const importedModes: Record<number, PeakMode> = {};
  const importSalt = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const baseRuleCount = replaceExisting
    ? current.peakRules.filter(rule => !rule.id.startsWith('imported-')).length
    : current.peakRules.length;
  let groupIndex = 0;

  for (const [groupKey, groupEntries] of grouped.entries()) {
    const color = groupEntries.find(entry => entry.color)?.color || '#f59e0b';
    const ruleId = `imported-${importSalt}-${groupIndex}`;
    const fallbackName = label || (groupKey === '__generic_bed__' ? 'Imported peaks' : `${groupKey} imported`);
    const rule: PeakRule = {
      id: ruleId,
      name: importedRuleName(groupEntries, fallbackName),
      source: 'custom',
      enabled: true,
      color,
      opacity: 0.65,
      useGradient: false,
      smoothWidth: 100,
      thresholds: [0.50, 0.30, 0.15, 0.08],
      minPeakWidth: 1,
      minReads: 1,
    };
    const offset = computeRuleOffset(baseRuleCount + groupIndex);
    const peaks = groupEntries.map((entry, localIndex): FirePeak => {
      const peakIndex = offset + localIndex;
      if (select && (entry.selected ?? true)) importedSelected.add(peakIndex);
      const mode = entry.mode || 'accessibility';
      if (mode !== 'accessibility') importedModes[peakIndex] = mode;
      return {
        start: entry.start,
        end: entry.end,
        index: peakIndex,
        layer: entry.layer ?? 0,
        score: entry.score,
        threshold: entry.threshold,
        isCustom: true,
        chrom: targetChrom,
        sourceLabel: entry.name,
        sourceColor: color,
        ruleId,
      };
    });
    importedRules.push(rule);
    importedPeaksByRule[ruleId] = peaks;
    groupIndex += 1;
  }

  useBrowserStore.setState(state => keepMatched(state, {
    peakRules: [
      ...(replaceExisting ? state.peakRules.filter(rule => !rule.id.startsWith('imported-')) : state.peakRules),
      ...importedRules,
    ],
    peaksByRule: replaceExisting
      ? importedPeaksByRule
      : { ...state.peaksByRule, ...importedPeaksByRule },
    selectedPeaks: importedSelected,
    peakModes: importedModes,
    peaksLocked: lock,
    peakSignalCache: replaceExisting ? {} : state.peakSignalCache,
    clusterAssignments: {},
    filteredReadIds: {},
    clusterFocus: {},
  }));

  return {
    imported: matchingEntries.length,
    skipped: entries.length - matchingEntries.length,
    chrom: targetChrom,
    locked: lock,
  };
}
