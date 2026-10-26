/** The scan routes (browser/routers/scan.py): open fiberhmm-scan directories, their hits, live scans. */
import { fetchJson } from '../../api/sharedFetch';
import type { FeatureSet, FeatureTypeDecl, GroupDecl, HitValue, Provenance, Frame } from './types';

export interface ScanSetInfo extends Omit<FeatureSet, 'type' | 'groups'> {
  type: FeatureTypeDecl & { columns?: string[] };
  groups: Array<GroupDecl & { scanDataset?: string; binding?: 'bound' | 'stale' | 'unbound' }>;
  provenance: Provenance & { experimental?: boolean };
}

export interface ScanInfo {
  scanId: string;
  path: string;
  label: string;
  source: 'opened' | 'cache';
  manifestDigest: string;
  fiberhmm?: string;
  frame?: Frame | { kind: string; [k: string]: unknown };
  referenceNote?: string | null;
  units: { mode: 'grid' | 'bed'; unit_bp?: number; stride_bp?: number; contigs?: string[] | null; count?: number };
  modules: Record<string, { version: string; settingsHash: string; experimental: boolean }>;
  annotate: boolean;
  annotated: Array<{ datasetId: string; path: string; source?: string; records?: number; scope?: string }>;
  datasets: Array<{ scanDataset: string; ordinal: number; chemistry?: string | null; files: string[];
    dataset?: string | null; status?: 'bound' | 'stale' | 'unbound'; via?: string | null; note?: string }>;
  status?: { units_total?: number; units_done?: number; units_failed?: string[] };
  sets: ScanSetInfo[];
}

export interface ScanHit {
  hitId: string; typeId: string; chrom: string; start: number; end: number; anchor: number;
  strand?: '+' | '-' | null; label: string; score: number | null; unitId?: string; parentId?: string | null;
  flags: string[]; zeroWidth: boolean;
  /** Per column ('all' and each scan dataset id): the type's score roles. */
  columns: Record<string, { prevalence?: HitValue; strength?: HitValue }>;
  raw: Record<string, Record<string, HitValue>>;
  groupKinds: Record<string, string>;
  module: Record<string, string | number>;
}

export interface ScanPlanSummary {
  scope: string; where: string; modules: string[];
  datasets: Array<{ datasetId: string; label: string; scanDataset: string; chemistry?: string | null }>;
  units: number; workers: number;
  coverage: Record<string, { total: number; precomputed: number; cached: number; toCompute: number; precomputedBy: string[] }>;
  settingsHashes: Record<string, string>; experimental: string[];
  cli: { args: string[]; text: string; parameters: Record<string, unknown> | null; datasets?: Array<Record<string, unknown>> | null; notes: string[] };
  note?: string | null;
}

export interface ScanJob {
  job_id: string; status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'complete' | 'error';
  stage?: string; message?: string; created_at: number; finished_at?: number; error?: string;
  where: string; modules: string[]; scans: string[]; computed_units: number;
  coverage: Record<string, { total: number; precomputed: number; cached: number; toCompute: number }>;
  progress?: { completed?: number; total?: number; fraction?: number | null; stage?: string } | null;
  cli?: ScanPlanSummary['cli'];
}

export interface ScanRequest {
  datasets: string[];
  scope: 'view' | 'bed' | 'genes' | 'regions';
  chrom?: string; start?: number; end?: number;
  bed?: string; genes?: string[]; flank?: number; regions?: [string, number, number][];
  modules: string[];
  parameters?: Record<string, unknown>;
  caps?: { max_discovery_molecules?: number; max_quantification_molecules?: number; sample_seed?: number };
  include_duplicates?: boolean;
  workers?: number;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const scanAvailable = () => fetchJson<{ available: boolean; reason?: string; fiberhmm?: string;
  modules: Array<{ name: string; version: string; experimental: boolean; types: string[] }> }>('/api/scan/available');
export const openScan = (path: string) => fetchJson<ScanInfo>('/api/scan/open', json({ path }));
export const listScans = () => fetchJson<{ scans: ScanInfo[] }>('/api/scan/list');
export const closeScan = (scanId: string) => fetchJson<{ closed: boolean }>(`/api/scan/${encodeURIComponent(scanId)}`, { method: 'DELETE' });
export function scanHits(scanId: string, module: string, chrom: string, start: number, end: number, type?: string, signal?: AbortSignal) {
  const q = new URLSearchParams({ module, chrom, start: String(Math.max(0, Math.floor(start))), end: String(Math.ceil(end)) });
  if (type) q.set('type', type);
  return fetchJson<{ hits: ScanHit[]; truncated: boolean }>(`/api/scan/${encodeURIComponent(scanId)}/hits?${q}`, signal ? { signal } : undefined);
}
export const planScan = (request: ScanRequest) => fetchJson<ScanPlanSummary>('/api/scan/plan', json(request));
export const submitScan = (request: ScanRequest) => fetchJson<ScanJob>('/api/scan/jobs', json(request));
export const getScanJob = (jobId: string) => fetchJson<ScanJob>(`/api/scan/jobs/${encodeURIComponent(jobId)}`);
export const cancelScanJob = (jobId: string) => fetchJson<ScanJob>(`/api/scan/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
