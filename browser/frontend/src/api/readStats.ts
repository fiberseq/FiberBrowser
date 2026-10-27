import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export interface CigarOp {
  op: string;  // M, I, D, N, S, H, =, X
  len: number;
}

export interface PerReadStats {
  signal?: import('../utils/signalFilters').SignalEvidence;
  read_id: string;
  dataset_id: string;
  mapq: number | null;
  strand: string | null;
  read_length: number;
  aligned_span: number;
  nm: number | null;
  footprint_count: number;
  nucleosome_count: number;
  subnuc_count: number;
  avg_footprint_size: number;
  median_footprint_size: number;
  accessibility_pct: number;
  methyl_count: number | null;
  methyl_pct: number | null;
  // Single-read BAM details
  cigar_string: string | null;
  cigar_ops: CigarOp[] | null;
  ref_start: number | null;
  ref_end: number | null;
  /** A lifted read: its alignment bounds are on the sample's own assembly, on this contig (coordinates 'source'). */
  ref_contig?: string | null;
  coordinates?: 'source';
  lifted?: boolean;
  fp_intervals: [number, number, number][] | null;  // [start, end, size] read-relative
  methyl_pos: number[] | null;  // read-relative positions
  // Nucleosome molecule scalars (nucmol; null when missing or not scanned)
  nrl?: number | null;
  regularity?: number | null;
  gap_cv?: number | null;
  lambda_acc?: number | null;
  n_short?: number | null;
  n_mono?: number | null;
  n_multi?: number | null;
  n_cant_tell?: number | null;
  reg_fraction?: number | null;
  disordered_fraction?: number | null;
  undetermined_fraction?: number | null;
  n_missing?: number | null;
}

export interface HistogramBin {
  lo: number;
  hi: number;
  count: number;
  label: string;
}

export interface ReadStatsAggregate {
  n_reads: number;
  n_datasets: number;
  strand_counts: Record<string, number>;
  mean_accessibility_pct?: number;
  mean_footprint_count?: number;
  mean_footprint_size?: number;
  mean_read_length?: number;
  mean_mapq?: number | null;
  median_footprint_size?: number;
  hist_accessibility?: HistogramBin[];
  hist_fp_size?: HistogramBin[];
  hist_fp_count?: HistogramBin[];
  hist_read_length?: HistogramBin[];
  hist_mapq?: HistogramBin[] | null;
  mean_methyl_pct?: number | null;
  hist_methyl_pct?: HistogramBin[];
}

export interface ReadStatsResponse {
  per_read: PerReadStats[];
  aggregate: ReadStatsAggregate;
  is_bam: boolean;
  requested_count?: number;
  found_count?: number;
  missing_read_ids_by_dataset?: Record<string, string[]>;
  sample_seed?: string;
  /** The group was larger than the server's cap: only its first reads were used. */
  truncated?: boolean;
  requested_total?: number;
  max_reads?: number;
}

/** Reads selected in panels at another locus, looked up at that region. */
export interface ReadStatsRegion {
  chrom: string;
  start: number;
  end: number;
  read_ids_by_dataset: Record<string, string[]>;
}

export async function fetchReadStats(
  chrom: string,
  start: number,
  end: number,
  spanning: boolean,
  readIdsByDataset: Record<string, string[]>,
  sampleSeed?: string,
  options?: { signal?: AbortSignal; extraRegions?: ReadStatsRegion[]; genome?: string | null },
): Promise<ReadStatsResponse> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString(),
  });
  // Reads of a panel on another reference (services/panel_genomes.py): its topology and contig names.
  if (options?.genome) params.set('panel_genome', options.genome);
  return fetchJson(`${API_BASE}/reads/stats?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      read_ids_by_dataset: readIdsByDataset,
      sample_seed: sampleSeed ?? null,
      ...(options?.extraRegions?.length ? { extra_regions: options.extraRegions } : {}),
    }),
    signal: options?.signal,
  });
}
