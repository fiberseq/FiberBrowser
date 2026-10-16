import { fetchJson } from '../../api/sharedFetch';
import type { Dataset } from '../../types/dataset';
import type { AltAlleleInfo, AltAlleleLayout } from './types';
import type { PanelGenomeInfo } from '../../api/panelGenomes';

/** POST /api/alt_allele/open (services/alt_allele.py). */
export interface AltAlleleRequest {
  dataset_id: string;
  chrom: string;
  ref?: number;
  length?: number;
  pos?: number;
  flank?: number;
  include_reference?: boolean;
  max_carriers?: number;
  include_duplicates?: boolean;
}

export interface AltAlleleResponse {
  success: boolean;
  error?: string;
  dataset?: Dataset;
  genome?: PanelGenomeInfo;
  genome_key?: string;
  locus?: { chrom: string; start: number; end: number };
  layout?: AltAlleleLayout;
  alt_allele?: AltAlleleInfo;
  /** Built by this call (else its files were reused). */
  built?: boolean;
}

export async function openAltAllele(request: AltAlleleRequest): Promise<AltAlleleResponse> {
  return fetchJson<AltAlleleResponse>('/api/alt_allele/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export interface InsertionClusterSummary {
  t: 'I';
  ref: number;
  len: number;
  carriers: number;
  clip_support?: number;
}

/** GET /api/insertions/clusters: the insertions (>= minLen) in a region of a BAM dataset. */
export async function insertionClustersInView(datasetId: string, chrom: string, start: number, end: number, minLen: number): Promise<{ success: boolean; error?: string; clusters: InsertionClusterSummary[] }> {
  const params = new URLSearchParams({
    chrom, start: String(Math.max(0, Math.floor(start))), end: String(Math.ceil(end)), dataset_id: datasetId, min_len: String(minLen),
  });
  return fetchJson(`/api/insertions/clusters?${params}`);
}
