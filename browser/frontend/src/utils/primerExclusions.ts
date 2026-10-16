import type { SavedPrimer } from '../types';

export type PrimerExcludeRegion = [number, number];

function clampPad(padBp: number): number {
  return Math.max(0, Math.floor(Number.isFinite(padBp) ? padBp : 0));
}

function appendPairRegions(regions: PrimerExcludeRegion[], primer: SavedPrimer, padBp: number) {
  const pad = clampPad(padBp);
  const { pair } = primer;
  if (Number.isFinite(pair.fwd_start) && Number.isFinite(pair.fwd_end)) {
    regions.push([Math.max(0, pair.fwd_start - pad), pair.fwd_end + pad]);
  }
  if (Number.isFinite(pair.rev_start) && Number.isFinite(pair.rev_end)) {
    regions.push([Math.max(0, pair.rev_start - pad), pair.rev_end + pad]);
  }
}

export function buildPrimerExcludeRegions(
  savedPrimers: SavedPrimer[],
  targetChrom: string,
  enabled: boolean,
  padBp: number,
): PrimerExcludeRegion[] {
  if (!enabled) return [];
  const regions: PrimerExcludeRegion[] = [];
  for (const primer of savedPrimers) {
    if (!sameChrom(primer.chrom, targetChrom)) continue;
    appendPairRegions(regions, primer, padBp);
  }
  return regions;
}

export function buildPrimerExcludeRegionsByChrom(
  savedPrimers: SavedPrimer[],
  enabled: boolean,
  padBp: number,
): Record<string, PrimerExcludeRegion[]> {
  if (!enabled) return {};
  const byChrom: Record<string, PrimerExcludeRegion[]> = {};
  for (const primer of savedPrimers) {
    if (!primer.chrom) continue;
    const regions = byChrom[primer.chrom] ?? (byChrom[primer.chrom] = []);
    appendPairRegions(regions, primer, padBp);
  }
  return byChrom;
}
import { sameChrom } from './chromAliases';
