import type { ModificationOverlay } from '../types';
import { fetchJson } from './sharedFetch';
import { pickWithFallback } from './files';

const API_BASE = '/api';

export type { ModificationOverlay } from '../types';

export interface OverlayMarks {
  [readId: string]: number[];
}

export async function getOverlays(): Promise<{ overlays: ModificationOverlay[] }> {
  return fetchJson(`${API_BASE}/overlays`);
}

export async function addOverlay(path: string, type?: string): Promise<{ success: boolean; overlay?: ModificationOverlay; error?: string }> {
  const body: { path: string; type?: string } = { path };
  if (type) body.type = type;

  return fetchJson(`${API_BASE}/overlays/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function removeOverlay(overlayId: string): Promise<{ success: boolean; error?: string }> {
  return fetchJson(`${API_BASE}/overlays/${overlayId}`, { method: 'DELETE' });
}

export async function pickOverlayFile(type?: string): Promise<{ success: boolean; path: string | null; message?: string }> {
  const params = type ? `file_type=overlay&overlay_type=${type}` : 'file_type=overlay';
  return pickWithFallback(() => fetchJson(`${API_BASE}/pick_file?${params}`), { title: 'Choose a modification file' });
}

export async function getOverlayMarks(
  overlayId: string,
  chrom: string,
  start: number,
  end: number,
  options?: RequestInit
): Promise<{ marks: OverlayMarks }> {
  const params = new URLSearchParams({ chrom, start: start.toString(), end: end.toString() });
  return fetchJson(`${API_BASE}/overlays/${overlayId}/marks?${params}`, options);
}
