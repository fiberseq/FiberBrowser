import type { ReadStatsRegion } from '../../../api/readStats';
import type { Locus } from '../../../utils/panelNavigation';

/**
 * Where Read Stats looked reads up (fb-n2-scope, audit M2): the main view's
 * reads go in the request itself, each panel at another locus (its own view,
 * another assembly's) adds a region. A read is on the chromosome of the
 * locus it was requested at, not the main one (stale in Per panel mode).
 */
export interface ReadStatsLoci {
  main: Locus;
  readIdsByDataset: Record<string, string[]>;
  extraRegions: ReadStatsRegion[];
}

/** The chromosome a read of the result was requested on. */
export function readStatsChromOf(read: { dataset_id: string; read_id: string }, loci: ReadStatsLoci): string {
  if (loci.readIdsByDataset[read.dataset_id]?.includes(read.read_id)) return loci.main.chrom;
  const region = loci.extraRegions.find(r => r.read_ids_by_dataset[read.dataset_id]?.includes(read.read_id));
  return region?.chrom ?? loci.main.chrom;
}

/** The loci the request covers: the main view (when it has reads), then each region. */
export function readStatsRequestLoci(loci: ReadStatsLoci): Locus[] {
  const out: Locus[] = [];
  if (Object.values(loci.readIdsByDataset).some(ids => ids.length > 0)) out.push(loci.main);
  for (const r of loci.extraRegions) out.push({ chrom: r.chrom, start: r.start, end: r.end });
  return out.length ? out : [loci.main];
}
