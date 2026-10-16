import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export interface UcscTrack {
  id: string;
  label: string;
  url: string;
  type?: string;
  category?: string;
  description?: string;
  loadable?: boolean;
  loaded?: boolean;
  render_mode?: string;
  track_format?: string;
}

export interface UcscBrowseResponse {
  groups: Record<string, UcscTrack[]>;
  total: number;
  loadable_count: number;
  genome: string;
  error?: string;
}

export async function getUcscCurated(genome: string, options?: RequestInit): Promise<{ tracks: UcscTrack[]; genome: string }> {
  const params = new URLSearchParams({ genome });
  return fetchJson(`${API_BASE}/ucsc/curated?${params}`, options);
}

export async function searchUcscTracks(genome: string, query: string): Promise<{ tracks: UcscTrack[]; genome: string; total?: number; error?: string }> {
  const params = new URLSearchParams({ genome, query });
  return fetchJson(`${API_BASE}/ucsc/search?${params}`);
}

export async function browseUcscTracks(genome: string, options?: RequestInit): Promise<UcscBrowseResponse> {
  const params = new URLSearchParams({ genome });
  return fetchJson(`${API_BASE}/ucsc/browse?${params}`, options);
}

export interface EncodeFacet {
  key: string;
  count: number;
}

export interface EncodeFacetsResponse {
  supported: boolean;
  genome: string;
  assays?: EncodeFacet[];
  targets?: EncodeFacet[];
  biosamples?: EncodeFacet[];
  error?: string;
}

export interface EncodeTrack {
  url: string;
  label: string;
  output_type: string;
  dataset: string;
  file_size: number;
}

export interface EncodeSearchResponse {
  supported: boolean;
  genome: string;
  tracks: EncodeTrack[];
  total?: number;
  error?: string;
}

export async function getEncodeFacets(genome: string, options?: RequestInit): Promise<EncodeFacetsResponse> {
  const params = new URLSearchParams({ genome });
  return fetchJson(`${API_BASE}/encode/facets?${params}`, options);
}

export async function searchEncode(
  genome: string,
  assay?: string,
  target?: string,
  biosample?: string,
  query?: string,
  limit: number = 25,
  options?: RequestInit,
): Promise<EncodeSearchResponse> {
  const params = new URLSearchParams({ genome, limit: limit.toString() });
  if (assay) params.set('assay', assay);
  if (target) params.set('target', target);
  if (biosample) params.set('biosample', biosample);
  if (query) params.set('query', query);
  return fetchJson(`${API_BASE}/encode/search?${params}`, options);
}

export interface ChipAtlasFacet {
  key: string;
  count: number;
}

export interface ChipAtlasFacetsResponse {
  supported: boolean;
  loading: boolean;
  genome: string;
  total_experiments?: number;
  antigen_classes?: ChipAtlasFacet[];
  cell_type_classes?: ChipAtlasFacet[];
}

export interface ChipAtlasTrack {
  url: string;
  label: string;
  id: string;
  antigen_class: string;
  antigen: string;
  cell_type_class: string;
  cell_type: string;
}

export interface ChipAtlasSearchResponse {
  supported: boolean;
  genome: string;
  tracks: ChipAtlasTrack[];
  total?: number;
}

export interface ChipAtlasStatus {
  status: string;
  message: string;
  loading: boolean;
  genomes_loaded: string[];
}

export async function getChipAtlasStatus(): Promise<ChipAtlasStatus> {
  return fetchJson(`${API_BASE}/chipatlas/status`);
}

export async function getChipAtlasFacets(genome: string, options?: RequestInit): Promise<ChipAtlasFacetsResponse> {
  const params = new URLSearchParams({ genome });
  return fetchJson(`${API_BASE}/chipatlas/facets?${params}`, options);
}

export async function searchChipAtlas(
  genome: string,
  antigenClass?: string,
  antigen?: string,
  cellTypeClass?: string,
  cellType?: string,
  limit: number = 25,
  options?: RequestInit,
): Promise<ChipAtlasSearchResponse> {
  const params = new URLSearchParams({ genome, limit: limit.toString() });
  if (antigenClass) params.set('antigen_class', antigenClass);
  if (antigen) params.set('antigen', antigen);
  if (cellTypeClass) params.set('cell_type_class', cellTypeClass);
  if (cellType) params.set('cell_type', cellType);
  return fetchJson(`${API_BASE}/chipatlas/search?${params}`, options);
}
