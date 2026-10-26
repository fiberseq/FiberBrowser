import { normalizeSvConflictOptions, type SvConflictOptions } from '../utils/svConflicts';
import { validateMatchedState } from '../utils/matchedRegions';
import { normalizeSignalFilters } from '../utils/signalFilters';
import { normalizeSvCarrierEvidence, normalizeClusterGroupLabels, normalizeSvSplits } from './svSlice';
import { restoreDifferencesSession, restoreHistoricalMembership, legacySplitDefinitions, type DifferencesSession } from '../features/differences/session';
import '../features/differences/persistence';
import { clampMinSvLen, SV_MIN_LEN_DEFAULT, clampMinSvSupport, SV_MIN_SUPPORT_DEFAULT } from '../components/tracks/read-track/svDrawing';
import { normalizeFeatureRefs } from './featureStore';
import { normalizePinnedMotifs } from '../utils/pinnedMotifs';
import { clampMotifP, normalizeCustomMotifs, normalizeScoreMode } from '../utils/motifSettings';
import { restoreExtensions, serializeExtensions } from './storeExtensions';
import type { BrowserState } from './browserStore';
import type { CatalogEntry, CompositeTrack } from '../types/dataset';
import type { ClusterWindowPeaks } from '../types/clustering';
import type { SavedTrack } from './savedTracksSlice';
import type { ReadFilterSource } from './clusterSlice';
import { toArray, toSet } from './hydration';
import { migrateSitePanels } from './siteLock';
import { migratePanelTracks } from './utils';
import { canonicalPanelType, migratePanelAliases } from '../plugins/registry';
import { applyCoaccSettings, serializeCoaccSettings, type SerializedCoaccSettings } from './coaccStore';
import { applyExcludedReads, serializeExcludedReads } from './readActionsStore';
import { migrateColormap, normalizeAnalysisFilterRules, normalizeAnalysisSortRules, normalizeClusterFeatureRules, normalizeFootprintGroups, normalizeTranscriptionStateFilters } from './utils';
import { normalizeAnnotationLayer, normalizeLayerToggleMap } from '../utils/layerAliases';
import { getBrowserPerformanceProfile } from '../utils/performanceProfile';
import { trimHistory } from '../utils/historyBudget';
import { normalizeHighlights } from './highlightSlice';
import { DEFAULT_CLASS_REGION_MODE, isClassRegionMode } from '../utils/classRegion';
import { normalizeMergeLog } from './clusterMergeLog';
import { isMergeStrategy } from '../utils/mergeStrategies';
import { sessionPackMarker, withoutMissingPackState, type SessionPacks } from '../api/sessionPacks';

/** Merge similar clusters' settings from a step or session (absent in older ones: left as they are). */
export function restoredMergeSettings(s: {
  mergeMinFraction?: unknown; mergeMaxSimilarity?: unknown; mergeStrategy?: unknown; mergeThresholds?: unknown;
}): Partial<Pick<BrowserState, 'mergeMinFraction' | 'mergeMaxSimilarity' | 'mergeStrategy' | 'mergeThresholds'>> {
  const out: Partial<Pick<BrowserState, 'mergeMinFraction' | 'mergeMaxSimilarity' | 'mergeStrategy' | 'mergeThresholds'>> = {};
  if (typeof s.mergeMinFraction === 'number' && Number.isFinite(s.mergeMinFraction)) out.mergeMinFraction = s.mergeMinFraction;
  if (typeof s.mergeMaxSimilarity === 'number' && Number.isFinite(s.mergeMaxSimilarity)) out.mergeMaxSimilarity = s.mergeMaxSimilarity;
  if (isMergeStrategy(s.mergeStrategy)) out.mergeStrategy = s.mergeStrategy;
  if (s.mergeThresholds && typeof s.mergeThresholds === 'object' && !Array.isArray(s.mergeThresholds)) {
    out.mergeThresholds = Object.fromEntries(Object.entries(s.mergeThresholds as Record<string, unknown>)
      .filter(([k, v]) => isMergeStrategy(k) && typeof v === 'number' && Number.isFinite(v)));
  }
  return out;
}

// ============================================================
// HISTORY SLICE — Undo/Redo with labeled snapshots
// ============================================================

function stripCatalogTrackIndices(entries: CatalogEntry[] | undefined): CatalogEntry[] | undefined {
  return entries?.map(entry => {
    const { trackIndex: _trackIndex, ...rest } = entry;
    return rest as CatalogEntry;
  });
}

/** A labeled snapshot of restorable state. */
export interface Snapshot {
  label: string;
  timestamp: number;
  state: SerializedState;
  kind?: SnapshotKind;
  coalesceKey?: string;
  /** This step closed these datasets: undoing it reopens them from their files, redoing closes them again. */
  closedDatasets?: SerializedDataset[];
  /** Unique per recorded step (a coalesced step gets a new one): lets a late effect fold into exactly its step. */
  id?: number;
  /** A "Before …" checkpoint (seedHistoryBaseline), never a step a late correction may rewrite. */
  baseline?: boolean;
}

let snapshotSeq = 0;
/** The id the most recently recorded step got (0: none yet). */
export const lastSnapshotId = () => snapshotSeq;

type SnapshotOptions = {
  kind?: SnapshotKind; coalesceKey?: string; coalesceMs?: number; closedDatasets?: SerializedDataset[];
  /** A step the user took (a panel's pan), not an effect echoing a restore: recorded even just after Undo. */
  explicit?: boolean;
};

export interface CommandHistoryActionRecord {
  id: string;
  type: string;
  summary: string;
  status: 'pending' | 'success' | 'error' | 'skipped';
  payload: unknown;
  apiEquivalent?: {
    method?: string;
    path?: string;
    body?: unknown;
    note?: string;
  };
  message?: string;
  response?: unknown;
  timestamp: number;
}

export interface CommandHistoryEntry {
  id: string;
  text: string;
  planner?: string;
  summary?: string;
  trace?: string[];
  debug?: unknown;
  status: 'planned' | 'running' | 'success' | 'error';
  warnings?: string[];
  actions: CommandHistoryActionRecord[];
  messages?: string[];
  error?: string;
  timestamp: number;
  completedAt?: number;
}

export type SnapshotKind =
  | 'navigation'
  | 'clustering'
  | 'sorting'
  | 'filtering'
  | 'labeling'
  | 'session'
  | 'layout'
  | 'view'
  | 'analysis'
  | 'other';

/** A baseline is a fixed undo point: the result pushed right after it
 * (same kind, within the coalescing window) must not replace it. */
let baselineCounter = 0;
const baselineKey = () => `baseline-${++baselineCounter}`;
const isBaselineKey = (key?: string) => Boolean(key?.startsWith('baseline-'));

/**
 * Display preferences kept in snapshots for sessions and crash recovery, but
 * not part of undo: Undo of a zoom must not flip the theme or the UI size.
 */
export const HISTORY_PREFERENCE_FIELDS = ['darkMode', 'uiScale'] as const;

/** The snapshot fields undo/redo compare and restore (preferences left out). */
function historyComparable(state: SerializedState): Partial<SerializedState> {
  const out: Partial<SerializedState> = { ...state };
  for (const field of HISTORY_PREFERENCE_FIELDS) delete out[field];
  return out;
}

/** Same restorable state, ignoring display preferences (theme, UI size). */
export function sameHistoryState(a: SerializedState | undefined | null, b: SerializedState | undefined | null): boolean {
  if (!a || !b) return a === b;
  try {
    return JSON.stringify(historyComparable(a)) === JSON.stringify(historyComparable(b));
  } catch {
    return false;
  }
}

/**
 * Just after an undo/redo/jump (1.5 s), a push that only echoes the restore
 * (effects re-pushing the restored state, a navigation effect) is dropped so
 * redo survives; a real change still records and branches (dropping redo).
 */
function echoesRestore(state: BrowserState, snapshotState: SerializedState, kind: SnapshotKind, explicit = false): boolean {
  if (!(state._historyPaused || Date.now() - state._lastRestoreTime < 1500)) return false;
  if (state._historyPaused || (kind === 'navigation' && !explicit)) return true;
  const current = state._historyStack[state._historyPointer];
  if (!current) return false;
  try {
    return JSON.stringify(historyComparable(current.state)) === JSON.stringify(historyComparable(snapshotState));
  } catch {
    return true;
  }
}

/**
 * What only automatic work writes after a step (the peak auto-scan of a new
 * view): the scanned rules' peaks. A change in them alone belongs to the step
 * that caused it, not to an undo step of its own (audit M8: every panel step
 * took two Undos, the first only reverting the re-scanned peaks). Peaks the
 * user drew (the custom rule's) are not derived: they keep their checkpoint.
 */
function withoutDerivedPeaks(x: SerializedState): Record<string, unknown> {
  const out = historyComparable(x) as Record<string, unknown>;
  const custom = new Set(((x.peakRules ?? []) as Array<{ id: string; source?: string }>).filter(r => (r.source === 'custom' || r.source === 'matched')).map(r => r.id));
  const kept = Object.fromEntries(Object.entries(x.peaksByRule ?? {}).filter(([ruleId]) => custom.has(ruleId)));
  out.peaksByRule = kept;
  return out;
}

/** `a` and `b` differ, if at all, only in automatically scanned peaks (and display preferences). */
export function onlyDerivedHistoryChange(a: SerializedState, b: SerializedState): boolean {
  const strip = withoutDerivedPeaks;
  try {
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  } catch {
    return false;
  }
}

export function seedHistoryBaseline(
  state: Pick<BrowserState, '_historyStack' | 'pushSnapshot'> & Partial<Pick<BrowserState, '_historyPointer' | 'foldIntoCurrentSnapshot'>>,
  label: string,
  kind: SnapshotKind,
): void {
  const stack = state._historyStack ?? [];
  if (stack.length === 0) {
    state.pushSnapshot?.(label, { kind, coalesceKey: baselineKey() });
    return;
  }
  // Also checkpoint when things changed since the last snapshot (peaks
  // selected, a filter typed, say), so undoing the next action returns here
  // rather than to an older state. Peaks re-scanned for the view the last
  // step went to are part of that step: they update it in place.
  const current = stack[state._historyPointer ?? stack.length - 1];
  try {
    const now = serializeState(state as unknown as BrowserState);
    if (current && sameHistoryState(now, current.state)) return;
    if (current && state.foldIntoCurrentSnapshot && (now.selectedPeaks?.length ?? 0) === 0
      && onlyDerivedHistoryChange(now, current.state)) {
      state.foldIntoCurrentSnapshot(now);
      return;
    }
    state.pushSnapshot?.(label, { kind, coalesceKey: baselineKey() });
  } catch {
    // A partial state (tests, early startup) cannot be compared; skip.
  }
}

/**
 * Serialized state — all user-restorable fields with Sets converted to arrays.
 * Excludes transient/server-derived fields (loading, genes, firePeaks, etc.).
 */
/** Minimal dataset info stored in snapshots for crash recovery. */
export interface SerializedDataset {
  molecule_groups?: [string, string][];
  id: string;
  label: string;
  paths: string[];
  source_identity?: string;
  color: string;
  data_type: string;
  layer_type?: string | null;
  available_layers?: Record<string, boolean>;
  derived_layers?: Record<string, unknown>;
  /** A dataset closed while it had a reference of its own (services/panel_genomes.py): given back on reopen. */
  reference?: ClosedDatasetReference;
  /** A live-lift dataset's map, haplotypes and settings: reopened through the lift route, never as a plain BAM. */
  live_lift?: { manifest: string; haplotypes: string[]; settings: Record<string, unknown> };
}

/** A dataset's own reference as Undo gives it back (POST /api/panel_genomes/attach). */
export interface ClosedDatasetReference {
  /** Its key then (contigs-only references are keyed by dataset id, so a reopen may get another). */
  key: string;
  source: { genome_id?: string; fasta_path?: string; gtf_path?: string; contigs?: boolean };
}

export interface SerializedState {
  // The plugin packs that wrote parts of this state (api/sessionPacks.ts).
  packs?: SessionPacks;
  // Datasets (for crash recovery — paths needed to reload on backend)
  datasets?: SerializedDataset[];
  // Reference genome
  currentGenome?: string | null;
  fastaPath?: string | null;
  /** The reference collection when several FASTA/annotation pairs were loaded together (first = fastaPath). */
  referencePairs?: Array<{ fasta: string; annotation: string | null }> | null;
  /** Genomes declared for custom FASTAs (motif species, TE library): kept by the autosave, put back on Reopen. */
  genomeDeclarations?: Array<{ fasta_path: string; genome: string }>;
  // Primer config
  primerConfigBlastDb?: string | null;
  primerSavedPrimers?: unknown[];

  // Viewport
  chrom: string;
  start: number;
  end: number;
  isReversed: boolean;
  showRelativeCoords: boolean;
  relativeTSS: number | null;
  /** The gene TSS-relative coordinates are about (its strand sets the axis signs). */
  relativeGene?: unknown;

  // Clustering
  selectedPeaks: number[]; // Set → array
  /** Clusters picked for merging/subclustering, per panel key (Set → array). */
  selectedClusters?: Record<string, number[]>;
  peakModes: Record<number, string>;
  clusterK: number;
  clusterResolution?: number;
  clusterMethod: string;
  clusterPeakMode?: string;
  clusterFeatureRules?: unknown[];
  analysisSortRules?: unknown[];
  analysisFilterRules?: unknown[];
  clusterAssignments: Record<string, Record<string, number>>;
  /** SV allele splits, per state key (stores/svSlice.ts); absent in older snapshots. */
  svSplits?: Record<string, unknown>;
  differencesSession?: DifferencesSession;
  svCarrierEvidence?: Record<string, unknown>;
  /** Names a group source gave cluster ids, per state key; absent in older snapshots. */
  clusterGroupLabels?: Record<string, Record<number, string>>;
  /** SV display settings (fb-n9-sv); absent in older snapshots. */
  svDisplayEnabled?: boolean;
  svMinLen?: number;
  svMinSupport?: number;
  svConflictOptions?: SvConflictOptions;
  /** Retired (fb-n11-tracks): the SV summary is a track row; a true here restores it at its smallest height. */
  svTrackCollapsed?: boolean;
  clusterOrder: Record<string, number[]>;
  clusterPatterns: Record<number, number[]>;
  clusterCentroids?: Record<number, number[]>;
  clusterPeakWidths?: number[];
  clusterPeakRegions: Array<{ start: number; end: number; mode?: string }>;
  /** A run over panels at several loci: each panel's own matched peaks and view (older saves: none). */
  clusterMatchedRun?: import('../utils/clusterMatchedRun').ClusterMatchedRun | null;
  clusterWindowPeaks?: ClusterWindowPeaks | null;
  dynamicClustering: boolean;
  dynamicOverlapMode?: 'conservative' | 'aggressive';
  clusterTreeNodes?: Record<string, unknown>;
  clusterTreeRootIds?: string[];
  activeClusterTreeNodeId?: string | null;
  readSortOrder: Record<string, string[]>;
  subnucleosomalThreshold: number;
  accessibilityThreshold: number;
  /** Merge similar clusters' settings (older saves: none, the defaults). */
  mergeMinFraction?: number;
  mergeMaxSimilarity?: number;
  mergeStrategy?: string;
  mergeThresholds?: Record<string, number>;
  /** The merges since the last clustering, for Unmerge (stores/clusterMergeLog.ts; older saves: none). */
  clusterMergeLog?: unknown;

  // Filtering
  filteredReadIds: Record<string, string[] | null>; // Set → array
  readFilterSources?: Record<string, ReadFilterSource | null>;
  /** Reads hidden with "Exclude selected", per state key (stores/readActionsStore.ts); absent in older snapshots. */
  excludedReadIds?: Record<string, string[]>;
  clusterFocus: Record<string, number[] | null>; // Set → array
  readStateDetails: Record<string, Record<string, unknown>>;
  transcriptionStateFilters: {
    pause?: boolean;
    pic?: boolean;
    elongating?: number | null;
    elongating_max?: number | null;
  };

  // Peaks/genes — rule-based system
  peakRules?: unknown[];
  peaksByRule?: Record<string, unknown[]>;  // Custom peaks, or all peaks when locked
  peaksLocked?: boolean;
  selectedGenes: unknown[];
  // Legacy compat (old sessions before peak rules)
  customPeaks?: unknown[];
  additionalPeaks?: unknown[];

  // UI settings
  viewMode: string;
  sortMode: string;
  /** The Sort selector's last applied choice; absent in older snapshots. */
  sortSelection?: string | null;
  filterMode: string;
  spanningOnly: boolean;
  downsampleCount: number | null;
  readDisplayMode?: 'sample' | 'all';
  allReadsDisplayCap?: number;
  backgroundReadCap?: number | null;
  clusterPreparationCount?: number | null;
  clusterPreparationSamples?: Record<string, import('../types').ClusterPreparationSample>;
  analysisSampleCount?: number | null;
  analysisSampleSeed?: string;
  /** Which region Find classes analyses (utils/classRegion.ts); absent in older snapshots. */
  classRegionMode?: string;
  enabledModTypes: Record<string, boolean>;
  enabledMetaProfiles: Record<string, boolean>;
  cachedLayerTypes?: Record<string, boolean>;
  legacyLayerInference?: boolean;
  legacyNucMinSize?: number;
  clickTargetLayer?: string | null;
  footprintAnalysisLayer?: string | null;
  fillSmallGaps: boolean;
  fillGapSize: number;
  hideTerminalGaps: boolean;
  terminalGapThreshold: number;
  /** Older saves predate it: read as on (the default). */
  hideShortEndFootprints?: boolean;
  minFpQuality: number;
  minFootprints: number;
  /** Min footprints is the untouched default (it may turn itself off); older saves: false. */
  minFootprintsAuto?: boolean;
  signalFilters?: import('../utils/signalFilters').SignalFilters;
  showDuplicateReads?: boolean;
  enabledCigarTypes: { mismatches: boolean; insertions: boolean; deletions: boolean };
  darkMode: boolean;
  peakSettings: {
    smoothWidth: number;
    thresholdStrong: number;
    thresholdMedium: number;
    thresholdWeak: number;
    thresholdRare: number;
  };
  activeColormap: unknown;
  showHiddenTrackStrip?: boolean;
  fillReadHeight: boolean;
  readSeparatorMode?: 'auto' | 'fixed' | 'off';
  readSeparatorMinHeight?: number;
  readSeparatorWidth?: number;
  showReadTooltip: boolean;
  showCoverageHistogram: boolean;
  maxRegionForReads: number;
  motifThreshold: number;
  sessionName: string;
  uiScale: number;
  readRowHeight: number | 'auto';
  readScrollOffsets?: Record<string, number>;
  showGenomeOverview?: boolean;
  publicMode?: boolean;

  // Panels
  panels: unknown[];
  fullViewPanelId: string | null;
  /** "Each panel navigates" or linked (fb-r2-genomes); absent in older snapshots. */
  navigationMode?: 'linked' | 'perPanel';
  editMode: boolean;
  navigatorRegions?: unknown[];
  /** Highlighted regions (stores/highlightSlice.ts); absent in older snapshots. */
  highlights?: unknown[];
  /** The Projection map (autosave only, not undo snapshots: utils/projectionExport projectionForSave). */
  readProjection?: unknown;

  // Selection
  selectedReadIds: Record<string, string[]>; // Set → array
  selectedDatasets: string[]; // Set → array
  selectedFootprints: unknown[];
  footprintGroups: unknown[];
  footprintCrossHighlight: boolean;

  // Saved clusters cart
  savedClusters?: unknown[];

  // Selected features (stores/featureStore.ts); absent in older snapshots and sessions
  selectedFeatures?: unknown[];
  // Pinned key-factor motifs per species (the motif views); absent: keep the local preference
  pinnedMotifs?: Record<string, string[]>;
  // Motif scoring (every motif view); absent in sessions before the p / % toggle: those restore in relative mode
  motifScoreMode?: string;
  motifPValue?: number;
  customMotifs?: unknown[];
  // Plugin packs' state (stores/storeExtensions.ts) is saved under its own keys beside these.

  // Capture regions cart
  captureRegions?: unknown[];
  capturePadding?: number;

  // Strip visibility
  hiddenStripPanels?: string[]; // Set → array

  // Row layout
  collapsedRows?: number[];       // Set → array
  analysisStripCollapsed?: boolean;
  /** Co-occupancy: the saved footprints to cluster by, per locus. */
  cooccClusterSelections?: Array<{ chrom: string; start: number; end: number; groupIds: string[] }>;

  // Track catalog + cart (v3 schema)
  catalog?: CatalogEntry[];
  compositeTracks?: CompositeTrack[];
  // Saved track presets (v3 schema). Library of cart-track templates the
  // user can re-add to the cart later.
  savedTracks?: SavedTrack[];

  // Sidecar analysis-track settings.
  coaccSettings?: SerializedCoaccSettings;

  // Natural-language command history for reproducibility/export.
  commandHistory?: CommandHistoryEntry[];
}

// ============================================================
// HISTORY SLICE — Interface
// ============================================================

export interface HistorySlice {
  _historyStack: Snapshot[];
  _historyPointer: number; // Index into _historyStack, -1 = no snapshots
  _maxHistorySize: number;
  _historyPaused: boolean; // Legacy (kept for compat), prefer _lastRestoreTime
  _lastRestoreTime: number; // Timestamp of last undo/redo/jump — pushSnapshot suppressed within 1.5s
  commandHistory: CommandHistoryEntry[];

  pushSnapshot: (label: string, options?: SnapshotOptions) => void;
  /** Datasets being reopened by an undo (their labels), for the toolbar's status. */
  reopeningDatasets: string[];
  /** Apply the current history step again, with dataset ids renamed (after an undo reopened a dataset). */
  /** Rename dataset ids in every history step (a reopened dataset came back under another id).
   *  Returns the renames made, including those that moved other datasets out of the way. */
  remapHistoryDatasetIds: (idMap: Record<string, string>) => Record<string, string>;
  reapplyCurrentSnapshot: () => void;
  /**
   * The current step's saved state becomes `snapshotState` (its label, time
   * and place stay): derived data computed after the step (re-scanned peaks)
   * joins it rather than making an undo step of its own. Not while history is paused.
   */
  foldIntoCurrentSnapshot: (snapshotState: SerializedState) => void;
  pushSerializedSnapshot: (label: string, snapshotState: SerializedState, options?: { kind?: SnapshotKind; coalesceKey?: string; coalesceMs?: number }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  getHistoryLabels: () => Array<{ label: string; timestamp: number; isCurrent: boolean; kind: SnapshotKind }>;
  restoreSnapshot: (index: number, options?: { restoreViewport?: boolean }) => void;
  jumpToSnapshot: (index: number) => void;
  clearHistory: () => void;
  addCommandHistoryEntry: (entry: CommandHistoryEntry) => void;
  updateCommandHistoryEntry: (id: string, updates: Partial<CommandHistoryEntry>) => void;
  clearCommandHistory: () => void;
}

// ============================================================
// Serialization helpers
// ============================================================

function serializeSet<T>(s: Set<T> | T[] | undefined): T[] {
  return toArray<T>(s);
}

function serializeSetRecord<K extends string>(
  rec: Record<K, Set<unknown> | null> | undefined,
): Record<K, unknown[] | null> {
  if (!rec) return {} as Record<K, unknown[] | null>;
  const out = {} as Record<K, unknown[] | null>;
  for (const [k, v] of Object.entries(rec) as Array<[K, Set<unknown> | null]>) {
    out[k] = v ? toArray(v) : null;
  }
  return out;
}

const COALESCED_KINDS = new Set<SnapshotKind>(['sorting', 'filtering']);

function inferSnapshotKind(label: string): SnapshotKind {
  const lower = label.toLowerCase();
  if (lower.includes('reset view')) return 'view';
  if (lower.startsWith('navigate') || lower.includes('view')) return 'navigation';
  if (lower.startsWith('cluster') || lower.includes('autocull')) return 'clustering';
  if (lower.startsWith('sort')) return 'sorting';
  if (lower.includes('label') || lower.includes('colormap') || lower.includes('background') || lower.includes('opacity') || lower.includes('smoothing')) return 'labeling';
  if (lower.includes('filter')) return 'filtering';
  if (lower.includes('session') || lower.includes('import')) return 'session';
  if (lower.includes('panel') || lower.includes('layout') || lower.includes('link') || lower.includes('unlink')) return 'layout';
  if (lower.includes('peak') || lower.includes('capture') || lower.includes('primer')) return 'analysis';
  return 'other';
}

function coalesceKeyFor(kind: SnapshotKind, explicit?: string): string | undefined {
  if (explicit) return explicit;
  return COALESCED_KINDS.has(kind) ? kind : undefined;
}

/** A dataset as snapshots keep it: enough to open it again from its files. */
export function serializeDataset(d: any): SerializedDataset {
  return {
    id: d.id,
    label: d.label,
    paths: d.paths || (d.path ? [d.path] : []),
    ...(d.source_identity ? { source_identity: d.source_identity } : {}),
    ...(d.molecule_groups ? { molecule_groups: d.molecule_groups.map((p: [string, string]) => [p[0], p[1]] as [string, string]) } : {}),
    color: d.color,
    data_type: d.data_type,
    layer_type: d.layer_type ?? null,
    available_layers: d.available_layers ?? {},
    derived_layers: d.derived_layers ?? {},
    ...(d.live_lift ? { live_lift: { manifest: d.live_lift.manifest, haplotypes: d.live_lift.haplotypes,
      settings: d.live_lift.settings } } : {}),
  };
}

/**
 * The datasets to reopen and to close when the history pointer moves from
 * `from` to `to`: going back across a step that closed datasets reopens them;
 * going forward across it closes them again.
 */
export function datasetChangesBetween(stack: Snapshot[], from: number, to: number): { reopen: SerializedDataset[]; close: SerializedDataset[] } {
  const reopen: SerializedDataset[] = [];
  const close: SerializedDataset[] = [];
  if (to < from) {
    for (let i = from; i > to; i--) reopen.push(...(stack[i]?.closedDatasets ?? []));
  } else {
    for (let i = from + 1; i <= to; i++) close.push(...(stack[i]?.closedDatasets ?? []));
  }
  return { reopen, close };
}

// A dataset's own-contigs reference key (services/panel_genomes.py): `contigs:<dataset id>`.
const CONTIGS_KEY = 'contigs:';
// Fields whose string values are dataset ids or per-dataset state keys.
// (`dataset_id`: a graph run's observations, ClusterMatchedRun.graph, in the server's spelling.)
const DATASET_ID_FIELDS = new Set(['datasetId', 'sourceDatasetId', 'datasetIds', 'stateKey', 'stateKeys', 'dataset_id']);
// Top-level records keyed by a dataset's state key (its id, or `<id>:…`).
const DATASET_KEYED_RECORDS = new Set([
  'selectedClusters', 'clusterAssignments', 'clusterOrder', 'readSortOrder', 'filteredReadIds',
  'readFilterSources', 'clusterFocus', 'readStateDetails', 'readScrollOffsets', 'selectedReadIds',
  'excludedReadIds', 'svSplits', 'clusterGroupLabels', 'svCarrierEvidence',
]);
// The same, inside each cluster-tree branch (ClusterTreeNode).
const CLUSTER_TREE_NODE_KEYED_RECORDS = ['assignments', 'order', 'focus', 'readScope', 'groupLabels'];

/**
 * Rename dataset ids in a serialized state (a reopened dataset can come back
 * under another id): the `id` of entries in `datasets`, values of the
 * dataset-id fields anywhere (panels' datasetId/stateKey, …), and the keys of
 * the per-dataset records. Nothing else: field names, labels and read names
 * that happen to equal a dataset id stay as they are. An array is taken as a
 * list of datasets (a step's closedDatasets). The renaming is simultaneous, so
 * `{a: 'b', b: 'c'}` swaps cleanly.
 */
export function remapDatasetIds<T>(value: T, idMap: Record<string, string>): T {
  if (!Object.keys(idMap).some(k => idMap[k] !== k)) return value;
  const mapId = (v: string): string => {
    if (Object.prototype.hasOwnProperty.call(idMap, v)) return idMap[v];
    const at = v.indexOf('@');
    if (at > 0) return mapId(v.slice(0, at)) + v.slice(at);
    const colon = v.indexOf(':');
    const head = colon > 0 ? v.slice(0, colon) : '';
    if (head && Object.prototype.hasOwnProperty.call(idMap, head)) return idMap[head] + v.slice(colon);
    return v;
  };
  const mapIdValues = (v: unknown): unknown =>
    typeof v === 'string' ? mapId(v) : Array.isArray(v) ? v.map(mapIdValues) : v;
  // Dataset-id fields wherever they sit (panels, cluster tree nodes, …).
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // A panel on its dataset's own contigs (reference key `contigs:<dataset id>`).
      if (k === 'genome' && typeof x === 'string' && x.startsWith(CONTIGS_KEY)) out[k] = CONTIGS_KEY + mapId(x.slice(CONTIGS_KEY.length));
      else out[k] = DATASET_ID_FIELDS.has(k) ? mapIdValues(x) : walk(x);
    }
    return out;
  };
  const mapDatasets = (list: unknown): unknown => (Array.isArray(list)
    ? list.map(d => (d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string'
      ? { ...(d as object), id: mapId((d as { id: string }).id) } : d))
    : list);
  const mapKeys = (x: unknown): unknown => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [mapId(k), y]))
    : x);
  // A run's per-window peaks and views, keyed by each window's state key.
  const mapWindowPeaks = (x: unknown): unknown => {
    const w = walk(x) as Record<string, unknown>;
    return { ...w, byKey: mapKeys(w.byKey), ...('views' in w ? { views: mapKeys(w.views) } : {}) };
  };
  // Unmerge's steps keep the reads they moved per state key, and the other
  // clustering's order: their record keys (call on a log already walked, once).
  const mapMergeLogKeys = (w: Record<string, unknown>): Record<string, unknown> => {
    if ('otherOrder' in w) w.otherOrder = mapKeys(w.otherOrder);
    if (Array.isArray(w.steps)) {
      w.steps = w.steps.map(step => (step && typeof step === 'object' && !Array.isArray(step)
        ? { ...(step as Record<string, unknown>), moved: mapKeys((step as Record<string, unknown>).moved) }
        : step));
    }
    return w;
  };
  // A cluster-tree branch keeps its results per state key as well.
  const mapTreeNode = (node: unknown): unknown => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const out = walk(node) as Record<string, unknown>;
    for (const field of CLUSTER_TREE_NODE_KEYED_RECORDS) if (field in out) out[field] = mapKeys(out[field]);
    return out;
  };
  if (Array.isArray(value)) return mapDatasets(value) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [field, x] of Object.entries(value as Record<string, unknown>)) {
    // Saved content/provenance identities and reversible historical snapshots
    // are not the reopened dataset's locator. Keep them for deliberate relink.
    if (field === 'differencesSession') out[field] = x;
    else if (field === 'datasets') out[field] = mapDatasets(x);
    else if (DATASET_KEYED_RECORDS.has(field)) out[field] = mapKeys(x);
    else if (field === 'clusterWindowPeaks' && x && typeof x === 'object' && !Array.isArray(x)) {
      out[field] = mapWindowPeaks(x);
    } else if (field === 'clusterMatchedRun' && x && typeof x === 'object' && !Array.isArray(x)) {
      const run = walk(x) as Record<string, unknown>;
      out[field] = { ...run, assignments: mapKeys(run.assignments), panelAssignments: mapKeys(run.panelAssignments),
        windows: Array.isArray(run.windows) ? run.windows.map((w: any) => ({ ...w, key: mapId(w.key) })) : [] };
    } else if (field === 'savedClusters' && Array.isArray(x)) {
      // A saved clustering keeps its results by dataset id, and each window's peaks by state key.
      out[field] = x.map(saved => {
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return saved;
        const w = walk(saved) as Record<string, unknown>;
        for (const f of ['assignments', 'order']) if (f in w) w[f] = mapKeys(w[f]);
        if (w.windowPeaks && typeof w.windowPeaks === 'object') w.windowPeaks = mapWindowPeaks(w.windowPeaks);
        // ...and the merges behind it (fb-n6-integ; walk renamed its stateKeys already).
        if (w.mergeLog && typeof w.mergeLog === 'object' && !Array.isArray(w.mergeLog)) w.mergeLog = mapMergeLogKeys(w.mergeLog as Record<string, unknown>);
        return w;
      });
    } else if (field === 'clusterMergeLog' && x && typeof x === 'object' && !Array.isArray(x)) {
      out[field] = mapMergeLogKeys(walk(x) as Record<string, unknown>);
    } else if (field === 'clusterTreeNodes' && x && typeof x === 'object' && !Array.isArray(x)) {
      out[field] = Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, node]) => [k, mapTreeNode(node)]));
    } else out[field] = walk(x);
  }
  return out as T;
}

/**
 * Extend a reopen's renames so no two datasets of the history end up sharing
 * an id: when a reopened dataset takes an id another (closed) dataset of the
 * history still has, that one moves to a fresh id. (Load sample.bam twice as
 * `sample` and `sample_1`, close both, Undo twice: the second file comes back
 * as `sample`, so the first one's history id must make room.)
 */
export function collisionFreeIdMap(stack: Snapshot[], idMap: Record<string, string>): Record<string, string> {
  const historical = new Set<string>();
  for (const snap of stack) {
    for (const d of snap.state?.datasets ?? []) historical.add(d.id);
    for (const d of snap.closedDatasets ?? []) historical.add(d.id);
  }
  const out = { ...idMap };
  const taken = new Set([...historical, ...Object.values(out)]);
  for (const target of Object.values(idMap)) {
    if (!historical.has(target) || Object.prototype.hasOwnProperty.call(out, target)) continue;
    let n = 1;
    let fresh = `${target}~${n}`;
    while (taken.has(fresh)) fresh = `${target}~${++n}`;
    out[target] = fresh;
    taken.add(fresh);
  }
  return out;
}

/** A saved clusterWindowPeaks as the store takes it (null: none, or not one). */
function normalizeClusterWindowPeaks(value: unknown): ClusterWindowPeaks | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<ClusterWindowPeaks>;
  if (!Array.isArray(v.regions) || !v.byKey || typeof v.byKey !== 'object') return null;
  return { regions: v.regions, byKey: v.byKey, ...(v.views && typeof v.views === 'object' ? { views: v.views } : {}) };
}

/** Extract the restorable subset of state and convert Sets to arrays. */
/** The navigation mode a snapshot or session was saved in (older ones: linked unless a panel says otherwise). */
function savedNavigationMode(s: SerializedState): 'linked' | 'perPanel' {
  if (s.navigationMode === 'perPanel' || s.navigationMode === 'linked') return s.navigationMode;
  return (s.panels ?? []).some(p => Boolean((p as { navOwn?: boolean } | null)?.navOwn)) ? 'perPanel' : 'linked';
}

export function serializeState(state: BrowserState): SerializedState {
  // Which plugin packs wrote parts of this state: a build without one leaves them out of an undo step, a recovered
  // state or a session (api/sessionPacks.ts).
  const packs = sessionPackMarker();
  return {
    ...(Object.keys(packs).length ? { packs } : {}),
    // Datasets (for crash recovery)
    datasets: (state.datasets || []).map(serializeDataset),
    currentGenome: (state as any).currentGenome ?? null,
    fastaPath: (state as any).fastaPath ?? null,
    referencePairs: (state as any).referencePairs ?? null,
    primerConfigBlastDb: state.primer?.configBlastDb ?? null,
    primerSavedPrimers: state.primer?.savedPrimers ?? [],

    // Viewport
    chrom: state.chrom,
    start: state.start,
    end: state.end,
    isReversed: state.isReversed,
    showRelativeCoords: state.showRelativeCoords,
    relativeTSS: state.relativeTSS,
    relativeGene: state.relativeGene,

    // Clustering
    selectedPeaks: serializeSet(state.selectedPeaks),
    selectedClusters: Object.fromEntries(
      Object.entries(state.selectedClusters ?? {}).map(([k, v]) => [k, serializeSet(v)]),
    ),
    peakModes: { ...state.peakModes },
    clusterK: state.clusterK,
    clusterResolution: state.clusterResolution,
    clusterMethod: state.clusterMethod,
    clusterPeakMode: state.clusterPeakMode,
    clusterFeatureRules: normalizeClusterFeatureRules(state.clusterFeatureRules),
    analysisSortRules: normalizeAnalysisSortRules(state.analysisSortRules),
    analysisFilterRules: normalizeAnalysisFilterRules(state.analysisFilterRules),
    clusterAssignments: state.clusterAssignments,
    svSplits: state.svSplits ?? {},
    differencesSession: state.differencesSession,
    svCarrierEvidence: state.svCarrierEvidence ?? {},
    clusterGroupLabels: state.clusterGroupLabels ?? {},
    clusterOrder: state.clusterOrder,
    clusterPatterns: state.clusterPatterns,
    clusterCentroids: state.clusterCentroids,
    clusterPeakWidths: state.clusterPeakWidths,
    clusterPeakRegions: state.clusterPeakRegions,
    clusterMatchedRun: state.clusterMatchedRun ?? null,
    clusterWindowPeaks: state.clusterWindowPeaks ?? null,
    dynamicClustering: state.dynamicClustering,
    dynamicOverlapMode: state.dynamicOverlapMode,
    clusterTreeNodes: state.clusterTreeNodes,
    clusterTreeRootIds: state.clusterTreeRootIds,
    activeClusterTreeNodeId: state.activeClusterTreeNodeId,
    readSortOrder: state.readSortOrder,
    subnucleosomalThreshold: state.subnucleosomalThreshold,
    accessibilityThreshold: state.accessibilityThreshold,
    mergeMinFraction: state.mergeMinFraction,
    mergeMaxSimilarity: state.mergeMaxSimilarity,
    mergeStrategy: state.mergeStrategy,
    mergeThresholds: { ...(state.mergeThresholds ?? {}) },
    clusterMergeLog: state.clusterMergeLog ?? null,

    // Filtering — convert Sets to arrays
    filteredReadIds: serializeSetRecord(
      state.filteredReadIds as Record<string, Set<string> | null>,
    ) as Record<string, string[] | null>,
    readFilterSources: state.readFilterSources,
    excludedReadIds: serializeExcludedReads(),
    clusterFocus: serializeSetRecord(
      state.clusterFocus as Record<string, Set<number> | null>,
    ) as Record<string, number[] | null>,
    readStateDetails: state.readStateDetails as Record<string, Record<string, unknown>>,
    transcriptionStateFilters: normalizeTranscriptionStateFilters(state.transcriptionStateFilters),

    // Peaks/genes — peak rules and each rule's current peaks.
    peakRules: state.peakRules,
    // Always keep the peaks themselves: the saved peak selection indexes
    // into them, and auto-scan does not run while a selection exists, so a
    // restore without them showed a selection pointing at nothing.
    peaksByRule: (() => {
      const saved: Record<string, unknown[]> = {};
      for (const [ruleId, peaks] of Object.entries(state.peaksByRule)) {
        if (peaks.length > 0) saved[ruleId] = peaks.map(p => ({ ...p }));
      }
      return saved;
    })(),
    peaksLocked: state.peaksLocked,
    selectedGenes: state.selectedGenes,

    // UI settings
    viewMode: state.viewMode,
    sortMode: state.sortMode,
    sortSelection: state.sortSelection ?? null,
    filterMode: state.filterMode,
    spanningOnly: state.spanningOnly,
    downsampleCount: state.downsampleCount,
    readDisplayMode: state.readDisplayMode,
    allReadsDisplayCap: state.allReadsDisplayCap,
    backgroundReadCap: state.backgroundReadCap,
    clusterPreparationCount: state.clusterPreparationCount,
    clusterPreparationSamples: state.clusterPreparationSamples,
    analysisSampleCount: state.analysisSampleCount,
    analysisSampleSeed: state.analysisSampleSeed,
    classRegionMode: state.classRegionMode,
    enabledModTypes: normalizeLayerToggleMap(state.enabledModTypes) ?? {},
    enabledMetaProfiles: normalizeLayerToggleMap(state.enabledMetaProfiles) ?? {},
    cachedLayerTypes: normalizeLayerToggleMap(state.cachedLayerTypes) ?? {},
    legacyLayerInference: state.legacyLayerInference,
    legacyNucMinSize: state.legacyNucMinSize,
    clickTargetLayer: normalizeAnnotationLayer(state.clickTargetLayer),
    footprintAnalysisLayer: normalizeAnnotationLayer(state.footprintAnalysisLayer),
    fillSmallGaps: state.fillSmallGaps,
    fillGapSize: state.fillGapSize,
    hideTerminalGaps: state.hideTerminalGaps,
    terminalGapThreshold: state.terminalGapThreshold,
    hideShortEndFootprints: state.hideShortEndFootprints,
    minFpQuality: state.minFpQuality,
    minFootprints: state.minFootprints,
    minFootprintsAuto: state.minFootprintsAuto,
    signalFilters: { ...state.signalFilters },
    showDuplicateReads: state.showDuplicateReads,
    enabledCigarTypes: { ...state.enabledCigarTypes },
    svDisplayEnabled: state.svDisplayEnabled,
    svMinLen: state.svMinLen,
    svMinSupport: state.svMinSupport,
    svConflictOptions: state.svConflictOptions,
    darkMode: state.darkMode,
    peakSettings: { ...state.peakSettings },
    activeColormap: migrateColormap(state.activeColormap as any),
    showHiddenTrackStrip: state.showHiddenTrackStrip,
    fillReadHeight: state.fillReadHeight,
    readSeparatorMode: state.readSeparatorMode,
    readSeparatorMinHeight: state.readSeparatorMinHeight,
    readSeparatorWidth: state.readSeparatorWidth,
    showReadTooltip: state.showReadTooltip,
    showCoverageHistogram: state.showCoverageHistogram,
    maxRegionForReads: state.maxRegionForReads,
    motifThreshold: state.motifThreshold,
    sessionName: state.sessionName,
    uiScale: state.uiScale,
    readRowHeight: state.readRowHeight,
    readScrollOffsets: { ...state.readScrollOffsets },
    showGenomeOverview: state.showGenomeOverview,
    publicMode: state.publicMode,

    // Panels
    panels: state.panels,
    fullViewPanelId: state.fullViewPanelId,
    navigationMode: state.navigationMode,
    editMode: state.editMode,
    navigatorRegions: state.navigatorRegions,
    highlights: state.highlights ?? [],

    // Selection — convert Sets to arrays
    selectedReadIds: Object.fromEntries(
      Object.entries(state.selectedReadIds).map(([k, v]) => [k, serializeSet(v)]),
    ),
    selectedDatasets: serializeSet(state.selectedDatasets),
    selectedFootprints: state.selectedFootprints,
    footprintGroups: normalizeFootprintGroups(state.footprintGroups),
    footprintCrossHighlight: state.footprintCrossHighlight,

    // Saved clusters cart
    savedClusters: state.savedClusters,
    selectedFeatures: normalizeFeatureRefs(state.selectedFeatures),
    pinnedMotifs: normalizePinnedMotifs(state.pinnedMotifs),
    motifScoreMode: state.motifScoreMode,
    motifPValue: state.motifPValue,
    customMotifs: state.customMotifs,
    // Plugin packs' state (stores/storeExtensions.ts).
    ...serializeExtensions(state),

    // Capture regions cart
    captureRegions: state.captureRegions,
    capturePadding: state.capturePadding,

    // Strip visibility
    hiddenStripPanels: serializeSet(state.hiddenStripPanels),

    // Row layout
    collapsedRows: serializeSet(state.collapsedRows),
    analysisStripCollapsed: state.analysisStripCollapsed,
    cooccClusterSelections: (state.cooccClusterSelections ?? []).map(entry => ({ ...entry, groupIds: [...entry.groupIds] })),

    // Track catalog + cart + saved presets (v3)
    catalog: state.catalog ?? [],
    compositeTracks: state.compositeTracks ?? [],
    savedTracks: state.savedTracks ?? [],
    coaccSettings: serializeCoaccSettings(),
    commandHistory: state.commandHistory ?? [],
  };
}

/**
 * Convert serialized state back into store-compatible partial, restoring Sets.
 *
 * @param s - The serialized snapshot state
 * @param currentState - If provided, used to validate datasets/panels (undo/redo mode).
 *   When set, datasets and panels are NOT overwritten — merge/unmerge changes backend
 *   state irreversibly. Only analysis state (clustering, sorting, filtering, UI) is restored.
 *   When null, datasets ARE restored (crash recovery mode).
 */
function deserializeState(
  s: SerializedState,
  currentState?: BrowserState,
  options: { restoreViewport?: boolean } = {},
): Partial<BrowserState> {
  // Saved by a build with plugin packs this one doesn't have: their panels (and what only they showed) left out.
  s = withoutMissingPackState(s);
  const differences = restoreDifferencesSession(s as unknown as Record<string, unknown>);
  s = { ...s, ...restoreHistoricalMembership(s, differences) };
  const svSplits = normalizeSvSplits(legacySplitDefinitions(s as unknown as Record<string, unknown>));
  for (const [key, def] of Object.entries(svSplits)) {
    if (!s.differencesSession || differences.targets[key]?.frozen) def.frozenImport = true;
  }
  applyCoaccSettings(s.coaccSettings);
  applyExcludedReads(s.excludedReadIds);

  // Restore filteredReadIds: array → Set
  const filteredReadIds: Record<string, Set<string> | null> = {};
  for (const [k, v] of Object.entries(s.filteredReadIds ?? {})) {
    filteredReadIds[k] = v ? toSet<string>(v) : null;
  }

  // Restore clusterFocus: array → Set
  const clusterFocus: Record<string, Set<number> | null> = {};
  for (const [k, v] of Object.entries(s.clusterFocus ?? {})) {
    clusterFocus[k] = v ? toSet<number>(v) : null;
  }

  // Restore selectedReadIds: array → Set
  const selectedReadIds: Record<string, Set<string>> = {};
  for (const [k, v] of Object.entries(s.selectedReadIds ?? {})) {
    selectedReadIds[k] = toSet<string>(v);
  }

  // Determine whether to restore datasets/panels.
  // In undo/redo mode (currentState provided): only restore panels if dataset IDs match.
  // Merge/unmerge changes backend state irreversibly, so we keep current datasets/panels
  // if they've diverged.
  let datasetsAndPanels: Partial<BrowserState> = {};
  if (!currentState) {
    // Crash recovery mode — restore everything
    datasetsAndPanels = {
      ...(s.datasets ? { datasets: s.datasets as any } : {}),
      ...(s.currentGenome !== undefined ? { currentGenome: s.currentGenome } : {}),
      panels: migratePanelTracks(migrateSitePanels(migratePanelAliases((s.panels ?? []) as any[])), s.svTrackCollapsed === true) as any,
      fullViewPanelId: s.fullViewPanelId,
      navigationMode: savedNavigationMode(s),
    };
  } else {
    // Undo/redo mode — check if dataset IDs still match
    const currentDsIds = new Set(currentState.datasets.map((d: any) => d.id));
    const snapshotDsIds = new Set((s.datasets || []).map(d => d.id));
    const match = currentDsIds.size === snapshotDsIds.size &&
      [...currentDsIds].every(id => snapshotDsIds.has(id));

    if (match) {
      // Dataset IDs match — safe to restore panels (link/unlink changes, etc.)
      datasetsAndPanels = {
        panels: migratePanelTracks(migrateSitePanels(migratePanelAliases((s.panels ?? []) as any[])), s.svTrackCollapsed === true) as any,
        fullViewPanelId: s.fullViewPanelId,
        navigationMode: savedNavigationMode(s),
      };
    }
    // If IDs don't match (merge/unmerge happened), keep current datasets + panels
  }
  const performanceProfile = getBrowserPerformanceProfile();

  return validateMatchedState({
    ...datasetsAndPanels,

    // Viewport — only restore on crash recovery (no currentState).
    // For undo/redo, keep current viewport — undo should reverse the action
    // (clustering, sorting, etc.) without teleporting the user.
    ...(!currentState || options.restoreViewport ? {
      chrom: s.chrom,
      start: s.start,
      end: s.end,
      isReversed: s.isReversed,
      showRelativeCoords: s.showRelativeCoords,
      relativeTSS: s.relativeTSS,
      ...(s.relativeGene !== undefined ? { relativeGene: s.relativeGene as never } : {}),
    } : {}),
    ...(s.selectedClusters ? {
      selectedClusters: Object.fromEntries(
        Object.entries(s.selectedClusters).map(([k, v]) => [k, toSet<number>(v)]),
      ),
    } : {}),

    // Clustering
    selectedPeaks: toSet<number>(s.selectedPeaks),
    correspondenceScans: {},
    peakModes: s.peakModes as any,
    clusterK: s.clusterK,
    clusterResolution: s.clusterResolution ?? 1,
    clusterMethod: s.clusterMethod,
    clusterPeakMode: (s.clusterPeakMode ?? 'accessibility') as any,
    clusterFeatureRules: normalizeClusterFeatureRules(s.clusterFeatureRules),
    analysisSortRules: normalizeAnalysisSortRules(s.analysisSortRules),
    analysisFilterRules: normalizeAnalysisFilterRules(s.analysisFilterRules),
    clusterAssignments: s.clusterAssignments,
    svSplits,
    differencesSession: differences,
    svCarrierEvidence: normalizeSvCarrierEvidence(s.svCarrierEvidence),
    clusterGroupLabels: normalizeClusterGroupLabels(s.clusterGroupLabels),
    clusterOrder: s.clusterOrder,
    clusterPatterns: s.clusterPatterns,
    clusterCentroids: s.clusterCentroids ?? {},
    clusterPeakWidths: s.clusterPeakWidths ?? [],
    clusterPeakRegions: s.clusterPeakRegions,
    clusterMatchedRun: s.clusterMatchedRun ?? null,
    clusterWindowPeaks: normalizeClusterWindowPeaks(s.clusterWindowPeaks),
    dynamicClustering: s.dynamicClustering,
    dynamicOverlapMode: s.dynamicOverlapMode ?? 'aggressive',
    clusterTreeNodes: (s.clusterTreeNodes ?? {}) as any,
    clusterTreeRootIds: s.clusterTreeRootIds ?? [],
    activeClusterTreeNodeId: s.activeClusterTreeNodeId ?? null,
    readSortOrder: s.readSortOrder,
    subnucleosomalThreshold: s.subnucleosomalThreshold,
    accessibilityThreshold: s.accessibilityThreshold,
    ...restoredMergeSettings(s),
    clusterMergeLog: normalizeMergeLog(s.clusterMergeLog),

    // Filtering
    filteredReadIds,
    readFilterSources: s.readFilterSources ?? {},
    clusterFocus,
    readStateDetails: s.readStateDetails as any,
    transcriptionStateFilters: normalizeTranscriptionStateFilters(s.transcriptionStateFilters),

    // Peaks/genes — restore peak rules + peaksByRule
    ...(s.peakRules ? { peakRules: s.peakRules as any } : {}),
    ...(s.peaksByRule ? { peaksByRule: s.peaksByRule as any } : (
      // Legacy migration: convert old customPeaks to peaksByRule
      s.customPeaks && (s.customPeaks as any[]).length > 0
        ? { peaksByRule: { 'default-custom': s.customPeaks } as any }
        : {}
    )),
    peaksLocked: s.peaksLocked ?? false,
    selectedGenes: s.selectedGenes as any,

    // UI settings
    viewMode: s.viewMode as any,
    sortMode: s.sortMode as any,
    sortSelection: typeof s.sortSelection === 'string' ? s.sortSelection : null,
    filterMode: s.filterMode as any,
    spanningOnly: s.spanningOnly,
    downsampleCount: s.downsampleCount,
    readDisplayMode: s.readDisplayMode === 'all' ? 'all' : 'sample',
    allReadsDisplayCap: s.allReadsDisplayCap ?? performanceProfile.defaultAllReadsDisplayCap,
    backgroundReadCap: s.backgroundReadCap ?? performanceProfile.defaultBackgroundReadCap,
    clusterPreparationCount: s.clusterPreparationCount ?? null,
    clusterPreparationSamples: s.clusterPreparationSamples ?? {},
    analysisSampleCount: s.analysisSampleCount ?? null,
    analysisSampleSeed: s.analysisSampleSeed ?? 'fiberbrowser-analysis',
    classRegionMode: isClassRegionMode(s.classRegionMode) ? s.classRegionMode : DEFAULT_CLASS_REGION_MODE,
    enabledModTypes: (normalizeLayerToggleMap(s.enabledModTypes as any) ?? {}) as any,
    enabledMetaProfiles: normalizeLayerToggleMap(s.enabledMetaProfiles as any) ?? {},
    cachedLayerTypes: normalizeLayerToggleMap(s.cachedLayerTypes as any) ?? {},
    legacyLayerInference: s.legacyLayerInference ?? true,
    legacyNucMinSize: s.legacyNucMinSize ?? 90,
    clickTargetLayer: normalizeAnnotationLayer(s.clickTargetLayer),
    footprintAnalysisLayer: normalizeAnnotationLayer(s.footprintAnalysisLayer),
    fillSmallGaps: s.fillSmallGaps,
    fillGapSize: s.fillGapSize,
    hideTerminalGaps: s.hideTerminalGaps,
    terminalGapThreshold: s.terminalGapThreshold,
    hideShortEndFootprints: s.hideShortEndFootprints ?? true,
    minFpQuality: s.minFpQuality,
    minFootprints: s.minFootprints,
    // A restored value is the user's unless the save says it was the untouched default.
    minFootprintsAuto: s.minFootprintsAuto ?? false,
    // "Min footprints is off" is about the live setting: gone once a restore turns it back on.
    ...(s.minFootprints !== 0 ? { minFootprintsNotice: null } : {}),
    signalFilters: normalizeSignalFilters(s.signalFilters),
    showDuplicateReads: s.showDuplicateReads ?? false,
    enabledCigarTypes: s.enabledCigarTypes,
    svDisplayEnabled: s.svDisplayEnabled ?? true,
    svMinLen: clampMinSvLen(s.svMinLen ?? SV_MIN_LEN_DEFAULT),
    svConflictOptions: normalizeSvConflictOptions(s.svConflictOptions),
    svMinSupport: clampMinSvSupport(s.svMinSupport ?? SV_MIN_SUPPORT_DEFAULT),
    // Theme and UI size are preferences, not steps: undo/redo keep the current ones.
    ...(!currentState && s.darkMode !== undefined ? { darkMode: s.darkMode } : {}),
    peakSettings: s.peakSettings,
    activeColormap: migrateColormap(s.activeColormap as any),
    showHiddenTrackStrip: s.showHiddenTrackStrip ?? true,
    fillReadHeight: s.fillReadHeight,
    readSeparatorMode: s.readSeparatorMode === 'fixed' || s.readSeparatorMode === 'off' ? s.readSeparatorMode : 'auto',
    readSeparatorMinHeight: typeof s.readSeparatorMinHeight === 'number' ? s.readSeparatorMinHeight : 3,
    readSeparatorWidth: typeof s.readSeparatorWidth === 'number' ? s.readSeparatorWidth : 1,
    showReadTooltip: s.showReadTooltip,
    showCoverageHistogram: s.showCoverageHistogram,
    maxRegionForReads: s.maxRegionForReads ?? performanceProfile.defaultMaxRegionForReads,
    motifThreshold: s.motifThreshold,
    sessionName: s.sessionName,
    ...(!currentState && s.uiScale !== undefined ? { uiScale: s.uiScale } : {}),
    readRowHeight: s.readRowHeight,
    readScrollOffsets: s.readDisplayMode === 'all' ? s.readScrollOffsets ?? {} : {},
    showGenomeOverview: s.showGenomeOverview ?? true,
    publicMode: s.publicMode ?? false,

    editMode: s.editMode,
    navigatorRegions: (s.navigatorRegions ?? []) as any,
    highlights: normalizeHighlights(s.highlights),

    // Selection
    selectedReadIds,
    selectedDatasets: toSet<string>(s.selectedDatasets),
    selectedFootprints: s.selectedFootprints as any,
    footprintGroups: normalizeFootprintGroups(s.footprintGroups),
    footprintCrossHighlight: s.footprintCrossHighlight,

    // Saved clusters cart
    savedClusters: (s.savedClusters ?? []) as any,
    selectedFeatures: normalizeFeatureRefs(s.selectedFeatures),
    ...(s.pinnedMotifs ? { pinnedMotifs: normalizePinnedMotifs(s.pinnedMotifs) } : {}),
    // a snapshot from before the toggle: relative mode (the scoring it was made with)
    motifScoreMode: s.motifScoreMode == null ? 'relative' : normalizeScoreMode(s.motifScoreMode),
    ...(s.motifPValue != null ? { motifPValue: clampMotifP(s.motifPValue) } : {}),
    ...(s.customMotifs ? { customMotifs: normalizeCustomMotifs(s.customMotifs) } : {}),
    // Plugin packs' state (stores/storeExtensions.ts).
    ...(restoreExtensions(s as unknown as Record<string, unknown>) as Partial<BrowserState>),

    // Capture regions cart
    captureRegions: (s.captureRegions ?? []) as any,
    capturePadding: s.capturePadding ?? 0,

    // Strip visibility
    ...(s.hiddenStripPanels ? { hiddenStripPanels: new Set([...toSet<string>(s.hiddenStripPanels)].map(t => canonicalPanelType(t))) } : {}),

    // Row layout
    ...(s.collapsedRows ? { collapsedRows: toSet<number>(s.collapsedRows) } : {}),
    ...(s.analysisStripCollapsed !== undefined ? { analysisStripCollapsed: s.analysisStripCollapsed } : {}),
    ...(s.cooccClusterSelections ? { cooccClusterSelections: s.cooccClusterSelections.map(entry => ({ ...entry, groupIds: [...entry.groupIds] })) } : {}),

    // Track catalog + cart (v3 schema). When the snapshot was written before
    // P3 (no `catalog`/`compositeTracks` keys), leave the current store
    // values alone — legacy ortho-${n} slots still render through the
    // SubTrackDispatch fallback path until the user explicitly creates a
    // composite or the backend migration runs.
    ...(s.catalog ? { catalog: stripCatalogTrackIndices(s.catalog) } : {}),
    ...(s.compositeTracks ? { compositeTracks: s.compositeTracks } : {}),
    ...(s.savedTracks ? { savedTracks: s.savedTracks } : {}),
    commandHistory: s.commandHistory ?? currentState?.commandHistory ?? [],

    // Primer config — restore BLAST DB and saved primers. Merge with the
    // current primer state so transient fields (mode, dafcQuads,
    // cartTrackDisplay, ...) aren't clobbered with undefined, which would
    // crash the panel on render.
    ...(s.primerConfigBlastDb !== undefined || s.primerSavedPrimers !== undefined
      ? {
          primer: {
            ...(currentState?.primer ?? {}),
            targetStart: null,
            targetEnd: null,
            pair: null,
            configFasta: currentState?.primer?.configFasta ?? null,
            configBlastDb: s.primerConfigBlastDb ?? null,
            designing: false,
            error: null,
            designResults: [],
            savedPrimers: (s.primerSavedPrimers as any[]) ?? [],
            dafcQuads: [],
            mode: currentState?.primer?.mode ?? 'standard',
            cartTrackDisplay: currentState?.primer?.cartTrackDisplay ?? 'off',
          },
        }
      : {}),
  } as Partial<BrowserState>);
}

/**
 * A saved state as the store takes it back whole (crash recovery, reopening
 * the last session): every field undo knows, so a field added to snapshots
 * comes back there too.
 */
export function deserializeSavedState(s: SerializedState): Partial<BrowserState> {
  return deserializeState(s);
}

// ============================================================
// HISTORY SLICE — Implementation
// ============================================================

export function createHistorySlice(
  set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void,
  get: () => BrowserState,
): HistorySlice {
  // Reopen or close the datasets that the steps crossed closed (async: files
  // are opened by the server). Jobs run one after another, in the order the
  // pointer moved, so Undo then Redo before the reopen finishes still ends
  // with the dataset closed; history stays paused until the last one is done.
  let reconcileQueue: Promise<void> = Promise.resolve();
  let reconcileInFlight = 0;
  const reconcileDatasets = (from: number, to: number) => {
    const preview = datasetChangesBetween(get()._historyStack, from, to);
    if (preview.reopen.length === 0 && preview.close.length === 0) return;
    reconcileInFlight += 1;
    // Say so at once ("Reopening …"); the work itself waits on the server.
    set((s) => ({
      reopeningDatasets: [...(s.reopeningDatasets ?? []), ...preview.reopen.map(d => d.label)],
      _historyPaused: true,
    }) as Partial<BrowserState>);
    reconcileQueue = reconcileQueue
      .then(() => import('../utils/datasetUndo'))
      // Read the step again when the job starts: an earlier job may have
      // renamed the ids of datasets it reopened.
      .then(m => m.reconcileClosedDatasets(datasetChangesBetween(get()._historyStack, from, to)))
      .catch(() => undefined)
      .finally(() => {
        reconcileInFlight -= 1;
        if (reconcileInFlight > 0) return;
        // The datasets now match the current step: bring back its panels and
        // layout too (with any reopened dataset's new id), then resume history.
        try { get().reapplyCurrentSnapshot(); } finally {
          set({ reopeningDatasets: [], _historyPaused: false, _lastRestoreTime: Date.now() } as Partial<BrowserState>);
        }
      });
  };

  const restoreSnapshotAt = (index: number, restoreViewport = false) => {
    const state = get();
    if (index < 0 || index >= state._historyStack.length) return;

    const snapshot = state._historyStack[index];
    if (!snapshot) return;
    const from = state._historyPointer;

    const restored = deserializeState(snapshot.state, state, { restoreViewport });
    set({
      ...restored,
      _historyPointer: index,
      _lastRestoreTime: Date.now(),
      refreshGeneration: state.refreshGeneration + 1,
    } as Partial<BrowserState>);

    reconcileDatasets(from, index);
  };

  return {
    _historyStack: [],
    _historyPointer: -1,
    _maxHistorySize: 30,
    _historyPaused: false,
    _lastRestoreTime: 0,
    commandHistory: [],
    reopeningDatasets: [],

    remapHistoryDatasetIds: (reopened) => {
      if (!Object.keys(reopened).some(k => reopened[k] !== k)) return {};
      const idMap = collisionFreeIdMap(get()._historyStack, reopened);
      set((s) => {
        return {
        _historyStack: s._historyStack.map(snap => ({
          ...snap,
          state: remapDatasetIds(snap.state, idMap),
          ...(snap.closedDatasets ? { closedDatasets: remapDatasetIds(snap.closedDatasets, idMap) } : {}),
        })),
        } as Partial<BrowserState>;
      });
      return idMap;
    },

    reapplyCurrentSnapshot: () => {
      const state = get();
      const snapshot = state._historyStack[state._historyPointer];
      if (!snapshot) return;
      const restored = deserializeState(snapshot.state, state, { restoreViewport: true });
      set({ ...restored, _lastRestoreTime: Date.now(), refreshGeneration: state.refreshGeneration + 1 } as Partial<BrowserState>);
    },

    foldIntoCurrentSnapshot: (snapshotState) => {
      if (get()._historyPaused) return;
      set((s) => {
        const current = s._historyStack[s._historyPointer];
        if (!current) return {};
        const stack = s._historyStack.slice();
        stack[s._historyPointer] = { ...current, state: snapshotState };
        return { _historyStack: stack };
      });
    },

    pushSnapshot: (label: string, options) => {
      const state = get();
      const kind = options?.kind ?? inferSnapshotKind(label);
      const serialized = serializeState(state);
      if (echoesRestore(state, serialized, kind, options?.explicit)) return;

      const coalesceKey = coalesceKeyFor(kind, options?.coalesceKey);
      const snapshot: Snapshot = {
        label,
        timestamp: Date.now(),
        state: serialized,
        kind,
        coalesceKey,
        id: ++snapshotSeq,
        ...(isBaselineKey(options?.coalesceKey) ? { baseline: true } : {}),
        ...(options?.closedDatasets?.length ? { closedDatasets: options.closedDatasets } : {}),
      };

      set((s) => {
        // Truncate any forward history (we branched)
        const stack = s._historyStack.slice(0, s._historyPointer + 1);
        const last = stack[stack.length - 1];
        const coalesceMs = options?.coalesceMs ?? 4000;
        if (
          coalesceKey &&
          last?.coalesceKey === coalesceKey &&
          snapshot.timestamp - last.timestamp <= coalesceMs &&
          // Never into a step Undo/Redo just went back to: that step stays.
          last.timestamp >= s._lastRestoreTime
        ) {
          stack[stack.length - 1] = snapshot;
        } else {
          stack.push(snapshot);
        }

        // Enforce max size — drop oldest
        trimHistory(stack, s._maxHistorySize);

        return {
          _historyStack: stack,
          _historyPointer: stack.length - 1,
        };
      });
    },

    pushSerializedSnapshot: (label: string, snapshotState, options) => {
      const state = get();
      const kind = options?.kind ?? inferSnapshotKind(label);
      if (echoesRestore(state, snapshotState, kind)) return;

      const coalesceKey = coalesceKeyFor(kind, options?.coalesceKey);
      const snapshot: Snapshot = {
        label,
        timestamp: Date.now(),
        state: snapshotState,
        kind,
        coalesceKey,
        id: ++snapshotSeq,
        ...(isBaselineKey(options?.coalesceKey) ? { baseline: true } : {}),
      };

      set((s) => {
        const stack = s._historyStack.slice(0, s._historyPointer + 1);
        const last = stack[stack.length - 1];
        const coalesceMs = options?.coalesceMs ?? 4000;
        if (
          coalesceKey &&
          last?.coalesceKey === coalesceKey &&
          snapshot.timestamp - last.timestamp <= coalesceMs &&
          last.timestamp >= s._lastRestoreTime
        ) {
          stack[stack.length - 1] = snapshot;
        } else {
          stack.push(snapshot);
        }

        trimHistory(stack, s._maxHistorySize);

        return {
          _historyStack: stack,
          _historyPointer: stack.length - 1,
        };
      });
    },

    undo: () => {
      const state = get();
      if (state._historyPointer <= 0) return; // Nothing to undo

      const targetIdx = state._historyPointer - 1;
      const snapshot = state._historyStack[targetIdx];
      if (!snapshot) return;
      const from = state._historyPointer;

      // Pass current state so deserialize can validate datasets/panels. Bump
      // refreshGeneration so read/track fetch hooks repaint from restored
      // filters, cart state, viewport, and cluster state immediately.
      const restored = deserializeState(snapshot.state, state, { restoreViewport: true });
      set({
        ...restored,
        _historyPointer: targetIdx,
        _lastRestoreTime: Date.now(),
        refreshGeneration: state.refreshGeneration + 1,
      } as Partial<BrowserState>);

      reconcileDatasets(from, targetIdx);
    },

    redo: () => {
      const state = get();
      if (state._historyPointer >= state._historyStack.length - 1) return;

      const targetIdx = state._historyPointer + 1;
      const snapshot = state._historyStack[targetIdx];
      if (!snapshot) return;
      const from = state._historyPointer;

      const restored = deserializeState(snapshot.state, state, { restoreViewport: true });
      set({
        ...restored,
        _historyPointer: targetIdx,
        _lastRestoreTime: Date.now(),
        refreshGeneration: state.refreshGeneration + 1,
      } as Partial<BrowserState>);

      reconcileDatasets(from, targetIdx);
    },

    canUndo: () => {
      const state = get();
      return state._historyPointer > 0;
    },

    canRedo: () => {
      const state = get();
      return state._historyPointer < state._historyStack.length - 1;
    },

    getHistoryLabels: () => {
      const state = get();
      return state._historyStack.map((snap, i) => ({
        label: snap.label,
        timestamp: snap.timestamp,
        isCurrent: i === state._historyPointer,
        kind: snap.kind ?? inferSnapshotKind(snap.label),
      }));
    },

    restoreSnapshot: (index, options) => {
      restoreSnapshotAt(index, options?.restoreViewport ?? false);
    },

    jumpToSnapshot: (index: number) => {
      restoreSnapshotAt(index, false);
    },

    clearHistory: () => {
      set({
        _historyStack: [],
        _historyPointer: -1,
      });
    },

    addCommandHistoryEntry: (entry) => set(state => ({
      commandHistory: [entry, ...(state.commandHistory ?? [])].slice(0, 100),
    })),

    updateCommandHistoryEntry: (id, updates) => set(state => ({
      commandHistory: (state.commandHistory ?? []).map(entry =>
        entry.id === id ? { ...entry, ...updates } : entry
      ),
    })),

    clearCommandHistory: () => set({ commandHistory: [] }),
  };
}
