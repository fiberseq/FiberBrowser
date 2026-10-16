import type { Dataset, FootprintGroup } from '../types';
import { fetchJson } from './sharedFetch';
import { useBrowserStore } from '../stores/browserStore';

const API_BASE = '/api';

export interface SelectedFootprintAPI {
  absStart: number;
  absEnd: number;
  size: number;
  readId: string;
  datasetId: string;
}

export interface MotifHit {
  motif_id: string;
  motif_name: string;
  start: number;
  end: number;
  strand: string;
  rel_score: number;
  matched_seq: string;
  /** p-value of the hit for its matrix (p-value scoring); absent in relative-score mode. */
  p?: number;
  /** Similar matrices on the same bases, collapsed into this hit (p-value scoring). */
  family?: string[];
}

export interface FootprintInfo {
  absStart: number;
  absEnd: number;
  size: number;
  sequence: string | null;
  seq_start: number;
  motif_hits: MotifHit[];
}

export interface SizeHistogram {
  bins: number[];
  counts: number[];
  bin_width: number;
}

export interface OverlapEntry {
  overlap_count: number;
  overlap_fraction: number;
  size_mean: number;
  size_median: number;
  size_histogram: SizeHistogram;
  overlap_sizes?: number[];
}

export interface CoOccupancyPair {
  group_i: number;
  group_j: number;
  table: [[number, number], [number, number]];
  /** null when undefined (0/0), e.g. two definitions that never co-occur. */
  odds_ratio: number | null;
  p_value: number | null;
  q_value?: number | null;
  n_both: number;
  n_i_only: number;
  n_j_only: number;
  n_neither: number;
  ids_both?: string[];
  ids_i_only?: string[];
  ids_j_only?: string[];
  ids_neither?: string[];
}

export interface PerGroupOccupancy {
  eligible_reads?: number;
  n_with: number;
  n_without: number;
  ids_with?: string[];
  ids_without?: string[];
  ambiguous_read_ids?: string[];
  /** Footprint classes: reads matched to the run that the class was not evaluated on (e.g. they end before it). */
  not_evaluated_reads?: number;
  /** Footprint classes: why the class can't be resolved (its run is gone, another chromosome); left out of pairs. */
  unavailable?: string;
}

export interface ProfileConfidenceBand {
  low: number[];
  high: number[];
  confidence_level: number;
  method: string;
  resamples: number;
  n_reads: number;
}

export interface FootprintAnalysisResult {
  success: boolean;
  footprints: FootprintInfo[];
  overlap_stats: Record<string, { total_reads: number; per_footprint: OverlapEntry[] }>;
  profiles: Record<string, {
    aggregate: number[];
    aggregate_ci?: ProfileConfidenceBand;
    window: number;
    by_layer?: Record<string, number[]>;
    by_layer_ci?: Record<string, ProfileConfidenceBand>;
  }>;
  vplot: Record<string, { matrix: number[][]; size_min: number; size_max: number; size_bin: number; pos_bin: number }>;
  motif_pwms: Record<string, { A: number[]; C: number[]; G: number[]; T: number[]; name: string }>;
  /** The species the automatic JASPAR scan used (inferred: taken from the loaded chromosome names; inherited: the
   *  genome an expanded insert was built from; declared: the user said so for this FASTA; fallback: no genome, the
   *  vertebrate taxon group's matrices, genome and taxid null). */
  jaspar_species?: { genome: string | null; taxid: number | null; name?: string | null; inferred: boolean;
    inherited?: boolean; declared?: boolean; fallback?: boolean; tax_group?: string } | null;
  /** The motif scoring used (shared scorer): mode, thresholds, background and the pinned names reported. */
  motif_scoring?: { mode: 'p' | 'relative'; p: number; relative: number; background: string | null; pinned: string[]; /** Default factors JASPAR CORE lacks. */ unavailable?: string[] };
  motif_sources?: Array<{
    id: string;
    name: string;
    source: string;
    track_index?: number;
    motif_type?: string;
    motif_source?: string;
  }>;
  co_occupancy?: Record<string, { pairs: CoOccupancyPair[]; per_group?: PerGroupOccupancy[]; total_reads: number; error?: string }>;
  sample_seed?: string | null;
  timings?: Record<string, number>;
  warnings?: string[] | null;
}

export async function analyzeFootprints(
  chrom: string,
  regionStart: number,
  regionEnd: number,
  spanning: boolean,
  footprints: SelectedFootprintAPI[],
  datasetIds: string[],
  options?: {
    panelGenome?: string | null;
    autoMotifs?: boolean;
    customMotifNames?: string[];
    motifTrackIndices?: number[];
    customPwms?: Array<{ name: string; counts: Record<'A' | 'C' | 'G' | 'T', number[]>; label?: string }>;
    motifThreshold?: number;
    /** Motif scoring; defaults: the shared settings (motifScoreMode, motifPValue). */
    motifMode?: 'p' | 'relative';
    motifP?: number;
    /** With no customMotifNames: report the species' default key factors. */
    pinnedDefaults?: boolean;
    flankBp?: number;
    profileWindow?: number;
    groups?: Array<{
      consensusStateId?: string | null;
      consensusJobId?: string | null;
      consensusStrand?: 'CT' | 'GA' | null;
      consensusTier?: string | null;
      sourceDatasetId?: string | null;
      sourceIndex: number;
      sizeMin: number;
      sizeMax: number | null;
      overlapFraction: number;
      referenceAbsStart?: number | null;
      referenceAbsEnd?: number | null;
      minFpCoverage?: number;
      minTargetCoverage?: number;
      familyId?: number | null;
      minFamilyConfidence?: number;
    }>;
    readIdsByDataset?: Record<string, string[]>;
    /** DAF-seq panels showing one strand: dataset id -> strand. */
    strandByDataset?: Record<string, 'CT' | 'GA'>;
    maxReads?: number;
    sampleSeed?: string;
    readAnalysis?: boolean;
    sequences?: boolean;
    motifs?: boolean;
    overlap?: boolean;
    overlapSizes?: boolean;
    profiles?: boolean;
    vplot?: boolean;
    coocc?: boolean;
    vplotSizeBin?: number;
    vplotPosBin?: number;
    vplotSizeMin?: number;
    vplotSizeMax?: number;
    vplotLog?: boolean;
    vplotSmooth?: number;
    layer?: string | null;
    layers?: string[] | null;
    signal?: AbortSignal;
  },
): Promise<FootprintAnalysisResult> {
  const params = new URLSearchParams({
    chrom,
    region_start: regionStart.toString(),
    region_end: regionEnd.toString(),
    spanning: spanning.toString(),
  });
  if (options?.panelGenome) params.set('panel_genome', options.panelGenome);
  return fetchJson(`${API_BASE}/footprint/analyze?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      footprints: footprints.map(fp => ({
        absStart: fp.absStart,
        absEnd: fp.absEnd,
        size: fp.size,
        readId: fp.readId,
        datasetId: fp.datasetId,
      })),
      dataset_ids: datasetIds,
      auto_motifs: options?.autoMotifs ?? true,
      custom_motif_names: options?.customMotifNames ?? null,
      motif_track_indices: options?.motifTrackIndices ?? null,
      custom_pwms: options?.customPwms ?? null,
      motif_threshold: options?.motifThreshold ?? 0.8,
      motif_mode: options?.motifMode ?? useBrowserStore.getState().motifScoreMode ?? 'p',
      motif_p: options?.motifP ?? useBrowserStore.getState().motifPValue ?? 1e-4,
      pinned_defaults: options?.customMotifNames == null && !!options?.pinnedDefaults,
      flank_bp: options?.flankBp ?? 20,
      profile_window: options?.profileWindow ?? 500,
      groups: options?.groups ?? null,
      read_ids_by_dataset: options?.readIdsByDataset ?? null,
      ...(options?.strandByDataset && Object.keys(options.strandByDataset).length ? { strand_by_dataset: options.strandByDataset } : {}),
      max_reads: options?.maxReads ?? null,
      sample_seed: options?.sampleSeed ?? null,
      include_read_analysis: options?.readAnalysis ?? true,
      include_sequences: options?.sequences ?? true,
      include_motifs: options?.motifs ?? true,
      include_overlap: options?.overlap ?? true,
      include_overlap_sizes: options?.overlapSizes ?? true,
      include_profiles: options?.profiles ?? true,
      include_vplot: options?.vplot ?? true,
      include_coocc: options?.coocc ?? true,
      ...(options?.layer && { layer: options.layer }),
      ...(options?.layers && options.layers.length > 0 && { layers: options.layers }),
      ...(options?.vplotSizeBin != null && { vplot_size_bin: options.vplotSizeBin }),
      ...(options?.vplotPosBin != null && { vplot_pos_bin: options.vplotPosBin }),
      ...(options?.vplotSizeMin != null && { vplot_size_min: options.vplotSizeMin }),
      ...(options?.vplotSizeMax != null && { vplot_size_max: options.vplotSizeMax }),
      ...(options?.vplotLog != null && { vplot_log: options.vplotLog }),
      ...(options?.vplotSmooth != null && { vplot_smooth: options.vplotSmooth }),
    }),
    signal: options?.signal,
  });
}

export interface DerivedLayerBundleResult {
  dataset_id: string;
  dataset_label: string;
  manifest_path: string;
  bed_path: string;
  autosql_path: string;
  chrom_sizes_path: string;
  bigbed_path: string | null;
  n_rows: number;
  n_intervals: number;
  classes: Array<Record<string, unknown>>;
  warnings?: string[];
}

export async function saveFootprintRules(body: {
  groups: FootprintGroup[];
  output_dir: string;
  bundle_name?: string | null;
  chrom?: string | null;
  start?: number | null;
  end?: number | null;
  spanning?: boolean | null;
  dataset_ids?: string[] | null;
  sample_seed?: string | null;
}): Promise<{
  success: boolean;
  path?: string;
  groups?: FootprintGroup[];
  n_rules?: number;
  schema?: string;
  error?: string | null;
}> {
  return fetchJson(`${API_BASE}/footprint/rules/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function loadFootprintRules(path: string): Promise<{
  success: boolean;
  path?: string;
  groups?: FootprintGroup[];
  n_rules?: number;
  schema?: string;
  name?: string | null;
  context?: Record<string, unknown>;
  error?: string | null;
}> {
  return fetchJson(`${API_BASE}/footprint/rules/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export async function exportDerivedLayers(
  chrom: string,
  regionStart: number,
  regionEnd: number,
  spanning: boolean,
  body: {
    dataset_ids: string[];
    groups: FootprintGroup[];
    output_dir: string;
    bundle_name?: string | null;
    include_disabled?: boolean;
    read_ids_by_dataset?: Record<string, string[]>;
    max_reads?: number | null;
    sample_seed?: string | null;
  },
): Promise<{
  success: boolean;
  bundles: DerivedLayerBundleResult[];
  datasets?: Dataset[];
  warnings?: string[] | null;
  error?: string | null;
}> {
  const params = new URLSearchParams({
    chrom,
    region_start: regionStart.toString(),
    region_end: regionEnd.toString(),
    spanning: spanning.toString(),
  });
  return fetchJson(`${API_BASE}/footprint/derived_layers/export?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function loadDerivedLayers(
  path: string,
  datasetIds?: string[],
): Promise<{
  success: boolean;
  bundle_path?: string;
  attached?: Array<{ dataset_id: string; layer_ids: string[] }>;
  datasets?: Dataset[];
  warnings?: string[] | null;
  error?: string | null;
}> {
  return fetchJson(`${API_BASE}/footprint/derived_layers/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      dataset_ids: datasetIds && datasetIds.length > 0 ? datasetIds : null,
    }),
  });
}
