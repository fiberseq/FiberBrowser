import { useBrowserStore } from '../stores/browserStore';
import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export interface CigarOp {
  op: string;  // M, I, D, N, S, H, =, X
  len: number;
}

export interface PerReadStats {
  qcfail?: boolean;
  chimera?: 'strand_swap';
  signal?: import('../utils/signalFilters').SignalEvidence;
  read_id: string;
  dataset_id: string;
  mapq: number | null;
  strand: string | null;
  read_length: number;
  aligned_span: number;
  nm: number | null;
  /** "not called": the footprint caller skipped this read (no call tags); footprint fields are then null. */
  call_status?: "called" | "not called";
  footprint_count: number | null;
  nucleosome_count: number | null;
  subnuc_count: number | null;
  avg_footprint_size: number | null;
  median_footprint_size: number | null;
  accessibility_pct: number | null;
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
  /** null when no read in scope has footprint calls (NA, not 0). */
  mean_accessibility_pct?: number | null;
  mean_footprint_count?: number | null;
  /** Reads without footprint calls, left out of the footprint and accessibility means. */
  n_not_called?: number;
  mean_footprint_size?: number | null;
  mean_read_length?: number;
  mean_mapq?: number | null;
  median_footprint_size?: number | null;
  hist_accessibility?: HistogramBin[] | null;
  hist_fp_size?: HistogramBin[];
  hist_fp_count?: HistogramBin[];
  hist_read_length?: HistogramBin[];
  hist_mapq?: HistogramBin[] | null;
  mean_methyl_pct?: number | null;
  hist_methyl_pct?: HistogramBin[];
  /** Reads in the regions Min footprints hid: without footprint calls, and with < min_footprints calls. */
  hide_uncalled?: boolean;
  n_hidden_uncalled?: number;
  min_footprints?: number;
  n_hidden_min_footprints?: number;
  /** The read track's read policy, as applied: reads in the regions hidden as QC-fail or duplicate. */
  include_qcfail?: boolean;
  n_hidden_qcfail?: number;
  include_duplicates?: boolean;
  n_hidden_duplicate?: number;
  /** Footprints below this quality (legacy nq) were dropped, as on the read track (0: off). */
  min_fp_quality?: number;
  /** Selected reads the quality filters left no intervals (the read track drops them too). */
  n_hidden_quality?: number;
  /** Each active colour-rule quality filter: calls it applies to in the selected reads and how many it removed. */
  quality_filters?: ReadStatsQualityFilter[];
}

export interface ReadStatsQualityFilter {
  layer: string;
  quality_name: string;
  min_value: number;
  /** "nq ≥ 100 (nuc)" */
  label: string;
  calls: number;
  removed: number;
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
      // The read track's read policy and footprint-quality gate (the colour-rule quality filters are the server's).
      include_qcfail: Boolean(useBrowserStore.getState().showQcFailReads),
      include_duplicates: Boolean(useBrowserStore.getState().showDuplicateReads),
      min_fp_quality: Math.max(0, useBrowserStore.getState().minFpQuality || 0),
      // Min footprints as the read track applies it (-1: "All reads, including uncalled"):
      // the summary says which reads it hid, by reason.
      hide_uncalled: useBrowserStore.getState().minFootprints !== -1,
      min_footprints: Math.max(0, useBrowserStore.getState().minFootprints || 0),
      read_ids_by_dataset: readIdsByDataset,
      sample_seed: sampleSeed ?? null,
      ...(options?.extraRegions?.length ? { extra_regions: options.extraRegions } : {}),
    }),
    signal: options?.signal,
  });
}
