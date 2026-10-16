import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export interface CatalogGroup {
  name: string;
  description: string;
  dataset_count: number;
  loaded: boolean;
  merge: boolean;
  dataset_labels: string[];
}

export interface CatalogTrack {
  label: string;
  loaded: boolean;
}

export interface Catalog {
  name: string;
  genome: string | null;
  groups: CatalogGroup[];
  tracks: CatalogTrack[];
}

export async function getCatalog(): Promise<{ catalog: Catalog | null }> {
  return fetchJson(`${API_BASE}/catalog`);
}

export async function catalogLoad(groupIndex: number): Promise<{ success: boolean; message?: string; dataset_ids?: string[] }> {
  return fetchJson(`${API_BASE}/catalog/load?group_index=${groupIndex}`, { method: 'POST' });
}

export async function catalogUnload(groupIndex: number): Promise<{ success: boolean; message?: string; removed_ids?: string[] }> {
  return fetchJson(`${API_BASE}/catalog/unload?group_index=${groupIndex}`, { method: 'POST' });
}

export async function catalogTrackLoad(trackIndex: number): Promise<{ success: boolean; message?: string }> {
  return fetchJson(`${API_BASE}/catalog/tracks/load?track_index=${trackIndex}`, { method: 'POST' });
}

export async function catalogTrackUnload(trackIndex: number): Promise<{ success: boolean; message?: string }> {
  return fetchJson(`${API_BASE}/catalog/tracks/unload?track_index=${trackIndex}`, { method: 'POST' });
}

/** What to tell the user about a catalog group load: null when every file opened. */
export function catalogLoadFailure(res: { success: boolean; message?: string } | null | undefined): string | null {
  if (!res) return null;
  const message = (res.message || '').trim();
  if (!res.success) return message || 'Could not load the catalog group';
  // "Loaded 1 dataset(s) (1 failed: <label>: <reason>)"
  return /\(\d+ failed: /.test(message) ? message : null;
}
