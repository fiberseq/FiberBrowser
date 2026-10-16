import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export interface ScanPeaksResponse {
  peaks: Array<{
    start: number;
    end: number;
    index: number;
    score: number;
    layer: number;
    width: number;
    threshold: number;
  }>;
  layer_info: Array<{
    layer: number;
    threshold: number;
    label: string;
    n_peaks: number;
    /** Calls at this tier wider than max_peak_width (background, not peaks). */
    n_broad?: number;
  }>;
  n_reads: number;
  /** Above a tier's threshold but wider than max_peak_width (default 2 kb):
   * the view's background accessibility, left out of `peaks`. */
  broad_peaks?: Array<{ start: number; end: number; layer: number; score: number; width: number; threshold: number }>;
  n_clusters?: number;
  mode: string;
  signal?: number[];
  server_elapsed_ms?: number;
  server_timings?: Record<string, number>;
}

export interface PeakDetectionSettings {
  smoothWidth: number;
  thresholdStrong: number;
  thresholdMedium: number;
  thresholdWeak: number;
  thresholdRare: number;
}

export async function scanPeaks(
  chrom: string,
  start: number,
  end: number,
  minWidth: number = 80,
  minReads: number = 5,
  readIds?: string[],
  downsample?: number,
  peakSettings?: PeakDetectionSettings,
  datasetId?: string,
  readIdsByDataset?: Record<string, string[]>,
  signalSource: string = 'accessibility',
  returnSignal: boolean = false,
  sampleSeed?: string,
  datasetIds?: string[],
  options?: RequestInit,
  /** A panel on another assembly: its reference's key (its chromosome names and sizes). */
  panelGenome?: string | null,
  readStrand?: 'CT' | 'GA',
): Promise<ScanPeaksResponse> {
  const params = new URLSearchParams({ chrom, start: start.toString(), end: end.toString() });
  if (datasetId) params.set('dataset_id', datasetId);
  if (panelGenome) params.set('panel_genome', panelGenome);
  const headers = new Headers(options?.headers);
  headers.set('Content-Type', 'application/json');
  return fetchJson(`${API_BASE}/scan_peaks?${params}`, {
    ...(options ?? {}),
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...(readStrand ? { strand: readStrand } : {}),
      min_width: minWidth,
      min_reads: minReads,
      read_ids: readIds ?? null,
      read_ids_by_dataset: readIdsByDataset ?? null,
      dataset_ids: datasetIds ?? null,
      downsample: downsample ?? null,
      smooth_width: peakSettings?.smoothWidth ?? 100,
      threshold_strong: peakSettings?.thresholdStrong ?? 0.50,
      threshold_medium: peakSettings?.thresholdMedium ?? 0.30,
      threshold_weak: peakSettings?.thresholdWeak ?? 0.15,
      threshold_rare: peakSettings?.thresholdRare ?? 0.08,
      signal_source: signalSource,
      return_signal: returnSignal,
      sample_seed: sampleSeed ?? null,
    }),
  });
}
