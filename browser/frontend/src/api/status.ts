import type { PrimerConfigResponse } from './primers';
import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export interface StatusResponse {
  datasets: number;
  has_gtf: boolean;
  gene_count: number;
  track_count: number;
  chroms: number;
  primers_enabled?: boolean;
  primer_config?: PrimerConfigResponse;
  initial_position?: { chrom: string; start: number; end: number; gene_name: string } | null;
  config?: { prefetch_multiplier: number };
  has_fasta?: boolean;
  fasta_path?: string | null;
  fasta_error?: string | null;
  current_genome?: string | null;
  has_fire?: boolean;
  public_mode?: boolean;
  /** Datasets that don't fit the loaded genome (then no initial_position is sent). */
  genome_mismatch?: { dataset_ids: string[]; message: string | null } | null;
}

export async function getStatus(initialPosition = true): Promise<StatusResponse> {
  return fetchJson(`${API_BASE}/status${initialPosition ? '' : '?initial_position=false'}`);
}
