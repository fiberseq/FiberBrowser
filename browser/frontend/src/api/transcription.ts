import type { ReadStateInfo, TranscriptionStateFilters } from '../types';
import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export type { ReadStateInfo, TranscriptionStateFilters } from '../types';

export interface TranscriptionStateFilterResult {
  filtered_ids: string[];
  read_states: Record<string, ReadStateInfo>;
  summary: {
    total: number;
    overlapping_genes: number;
    pause: number;
    pic: number;
    elongating_gte_1: number;
    elongating_gte_3: number;
    elongating_gte_5: number;
    elongating_dist?: { '1': number; '2': number; '3': number; '4+': number };
    total_matching: number;
  };
}

export async function filterByTranscriptionState(
  chrom: string,
  start: number,
  end: number,
  spanning: boolean,
  datasetIds: string[],
  geneIds: string[],
  filters: TranscriptionStateFilters,
  sampleSeed?: string,
  options?: { signal?: AbortSignal; genome?: string | null },
): Promise<{ results: Record<string, TranscriptionStateFilterResult> }> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString()
  });
  // A region on another assembly: its genes are that reference's (services/panel_genomes.py).
  if (options?.genome) params.set('panel_genome', options.genome);
  return fetchJson(`${API_BASE}/filter_by_transcription_state?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataset_ids: datasetIds,
      gene_ids: geneIds,
      filters,
      sample_seed: sampleSeed ?? null,
    }),
    signal: options?.signal,
  });
}

export interface Pol2COMResult {
  binary_matrix: number[][];
  smoothed_matrix: number[][];
  read_ids: string[];
  com_values: number[];
  n_reads: number;
  n_bins: number;
  gene_body_size: number;
  viewport_size?: number;
}

export async function fetchPol2COM(
  chrom: string, start: number, end: number, spanning: boolean,
  datasetIds: string[], geneIds: string[],
  fpSizeMin?: number, fpSizeMax?: number, nBins?: number,
  smoothingSigma?: number,
  sampleSeed?: string,
): Promise<{ results: Record<string, Pol2COMResult> }> {
  const params = new URLSearchParams({
    chrom,
    start: start.toString(),
    end: end.toString(),
    spanning: spanning.toString(),
  });
  const body: Record<string, unknown> = {
    dataset_ids: datasetIds,
    gene_ids: geneIds,
  };
  if (fpSizeMin !== undefined) body.fp_size_min = fpSizeMin;
  if (fpSizeMax !== undefined) body.fp_size_max = fpSizeMax;
  if (nBins !== undefined) body.n_bins = nBins;
  if (smoothingSigma !== undefined) body.smoothing_sigma = smoothingSigma;
  body.sample_seed = sampleSeed ?? null;
  return fetchJson(`${API_BASE}/pol2_com?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
