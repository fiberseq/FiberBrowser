/** What a meta-locus read carries besides the ordinary compact-read fields (server: services/meta_locus_jobs). */
export interface MetaReadProvenance {
  dataset?: string;
  site?: number;
  site_name?: string;
  /** The site's real contig and window (the read's view coordinates are relative to it). */
  chrom?: string;
  window?: [number, number];
  anchor?: number;
  strand?: '+' | '-';
  /** The read overlaps other sites' windows too (each read-site pair is its own observation). */
  shared?: boolean;
  source_id?: string;
  identity?: { dataset: string; name: string; site: number };
  real?: { chrom?: string; reference_start?: number; reference_end?: number; aligned_blocks?: number[][]; alignment_orientation?: string };
  rank?: number;
  key?: string;
}
