/**
 * Meta-locus server API (browser/routers/meta_locus.py): a BED file's reads pooled into one virtual locus, the
 * contig `meta:<pool id>` at [0, width), shown as -flank..+flank. The ordinary read routes serve that contig like any
 * other; these calls build the pool, set its working set (the view) and grow it (refill, find more).
 */
import { fetchJson } from '../../api/sharedFetch';

export interface MetaLocusProgress {
  fraction?: number;
  eta_s?: number | null;
  sites_done?: number;
  sites_total?: number;
  bytes_done?: number;
  bytes_total?: number;
  entries?: number;
}

export interface MetaLocusView {
  chrom: string;
  width: number;
  axis_offset: number;
  seed: number;
  count: number;
  cursor: Record<string, number>;
  pool_observations: Record<string, number>;
  pool_total: number;
  extra_entries: Array<[string, string, number]>;
  extra_count: number;
  enriched: boolean;
  generation: number;
}

export interface MetaLocusStatus {
  success?: boolean;
  pool_id: string;
  name: string;
  status: 'building' | 'ready' | 'cancelled' | 'error';
  error?: string | null;
  progress?: MetaLocusProgress;
  sites?: number;
  flank_bp?: number;
  chrom?: string;
  width?: number;
  axis_offset?: number;
  label?: string;
  spec?: { anchor?: string; flank_bp?: number; policy?: string; [key: string]: unknown };
  view?: MetaLocusView | null;
}

export interface MetaLocusSpec {
  bed_path: string;
  /** A BED chosen in the browser: its text (a file input gives contents, not a path). The server keeps a copy and
   * answers with its path (status.spec.bed_path), which the URL and sessions then use. */
  bed_text?: string;
  bed_name?: string;
  name?: string;
  anchor: 'centre' | 'start' | 'end';
  flank_bp: number;
  dataset_ids?: string[];
  policy?: string;
  count_unit?: string;
}

export interface MetaLocusViewRequest {
  seed?: number;
  count?: number;
  more?: number;
  resample?: boolean;
  clear_extra?: boolean;
  extra_entries?: Array<[string, string, number]>;
}

export interface ClusterEstimate {
  cluster: number | string;
  in_view?: number;
  added?: number;
  found: number;
  scanned: number;
  freq: number;
  wilson: [number, number];
}

export interface RefillResult {
  success?: boolean;
  per_cluster: ClusterEstimate[];
  scanned: number;
  unit?: string;
  enriched?: boolean;
  view?: MetaLocusView;
  /** Clusters of the reads added (server extension; merged into the panels' assignments when present). */
  assignments?: Record<string, Record<string, number>>;
}

export interface FindMoreResult {
  success?: boolean;
  found: number;
  scanned: number;
  unassignable?: number;
  freq: number;
  wilson: [number, number];
  added?: number;
  unit?: string;
  enriched?: boolean;
  view?: MetaLocusView;
}

const BASE = '/api/meta_locus/pools';
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const startMetaLocusPool = (spec: MetaLocusSpec) => fetchJson<MetaLocusStatus>(BASE, json(spec));
/** Whether the server already has the pool of this spec built (the dialog's "cached: opens instantly"). */
export const probeMetaLocusPool = (spec: Omit<MetaLocusSpec, 'name'>) =>
  fetchJson<{ success: boolean; cached: boolean; pool_id?: string; sites?: number }>(`${BASE}/probe`, json(spec));
export const metaLocusStatus = (poolId: string) => fetchJson<MetaLocusStatus>(`${BASE}/${encodeURIComponent(poolId)}`);
export const cancelMetaLocusPool = (poolId: string) => fetchJson<MetaLocusStatus>(`${BASE}/${encodeURIComponent(poolId)}/cancel`, json({}));
export const setMetaLocusView = (poolId: string, request: MetaLocusViewRequest) =>
  fetchJson<MetaLocusView>(`${BASE}/${encodeURIComponent(poolId)}/view`, json(request));
export const refillMetaLocus = (poolId: string, body: { assignments: Record<string, Record<string, number>>; peak_regions?: Array<[number, number]>; target_per_cluster?: number; max_scan?: number }) =>
  fetchJson<RefillResult>(`${BASE}/${encodeURIComponent(poolId)}/refill`, json(body));
export const findMoreMetaLocus = (poolId: string, body: { read_ids: Record<string, string[]>; k?: number; max_scan?: number; peak_regions?: Array<[number, number]> }) =>
  fetchJson<FindMoreResult>(`${BASE}/${encodeURIComponent(poolId)}/find_more`, json(body));
