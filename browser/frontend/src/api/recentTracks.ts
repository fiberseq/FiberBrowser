import { fetchJson } from './sharedFetch';
import type { CatalogEntry } from '../types/dataset';
import { isPublicServerPage } from '../utils/publicServerFlag';
import { isSandboxPage } from '../utils/sandbox';

/**
 * Whether this tab has Recent tracks. They are the host's (file paths and URLs
 * used in any session), so a tour sandbox tab or a public server has none: the
 * server refuses the route there (403), and the UI doesn't ask.
 */
export function recentTracksOffered(publicMode: boolean): boolean {
  return !publicMode && !isSandboxPage() && !isPublicServerPage();
}

/** A track source used before, kept on the server (location only, no data). */
export interface RecentTrack {
  key: string;
  source: 'online' | 'local';
  kind: CatalogEntry['kind'];
  label: string;
  path?: string;
  url?: string;
  catalogId?: string;
  filterNames?: string[];
  meta?: CatalogEntry['meta'];
  lastUsed?: number;
  /** False when a local file is no longer at its saved path. */
  available: boolean;
}

export async function getRecentTracks(options?: RequestInit): Promise<RecentTrack[]> {
  const res = await fetchJson<{ tracks?: RecentTrack[] }>('/api/tracks/recent', options);
  return res.tracks ?? [];
}

export async function rememberRecentTrack(entry: Omit<RecentTrack, 'key' | 'available' | 'lastUsed'>): Promise<void> {
  await fetchJson('/api/tracks/recent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

export async function forgetRecentTrack(key: string): Promise<void> {
  await fetchJson(`/api/tracks/recent?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
}
