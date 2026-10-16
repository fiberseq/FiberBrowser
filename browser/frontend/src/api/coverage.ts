import { fetchJson, fetchJsonSharedGet, withSortedParams } from './sharedFetch';

const API_BASE = '/api';

export interface RandomWindowResponse {
  success: boolean;
  chrom?: string;
  start?: number;
  end?: number;
  max_coverage?: number;
  attempts?: number;
  error?: string;
  reason?: FindReadsReason;
  genome?: string | null;
}

/**
 * Why a reads search found nothing (the server's `reason`): no dataset;
 * the dataset has no mapped reads; its reads are all on contigs the loaded
 * genome lacks; none within the loaded genome; the search ran out of time.
 */
export type FindReadsReason = 'no_datasets' | 'no_reads' | 'contig_mismatch' | 'not_found' | 'timeout';

export async function getRandomCoveredWindow(
  span: number,
  minCoverage: number,
  datasetId?: string,
): Promise<RandomWindowResponse> {
  const params = new URLSearchParams({
    span: Math.max(1, Math.round(span)).toString(),
    min_coverage: Math.max(1, Math.round(minCoverage)).toString(),
  });
  if (datasetId) params.set('dataset_id', datasetId);
  return fetchJson(`${API_BASE}/reads/random_window?${params}`);
}

export interface CoverageResponse {
  coverage: number[];
  max: number;
  /** Reads (molecules) counted in the window: the read panel's reads there before its filters. */
  reads?: number;
}

export function coverageQueryKey(params: URLSearchParams): string {
  return withSortedParams(`${API_BASE}/coverage`, params);
}

export async function getCoverage(
  chrom: string,
  start: number,
  end: number,
  bins: number,
  datasetId?: string,
  options?: RequestInit,
  includeDuplicates = false,
): Promise<CoverageResponse> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    bins: bins.toString(),
  });
  if (datasetId) params.set('dataset_id', datasetId);
  // Duplicate-flagged molecules count only when the read panel shows them.
  if (includeDuplicates) params.set('include_duplicates', 'true');
  return fetchJsonSharedGet(coverageQueryKey(params), options);
}

export interface TopWindow { chrom: string; start: number; end: number; depth: number; /** Narrowed to its reads (fit). */ fitted?: boolean }

export interface TopWindowsResponse {
  success: boolean;
  windows: TopWindow[];
  error?: string;
  reason?: FindReadsReason;
  genome?: string | null;
  /** The search ran out of time: the windows it found by then. */
  partial?: boolean;
}

/** The best-covered windows of this width, deepest first. */
export async function getTopCoveredWindows(span: number, datasetId?: string, n = 20, options?: RequestInit & { fit?: boolean; genome?: string | null }): Promise<TopWindowsResponse> {
  const params = new URLSearchParams({ span: Math.max(1, Math.round(span)).toString(), n: String(n) });
  if (datasetId) params.set('dataset_id', datasetId);
  const { fit, genome, ...init } = options ?? {};
  // A dataset on its own reference: search that reference's contigs.
  if (genome) params.set('panel_genome', genome);
  // Narrow each window to its reads when they cover much less than span (amplicons).
  if (fit) params.set('fit', 'true');
  return fetchJson(`${API_BASE}/reads/top_windows?${params}`, init);
}
