/** Live-lift endpoints (routers/lift.py); every one answers 404 while the server's flag is off. */
import type { Dataset } from '../../types';
import { fetchJson } from '../../api/sharedFetch';
import { getCoverage, type CoverageResponse } from '../../api/coverage';
import type { DifferencesResponse, DifferenceReadsResponse } from './differenceTypes';

export interface DifferencesQuery {
  datasetId: string; liftKey: string; chrom: string; start: number; end: number;
  liftHap?: string | null; minBp?: number; nativeDatasetId?: string; detailBp?: number;
}
export function getDifferences(q: DifferencesQuery, signal?: AbortSignal): Promise<DifferencesResponse> {
  const p = new URLSearchParams({ dataset_id: q.datasetId, lift_key: q.liftKey, chrom: q.chrom,
    start: String(Math.max(0, Math.floor(q.start))), end: String(Math.ceil(q.end)), min_bp: String(q.minBp ?? 0) });
  if (q.liftHap) p.set('lift_hap', q.liftHap);
  if (q.nativeDatasetId) p.set('native_dataset_id', q.nativeDatasetId);
  if (q.detailBp) p.set('detail_bp', String(q.detailBp));
  return fetchJson(`/api/lift/differences?${p}`, { signal });
}
export function getDifferenceReads(q: Omit<DifferencesQuery, 'start'> & { pos: number; itemId?: string; includeSequence?: boolean }, signal?: AbortSignal): Promise<DifferenceReadsResponse> {
  const p = new URLSearchParams({ dataset_id: q.datasetId, lift_key: q.liftKey, chrom: q.chrom, pos: String(q.pos), end: String(q.end) });
  if (q.liftHap) p.set('lift_hap', q.liftHap);
  if (q.itemId) p.set('item_id', q.itemId);
  if (q.includeSequence) p.set('include_sequence', 'true');
  return fetchJson(`/api/lift/difference_reads?${p}`, { signal });
}

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
  cohort_alternatives?: 'exclude' | 'include';
  cohort_supplementaries?: 'all_records' | 'follow_display' | 'primary_only';
  fold_molecule?: boolean;
  fold_orientation_rows?: boolean;
  joint_dedup?: 'off' | 'by_molecule';
  molecule_groups?: [string, string][];
  primary_lookup?: boolean;
  pooled_depth?: 'raw' | 'correspondence_normalised';
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


export function updateMoleculeProvenance(datasetId: string, molecule_groups: [string, string][], joint_dedup: 'off' | 'by_molecule'): Promise<LiftAddResult> {
  return fetchJson(`/api/lift/provenance/${encodeURIComponent(datasetId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ molecule_groups, joint_dedup }),
  });
}
