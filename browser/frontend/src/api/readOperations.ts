import { prefetchReadRegion, prepareReadNavigation } from './readPrefetch';
export { cancelReadPrefetch, setReadPrefetchMargin } from './readPrefetch';
import { signalFilterParams } from '../utils/signalFilters';
import { canProjectReadRegion, lookupReadRegion, rememberReadRegion, readRegionGeneration, lookupExactReadResponse, rememberExactReadResponse } from './loadedReadRegion';
import type { ReadsResponse } from '../components/tracks/read-track/types';
import { READ_STREAM_TYPE } from './readStream';
import type { ReadRequestOptions } from './sharedFetch';
import { readBinaryBytes, READ_BINARY_TYPE } from './readBinary';
import type { FireResponse, FilterMode, MetaResponse } from '../types';
import { fetchJson, fetchJsonSharedGet, withSortedParams } from './sharedFetch';
import type { QualityGatePayload } from '../utils/ruleMatching';

const API_BASE = '/api';

export async function getMeta(chrom: string, start: number, end: number, datasetId?: string): Promise<MetaResponse> {
  const params = new URLSearchParams({ chrom, start: start.toString(), end: end.toString() });
  if (datasetId) params.set('dataset_id', datasetId);
  return fetchJson(`${API_BASE}/meta?${params}`);
}

export async function getMetaAll(chrom: string, start: number, end: number): Promise<{ profiles: Record<string, { nucleosome_profile: number[]; subnuc_profile: number[] }> }> {
  const params = new URLSearchParams({ chrom, start: start.toString(), end: end.toString() });
  return fetchJson(`${API_BASE}/meta_all?${params}`);
}

export function compactReadsQueryKey(params: URLSearchParams): string {
  return withSortedParams(`${API_BASE}/reads/compact`, signalFilterParams(params));
}

export function compactReadsAllQueryKey(params: URLSearchParams): string {
  return withSortedParams(`${API_BASE}/reads/compact_all`, signalFilterParams(params));
}

export function linkedCompactReadsQueryKey(params: URLSearchParams): string {
  return withSortedParams(`${API_BASE}/linked/reads/compact`, params);
}

function readTransportOptions(params: URLSearchParams, options?: RequestInit): RequestInit | undefined {
  // Small display samples cost less to parse as JSON. Dense cohorts benefit
  // from keeping their evidence in columns until rows are actually accessed.
  const count = params.get('max_reads');
  if (params.get('full_working_set') !== 'true' && count !== '0' && Number(count || 0) < 2000) return options;
  const headers = new Headers(options?.headers);
  headers.set('Accept', READ_BINARY_TYPE);
  return { ...options, headers };
}

export async function getCompactReads<T = any>(params: URLSearchParams, options?: ReadRequestOptions): Promise<T> {
  if (options?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  params = signalFilterParams(params);
  prepareReadNavigation(params);
  const key = compactReadsQueryKey(params);
  const cached = lookupExactReadResponse<ReadsResponse>(key) ?? lookupReadRegion(params);
  if (cached) {
    prefetchReadRegion(params, readRegionGeneration(), cached);
    return cached as T;
  }
  const generation = readRegionGeneration();
  const transport = readTransportOptions(params, options);
  const limit = Number(params.get('max_reads') || 0);
  const streaming = canProjectReadRegion(params) && (limit === 0 || limit >= 2000);
  const headers = new Headers(transport?.headers);
  if (streaming) headers.set('Accept', READ_STREAM_TYPE);
  const data = await fetchJsonSharedGet<T>(key, { ...transport, headers,
    onReadProgress: streaming ? options?.onReadProgress : undefined });
  const bytes = data && typeof data === 'object' ? readBinaryBytes.get(data) : undefined;
  if (bytes !== undefined && canProjectReadRegion(params)) rememberReadRegion(params, data as ReadsResponse, bytes, generation);
  if (!lookupReadRegion(params)) rememberExactReadResponse(key, data, generation);
  if (!options?.signal?.aborted) prefetchReadRegion(params, generation, data as ReadsResponse);
  return data;
}

export async function getCompactReadsAll<T = any>(params: URLSearchParams, options?: RequestInit): Promise<T> {
  if (options?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  const ids = (params.get('dataset_ids') || params.get('dataset_id') || '').split(',');
  for (const id of ids) {
    const request = signalFilterParams(new URLSearchParams(params));
    request.delete('dataset_ids');
    request.set('dataset_id', id);
    request.set('prefetch_batch', 'true');
    prepareReadNavigation(request);
  }
  const generation = readRegionGeneration();
  const key = compactReadsAllQueryKey(params);
  const cached = lookupExactReadResponse<T>(key);
  const data = cached ?? await fetchJsonSharedGet<T>(key, readTransportOptions(params, options));
  if (!cached) rememberExactReadResponse(key, data, generation);
  if (!options?.signal?.aborted) {
    const datasets = (data as { datasets?: Record<string, ReadsResponse> })?.datasets;
    for (const [id, reads] of Object.entries(datasets ?? {})) {
      const request = signalFilterParams(new URLSearchParams(params));
      request.delete('dataset_ids');
      request.set('dataset_id', id);
      request.set('prefetch_batch', 'true');
      prefetchReadRegion(request, generation, reads);
    }
  }
  return data;
}

export async function getLinkedCompactReads<T = any>(params: URLSearchParams, options?: RequestInit): Promise<T> {
  return fetchJsonSharedGet<T>(linkedCompactReadsQueryKey(params), options);
}

export async function getFire(chrom: string, start: number, end: number): Promise<FireResponse> {
  const params = new URLSearchParams({ chrom, start: start.toString(), end: end.toString() });
  return fetchJson(`${API_BASE}/fire?${params}`);
}

export async function filterReads(
  chrom: string,
  start: number,
  end: number,
  peakRegions: Array<{ start: number; end: number }>,
  filterMode: FilterMode,
  spanning: boolean,
  datasetId: string,
  layer?: string | null,
  sampleSeed?: string,
): Promise<{ read_ids: string[] }> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString(),
    dataset_id: datasetId
  });
  return fetchJson(`${API_BASE}/filter?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peak_regions: peakRegions,
      filter_mode: filterMode,
      ...(layer && { layer }),
      sample_seed: sampleSeed ?? null,
    }),
  });
}

export interface AnalysisFilterResult {
  read_ids: string[];
  total: number;
  filtered: number;
}

export async function filterReadsByAnalysisRule(
  chrom: string,
  start: number,
  end: number,
  spanning: boolean,
  datasetIds: string[],
  opts: {
    metric: string;
    operator: string;
    threshold: number;
    rule?: { size_min: number; size_max: number | null; conditions: any[]; quality_gates?: QualityGatePayload[] };
    peakRegions?: number[][];
    scopeWindows?: number[][];
    layer?: string | null;
    transcriptionState?: string | null;
    geneIds?: string[];
    sampleSeed?: string;
    /** A panel on another assembly: its reference's key (genes and chromosomes are that reference's). */
    panelGenome?: string | null;
  },
): Promise<{ results: Record<string, AnalysisFilterResult> }> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString(),
  });
  if (opts.panelGenome) params.set('panel_genome', opts.panelGenome);
  return fetchJson(`${API_BASE}/filter_by_analysis_rule?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataset_ids: datasetIds,
      metric: opts.metric,
      operator: opts.operator,
      threshold: opts.threshold,
      ...(opts.rule && { rule: opts.rule }),
      ...(opts.peakRegions && { peak_regions: opts.peakRegions }),
      ...(opts.scopeWindows && { scope_windows: opts.scopeWindows }),
      ...(opts.layer && { layer: opts.layer }),
      ...(opts.transcriptionState && { transcription_state: opts.transcriptionState }),
      ...(opts.geneIds && { gene_ids: opts.geneIds }),
      sample_seed: opts.sampleSeed ?? null,
    }),
  });
}

export interface SortReadsResult {
  no_op_reason?: string;
  cluster_order: number[];
  read_sort_order: string[];
}

export async function sortReads(
  chrom: string,
  start: number,
  end: number,
  spanning: boolean,
  datasetIds: string[],
  sortBy: string,
  opts?: {
    rule?: { size_min: number; size_max: number | null; conditions: any[]; quality_gates?: QualityGatePayload[] };
    descending?: boolean;
    linked?: boolean;
    peakRegions?: number[][];
    selectedPeakWindows?: number[][];
    layer?: string | null;
    transcriptionState?: string | null;
    geneIds?: string[];
    sampleSeed?: string;
    readIds?: Record<string, string[]>;
    clusterAssignments?: Record<string, Record<string, number>>;
    /** sortBy 'projection': the Projection tab's map features (its peaks, rules, threshold). */
    projection?: {
      peakRegions: Array<{ start: number; end: number; mode?: string }>;
      clusterFeatureRules?: unknown[];
      subnucleosomalThreshold?: number;
      /** The whole clustering the map is drawn from (the sort may order a subset of it). */
      clusterAssignments?: Record<string, Record<string, number>>;
    };
    /** A panel on another assembly: its reference's key (genes and chromosomes are that reference's). */
    panelGenome?: string | null;
    signal?: AbortSignal;
  }
): Promise<{ results: Record<string, SortReadsResult>; error?: string }> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString()
  });
  if (opts?.panelGenome) params.set('panel_genome', opts.panelGenome);
  return fetchJson(`${API_BASE}/sort_reads?${params}`, {
    signal: opts?.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataset_ids: datasetIds,
      sort_by: sortBy,
      ...(opts?.rule && { rule: opts.rule }),
      descending: opts?.descending ?? true,
      ...(opts?.linked !== undefined && { linked: opts.linked }),
      ...(opts?.peakRegions && { peak_regions: opts.peakRegions }),
      ...(opts?.selectedPeakWindows && { selected_peak_windows: opts.selectedPeakWindows }),
      ...(opts?.layer && { layer: opts.layer }),
      ...(opts?.transcriptionState && { transcription_state: opts.transcriptionState }),
      ...(opts?.geneIds && { gene_ids: opts.geneIds }),
      ...(opts?.readIds && { read_ids: opts.readIds }),
      ...(opts?.clusterAssignments && { cluster_assignments: opts.clusterAssignments }),
      ...(opts?.projection && {
        projection: {
          peak_regions: opts.projection.peakRegions,
          cluster_feature_rules: opts.projection.clusterFeatureRules ?? [],
          subnucleosomal_threshold: opts.projection.subnucleosomalThreshold ?? 90,
          ...(opts.projection.clusterAssignments && { cluster_assignments: opts.projection.clusterAssignments }),
        },
      }),
      sample_seed: opts?.sampleSeed ?? null,
    }),
  });
}

export interface AutozoomResult {
  success: boolean;
  chrom?: string;
  start?: number;
  end?: number;
  spanning_reads?: number;
  original_start?: number;
  original_end?: number;
  message?: string;
  best_count?: number;
  left_primer?: number;
  right_primer?: number;
  primer_clip?: number;
}

export async function autozoom(
  chrom: string,
  start: number,
  end: number,
  spanning: boolean,
  datasetIds: string[],
  distance: number = 1000,
  minReads: number = 5,
  primerClip: number = 50,
  clusterWindow: number = 100
): Promise<AutozoomResult> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString()
  });
  return fetchJson(`${API_BASE}/autozoom?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataset_ids: datasetIds,
      distance,
      min_reads: minReads,
      primer_clip: primerClip,
      cluster_window: clusterWindow
    }),
  });
}

export interface CompactRead {
  id: string;
  intervals: Array<[number, number, number]>;
  methyl?: Array<[number, number, string, number]>;
}

export interface ClusterExpandResult {
  reads: CompactRead[];
  count: number;
  cluster_counts: Record<number, number>;
  total_in_clusters: number;
}

export async function clusterExpand(
  chrom: string,
  start: number,
  end: number,
  clusterIds: number[],
  datasetId: string,
  maxReads: number = 500
): Promise<ClusterExpandResult> {
  const params = new URLSearchParams({ chrom, start: start.toString(), end: end.toString() });
  return fetchJson(`${API_BASE}/cluster_expand?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cluster_ids: clusterIds,
      dataset_id: datasetId,
      max_reads: maxReads,
    }),
  });
}

export interface WorkingSetInfo {
  has_working_set: boolean;
  working_count: number;
  total_spanning: number;
  total_overlapping: number;
  has_clusters: boolean;
  cluster_count: number;
  cluster_sizes: Record<number, number>;
  max_working_reads: number;
  sample_seed?: string;
}

export async function getWorkingSetInfo(
  chrom: string,
  start: number,
  end: number,
  datasetId: string,
  sampleSeed?: string,
): Promise<WorkingSetInfo> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    dataset_id: datasetId,
  });
  if (sampleSeed) params.set('sample_seed', sampleSeed);
  return fetchJson(`${API_BASE}/working_set_info?${params}`);
}
