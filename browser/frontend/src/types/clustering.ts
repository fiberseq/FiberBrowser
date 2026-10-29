import type { ClusterMergeLog } from '../stores/clusterMergeLog';
import type { ClusterFeatureRule } from './index';

// Clustering and transcription state types

export interface TranscriptionStateFilters {
  pause?: boolean;
  pic?: boolean;
  elongating?: number | null;  // null = disabled, number = min count threshold (>=)
  elongating_max?: number | null;  // null = no upper bound, number = max count threshold (<=)
}

export interface ReadStateInfo {
  pause: boolean;
  pic: boolean;
  elongating_count: number;
}

/**
 * A fit's molecule metric cohort (services/clustering_features.py `fitted_metric_cohort`): each metric's distinct
 * fitted values with their counts (a sorted list in older correspondence models). Kept with the fit's patterns or
 * centroids and sent back with them, so dynamic assignment ranks a view's reads against the reads the model was
 * fitted on rather than against each other. Empty: the fit had no molecule metric column (or predates the cohort).
 */
export type ClusterMetricCohort = Record<string, { values: number[]; counts: number[] } | number[]>;

/**
 * A run over panels at several loci: each panel's own matched peaks (state
 * key -> absolute peaks, as sent), valid while the clustering's peaks are
 * still that run's `regions`, with the view each was clustered at.
 */
export interface ClusterWindowPeaks {
  regions: Array<{ start: number; end: number; mode?: string; chrom?: string; genome?: string }>;
  byKey: Record<string, Array<{ start: number; end: number; mode?: string }>>;
  /** Each window's view when clustered: its locus and reference (null: the main genome). */
  views?: Record<string, { chrom: string; start: number; end: number; genome: string | null }>;
}

/** A saved clustering result that persists across navigation. */
export interface SavedCluster {
  id: string;                    // crypto.randomUUID()
  name: string;                  // user-editable, auto-generated default
  addedAt: number;               // Date.now()

  // Viewport where clustering was performed
  chrom: string;
  start: number;
  end: number;

  // Config
  clusterMethod: string;
  clusterK: number;
  /** Method 'graph': community resolution (older records: 1). */
  clusterResolution?: number;
  subnucleosomalThreshold: number;
  accessibilityThreshold: number;
  clusterFeatureRules?: ClusterFeatureRule[];

  // Peak regions (absolute genomic coords)
  peakRegions: Array<{ start: number; end: number; mode?: string; chrom?: string }>;
  customPeaks: Array<{ start: number; end: number; chrom?: string }>;
  peakSelection?: import('../features/hub/peakMigration').PeakSelection;
  selectedPeakIndices: number[];
  peakModes: Record<number, string>;

  // Results — keyed by datasetId (not stateKey, for portability): the panel
  // showing the saved view, when one dataset had several panels.
  assignments: Record<string, Record<string, number>>;
  order: Record<string, number[]>;
  patterns: Record<number, number[]>;
  /** The fit's molecule metric cohort, with its patterns (older saves: none). */
  metricCohort?: ClusterMetricCohort;
  /** Each clustered panel's own result, so two panels of one dataset
   *  (independently clustered, or at their own locus) come back as they were. */
  panelResults?: Array<{
    stateKey: string;
    datasetId: string;
    /** The panel's own locus; absent when it showed the saved view. */
    viewport?: { chrom: string; start: number; end: number };
    /** The panel's own reference (PanelConfig.genome); absent: the main genome. */
    genome?: string;
    assignments: Record<string, number>;
    order?: number[];
  }>;
  /** A run over panels at several loci: each panel's own matched peaks (as clusterWindowPeaks). */
  windowPeaks?: ClusterWindowPeaks | null;
  /**
   * The merges behind this clustering (stores/clusterMergeLog.ts), keyed by
   * state key, so Unmerge and Split back work again once it is restored
   * (older saves: none).
   */
  mergeLog?: ClusterMergeLog | null;
}

/** One persistent node in a drill-down clustering tree. */
export interface ClusterTreeNode {
  preparationSamples?: Record<string, import('./index').ClusterPreparationSample>;
  preparationCount?: number | null;
  id: string;
  parentId: string | null;
  name: string;
  createdAt: number;

  // Viewport where this branch was computed.
  chrom: string;
  start: number;
  end: number;

  // Parent branch provenance.
  sourceClusterIds: number[];
  sourceLabel?: string;
  readScope?: Record<string, string[]>;
  /** A refinement within carriers (graph primary §2.6): every read of the parent stays shown (it is not a subset
   * branch), refined reads under their C<parent>.<j> names. */
  refinement?: boolean;
  /** Names of its refined clusters, by state key (restored with the node). */
  groupLabels?: Record<string, Record<number, string>>;

  // Config used to compute this branch.
  clusterMethod: string;
  clusterK: number;
  /** Method 'graph': community resolution (older records: 1). */
  clusterResolution?: number;
  clusterPeakMode?: string;
  subnucleosomalThreshold: number;
  accessibilityThreshold: number;
  clusterFeatureRules?: ClusterFeatureRule[];

  // Peak regions are absolute genomic coords.
  peakRegions: Array<{ start: number; end: number; mode?: string; chrom?: string }>;
  peakSelection?: import('../features/hub/peakMigration').PeakSelection;
  selectedPeakIndices: number[];
  peakModes: Record<number, string>;
  patterns: Record<number, number[]>;
  // Per-cluster centroids + feature-column widths for non-combinatorial dynamic
  // reassignment (kmeans, etc.). Empty for combinatorial branches (patterns).
  centroids?: Record<number, number[]>;
  peakWidths?: number[];
  /** The fit's molecule metric cohort, with its patterns or centroids (older nodes: none). */
  metricCohort?: ClusterMetricCohort;
  dynamicClustering: boolean;

  /** A graph run's record provenance, by the state key of each panel it labelled on this node: the run's
   * observations and the record keys each observation labelled (dynamic assignment included). A haplotype popped
   * out of that panel keeps, on this node, only its own observations' rows. */
  graphProvenance?: Record<string, { observations: import('../utils/clusterMatchedRun').GraphRunObservation[];
    owned: Record<string, string[]> }>;
  /** State keys whose labels on this node another grouping (a merge, a clustering of the panel's own) replaced after
   * the graph run labelled them: the run's provenance still says whose records they are (pop-outs split by it), but
   * the labels are no longer the run's own (a source view keeps its order and focus). A graph run clears its keys. */
  graphLabelsReplaced?: Record<string, boolean>;

  // Results are keyed by current stateKey for in-session branch switching.
  assignments: Record<string, Record<string, number>>;
  order: Record<string, number[]>;
  focus: Record<string, number[] | null>;
}

// Analysis panel type — open string for plugin panels
export type AnalysisPanelType = string;

export interface AnalysisPanel {
  id: string;
  type: AnalysisPanelType;
  label: string;
}
