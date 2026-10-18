import type { SelectedFootprint } from '../../../types';

export interface Props {
  /** Cluster gutter width shared by every track in the view, so all tracks
   * keep the same x-scale; defaults to this panel's own clusters. */
  gutterWidth?: number;
  /** A dataset panel's reads row: hands its reads to the panel's SV and coverage rows (trackFeedStore). Split views leave it off. */
  publishFeed?: boolean;
  width: number;
  height: number;
  datasetId?: string;
  stateKey?: string;   // key for per-panel state lookups (clusters, filters, sort). Defaults to datasetId.
  datasetLabel?: string;
  datasetColor?: string;
  // Viewport override props for split view (DAF-C linked reads)
  overrideChrom?: string;
  overrideStart?: number;
  overrideEnd?: number;
  overrideFilteredIds?: Set<string>;
  /** DAF-seq panel shown for one strand only (CT or GA). */
  readStrand?: 'CT' | 'GA' | null;
  panelLabel?: string;  // Label for the panel (e.g., "Locus X", "Locus Y")
  disableSpanning?: boolean;  // Force spanning off (for split view)
  // Linked session props for DAF-C paired reads
  linkedSessionId?: string;  // Session ID for linked reads
  linkedRegion?: 'x' | 'y';  // Which region of the linked pair
  // Original bounds for linked mode (for coordinate transformation when zoomed)
  linkedBoundsStart?: number;  // Original linked region start
  linkedBoundsEnd?: number;    // Original linked region end
  // Sort order for linked reads
  linkedSortBy?: 'x' | 'y';  // Which region determines row order
  // Coordinated viewport filter: set of read IDs to show (computed by parent)
  linkedFilteredIds?: Set<string> | null;
  // Exclude these read IDs (for showing unlinked reads)
  excludeIds?: Set<string>;
  // Visual-only linked molecule emphasis; does not mutate selectedReadIds.
  linkedHighlightIds?: Set<string>;
  // Callback to report visible read IDs to parent
  onVisibleReadsChange?: (visibleIds: Set<string>) => void;
  // Custom viewport change handler for split view (disables default pan behavior)
  onViewportChange?: (start: number, end: number) => void;
  /** The view this track pans with (usePanOffsetTransform scope). Default: its
   *  panel's own when it has onViewportChange, else the main view. */
  panScope?: string;
  /** The panel's own reference (PanelConfig.genome): its contigs' topology bounds a pan. */
  genome?: string;
}

export interface CigarEvent {
  type: 'M' | 'I' | 'D';  // Mismatch, Insertion, Deletion
  pos: number;           // Position relative to region start
  len: number;           // Length in bp
  seq?: string;          // Sequence (for mismatches and insertions)
}

/**
 * Per-read structural-variant events (fb-n9-sv; shared schema, see
 * services/sv_events.py). Absolute 0-based reference coordinates; `q` is a
 * query position in the BAM SEQ frame.
 */
export interface SvAlleleMetadata {
  ref_end?: number; ref_len?: number; alt_len?: number; q_end?: number;
  raw_ref?: number; raw_ref_end?: number; uncertainty?: [number, number];
  inserted_len?: number; deleted_len?: number; net_len?: number;
  alt_seq?: string; ref_seq?: string; normalized?: boolean;
  raw_pieces?: Array<{ t: 'I' | 'D' | 'M' | '=' | 'X'; ref: number; len: number; q: number }>;
}

export type SvEvent = (
  | { t: 'D'; ref: number; len: number; q: number }
  | { t: 'I'; ref: number; len: number; q: number; seq?: string }
  | { t: 'S'; side: 'L' | 'R'; ref: number; len: number; q: number; h?: 1;
      anchor?: Omit<SvSegment, 't' | 'mapq' | 'query_blocks'> }
  | { t: 'SA'; chrom: string; pos: number; strand: '+' | '-'; mapq: number; nm: number; cigar_ref_len: number; supp: boolean;
      /** The segment aligns on the read's own strand (a deletion's split read; an inversion's does not). */
      same_strand?: boolean }) & SvAlleleMetadata;

export type SvEvidenceLevel = 'confirmed' | 'putative' | 'conflicting' | 'ambiguous';
export interface SvSegment {
  t?: 'SA';
  chrom: string; pos: number; cigar_ref_len: number; strand: '+' | '-'; mapq: number;
  q_start: number; q_end: number; query_length: number;
  /** Full-query M/=/X intervals; internal insertions do not align elsewhere. */
  query_blocks?: [number, number][];
}

/** One SV cluster across the reads in view. */
export interface SvCluster {
  ref_len?: number; alt_len?: number; raw_ref?: number; uncertainty?: [number, number];
  id: string;
  t: 'D' | 'I';
  ref: number;
  len: number;
  /** ref + len for a deletion, ref for an insertion. */
  end: number;
  /** Carrier reads. */
  support: number;
  confirmed?: number;
  putative?: number;
  conflicting?: number;
  ambiguous?: number;
  /** Carriers plus reads spanning [ref - margin, end + margin] without it. */
  informative: number;
  /** Carriers whose evidence is a clip with an SA segment (deletions). */
  sa_support: number;
  /** Carriers clipped at the breakpoint (insertions: soft or hard clip, with or without an SA). */
  clip_support?: number;
}

export interface SvSummary {
  conflict_options?: import('../../../utils/svConflicts').SvConflictOptions;
  evidence_targets?: Pick<SvCluster, 't' | 'ref' | 'len' | 'uncertainty'>[];
  min_len: number;
  margin: number;
  /** 'loaded': a working-read cap truncated the reads in view. */
  scope: 'all' | 'loaded';
  n_reads: number;
  clusters: SvCluster[];
  clips: Array<{ side: 'L' | 'R'; ref: number; n: number }>;
}

/** A named annotation layer — nucleosomes, TF footprints, FIRE/internal MSP, or custom types. */
export interface AnnotationLayer {
  family_confidence_kind?: 'unavailable';
  consensus_workflow?: boolean;
  consensus_records?: import('../../../utils/consensusVisual').ConsensusRecord[];
  show_quality_outlines?: boolean;
  draw_style?: 'fill' | 'outline';
  job_id?: string;
  intervals: [number, number, number][];  // [start, end, size], region-relative
  /** Unclipped reference bounds, possibly outside the viewport; analysis only. */
  source_intervals?: [number, number, number][];
  /** Frozen consensus-model bounds aligned one-to-one with intervals. */
  family_intervals?: [number, number, number][];
  qualities?: number[][];                  // multi-dim: e.g. [[tq0,tq1,...],[el0,...],[er0,...]]
  quality_names?: string[];                // e.g. ['tq','el','er'] or ['nq','mq','lq','rq']
  annotation_names?: string[];
  /** Targeted SR action aligned one-to-one with intervals. */
  refinement_kinds?: string[];
  circular_ids?: string[];
  /** Molecular call layer whose geometry was assigned to this family. */
  source_layer?: 'tf' | 'tf_sr' | string;
}

export interface CompactRead {
  signal?: import('../../../utils/signalFilters').SignalEvidence;
  id: string;
  /** BAM 0x400 / FiberHMM BigBed isDuplicate annotation. */
  duplicate?: boolean;
  /** DAF strand from the record's st:Z tag (FiberHMM's rule); '.' = st present but neither CT nor GA (no strand). */
  strand?: 'CT' | 'GA' | '.';
  /** st:Z and the SEQ's R/Y deamination marks name different strands (e.g. st not swapped by a graph lift). */
  strand_conflict?: boolean;
  /** A fiberhmm-lift record's provenance: source locus (Yp:Z, contig:POS:strand) and source MAPQ (Yq:i). */
  lift?: { from: string; mapq?: number };
  intervals: [number, number, number][]; // [start, end, size] - size negative for gaps (primary layer, backward compat)
  /** Legacy union field — populated with whichever modification signal is
   *  primary for this read (m6a preferred, then m5c, then deam positions).
   *  New code should prefer the per-type fields below. */
  methyl?: number[];
  /** m6A methylation positions (region-relative). From BAM MM/ML A+a blocks. */
  methyl_m6a?: number[];
  /** 5mC methylation positions (region-relative). From BAM MM/ML C+m blocks. */
  methyl_m5c?: number[];
  /** DAF deamination events as [pos, blockMod] pairs. blockMod 0 = R / GA-deamination,
   *  1 = Y / CT-deamination. From IUPAC R/Y codes in sequence or ref-mismatch fallback. */
  deam?: [number, number][];
  /** Possible strand-informative DAF targets, region-relative. Source
   *  deletions are absent; observed Y/R or mismatch events remain included. */
  possible_deam_ct?: number[];
  possible_deam_ga?: number[];
  qualities?: number[]; // per-footprint quality scores (0-255, from nq tag) — primary layer
  cigar?: CigarEvent[]; // CIGAR events for visualization
  /** SV events of at least the request's min_sv_len overlapping the view (absent when none). */
  sv?: SvEvent[];
  /** Full allele evidence when display size/view filtering removed events from sv. */
  sv_evidence?: SvEvent[];
  sv_segments?: SvSegment[];
  aligned_blocks?: [number, number][];
  sequence_span?: [number, number];
  supplementary?: boolean;
  sv_alignments?: Omit<CompactRead, 'intervals' | 'sv_alignments'>[];
  fire?: [number, number, number][]; // FIRE intervals [start, end, quality] from as/al/aq tags
  /** Named annotation layers from v3 caller (nuc, tf, msp, custom). */
  layers?: Record<string, AnnotationLayer>;
  annotation_names?: string[];
  circular_ids?: string[];
  /** Layers omitted from the wire payload because they can be derived locally. */
  derived_layers?: string[];
}

/**
 * The server's display sample of a deep view (1 in 2^level): ``kept`` of
 * ``total`` primary alignments in view (both before the read filters, exact);
 * ``loaded``: the sampled reads in view after them (what the panel counts).
 */
export interface WorkingSampling {
  level: number;
  fraction: number;
  kept: number;
  total: number;
  kept_spanning: number;
  total_spanning: number;
  loaded?: number;
  loaded_spanning?: number;
}

export interface ReadsResponse {
  count: number;
  display_count?: number;
  total: number;
  total_in_scope?: number;  // Reads matching the current span/filter request scope before display sampling
  total_overlapping?: number;
  total_spanning?: number;  // Count of spanning reads before sampling
  working_count?: number;  // Count of reads sampled from for this response
  /** Reads in view that Min footprints hid, sent when it hid every one of them. */
  hidden_by_min_footprints?: number;
  signal_counts?: import('../../../utils/signalFilters').SignalCounts;
  /** A deep BAM view: the server loaded a stable sample of its reads (services/read_sampling.py). */
  working_sampling?: WorkingSampling;
  width: number;
  reads: CompactRead[];
  dataset_id?: string;
  label?: string;
  color?: string;
  has_methylation?: boolean;
  /** Annotation layer names detected in this batch (from v3 caller / legacy conventions / MA spec). */
  available_layers?: string[] | null;
  warning?: string;  // Server-side warning (e.g., missing BAM index)
  server_elapsed_ms?: number;  // Backend elapsed time for diagnostics
  server_timings?: Record<string, number>;  // Backend phase timings for diagnostics
  sample_seed?: string;
  metaprofile?: {
    nucleosome_profile: number[];
    subnuc_profile: number[];
    layers?: Record<string, number[]>;
  };
  metaprofile_read_count?: number;
  profile_max_reads?: number;
  /** SV clusters across every read in view (not only the display sample). */
  sv_summary?: SvSummary;
}

// Layout computation result shared between canvas drawing and mouse interaction
export interface ReadTrackLayout {
  headerHeight: number;
  histogramHeight: number;
  trackHeight: number;
  trackWidth: number;
  rowHeight: number;
  rowGap: number;
  scale: number;
  sidebarWidth: number;
  regionWidth: number;
  n: number;
  totalContentHeight: number;
  needsScroll: boolean;
  maxScrollOffset: number;
  clampedScrollOffset: number;
  firstVisibleRow: number;
  lastVisibleRow: number;
  linkedOffset: number;
}
