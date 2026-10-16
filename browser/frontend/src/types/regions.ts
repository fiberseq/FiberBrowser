/**
 * The region catalog (Regions panel): named regions in categories, per
 * reference. Stored per reference in ~/.fiberhmm/regions (services/region_catalog.py)
 * and in sessions. One list for the whole app: saved views, imported BED files,
 * a dataset's amplicons, and what used to be bookmarks and the Regions panel's
 * saved views.
 */

/** Where an entry came from. */
export type RegionSource = 'auto' | 'top' | 'bed' | 'saved' | 'bookmark' | 'navigator';

export interface RegionCategory {
  id: string;
  name: string;
  /** A subheading of this category (one level). */
  parent?: string;
  collapsed?: boolean;
  /** 'auto': a dataset's detected amplicons (shown while that dataset is open); 'top': found on request. */
  source?: 'auto' | 'top' | 'bed' | 'saved' | 'bookmarks' | 'user';
  /** The dataset's content fingerprint (region_detect.dataset_fingerprint) for 'auto'/'top'. */
  fingerprint?: string;
  /** The dataset's name when the category was made. */
  dataset?: string;
  note?: string;
  created?: string;
}

export interface RegionEntry {
  id: string;
  chrom: string;
  /** 0-based, end exclusive (BED). */
  start: number;
  end: number;
  label: string;
  /** The detected (nearest-gene) label; Reset puts it back. */
  autoLabel?: string;
  category: string;
  source: RegionSource;
  reads?: number;
  score?: number;
  strand?: string;
  gene?: string;
  /** Where the label comes from ("Intergenic: X 1.2 kb away"). */
  detail?: string;
  note?: string;
  created?: string;
}

export interface RegionCatalog {
  version: 1;
  /** The reference: a registry id (dm6), a FASTA file name, or 'none'. */
  genome: string;
  categories: RegionCategory[];
  /** In display order within each category. */
  entries: RegionEntry[];
  /** Writes of the saved file so far (services/region_catalog.py); a save from an older one is refused. */
  revision?: number;
}

/** A region shaded in every panel on its reference (Highlight). */
export interface Highlight {
  id: string;
  genome: string;
  chrom: string;
  start: number;
  end: number;
  color: string;
  label?: string;
}
