// ============================================================================
// DAF-C TYPES
// ============================================================================

// Linked region from a contact selection
export interface LinkedRegion {
  chrom: string;
  x_chrom?: string | null;
  y_chrom?: string | null;
  x_start: number;
  x_end: number;
  y_start: number;
  y_end: number;
}

// Contact mode - determines split view behavior
export type ContactMode = 'dafc' | 'microc';
export type SplitViewMode = 'molecule_linked' | 'region_independent' | 'coordinate_synced' | 'unassigned';

export interface SplitViewSemantics {
  mode: SplitViewMode;
  label: string;
  row_coupling: 'molecule' | 'none' | 'syncable_independent';
  read_source: 'linked_segments' | 'per_region_query' | 'none';
  analysis_scope: string;
  co_cluster_scope: string;
  supports_background_reads: boolean;
  description: string;
}

// Result of selecting a contact region
export interface ContactSelection {
  chrom: string;
  x_start: number;
  x_end: number;
  y_start: number;
  y_end: number;
  contacts: number;
  n_ligated_reads: number;
  read_ids: string[];
  contact_mode: ContactMode;  // Detected mode: "dafc" or "microc"
}

// Arc data from Micro-C interaction
export interface ContactArc {
  start: number;
  end: number;
  strength: number;  // Normalized strength (0-1) or O/E ratio in stable mode
  count: number;     // Raw contact count (number of interactions)
  distance: number;
  oe_ratio?: number; // Observed/Expected ratio (when using O/E normalization)
}

// Virtual 4C profile response
export interface Virtual4CResponse {
  profile: number[];
  resolution: number;
  viewpoint: {
    start: number;
    end: number;
  };
}

// APA (Aggregate Peak Analysis) response
export interface APAResponse {
  matrix: number[][];
  apa_score: number;
  center_value: number;
  corner_mean: number;
  n_pairs: number;
  window: number;
  resolution: number;
  matrix_size: number;
  normalization: string;
  error?: string;
}

// Micro-C track display modes
export type MicroCTrackMode = 'matrix' | 'arc' | 'virtual4c' | 'apa' | null;

// A linked browser session
export interface LinkedSession {
  id: string;
  created_at: number;
  version: number;
  has_regions: boolean;
  has_reads: boolean;
  n_reads: number;
  regions: LinkedRegion | null;
  contact_mode: ContactMode | null;
  split_view_mode: SplitViewMode;
  split_view_semantics: SplitViewSemantics;
}

// DAF-C status from server
export interface DAFCStatus {
  loaded: boolean;
  cool_file: string | null;
  bigbed_file: string | null;
  resolutions: number[];
  current_resolution: number;
  chroms: { name: string; size: number }[];
  has_bigbed: boolean;
  has_read_source?: boolean;
  read_source_type?: string | null;
  n_linked_sessions: number;
}
