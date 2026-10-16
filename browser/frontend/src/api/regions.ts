import { fetchApiResponse, fetchJson } from './sharedFetch';
import { withPanelGenome } from './reference';
import type { RegionCatalog } from '../types/regions';

const API_BASE = '/api';

export interface DetectedRegion {
  chrom: string;
  start: number;
  end: number;
  reads: number;
  depth?: number;
  label: string;
  gene: string | null;
  detail?: string;
}

export interface DetectRegionsResponse {
  success: boolean;
  /** 'amplicon': reads share their ends (one region per amplicon); 'cluster': a few read clusters; 'top': deepest stretches;
   * 'targeted': a targeted run's dense stretches, from its index. */
  kind?: 'amplicon' | 'cluster' | 'top' | 'targeted' | null;
  /** 'scanned'; skipped: 'whole-genome', 'mismatch' (another reference), 'too-many' (the scope holds too many reads). */
  status?: 'scanned' | 'whole-genome' | 'mismatch' | 'too-many';
  /** 'index': found from the BAM index (read counts are estimates); 'reads': by reading the reads. */
  method?: 'index' | 'reads';
  /** What the scan narrowed or estimated (shown with the result). */
  note?: string;
  /** The dataset's mapped reads (its index). */
  reads?: number;
  whole_genome?: boolean;
  /** Decided from a first sample of reads (not amplicons: the dataset was not read whole). */
  precheck?: boolean;
  amplicon_like?: boolean;
  regions: DetectedRegion[];
  /** The reference the coordinates are on (services/region_detect.region_genome_key). */
  genome?: string;
  dataset_id?: string;
  fingerprint?: string | null;
  /** Too much to scan here; `reason` says what to do instead. */
  refused?: boolean;
  /** Refused because the dataset doesn't fit the reference it is on (another assembly). */
  mismatch?: boolean;
  reason?: string;
  error?: string;
  elapsed_ms?: number;
  scanned_reads?: number;
  partial?: boolean;
  small_clusters?: number;
  gene_labels?: boolean;
  scope?: 'dataset' | 'chrom' | 'view';
  cached?: boolean;
}

/** A dataset's amplicons or best-covered regions (whole dataset when small; a chromosome; a view). */
export function detectRegions(datasetId: string, scope: { chrom?: string; start?: number; end?: number; force?: boolean } = {}, init?: RequestInit): Promise<DetectRegionsResponse> {
  const params = new URLSearchParams({ dataset_id: datasetId });
  if (scope.force) params.set('force', 'true');
  if (scope.chrom) params.set('chrom', scope.chrom);
  if (scope.chrom && scope.start != null && scope.end != null) {
    params.set('start', String(Math.max(0, Math.floor(scope.start))));
    params.set('end', String(Math.ceil(scope.end)));
  }
  return fetchJson(`${API_BASE}/reads/regions?${params}`, init);
}

export interface RegionLabelResponse { label: string; gene: string | null; detail?: string; genome?: string }

/** The nearest-gene name for a region on a panel's reference (null: the main genome). */
export function regionLabel(chrom: string, start: number, end: number, panelGenome?: string | null): Promise<RegionLabelResponse> {
  const params = withPanelGenome(new URLSearchParams({ chrom, start: String(Math.max(0, Math.floor(start))), end: String(Math.ceil(end)) }), panelGenome);
  return fetchJson(`${API_BASE}/regions/label?${params}`);
}

/**
 * A reference's saved catalog, and the identity it was read under (a FASTA's
 * contig digest; '' for a registry genome): sent back with writes, so a save
 * still goes to this catalog after another FASTA of the same name is loaded.
 */
export async function getRegionCatalog(genome: string): Promise<{ catalog: RegionCatalog; identity?: string }> {
  const res = await fetchJson<{ success: boolean; catalog: RegionCatalog; identity?: string }>(`${API_BASE}/regions/catalog?${new URLSearchParams({ genome })}`);
  return { catalog: res.catalog, ...(typeof res.identity === 'string' ? { identity: res.identity } : {}) };
}

export type PutCatalogResult =
  | { ok: true; revision: number }
  | { ok: false; conflict: true; catalog: RegionCatalog };

/**
 * Replace a reference's catalog, from the revision it was read at: another
 * window saved since → `conflict` with what is saved now (the caller reapplies
 * its own changes on top and writes again).
 */
export async function putRegionCatalog(genome: string, catalog: RegionCatalog, baseRevision?: number, identity?: string): Promise<PutCatalogResult> {
  const res = await fetchApiResponse(`${API_BASE}/regions/catalog`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ genome, catalog, ...(baseRevision != null ? { base_revision: baseRevision } : {}), ...(identity != null ? { identity } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 && body?.catalog) return { ok: false, conflict: true, catalog: body.catalog };
  if (!res.ok) throw new Error(body?.detail || body?.error || `HTTP ${res.status}`);
  return { ok: true, revision: Number(body.revision) || 0 };
}

export function deleteRegionCatalog(genome: string, identity?: string): Promise<{ success: boolean; deleted?: boolean; revision?: number }> {
  return fetchJson(`${API_BASE}/regions/catalog?${new URLSearchParams({ genome, ...(identity != null ? { identity } : {}) })}`, { method: 'DELETE' });
}
