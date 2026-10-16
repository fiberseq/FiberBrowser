import { fetchApiResponse, fetchJson } from './sharedFetch';

const API_BASE = '/api';

export interface TrackDataResponse {
  label: string;
  values: number[];
  render_mode?: string;
}

export interface TrackAnnotationInterval {
  start: number;
  end: number;
  name?: string;
  strand?: string;
  score?: number;
  blocks?: { start: number; size: number }[];
  cdsStart?: number;
  cdsEnd?: number;
}

export interface TrackAnnotationsResponse {
  label: string;
  intervals: TrackAnnotationInterval[];
  track_type?: string;
}

export interface TrackBatchItemResponse extends TrackDataResponse {
  index: number;
  intervals?: TrackAnnotationInterval[];
  track_type?: string;
  error?: string;
}

export interface TrackBatchResponse {
  tracks: TrackBatchItemResponse[];
}

export interface BigBedNamesResponse {
  success: boolean;
  names: string[];
  name_to_ma?: Record<string, string[]>;
  error?: string;
}

export interface TrackListEntry {
  index: number;
  label: string;
  path: string;
  render_mode?: string;
  category?: string;
  format?: string;
  /** Names the track is filtered to (empty: every feature). */
  filter_names?: string[];
  motif_type?: string;
  motif_name?: string;
  motif_source?: string;
}

export interface BackendMotifTrack {
  track_index: number;
  path: string;
  label: string;
  motif_name?: string;
  motif_type?: string;
  motif_source?: string;
  threshold?: number;
}

export type MotifPwmCounts = Record<'A' | 'C' | 'G' | 'T', number[]>;

export async function getTrackData(
  trackIdx: number,
  chrom: string,
  start: number,
  end: number,
  bins?: number,
  options?: RequestInit
): Promise<TrackDataResponse> {
  const params = new URLSearchParams({ chrom, start: start.toString(), end: end.toString() });
  if (bins) params.set('bins', bins.toString());
  return fetchJson(`${API_BASE}/tracks/${trackIdx}?${params}`, options);
}

export async function getTrackAnnotations(
  trackIdx: number,
  chrom: string,
  start: number,
  end: number,
  filterNames?: string[],
  options?: RequestInit
): Promise<TrackAnnotationsResponse> {
  const params = new URLSearchParams({ chrom, start: start.toString(), end: end.toString() });
  if (filterNames && filterNames.length > 0) params.set('filter_names', filterNames.join(','));
  return fetchJson(`${API_BASE}/tracks/${trackIdx}/annotations?${params}`, options);
}

export async function getTracksBatch(
  trackIndices: number[],
  chrom: string,
  start: number,
  end: number,
  bins?: number,
  annotationFilters?: Record<number, string[] | undefined>,
  options?: RequestInit,
  /** A panel's own reference (another assembly, a plugin pack's contig): its sequence is scanned for motifs. */
  genome?: string | null,
): Promise<TrackBatchResponse> {
  return fetchJson(`${API_BASE}/tracks/batch${genome ? `?${new URLSearchParams({ panel_genome: genome })}` : ''}`, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      track_indices: trackIndices,
      chrom,
      start,
      end,
      bins: bins ?? 500,
      annotation_filters: annotationFilters ?? {},
    }),
  });
}

export async function getBigBedNames(url: string, genome?: string): Promise<BigBedNamesResponse> {
  const params = new URLSearchParams({ url });
  if (genome) params.set('genome', genome);
  return fetchJson(`${API_BASE}/bigbed/names?${params}`);
}

export async function updateTrackFilter(trackIdx: number, filterNames: string[] | null): Promise<{ success: boolean; filter_names?: string[] | null }> {
  return fetchJson(`${API_BASE}/tracks/${trackIdx}/filter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter_names: filterNames }),
  });
}

export async function reorderTracks(fromIndex: number, toIndex: number): Promise<{ success: boolean; message?: string }> {
  return fetchJson(`${API_BASE}/tracks/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_index: fromIndex, to_index: toIndex }),
  });
}

export async function exportTrack(
  trackIdx: number,
  chrom: string,
  start: number,
  end: number,
  format: 'bedgraph' | 'tsv' = 'bedgraph',
  bins = 2000,
): Promise<Blob> {
  const params = new URLSearchParams({ chrom, start: String(start), end: String(end), format, bins: String(bins) });
  const response = await fetchApiResponse(`${API_BASE}/tracks/${trackIdx}/export?${params}`);
  if (!response.ok) throw new Error(`Export failed: ${response.status}`);
  return response.blob();
}

export async function exportTracksMulti(
  trackIndices: number[],
  labels: string[],
  chrom: string,
  start: number,
  end: number,
  bins = 2000,
): Promise<Blob> {
  const response = await fetchApiResponse(`${API_BASE}/tracks/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ track_indices: trackIndices, labels, chrom, start, end, bins }),
  });
  if (!response.ok) throw new Error(`Export failed: ${response.status}`);
  return response.blob();
}

export async function addTrack(path: string, label?: string, filterNames?: string[], category?: string, renderMode?: string): Promise<{ success: boolean; message?: string; track_index?: number; label?: string; render_mode?: string; warning?: string }> {
  const params = new URLSearchParams({ path });
  if (label) params.set('label', label);
  if (filterNames && filterNames.length > 0) params.set('filter_names', filterNames.join(','));
  if (category) params.set('category', category);
  if (renderMode) params.set('render_mode', renderMode);
  return fetchJson(`${API_BASE}/add_track?${params}`, {
    method: 'POST'
  });
}

export async function getTracks(): Promise<{ tracks: TrackListEntry[] }> {
  return fetchJson(`${API_BASE}/tracks`);
}

export async function addMotifSequenceTrack(
  sequence: string,
  label?: string,
  threshold?: number
): Promise<{ success: boolean; track_index?: number; path?: string; label?: string; motif_name?: string; motif_type?: string; message?: string }> {
  return fetchJson(`${API_BASE}/tracks/add_motif_sequence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sequence, label: label ?? null, threshold: threshold ?? 0.85 }),
  });
}

export async function addMotifFileTracks(
  filePath: string,
  format?: string,
  threshold?: number
): Promise<{ success: boolean; loaded?: string[]; tracks?: BackendMotifTrack[]; count?: number; message?: string }> {
  return fetchJson(`${API_BASE}/tracks/add_motif_file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_path: filePath, format: format ?? null, threshold: threshold ?? 0.8 }),
  });
}

export async function addMotifPwmTrack(
  name: string,
  counts: MotifPwmCounts,
  label?: string,
  threshold?: number
): Promise<{ success: boolean; track_index?: number; path?: string; label?: string; motif_name?: string; motif_type?: string; motif_source?: string; message?: string }> {
  return fetchJson(`${API_BASE}/tracks/add_motif_pwm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, counts, label: label ?? null, threshold: threshold ?? 0.85 }),
  });
}

export interface JasparSearchResult {
  matrix_id: string;
  name: string;
  tax_group: string;
  length: number;
}

/**
 * JASPAR search, ranked for a reference's taxon: `panelGenome` (a panel reference key: an expanded insert,
 * a panel FASTA) or, without one, the main reference. The server resolves the genome (loaded, inherited
 * or declared); no genome name is sent.
 */
export async function searchJasparMotifs(
  query: string,
  panelGenome?: string | null,
  signal?: AbortSignal,
): Promise<{ available: boolean; results: JasparSearchResult[]; message?: string }> {
  const params = new URLSearchParams({ q: query, limit: '12' });
  if (panelGenome) params.set('panel_genome', panelGenome);
  return fetchJson(`${API_BASE}/motifs/jaspar/search?${params}`, { signal });
}

export async function addMotifJasparTracks(
  matrixIds: string[],
  threshold: number,
): Promise<{ success: boolean; tracks?: BackendMotifTrack[]; message?: string }> {
  return fetchJson(`${API_BASE}/tracks/add_motif_jaspar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matrix_ids: matrixIds, threshold }),
  });
}

export async function removeTrack(trackIdx: number): Promise<{ success: boolean; message?: string }> {
  return fetchJson(`${API_BASE}/tracks/${trackIdx}`, { method: 'DELETE' });
}
