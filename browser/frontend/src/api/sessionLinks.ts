/**
 * Session links: open a session document (?session=) or a track hub (?hub=)
 * from another page, after the user confirms. Server side:
 * browser/services/session_links.py.
 */
import type { Dataset } from '../types/dataset';
import { fetchApiResponse } from './sharedFetch';

const API = '/api/session-links';

export interface LinkSource {
  kind: 'session' | 'hub' | 'inline';
  host: string | null;
  url: string | null;
}

export interface LinkTrack {
  index: number;
  name: string;
  type: 'bam' | 'bigbed' | 'bigwig' | 'bed' | 'plasmid';
  as: 'reads' | 'annotation' | 'signal' | 'plasmid' | null;
  host: string;
  url: string;
  size: number | null;
  sample: string | null;
  group: string | null;
  color: string | null;
  visible: boolean;
  signed: boolean;
  problem: string | null;
  /** `[user@]host` of an ssh:// file on a cluster (opened only once connected). */
  cluster?: string | null;
}

export interface LinkGenome {
  kind: 'catalog' | 'fasta';
  id?: string;
  /** Display form (no query string: a pre-signed signature never reaches the page). */
  url?: string;
  fai?: string | null;
  label?: string;
  /** The reference URL was pre-signed. */
  signed?: boolean;
  /** Why the reference can't be loaded here (host rules), if it can't. */
  problem?: string | null;
}

export interface LinkLocus {
  text: string;
  chrom?: string;
  start?: number;
  end?: number;
}

export interface LinkPreview {
  success: boolean;
  id: string;
  source: LinkSource;
  expires_in?: number;
  error?: string;
  needs_fetch_confirmation?: boolean;
  reason?: string;
  title?: string | null;
  genome?: LinkGenome | null;
  locus?: LinkLocus | null;
  tracks?: LinkTrack[];
  hosts?: string[];
  warnings?: string[];
  max_tracks?: number;
  public?: boolean;
  hub?: { name?: string; genomes?: string[]; genome?: string; skipped?: string[] } | null;
}

export interface OpenedLinkTrack {
  track_index: number;
  label: string;
  url: string;
  kind: 'bigwig' | 'bigbed';
  render_mode: 'signal' | 'annotation';
  color: string | null;
  group: string | null;
  sample: string | null;
}

export interface OpenedLink {
  success: boolean;
  error?: string;
  message?: string;
  title?: string | null;
  genome?: {
    kind: 'catalog' | 'fasta';
    id?: string;
    label?: string;
    url?: string;
    loaded: boolean;
    has_fasta: boolean;
    inferred_genome?: string | null;
  } | null;
  locus?: LinkLocus | null;
  datasets?: Dataset[];
  tracks?: OpenedLinkTrack[];
  plasmids?: { name: string; label: string }[];
  errors?: string[];
  warnings?: string[];
  source?: LinkSource;
  opened?: number;
}

export interface HeldLink {
  url: string;
  host: string;
  labels: string[];
  expires_at: number | null;
  expired: boolean;
  expiring_soon: boolean;
}

export interface LinkStatus {
  links: HeldLink[];
  expired: HeldLink[];
  expiring_soon: HeldLink[];
}

async function call<T extends { success?: boolean; error?: string }>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchApiResponse(url, init);
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error || payload?.message || payload?.detail || `The server answered ${response.status}`;
    return { ...(payload ?? {}), success: false, error: String(message) } as T;
  }
  return payload as T;
}

export function stageLink(link: { session?: string; hub?: string; genome?: string | null }) {
  return call<{ success: boolean; id?: string; error?: string; source?: LinkSource }>(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...link, origin: 'page' }),
  });
}

export function previewLink(id: string, fetchConfirmed = false) {
  return call<LinkPreview>(`${API}/${encodeURIComponent(id)}${fetchConfirmed ? '?fetch=true' : ''}`);
}

export function openLink(id: string, selected: number[]) {
  return call<OpenedLink>(`${API}/${encodeURIComponent(id)}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selected }),
  });
}

export function discardLink(id: string) {
  return call<{ success: boolean; error?: string }>(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function linkStatus(): Promise<LinkStatus> {
  const response = await fetchApiResponse(`${API}/status`);
  if (!response.ok) return { links: [], expired: [], expiring_soon: [] };
  return response.json();
}
