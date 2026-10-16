import type {
  AnnotationFileInfo,
  AnnotationTypeInfo,
  ReadAnnotation,
} from '../stores/annotationSlice';
import { fetchJson } from './sharedFetch';
import { pickWithFallback } from './files';

const API_BASE = '/api';

// Backend returns snake_case keys while frontend stores use camelCase.
// Normalize once at the API boundary so consumers can stay store-shaped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeAnnotationFile(raw: any): AnnotationFileInfo {
  return {
    id: raw.id,
    path: raw.path,
    label: raw.label,
    active: raw.active,
    datasetIds: raw.dataset_ids ?? raw.datasetIds ?? [],
    annotationTypes: (raw.annotation_types ?? raw.annotationTypes ?? []).map((t: any) => ({
      name: t.name,
      category: t.category,
      description: t.description,
      color: t.color,
      count: t.count,
    })),
  };
}

export async function getAnnotationFiles(options?: RequestInit): Promise<{ files: AnnotationFileInfo[] }> {
  const raw = await fetchJson<{ files: any[] }>(`${API_BASE}/annotations/files`, options);
  return { files: raw.files.map(normalizeAnnotationFile) };
}

export async function activateAnnotationFile(fileId: string): Promise<{ file: AnnotationFileInfo; types_discovered: number }> {
  const raw = await fetchJson<any>(`${API_BASE}/annotations/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  return { file: normalizeAnnotationFile(raw.file), types_discovered: raw.types_discovered };
}

export async function deactivateAnnotationFile(fileId: string): Promise<{ status: string }> {
  return fetchJson(`${API_BASE}/annotations/deactivate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
}

export async function addAnnotationFile(path: string, label?: string, datasetIds?: string[]): Promise<{ file: AnnotationFileInfo }> {
  const raw = await fetchJson<any>(`${API_BASE}/annotations/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, label, dataset_ids: datasetIds || [] }),
  });
  return { file: normalizeAnnotationFile(raw.file) };
}

export interface BrowseAnnotationEntry {
  name: string;
  path: string;
  size: number;
}

export async function pickAnnotationFile(): Promise<{ success: boolean; path: string | null; message?: string }> {
  return pickWithFallback(() => fetchJson(`${API_BASE}/pick_file?file_type=annotation`), { title: 'Choose an annotation file' });
}

export async function browseAnnotationFiles(dir: string): Promise<{ files: BrowseAnnotationEntry[]; dir: string }> {
  const params = new URLSearchParams({ dir });
  return fetchJson(`${API_BASE}/annotations/browse?${params}`);
}

export async function removeAnnotationFile(fileId: string): Promise<{ status: string }> {
  return fetchJson(`${API_BASE}/annotations/${fileId}`, { method: 'DELETE' });
}

export async function getAnnotationsForRegion(
  chrom: string,
  start: number,
  end: number,
  datasetIds: string | string[],
  fileIds?: string[],
  sampleSeed?: string,
  options?: RequestInit,
): Promise<{
  annotations: Record<string, ReadAnnotation[]>;
  /** Per dataset: files that apply to it, over its own reads. */
  annotations_by_dataset?: Record<string, Record<string, ReadAnnotation[]>>;
  types: AnnotationTypeInfo[];
}> {
  const ids = Array.isArray(datasetIds) ? datasetIds.join(',') : datasetIds;
  const params = new URLSearchParams({ chrom, start: String(start), end: String(end), dataset_ids: ids });
  if (fileIds && fileIds.length > 0) params.set('file_ids', fileIds.join(','));
  if (sampleSeed) params.set('sample_seed', sampleSeed);
  return fetchJson(`${API_BASE}/annotations/region?${params}`, options);
}

export async function filterByAnnotations(
  types: string[],
  mode: string,
  chrom: string,
  start: number,
  end: number,
  datasetIds: string[],
  sampleSeed?: string,
  options?: Pick<RequestInit, 'signal'>,
): Promise<{
  read_ids: string[]; total: number; filtered: number;
  by_dataset?: Record<string, { read_ids: string[]; total: number; filtered: number }>;
}> {
  return fetchJson(`${API_BASE}/annotations/filter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options?.signal,
    body: JSON.stringify({
      annotation_types: types,
      filter_mode: mode,
      chrom,
      start,
      end,
      dataset_ids: datasetIds,
      sample_seed: sampleSeed ?? null,
    }),
  });
}

export async function clusterByAnnotations(
  peakRegions: { start: number; end: number }[],
  types: string[],
  method: string,
  k: number,
  datasetIds: string[],
  chrom: string,
  start: number,
  end: number,
  sampleSeed?: string,
  options?: Pick<RequestInit, 'signal'>,
): Promise<{
  assignments: Record<string, number>; assignments_by_dataset?: Record<string, Record<string, number>>;
  order: number[]; patterns: Record<number, number[]>; sample_seed?: string; annotation_random_state?: number;
}> {
  return fetchJson(`${API_BASE}/annotations/cluster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options?.signal,
    body: JSON.stringify({
      peak_regions: peakRegions,
      annotation_types: types,
      method,
      k,
      dataset_ids: datasetIds,
      chrom,
      start,
      end,
      sample_seed: sampleSeed ?? null,
    }),
  });
}

export async function getAnnotationProfile(
  chrom: string,
  start: number,
  end: number,
  datasetId: string,
  types: string[],
  bins?: number,
  options?: RequestInit,
): Promise<{ profiles: Record<string, number[]> }> {
  const params = new URLSearchParams({
    chrom,
    start: String(start),
    end: String(end),
    dataset_id: datasetId,
    annotation_types: types.join(','),
  });
  if (bins) params.set('bins', String(bins));
  return fetchJson(`${API_BASE}/annotations/profile?${params}`, options);
}

export async function setAnnotationThreshold(typeName: string, threshold: number): Promise<{ status: string }> {
  return fetchJson(`${API_BASE}/annotations/set_threshold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type_name: typeName, threshold }),
  });
}

export async function detectSignalPeaks(
  signal: number[],
  chrom: string,
  start: number,
  end: number,
  label: string,
  opts?: { minDistance?: number; minWidth?: number; thresholdPct?: number; thresholdValue?: number },
): Promise<{ peaks: { start: number; end: number; score: number; threshold?: number }[] }> {
  return fetchJson(`${API_BASE}/detect_peaks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signal,
      chrom,
      start,
      end,
      label,
      min_distance_bp: opts?.minDistance ?? 100,
      min_width_bp: opts?.minWidth ?? 80,
      threshold_percentile: opts?.thresholdPct ?? 50,
      threshold_value: opts?.thresholdValue ?? null,
    }),
  });
}
