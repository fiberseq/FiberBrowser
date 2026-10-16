import type { SelectedFootprint } from '../types';
import { sameChrom } from './chromAliases';

/**
 * Whether a drawn (or clicked) footprint is the selected one. Interval indexes
 * are positions in one response and change as the view pans, so a footprint is
 * identified by its read, dataset, chromosome and genomic bounds instead: two
 * footprints of a read in one layer never overlap, and a footprint clipped
 * differently at the window edge still overlaps its selected bounds.
 * (Layer equivalence is the caller's: primary and per-layer draws differ.)
 */
export function isSelectedFootprint(
  sf: Pick<SelectedFootprint, 'readId' | 'datasetId' | 'chrom' | 'absStart' | 'absEnd'>,
  fp: { readId: string; datasetId: string; chrom: string; absStart: number; absEnd: number },
): boolean {
  return sf.readId === fp.readId
    && sf.datasetId === fp.datasetId
    && (!sf.chrom || !fp.chrom || sameChrom(sf.chrom, fp.chrom))
    && sf.absStart < fp.absEnd
    && fp.absStart < sf.absEnd;
}
