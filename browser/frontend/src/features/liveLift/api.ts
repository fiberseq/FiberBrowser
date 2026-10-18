/** Live-lift endpoints (routers/lift.py); every one answers 404 while the server's flag is off. */
import type { Dataset } from '../../types';
import { fetchJson } from '../../api/sharedFetch';
import { getCoverage, type CoverageResponse } from '../../api/coverage';

export interface LiftMapInfo {
  manifest: string;
  haplotypes: Array<{ key: string; label: string }>;
  targets: string[];
  sources: number;
  chains: number;
  success?: boolean;
  error?: string;
}

/** The advanced settings shown in the browser (services/lift/live_lift.LiftSettings; all in lift_key). */
export interface LiftSettings {
  haplotype_mode?: 'split' | 'pooled';
  g_split?: number;
  window_merge?: number;
  rejoin_bp?: number;
  alternatives?: boolean;
  supplementary_display?: 'own_rows' | 'hide';
  coverage_hatching?: boolean;
  [key: string]: unknown;
}

export interface LiftAddResult {
  success: boolean;
  dataset?: Dataset;
  error?: string;
  warnings?: string[];
}

export async function liveLiftEnabled(): Promise<boolean> {
  try {
    const r = await fetch('/api/lift/enabled');
    if (!r.ok) return false;
    return Boolean((await r.json()).enabled);
  } catch {
    return false;
  }
}

export function inspectLiftMap(manifest: string): Promise<LiftMapInfo> {
  return fetchJson(`/api/lift/inspect?manifest=${encodeURIComponent(manifest)}`);
}

export function addLiveLiftDataset(body: {
  paths: string[]; manifest: string; haplotypes: string[]; settings?: LiftSettings; label?: string;
}): Promise<LiftAddResult> {
  return fetchJson('/api/lift/datasets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

export function updateLiftSettings(datasetId: string, settings: LiftSettings): Promise<LiftAddResult> {
  return fetchJson(`/api/lift/datasets/${encodeURIComponent(datasetId)}/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }),
  });
}

/** The map-only endpoint deliberately returns no depth/coverage; it need not open a read file. */
export type LiftCorrespondence = Omit<CoverageResponse, 'coverage'> & { coverage: number[] | null };

export function liftCoverage(params: { chrom: string; start: number; end: number; bins: number; datasetId: string;
  liftHap?: string | null; liftKey?: string; refreshGeneration?: number }, options?: RequestInit): Promise<LiftCorrespondence> {
  return getCoverage(params.chrom, params.start, params.end, params.bins, params.datasetId, options, false,
    { liftHap: params.liftHap, liftKey: params.liftKey, refreshGeneration: params.refreshGeneration, correspondenceOnly: true });
}
