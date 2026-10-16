/** The alt-allele panel's types (an insertion's carriers on its alternate allele, insert expanded). */

/** An insertion's alternate allele: reference flank + insert consensus + reference flank (browser/services/alt_allele.py). */
export interface AltAlleleLayout {
  /** The reference chromosome and breakpoint (0-based: the first reference base after the insert). */
  chrom: string;
  ref: number;
  insert_len: number;
  flank_left: number;
  flank_right: number;
  /** The contig's name (`chr2L_9467038_INS9184`) and length. */
  name: string;
  length: number;
  /** The insert on the contig: [insert_start, insert_end). */
  insert_start: number;
  insert_end: number;
}

/** What an alt-allele dataset was built from, and how (GET /api/datasets: Dataset.alt_allele). */
export interface AltAlleleInfo {
  source_dataset_id: string | null;
  source_paths?: string[];
  definition: { chrom: string; ref: number | null; length: number | null; pos: number | null; flank: number;
    include_reference: boolean; max_carriers: number; include_duplicates: boolean };
  layout: AltAlleleLayout;
  meta?: {
    sv?: { t: 'I'; ref: number; len: number };
    consensus?: { method: 'daf' | 'majority'; length: number; fallback?: string };
    carriers?: { total: number; written: number; sampled: boolean; cigar: number; clip_start: number; clip_end: number; hard: number;
      /** Placed with under 80% of their insert bases inside the insert. */
      poorly_aligned?: number };
    reference_reads?: { total: number; written: number };
    /** Reads at the site that are not this insertion's carriers: another insert there, or not spanning the breakpoint. */
    excluded?: { other_insert?: number; not_informative?: number };
    seconds?: number;
  };
}

/** The insertion an alt-allele panel shows: an SV cluster of a BAM dataset (ref/len), or one found near pos. */
export interface AltAlleleCluster {
  datasetId: string;
  chrom: string;
  ref?: number;
  len?: number;
  pos?: number;
}

export interface AltAllelePanelState {
  cluster: AltAlleleCluster;
  layout: AltAlleleLayout;
  altDatasetId: string;
  genomeKey: string;
  /** Moves with the main view through the breakpoint (utils/altAlleleCoords.ts). */
  linked: boolean;
  /** The source dataset's own reference (PanelConfig.genome), when it is not the main genome: never linked to the main view then. */
  sourceGenome?: string;
  /** Reference reads too, the insert drawn as a deletion across them. */
  includeReference?: boolean;
  flank?: number;
  /** What the panel showed before (the toggle back); null for a panel opened on the alt allele. */
  restore: {
    datasetId: string | null;
    genome?: string;
    viewportOverride?: { chrom: string; start: number; end: number };
    stateKey?: string;
    ownLocus?: boolean;
    navOwn?: boolean;
    siteLocked?: boolean;
    linkGroup: string | null;
  } | null;
}
