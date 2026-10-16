import type { LayerQualityFilter } from '../types';
import { fetchJson } from './sharedFetch';

export interface QualityFilterImpact {
  layer: string;
  quality_name: string;
  min_value: number;
  /** Calls in view the filter applies to, and how many it keeps. */
  total: number;
  kept: number;
  layers: string[];
}

export interface QualityImpactResponse {
  success: boolean;
  filters: QualityFilterImpact[];
  /** Quality dimensions each layer actually carries in view. */
  available: Record<string, string[]>;
}

/** `revision`: the data's revision (a refresh, a new footprint-class result), part of the server's cache key. */
export function getQualityImpact(
  chrom: string, start: number, end: number, filters: LayerQualityFilter[], datasetIds: string[], signal?: AbortSignal,
  revision?: string,
): Promise<QualityImpactResponse> {
  return fetchJson('/api/quality/impact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chrom, start, end, filters, dataset_ids: datasetIds, ...(revision ? { revision } : {}) }),
    signal,
  });
}
