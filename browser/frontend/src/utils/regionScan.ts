/**
 * Scanning an open dataset for its regions (services/region_detect.py) and filing the result: the
 * Regions panel's per-dataset status lines and the automatic scan of each opened BAM share this.
 *
 * Every scan leaves its dataset a status (stores/regionCatalogStore.DatasetScan): "scanned: N regions",
 * or skipped and why (whole-genome, wrong reference, too many reads), with what was narrowed or
 * estimated. Results are filed under the dataset's name and replace its earlier scans.
 */
import { detectRegions, type DetectRegionsResponse } from '../api/regions';
import { useRegionCatalogStore, type DatasetScan } from '../stores/regionCatalogStore';
import type { Dataset } from '../types';
import { formatCoordinates } from './coordinates';

export type RegionScanScope = 'dataset' | 'chrom' | 'view';

export interface RegionScanRequest {
  scope: RegionScanScope;
  view?: { chrom: string; start: number; end: number };
  /** "Scan anyway (slow)": read the reads whatever the scope's size. */
  force?: boolean;
}

/** The dataset's own detected categories: the whole dataset's regions, by kind. */
const AUTO_KINDS = new Set(['amplicon', 'cluster', 'targeted']);

/** One line: what the scan found, or why the dataset was skipped. */
export function scanStatusText(scan: DatasetScan | undefined): string {
  if (!scan) return 'not scanned yet';
  if (scan.state === 'running') return 'scanning…';
  if (scan.state === 'error') return `error: ${scan.message ?? 'the scan failed'}`;
  if (scan.state === 'refused') {
    if (scan.status === 'whole-genome') return `skipped: whole-genome${scan.reads != null ? ` (${scan.reads.toLocaleString()} reads)` : ''}`;
    if (scan.status === 'mismatch') return 'skipped: wrong reference';
    return `skipped: ${scan.message ?? 'too many reads to scan here'}`;
  }
  const n = scan.regions ?? 0;
  const where = scan.scope === 'view' ? ' in the view' : scan.scope === 'chrom' ? ` on ${scan.scopeLabel ?? 'the chromosome'}` : '';
  return `scanned: ${n} region${n === 1 ? '' : 's'}${where}${scan.method === 'index' ? ' (from the BAM index)' : ''}`;
}

/** The status a scan result leaves its dataset. */
export function scanFromResponse(res: DetectRegionsResponse, request: RegionScanRequest): DatasetScan {
  const scopeLabel = request.scope === 'chrom' ? request.view?.chrom
    : request.scope === 'view' && request.view ? formatCoordinates(request.view.chrom, request.view.start, request.view.end) : undefined;
  const common = { genome: res.genome, scope: request.scope, ...(scopeLabel ? { scopeLabel } : {}),
    ...(res.reads != null ? { reads: res.reads } : {}), ...(res.note ? { note: res.note } : {}) };
  if (!res.success) {
    return { ...common, state: res.refused ? 'refused' : 'error', status: res.status, message: res.reason || res.error };
  }
  return { ...common, state: 'done', kind: res.kind, method: res.method, elapsedMs: res.elapsed_ms, regions: res.regions.length,
    ...(res.reason && !res.regions.length ? { message: res.reason } : {}) };
}

/** File a scan's regions: a whole-dataset scan as the dataset's own category, others as its "Top regions". */
export async function fileRegionScan(res: DetectRegionsResponse, dataset: Dataset, request: RegionScanRequest): Promise<void> {
  if (!res.success || !res.genome) return;
  const store = useRegionCatalogStore.getState();
  if (!res.regions.length) {
    // Found nothing this time: the dataset's earlier regions of that kind go too (the latest scan is what is listed).
    if (res.fingerprint) await store.dropDetected(res.genome, res.fingerprint, request.scope === 'dataset' ? ['auto', 'top'] : ['top']);
    return;
  }
  await store.ensureLoaded(res.genome);
  const label = dataset.label || dataset.id;
  const scan = scanFromResponse(res, request);
  if (request.scope === 'dataset' && res.kind && AUTO_KINDS.has(res.kind)) {
    useRegionCatalogStore.getState().applyDetection(res, label, 'auto');
  } else {
    useRegionCatalogStore.getState().applyDetection(res, label, 'top', request.scope === 'dataset' ? undefined : scan.scopeLabel);
  }
}

/** Scan one dataset (the status line shows it running, then what it found or why not). */
/** The latest scan asked for each dataset: an older answer arriving later is dropped (never over a newer one). */
const latestScan = new Map<string, number>();
let scanCounter = 0;
/** Mark a scan of a dataset as the latest (the automatic scan on opening uses it too); returns a check. */
export function beginRegionScan(datasetId: string): () => boolean {
  const n = ++scanCounter;
  latestScan.set(datasetId, n);
  return () => latestScan.get(datasetId) === n;
}

export async function scanDatasetRegions(dataset: Dataset, request: RegionScanRequest): Promise<DetectRegionsResponse | null> {
  const store = useRegionCatalogStore.getState();
  const current = beginRegionScan(dataset.id);
  store.setScan(dataset.id, { state: 'running', scope: request.scope });
  try {
    const scope = request.scope === 'dataset' ? {} : request.scope === 'chrom' ? { chrom: request.view?.chrom } : { ...request.view };
    const res = await detectRegions(dataset.id, { ...scope, ...(request.force ? { force: true } : {}) });
    if (!current()) return null;
    if (res.fingerprint) useRegionCatalogStore.getState().setFingerprint(dataset.id, res.fingerprint);
    await fileRegionScan(res, dataset, request);
    if (!current()) return null;
    useRegionCatalogStore.getState().setScan(dataset.id, scanFromResponse(res, request));
    return res;
  } catch (err) {
    if (current()) useRegionCatalogStore.getState().setScan(dataset.id, { state: 'error', message: err instanceof Error ? err.message : String(err), scope: request.scope });
    return null;
  }
}
