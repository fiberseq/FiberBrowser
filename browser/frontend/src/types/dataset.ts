// Dataset and data source types

/** Annotation layer / modification type name.
 *
 * The fiberseq molecular annotation spec is extensible — tools can define
 * arbitrary annotation types (nuc, tf, msp, fp_v2, pol2, ctcf, ...). We keep
 * a few legacy names as autocomplete hints but accept any string so custom
 * types flow through naturally.
 */
export type ModificationType = 'mod' | 'm5c' | 'msp' | 'fire' | 'footprint' | (string & {});

// Meta profile types for MetaTrack — dynamic (rule IDs + 'mod')
export type MetaProfileType = string;

export type DatasetProfile = {
  mod: number[];
  fire: number[];
  rules: Record<string, number[]>;
  /** Per-layer presence profiles (nuc, tf, msp, custom). Each entry is a
   *  fraction-coverage array (0..1) at the resolution used by MetaTrack. */
  layers?: Record<string, number[]>;
};

export type ViewMode = 'stacked' | 'sideBySide' | 'linked' | 'linkedSplit';
export type FireTrackType = 'fire' | 'accessibility' | 'none';

export interface DerivedLayerDefinition {
  id: string;
  label: string;
  source_layer?: string;
  kind?: string;
  color?: string | null;
  rules?: Record<string, unknown>;
  bundle_path?: string;
  manifest_path?: string | null;
  source_dataset?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  version?: number | string | null;
}

/** A BAM contig shown as a plasmid map (the same sequence, maybe renamed or rotated). */
export interface PlasmidLink {
  dataset_id: string;
  dataset_label?: string;
  contig: string;
  /** The chromosome the reads are shown on (the map, or its copy in this BAM's frame). */
  chrom: string;
  map_chrom?: string;
  /** The contig is the map rotated by this many bp (the map is shown in the BAM's frame). */
  offset: number;
  method: 'm5' | 'reference' | 'reads' | 'header' | 'name' | 'confirmed' | 'session' | string;
  verified: boolean;
  detail?: string;
}

/** Why a BAM contig was not linked to a map, and whether the user may link it anyway. */
export interface PlasmidProblem {
  kind: 'length' | 'sequence' | 'reverse_complement' | 'unverified' | 'map_checksum' | 'unreadable' | 'error' | string;
  message: string;
  dataset_id?: string;
  dataset_label?: string;
  contig?: string;
  chrom?: string;
  can_confirm?: boolean;
  suggested_offset?: number;
  shown_by_name?: boolean;
}

export interface Dataset {
  id: string;
  /** Its display name: the file stem, or the name the user gave it (one rule for every way of opening it). */
  label: string;
  /**
   * Display only: the BAM's sample name (@RG SM, or the run's sample) when the page knows it (opened from the Library
   * or a run's results). Shown second (tooltips), never as the name and never in ids (usability round 2, N9).
   */
  sample?: string;
  path: string;
  paths?: string[];
  source_identity?: string;
  color: string;
  data_type?: 'bam' | 'bigbed' | 'unknown';
  layer_type?: ModificationType | 'bam';
  available_layers?: Partial<Record<ModificationType, boolean>>;
  companion_layers?: Record<string, string[]>;
  derived_layers?: Record<string, DerivedLayerDefinition>;
  /** The datatype footprint-class runs use for this dataset, from BAM header provenance or chosen in the browser. */
  consensus_chemistry?: 'ddda' | 'dddb' | 'hia5-pacbio' | 'hia5-nanopore' | null;
  /** @deprecated Legacy name of consensus_chemistry (servers before 3.0). */
  family_scan_chemistry?: 'ddda' | 'dddb' | 'hia5-pacbio' | 'hia5-nanopore' | null;
  chemistry_metadata?: {
    chemistry?: 'ddda' | 'dddb' | 'hia5-pacbio' | 'hia5-nanopore' | null;
    source?: string;
    status?: 'declared' | 'inferred' | 'unknown' | 'incomplete' | 'conflict' | 'unavailable';
    message?: string;
    declaration?: {
      assay?: string;
      enzyme?: string;
      platform?: string;
      mode?: string;
      [key: string]: unknown;
    };
    files?: Array<Record<string, unknown>>;
  };
  /** Plasmid maps linked to this BAM's contigs, maps its header named, and contigs that did not match. */
  plasmid?: {
    links?: PlasmidLink[];
    problems?: PlasmidProblem[];
    maps_loaded?: Array<{ success: boolean; name?: string; path?: string; length?: number; error?: string }>;
  };
}

export interface ModificationOverlay {
  id: string;
  label: string;
  path: string;
  type: ModificationType | 'unknown';
  color: string;
}

export interface OrthogonalTrack {
  index: number;
  label: string;
  values: number[];
  intervals?: import('./index').Interval[];
  renderMode: 'signal' | 'annotation';
  category?: string;  // 'motif', etc.
  path?: string;
  format?: string;  // 'bigWig', 'bigBed', 'bed', 'custom_motif', etc.
  motif_type?: string;  // 'sequence' | 'file' | 'pwm' for custom_motif tracks
  motif_name?: string;
  motif_source?: string;
}

export interface OrthogonalTrackViewportData {
  values: number[];
  intervals?: import('./index').Interval[];
}

// --- Catalog + Composite Track model ----------------------------------------

export type CatalogKind = 'bigwig' | 'bigbed' | 'bam' | 'motif' | 'metaprofile-rule' | 'fiberlayers';

export interface CatalogEntry {
  id: string;                  // stable uuid
  source: 'online' | 'local';
  kind: CatalogKind;
  label: string;
  path?: string;               // local file
  url?: string;                // online (or http(s) backed)
  catalogId?: string;          // online catalog id (e.g., UCSC track id)
  loaded: boolean;
  unavailable?: boolean;       // restore-time flag for missing local files
  meta?: { sizeBytes?: number; format?: string; lastSeen?: string; threshold?: number };
  /** Active filter names for motif/JASPAR/bigBed annotation tracks — e.g.
   *  ['CTCF', 'MAX']. Persisted with the entry so reloads re-register the
   *  backend track with the same filter (otherwise every motif from the
   *  source file gets loaded). */
  filterNames?: string[];
  /** Backend track index assigned by `addTrack`. Transient — re-stamped on
   *  every (re)register (catalog persists, but indices are reassigned each
   *  process). Used by source resolution so multiple catalog entries with
   *  the same URL but different filters can each point at their own
   *  orthogonalTrack — path-only matching collapses them. */
  trackIndex?: number;
}

export type SourceRef =
  | { kind: 'bigwig' | 'bigbed'; catalogEntryId: string }
  | { kind: 'online'; catalogEntryId: string }
  | { kind: 'metaprofile'; ruleId: string; datasetId?: string };

export interface TrackSource {
  id: string;                  // uuid
  ref: SourceRef;
  color: string;
  visible: boolean;
  negate: boolean;             // sign-flip; covers PRO-seq +/-
  scale: number;               // multiplier, default 1
}

export type CompositeKind = 'signal' | 'annotation' | 'metaprofile';
export type CompositeScaleMode = 'auto' | 'manual' | 'group' | 'per-source';
export type AnnotationScoreScale = 'linear' | 'sqrt' | 'log' | 'square';
export type AnnotationStrandMode = 'split' | 'inline' | 'none';

export interface AnnotationTrackStyle {
  /** Hide motif/annotation hits below this normalized score (0..1). */
  scoreMin?: number;
  /** Score value that maps to full intensity. Defaults to 1. */
  scoreMax?: number;
  scoreScale?: AnnotationScoreScale;
  strandMode?: AnnotationStrandMode;
  showScoreLegend?: boolean;
}

export interface CompositeTrack {
  id: string;
  label: string;
  kind: CompositeKind;
  sources: TrackSource[];
  scaleMode: CompositeScaleMode;
  yMin?: number;
  yMax?: number;
  logScale: boolean;
  scaleGroup?: string;
  visible: boolean;            // eye toggle
  groupAutoscaleSelected: boolean;
  showAxes: boolean;
  overlayGroup?: string;       // RESERVED for future arbitrary overlays
  annotationStyle?: AnnotationTrackStyle;
  /** When false, the cart hides the × remove button — the track can only be
   *  hidden, not deleted. Used for the seeded default metaprofile. Defaults
   *  to true (removable). */
  removable?: boolean;
}

/** Stable id for the seeded default metaprofile composite. Lives in the cart
 *  like any other entry, but is non-removable and gets seeded on first run. */
export const DEFAULT_METAPROFILE_ID = '__default_metaprofile__';
