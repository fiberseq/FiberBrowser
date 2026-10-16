// ============================================================================
// DAF-C API CLIENT
// ============================================================================

import type { LinkedRegion, ContactSelection, LinkedSession, DAFCStatus, SplitViewMode, SplitViewSemantics, ContactMode } from '../types/dafc';
import { fetchApiResponse, fetchJson, fetchJsonSharedGet, withSortedParams } from './sharedFetch';
import { withSandboxParam } from '../utils/sandbox';

const API_BASE = '/api';

// ============================================================================
// DAF-C Endpoints
// ============================================================================

export async function loadDafc(coolFile: string, bigbedFile?: string): Promise<{
  success: boolean;
  chroms: { name: string; size: number }[];
  resolutions: number[];
  current_resolution: number;
  has_bigbed: boolean;
  error?: string;
}> {
  const params = new URLSearchParams({ cool_file: coolFile });
  if (bigbedFile) params.append('bigbed_file', bigbedFile);

  return fetchJson(`${API_BASE}/dafc/load?${params}`, { method: 'POST' });
}

export async function getDafcStatus(): Promise<DAFCStatus> {
  const res = await fetchApiResponse(`${API_BASE}/dafc/status`);
  if (!res.ok) throw new Error('Failed to get DAF-C status');
  return res.json();
}

export function getDafcMatrixImageUrl(
  chrom: string,
  start: number,
  end: number,
  resolution?: number,
  offDiagonal?: { xStart: number; xEnd: number; yStart: number; yEnd: number },
  options?: {
    scaling?: string;
    colormap?: string;
    normalization?: string;
    vmin?: number | null;
    vmax?: number | null;
  }
): string {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
  });
  if (resolution) params.append('resolution', resolution.toString());
  if (offDiagonal) {
    params.append('x_start', offDiagonal.xStart.toString());
    params.append('x_end', offDiagonal.xEnd.toString());
    params.append('y_start', offDiagonal.yStart.toString());
    params.append('y_end', offDiagonal.yEnd.toString());
  }
  if (options?.scaling && options.scaling !== 'log') params.append('scaling', options.scaling);
  if (options?.colormap && options.colormap !== 'fall') params.append('colormap', options.colormap);
  if (options?.normalization && options.normalization !== 'none') params.append('normalization', options.normalization);
  if (options?.vmin != null) params.append('vmin', options.vmin.toString());
  if (options?.vmax != null) params.append('vmax', options.vmax.toString());
  return withSandboxParam(`${API_BASE}/dafc/matrix/image?${params}`);
}

export interface DafcMatrixDataResult {
  matrix: number[][];
  chrom: string;
  x_start: number;
  x_end: number;
  y_start: number;
  y_end: number;
  resolution: number;
  n_rows: number;
  n_columns: number;
  normalization: string;
  balance_applied: boolean;
}

export async function getDafcMatrixData(
  chrom: string,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number,
  resolution?: number,
  normalization: 'none' | 'balanced' | 'oe' | 'oe_global' = 'none',
): Promise<DafcMatrixDataResult> {
  const params = new URLSearchParams({
    chrom,
    start: Math.min(xStart, yStart).toString(),
    end: Math.max(xEnd, yEnd).toString(),
    x_start: xStart.toString(),
    x_end: xEnd.toString(),
    y_start: yStart.toString(),
    y_end: yEnd.toString(),
    normalization,
  });
  if (resolution) params.set('resolution', resolution.toString());
  return fetchJsonSharedGet<DafcMatrixDataResult>(
    withSortedParams(`${API_BASE}/dafc/matrix/data`, params),
  );
}

export async function selectDafcRegion(
  chrom: string,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number
): Promise<ContactSelection> {
  const params = new URLSearchParams({
    chrom,
    x_start: xStart.toString(),
    x_end: xEnd.toString(),
    y_start: yStart.toString(),
    y_end: yEnd.toString(),
  });
  const res = await fetchApiResponse(`${API_BASE}/dafc/select?${params}`);
  if (!res.ok) throw new Error('Failed to select region');
  return res.json();
}

// ============================================================================
// Linked Sessions Endpoints
// ============================================================================

export type LinkedSessionCreateResponse = {
  success: boolean;
  session_id: string;
  session?: LinkedSession;
};

export type LinkedSessionDetail = LinkedSession & {
  read_order: string[];
  linked_reads: Array<{
    base_id: string;
    x_segments: string[];
    y_segments: string[];
  }>;
  x_segment_names: string[];
  y_segment_names: string[];
};

export async function createLinkedSession(): Promise<LinkedSessionCreateResponse> {
  const res = await fetchApiResponse(`${API_BASE}/linked/session/create`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create session');
  return res.json();
}

export async function getLinkedSessions(): Promise<{ sessions: LinkedSession[] }> {
  const res = await fetchApiResponse(`${API_BASE}/linked/sessions`);
  if (!res.ok) throw new Error('Failed to get sessions');
  return res.json();
}

export async function getLinkedSession(sessionId: string): Promise<LinkedSessionDetail> {
  const res = await fetchApiResponse(`${API_BASE}/linked/session/${sessionId}`);
  if (!res.ok) throw new Error('Failed to get session');
  return res.json();
}

export async function sendToLinkedSession(
  sessionId: string,
  regions: LinkedRegion,
  readIds: string[],
  contactMode?: ContactMode,
  splitViewMode?: SplitViewMode
): Promise<{ success: boolean; n_reads: number; version: number; contact_mode: ContactMode | null; split_view_mode: SplitViewMode; split_view_semantics: SplitViewSemantics }> {
  const body: Record<string, unknown> = { regions, read_ids: readIds };
  if (contactMode) body.contact_mode = contactMode;
  if (splitViewMode) body.split_view_mode = splitViewMode;
  const res = await fetchApiResponse(`${API_BASE}/linked/session/${sessionId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to send reads');
  return res.json();
}

export async function deleteLinkedSession(sessionId: string): Promise<{ success: boolean }> {
  const res = await fetchApiResponse(`${API_BASE}/linked/session/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete session');
  return res.json();
}

// ============================================================================
// Linked Reads Endpoints
// ============================================================================

export function getLinkedReadsImageUrl(
  sessionId: string,
  region: 'x' | 'y',
  maxWidth: number = 2000,
  rowHeight: number = 3,
  version?: number
): string {
  const params = new URLSearchParams({
    session_id: sessionId,
    region,
    max_width: maxWidth.toString(),
    row_height: rowHeight.toString(),
  });
  // Add version for cache busting
  if (version !== undefined) params.append('v', version.toString());
  return withSandboxParam(`${API_BASE}/linked/reads/image?${params}`);
}

export type LinkedReadsDataResult = LinkedSession & {
  regions: LinkedRegion | null;
  reads: any[];
  read_order: string[];
  n_reads: number;
  version: number;
};

export async function getLinkedReadsData(sessionId: string): Promise<LinkedReadsDataResult> {
  const res = await fetchApiResponse(`${API_BASE}/linked/reads/data?session_id=${sessionId}`);
  if (!res.ok) throw new Error('Failed to get linked reads');
  return res.json();
}

// Compact read format for ReadTrack
interface CompactRead {
  id: string;
  intervals: Array<[number, number, number]>;  // [start, end, size] - size negative for gaps
  methyl?: Array<[number, number, string, number]>;
}

export interface LinkedReadsCompactResult {
  reads: CompactRead[];
  count: number;
  total: number;
  working_count: number;
  width: number;
  sample_seed?: string;
  region: {
    chrom: string;
    start: number;
    end: number;
  };
  contact_mode?: ContactMode;
  split_view_mode?: SplitViewMode;
  split_view_semantics?: SplitViewSemantics;
}

export type LinkedReadsCompactOptions = {
  maxReads?: number;
  sortBy?: 'x' | 'y';
  hideTerminalGaps?: boolean;
  terminalGapThreshold?: number;
  sampleSeed?: string;
};

export async function getLinkedReadsCompact(
  sessionId: string,
  region: 'x' | 'y',
  maxReadsOrOptions: number | LinkedReadsCompactOptions = 500,
  sampleSeed?: string
): Promise<LinkedReadsCompactResult> {
  const options: LinkedReadsCompactOptions = typeof maxReadsOrOptions === 'number'
    ? { maxReads: maxReadsOrOptions, sampleSeed }
    : maxReadsOrOptions;
  const params = new URLSearchParams({
    session_id: sessionId,
    region,
    max_reads: (options.maxReads ?? 500).toString(),
    sort_by: options.sortBy ?? 'x',
    hide_terminal_gaps: String(options.hideTerminalGaps ?? true),
    terminal_gap_threshold: String(options.terminalGapThreshold ?? 500),
  });
  if (options.sampleSeed) params.set('sample_seed', options.sampleSeed);
  return fetchJsonSharedGet<LinkedReadsCompactResult>(
    withSortedParams(`${API_BASE}/linked/reads/compact`, params),
  );
}

// ============================================================================
// Micro-C / Hi-C Endpoints
// ============================================================================

import type { ContactArc, Virtual4CResponse, APAResponse } from '../types/dafc';

export function getMicrocMatrixStripUrl(
  chrom: string,
  start: number,
  end: number,
  maxDistance: number = 100000,
  width: number = 800,
  height: number = 150,
  resolution?: number,
  scaling: 'linear' | 'log' | 'sqrt' = 'log',
  colormap: 'red' | 'fall' | 'hot' | 'viridis' | 'blues' = 'fall',
  normalization: 'none' | 'balanced' | 'oe' | 'oe_global' = 'none',
  focusRegion?: { start: number; end: number } | null
): string {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    max_distance: maxDistance.toString(),
    width: width.toString(),
    height: height.toString(),
    scaling,
    colormap,
    normalization,
  });
  if (resolution) params.append('resolution', resolution.toString());
  if (focusRegion) {
    params.append('focus_start', focusRegion.start.toString());
    params.append('focus_end', focusRegion.end.toString());
  }
  return withSandboxParam(`${API_BASE}/microc/matrix/strip?${params}`);
}

export async function getMicrocArcs(
  chrom: string,
  start: number,
  end: number,
  options?: {
    minDistance?: number;
    maxDistance?: number;
    threshold?: number;
    maxArcs?: number;
    resolution?: number;
    normalization?: 'none' | 'oe' | 'oe_global';
    minCount?: number;
    mergeBin?: number;  // Server-side merge bin size (0 = no merge)
    stableStrength?: boolean;  // Return raw O/E instead of normalized 0-1
    oeFloor?: number;  // Minimum O/E ratio to display (only for O/E modes, 0 = show all)
    accCorrect?: boolean;  // Apply accessibility correction from fiber-seq
    accLog?: boolean;  // Use log-space accessibility correction
  }
): Promise<{ arcs: ContactArc[]; max_distance: number; normalization: string; merged?: boolean; stable?: boolean }> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
  });
  // 0 is "Off", not "unset" (the server's default is 5 kb).
  if (options?.minDistance != null) params.append('min_distance', options.minDistance.toString());
  if (options?.maxDistance) params.append('max_distance', options.maxDistance.toString());
  if (options?.threshold) params.append('threshold', options.threshold.toString());
  if (options?.maxArcs) params.append('max_arcs', options.maxArcs.toString());
  if (options?.resolution) params.append('resolution', options.resolution.toString());
  if (options?.normalization) params.append('normalization', options.normalization);
  if (options?.minCount) params.append('min_count', options.minCount.toString());
  if (options?.mergeBin) params.append('merge_bin', options.mergeBin.toString());
  if (options?.stableStrength) params.append('stable_strength', 'true');
  if (options?.oeFloor) params.append('oe_floor', options.oeFloor.toString());
  if (options?.accCorrect) params.append('acc_correct', 'true');
  if (options?.accLog) params.append('acc_log', 'true');

  const res = await fetchApiResponse(`${API_BASE}/microc/arcs?${params}`);
  if (!res.ok) throw new Error('Failed to get Micro-C arcs');
  return res.json();
}

// Precompute chromosome-wide expected values for O/E global normalization
// Call this when switching chromosomes to warm up the cache
export async function precomputeExpected(
  chrom: string,
  resolution?: number
): Promise<{ success: boolean; cached: boolean; computing?: boolean }> {
  const params = new URLSearchParams({ chrom });
  if (resolution) params.append('resolution', resolution.toString());

  try {
    const res = await fetchApiResponse(`${API_BASE}/microc/precompute_expected?${params}`, { method: 'POST' });
    if (!res.ok) return { success: false, cached: false };
    return res.json();
  } catch {
    return { success: false, cached: false };
  }
}

// Check if expected values are ready for a chromosome
export async function getExpectedStatus(
  chrom: string,
  resolution?: number
): Promise<{ ready: boolean; computing: boolean; status: 'ready' | 'computing' | 'not_started' }> {
  const params = new URLSearchParams({ chrom });
  if (resolution) params.append('resolution', resolution.toString());

  try {
    const res = await fetchApiResponse(`${API_BASE}/microc/expected_status?${params}`);
    if (!res.ok) return { ready: false, computing: false, status: 'not_started' };
    return res.json();
  } catch {
    return { ready: false, computing: false, status: 'not_started' };
  }
}

export async function getVirtual4C(
  chrom: string,
  viewpointStart: number,
  viewpointEnd: number,
  profileStart: number,
  profileEnd: number,
  resolution?: number,
  normalization?: 'none' | 'oe'
): Promise<Virtual4CResponse> {
  const params = new URLSearchParams({
    chrom,
    viewpoint_start: viewpointStart.toString(),
    viewpoint_end: viewpointEnd.toString(),
    profile_start: profileStart.toString(),
    profile_end: profileEnd.toString(),
  });
  if (resolution) params.append('resolution', resolution.toString());
  if (normalization) params.append('normalization', normalization);

  const res = await fetchApiResponse(`${API_BASE}/microc/virtual4c?${params}`);
  if (!res.ok) throw new Error('Failed to get virtual 4C profile');
  return res.json();
}

export async function getAPA(
  chrom: string,
  peaks: Array<{ start: number; end: number }>,
  options?: {
    window?: number;
    resolution?: number;
    normalization?: 'none' | 'oe';
  }
): Promise<APAResponse> {
  const params = new URLSearchParams({ chrom });
  if (options?.window) params.append('window', options.window.toString());
  if (options?.resolution) params.append('resolution', options.resolution.toString());
  if (options?.normalization) params.append('normalization', options.normalization);

  const res = await fetchApiResponse(`${API_BASE}/microc/apa?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peaks }),
  });
  if (!res.ok) throw new Error('Failed to compute APA');
  return res.json();
}
