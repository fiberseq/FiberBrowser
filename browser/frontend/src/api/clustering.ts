import type { ClusterFeatureRule, ClusterResponse, FilterMode, PeakMode } from '../types';
import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export async function clusterReads(
  chrom: string,
  start: number,
  end: number,
  peakIndices: number[],
  k: number,
  filterMode: FilterMode,
  spanning: boolean,
  datasetId: string
): Promise<ClusterResponse> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString(),
    dataset_id: datasetId
  });
  return fetchJson(`${API_BASE}/cluster?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peak_indices: peakIndices, k, filter_mode: filterMode }),
  });
}

export interface PeakRegionWithMode {
  start: number;
  end: number;
  mode?: PeakMode;  // 'accessibility' (default) or 'tf'
}

export async function clusterAllReads(
  chrom: string,
  start: number,
  end: number,
  peakRegions: Array<PeakRegionWithMode>,
  k: number,
  spanning: boolean,
  datasetIds: string[],
  method: string = 'kmeans',
  readIds?: Record<string, string[]>,
  maxReads?: number,
  subnucleosomalThreshold: number = 90,
  accessibilityThreshold: number = 0.5,
  extraChroms?: string[],
  sampleSeed?: string,
  clusterFeatureRules?: ClusterFeatureRule[],
  viewports?: Array<{dataset_id:string;result_key:string;chrom:string;start:number;end:number;read_ids?:string[];strand?:'CT'|'GA';peak_regions?:Array<{start:number;end:number;mode?:string}>}>,
  /**
   * method 'graph': community resolution (higher gives more, smaller clusters).
   * panelGenome: the run's reference when it is a panel's own (another
   * assembly): reads, chromosomes and gene-conditioned rules come from it.
   */
  options?: { resolution?: number; panelGenome?: string | null; preparationSampleCount?: number | null; signal?: AbortSignal },
): Promise<{
  results: Record<string, ClusterResponse>;
  cluster_patterns?: Record<number, number[]>;
  cluster_centroids?: Record<number, number[]>;
  cluster_peak_widths?: number[];
  peak_regions?: Array<{ start: number; end: number; mode?: string }>;
  sample_seed?: string | null;
  cluster_random_state?: number;
  timings?: Record<string, number>;
}> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString()
  });
  if (options?.panelGenome) params.set('panel_genome', options.panelGenome);
  const body: Record<string, unknown> = {
    peak_regions: peakRegions,
    k,
    method,
    dataset_ids: datasetIds,
    subnucleosomal_threshold: subnucleosomalThreshold,
    accessibility_threshold: accessibilityThreshold
  };
  if (viewports?.length) body.viewports = viewports;
  if (options?.preparationSampleCount) body.preparation_sample_count = options.preparationSampleCount;
  if (method === 'graph' && options?.resolution != null) body.resolution = options.resolution;
  if (readIds) {
    body.read_ids = readIds;
  }
  if (maxReads) {
    body.max_reads = maxReads;
  }
  if (sampleSeed) {
    body.sample_seed = sampleSeed;
  }
  if (extraChroms && extraChroms.length > 0) {
    body.extra_chroms = extraChroms;
  }
  if (clusterFeatureRules && clusterFeatureRules.length > 0) {
    body.cluster_feature_rules = clusterFeatureRules;
  }
  return fetchJson(`${API_BASE}/cluster_all?${params}`, {
    signal: options?.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** One dataset panel of a comparison view; its result comes back under result_key. */
export interface MatchedViewPanel {
  dataset_id: string;
  result_key: string;
  read_ids?: string[];
  strand?: 'CT' | 'GA';
}

/** One side of a two-view (haplotype) comparison. */
export interface MatchedClusterView {
  id: string;
  chrom: string;
  start: number;
  end: number;
  panels: MatchedViewPanel[];
  /** Absolute features in genomic order; feature i of each view is matched. */
  peak_regions: PeakRegionWithMode[];
  /** Match this view's features right to left, each read in reverse (an inverted locus). */
  reverse?: boolean;
}

export interface MatchedClusterPanelResult {
  assignments: Record<string, number>;
  cluster_counts: Record<number, number>;
  view_id: string;
  dataset_id: string;
  eligible_read_count: number;
  peak_covering_read_count: number;
  analysis_read_count: number;
}

export interface MatchedClusterResponse {
  results: Record<string, MatchedClusterPanelResult>;
  mode: 'joint' | 'separate';
  method: string;
  /** shared: a state means the same in both views; per_view: each view has its own states. */
  label_space: 'shared' | 'per_view';
  feature_count: number;
  bins_per_feature: number;
  cluster_patterns?: Record<number, number[]> | null;
  balanced_fit_reads: number;
  total_reads: number;
  view_separation_nmi: number | null;
  dataset_separation_nmi: number | null;
  sample_seed?: string;
  timings?: Record<string, number>;
}

/** Cluster two comparison views on matched features (POST /api/cluster_matched_views). */
export async function clusterMatchedViews(args: {
  views: MatchedClusterView[];
  mode: 'joint' | 'separate';
  k: number;
  method: string;
  binsPerFeature?: number;
  balanceViews?: boolean;
  maxReads?: number;
  sampleSeed?: string;
  subnucleosomalThreshold?: number;
  accessibilityThreshold?: number;
}, init?: { signal?: AbortSignal }): Promise<MatchedClusterResponse> {
  const body: Record<string, unknown> = {
    views: args.views,
    mode: args.mode,
    k: args.k,
    method: args.method,
    bins_per_feature: args.binsPerFeature ?? 20,
    balance_views: args.balanceViews ?? true,
    subnucleosomal_threshold: args.subnucleosomalThreshold ?? 90,
    accessibility_threshold: args.accessibilityThreshold ?? 0.5,
  };
  if (args.maxReads) body.max_reads = args.maxReads;
  if (args.sampleSeed) body.sample_seed = args.sampleSeed;
  return fetchJson(`${API_BASE}/cluster_matched_views`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
}

export async function dissolveCluster(
  chrom: string,
  start: number,
  end: number,
  clusterToDissolve: number,
  currentAssignments: Record<string, Record<string, number>>,
  peakRegions: Array<PeakRegionWithMode>,
  datasetIds: string[],
  spanning: boolean,
  subnucleosomalThreshold: number = 90,
  accessibilityThreshold: number = 0.5,
  sampleSeed?: string,
  clusterFeatureRules?: ClusterFeatureRule[],
  /** A panel on another assembly: its reference's key (panel_genome). */
  panelGenome?: string | null,
): Promise<{ results: Record<string, ClusterResponse> }> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString()
  });
  if (panelGenome) params.set('panel_genome', panelGenome);
  return fetchJson(`${API_BASE}/dissolve_cluster?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cluster_to_dissolve: clusterToDissolve,
      current_assignments: currentAssignments,
      peak_regions: peakRegions,
      dataset_ids: datasetIds,
      subnucleosomal_threshold: subnucleosomalThreshold,
      accessibility_threshold: accessibilityThreshold,
      sample_seed: sampleSeed ?? null,
      cluster_feature_rules: clusterFeatureRules ?? [],
    }),
  });
}

export interface DissolvedCluster {
  cluster: number;
  count: number;
  reason: string;
  merged_into?: Record<number, number>;
  dominant_target?: number | null;
  /** "Merge by" strategy that judged it alike, and its score (absent for small clusters on older servers). */
  strategy?: string;
  score?: number;
}

/** "Merge by" for Merge similar clusters (utils/mergeStrategies.ts); absent: cosine at maxCosineSimilarity. */
export interface MergeByOptions {
  strategy?: string;
  /** The strategy's threshold (cosine: the similarity cutoff). */
  threshold?: number;
}

export async function autoCullClusters(
  chrom: string,
  start: number,
  end: number,
  currentAssignments: Record<string, Record<string, number>>,
  peakRegions: Array<PeakRegionWithMode>,
  datasetIds: string[],
  spanning: boolean,
  subnucleosomalThreshold: number = 90,
  accessibilityThreshold: number = 0.5,
  minFraction: number = 0.05,
  maxCosineSimilarity: number = 0.95,
  sampleSeed?: string,
  clusterFeatureRules?: ClusterFeatureRule[],
  /** A panel on another assembly: its reference's key (panel_genome). */
  panelGenome?: string | null,
  mergeBy?: MergeByOptions,
): Promise<{ results: Record<string, ClusterResponse>; dissolved: DissolvedCluster[]; merge?: Record<string, unknown> }> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString()
  });
  if (panelGenome) params.set('panel_genome', panelGenome);
  return fetchJson(`${API_BASE}/auto_cull_clusters?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      current_assignments: currentAssignments,
      peak_regions: peakRegions,
      dataset_ids: datasetIds,
      subnucleosomal_threshold: subnucleosomalThreshold,
      accessibility_threshold: accessibilityThreshold,
      min_fraction: minFraction,
      max_cosine_similarity: maxCosineSimilarity,
      ...(mergeBy?.strategy ? { merge_strategy: mergeBy.strategy } : {}),
      ...(mergeBy?.threshold != null ? { merge_threshold: mergeBy.threshold } : {}),
      sample_seed: sampleSeed ?? null,
      cluster_feature_rules: clusterFeatureRules ?? [],
    }),
  });
}

export type ProjectionMethod = 'pca' | 'umap' | 'tsne';

export interface ProjectionResponse {
  coords_x: number[];
  coords_y: number[];
  read_ids: string[];
  dataset_ids: string[];
  labels_before: number[];
  labels_after: number[] | null;
  cluster_centroids_before: Record<string, [number, number]>;
  cluster_centroids_after: Record<string, [number, number]> | null;
  dissolved: DissolvedCluster[];
  method: string;
  variance_explained: number[] | null;
  feature_dim: number;
  n_reads: number;
  sample_seed?: string;
  projection_random_state?: number;
  /** Datasets clustered at other peaks than the first one, left out of this projection. */
  skipped_datasets?: string[];
  /** Per read: DAF strand (CT/GA, '' unknown) and alignment orientation (+/-). */
  strands?: string[];
  alignment_strands?: string[];
  /** t-SNE: false for reads placed by their nearest embedded reads (over the cap). */
  embedded?: boolean[] | null;
  /** What defines the map: method, seed, perplexity, neighbours, feature digest, cap. */
  projection_params?: ProjectionParams | null;
}

export interface ProjectionParams {
  method: string;
  random_state: number;
  sample_seed?: string;
  n_reads: number;
  feature_dim: number;
  perplexity?: number;
  n_neighbors?: number;
  feature_digest?: string;
  max_reads?: number;
  n_embedded?: number;
  seconds?: number;
  cache_hit?: boolean;
  [key: string]: unknown;
}

export async function fetchClusterProjection(
  chrom: string,
  start: number,
  end: number,
  datasetIds: string[],
  peakRegions: Array<PeakRegionWithMode>,
  method: ProjectionMethod,
  spanning: boolean,
  options: {
    simulateAutocull?: boolean;
    minFraction?: number;
    maxCosineSimilarity?: number;
    /** "Merge by" for the merge preview (same as Merge similar clusters). */
    mergeStrategy?: string;
    mergeThreshold?: number;
    subnucleosomalThreshold?: number;
    accessibilityThreshold?: number;
    nComponents?: number;
    sampleSeed?: string;
    clusterFeatureRules?: ClusterFeatureRule[];
    signal?: AbortSignal;
    // Active cluster-tree branch assignments (datasetId -> readId -> cluster).
    // Sent so the backend uses the branch shown in the UI, not its stored map.
    clusterAssignments?: Record<string, Record<string, number>>;
    /** Per-read DAF strand (CT/GA): loads deamination marks, so only for the export. */
    includeStrands?: boolean;
    /** A panel on another assembly: its reference's key (panel_genome). */
    panelGenome?: string | null;
  } = {}
): Promise<ProjectionResponse> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString(),
  });
  if (options.panelGenome) params.set('panel_genome', options.panelGenome);
  return fetchJson(`${API_BASE}/cluster_projection?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataset_ids: datasetIds,
      peak_regions: peakRegions,
      method,
      n_components: options.nComponents ?? 2,
      simulate_autocull: options.simulateAutocull ?? false,
      min_fraction: options.minFraction ?? 0.05,
      max_cosine_similarity: options.maxCosineSimilarity ?? 0.95,
      ...(options.mergeStrategy ? { merge_strategy: options.mergeStrategy } : {}),
      ...(options.mergeThreshold != null ? { merge_threshold: options.mergeThreshold } : {}),
      subnucleosomal_threshold: options.subnucleosomalThreshold ?? 90,
      accessibility_threshold: options.accessibilityThreshold ?? 0.5,
      sample_seed: options.sampleSeed ?? null,
      cluster_feature_rules: options.clusterFeatureRules ?? [],
      ...(options.clusterAssignments ? { cluster_assignments: options.clusterAssignments } : {}),
      ...(options.includeStrands ? { include_strands: true } : {}),
    }),
    signal: options.signal,
  });
}

export async function assignToClusters(
  chrom: string,
  start: number,
  end: number,
  peakRegions: Array<PeakRegionWithMode>,
  clusterPatterns: Record<number, number[]>,
  datasetIds: string[],
  spanning: boolean,
  subnucleosomalThreshold: number = 90,
  accessibilityThreshold: number = 0.5,
  options?: {
    sampleSeed?: string;
    clusterFeatureRules?: ClusterFeatureRule[];
    readIds?: Record<string, string[]>;
    signal?: AbortSignal;
    // Non-combinatorial dynamic reassignment: supply centroids + feature-column
    // widths instead of patterns, and reads are assigned to the nearest centroid.
    centroids?: Record<number, number[]>;
    peakWidths?: number[];
    // Conservative: a read missing any clustering peak goes to Unassigned.
    overlapMode?: 'conservative' | 'aggressive';
  }
): Promise<{ results: Record<string, ClusterResponse> }> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString()
  });
  const useCentroids = !!options?.centroids && Object.keys(options.centroids).length > 0;
  return fetchJson(`${API_BASE}/assign_to_clusters?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peak_regions: peakRegions,
      cluster_patterns: clusterPatterns,
      dataset_ids: datasetIds,
      subnucleosomal_threshold: subnucleosomalThreshold,
      accessibility_threshold: accessibilityThreshold,
      sample_seed: options?.sampleSeed ?? null,
      cluster_feature_rules: options?.clusterFeatureRules ?? [],
      ...(options?.readIds ? { read_ids: options.readIds } : {}),
      // Applies to pattern and centroid reassignment alike.
      ...(options?.overlapMode ? { overlap_mode: options.overlapMode } : {}),
      ...(useCentroids ? {
        cluster_centroids: options!.centroids,
        cluster_peak_widths: options!.peakWidths ?? [],
      } : {}),
    }),
    signal: options?.signal,
  });
}

export interface ClusterVPlotData {
  matrix: number[][];
  size_min: number;
  size_max: number;
  size_bin: number;
  pos_bin: number;
  normalize?: 'per_cluster' | 'shared';
  /** 'midpoint': each footprint at its centre; 'span': across every position it covers. */
  mode?: VPlotMode;
  /** Each size row over its mean across the window. */
  row_normalize?: boolean;
  layer?: string | null;
}

/** 'midpoint': the traditional V-plot; 'span': "full footprint", each footprint fills the positions it covers. */
export type VPlotMode = 'midpoint' | 'span';

export async function fetchClusterVPlot(
  chrom: string,
  regionStart: number,
  regionEnd: number,
  options?: {
    sizeBin?: number; posBin?: number; sizeMin?: number; sizeMax?: number;
    logNorm?: boolean; smooth?: number;
    layer?: string | null;
    normalize?: 'per_cluster' | 'shared';
    mode?: VPlotMode;
    rowNormalize?: boolean;
    sampleSeed?: string;
    signal?: AbortSignal;
    // Active cluster-tree branch assignments (datasetId -> readId -> cluster).
    clusterAssignments?: Record<string, Record<string, number>>;
    /** A panel on another assembly: its reference's key (panel_genome). */
    panelGenome?: string | null;
  }
): Promise<{ success: boolean; data: Record<string, Record<number, ClusterVPlotData>> }> {
  const params = new URLSearchParams({
    chrom,
    region_start: regionStart.toString(),
    region_end: regionEnd.toString(),
  });
  if (options?.panelGenome) params.set('panel_genome', options.panelGenome);
  return fetchJson(`${API_BASE}/cluster/vplot?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size_bin: options?.sizeBin ?? 5,
      pos_bin: options?.posBin ?? 5,
      size_min: options?.sizeMin ?? 10,
      size_max: options?.sizeMax ?? 300,
      log_norm: options?.logNorm ?? true,
      smooth: options?.smooth ?? 1.0,
      layer: options?.layer ?? null,
      normalize: options?.normalize ?? 'per_cluster',
      mode: options?.mode ?? 'midpoint',
      row_normalize: options?.rowNormalize ?? false,
      sample_seed: options?.sampleSeed ?? null,
      ...(options?.clusterAssignments ? { cluster_assignments: options.clusterAssignments } : {}),
    }),
    signal: options?.signal,
  });
}
