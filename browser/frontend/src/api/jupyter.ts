import { isPublicServerPage } from '../utils/publicServerFlag';
import type {
  CaptureRegion,
  CatalogEntry,
  Colormap,
  CompositeTrack,
  FirePeak,
  FootprintGroup,
  JupyterFootprintColor,
  JupyterHighlight,
  JupyterMarker,
  PeakRule,
  AnalysisFilterRule,
  AnalysisSortRule,
  ClusterFeatureRule,
  Gene,
  PeakMode,
  SavedPrimer,
  TranscriptionStateFilters,
} from '../types';
import type { SerializedCoaccSettings } from '../stores/coaccStore';
import type { SavedTrack } from '../stores/savedTracksSlice';
import type { SessionManifest } from '../utils/sessionManifest';
import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export type { JupyterHighlight, JupyterMarker, JupyterFootprintColor } from '../types';

export interface JupyterState {
  version: number;
  has_custom_reads: boolean;
  has_pushed_reads: boolean;
  pushed_reads: Array<{ id: string; intervals: [number, number, number][] }> | null;
  has_order: boolean;
  has_filter: boolean;
  has_highlights: boolean;
  has_markers: boolean;
  has_footprint_colors: boolean;
  highlights: JupyterHighlight[];
  markers: JupyterMarker[];
  footprint_colors: JupyterFootprintColor[];
  read_order: Record<string, string[]>;
  read_filter: Record<string, string[]>;
  selected_reads?: string[];
  selected_read_ids?: Record<string, string[]>;
  browser_settings?: BrowserSettingsSnapshot;
  browser_actions?: Array<{ id?: string; label?: string; action: Record<string, unknown> }>;
  goto?: { chrom: string; start: number; end: number };
  refresh?: boolean;
  peak_import?: {
    id?: string;
    peaks: Array<Record<string, unknown>>;
    chrom?: string | null;
    label?: string | null;
    lock?: boolean;
    select?: boolean;
    replace_existing?: boolean;
  };
  peak_rules_update?: {
    id?: string;
    rules: PeakRule[];
    lock?: boolean | null;
    clear_peaks?: boolean;
    rescan?: boolean;
  };
  settings_update?: {
    analysis_sample_seed?: string | null;
    analysis_sample_count?: number | null;
    display_sample_count?: number | null;
    read_display_mode?: 'sample' | 'all' | null;
    all_reads_display_cap?: number | null;
    background_read_cap?: number | null;
    spanning_only?: boolean | null;
    peaks_locked?: boolean | null;
    peak_rules?: PeakRule[] | null;
    selected_peaks?: number[] | null;
    peak_modes?: Record<number, PeakMode> | null;
    peaks_by_rule?: Record<string, FirePeak[]> | null;
    cluster_feature_rules?: ClusterFeatureRule[] | null;
    analysis_sort_rules?: AnalysisSortRule[] | null;
    analysis_filter_rules?: AnalysisFilterRule[] | null;
    active_colormap?: Colormap | null;
    cluster_method?: string | null;
    cluster_k?: number | null;
    small_footprint_threshold_bp?: number | null;
    accessibility_threshold?: number | null;
    capture_regions?: CaptureRegion[];
    capture_padding?: number | null;
    catalog?: CatalogEntry[];
    composite_tracks?: CompositeTrack[];
    saved_tracks?: SavedTrack[];
    footprint_groups?: FootprintGroup[];
    selected_genes?: Gene[];
    transcription_state_filters?: TranscriptionStateFilters | null;
    primer_saved_primers?: SavedPrimer[] | null;
    primer_mode?: 'standard' | 'dafc' | '4c' | null;
    primer_cart_track_display?: 'off' | 'all' | 'imported' | 'design' | null;
    enabled_mod_types?: Record<string, boolean> | null;
    enabled_meta_profiles?: Record<string, boolean> | null;
    cached_layer_types?: Record<string, boolean> | null;
    legacy_layer_inference?: boolean | null;
    legacy_nuc_min_size?: number | null;
    click_target_layer?: string | null;
    footprint_analysis_layer?: string | null;
    coacc_settings?: SerializedCoaccSettings | null;
    fill_read_height?: boolean | null;
    read_row_height?: number | 'auto' | null;
    show_coverage_histogram?: boolean | null;
    max_region_for_reads?: number | null;
    show_genome_overview?: boolean | null;
    open_panel?: string | null;
    close_panel?: string | null;
    /** Panel opens/closes, in the order the notebook asked for them. */
    panel_ops?: Array<['open' | 'close', string]>;
    hidden_strip_panels?: string[];
  };
}

export interface BrowserSettingsSnapshot {
  analysis_sample_seed?: string | null;
  analysis_sample_count?: number | null;
  display_sample_count?: number | null;
  read_display_mode?: 'sample' | 'all' | null;
  all_reads_display_cap?: number | null;
  background_read_cap?: number | null;
  spanning_only?: boolean | null;
  peaks_locked?: boolean | null;
  peak_rules?: PeakRule[];
  selected_peaks?: number[];
  peak_modes?: Record<number, PeakMode>;
  selected_read_ids?: Record<string, string[]>;
  peaks_by_rule?: Record<string, FirePeak[]>;
  cluster_feature_rules?: ClusterFeatureRule[];
  analysis_sort_rules?: AnalysisSortRule[];
  analysis_filter_rules?: AnalysisFilterRule[];
  active_colormap?: Colormap | null;
  active_quality_filters?: Array<Record<string, unknown>>;
  cluster_method?: string | null;
  cluster_k?: number | null;
  small_footprint_threshold_bp?: number | null;
  accessibility_threshold?: number | null;
  selected_peak_count?: number | null;
  capture_regions?: CaptureRegion[];
  capture_padding?: number | null;
  catalog?: CatalogEntry[];
  composite_tracks?: CompositeTrack[];
  saved_tracks?: SavedTrack[];
  footprint_groups?: FootprintGroup[];
  selected_genes?: Gene[];
  transcription_state_filters?: TranscriptionStateFilters;
  primer_saved_primers?: SavedPrimer[];
  primer_mode?: 'standard' | 'dafc' | '4c';
  primer_cart_track_display?: 'off' | 'all' | 'imported' | 'design';
  enabled_mod_types?: Record<string, boolean>;
  enabled_meta_profiles?: Record<string, boolean>;
  cached_layer_types?: Record<string, boolean>;
  legacy_layer_inference?: boolean;
  legacy_nuc_min_size?: number;
  click_target_layer?: string | null;
  footprint_analysis_layer?: string | null;
  coacc_settings?: SerializedCoaccSettings;
  fill_read_height?: boolean;
  read_row_height?: number | 'auto';
  show_coverage_histogram?: boolean;
  max_region_for_reads?: number;
  show_genome_overview?: boolean;
  session_manifest?: SessionManifest;
  active_panels?: Array<Record<string, unknown>>;
  hidden_strip_panels?: string[];
  cluster_assignments?: Record<string, Record<string, number>>;
  cluster_order?: Record<string, number[]>;
  read_sort_order?: Record<string, string[]>;
}

export async function getJupyterState(): Promise<JupyterState> {
  return fetchJson(`${API_BASE}/jupyter/state`);
}

export async function syncJupyterBrowserSettings(
  settings: BrowserSettingsSnapshot,
): Promise<{ success: boolean; settings: BrowserSettingsSnapshot }> {
  return fetchJson(`${API_BASE}/jupyter/settings/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

export async function getJupyterReads(
  datasetId: string,
  chrom?: string,
  start?: number,
  end?: number,
): Promise<{ reads: Array<Record<string, unknown>>; chrom: string; start: number; end: number; count: number }> {
  const params = new URLSearchParams({ dataset_id: datasetId });
  if (chrom) params.set('chrom', chrom);
  if (start !== undefined) params.set('start', start.toString());
  if (end !== undefined) params.set('end', end.toString());
  return fetchJson(`${API_BASE}/jupyter/reads?${params}`);
}

export async function setJupyterSelection(readIds: string[]): Promise<{ success: boolean }> {
  return fetchJson(`${API_BASE}/jupyter/selection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readIds),
  });
}

export async function syncBrowserReadOrder(
  datasetId: string,
  readIds: string[],
): Promise<{ success: boolean; dataset_id: string; count: number }> {
  // No notebook link on a public server.
  if (isPublicServerPage()) return { success: false, dataset_id: datasetId, count: 0 };
  return fetchJson(`${API_BASE}/jupyter/browser_order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset_id: datasetId, read_ids: readIds }),
  });
}

export async function clearCache(): Promise<{ success: boolean; message: string }> {
  return fetchJson(`${API_BASE}/clear_cache`, {
    method: 'POST',
  });
}
