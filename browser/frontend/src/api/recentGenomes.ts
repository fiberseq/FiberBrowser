import { fetchJson } from './sharedFetch';
import { confirmLargeDownload, type LargeDownloadInfo } from '../utils/downloadSize';

/** A pinned or recent genome (services/recent_genomes.py). */
export interface RecentGenome {
  key: string;
  kind: 'fasta' | 'registry';
  genome_id: string | null;
  assembly: string | null;
  name: string | null;
  fasta: string | null;
  fasta_name: string | null;
  gtf: string | null;
  gtf_name: string | null;
  gtf_exists: boolean;
  /** The FASTA is there (a registry genome: always; `cached` says whether it is downloaded). */
  exists: boolean;
  cached: boolean | null;
  /** Epoch seconds. */
  last_used: number | null;
  pinned: boolean;
}

export interface RecentGenomesListing {
  pinned: RecentGenome[];
  recent: RecentGenome[];
  max: number;
}

/** The genome-check offer: a pinned or recent genome that fits the data clearly better than the loaded one. */
export interface RecentGenomeMatch {
  key: string;
  label: string;
  pinned: boolean;
  fasta_name: string | null;
  gtf_name: string | null;
  matched: number;
  total: number;
  current_matched: number;
  /** "all 8 contigs match", "7 of 8 contigs match". */
  fit: string;
}

export interface RecentGenomeOpenResult {
  success: boolean;
  error?: string;
  missing?: boolean;
  already_loaded?: boolean;
  fasta_loaded?: boolean;
  fasta_path?: string | null;
  gtf_loaded?: boolean;
  gtf_error?: string;
  fasta_error?: string;
  genome_id?: string | null;
  gene_count?: number;
  needs_confirmation?: boolean;
  download?: LargeDownloadInfo;
  name?: string;
}

const BASE = '/api/recent_genomes';
const post = <T,>(path: string, body: unknown = {}) =>
  fetchJson<T>(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const getRecentGenomes = () => fetchJson<RecentGenomesListing>(BASE);
export const removeRecentGenome = (key: string) => post<RecentGenomesListing>('/remove', { key });
export const clearRecentGenomes = () => post<RecentGenomesListing>('/clear');
export const pinRecentGenome = (key: string, pinned: boolean) => post<RecentGenomesListing>('/pin', { key, pinned });
export const reorderPinnedGenomes = (keys: string[]) => post<RecentGenomesListing>('/reorder', { keys });

/** Load it in one step (a registry genome's download over the warning size asks first, as a genome load does). */
export async function openRecentGenome(key: string): Promise<RecentGenomeOpenResult> {
  const res = await post<RecentGenomeOpenResult>('/open', { key });
  if (!res?.needs_confirmation || !res.download) return res;
  if (confirmLargeDownload(res.name || key, res.download)) return post<RecentGenomeOpenResult>('/open', { key, confirm_large: true });
  return { ...res, success: false, error: 'Not downloaded: over the download warning size' };
}
