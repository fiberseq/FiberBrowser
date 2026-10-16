import { clusterSelectionKeys, type ClusterMatchedRun } from '../utils/clusterMatchedRun';
import { matchedModeIndices, keepMatched } from '../utils/matchedRegions';
import { loadPinnedMotifs, normalizePinnedMotifs, type PinnedMotifs } from '../utils/pinnedMotifs';
import {
  clampMotifP, loadCustomMotifs, loadMotifScoring, normalizeCustomMotifs, type CustomMotif, type MotifScoreMode,
} from '../utils/motifSettings';
import { nextSelection, normalizeFeatureRefs, type FeatureRef } from './featureStore';
import { rememberClusterSelection, type ClusterSelection } from '../utils/footprintClusterSelection';
import { isSelectedFootprint } from '../utils/footprintSelection';
import { geneTss } from '../utils/coordinates';
import { sameChrom } from '../utils/chromAliases';
import { autoNameSuffix, sizeRangeName } from '../utils/footprintGroupNames';
import type { BrowserState } from './browserStore';
import { seedHistoryBaseline } from './historySlice';
import { inGenomeLinkGroup } from '../utils/panelNavigation';
import type { AnalysisFilterRule, AnalysisFilterRuleSet, AnalysisSortRule, AnalysisSortRuleSet, ClusterFeatureRule, ClusterFeatureRuleSet, ClusterTreeNode, FirePeak, Gene, PeakMode, SelectedFootprint, FootprintGroup, TranscriptionStateFilters, ReadStateInfo, SortMode, FilterMode, ModificationType, SavedCluster, PanelConfig, ClusterWindowPeaks } from '../types';
import { CLUSTER_RULE_MODE_PREFIX } from '../types';
import type { ReadProjectionIndex } from '../utils/projectionExport';
import { fetchApiResponse } from '../api/sharedFetch';
import { isPublicServerPage } from '../utils/publicServerFlag';
import { computeRuleOffset } from './peakRuleSlice';
import {
  mergeLogStatus,
  normalizeMergeLog,
  recordMergeStep,
  restoreMergeLog,
  splitBackCluster,
  toggleMerge,
  type ClusterMergeKind,
  type ClusterMergeLog,
  type ClusterMergeSettingsRecord,
} from './clusterMergeLog';
import {
  clampMergeThreshold,
  isMergeStrategy,
  type MergeStrategy,
  type MergeThresholds,
} from '../utils/mergeStrategies';
import {
  DEFAULT_ANALYSIS_SORT_RULESET_STORAGE_KEY,
  DEFAULT_ANALYSIS_FILTER_RULESET_STORAGE_KEY,
  DEFAULT_CLUSTER_FEATURE_RULESET_STORAGE_KEY,
  getInitialAnalysisFilterRules,
  getInitialAnalysisSortRules,
  getInitialClusterFeatureRules,
  loadAnalysisFilterRuleSetsFromStorage,
  loadDefaultAnalysisFilterRuleSetName,
  loadAnalysisSortRuleSetsFromStorage,
  loadDefaultAnalysisSortRuleSetName,
  loadClusterFeatureRuleSetsFromStorage,
  loadDefaultClusterFeatureRuleSetName,
  loadFootprintGroupsFromStorage,
  normalizeAnalysisFilterRules,
  normalizeAnalysisSortRules,
  normalizeClusterFeatureRules,
  normalizeFootprintGroups,
  normalizeTranscriptionStateFilters,
  saveAnalysisFilterRuleSetsToStorage,
  saveAnalysisSortRuleSetsToStorage,
  saveClusterFeatureRuleSetsToStorage,
  saveFootprintGroupsToStorage,
} from './utils';

const UNASSIGNED_CLUSTER_ID = -1;

function hasAnyClusterAssignments(assignments: Record<string, Record<string, number>>): boolean {
  return Object.values(assignments).some(a => Object.keys(a).length > 0);
}

const CLUSTER_METHOD_NAMES: Record<string, string> = {
  combinatorial: 'Combinatorial', binary: 'Combinatorial', hdbscan: 'HDBSCAN', agglom: 'Hierarchical',
  minibatch: 'K-means (fast)', kmeans: 'K-means (exact)', graph: 'Neighbourhoods',
};

/**
 * A clustering run's undo label: the method and the parameter it actually
 * takes (K for k-means, the resolution for Neighbourhoods, none otherwise).
 */
export function clusterRunLabel(method: string, k: number, resolution?: number | null): string {
  const name = CLUSTER_METHOD_NAMES[method] ?? method;
  if (method === 'kmeans' || method === 'minibatch') return `Cluster ${name} k=${k}`;
  if (method === 'graph' && resolution != null && Number.isFinite(resolution)) {
    return `Cluster ${name} resolution ${Number(resolution.toFixed(2))}`;
  }
  return `Cluster ${name}`;
}

/** A peak to cluster on: drawn or scanned in a panel (its chromosome and reference when not the main view's). */
export interface ReferencedPeak { start: number; end: number; chrom?: string | null; genome?: string | null }

type ReferenceScopeState = { panels: PanelConfig[]; chrom: string; start: number; end: number };

const isDatasetPanel = (p: PanelConfig) => p.contentType === 'dataset' && !!p.datasetId;
const locusOf = (st: ReferenceScopeState, p: PanelConfig) => p.viewportOverride ?? { chrom: st.chrom, start: st.start, end: st.end };

/**
 * The reference a selected peak is on: its own (scanned on another assembly),
 * else the reference of the panels showing it (a peak drawn in a dm6 panel
 * carries only its chromosome), the main genome first; null: the main genome.
 */
export function peakReference(st: ReferenceScopeState, peak: ReferencedPeak): string | null {
  if (peak.genome) return peak.genome;
  const chrom = peak.chrom ?? st.chrom;
  const showing = st.panels.filter(p => {
    if (!isDatasetPanel(p)) return false;
    const at = locusOf(st, p);
    return sameChrom(at.chrom, chrom) && peak.start < at.end && peak.end > at.start;
  });
  if (showing.length === 0 || showing.some(p => !p.genome)) return null;
  return showing[0].genome ?? null;
}

export type ClusterReferenceScope<W, P> =
  | { ok: true; genome: string | null; windows: W[]; peaks: P[]; leftOut: W[]; note?: string }
  | { ok: false; message: string };

/**
 * Clustering joins reads of one reference only (fb-n3-clusters, audit H1):
 * matched-peak clustering across panels pairs peak i of every window, which
 * means something for copies of a locus on one assembly, nothing across
 * assemblies (human NAPA peaks paired with fly CG9500 peaks).
 *
 * `windows`: the panels to cluster (`result_key` = the panel's state key).
 * Selected peaks on two references of these panels are refused, with the way
 * out; otherwise only the panels on the peaks' reference are clustered (the
 * others are listed in `leftOut` and the note) with that reference's peaks.
 */
export function clusterReferenceScope<W extends { result_key: string }, P extends ReferencedPeak>(
  st: ReferenceScopeState,
  windows: W[],
  peaks: P[],
  referenceName: (genome: string | null) => string,
): ClusterReferenceScope<W, P> {
  const panelReference = (key: string): string | null =>
    st.panels.find(p => isDatasetPanel(p) && (p.stateKey ?? p.datasetId) === key)?.genome ?? null;
  const windowRef = new Map(windows.map(w => [w.result_key, panelReference(w.result_key)]));
  const windowRefs = [...new Set(windowRef.values())];
  const peakRef = peaks.map(p => peakReference(st, p));
  const peakRefs = [...new Set(peakRef)];
  const usable = peakRefs.filter(r => windowRefs.includes(r));
  const names = (refs: Array<string | null>) => {
    const list = refs.map(referenceName);
    return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  };
  if (usable.length > 1) {
    return {
      ok: false,
      message: `Peaks are selected on ${names(usable)}. Reads of two assemblies can't share clusters, so cluster one reference at a time: `
        + 'select the panels of one reference (click a panel’s name) and Cluster again, or clear the other reference’s peaks.',
    };
  }
  if (usable.length === 0) {
    if (windows.length === 0 || peaks.length === 0) return { ok: true, genome: windowRefs[0] ?? null, windows, peaks, leftOut: [] };
    // Two builds of one insertion (each panel's reads give their own consensus) share a name but not a reference.
    if (names(peakRefs) === names(windowRefs)) {
      return {
        ok: false,
        message: `The selected peaks are on another build of ${names(peakRefs)} (a consensus built from another panel's reads), `
          + 'not the one these panels show. Select peaks in the panels to cluster.',
      };
    }
    return {
      ok: false,
      message: `The selected peaks are on ${names(peakRefs)}, but the panels to cluster are on ${names(windowRefs)}. `
        + 'Select peaks in those panels, or select a panel on the peaks’ reference.',
    };
  }
  const genome = usable[0];
  const kept = windows.filter(w => windowRef.get(w.result_key) === genome);
  const leftOut = windows.filter(w => windowRef.get(w.result_key) !== genome);
  const otherRefs = [...new Set(leftOut.map(w => windowRef.get(w.result_key) ?? null))];
  return {
    ok: true,
    genome,
    windows: kept,
    peaks: peaks.filter((_, i) => peakRef[i] === genome),
    leftOut,
    ...(leftOut.length ? {
      note: `${leftOut.length} panel${leftOut.length !== 1 ? 's' : ''} on ${names(otherRefs)} ${leftOut.length !== 1 ? 'were' : 'was'} not clustered: `
        + `the selected peaks are on ${referenceName(genome)}, and reads of two assemblies can't share clusters.`,
    } : {}),
  };
}

/** Resolve the mode assigned to a newly selected peak.
 *
 * Direct toolbar modes are authoritative. A cluster feature rule is scoped
 * independently, so it leaves per-peak modes to the caller/default. Preserve
 * the legacy modification-only fallback when Accessibility is merely the
 * initial store default and the peak track has no footprint source.
 */
function resolvePeakSelectionMode(state: BrowserState, defaultMode?: PeakMode): PeakMode {
  const autoMode = defaultMode ?? (
    state.datasets.length > 0 && state.datasets.every(d =>
      d.available_layers?.mod && !d.available_layers?.footprint
    ) ? 'modification' : 'accessibility'
  );
  if (typeof state.clusterPeakMode !== 'string'
      || state.clusterPeakMode.startsWith(CLUSTER_RULE_MODE_PREFIX)) {
    return autoMode;
  }
  if (state.clusterPeakMode === 'accessibility' && autoMode === 'modification') {
    return autoMode;
  }
  return state.clusterPeakMode;
}

/** The same reads in the same groups (a branch's snapshot and the live assignments of one state key). */
function sameAssignments(a: Record<string, number> | undefined, b: Record<string, number> | undefined): boolean {
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length === 0 || keys.length !== Object.keys(b).length) return false;
  return keys.every(k => a[k] === b[k]);
}

function cloneAssignments(assignments: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  return Object.fromEntries(
    Object.entries(assignments)
      .filter(([, value]) => Object.keys(value).length > 0)
      .map(([key, value]) => [key, { ...value }]),
  );
}

function cloneOrder(order: Record<string, number[]>): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(order).map(([key, value]) => [key, [...value]]),
  );
}

function normalizeClusterOrder(
  clusterIds: number[],
  existingOrder?: number[],
): number[] {
  const clusterSet = new Set(clusterIds);
  const normalized: number[] = [];
  for (const cluster of existingOrder ?? []) {
    if (clusterSet.has(cluster) && !normalized.includes(cluster)) {
      normalized.push(cluster);
    }
  }
  for (const cluster of clusterIds) {
    if (!normalized.includes(cluster)) normalized.push(cluster);
  }
  return normalized;
}

function normalizeClusterOrderRecord(
  assignments: Record<string, Record<string, number>>,
  order: Record<string, number[]>,
): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [key, perRead] of Object.entries(assignments)) {
    const clusterIds = [...new Set(Object.values(perRead))].sort((a, b) => a - b);
    result[key] = normalizeClusterOrder(clusterIds, order[key]);
  }
  return result;
}

function serializeClusterFocus(focus: Record<string, Set<number> | null>): Record<string, number[] | null> {
  return Object.fromEntries(
    Object.entries(focus).map(([key, value]) => [key, value ? [...value] : null]),
  );
}

function deserializeClusterFocus(focus: Record<string, number[] | null>): Record<string, Set<number> | null> {
  return Object.fromEntries(
    Object.entries(focus).map(([key, value]) => [key, value ? new Set(value) : null]),
  );
}

function buildClusterTreeNodeFromState(
  state: BrowserState,
  options: {
    id: string;
    parentId: string | null;
    name: string;
    sourceClusterIds?: number[];
    sourceLabel?: string;
    readScope?: Record<string, string[]>;
  },
): ClusterTreeNode {
  return {
    id: options.id,
    parentId: options.parentId,
    name: options.name,
    createdAt: Date.now(),
    chrom: state.chrom,
    start: state.start,
    end: state.end,
    sourceClusterIds: [...(options.sourceClusterIds ?? [])],
    ...(options.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
    ...(options.readScope ? {
      readScope: Object.fromEntries(
        Object.entries(options.readScope).map(([key, ids]) => [key, [...ids]]),
      ),
    } : {}),
    clusterMethod: state.clusterMethod,
    preparationSamples: { ...state.clusterPreparationSamples },
    preparationCount: state.clusterPreparationCount,
    clusterK: state.clusterK,
    clusterResolution: state.clusterResolution,
    clusterPeakMode: state.clusterPeakMode,
    subnucleosomalThreshold: state.subnucleosomalThreshold,
    accessibilityThreshold: state.accessibilityThreshold,
    clusterFeatureRules: normalizeClusterFeatureRules(state.clusterFeatureRules),
    peakRegions: state.clusterPeakRegions.map(region => ({ ...region })),
    selectedPeakIndices: [...state.selectedPeaks],
    peakModes: { ...state.peakModes },
    patterns: { ...state.clusterPatterns },
    centroids: { ...state.clusterCentroids },
    peakWidths: [...state.clusterPeakWidths],
    dynamicClustering: state.dynamicClustering,
    assignments: cloneAssignments(state.clusterAssignments),
    order: normalizeClusterOrderRecord(state.clusterAssignments, state.clusterOrder),
    focus: serializeClusterFocus(state.clusterFocus),
  };
}

function resolveClusterNodePeakSelection(
  state: BrowserState,
  node: ClusterTreeNode,
): { selectedPeaks: Set<number>; peakModes: Record<number, PeakMode> } {
  const allPeaks = state.getAllPeaks?.() ?? [];
  const selectedPeaks = new Set<number>();
  const peakModes: Record<number, PeakMode> = {};
  const peakByIndex = new Map(allPeaks.map(peak => [peak.index, peak]));

  for (const index of node.selectedPeakIndices ?? []) {
    if (!peakByIndex.has(index)) continue;
    selectedPeaks.add(index);
    const mode = node.peakModes?.[index] as PeakMode | undefined;
    if (mode && mode !== 'accessibility') peakModes[index] = mode;
  }

  for (const region of node.peakRegions) {
    const match = allPeaks.find(peak => (
      peak.start === region.start
      && peak.end === region.end
      && (!region.chrom || !peak.chrom || sameChrom(peak.chrom, region.chrom))
    ));
    if (!match) continue;
    selectedPeaks.add(match.index);
    const mode = (region.mode || 'accessibility') as PeakMode;
    if (mode !== 'accessibility') peakModes[match.index] = mode;
  }

  return { selectedPeaks, peakModes };
}

export type ReadFilterSourceTarget =
  | 'annotation-filter'
  | 'analysis-filter'
  | 'cluster-detail'
  | 'footprint-cooccurrence'
  | 'transcription-filters';

export interface ReadFilterSource {
  target: ReadFilterSourceTarget;
  label: string;
}

// ============================================================
// CLUSTER SLICE — Interface
// ============================================================

export interface ClusterSlice {
  peakDrawMode: boolean;
  peakDrawStart: number | null;
  /** The chromosome the pending peak start was clicked on (its end must be on it too). */
  peakDrawChrom: string | null;

  // Per-dataset profiles
  selectedPeaks: Set<number>;
  /** Features (footprint classes, plugin packs' kinds) selected in the channels above the reads or the panels' lists (stores/featureStore.ts). */
  selectedFeatures: FeatureRef[];
  selectedDatasets: Set<string>;  // Selected panel IDs for scoped operations (maps to dataset IDs via getTargetDatasetIds)
  peakModes: Record<number, PeakMode>;  // Per-peak clustering mode (default: accessibility)
  clusterK: number;
  clusterMethod: string;  // combinatorial, hdbscan, agglom, minibatch, kmeans, graph
  /** Cluster method 'graph': community resolution (higher gives more, smaller clusters). */
  clusterResolution: number;
  /** The latest Clusters > Projection map (coordinates by dataset and read), for the exports. */
  readProjection: ReadProjectionIndex | null;
  subnucleosomalThreshold: number;  // Footprints below this size (bp) are considered accessible (default 90)
  accessibilityThreshold: number;  // Fraction of bases that must be accessible to call peak "open" (default 0.5)
  clusterAssignments: Record<string, Record<string, number>>;  // datasetId -> readId -> cluster
  clusterOrder: Record<string, number[]>;  // datasetId -> ordered array of cluster IDs
  selectedClusters: Record<string, Set<number>>;  // datasetId/stateKey -> selected cluster IDs for manual merge/grouping
  clusterPatterns: Record<number, number[]>;  // clusterId -> binary pattern (for combinatorial clustering)
  clusterCentroids: Record<number, number[]>;  // clusterId -> feature centroid (non-combinatorial dynamic reassignment)
  clusterPeakWidths: number[];  // per-peak feature-column widths (for centroid masking)
  clusterPeakRegions: Array<{ start: number; end: number; mode?: string; chrom?: string; genome?: string }>;  // Peak regions used for clustering (chrom/genome: a panel at another locus or on another assembly)
  dynamicClustering: boolean;  // Whether to dynamically re-cluster as viewport changes
  /** Merge similar clusters: clusters under this share of reads are merged away first, */
  mergeMinFraction: number;
  /** then the smaller of any two whose average profiles are more alike than this (cosine). */
  mergeMaxSimilarity: number;
  /** How two clusters are judged alike ("Merge by"; utils/mergeStrategies.ts). Cosine uses mergeMaxSimilarity. */
  mergeStrategy: MergeStrategy;
  /** Each other strategy's threshold (absent: its default). */
  mergeThresholds: MergeThresholds;
  /** The merges done since the last clustering, to switch back and forth (stores/clusterMergeLog.ts). */
  clusterMergeLog: ClusterMergeLog | null;
  /** Set by a restore: its clusters belong to this view, so don't re-derive them here. */
  restoredClusterViewport: { chrom: string; start: number; end: number } | null;
  dynamicOverlapMode: 'conservative' | 'aggressive';  // Partial-overlap handling for centroid reassignment
  readSortOrder: Record<string, string[]>;  // datasetId -> sorted read ID list
  filteredReadIds: Record<string, Set<string> | null>;  // datasetId -> read ids (from filter operation)
  readFilterSources: Record<string, ReadFilterSource | null>;  // datasetId/stateKey -> provenance for active read filters
  footprintFilterKey: string | null;  // Active co-occupancy filter cell key (persists across panel minimize)
  /** A saved entry whose filter was cleared because its definition changed; the Footprints panel re-applies it. */
  footprintRefilterId: string | null;
  setFootprintRefilterId: (id: string | null) => void;
  activeReadIds: Record<string, string[]>;  // datasetId -> currently displayed/active read IDs
  autozoomDistance: number;  // Distance to search for autozoom (default 1000bp)
  clusterFocus: Record<string, Set<number> | null>;  // datasetId -> focused cluster IDs (null = show all)
  clusterTreeNodes: Record<string, ClusterTreeNode>;  // persistent branch snapshots
  clusterTreeRootIds: string[];
  activeClusterTreeNodeId: string | null;

  // Unified peak mode for clustering (applies to all selected peaks)
  clusterPeakMode: PeakMode;
  clusterFeatureRules: ClusterFeatureRule[];
  savedClusterFeatureRuleSets: ClusterFeatureRuleSet[];
  analysisSortRules: AnalysisSortRule[];
  savedAnalysisSortRuleSets: AnalysisSortRuleSet[];
  analysisFilterRules: AnalysisFilterRule[];
  savedAnalysisFilterRuleSets: AnalysisFilterRuleSet[];

  // Legacy: peakSettings kept for backward-compat reading of old sessions
  peakSettings: {
    smoothWidth: number;
    thresholdStrong: number;
    thresholdMedium: number;
    thresholdWeak: number;
    thresholdRare: number;
  };

  // Gene selection and transcription state filtering
  selectedGenes: Gene[];  // Currently selected genes for transcription state filtering
  transcriptionStateFilters: TranscriptionStateFilters;  // Active state filters
  readStateDetails: Record<string, Record<string, ReadStateInfo>>;  // datasetId -> readId -> state info

  // Colormap
  selectedFootprints: SelectedFootprint[];
  footprintCrossHighlight: boolean;
  footprintGroups: FootprintGroup[];
  /** Co-occupancy > Cluster reads by…: which saved footprints to cluster by, remembered per locus. */
  cooccClusterSelections: ClusterSelection[];
  setCooccClusterSelection: (entry: ClusterSelection) => void;
  /** Ephemeral family selected for visual inspection. Unlike a Cart filter,
   * this keeps every read visible and emphasizes the shared family outline. */
  selectedFamilyGroupId: string | null;

  togglePeakSelection: (index: number, defaultMode?: PeakMode) => void;
  replacePeakSelection: (indices: Iterable<number>, defaultMode?: PeakMode) => void;
  clearPeakSelection: () => void;
  deleteSelectedPeaks: () => void;

  // Panel selection for scoped operations (filter/cluster) — stores panel IDs
  toggleDatasetSelection: (panelId: string) => void;
  clearDatasetSelection: () => void;

  // Peak mode actions for per-peak clustering modes
  cyclePeakMode: (peakIndex: number, allowTf: boolean) => void;
  setPeakMode: (peakIndex: number, mode: PeakMode) => void;
  resetTfModes: () => void;  // Reset all TF modes to accessibility (when switching to combinatorial)
  getPeakMode: (peakIndex: number) => PeakMode;  // Get mode for peak (defaults to accessibility)

  // Custom peak drawing (via peakRuleSlice)
  setPeakDrawMode: (mode: boolean) => void;
  setPeakDrawStart: (pos: number | null, chrom?: string | null) => void;
  /** `genome`: drawn in a panel on another assembly (its reference's key), so it is shown and clustered there only. */
  addCustomPeak: (start: number, end: number, chrom?: string, genome?: string | null, panelId?: string) => void;
  clearCustomPeaks: () => void;

  /** Plain: this feature alone (again: none); additive (shift / ctrl / cmd): toggle it in the selection. */
  selectFeature: (ref: FeatureRef, additive?: boolean) => void;
  setSelectedFeatures: (refs: FeatureRef[]) => void;
  clearFeatureSelection: () => void;
  setClusterK: (k: number) => void;
  setClusterMethod: (method: string) => void;
  setClusterResolution: (resolution: number) => void;
  setReadProjection: (projection: ReadProjectionIndex | null) => void;
  setSubnucleosomalThreshold: (threshold: number) => void;
  setAccessibilityThreshold: (threshold: number) => void;
  setClusterAssignments: (
    datasetId: string,
    assignments: Record<string, number>,
    /** `svSplit`: the SV allele split's own write (keeps its definition and group labels). */
    options?: { mirror?: boolean; merge?: boolean; svSplit?: boolean },
  ) => void;
  setClusterOrder: (datasetId: string, order: number[], options?: { mirror?: boolean }) => void;
  resetClusterState: () => void;
  setClusterSelection: (datasetId: string, clusterIds: Set<number> | number[]) => void;
  /** Drop clusters that no longer exist (dissolved or merged away) from a panel's selection. */
  pruneClusterSelection: (stateKey: string, removed: Iterable<number>) => void;
  toggleClusterSelection: (datasetId: string, clusterId: number) => void;
  clearClusterSelection: (datasetId?: string) => void;
  mergeSelectedClusters: (datasetIds?: string[]) => number;
  setClusterPatterns: (patterns: Record<number, number[]>) => void;
  setClusterCentroids: (centroids: Record<number, number[]>, peakWidths: number[]) => void;
  setClusterPeakRegions: (regions: Array<{ start: number; end: number; mode?: string; chrom?: string; genome?: string }>) => void;
  /**
   * A run over panels at several loci: each panel's own matched peaks (state
   * key -> absolute peaks, as sent), valid while clusterPeakRegions are still
   * that run's `regions` (another run replaces them). The cluster charts plot
   * a panel with its own peaks.
   */
  clusterMatchedRun: ClusterMatchedRun | null;
  clusterWindowPeaks: ClusterWindowPeaks | null;
  setClusterWindowPeaks: (value: ClusterSlice['clusterWindowPeaks']) => void;
  setDynamicClustering: (enabled: boolean) => void;
  setMergeSettings: (settings: { minFraction?: number; maxSimilarity?: number; strategy?: MergeStrategy; threshold?: number }) => void;
  /**
   * Record a merge just applied (Merge, Merge similar clusters, Delete): `before`
   * is the clustering just before it. Call before the step's pushSnapshot.
   */
  recordClusterMerge: (
    before: { assignments: Record<string, Record<string, number>>; order: Record<string, number[]> },
    stateKeys: string[],
    info: { label: string; kind: ClusterMergeKind; settings?: ClusterMergeSettingsRecord },
  ) => void;
  /** Unmerge / merge again: switch between the clustering before the merges and after them (one undo step). */
  toggleClusterMerge: () => boolean;
  /** Split one merged-away cluster back out, keeping the other merges (one undo step). */
  splitBackMergedCluster: (stepId: string, cluster: number) => boolean;
  setDynamicOverlapMode: (mode: 'conservative' | 'aggressive') => void;
  setReadSortOrder: (datasetId: string, order: string[]) => void;
  clearReadSortOrder: () => void;
  setFilteredReadIds: (datasetId: string, ids: Set<string> | null, source?: ReadFilterSource | null) => void;
  setFootprintFilterKey: (key: string | null) => void;
  setActiveReadIds: (datasetId: string, ids: string[]) => void;
  setAutozoomDistance: (distance: number) => void;
  setClusterFocus: (datasetId: string, clusters: Set<number> | null) => void;
  /** Focus these clusters in several panels at once, as one undo step (the read map, its legend). */
  focusClustersIn: (stateKeys: string[], clusters: Set<number> | null, label?: string) => void;
  clearClusterFocus: () => void;
  clearAllFilters: () => void;
  captureActiveClusterTreeNode: (options?: { name?: string }) => string | null;
  createClusterTreeChildFromActive: (parentId: string, options?: { name?: string; sourceClusterIds?: number[]; sourceLabel?: string; readScope?: Record<string, string[]> }) => string | null;
  // Atomically branch the active node into a subcluster child and project it
  // into live state. Non-subset reads of the parent's scope fold into the
  // Unassigned (-1) bucket (hidden by default). The parent node is never
  // mutated, so going back up the tree restores it intact. resultsByKey maps
  // stateKey -> { readId -> new sub-cluster id } from the backend.
  commitSubcluster: (resultsByKey: Record<string, Record<string, number>>, options?: { sourceClusterIds?: number[]; sourceLabel?: string; name?: string; readScope?: Record<string, string[]> }) => string | null;
  /** keepSameSvSplits: the Clusters panel's automatic re-apply of the root after a split into panels cleared the
   * active branch; a branch the user picks always drops SV splits. */
  applyClusterTreeNode: (id: string, options?: { keepSameSvSplits?: boolean }) => void;
  renameClusterTreeNode: (id: string, name: string) => void;
  deleteClusterTreeNode: (id: string) => void;
  syncActiveClusterTreeNode: () => void;

  // Cluster peak mode action
  setClusterPeakMode: (mode: PeakMode) => void;
  setClusterFeatureRules: (rules: ClusterFeatureRule[]) => void;
  addClusterFeatureRule: (rule: ClusterFeatureRule) => void;
  updateClusterFeatureRule: (id: string, updates: Partial<ClusterFeatureRule>) => void;
  removeClusterFeatureRule: (id: string) => void;
  saveClusterFeatureRuleSet: (name: string) => void;
  loadClusterFeatureRuleSet: (name: string) => void;
  deleteClusterFeatureRuleSet: (name: string) => void;
  setDefaultClusterFeatureRuleSet: (name: string | null) => void;
  setAnalysisSortRules: (rules: AnalysisSortRule[]) => void;
  addAnalysisSortRule: (rule: AnalysisSortRule) => void;
  updateAnalysisSortRule: (id: string, updates: Partial<AnalysisSortRule>) => void;
  removeAnalysisSortRule: (id: string) => void;
  saveAnalysisSortRuleSet: (name: string) => void;
  loadAnalysisSortRuleSet: (name: string) => void;
  deleteAnalysisSortRuleSet: (name: string) => void;
  setDefaultAnalysisSortRuleSet: (name: string | null) => void;
  setAnalysisFilterRules: (rules: AnalysisFilterRule[]) => void;
  addAnalysisFilterRule: (rule: AnalysisFilterRule) => void;
  updateAnalysisFilterRule: (id: string, updates: Partial<AnalysisFilterRule>) => void;
  removeAnalysisFilterRule: (id: string) => void;
  saveAnalysisFilterRuleSet: (name: string) => void;
  loadAnalysisFilterRuleSet: (name: string) => void;
  deleteAnalysisFilterRuleSet: (name: string) => void;
  setDefaultAnalysisFilterRuleSet: (name: string | null) => void;

  // Gene selection and transcription state filtering actions
  setSelectedGenes: (genes: Gene[]) => void;
  toggleGeneSelection: (gene: Gene) => void;
  clearGeneSelection: () => void;
  setTranscriptionStateFilters: (filters: Partial<TranscriptionStateFilters>) => void;
  resetTranscriptionStateFilters: () => void;
  setReadStateDetails: (datasetId: string, details: Record<string, ReadStateInfo>) => void;
  clearReadStateDetails: () => void;

  // Peak selection by layer (works across all rules)
  selectPeaksByLayer: (layer: number) => void;

  selectFootprint: (fp: SelectedFootprint, accumulate: boolean) => void;
  clearFootprintSelection: () => void;
  clearFootprintGroups: () => void;
  setFootprintCrossHighlight: (enabled: boolean) => void;
  setSelectedFamilyGroupId: (groupId: string | null) => void;

  // Footprint group actions
  setFootprintGroups: (groups: FootprintGroup[]) => void;
  setAutoFamilyGroups: (sourceViewKey: string, groups: FootprintGroup[]) => void;
  addFootprintGroup: (group: Omit<FootprintGroup, 'id'>) => void;
  updateFootprintGroup: (id: string, updates: Partial<FootprintGroup>) => void;
  removeFootprintGroup: (id: string) => void;

  /** Pinned key-factor motifs per species (utils/pinnedMotifs.ts); null resets a species to the server's defaults. */
  pinnedMotifs: PinnedMotifs;
  setPinnedMotifs: (species: string, names: string[] | null) => void;
  /** Motif scoring shared by the panels (utils/motifSettings.ts): mode and the p-value threshold; the relative
   *  threshold is motifThreshold. */
  motifScoreMode: MotifScoreMode;
  motifPValue: number;
  setMotifScoreMode: (mode: MotifScoreMode) => void;
  setMotifPValue: (p: number) => void;
  customMotifs: CustomMotif[];
  setCustomMotifs: (motifs: CustomMotif[]) => void;

  // Saved clusters cart
  savedClusters: SavedCluster[];
  pendingClusterRestore: string | null;
  saveCurrentClustering: (name?: string) => void;
  removeSavedCluster: (id: string) => void;
  updateSavedClusterName: (id: string, name: string) => void;
  clearSavedClusters: () => void;
  restoreSavedCluster: (id: string) => void;
  setPendingClusterRestore: (id: string | null) => void;

  syncPeaksToBackend: () => Promise<void>;

  // Bookmark actions
}

// ============================================================
// CLUSTER SLICE — Implementation
// ============================================================

/** The fields that decide which reads a saved definition matches. A filter
 * applied with one definition is stale once any of these change. */
function footprintMatchSignature(group: FootprintGroup): string {
  return JSON.stringify([
    group.layer ?? null, group.sizeMin, group.sizeMax ?? null,
    group.referenceAbsStart ?? null, group.referenceAbsEnd ?? null,
    group.minFpCoverage ?? 0, group.minTargetCoverage ?? 0, group.overlapFraction ?? 0, group.overlapMode ?? null,
    group.familyId ?? null, group.familyAnnotationName ?? null, group.minFamilyConfidence ?? 0,
    group.consensusStateId ?? null, group.consensusJobId ?? null, group.sourceDatasetId ?? null, group.consensusDatasetId ?? null,
  ]);
}

/** What decides the reads a saved recaller class (all its entries) matches: per entry its matching rule, strand,
 * tier and stage, plus the channels picked. Name, color and on/off state are cosmetic. */
function savedClassMatchSignature(groups: FootprintGroup[], id: string): string | null {
  const entries = groups.filter(group => group.savedClass?.id === id);
  if (!entries.length) return null;
  return JSON.stringify([
    [...(entries[0].savedClass?.picked ?? [])].sort(),
    entries.map(group => JSON.stringify([footprintMatchSignature(group), group.consensusStrand ?? null,
      group.consensusTier || 'core', group.consensusStage ?? null])).sort(),
  ]);
}

/**
 * A saved-entry filter ("cart:<id>") stays only while that entry exists with
 * an unchanged matching rule; otherwise it is cleared together with its read
 * IDs, so no invisible or stale filter is left behind. State filters don't
 * depend on saved entries; co-occupancy cell filters are reconciled by the
 * panel, which knows the groups they were computed for.
 */
function reconcileFootprintFilter(
  state: Pick<ClusterSlice, 'footprintFilterKey' | 'footprintGroups' | 'filteredReadIds' | 'readFilterSources'>,
  nextGroups: FootprintGroup[],
) {
  const key = state.footprintFilterKey;
  if (!key || !key.startsWith('cart:')) return {};
  if (key.startsWith('cart:saved:')) {
    // A saved class's filter ("cart:saved:<S-id>") covers all of its entries: kept through cosmetic edits and
    // edits to other definitions; cleared when the class is removed or what it matches changes.
    const id = key.slice('cart:saved:'.length);
    const before = savedClassMatchSignature(state.footprintGroups, id);
    const after = savedClassMatchSignature(nextGroups, id);
    if (before !== null && before === after) return {};
    return { ...clearFootprintReadFilters(state), footprintFilterKey: null, footprintRefilterId: null };
  }
  const previous = state.footprintGroups.find(group => `cart:${group.id}` === key);
  const next = nextGroups.find(group => `cart:${group.id}` === key);
  if (previous && next && footprintMatchSignature(previous) === footprintMatchSignature(next)) return {};
  // An edited (not removed) entry gets its filter re-applied once recomputed.
  return { ...clearFootprintReadFilters(state), footprintFilterKey: null, footprintRefilterId: next ? next.id : null };
}

/** Remove read filters that came from the Footprint Analysis panel. */
function clearFootprintReadFilters(state: Pick<ClusterSlice, 'filteredReadIds' | 'readFilterSources'>) {
  const filteredReadIds = { ...state.filteredReadIds };
  const readFilterSources = { ...state.readFilterSources };
  for (const [key, source] of Object.entries(state.readFilterSources)) {
    if (source?.target === 'footprint-cooccurrence') {
      filteredReadIds[key] = null;
      readFilterSources[key] = null;
    }
  }
  return { filteredReadIds, readFilterSources };
}

export function createClusterSlice(set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void, get: () => BrowserState): ClusterSlice {
  /**
   * Show another clustering of the merge log (Unmerge, Merge again, Split back):
   * the read panels, charts and active branch follow; focus and selection keep
   * only clusters that still exist.
   */
  const applyMergeSwitch = (
    assignments: Record<string, Record<string, number>>,
    order: Record<string, number[]>,
    log: ClusterMergeLog | null,
  ) => set(state => {
    const clusterFocus = { ...state.clusterFocus };
    const selectedClusters = { ...state.selectedClusters };
    for (const key of Object.keys(assignments)) {
      if (assignments[key] === state.clusterAssignments[key]) continue;
      const present = new Set(Object.values(assignments[key] ?? {}));
      const focus = clusterFocus[key];
      if (focus) {
        const kept = new Set([...focus].filter(c => present.has(c)));
        clusterFocus[key] = kept.size > 0 ? kept : null;
      }
      const selected = selectedClusters[key];
      if (selected) {
        const kept = new Set([...selected].filter(c => present.has(c)));
        if (kept.size > 0) selectedClusters[key] = kept;
        else delete selectedClusters[key];
      }
    }
    const activeNode = state.activeClusterTreeNodeId ? state.clusterTreeNodes[state.activeClusterTreeNodeId] : null;
    return {
      clusterAssignments: assignments,
      clusterOrder: order,
      clusterMergeLog: log,
      clusterFocus,
      selectedClusters,
      // The reassignment model describes one of the two clusterings only.
      dynamicClustering: false,
      ...(activeNode ? {
        clusterTreeNodes: {
          ...state.clusterTreeNodes,
          [activeNode.id]: {
            ...activeNode,
            assignments: cloneAssignments(assignments),
            order: cloneOrder(order),
            focus: serializeClusterFocus(clusterFocus),
            dynamicClustering: false,
          },
        },
      } : {}),
    };
  });
  const ensureFilterBaseline = () => {
    const state = get();
    if (state._historyStack?.length === 0) {
      state.pushSnapshot?.('Before filter change', { kind: 'filtering' });
    }
  };
  const pushFilterSnapshot = (label: string, coalesceKey?: string) => {
    get().pushSnapshot?.(label, {
      kind: 'filtering',
      coalesceKey,
      coalesceMs: 800,
    });
  };
  return {
  peakDrawMode: false,
  peakDrawStart: null,
  peakDrawChrom: null,

  selectedPeaks: new Set(),
  selectedFeatures: [],
  selectFeature: (ref, additive = false) => set(state => ({ selectedFeatures: nextSelection(state.selectedFeatures, ref, additive) })),
  setSelectedFeatures: refs => set({ selectedFeatures: normalizeFeatureRefs(refs) }),
  clearFeatureSelection: () => set(state => (state.selectedFeatures.length ? { selectedFeatures: [] } : {})),
  selectedDatasets: new Set(),  // No panels selected by default (operations apply to all)
  peakModes: {},  // Per-peak clustering modes (default: accessibility)
  clusterK: 10,
  clusterResolution: 1,
  readProjection: null,
  clusterMethod: 'kmeans',  // KMeans is more usable as a default — produces a meaningful K-cluster grouping out of the box
  subnucleosomalThreshold: 90,  // Default: footprints <90bp are accessible
  accessibilityThreshold: 0.5,  // Default: >50% of bases must be accessible
  clusterAssignments: {},
  clusterOrder: {},
  selectedClusters: {},
  clusterPatterns: {},  // clusterId -> binary pattern for combinatorial clustering
  clusterCentroids: {},  // clusterId -> feature centroid for non-combinatorial dynamic reassignment
  clusterPeakWidths: [],  // per-peak feature-column widths (centroid masking)
  clusterPeakRegions: [],  // Peak regions used for clustering
  clusterMatchedRun: null,
  clusterWindowPeaks: null,
  dynamicClustering: false,  // Dynamic re-clustering as viewport changes
  mergeMinFraction: 0.05,
  mergeMaxSimilarity: 0.95,
  mergeStrategy: 'cosine',
  mergeThresholds: {},
  clusterMergeLog: null,
  restoredClusterViewport: null,
  dynamicOverlapMode: 'aggressive',  // Default: a read is Unassigned only if it overlaps NO clustering peak; partial overlaps still get reassigned
  readSortOrder: {},
  filteredReadIds: {},
  readFilterSources: {},
  footprintFilterKey: null,
  footprintRefilterId: null,
  activeReadIds: {},  // Track currently active/displayed reads per dataset
  autozoomDistance: 1000,  // Default 1kb search distance
  clusterFocus: {},  // No cluster focus by default (show all)
  clusterTreeNodes: {},
  clusterTreeRootIds: [],
  activeClusterTreeNodeId: null,

  // Unified peak mode for clustering
  clusterPeakMode: 'accessibility',
  clusterFeatureRules: getInitialClusterFeatureRules(),
  savedClusterFeatureRuleSets: loadClusterFeatureRuleSetsFromStorage(),
  analysisSortRules: getInitialAnalysisSortRules(),
  savedAnalysisSortRuleSets: loadAnalysisSortRuleSetsFromStorage(),
  analysisFilterRules: getInitialAnalysisFilterRules(),
  savedAnalysisFilterRuleSets: loadAnalysisFilterRuleSetsFromStorage(),

  // Legacy peakSettings (for backward compat — actual thresholds now live on PeakRule)
  peakSettings: {
    smoothWidth: 100,
    thresholdStrong: 0.50,
    thresholdMedium: 0.30,
    thresholdWeak: 0.15,
    thresholdRare: 0.08,
  },

  // Gene selection and transcription state filtering
  selectedGenes: [],
  transcriptionStateFilters: {
    pause: false,
    pic: false,
    elongating: null,
  },
  readStateDetails: {},
  
  // Colormap
  selectedFootprints: [],
  footprintCrossHighlight: true,
  // Persistent cart loaded from localStorage; survives navigation + reload.
  footprintGroups: loadFootprintGroupsFromStorage(),
  cooccClusterSelections: [],
  setCooccClusterSelection: (entry) => set(state => ({
    cooccClusterSelections: rememberClusterSelection(state.cooccClusterSelections, entry),
  })),
  selectedFamilyGroupId: null,

  togglePeakSelection: (index, defaultMode) => set(state => {
    const indices = matchedModeIndices(state, index);
    const selectedPeaks = new Set(state.selectedPeaks), peakModes = { ...state.peakModes };
    const remove = selectedPeaks.has(index);
    const mode = resolvePeakSelectionMode(state, defaultMode);
    for (const i of indices) {
      if (remove) selectedPeaks.delete(i); else selectedPeaks.add(i);
      if (remove || mode === 'accessibility') delete peakModes[i]; else peakModes[i] = mode;
    }
    return { selectedPeaks, peakModes };
  }),

  replacePeakSelection: (indices, defaultMode) => set(state => {
    const selectedPeaks = new Set([...indices].flatMap(i => matchedModeIndices(state, i)));
    const mode = resolvePeakSelectionMode(state, defaultMode);
    const peakModes: Record<number, PeakMode> = {};
    if (mode !== 'accessibility') {
      for (const index of selectedPeaks) peakModes[index] = mode;
    }
    return { selectedPeaks, peakModes };
  }),
  
  clearPeakSelection: () => set({
    selectedPeaks: new Set(),
    peakModes: {},  // Clear peak modes when clearing selection
    clusterAssignments: {},
    clusterOrder: {},
    selectedClusters: {},
    clusterPatterns: {},
    clusterCentroids: {},
    clusterPeakWidths: [],
    clusterPeakRegions: [],
    dynamicClustering: false,
    readSortOrder: {},
    clusterFocus: {},
    clusterTreeNodes: {},
    clusterTreeRootIds: [],
    activeClusterTreeNodeId: null,
    clusterProfiles: {},
    filteredReadIds: {},
    filterMode: 'either',
  }),
  
  deleteSelectedPeaks: () => {
    for (const r of [...get().peakRules]) if (r.source === 'matched' && get().peaksByRule[r.id]?.some(p => get().selectedPeaks.has(p.index))) get().removeMatchedGroup(r.id);
    set(state => {
    // Delete selected peaks from their respective rules' peaksByRule
    const newPeaksByRule = { ...state.peaksByRule };
    const selectedSet = state.selectedPeaks;

    for (const [ruleIdx, rule] of state.peakRules.entries()) {
      const rulePeaks = newPeaksByRule[rule.id];
      if (!rulePeaks) continue;
      const filtered = rulePeaks.filter(p => !selectedSet.has(p.index));
      if (filtered.length !== rulePeaks.length) {
        const offset = computeRuleOffset(ruleIdx);
        newPeaksByRule[rule.id] = filtered.map((p, i) => ({ ...p, index: offset + i }));
      }
    }

    return keepMatched(state, {
      peaksByRule: newPeaksByRule,
      selectedPeaks: new Set(),
      peakModes: {},
    });
  }); },

  // Panel selection for scoped operations — stores panel IDs, link-aware
  // Toggling one member of a link group toggles all linked panels
  toggleDatasetSelection: (panelId) => set(() => {
    const { selectedDatasets, panels } = get() as BrowserState;
    const newSet = new Set(selectedDatasets);
    const panel = panels.find(p => p.id === panelId);
    if (!panel) return {};
    const linkGroup = panel.linkGroup;
    const linkedPanelIds = linkGroup
      ? panels.filter(p => p.linkGroup === linkGroup).map(p => p.id)
      : [panelId];
    if (newSet.has(panelId)) {
      for (const id of linkedPanelIds) newSet.delete(id);
    } else {
      for (const id of linkedPanelIds) newSet.add(id);
    }
    return { selectedDatasets: newSet };
  }),

  clearDatasetSelection: () => set({ selectedDatasets: new Set() }),

  // Peak mode actions for per-peak clustering
  // Shift+click cycles canonical user-facing modes. The backend keeps
  // tf_layer/nuc_layer aliases for older sessions, but new UI actions use
  // tf/nuc so the mode names match the toolbar and exported BED labels.
  cyclePeakMode: (peakIndex, allowTf) => set(state => {
    const currentMode = state.peakModes[peakIndex] || 'accessibility';
    // Include v3 layer modes when loaded datasets actually expose those
    // layers. Visibility toggles default primary TF/nuc on, but toggles alone
    // should not make layer-specific peak modes appear before data exists.
    const hasLayer = (name: string) =>
      state.datasets.some(dataset => !!dataset.available_layers?.[name]);
    const hasV3Nuc = hasLayer('nuc');
    const hasV3Tf = hasLayer('tf');

    const cycle: PeakMode[] = ['accessibility'];
    if (allowTf) cycle.push('tf');
    cycle.push('modification', 'fire');
    if (hasV3Tf && !cycle.includes('tf')) cycle.push('tf');
    if (hasV3Nuc) cycle.push('nuc');

    const idx = cycle.indexOf(currentMode);
    const nextMode: PeakMode = cycle[(idx + 1) % cycle.length];

    const newModes = { ...state.peakModes };
    if (nextMode === 'accessibility') {
      for (const i of matchedModeIndices(state, peakIndex)) delete newModes[i];  // Remove default mode entry
    } else {
      for (const i of matchedModeIndices(state, peakIndex)) newModes[i] = nextMode;
    }

    return { peakModes: newModes };
  }),

  setPeakMode: (peakIndex, mode) => set(state => {
    const newModes = { ...state.peakModes };
    if (mode === 'accessibility') {
      for (const i of matchedModeIndices(state, peakIndex)) delete newModes[i];  // Remove default mode
    } else {
      for (const i of matchedModeIndices(state, peakIndex)) newModes[i] = mode;
    }
    return { peakModes: newModes };
  }),

  resetTfModes: () => set(state => {
    // Reset any TF modes to accessibility (keep modification modes)
    const newModes: Record<number, PeakMode> = {};
    for (const [idx, mode] of Object.entries(state.peakModes)) {
      if (mode !== 'tf') {
        newModes[Number(idx)] = mode;
      }
    }
    return { peakModes: newModes };
  }),

  getPeakMode: (peakIndex) => {
    return get().peakModes[peakIndex] || 'accessibility';
  },

  // Custom peak drawing
  setPeakDrawMode: (mode) => set({ peakDrawMode: mode, peakDrawStart: null, peakDrawChrom: null }),
  setPeakDrawStart: (pos, chrom) => set({ peakDrawStart: pos, peakDrawChrom: pos === null ? null : (chrom ?? null) }),
  
  addCustomPeak: (start, end, chrom?, genome?, panelId?) => set(state => {
    const normStart = Math.min(start, end);
    const normEnd = Math.max(start, end);
    const customRuleId = state.getCustomRuleId();
    const customPeaks = state.peaksByRule[customRuleId] || [];
    // Dedup: skip a peak with identical coords on the same chromosome (an
    // untagged peak is on the main view's).
    const peakChrom = chrom ?? state.chrom;
    if (state.getAllPeaks().some(p => p.ruleId === customRuleId && p.start === normStart && p.end === normEnd
      && sameChrom(p.chrom ?? state.chrom, peakChrom) && (p.genome ?? null) === (genome ?? null))) return {};
    const ruleIdx = state.peakRules.findIndex(r => r.id === customRuleId);
    const offset = ruleIdx >= 0 ? computeRuleOffset(ruleIdx) : 0;
    // Past every surviving custom peak's index: peaks drawn in a panel at another
    // locus can outlive earlier ones (pruned on navigation), so length alone
    // could hand out an index still in use.
    const newIndex = Math.max(offset + customPeaks.length, ...customPeaks.map(p => p.index + 1));
    const newPeak: FirePeak = {
      start: normStart,
      end: normEnd,
      index: newIndex,
      layer: 0,
      isCustom: true,
      ruleId: customRuleId,
      ...(panelId && state.getAllPeaks().some(p => p.match && !p.match.correspondenceId && p.start <= normStart && p.end >= normEnd
        && sameChrom(p.chrom ?? state.chrom, peakChrom) && (p.genome ?? null) === (genome ?? null)) ? { memberPanelId: panelId } : {}),
      ...(chrom ? { chrom } : {}),
      ...(genome ? { genome } : {}),
    };
    return {
      peaksByRule: { ...state.peaksByRule, [customRuleId]: [...customPeaks, newPeak] },
      peakDrawStart: null,
      peakDrawChrom: null,
    };
  }),
  
  clearCustomPeaks: () => set(state => {
    const customRuleId = state.getCustomRuleId();
    const customPeakIndices = new Set((state.peaksByRule[customRuleId] || []).map(p => p.index));
    const newPeaksByRule = { ...state.peaksByRule };
    delete newPeaksByRule[customRuleId];
    return {
      peaksByRule: newPeaksByRule,
      selectedPeaks: new Set([...state.selectedPeaks].filter(i => !customPeakIndices.has(i))),
    };
  }),
  
  setClusterK: (k) => set({ clusterK: k }),
  setClusterMethod: (method: string) => set({ clusterMethod: method }),
  setClusterResolution: (resolution) => set({ clusterResolution: resolution }),
  setReadProjection: (projection) => set({ readProjection: projection }),
  setSubnucleosomalThreshold: (threshold) => set({ subnucleosomalThreshold: threshold }),
  setAccessibilityThreshold: (threshold) => set({ accessibilityThreshold: threshold }),
  setClusterAssignments: (datasetId, assignments, options) => set(state => {
    // A navigation-driven dynamic pass only covers reads returned for its
    // viewport. Seed from the immutable active-node snapshot, then merge live
    // and returned labels so a partial pass cannot silently shrink the cohort
    // and become `filter_ids` on the next layer/methylation refetch. The saved
    // floor also repairs tabs contracted by an older build. Authoritative user
    // actions continue to replace the map wholesale.
    const activeSnapshotAssignments = state.activeClusterTreeNodeId
      ? state.clusterTreeNodes[state.activeClusterTreeNodeId]?.assignments[datasetId]
      : undefined;
    const nextAssignments = options?.merge
      ? {
          ...(activeSnapshotAssignments ?? {}),
          ...(state.clusterAssignments[datasetId] ?? {}),
          ...assignments,
        }
      : assignments;
    // Auto-initialize cluster order if not set
    const clusterIds = [...new Set(Object.values(nextAssignments))].sort((a, b) => a - b);
    const existingOrder = state.clusterOrder[datasetId];
    const newOrder = normalizeClusterOrder(clusterIds, existingOrder);
    const clusterAssignments = { ...state.clusterAssignments, [datasetId]: nextAssignments };
    const clusterOrder = { ...state.clusterOrder, [datasetId]: newOrder };
    // Another grouping replaces an SV allele split's groups: its names go too.
    const dropSvSplit = !options?.svSplit && (datasetId in (state.svSplits ?? {}) || datasetId in (state.clusterGroupLabels ?? {}));
    const svReset = dropSvSplit ? (() => {
      const svSplits = { ...state.svSplits };
      const clusterGroupLabels = { ...state.clusterGroupLabels };
      delete svSplits[datasetId];
      delete clusterGroupLabels[datasetId];
      return { svSplits, clusterGroupLabels };
    })() : {};
    // Tree nodes are immutable snapshots. Navigation/dynamic passes must not
    // mirror their (partial, viewport-specific) results back into the active
    // node, or returning up the tree would restore corrupted state.
    const mirror = options?.mirror !== false;
    const activeNode = mirror && state.activeClusterTreeNodeId ? state.clusterTreeNodes[state.activeClusterTreeNodeId] : null;
    return {
      clusterAssignments,
      clusterOrder,
      ...svReset,
      ...(activeNode ? {
        clusterTreeNodes: {
          ...state.clusterTreeNodes,
          [activeNode.id]: {
            ...activeNode,
            assignments: cloneAssignments(clusterAssignments),
            order: cloneOrder(clusterOrder),
          },
        },
      } : {}),
    };
  }),
  setClusterOrder: (datasetId, order, options) => set(state => ({
    clusterOrder: { ...state.clusterOrder, [datasetId]: order },
    ...(options?.mirror !== false && state.activeClusterTreeNodeId && state.clusterTreeNodes[state.activeClusterTreeNodeId] ? {
      clusterTreeNodes: {
        ...state.clusterTreeNodes,
        [state.activeClusterTreeNodeId]: {
          ...state.clusterTreeNodes[state.activeClusterTreeNodeId],
          order: cloneOrder({ ...state.clusterOrder, [datasetId]: order }),
        },
      },
    } : {}),
  })),
  resetClusterState: () => {
    const state = get();
    const hasClusters =
      hasAnyClusterAssignments(state.clusterAssignments) ||
      Object.keys(state.clusterTreeNodes).length > 0 ||
      Object.keys(state.clusterOrder).length > 0 ||
      Object.keys(state.readSortOrder).length > 0 ||
      Object.keys(state.clusterFocus).length > 0;
    if (!hasClusters) return;
    if ((state._historyStack?.length ?? 0) === 0) {
      state.pushSnapshot?.('Before clearing clusters', { kind: 'clustering' });
    }
    set({
      clusterAssignments: {},
      clusterPreparationSamples: {},
      clusterOrder: {},
      selectedClusters: {},
      clusterPatterns: {},
      clusterCentroids: {},
      clusterPeakWidths: [],
      clusterPeakRegions: [],
      dynamicClustering: false,
      readSortOrder: {},
      clusterFocus: {},
      clusterTreeNodes: {},
      clusterTreeRootIds: [],
      activeClusterTreeNodeId: null,
      clusterProfiles: {},
      svSplits: {},
      clusterGroupLabels: {},
    });
    get().pushSnapshot?.('Clear clusters', { kind: 'clustering' });
  },
  setClusterSelection: (datasetId, clusterIds) => set(state => {
    const next = clusterIds instanceof Set ? new Set(clusterIds) : new Set(clusterIds);
    const selectedClusters = { ...state.selectedClusters };
    for (const key of clusterSelectionKeys(state, datasetId)) {
      if (next.size === 0) delete selectedClusters[key];
      else selectedClusters[key] = new Set(next);
    }
    return { selectedClusters };
  }),
  pruneClusterSelection: (stateKey, removed) => set(state => {
    const current = state.selectedClusters[stateKey];
    if (!current) return state;
    const gone = new Set(removed);
    const next = new Set([...current].filter(id => !gone.has(id)));
    if (next.size === current.size) return state;
    const selectedClusters = { ...state.selectedClusters };
    if (next.size === 0) delete selectedClusters[stateKey];
    else selectedClusters[stateKey] = next;
    return { selectedClusters };
  }),
  toggleClusterSelection: (datasetId, clusterId) => set(state => {
    const current = state.selectedClusters[datasetId] ?? new Set<number>();
    const next = new Set(current);
    if (next.has(clusterId)) next.delete(clusterId);
    else next.add(clusterId);
    const selectedClusters = { ...state.selectedClusters };
    for (const key of clusterSelectionKeys(state, datasetId)) {
      if (next.size === 0) delete selectedClusters[key];
      else selectedClusters[key] = new Set(next);
    }
    return { selectedClusters };
  }),
  clearClusterSelection: (datasetId) => set(state => {
    if (!datasetId) return { selectedClusters: {} };
    const selectedClusters = { ...state.selectedClusters };
    for (const key of clusterSelectionKeys(state, datasetId)) delete selectedClusters[key];
    return { selectedClusters };
  }),
  mergeSelectedClusters: (datasetIds) => {
    const before = get();
    const targetKeys = datasetIds?.length ? datasetIds : Object.keys(before.selectedClusters);
    if (targetKeys.length === 0) return 0;

    const clusterAssignments = { ...before.clusterAssignments };
    const clusterOrder = { ...before.clusterOrder };
    const clusterFocus = { ...before.clusterFocus };
    let mergedKeys = 0;
    const changedKeys: string[] = [];
    const mergedIds = new Set<number>();

    for (const key of targetKeys) {
      const selected = before.selectedClusters[key];
      const assignments = before.clusterAssignments[key];
      if (!selected || selected.size < 2 || !assignments) continue;

      const assignedClusters = new Set(Object.values(assignments));
      const selectedExisting = [...selected].filter(cluster => assignedClusters.has(cluster));
      if (selectedExisting.length < 2) continue;

      const selectedSet = new Set(selectedExisting);
      const order = before.clusterOrder[key]?.length
        ? before.clusterOrder[key]
        : [...assignedClusters].sort((a, b) => a - b);
      const targetCluster = order.find(cluster => selectedSet.has(cluster) && cluster !== UNASSIGNED_CLUSTER_ID)
        ?? order.find(cluster => selectedSet.has(cluster))
        ?? Math.min(...selectedExisting);
      const removedClusters = new Set(selectedExisting.filter(cluster => cluster !== targetCluster));

      const nextAssignments = Object.fromEntries(
        Object.entries(assignments).map(([readId, cluster]) => [
          readId,
          selectedSet.has(cluster) ? targetCluster : cluster,
        ]),
      );
      const remainingClusters = new Set(Object.values(nextAssignments));
      const nextOrder = order
        .filter(cluster => remainingClusters.has(cluster) && !removedClusters.has(cluster))
        .filter((cluster, idx, arr) => arr.indexOf(cluster) === idx);
      for (const cluster of [...remainingClusters].sort((a, b) => a - b)) {
        if (!nextOrder.includes(cluster)) nextOrder.push(cluster);
      }

      clusterAssignments[key] = nextAssignments;
      clusterOrder[key] = nextOrder;
      if (clusterFocus[key] && selectedExisting.some(cluster => clusterFocus[key]?.has(cluster))) {
        clusterFocus[key] = null;
      }
      mergedKeys += 1;
      changedKeys.push(key);
      for (const cluster of selectedExisting) mergedIds.add(cluster);
    }

    if (mergedKeys === 0) return 0;
    const state = get();
    if ((state._historyStack?.length ?? 0) === 0) {
      state.pushSnapshot?.('Before cluster merge', { kind: 'clustering' });
    }
    set({
      clusterAssignments,
      clusterOrder,
      clusterFocus,
      selectedClusters: {},
      // Reassignment's patterns/centroids still describe the clusters before
      // the merge; left on, the next pan would split the merged cluster again.
      dynamicClustering: false,
      ...(state.activeClusterTreeNodeId && state.clusterTreeNodes[state.activeClusterTreeNodeId] ? {
        clusterTreeNodes: {
          ...state.clusterTreeNodes,
          [state.activeClusterTreeNodeId]: {
            ...state.clusterTreeNodes[state.activeClusterTreeNodeId],
            assignments: cloneAssignments(clusterAssignments),
            order: cloneOrder(clusterOrder),
            focus: serializeClusterFocus(clusterFocus),
            dynamicClustering: false,
          },
        },
      } : {}),
    });
    // Recorded for Unmerge (stores/clusterMergeLog.ts).
    get().recordClusterMerge(
      { assignments: before.clusterAssignments, order: before.clusterOrder },
      changedKeys,
      { label: `Merge ${[...mergedIds].sort((a, b) => a - b).map(c => (c === UNASSIGNED_CLUSTER_ID ? 'Unassigned' : `C${c}`)).join(', ')}`, kind: 'manual' },
    );
    get().pushSnapshot?.('Merge selected clusters', { kind: 'clustering' });
    return mergedKeys;
  },
  setClusterPatterns: (patterns) => set(state => ({
    clusterPatterns: patterns,
    ...(state.activeClusterTreeNodeId && state.clusterTreeNodes[state.activeClusterTreeNodeId] ? {
      clusterTreeNodes: {
        ...state.clusterTreeNodes,
        [state.activeClusterTreeNodeId]: {
          ...state.clusterTreeNodes[state.activeClusterTreeNodeId],
          patterns: { ...patterns },
        },
      },
    } : {}),
  })),
  setClusterCentroids: (centroids, peakWidths) => set(state => ({
    clusterCentroids: centroids,
    clusterPeakWidths: peakWidths,
    ...(state.activeClusterTreeNodeId && state.clusterTreeNodes[state.activeClusterTreeNodeId] ? {
      clusterTreeNodes: {
        ...state.clusterTreeNodes,
        [state.activeClusterTreeNodeId]: {
          ...state.clusterTreeNodes[state.activeClusterTreeNodeId],
          centroids: { ...centroids },
          peakWidths: [...peakWidths],
        },
      },
    } : {}),
  })),
  setDynamicOverlapMode: (mode) => set({ dynamicOverlapMode: mode }),
  setClusterWindowPeaks: (value) => set({ clusterWindowPeaks: value }),
  setClusterPeakRegions: (regions) => set(state => ({
    clusterPeakRegions: regions,
    ...(state.activeClusterTreeNodeId && state.clusterTreeNodes[state.activeClusterTreeNodeId] ? {
      clusterTreeNodes: {
        ...state.clusterTreeNodes,
        [state.activeClusterTreeNodeId]: {
          ...state.clusterTreeNodes[state.activeClusterTreeNodeId],
          peakRegions: regions.map(region => ({ ...region })),
        },
      },
    } : {}),
  })),
  setMergeSettings: ({ minFraction, maxSimilarity, strategy, threshold }) => set(state => {
    const nextStrategy = isMergeStrategy(strategy) ? strategy : state.mergeStrategy;
    const finite = (v: number | undefined): v is number => v != null && Number.isFinite(v);
    // `threshold` is the chosen (or given) strategy's; cosine's is mergeMaxSimilarity.
    const cosine = nextStrategy === 'cosine' && finite(threshold) ? threshold : maxSimilarity;
    return {
      mergeMinFraction: finite(minFraction) ? Math.min(0.5, Math.max(0, minFraction)) : state.mergeMinFraction,
      mergeMaxSimilarity: finite(cosine) ? Math.min(1, Math.max(0.5, cosine)) : state.mergeMaxSimilarity,
      mergeStrategy: nextStrategy,
      mergeThresholds: nextStrategy !== 'cosine' && finite(threshold)
        ? { ...state.mergeThresholds, [nextStrategy]: clampMergeThreshold(nextStrategy, threshold) }
        : state.mergeThresholds,
    };
  }),
  recordClusterMerge: (before, stateKeys, info) => {
    const state = get();
    const log = recordMergeStep(
      state.clusterMergeLog,
      before,
      { assignments: state.clusterAssignments, order: state.clusterOrder },
      stateKeys,
      info,
    );
    if (log !== state.clusterMergeLog) set({ clusterMergeLog: log });
  },
  toggleClusterMerge: () => {
    const state = get();
    const log = state.clusterMergeLog;
    if (!log) return false;
    const next = toggleMerge(log, { assignments: state.clusterAssignments, order: state.clusterOrder });
    if (!next) return false;
    seedHistoryBaseline(state, 'Before unmerging clusters', 'clustering');
    applyMergeSwitch(next.assignments, next.order, next.log);
    get().pushSnapshot?.(next.log.showing === 'original' ? 'Unmerge clusters' : 'Merge clusters again', { kind: 'clustering' });
    return true;
  },
  splitBackMergedCluster: (stepId, cluster) => {
    const state = get();
    const log = state.clusterMergeLog;
    if (!log) return false;
    const next = splitBackCluster(log, { assignments: state.clusterAssignments, order: state.clusterOrder }, stepId, cluster);
    if (!next) return false;
    seedHistoryBaseline(state, 'Before splitting a cluster back', 'clustering');
    applyMergeSwitch(next.assignments, next.order, next.log);
    get().pushSnapshot?.(`Split C${cluster} back`, { kind: 'clustering' });
    return true;
  },
  setDynamicClustering: (enabled) => set(state => ({
    dynamicClustering: enabled,
    ...(state.activeClusterTreeNodeId && state.clusterTreeNodes[state.activeClusterTreeNodeId] ? {
      clusterTreeNodes: {
        ...state.clusterTreeNodes,
        [state.activeClusterTreeNodeId]: {
          ...state.clusterTreeNodes[state.activeClusterTreeNodeId],
          dynamicClustering: enabled,
        },
      },
    } : {}),
  })),
  setReadSortOrder: (datasetId, order) => set(state => ({
    readSortOrder: { ...state.readSortOrder, [datasetId]: order }
  })),
  clearReadSortOrder: () => set({ readSortOrder: {} }),
  setFilteredReadIds: (datasetId, ids, source) => set(state => {
    const nextSources = { ...state.readFilterSources };
    if (!ids) {
      nextSources[datasetId] = null;
    } else if (source !== undefined) {
      nextSources[datasetId] = source;
    }
    return {
      filteredReadIds: { ...state.filteredReadIds, [datasetId]: ids },
      readFilterSources: nextSources,
    };
  }),
  // An explicit filter choice (or clear) cancels a pending saved-entry refilter.
  setFootprintFilterKey: (key) => set({ footprintFilterKey: key, footprintRefilterId: null }),
  setFootprintRefilterId: (id) => set({ footprintRefilterId: id }),
  setActiveReadIds: (datasetId, ids) => set(state => ({
    activeReadIds: { ...state.activeReadIds, [datasetId]: ids }
  })),
  setAutozoomDistance: (distance) => set({ autozoomDistance: distance }),
  
  setClusterFocus: (datasetId, clusters) => {
    ensureFilterBaseline();
    set(state => {
      const clusterFocus = { ...state.clusterFocus };
      for (const key of clusterSelectionKeys(state, datasetId)) clusterFocus[key] = clusters ? new Set(clusters) : null;
      return {
        clusterFocus,
        ...(state.activeClusterTreeNodeId && state.clusterTreeNodes[state.activeClusterTreeNodeId] ? {
          clusterTreeNodes: {
            ...state.clusterTreeNodes,
            [state.activeClusterTreeNodeId]: {
              ...state.clusterTreeNodes[state.activeClusterTreeNodeId],
              focus: serializeClusterFocus(clusterFocus),
            },
          },
        } : {}),
      };
    });
    pushFilterSnapshot('Set cluster focus', `cluster-focus:${datasetId}`);
  },
  focusClustersIn: (stateKeys, clusters, label) => {
    if (stateKeys.length === 0) return;
    // Each click its own step (as the cluster list's Hide / Hide others), not coalesced like typed filters.
    seedHistoryBaseline(get(), 'Before cluster focus', 'clustering');
    set(state => {
      const clusterFocus = { ...state.clusterFocus };
      for (const key of new Set(stateKeys.flatMap(key => clusterSelectionKeys(state, key)))) clusterFocus[key] = clusters ? new Set(clusters) : null;
      return {
        clusterFocus,
        ...(state.activeClusterTreeNodeId && state.clusterTreeNodes[state.activeClusterTreeNodeId] ? {
          clusterTreeNodes: {
            ...state.clusterTreeNodes,
            [state.activeClusterTreeNodeId]: {
              ...state.clusterTreeNodes[state.activeClusterTreeNodeId],
              focus: serializeClusterFocus(clusterFocus),
            },
          },
        } : {}),
      };
    });
    get().pushSnapshot?.(label ?? (clusters ? 'Set cluster focus' : 'Clear cluster focus'), { kind: 'clustering' });
  },
  clearClusterFocus: () => {
    // Nothing focused: nothing to clear, and no history step.
    const current = get();
    const node = current.activeClusterTreeNodeId ? current.clusterTreeNodes[current.activeClusterTreeNodeId] : undefined;
    const focused = (focus: Record<string, unknown> | undefined) => Object.values(focus ?? {}).some(v => v != null);
    if (!focused(current.clusterFocus) && !focused(node?.focus as Record<string, unknown> | undefined)) return;
    ensureFilterBaseline();
    set(state => ({
      clusterFocus: {},
      ...(state.activeClusterTreeNodeId && state.clusterTreeNodes[state.activeClusterTreeNodeId] ? {
        clusterTreeNodes: {
          ...state.clusterTreeNodes,
          [state.activeClusterTreeNodeId]: {
            ...state.clusterTreeNodes[state.activeClusterTreeNodeId],
            focus: {},
          },
        },
      } : {}),
    }));
    pushFilterSnapshot('Clear cluster focus', 'cluster-focus:all');
  },

  syncActiveClusterTreeNode: () => set(state => {
    const id = state.activeClusterTreeNodeId;
    if (!id || !state.clusterTreeNodes[id] || !hasAnyClusterAssignments(state.clusterAssignments)) return {};
    const current = state.clusterTreeNodes[id];
    return {
      clusterTreeNodes: {
        ...state.clusterTreeNodes,
        [id]: buildClusterTreeNodeFromState(state, {
          id,
          parentId: current.parentId,
          name: current.name,
          sourceClusterIds: current.sourceClusterIds,
          sourceLabel: current.sourceLabel,
          readScope: current.readScope,
        }),
      },
    };
  }),

  captureActiveClusterTreeNode: (options) => {
    const state = get();
    if (!hasAnyClusterAssignments(state.clusterAssignments)) return null;
    const existingId = state.activeClusterTreeNodeId;
    const id = existingId ?? crypto.randomUUID();
    const existing = existingId ? state.clusterTreeNodes[existingId] : undefined;
    const node = buildClusterTreeNodeFromState(state, {
      id,
      parentId: existing?.parentId ?? null,
      name: options?.name ?? existing?.name ?? 'All reads',
      sourceClusterIds: existing?.sourceClusterIds ?? [],
      sourceLabel: existing?.sourceLabel,
      readScope: existing?.readScope,
    });
    set(current => ({
      clusterTreeNodes: { ...current.clusterTreeNodes, [id]: node },
      clusterTreeRootIds: node.parentId === null && !current.clusterTreeRootIds.includes(id)
        ? [...current.clusterTreeRootIds, id]
        : current.clusterTreeRootIds,
      activeClusterTreeNodeId: id,
    }));
    return id;
  },

  createClusterTreeChildFromActive: (parentId, options) => {
    const state = get();
    if (!hasAnyClusterAssignments(state.clusterAssignments) || !state.clusterTreeNodes[parentId]) return null;
    const id = crypto.randomUUID();
    const sourceClusterIds = options?.sourceClusterIds ?? [];
    const sourceLabel = options?.sourceLabel ?? (
      sourceClusterIds.length > 0
        ? `from ${sourceClusterIds.map(cluster => cluster === UNASSIGNED_CLUSTER_ID ? 'Unassigned' : `C${cluster}`).join(', ')}`
        : 'subcluster'
    );
    const name = options?.name ?? (
      sourceClusterIds.length > 0
        ? `Subcluster ${sourceClusterIds.map(cluster => cluster === UNASSIGNED_CLUSTER_ID ? 'Unassigned' : cluster).join('+')}`
        : 'Subcluster'
    );
    const node = buildClusterTreeNodeFromState(state, {
      id,
      parentId,
      name,
      sourceClusterIds,
      sourceLabel,
      readScope: options?.readScope,
    });
    set(current => ({
      clusterTreeNodes: { ...current.clusterTreeNodes, [id]: node },
      activeClusterTreeNodeId: id,
      selectedClusters: {},
    }));
    return id;
  },

  commitSubcluster: (resultsByKey, options) => {
    const state = get();
    const parentId = state.activeClusterTreeNodeId;
    const parent = parentId ? state.clusterTreeNodes[parentId] : null;
    if (!parent) return null;

    const sourceClusterIds = options?.sourceClusterIds ?? [];
    const sourceLabel = options?.sourceLabel ?? (
      sourceClusterIds.length > 0
        ? `from ${sourceClusterIds.map(cluster => cluster === UNASSIGNED_CLUSTER_ID ? 'Unassigned' : `C${cluster}`).join(', ')}`
        : 'subcluster'
    );
    const name = options?.name ?? (
      sourceClusterIds.length > 0
        ? `Subcluster ${sourceClusterIds.map(cluster => cluster === UNASSIGNED_CLUSTER_ID ? 'Unassigned' : cluster).join('+')}`
        : 'Subcluster'
    );

    // Build the child's self-contained assignment for every read in the parent's
    // scope: subset reads keep their new sub-cluster id, everyone else folds into
    // the Unassigned (-1) dead bucket and is hidden by default.
    const childAssignments: Record<string, Record<string, number>> = {};
    const childFocus: Record<string, number[] | null> = {};
    const keys = new Set([...Object.keys(parent.assignments), ...Object.keys(resultsByKey)]);
    for (const sk of keys) {
      const parentAssigns = parent.assignments[sk] ?? {};
      const result = resultsByKey[sk] ?? {};
      const merged: Record<string, number> = {};
      for (const id of Object.keys(parentAssigns)) merged[id] = result[id] ?? UNASSIGNED_CLUSTER_ID;
      for (const [id, cluster] of Object.entries(result)) if (!(id in merged)) merged[id] = cluster;
      if (Object.keys(merged).length === 0) continue;
      childAssignments[sk] = merged;
      const ids = new Set(Object.values(merged));
      const hasUnassigned = ids.delete(UNASSIGNED_CLUSTER_ID);
      childFocus[sk] = hasUnassigned && ids.size > 0 ? [...ids] : null;
    }
    if (Object.keys(childAssignments).length === 0) return null;

    const id = crypto.randomUUID();
    const node: ClusterTreeNode = {
      ...buildClusterTreeNodeFromState(state, { id, parentId, name, sourceClusterIds, sourceLabel, readScope: options?.readScope }),
      assignments: cloneAssignments(childAssignments),
      order: normalizeClusterOrderRecord(childAssignments, {}),
      focus: childFocus,
    };

    // Single atomic write: create child, make it active, and project it into the
    // live (flat) state the renderer reads. No detach-to-null, so no React effect
    // can re-apply and corrupt the parent mid-operation.
    set(current => ({
      ...withoutSvSplits(current, Object.keys(childAssignments)),
      clusterTreeNodes: { ...current.clusterTreeNodes, [id]: node },
      activeClusterTreeNodeId: id,
      selectedClusters: {},
      clusterAssignments: cloneAssignments(childAssignments),
      clusterOrder: normalizeClusterOrderRecord(childAssignments, {}),
      clusterFocus: deserializeClusterFocus(childFocus),
    }));
    return id;
  },

  applyClusterTreeNode: (id, options) => {
    const state = get();
    const node = state.clusterTreeNodes[id];
    if (!node) return;
    const restoredPeaks = resolveClusterNodePeakSelection(state, node);
    // A tree branch is an ordinary clustering: no SV allele split names its groups. Except when the Clusters panel
    // re-applies the root by itself because a split into panels cleared the active branch: there a split whose groups
    // are the branch's own (the same reads in the same groups) stays, or the split it had just captured was dropped
    // (the Carriers never opened expanded with the Clusters panel open; integ/fb40, docking-policy e2e).
    const sameGroups = (key: string) => Boolean(options?.keepSameSvSplits)
      && sameAssignments(node.assignments[key], state.clusterAssignments[key]);
    const kept = withoutSvSplits(state, [...Object.keys(state.svSplits ?? {}), ...Object.keys(state.clusterGroupLabels ?? {})]
      .filter(key => !sameGroups(key)));
    set({
      activeClusterTreeNodeId: id,
      svSplits: kept.svSplits,
      clusterGroupLabels: kept.clusterGroupLabels,
      clusterAssignments: cloneAssignments(node.assignments),
      clusterOrder: normalizeClusterOrderRecord(node.assignments, node.order),
      clusterFocus: deserializeClusterFocus(node.focus),
      clusterPatterns: { ...node.patterns },
      clusterCentroids: { ...(node.centroids ?? {}) },
      clusterPeakWidths: [...(node.peakWidths ?? [])],
      clusterPeakRegions: node.peakRegions.map(region => ({ ...region })),
      dynamicClustering: node.dynamicClustering,
      clusterPreparationSamples: node.preparationSamples ?? {},
      clusterPreparationCount: node.preparationCount ?? null,
      selectedPeaks: restoredPeaks.selectedPeaks,
      peakModes: restoredPeaks.peakModes,
      clusterMethod: node.clusterMethod,
      clusterK: node.clusterK,
      clusterResolution: node.clusterResolution ?? 1,
      clusterPeakMode: (node.clusterPeakMode || state.clusterPeakMode) as PeakMode,
      subnucleosomalThreshold: node.subnucleosomalThreshold,
      accessibilityThreshold: node.accessibilityThreshold,
      ...(node.clusterFeatureRules ? { clusterFeatureRules: normalizeClusterFeatureRules(node.clusterFeatureRules) } : {}),
      selectedClusters: {},
    });
  },

  renameClusterTreeNode: (id, name) => set(state => {
    const node = state.clusterTreeNodes[id];
    if (!node) return {};
    const nextName = name.slice(0, 120);
    return {
      clusterTreeNodes: {
        ...state.clusterTreeNodes,
        [id]: {
          ...node,
          name: nextName,
        },
      },
    };
  }),

  deleteClusterTreeNode: (id) => {
    const state = get();
    const node = state.clusterTreeNodes[id];
    if (!node) return;
    const toDelete = new Set<string>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of Object.values(state.clusterTreeNodes)) {
        if (child.parentId && toDelete.has(child.parentId) && !toDelete.has(child.id)) {
          toDelete.add(child.id);
          changed = true;
        }
      }
    }

    const clusterTreeNodes = Object.fromEntries(
      Object.entries(state.clusterTreeNodes).filter(([nodeId]) => !toDelete.has(nodeId)),
    );
    const clusterTreeRootIds = state.clusterTreeRootIds.filter(nodeId => !toDelete.has(nodeId));
    const deletedActive = state.activeClusterTreeNodeId ? toDelete.has(state.activeClusterTreeNodeId) : false;
    const nextActiveId = deletedActive
      ? (node.parentId && clusterTreeNodes[node.parentId] ? node.parentId : clusterTreeRootIds[0] ?? null)
      : state.activeClusterTreeNodeId;

    set({
      clusterTreeNodes,
      clusterTreeRootIds,
      activeClusterTreeNodeId: nextActiveId && clusterTreeNodes[nextActiveId] ? nextActiveId : null,
    });
    if (deletedActive && nextActiveId && clusterTreeNodes[nextActiveId]) {
      get().applyClusterTreeNode(nextActiveId);
    }
  },
  
  clearAllFilters: () => set({
    filteredReadIds: {},
    readFilterSources: {},
    footprintFilterKey: null,
    clusterFocus: {},
    readStateDetails: {},
    transcriptionStateFilters: {
      pause: false,
      pic: false,
      elongating: null,
    },
  }),

  // Cluster peak mode action
  setClusterPeakMode: (mode) => set(state => {
    // When setting a unified peak mode, update all selected peaks to that mode
    const newModes: Record<number, PeakMode> = {};
    const isDirectMode = typeof mode === 'string' && !mode.startsWith(CLUSTER_RULE_MODE_PREFIX);
    for (const peakIdx of state.selectedPeaks) {
      if (isDirectMode && mode !== 'accessibility') {
        newModes[peakIdx] = mode;
      }
    }
    return { clusterPeakMode: mode, peakModes: newModes };
  }),

  setClusterFeatureRules: (rules) => set({
    clusterFeatureRules: normalizeClusterFeatureRules(rules),
  }),

  addClusterFeatureRule: (rule) => set(state => ({
    clusterFeatureRules: normalizeClusterFeatureRules([...state.clusterFeatureRules, rule]),
  })),

  updateClusterFeatureRule: (id, updates) => set(state => ({
    clusterFeatureRules: normalizeClusterFeatureRules(state.clusterFeatureRules.map(rule =>
      rule.id === id ? { ...rule, ...updates } : rule
    )),
  })),

  removeClusterFeatureRule: (id) => set(state => {
    const mode = `cluster_rule:${id}` as PeakMode;
    const peakModes = { ...state.peakModes };
    for (const [peakIdx, peakMode] of Object.entries(peakModes)) {
      if (peakMode === mode) delete peakModes[Number(peakIdx)];
    }
    return {
      clusterFeatureRules: state.clusterFeatureRules.filter(rule => rule.id !== id),
      clusterPeakMode: state.clusterPeakMode === mode ? 'accessibility' : state.clusterPeakMode,
      peakModes,
    };
  }),

  saveClusterFeatureRuleSet: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const state = get();
    const saved: ClusterFeatureRuleSet = {
      name: trimmed,
      savedAt: Date.now(),
      rules: normalizeClusterFeatureRules(state.clusterFeatureRules),
    };
    const next = [...state.savedClusterFeatureRuleSets.filter(set => set.name !== trimmed), saved];
    saveClusterFeatureRuleSetsToStorage(next);
    set({ savedClusterFeatureRuleSets: next });
  },

  loadClusterFeatureRuleSet: (name) => {
    const state = get();
    const found = state.savedClusterFeatureRuleSets.find(set => set.name === name);
    if (!found) return;
    set({ clusterFeatureRules: normalizeClusterFeatureRules(found.rules) });
  },

  deleteClusterFeatureRuleSet: (name) => {
    const state = get();
    const next = state.savedClusterFeatureRuleSets.filter(set => set.name !== name);
    saveClusterFeatureRuleSetsToStorage(next);
    if (loadDefaultClusterFeatureRuleSetName() === name) {
      localStorage.removeItem(DEFAULT_CLUSTER_FEATURE_RULESET_STORAGE_KEY);
    }
    set({ savedClusterFeatureRuleSets: next });
  },

  setDefaultClusterFeatureRuleSet: (name) => {
    if (name) {
      localStorage.setItem(DEFAULT_CLUSTER_FEATURE_RULESET_STORAGE_KEY, name);
    } else {
      localStorage.removeItem(DEFAULT_CLUSTER_FEATURE_RULESET_STORAGE_KEY);
    }
  },

  setAnalysisSortRules: (rules) => set({
    analysisSortRules: normalizeAnalysisSortRules(rules),
  }),

  addAnalysisSortRule: (rule) => set(state => ({
    analysisSortRules: normalizeAnalysisSortRules([...state.analysisSortRules, rule]),
  })),

  updateAnalysisSortRule: (id, updates) => set(state => ({
    analysisSortRules: normalizeAnalysisSortRules(state.analysisSortRules.map(rule =>
      rule.id === id ? { ...rule, ...updates } : rule
    )),
  })),

  removeAnalysisSortRule: (id) => set(state => ({
    analysisSortRules: state.analysisSortRules.filter(rule => rule.id !== id),
  })),

  saveAnalysisSortRuleSet: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const state = get();
    const saved: AnalysisSortRuleSet = {
      name: trimmed,
      savedAt: Date.now(),
      rules: normalizeAnalysisSortRules(state.analysisSortRules),
    };
    const next = [...state.savedAnalysisSortRuleSets.filter(set => set.name !== trimmed), saved];
    saveAnalysisSortRuleSetsToStorage(next);
    set({ savedAnalysisSortRuleSets: next });
  },

  loadAnalysisSortRuleSet: (name) => {
    const state = get();
    const found = state.savedAnalysisSortRuleSets.find(set => set.name === name);
    if (!found) return;
    set({ analysisSortRules: normalizeAnalysisSortRules(found.rules) });
  },

  deleteAnalysisSortRuleSet: (name) => {
    const state = get();
    const next = state.savedAnalysisSortRuleSets.filter(set => set.name !== name);
    saveAnalysisSortRuleSetsToStorage(next);
    if (loadDefaultAnalysisSortRuleSetName() === name) {
      localStorage.removeItem(DEFAULT_ANALYSIS_SORT_RULESET_STORAGE_KEY);
    }
    set({ savedAnalysisSortRuleSets: next });
  },

  setDefaultAnalysisSortRuleSet: (name) => {
    if (name) {
      localStorage.setItem(DEFAULT_ANALYSIS_SORT_RULESET_STORAGE_KEY, name);
    } else {
      localStorage.removeItem(DEFAULT_ANALYSIS_SORT_RULESET_STORAGE_KEY);
    }
  },

  setAnalysisFilterRules: (rules) => set({
    analysisFilterRules: normalizeAnalysisFilterRules(rules),
  }),

  addAnalysisFilterRule: (rule) => set(state => ({
    analysisFilterRules: normalizeAnalysisFilterRules([...state.analysisFilterRules, rule]),
  })),

  updateAnalysisFilterRule: (id, updates) => set(state => ({
    analysisFilterRules: normalizeAnalysisFilterRules(state.analysisFilterRules.map(rule =>
      rule.id === id ? { ...rule, ...updates } : rule
    )),
  })),

  removeAnalysisFilterRule: (id) => set(state => ({
    analysisFilterRules: state.analysisFilterRules.filter(rule => rule.id !== id),
  })),

  saveAnalysisFilterRuleSet: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const state = get();
    const saved: AnalysisFilterRuleSet = {
      name: trimmed,
      savedAt: Date.now(),
      rules: normalizeAnalysisFilterRules(state.analysisFilterRules),
    };
    const next = [...state.savedAnalysisFilterRuleSets.filter(set => set.name !== trimmed), saved];
    saveAnalysisFilterRuleSetsToStorage(next);
    set({ savedAnalysisFilterRuleSets: next });
  },

  loadAnalysisFilterRuleSet: (name) => {
    const state = get();
    const found = state.savedAnalysisFilterRuleSets.find(set => set.name === name);
    if (!found) return;
    set({ analysisFilterRules: normalizeAnalysisFilterRules(found.rules) });
  },

  deleteAnalysisFilterRuleSet: (name) => {
    const state = get();
    const next = state.savedAnalysisFilterRuleSets.filter(set => set.name !== name);
    saveAnalysisFilterRuleSetsToStorage(next);
    if (loadDefaultAnalysisFilterRuleSetName() === name) {
      localStorage.removeItem(DEFAULT_ANALYSIS_FILTER_RULESET_STORAGE_KEY);
    }
    set({ savedAnalysisFilterRuleSets: next });
  },

  setDefaultAnalysisFilterRuleSet: (name) => {
    if (name) {
      localStorage.setItem(DEFAULT_ANALYSIS_FILTER_RULESET_STORAGE_KEY, name);
    } else {
      localStorage.removeItem(DEFAULT_ANALYSIS_FILTER_RULESET_STORAGE_KEY);
    }
  },

  // Gene selection and transcription state filtering actions
  setSelectedGenes: (genes) => set(state => {
    const updates: Partial<BrowserState> = { selectedGenes: genes };
    if (state.showRelativeCoords && genes.length > 0) {
      const gene = genes[0];
      updates.relativeTSS = geneTss(gene);
      updates.relativeGene = gene;
    } else if (state.showRelativeCoords && genes.length === 0) {
      updates.showRelativeCoords = false;
      updates.relativeTSS = null;
      updates.relativeGene = null;
    }
    return updates;
  }),

  toggleGeneSelection: (gene) => set(state => {
    const isSelected = state.selectedGenes.some(g => g.id === gene.id);
    const newGenes = isSelected
      ? state.selectedGenes.filter(g => g.id !== gene.id)
      : [...state.selectedGenes, gene];
    const updates: Partial<BrowserState> = { selectedGenes: newGenes };
    if (state.showRelativeCoords && newGenes.length > 0) {
      const g = newGenes[0];
      updates.relativeTSS = geneTss(g);
      updates.relativeGene = g;
    } else if (state.showRelativeCoords && newGenes.length === 0) {
      updates.showRelativeCoords = false;
      updates.relativeTSS = null;
      updates.relativeGene = null;
    }
    return updates;
  }),

  clearGeneSelection: () => set({ selectedGenes: [] }),

  setTranscriptionStateFilters: (filters) => set(state => ({
    transcriptionStateFilters: normalizeTranscriptionStateFilters({ ...state.transcriptionStateFilters, ...filters })
  })),

  resetTranscriptionStateFilters: () => set({
    transcriptionStateFilters: {
      pause: false,
      pic: false,
      elongating: null,
      elongating_max: null,
    },
    readStateDetails: {},
  }),

  setReadStateDetails: (datasetId, details) => set(state => ({
    readStateDetails: { ...state.readStateDetails, [datasetId]: details }
  })),

  clearReadStateDetails: () => set({ readStateDetails: {} }),
  
  selectPeaksByLayer: (layer) => set(state => {
    const allPeaks = state.getAllPeaks();
    const layerPeaks = allPeaks.filter(p => p.layer === layer);
    const allSelected = layerPeaks.length > 0 && layerPeaks.every(p => state.selectedPeaks.has(p.index));
    const newSelected = new Set(state.selectedPeaks);
    const newModes = { ...state.peakModes };
    const directMode = typeof state.clusterPeakMode === 'string'
      && !state.clusterPeakMode.startsWith(CLUSTER_RULE_MODE_PREFIX)
      ? state.clusterPeakMode
      : 'accessibility';
    for (const peak of layerPeaks) {
      if (allSelected) {
        newSelected.delete(peak.index);
        delete newModes[peak.index];
      } else {
        newSelected.add(peak.index);
        if (directMode === 'accessibility') delete newModes[peak.index];
        else newModes[peak.index] = directMode;
      }
    }
    return { selectedPeaks: newSelected, peakModes: newModes };
  }),
  
  selectFootprint: (fp, accumulate) => set(state => {
    if (accumulate) {
      // Toggle: the same footprint (read, layer, genomic bounds; interval
      // indexes change as the view pans) is removed, anything else added.
      const idx = state.selectedFootprints.findIndex(
        sf => (sf.layer ?? null) === (fp.layer ?? null) && isSelectedFootprint(sf, fp)
      );
      if (idx >= 0) {
        const next = [...state.selectedFootprints];
        next.splice(idx, 1);
        return { selectedFootprints: next };
      }
      return { selectedFootprints: [...state.selectedFootprints, fp] };
    }
    return { selectedFootprints: [fp] };
  }),

  // Clears only the ephemeral selection + filter; footprintGroups (the
  // persistent cart) survives so users can deselect a click without losing
  // their saved footprint definitions.
  clearFootprintSelection: () => set({ selectedFootprints: [], footprintFilterKey: null }),
  clearFootprintGroups: () => {
    saveFootprintGroupsToStorage([]);
    set(state => ({
      ...(state.footprintFilterKey && !state.footprintFilterKey.startsWith('state:') ? clearFootprintReadFilters(state) : {}),
      footprintGroups: [],
      footprintFilterKey: state.footprintFilterKey?.startsWith('state:') ? state.footprintFilterKey : null,
      selectedFamilyGroupId: null,
    }));
  },
  setFootprintCrossHighlight: (enabled) => set({ footprintCrossHighlight: enabled }),
  setSelectedFamilyGroupId: (groupId) => set({ selectedFamilyGroupId: groupId }),

  // Footprint group CRUD — every mutation persists the cart to localStorage.
  setFootprintGroups: (groups) => {
    const normalized = normalizeFootprintGroups(groups);
    saveFootprintGroupsToStorage(normalized);
    set(state => {
      return {
        ...reconcileFootprintFilter(state, normalized),
        footprintGroups: normalized,
        selectedFamilyGroupId: normalized.some(group => group.id === state.selectedFamilyGroupId)
          ? state.selectedFamilyGroupId
          : null,
      };
    });
  },
  setAutoFamilyGroups: (sourceViewKey, groups) => set(state => {
    const retained = state.footprintGroups.filter(group => (
      !group.autoGeneratedFamily
      || group.sourceViewKey !== sourceViewKey
    ));
    const normalized = normalizeFootprintGroups([...retained, ...groups]);
    saveFootprintGroupsToStorage(normalized);
    // Refreshing viewport-derived entries must not clear an active read
    // filter. Stable family IDs allow the filter to survive ordinary pans.
    return {
      footprintGroups: normalized,
      selectedFamilyGroupId: normalized.some(group => group.id === state.selectedFamilyGroupId)
        ? state.selectedFamilyGroupId
        : null,
    };
  }),
  addFootprintGroup: (group) => set(state => {
    const next = normalizeFootprintGroups([...state.footprintGroups, { ...group, id: crypto.randomUUID() }]);
    saveFootprintGroupsToStorage(next);
    return { footprintGroups: next };
  }),
  updateFootprintGroup: (id, updates) => set(state => {
    const next = normalizeFootprintGroups(state.footprintGroups.map(g => {
      if (g.id !== id) return g;
      // Typing a name makes it the user's; an automatic name follows the size range.
      if ('name' in updates) return { ...g, ...updates, autoName: updates.autoName ?? false };
      const merged = { ...g, ...updates };
      // Older entries have no flag: a name that is exactly its range counts as automatic.
      const automatic = g.autoName ?? g.name === sizeRangeName(g.sizeMin, g.sizeMax, autoNameSuffix(g.name));
      if (automatic && ('sizeMin' in updates || 'sizeMax' in updates)) {
        merged.name = sizeRangeName(merged.sizeMin, merged.sizeMax, autoNameSuffix(g.name));
      }
      return merged;
    }));
    saveFootprintGroupsToStorage(next);
    return { ...reconcileFootprintFilter(state, next), footprintGroups: next };
  }),
  removeFootprintGroup: (id) => set(state => {
    const next = state.footprintGroups.filter(g => g.id !== id);
    saveFootprintGroupsToStorage(next);
    return {
      ...reconcileFootprintFilter(state, next),
      footprintGroups: next,
      selectedFamilyGroupId: state.selectedFamilyGroupId === id
        ? null
        : state.selectedFamilyGroupId,
    };
  }),

  pinnedMotifs: loadPinnedMotifs(),
  motifScoreMode: loadMotifScoring().mode,
  motifPValue: loadMotifScoring().p,
  setMotifScoreMode: (mode) => set({ motifScoreMode: mode === 'relative' ? 'relative' : 'p' }),
  setMotifPValue: (p) => set({ motifPValue: clampMotifP(p) }),
  customMotifs: loadCustomMotifs(),
  setCustomMotifs: (motifs) => set({ customMotifs: normalizeCustomMotifs(motifs) }),
  setPinnedMotifs: (species, names) => set(state => {
    const next = { ...state.pinnedMotifs };
    if (names == null) delete next[species];
    else next[species] = names;
    return { pinnedMotifs: normalizePinnedMotifs(next) };
  }),

  // Saved clusters cart
  savedClusters: [],
  pendingClusterRestore: null,

  saveCurrentClustering: (name?) => set(state => {
    const hasAssignments = Object.values(state.clusterAssignments).some(
      a => Object.keys(a).length > 0
    );
    if (!hasAssignments) return {};

    // Remap stateKey-keyed data to datasetId-keyed for portability (the panel
    // showing the main view wins), and keep each panel's own result too.
    const panels = (state as BrowserState).panels || [];
    const assignments: Record<string, Record<string, number>> = {};
    const order: Record<string, number[]> = {};
    const panelResults: NonNullable<SavedCluster['panelResults']> = [];
    const atMainView = (p: PanelConfig) => {
      const v = p.viewportOverride;
      return !p.genome && (!v || (v.chrom === state.chrom && v.start === state.start && v.end === state.end));
    };
    const seenKeys = new Set<string>();
    for (const p of [...panels].sort((a, b) => Number(atMainView(b)) - Number(atMainView(a)))) {
      if (p.contentType !== 'dataset' || !p.datasetId) continue;
      const sk = p.stateKey ?? p.datasetId;
      if (seenKeys.has(sk)) continue;
      seenKeys.add(sk);
      const own = state.clusterAssignments[sk];
      if (!own || Object.keys(own).length === 0) continue;
      panelResults.push({
        stateKey: sk,
        datasetId: p.datasetId,
        ...(atMainView(p) ? {} : { viewport: { ...(p.viewportOverride ?? { chrom: state.chrom, start: state.start, end: state.end }) } }),
        ...(p.genome ? { genome: p.genome } : {}),
        assignments: own,
        ...(state.clusterOrder[sk] ? { order: state.clusterOrder[sk] } : {}),
      });
      if (!assignments[p.datasetId] && atMainView(p)) {
        assignments[p.datasetId] = own;
        if (state.clusterOrder[sk]) order[p.datasetId] = state.clusterOrder[sk];
      }
    }
    // Fallback: include any entries not matched by panels (a panel's own
    // result is in panelResults, with its locus and reference).
    for (const [key, val] of Object.entries(state.clusterAssignments)) {
      if (!assignments[key] && !seenKeys.has(key) && Object.keys(val).length > 0) {
        assignments[key] = val;
        if (state.clusterOrder[key]) order[key] = state.clusterOrder[key];
      }
    }

    const nClusters = new Set(Object.values(assignments).flatMap(a => Object.values(a))).size;
    const nReads = Object.values(assignments).reduce((s, a) => s + Object.keys(a).length, 0);
    const autoName = name || `${state.clusterMethod} K=${nClusters} (${nReads} reads)`;

    const saved: SavedCluster = {
      id: crypto.randomUUID(),
      name: autoName,
      addedAt: Date.now(),
      chrom: state.chrom,
      start: state.start,
      end: state.end,
      clusterMethod: state.clusterMethod,
      clusterK: state.clusterK,
      clusterResolution: state.clusterResolution,
      subnucleosomalThreshold: state.subnucleosomalThreshold,
      accessibilityThreshold: state.accessibilityThreshold,
      clusterFeatureRules: normalizeClusterFeatureRules(state.clusterFeatureRules),
      peakRegions: state.clusterPeakRegions.map(r => ({ ...r })),
      customPeaks: (state.peaksByRule[state.getCustomRuleId()] || []).map(p => ({ start: p.start, end: p.end, ...(p.chrom ? { chrom: p.chrom } : {}) })),
      selectedPeakIndices: [...state.selectedPeaks],
      peakModes: { ...state.peakModes },
      assignments,
      order,
      patterns: { ...state.clusterPatterns },
      panelResults,
      // Each panel's own matched peaks (a run over panels at several loci), for its charts.
      ...(state.clusterWindowPeaks ? { windowPeaks: state.clusterWindowPeaks } : {}),
      // The merges behind it (Unmerge, Split back), when they are this clustering's.
      ...(state.clusterMergeLog && mergeLogStatus(state.clusterMergeLog, state.clusterAssignments)
        ? { mergeLog: state.clusterMergeLog } : {}),
    };

    return { savedClusters: [...state.savedClusters, saved] };
  }),

  removeSavedCluster: (id) => set(state => ({
    savedClusters: state.savedClusters.filter(sc => sc.id !== id),
  })),

  updateSavedClusterName: (id, name) => set(state => ({
    savedClusters: state.savedClusters.map(sc => sc.id === id ? { ...sc, name } : sc),
  })),

  clearSavedClusters: () => set({ savedClusters: [] }),

  restoreSavedCluster: (id) => {
    const state = get();
    const saved = state.savedClusters.find(sc => sc.id === id);
    if (!saved) return;

    // Panels saved at a locus of their own (Each panel navigates, another
    // assembly) go back there first: their saved result is for that locus.
    // The whole restore is one undo step (Before / Restore), not a step per
    // panel moved: history is held while they move.
    let moves = savedPanelMoves(saved, state as BrowserState);
    if (moves.length) {
      seedHistoryBaseline(get() as BrowserState, 'Before restoring a saved clustering', 'clustering');
      const paused = (get() as BrowserState)._historyPaused;
      set({ _historyPaused: true } as Partial<BrowserState>);
      try {
        // Saved in Each panel navigates (a main-genome panel with a locus of its
        // own, or two panels of one reference's link group at different loci):
        // Linked navigation would move them together, so switch back first.
        if (needsPerPanelForMoves(moves, get() as BrowserState)) {
          (get() as BrowserState).setNavigationMode('perPanel');
          moves = savedPanelMoves(saved, get() as BrowserState);
        }
        for (const move of moves) (get() as BrowserState).navigatePanel(move.panelId, move.chrom, move.start, move.end);
      } finally {
        set({ _historyPaused: paused } as Partial<BrowserState>);
      }
    }
    const now = moves.length ? get() : state;

    const sameViewport = now.chrom === saved.chrom && now.start === saved.start && now.end === saved.end;

    if (sameViewport) {
      // Apply directly — remap datasetId → stateKey(s)
      const { assignments: newAssignments, order: newOrder } = savedClusterStateForPanels(saved, now as BrowserState);

      // Restore custom peaks into the custom rule
      const customRuleId = now.getCustomRuleId();
      const customRuleIdx = now.peakRules.findIndex(r => r.id === customRuleId);
      const customOffset = customRuleIdx >= 0 ? computeRuleOffset(customRuleIdx) : 0;
      const restoredCustomPeaks = saved.customPeaks.map((p, i) => ({
        start: p.start, end: p.end, index: customOffset + i, layer: 0, isCustom: true as const,
        ruleId: customRuleId,
        ...(p.chrom ? { chrom: p.chrom } : {}),
      }));

      set({
        ...restoredClusteringState(saved, now, newAssignments),
        clusterAssignments: newAssignments,
        clusterOrder: newOrder,
        clusterPatterns: saved.patterns,
        clusterPeakRegions: saved.peakRegions,
        clusterWindowPeaks: saved.windowPeaks ?? null,
        peaksByRule: { ...now.peaksByRule, [customRuleId]: restoredCustomPeaks },
        selectedPeaks: new Set(saved.selectedPeakIndices),
        peakModes: saved.peakModes as Record<number, PeakMode>,
        clusterMethod: saved.clusterMethod,
        clusterK: saved.clusterK,
        clusterResolution: saved.clusterResolution ?? 1,
        subnucleosomalThreshold: saved.subnucleosomalThreshold,
        accessibilityThreshold: saved.accessibilityThreshold,
        ...(saved.clusterFeatureRules ? { clusterFeatureRules: normalizeClusterFeatureRules(saved.clusterFeatureRules) } : {}),
      });
      // The panels moved back: the restore is an undo step of its own (Redo brings the clusters back too).
      if (moves.length) (get() as BrowserState).pushSnapshot?.(`Restore clustering ${saved.name}`, { kind: 'clustering' });
    } else {
      // Cross-viewport: set pending, then navigate
      set({ pendingClusterRestore: id });
      (now as BrowserState).setViewport(saved.chrom, saved.start, saved.end);
    }
  },

  setPendingClusterRestore: (id) => set({ pendingClusterRestore: id }),

  syncPeaksToBackend: async () => {
    const state = get();
    // No notebook to mirror peaks to on a public server.
    if (state.publicMode || isPublicServerPage()) return;
    const { chrom, selectedPeaks } = state;
    const rulesById = new Map(state.peakRules.map(rule => [rule.id, rule]));
    const allPeaks = state.getAllPeaks().filter(p => !p.match).map(p => ({
      index: p.index,
      start: p.start,
      end: p.end,
      layer: p.layer ?? 0,
      score: p.score ?? 0,
      threshold: p.threshold ?? null,
      ruleId: p.ruleId ?? null,
      ruleName: p.ruleId ? rulesById.get(p.ruleId)?.name : null,
      source: p.ruleId ? rulesById.get(p.ruleId)?.source : null,
      color: p.sourceColor ?? (p.ruleId ? rulesById.get(p.ruleId)?.color : null),
      sourceLabel: p.sourceLabel ?? null,
      isCustom: !!p.isCustom,
      isSelected: selectedPeaks.has(p.index),
      mode: state.peakModes[p.index] || 'accessibility',
    }));

    try {
      await fetchApiResponse('/api/jupyter/sync_peaks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chrom, peaks: allPeaks }),
      });
    } catch (e) {
      // Silently ignore sync errors - Jupyter may not be connected
      console.debug('Peak sync failed (Jupyter may not be connected):', e);
    }
  },

  // Bookmark actions
  };
}

/**
 * An SV allele split's definition and group names, without the state keys whose groups another grouping replaced
 * (as setClusterAssignments does): a restored clustering or a subclustering must not keep the split's names, nor
 * its re-classification on pan.
 */
export function withoutSvSplits(
  state: Partial<Pick<BrowserState, 'svSplits' | 'clusterGroupLabels'>>,
  keys: Iterable<string>,
): Pick<BrowserState, 'svSplits' | 'clusterGroupLabels'> {
  let svSplits = state.svSplits ?? {};
  let clusterGroupLabels = state.clusterGroupLabels ?? {};
  for (const key of keys) {
    if (key in svSplits) { svSplits = { ...svSplits }; delete svSplits[key]; }
    if (key in clusterGroupLabels) { clusterGroupLabels = { ...clusterGroupLabels }; delete clusterGroupLabels[key]; }
  }
  return { svSplits, clusterGroupLabels };
}

/**
 * The rest of the clustering state a restored saved clustering replaces, so it
 * comes back whole rather than mixed with the branch it replaced: the restored
 * panels' focus and cluster selection are cleared (they named the old
 * clusters), it belongs to no saved branch, and the old centroid model is
 * dropped (a saved clustering keeps its patterns, not centroids), with the
 * restored view marked so dynamic reassignment doesn't redo it in place.
 * Its merges come back with it (Unmerge, Split back; restoredMergeLog).
 */
export function restoredClusteringState(
  saved: Pick<SavedCluster, 'chrom' | 'start' | 'end' | 'mergeLog'>,
  state: Pick<BrowserState, 'clusterAssignments' | 'clusterFocus' | 'selectedClusters' | 'clusterMergeLog' | 'clusterOrder' | 'svSplits' | 'clusterGroupLabels'>,
  newAssignments: Record<string, Record<string, number>>,
): Pick<BrowserState, 'clusterFocus' | 'selectedClusters' | 'activeClusterTreeNodeId' | 'clusterCentroids' | 'clusterPeakWidths' | 'restoredClusterViewport' | 'clusterMergeLog' | 'svSplits' | 'clusterGroupLabels'> {
  const clusterFocus = { ...state.clusterFocus };
  const selectedClusters = { ...state.selectedClusters };
  const replaced: string[] = [];
  for (const key of Object.keys(newAssignments)) {
    if (newAssignments[key] === state.clusterAssignments[key]) continue;
    clusterFocus[key] = null;
    delete selectedClusters[key];
    replaced.push(key);
  }
  return {
    ...withoutSvSplits(state, replaced),
    clusterFocus,
    selectedClusters,
    activeClusterTreeNodeId: null,
    clusterCentroids: {},
    clusterPeakWidths: [],
    restoredClusterViewport: { chrom: saved.chrom, start: saved.start, end: saved.end },
    clusterMergeLog: restoredMergeLog(saved, state, newAssignments),
  };
}

/**
 * The merge log after restoring a saved clustering (fb-n6-integ): the saved
 * one, on the panels now showing its clusterings (restoreMergeLog: a state key
 * renamed, a dataset's result restored to another panel, a panel left out of
 * the restore drops out). Without one (an older save, a clustering without
 * merges): the live log while it still describes what is on show (the
 * clustering from before its merges restored: Merge again), else only for
 * the panels the restore left as they were (a partial restore).
 */
export function restoredMergeLog(
  saved: Pick<SavedCluster, 'mergeLog'>,
  state: Pick<BrowserState, 'clusterAssignments' | 'clusterMergeLog'> & Partial<Pick<BrowserState, 'clusterOrder'>>,
  newAssignments: Record<string, Record<string, number>>,
): ClusterMergeLog | null {
  const fromSave = restoreMergeLog(normalizeMergeLog(saved.mergeLog), newAssignments);
  if (fromSave) return fromSave;
  const live = state.clusterMergeLog;
  const orders = state.clusterOrder ?? {};
  const status = live ? mergeLogStatus(live, newAssignments) : null;
  if (live && status) {
    if (status === live.showing) return live;
    // The other side of it restored (the clustering from before its merges, or the
    // merged one): say so, with the order of the side no longer on show.
    const otherOrder: Record<string, number[]> = {};
    if (mergeLogStatus(live, state.clusterAssignments) === live.showing) {
      for (const key of live.stateKeys) if (orders[key]) otherOrder[key] = [...orders[key]];
    }
    return { ...live, showing: status, otherOrder };
  }
  const untouched = new Set(Object.keys(newAssignments).filter(key => newAssignments[key] === state.clusterAssignments[key]));
  return restoreMergeLog(state.clusterMergeLog, newAssignments, untouched);
}

/**
 * A saved clustering's assignments and order keyed by the current panels' state
 * keys, on top of the current ones. A panel saved with its own result gets it
 * back (same state key and dataset, and the locus it was saved at); other
 * panels of a dataset showing the saved view get the dataset's result; a panel
 * at another locus keeps what it has.
 */
export function savedClusterStateForPanels(
  saved: SavedCluster,
  state: Pick<BrowserState, 'panels' | 'clusterAssignments' | 'clusterOrder'>,
): { assignments: Record<string, Record<string, number>>; order: Record<string, number[]> } {
  const assignments = { ...state.clusterAssignments };
  const order = { ...state.clusterOrder };
  const own = new Map((saved.panelResults ?? []).map(r => [r.stateKey, r]));
  const datasetPanels = (state.panels || []).filter(p => p.contentType === 'dataset' && p.datasetId);
  const covered = new Set<string>();
  for (const p of datasetPanels) {
    const sk = p.stateKey ?? p.datasetId!;
    const v = p.viewportOverride;
    const atSaved = !p.genome && (!v || (v.chrom === saved.chrom && v.start === saved.start && v.end === saved.end));
    const mine = own.get(sk);
    // Its own result: on the reference and at the locus it was saved at.
    const mineFits = mine && mine.datasetId === p.datasetId && (mine.genome ?? null) === (p.genome ?? null) && (mine.viewport
      ? !!v && v.chrom === mine.viewport.chrom && v.start === mine.viewport.start && v.end === mine.viewport.end
      : atSaved);
    if (mine && mineFits) {
      assignments[sk] = mine.assignments;
      if (mine.order) order[sk] = mine.order;
      else delete order[sk];
      covered.add(p.datasetId!);
      continue;
    }
    if (!atSaved) continue;
    const shared = saved.assignments[p.datasetId!];
    if (!shared) continue;
    assignments[sk] = shared;
    if (saved.order[p.datasetId!]) order[sk] = saved.order[p.datasetId!];
    covered.add(p.datasetId!);
  }
  for (const [dsId, assigns] of Object.entries(saved.assignments)) {
    // (Older saves listed a panel's own result here too: a panel's key is never a dataset's.)
    if (covered.has(dsId) || datasetPanels.some(p => p.datasetId === dsId || (p.stateKey ?? p.datasetId) === dsId)) continue;
    assignments[dsId] = assigns;
    if (saved.order[dsId]) order[dsId] = saved.order[dsId];
  }
  return { assignments, order };
}

/**
 * The panels a saved clustering takes back to the locus it was saved at
 * (fb-n4-integ): each panel saved with a locus of its own that is now
 * elsewhere, on the same reference (a panel now on another reference can't go
 * there; it keeps what it shows). Matched by state key and dataset.
 */
export function savedPanelMoves(
  saved: Pick<SavedCluster, 'panelResults'>,
  state: Pick<BrowserState, 'panels' | 'chrom' | 'start' | 'end'>,
): Array<{ panelId: string; chrom: string; start: number; end: number }> {
  const moves: Array<{ panelId: string; chrom: string; start: number; end: number }> = [];
  for (const entry of saved.panelResults ?? []) {
    const at = entry.viewport;
    if (!at) continue;
    const panel = (state.panels || []).find(p => p.contentType === 'dataset' && p.datasetId === entry.datasetId
      && (p.stateKey ?? p.datasetId) === entry.stateKey);
    if (!panel || (panel.genome ?? null) !== (entry.genome ?? null)) continue;
    const v = panel.viewportOverride ?? { chrom: state.chrom, start: state.start, end: state.end };
    if (panel.viewportOverride && v.chrom === at.chrom && v.start === at.start && v.end === at.end) continue;
    // A panel following the main view gets a locus of its own only in Each panel navigates (navigatePanel decides).
    moves.push({ panelId: panel.id, chrom: at.chrom, start: at.start, end: at.end });
  }
  return moves;
}

/**
 * Moving these panels back in Linked navigation would move other panels with
 * them (a reference's link group shows one locus) or give a main-view panel a
 * locus of its own: the saved layout was Each panel navigates.
 */
function needsPerPanelForMoves(
  moves: Array<{ panelId: string; chrom: string; start: number; end: number }>,
  state: Pick<BrowserState, 'panels' | 'navigationMode'>,
): boolean {
  if (state.navigationMode !== 'linked') return false;
  const groupLocus = new Map<string, string>();
  for (const move of moves) {
    const panel = state.panels.find(p => p.id === move.panelId);
    if (!panel) continue;
    if (!panel.genome && !panel.viewportOverride) return true;
    if (!inGenomeLinkGroup(panel)) continue;
    const locus = `${move.chrom}:${move.start}-${move.end}`;
    // A peer not moved back would be moved along, away from where it is.
    const staying = state.panels.filter(p => p.id !== panel.id && p.genome === panel.genome && inGenomeLinkGroup(p)
      && !moves.some(m => m.panelId === p.id));
    if (staying.some(p => !p.viewportOverride || `${p.viewportOverride.chrom}:${p.viewportOverride.start}-${p.viewportOverride.end}` !== locus)) return true;
    // Two panels of the group going to different loci.
    const known = groupLocus.get(panel.genome!);
    if (known && known !== locus) return true;
    groupLocus.set(panel.genome!, locus);
  }
  return false;
}
