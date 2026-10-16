import type { FootprintAnalysisResult } from '../api/footprints';
import type { PanelConfig } from '../types';
import { sameChrom } from './chromAliases';

export interface FootprintScope {
  chrom: string;
  start: number;
  end: number;
  /** Positions, in the selection, of the footprints analysed in this region. */
  indices: number[];
  genome?: string | null;
}

interface ScopedFootprint { chrom?: string | null; absStart: number; absEnd: number; datasetId?: string | null; stateKey?: string; genome?: string | null }

type ScopePanel = Pick<PanelConfig, 'contentType' | 'viewportOverride'> & Partial<Pick<PanelConfig, 'datasetId' | 'collapsed' | 'stateKey' | 'genome'>>;

/**
 * Selected footprints grouped by the region they were picked in, so each is
 * analysed against the reads where it was picked: the main view for a footprint
 * inside it shown by a panel of its dataset (as before), else that dataset's
 * panel showing it at its own locus (another chromosome, another locus on the
 * same one, "Each panel navigates", another assembly).
 */
export function footprintAnalysisScopes(
  footprints: ScopedFootprint[],
  main: { chrom: string; start: number; end: number },
  panels: ScopePanel[],
): FootprintScope[] {
  const scopes = new Map<string, FootprintScope>();
  const add = (chrom: string, start: number, end: number, index: number) => {
    const fp = footprints[index];
    const panel = panels.find(p => (p.stateKey ?? p.datasetId) === (fp.stateKey ?? fp.datasetId));
    const genome = fp.genome !== undefined ? fp.genome : panel?.genome;
    const key = `${genome ?? ""}|${fp.stateKey ?? ""}|${chrom}:${start}-${end}`;
    const scope = scopes.get(key) ?? { chrom, start, end, indices: [], ...(genome !== undefined ? { genome } : {}) };
    scope.indices.push(index);
    scopes.set(key, scope);
  };
  const datasetPanels = panels.filter(p => p.contentType === 'dataset' && !p.collapsed);
  const shows = (v: { chrom: string; start: number; end: number }, chrom: string, fp: ScopedFootprint) =>
    sameChrom(v.chrom, chrom) && v.start < fp.absEnd && v.end > fp.absStart;
  footprints.forEach((fp, index) => {
    const chrom = fp.chrom || main.chrom;
    // The panel it was picked in, when it is still there and shows it.
    const source = fp.stateKey ? datasetPanels.find(p => (p.stateKey ?? p.datasetId) === fp.stateKey) : undefined;
    if (source) {
      const v = source.viewportOverride ?? main;
      if (shows(v, chrom, fp)) {
        add(v.chrom, v.start, v.end, index);
        return;
      }
    }
    // The footprint's own dataset's panels (where it was picked), when it has any.
    const own = fp.datasetId ? datasetPanels.filter(p => p.datasetId === fp.datasetId) : [];
    const candidates = own.length ? own : datasetPanels;
    const atMain = shows(main, chrom, fp) && (own.length === 0 || own.some(p => !p.viewportOverride));
    if (atMain) {
      add(main.chrom, main.start, main.end, index);
      return;
    }
    // Else the panel showing it at a locus of its own.
    const panel = candidates.find(p => p.viewportOverride && shows(p.viewportOverride, chrom, fp))
      ?? datasetPanels.find(p => p.viewportOverride && shows(p.viewportOverride, chrom, fp));
    const v = panel?.viewportOverride;
    if (v) add(v.chrom, v.start, v.end, index);
    else if (shows(main, chrom, fp) || !fp.chrom) add(main.chrom, main.start, main.end, index);
    else add(fp.chrom, Math.max(0, fp.absStart - 5000), fp.absEnd + 5000, index);
  });
  return [...scopes.values()];
}

/** One region's results put back at their footprints' positions in the selection. */
export function mergeFootprintScopeResults(
  parts: Array<{ scope: FootprintScope; res: FootprintAnalysisResult }>,
): FootprintAnalysisResult | null {
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0].scope.indices.every((idx, i) => idx === i)) return parts[0].res;
  const merged: FootprintAnalysisResult = { ...parts[0].res, footprints: [], overlap_stats: {}, warnings: [] };
  for (const { scope, res } of parts) {
    scope.indices.forEach((idx, k) => { if (res.footprints?.[k]) merged.footprints[idx] = res.footprints[k]; });
    for (const [dsId, stats] of Object.entries(res.overlap_stats ?? {})) {
      const into = merged.overlap_stats[dsId] ?? { ...stats, per_footprint: [] };
      into.total_reads = Math.max(into.total_reads ?? 0, stats.total_reads ?? 0);
      scope.indices.forEach((idx, k) => { if (stats.per_footprint?.[k]) into.per_footprint[idx] = stats.per_footprint[k]; });
      merged.overlap_stats[dsId] = into;
    }
    for (const warning of res.warnings ?? []) if (!merged.warnings!.includes(warning)) merged.warnings!.push(warning);
  }
  return merged;
}
