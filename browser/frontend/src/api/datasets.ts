import type { Dataset } from '../types';
import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export type { Dataset } from '../types';

export async function getDatasets(): Promise<{ datasets: Dataset[] }> {
  return fetchJson(`${API_BASE}/datasets`);
}

export async function addDataset(pathOrPaths: string | string[], label?: string, options: { liftSourceOf?: string } = {}): Promise<{ success: boolean; dataset?: Dataset; error?: string }> {
  const body = {
    ...(Array.isArray(pathOrPaths) ? { paths: pathOrPaths, label } : { path: pathOrPaths, label }),
    // A live-lift source view's BAM: shown only in its source view.
    ...(options.liftSourceOf ? { lift_source_of: options.liftSourceOf } : {}),
  };

  return fetchJson(`${API_BASE}/datasets/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Load multiple files at once, pairing BigBed layer companions (same sample,
// different layer) into one dataset each instead of one dataset per file.
// Unrelated files and BAMs each load separately. Returns the created datasets.
export async function addDatasetsGrouped(paths: string[], label?: string): Promise<{ success: boolean; datasets?: Dataset[]; error?: string; errors?: string[] }> {
  return fetchJson(`${API_BASE}/datasets/add_grouped`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, label }),
  });
}

export async function removeDataset(datasetId: string): Promise<{ success: boolean; error?: string }> {
  return fetchJson(`${API_BASE}/datasets/${datasetId}`, {
    method: 'DELETE',
  });
}

export async function refreshDatasetCapabilities(datasetId: string): Promise<{ success: boolean; dataset?: Dataset; available_layers?: Record<string, boolean>; error?: string }> {
  return fetchJson(`${API_BASE}/datasets/${encodeURIComponent(datasetId)}/refresh_capabilities`, {
    method: 'POST',
  });
}

export async function setDatasetChemistry(
  datasetId: string,
  chemistry: NonNullable<Dataset['consensus_chemistry']>,
  persist = false,
  platform?: 'pacbio' | 'nanopore' | 'illumina',
): Promise<{ success: boolean; dataset?: Dataset; error?: string }> {
  return fetchJson(`${API_BASE}/datasets/${encodeURIComponent(datasetId)}/chemistry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chemistry, persist, platform }),
  });
}

export async function mergeDatasets(datasetIds: string[], label?: string): Promise<{ success: boolean; dataset?: Dataset; removed_ids?: string[]; error?: string }> {
  return fetchJson(`${API_BASE}/datasets/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset_ids: datasetIds, label: label ?? null }),
  });
}

export async function unmergeDataset(datasetId: string): Promise<{ success: boolean; datasets?: Dataset[]; removed_id?: string; error?: string }> {
  return fetchJson(`${API_BASE}/datasets/unmerge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset_id: datasetId }),
  });
}

/** Datasets whose files have this contig (where a plasmid's reads are). */
export async function getDatasetsWithContig(chrom: string): Promise<{ chrom: string; dataset_ids: string[] }> {
  return fetchJson(`${API_BASE}/datasets/with_contig?chrom=${encodeURIComponent(chrom)}`);
}
