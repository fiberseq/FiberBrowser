import { normalizeSvConflictOptions } from '../utils/svConflicts';
import { validateMatchedState } from '../utils/matchedRegions';
import { normalizeFeatureRefs } from '../stores/featureStore';
import { useSplitPanelStore } from '../stores/splitPanelStore';
import { setSplitSessionFallback, splitSessionReads } from '../utils/splitPanels';
import { normalizePinnedMotifs } from '../utils/pinnedMotifs';
import { clampMotifP, normalizeCustomMotifs, normalizeScoreMode } from '../utils/motifSettings';
import { storeExtensions } from '../stores/storeExtensions';
import { missingPacksNote, missingSessionPacks, usesPackParts, withoutMissingPackState } from './sessionPacks';
import { applyExcludedReads, useReadActionsStore } from '../stores/readActionsStore';
import { useBrowserStore } from '../stores/browserStore';
import { restoredMergeSettings, serializeState } from '../stores/historySlice';
import { normalizeMergeLog } from '../stores/clusterMergeLog';
import type { SerializedDataset, Snapshot } from '../stores/historySlice';
import { deserializeSets } from '../stores/hydration';
import { migrateSitePanels, withSiteLockSuppressed } from '../stores/siteLock';
import { migratePanelTracks } from '../stores/utils';
import { canonicalPanelType, migratePanelAliases } from '../plugins/registry';
import type { PanelConfig } from '../types';
import { coerceSidebarSection, migrateColormap, normalizeAnalysisFilterRules, normalizeAnalysisSortRules, normalizeClusterFeatureRules, normalizeFootprintGroups, normalizeTranscriptionStateFilters } from '../stores/utils';
import { applyCoaccSettings } from '../stores/coaccStore';
import { applyDafcSettings, serializeDafcSettings } from '../stores/dafcPersistence';
import { useDafcStore } from '../stores/dafcStore';
import { loadDafc } from './dafc';
import { projectionForSave, restoreSavedProjection } from '../utils/projectionExport';
import { buildSessionManifest } from '../utils/sessionManifest';
import { normalizeAnnotationLayer, normalizeLayerToggleMap } from '../utils/layerAliases';
import { fetchApiResponse, fetchJson } from './sharedFetch';
import { getTracks, type TrackListEntry } from './tracks';
import { emitTutorialEvent } from '../utils/tutorialEvents';
import { useRegionCatalogStore } from '../stores/regionCatalogStore';
import { normalizeHighlights } from '../stores/highlightSlice';
import { normalizeSvCarrierEvidence, normalizeClusterGroupLabels, normalizeSvSplits } from '../stores/svSlice';
import { clampMinSvLen, SV_MIN_LEN_DEFAULT, clampMinSvSupport, SV_MIN_SUPPORT_DEFAULT } from '../components/tracks/read-track/svDrawing';
import { DEFAULT_CLASS_REGION_MODE, isClassRegionMode } from '../utils/classRegion';
import { CLASS_REGION_RESET_EVENT } from '../utils/analysisCommands';
import { normalizeSignalFilters } from '../utils/signalFilters';
import { restoreDifferencesSession, restoreHistoricalMembership, legacySplitDefinitions } from '../features/differences/session';

export { deserializeSets } from '../stores/hydration';

const API_BASE = '/api';

export const SESSION_PRE_VIEWPORT_KEYS = [
  'viewMode', 'sortMode', 'sortSelection', 'filterMode', 'spanningOnly', 'downsampleCount', 'readDisplayMode', 'allReadsDisplayCap', 'backgroundReadCap', 'clusterPreparationCount', 'clusterPreparationSamples', 'analysisSampleCount', 'analysisSampleSeed', 'classRegionMode',
  'clusterK', 'clusterResolution', 'clusterMethod', 'clusterPeakMode', 'clusterFeatureRules', 'analysisSortRules', 'analysisFilterRules', 'subnucleosomalThreshold', 'accessibilityThreshold',
  'mergeMinFraction', 'mergeMaxSimilarity', 'mergeStrategy', 'mergeThresholds',
  'enabledModTypes', 'enabledMetaProfiles', 'cachedLayerTypes', 'legacyLayerInference', 'legacyNucMinSize', 'clickTargetLayer', 'footprintAnalysisLayer',
  'fillSmallGaps', 'fillGapSize', 'hideTerminalGaps', 'terminalGapThreshold', 'hideShortEndFootprints', 'minFpQuality', 'minFootprints', 'minFootprintsAuto', 'showDuplicateReads', 'signalFilters',
  'enabledCigarTypes', 'svDisplayEnabled', 'svMinLen', 'svMinSupport', 'svConflictOptions', 'isReversed', 'darkMode', 'peakSettings', 'activeColormap', 'fillReadHeight', 'showHiddenTrackStrip',
  'readSeparatorMode', 'readSeparatorMinHeight', 'readSeparatorWidth',
  'showReadTooltip', 'showCoverageHistogram', 'maxRegionForReads', 'motifThreshold', 'readRowHeight',
  'readScrollOffsets', 'showGenomeOverview', 'publicMode',
  'panels', 'navigationMode', 'editMode', 'fullViewPanelId', 'sessionName', 'uiScale', 'collapsedRows', 'analysisStripCollapsed', 'cooccClusterSelections',
  'navigatorRegions', 'highlights',
  'hiddenStripPanels',
  'captureRegions', 'capturePadding',
  'footprintCrossHighlight',
  'savedClusters',
  'catalog', 'compositeTracks', 'savedTracks',
  'peakRules',
  'commandHistory',
] as const;

export const SESSION_POST_VIEWPORT_KEYS = [
  'clusterAssignments', 'clusterOrder', 'clusterPatterns', 'clusterCentroids',
  'clusterPeakWidths', 'clusterPeakRegions', 'clusterWindowPeaks', 'clusterMatchedRun',
  'clusterTreeNodes', 'clusterTreeRootIds', 'activeClusterTreeNodeId',
  'dynamicClustering', 'dynamicOverlapMode', 'readSortOrder', 'readStateDetails',
  'peaksByRule', 'selectedPeaks', 'peakModes', 'peaksLocked',
  'clusterFocus', 'selectedClusters', 'filteredReadIds', 'readFilterSources', 'selectedReadIds', 'selectedDatasets',
  // Navigating to another chromosome clears these too.
  'selectedGenes', 'transcriptionStateFilters', 'selectedFootprints', 'footprintGroups',
  'showRelativeCoords', 'relativeTSS', 'relativeGene',
  // The Projection tab's latest map (export columns), with the clustering it was drawn for.
  'readProjection',
  // The merges since the last clustering (Unmerge / Merge again).
  'clusterMergeLog',
  // SV allele splits (the groups' definition) and their group names.
  'svSplits', 'clusterGroupLabels', 'svCarrierEvidence', 'differencesSession',
  // Selected features (Cluster / Sort / Filter on features).
  'selectedFeatures',
] as const;

/** Analysis state that belongs to a session: reset on import before the session's own is applied. */
const SESSION_OWNED_ANALYSIS_KEYS = [
  'clusterAssignments', 'clusterOrder', 'clusterPatterns', 'clusterCentroids',
  'clusterPeakWidths', 'clusterPeakRegions', 'clusterWindowPeaks', 'clusterMatchedRun',
  'clusterTreeNodes', 'clusterTreeRootIds', 'activeClusterTreeNodeId',
  'dynamicClustering', 'readSortOrder', 'readStateDetails',
  'clusterFocus', 'selectedClusters', 'filteredReadIds', 'readFilterSources', 'selectedReadIds',
  'readProjection', 'clusterMergeLog', 'svSplits', 'clusterGroupLabels', 'svCarrierEvidence', 'differencesSession', 'selectedFeatures',
  'correspondenceScans',
] as const;

/**
 * Collect all saveable frontend UI state from the Zustand store.
 * Returns the full SerializedState so session export captures everything
 * (clustering, filters, selections, footprint groups, etc.).
 */
export function collectFrontendState(): Record<string, unknown> {
  const s = useBrowserStore.getState();
  const frontendState = serializeState(s) as unknown as Record<string, unknown>;
  frontendState.dafcSettings = serializeDafcSettings();
  frontendState.annotationSettings = {
    annotationFiles: s.annotationFiles,
    enabledAnnotationTypes: s.enabledAnnotationTypes,
    annotationThresholds: s.annotationThresholds,
    annotationColors: s.annotationColors,
    annotationOpacityMin: s.annotationOpacityMin,
    annotationOpacityMax: s.annotationOpacityMax,
  };
  frontendState.primerState = {
    ...s.primer,
    designing: false,
    error: null,
  };
  frontendState.supplementalUiState = {
    bookmarks: s.bookmarks,
    selectedPanelIds: [...s.selectedPanelIds],
    dismissedPanelTypes: [...s.dismissedPanelTypes],
    activeSection: s.activeSection,
    // Older builds read the accordion's open sections.
    openSections: [s.activeSection],
  };
  // The Regions panel's catalogs (not in undo snapshots: stores/regionCatalogStore.ts).
  frontendState.regionCatalogs = useRegionCatalogStore.getState().sessionPayload();
  // Split panels carry their membership rule (panels[].readSubset); their read names too, used only when a rule's run
  // is gone when the session reopens (utils/splitPanels.ts).
  frontendState.splitPanelReads = splitSessionReads();
  frontendState.sessionManifest = buildSessionManifest(s);
  // Which plugin packs wrote parts of this session (serializeState's `packs`: a build without one leaves them out,
  // and says so).
  // The latest Clusters > Projection map (per-read coordinates and the
  // parameters that rebuild it), kept with the clustering it was drawn for.
  // (Only while it is still the map of these inputs: the import signs it again.)
  const projection = projectionForSave(s);
  if (projection) frontendState.readProjection = projection;
  return frontendState;
}

/**
 * Export the current session: POST frontend + viewport state to backend,
 * which merges with server-side state and returns full session JSON.
 * Returns a Blob for file download.
 */
export async function exportSession(): Promise<Blob> {
  const s = useBrowserStore.getState();

  // Include labeled history timeline for reproducibility
  const historyLabels = s.getHistoryLabels().map(h => ({
    label: h.label,
    timestamp: h.timestamp,
  }));

  // Include full history snapshots for reproducibility
  const historyStack: Snapshot[] = s._historyStack;

  const frontendState = collectFrontendState();
  // Embed full history in frontend_state so it persists through backend passthrough
  if (historyStack.length > 0) {
    frontendState.historySnapshots = historyStack;
    frontendState.historyPointer = s._historyPointer;
  }

  const body = {
    chrom: s.chrom,
    start: s.start,
    end: s.end,
    frontend_state: frontendState,
    history: historyLabels.length > 0 ? historyLabels : undefined,
  };

  const response = await fetchApiResponse(`${API_BASE}/session/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Export failed: ${response.status}`);
  }

  return response.blob();
}

/** Export and immediately download the current session using a stable,
 * human-readable filename. Shared by the top-bar shortcut and the detailed
 * session controls so both entry points produce identical files. */
export async function downloadSession(sessionName?: string | null): Promise<string> {
  const blob = await exportSession();
  // YYYYMMDD_HHMMSS (UTC); the old slice kept the '.' before milliseconds.
  const iso = new Date().toISOString();
  const timestamp = `${iso.slice(0, 10).replace(/-/g, '')}_${iso.slice(11, 19).replace(/:/g, '')}`;
  const slug = sessionName
    ? sessionName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '')
    : '';
  const filename = slug
    ? `${slug}_${timestamp}.json`
    : `fiberhmm_session_${timestamp}.json`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  emitTutorialEvent('session_saved');
  return filename;
}

export type SessionFileStatus = 'ok' | 'missing' | 'changed';

export interface SessionFileEntry {
  kind: string;
  label: string;
  path: string;
  resolved_path: string;
  status: SessionFileStatus;
  relinked: boolean;
}

export interface SessionFileCheck {
  files: SessionFileEntry[];
  /** Files on a cluster (ssh:// references) and whether their host is connected. */
  remote?: import('./remote').RemoteRefsStatus;
  /** Saved path -> path on this computer. Pass back to importSession. */
  mapping: Record<string, string>;
  missing: number;
  changed: number;
}

/**
 * Check which of a session's local input files exist on this computer.
 * `anchor` (one located file) and `searchRoot` (a folder to search) extend
 * the returned mapping to the other missing files.
 */
export async function checkSessionFiles(
  sessionJson: Record<string, unknown>,
  options: {
    mapping?: Record<string, string>;
    anchor?: { old: string; new: string };
    searchRoot?: string;
  } = {},
): Promise<SessionFileCheck> {
  return fetchJson(`${API_BASE}/session/check_files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: sessionJson,
      mapping: options.mapping ?? null,
      anchor: options.anchor ?? null,
      search_root: options.searchRoot ?? null,
    }),
  });
}

/**
 * Import a session from parsed JSON, then apply the returned state
 * to the frontend store without a page reload.
 */
/** Read a session JSON that is on the server's disk (Load File, drag and drop). */
export async function readSessionFile(path: string): Promise<{ success: boolean; session?: Record<string, unknown>; error?: string }> {
  const response = await fetchApiResponse(`${API_BASE}/session/read?path=${encodeURIComponent(path)}`, { method: 'POST' });
  return response.json();
}

export async function importSession(
  sessionJson: Record<string, unknown>,
  pathMapping?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetchApiResponse(`${API_BASE}/session/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pathMapping && Object.keys(pathMapping).length > 0
      ? { session: sessionJson, path_mapping: pathMapping }
      : { session: sessionJson }),
  });

  if (!response.ok) {
    throw new Error(`Import failed: ${response.status}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'Import failed');
  }

  // Linked-session IDs and their server registry are process-local resources.
  // Never carry a stale ID across a state import; the user can reconnect to a
  // currently live linked session after the portable browser state is loaded.
  useDafcStore.getState().clearLinkedState();
  useDafcStore.setState({
    linkedSessions: [],
    currentLinkedSessionId: null,
    linkedReadCount: 0,
    linkedVersion: 0,
  });

  const contactMap = result.contact_map as { cool_file?: string; bigbed_file?: string | null } | undefined;
  if (contactMap?.cool_file) {
    try {
      const loaded = await loadDafc(contactMap.cool_file, contactMap.bigbed_file ?? undefined);
      if (!loaded.success) throw new Error(loaded.error || 'Failed to reload contact map');
      useDafcStore.setState(s => ({
        dafcLoaded: true,
        dafcLoadGeneration: s.dafcLoadGeneration + 1,
        dafcResolutions: loaded.resolutions,
        dafcResolution: loaded.current_resolution,
      }));
    } catch (error) {
      const results = (result.results ?? {}) as Record<string, unknown>;
      results.contact_map_error = error instanceof Error ? error.message : String(error);
      result.results = results;
      useDafcStore.setState({ dafcLoaded: false, dafcResolutions: [] });
    }
  } else {
    useDafcStore.setState({ dafcLoaded: false, dafcResolutions: [] });
  }

  // Plugin packs' transient state (a run shown, slow requests and their notices) belongs to the previous session.
  for (const ext of storeExtensions()) ext.onSessionImport?.();
  // Split panels resolve their reads again from their rules (the session's runs), else from the names it kept.
  useSplitPanelStore.setState(s => ({ reads: {}, pending: null, generation: s.generation + 1 }));
  setSplitSessionFallback((result.frontend as Record<string, unknown> | undefined)?.splitPanelReads);
  applyImportedState(result);
  // Parts written by plugin packs this build doesn't have: left out, and said in one line (with the server's view).
  const frontend = result.frontend as Record<string, unknown> | undefined;
  const missing = missingSessionPacks(frontend).filter(p => usesPackParts(frontend, p)).map(p => p.label);
  const serverMissing = ((result.results ?? {}) as { missing_packs?: unknown }).missing_packs;
  const note = missingPacksNote([...missing, ...(Array.isArray(serverMissing) ? serverMissing.map(String) : [])]);
  if (note) result.pack_note = note;
  // The imported session is a step at once (before anything is awaited): the
  // view-moved effect would otherwise find an empty history and record the
  // previous session's view as "Before navigation". Its echo of the move
  // isn't a step either.
  useBrowserStore.getState().pushSnapshot('Import session');
  useBrowserStore.setState({ _lastRestoreTime: Date.now() } as any);
  // The imported tracks carry their own name filters on the server; mirror
  // them (the batch fetch sends these and they override the server's).
  try {
    const { tracks } = await getTracks();
    useBrowserStore.setState({ trackFilters: trackFiltersFromList(tracks) });
  } catch { /* none mirrored: the server applies each track's saved filter */ }

  return result;
}

/**
 * Apply server import result to the frontend Zustand store.
 * Restores datasets, overlays, reference state, frontend settings, and viewport.
 */
/** Each track's saved name filter, keyed by track index (the store's trackFilters). */
export function trackFiltersFromList(tracks: TrackListEntry[]): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const track of tracks) {
    if (track.filter_names && track.filter_names.length > 0) out[track.index] = [...track.filter_names];
  }
  return out;
}

export function applyImportedState(result: Record<string, unknown>): void {
  const store = useBrowserStore;
  // Highlights, pins and exclusions belong to the session being left.
  useReadActionsStore.getState().reset();

  // Collect all state updates into a single batch to minimize re-renders
  const batch: Record<string, unknown> = {};

  // Name filters are per track index: the previous session's would land on
  // whichever imported track now has that index.
  batch.trackFilters = {};
  // The track cart belongs to the session: one saved before the cart (no
  // catalog/composites) shows its tracks through its panels' legacy track
  // rows, so the previous session's cart must not be re-registered on top.
  batch.catalog = [];
  batch.compositeTracks = [];
  // Choices that belong to a session: one saved before them starts clean
  // (the imported session may reuse loci).
  batch.cooccClusterSelections = [];
  // Highlights belong to the session: one saved before them has none (not the previous session's).
  batch.highlights = [];

  // 1. Set datasets from server response
  if (Array.isArray(result.datasets)) {
    batch.datasets = result.datasets;
  }

  // 2. Set modification overlays
  if (Array.isArray(result.overlays)) {
    batch.modificationOverlays = result.overlays;
  }

  // 3. Set reference genome state
  batch.hasFasta = !!result.has_fasta;
  batch.fastaPath = (result.fasta_path as string) || null;
  batch.currentGenome = (result.current_genome as string) || null;

  // 4. Apply frontend settings (if present in session)
  const frontend = result.frontend as Record<string, unknown> | undefined;

  // Keys that are safe to set before viewport navigation (UI settings, panels, etc.)
  // Cluster/analysis state must be applied AFTER setViewport to avoid being cleared.
  batch.signalFilters = normalizeSignalFilters(frontend?.signalFilters);
  batch.signalCounts = {};
  if (frontend && typeof frontend === 'object') {
    for (const key of SESSION_PRE_VIEWPORT_KEYS) {
      if (key in frontend) {
        batch[key] = frontend[key];
      }
    }
    batch.signalFilters = normalizeSignalFilters(batch.signalFilters);
    if ('highlights' in batch) batch.highlights = normalizeHighlights(batch.highlights);
    // Motif scoring: the session's; a session from before the p / % toggle restores in relative mode (its threshold).
    if ('motifScoreMode' in frontend) batch.motifScoreMode = normalizeScoreMode(frontend.motifScoreMode);
    else if ('motifThreshold' in frontend) batch.motifScoreMode = 'relative';
    if ('motifPValue' in frontend) batch.motifPValue = clampMotifP(frontend.motifPValue);
    // Plugin packs' settings (stores/storeExtensions.ts).
    for (const ext of storeExtensions()) Object.assign(batch, ext.importSettings?.(frontend) ?? {});
    if ('customMotifs' in frontend) batch.customMotifs = normalizeCustomMotifs(frontend.customMotifs);
    // Find classes' region choice: the session's (older sessions: the default), never the open session's.
    batch.classRegionMode = isClassRegionMode(batch.classRegionMode) ? batch.classRegionMode : DEFAULT_CLASS_REGION_MODE;
    // An open Find classes card drops a region set by hand in the session being replaced.
    try { window.dispatchEvent(new CustomEvent(CLASS_REGION_RESET_EVENT)); } catch { /* no window (tests) */ }
    if ('activeColormap' in batch) {
      batch.activeColormap = migrateColormap(batch.activeColormap as any);
    }
    // A saved Min footprints is the user's unless the session says it was the untouched default.
    if ('minFootprints' in batch && !('minFootprintsAuto' in batch)) batch.minFootprintsAuto = false;
    // Sessions from before the setting existed: its default (on), not the open session's.
    if (!('hideShortEndFootprints' in batch)) batch.hideShortEndFootprints = true;
    // SV display (fb-n9-sv): a session saved before it gets its defaults, not the open session's.
    if (!('svDisplayEnabled' in batch)) batch.svDisplayEnabled = true;
    batch.svMinLen = clampMinSvLen(batch.svMinLen ?? SV_MIN_LEN_DEFAULT);
    batch.svConflictOptions = normalizeSvConflictOptions(batch.svConflictOptions);
    batch.svMinSupport = clampMinSvSupport(batch.svMinSupport ?? SV_MIN_SUPPORT_DEFAULT);
    if ('clusterFeatureRules' in batch) {
      batch.clusterFeatureRules = normalizeClusterFeatureRules(batch.clusterFeatureRules);
    }
    for (const key of ['mergeMinFraction', 'mergeMaxSimilarity', 'mergeStrategy', 'mergeThresholds'] as const) delete batch[key];
    Object.assign(batch, restoredMergeSettings(frontend));
    if ('analysisSortRules' in batch) {
      batch.analysisSortRules = normalizeAnalysisSortRules(batch.analysisSortRules);
    }
    if ('analysisFilterRules' in batch) {
      batch.analysisFilterRules = normalizeAnalysisFilterRules(batch.analysisFilterRules);
    }
    if ('enabledModTypes' in batch) {
      batch.enabledModTypes = normalizeLayerToggleMap(batch.enabledModTypes as any) ?? batch.enabledModTypes;
    }
    if ('enabledMetaProfiles' in batch) {
      batch.enabledMetaProfiles = normalizeLayerToggleMap(batch.enabledMetaProfiles as any) ?? batch.enabledMetaProfiles;
    }
    if ('cachedLayerTypes' in batch) {
      batch.cachedLayerTypes = normalizeLayerToggleMap(batch.cachedLayerTypes as any) ?? batch.cachedLayerTypes;
    }
    if ('clickTargetLayer' in batch) {
      batch.clickTargetLayer = normalizeAnnotationLayer(batch.clickTargetLayer);
    }
    if ('footprintAnalysisLayer' in batch) {
      batch.footprintAnalysisLayer = normalizeAnnotationLayer(batch.footprintAnalysisLayer);
    }
    if ('coaccSettings' in frontend) {
      applyCoaccSettings(frontend.coaccSettings);
    }
    if ('dafcSettings' in frontend) {
      const dafcState = useDafcStore.getState();
      applyDafcSettings(frontend.dafcSettings, {
        availableResolutions: dafcState.dafcLoaded ? dafcState.dafcResolutions : undefined,
      });
    }
    const annotationSettings = frontend.annotationSettings as Record<string, unknown> | undefined;
    if (annotationSettings && typeof annotationSettings === 'object') {
      // Settings are portable, but the backend response is authoritative for
      // which source files actually reopened on this machine.
      const { annotationFiles: savedAnnotationFiles, ...portableAnnotationSettings } = annotationSettings;
      Object.assign(batch, portableAnnotationSettings);
      const restoredAnnotationFiles = Array.isArray(result.annotations)
        ? result.annotations
        : Array.isArray(savedAnnotationFiles)
          ? savedAnnotationFiles
          : [];
      batch.annotationFiles = restoredAnnotationFiles.map((raw: any) => ({
        id: String(raw.id ?? ''),
        path: String(raw.path ?? ''),
        label: String(raw.label ?? raw.id ?? ''),
        active: Boolean(raw.active),
        datasetIds: Array.isArray(raw.datasetIds)
          ? raw.datasetIds
          : Array.isArray(raw.dataset_ids)
            ? raw.dataset_ids
            : [],
        annotationTypes: Array.isArray(raw.annotationTypes)
          ? raw.annotationTypes
          : Array.isArray(raw.annotation_types)
            ? raw.annotation_types
            : [],
      }));
      batch.annotationOverlays = {};
    }

    // Saved regions join the user's (stores/regionCatalogStore.ts); old sessions' bookmarks
    // and saved views become regions once the panels are restored (utils/regionMigration.ts).
    if (frontend.regionCatalogs) useRegionCatalogStore.getState().restoreSession(frontend.regionCatalogs);

    const primerState = frontend.primerState as Record<string, unknown> | undefined;
    if (primerState && typeof primerState === 'object') {
      batch.primer = {
        ...store.getState().primer,
        ...primerState,
        designing: false,
        error: null,
      };
    }

    const supplementalUiState = frontend.supplementalUiState as Record<string, unknown> | undefined;
    if (supplementalUiState && typeof supplementalUiState === 'object') {
      if (Array.isArray(supplementalUiState.bookmarks)) batch.bookmarks = supplementalUiState.bookmarks;
      if (Array.isArray(supplementalUiState.selectedPanelIds)) batch.selectedPanelIds = new Set(supplementalUiState.selectedPanelIds);
      if (Array.isArray(supplementalUiState.dismissedPanelTypes)) batch.dismissedPanelTypes = new Set(supplementalUiState.dismissedPanelTypes.map((t: string) => canonicalPanelType(t)));
      // The settings page shown (older sessions: the accordion's open sections, the first one).
      const activeSection = coerceSidebarSection(supplementalUiState.activeSection) ?? coerceSidebarSection(supplementalUiState.openSections);
      if (activeSection) batch.activeSection = activeSection;
    }

    // Primer config (BLAST DB, saved primers): on top of the full primer state
    // restored above (sessions have both); on its own for older sessions. A
    // saved null BLAST DB means none, not "keep the current one".
    if ('primerConfigBlastDb' in frontend || frontend.primerSavedPrimers) {
      const base = batch.primer ?? store.getState().primer;
      batch.primer = {
        ...base,
        ...('primerConfigBlastDb' in frontend ? { configBlastDb: (frontend.primerConfigBlastDb as string | null) ?? null } : {}),
        ...(Array.isArray(frontend.primerSavedPrimers) ? { savedPrimers: frontend.primerSavedPrimers as any[] } : {}),
      };
      if (frontend.primerConfigBlastDb) {
        try { localStorage.setItem('fiberhmm_blast_db', frontend.primerConfigBlastDb as string); } catch { /* storage unavailable */ }
      }
    }

    // 5. Sync darkMode to localStorage
    if ('darkMode' in frontend) {
      localStorage.setItem('fiberhmm_darkmode', String(frontend.darkMode));
    }
  }

  // Apply pre-viewport state (datasets, panels, UI settings).
  // collapsedRows lives in preViewportKeys but is a Set in the store —
  // run the same array→Set conversion before setState, otherwise components
  // like TrackContainer that call `collapsedRows.has(...)` crash on import.
  if (Object.keys(batch).length > 0) {
    deserializeSets(batch);
    if (Array.isArray(batch.panels)) {
      // A plugin pack this build doesn't have: its panels, rows and panel fields are left out, and the panels of the
      // datasets the server skipped for it; the full view and the selection keep only panels still there.
      const skipped = ((result.results ?? {}) as { datasets_skipped?: { id?: unknown }[] }).datasets_skipped;
      const fit = withoutMissingPackState(
        { panels: batch.panels, fullViewPanelId: (batch.fullViewPanelId as string | null | undefined) ?? null, packs: frontend?.packs },
        { skippedDatasetIds: Array.isArray(skipped) ? skipped.map(d => String(d?.id ?? '')).filter(Boolean) : [] },
      );
      if (fit.panels !== batch.panels) {
        const kept = new Set((fit.panels as PanelConfig[]).map(p => p.id));
        batch.panels = fit.panels;
        if ('fullViewPanelId' in batch) batch.fullViewPanelId = fit.fullViewPanelId;
        if (batch.selectedPanelIds instanceof Set) batch.selectedPanelIds = new Set([...batch.selectedPanelIds].filter(id => kept.has(id as string)));
      }
      batch.panels = migrateSitePanels(migratePanelAliases(batch.panels as PanelConfig[]));
      // Rows added since the save (SV, coverage); the retired SV collapse becomes a small SV row.
      batch.panels = migratePanelTracks(batch.panels as PanelConfig[], (frontend as { svTrackCollapsed?: unknown } | undefined)?.svTrackCollapsed === true);
      // Saved before "Each panel navigates" existed: linked (as it opened then).
      if (batch.navigationMode !== 'perPanel' && batch.navigationMode !== 'linked') {
        batch.navigationMode = (batch.panels as PanelConfig[]).some(p => p?.navOwn) ? 'perPanel' : 'linked';
      }
    }
    store.setState(batch as any);
  }
  // Imported clusters belong to the imported view: don't re-derive them there.
  const frontendState = (result.frontend ?? {}) as Record<string, unknown>;
  if (typeof frontendState.chrom === 'string' && frontendState.clusterAssignments) {
    store.setState({ restoredClusterViewport: {
      chrom: frontendState.chrom, start: Number(frontendState.start), end: Number(frontendState.end),
    } } as any);
  }

  // 6. Navigate to viewport (triggers data fetching — also clears cluster state)
  const viewport = result.viewport as { chrom?: string; start?: number; end?: number } | undefined;
  if (viewport && viewport.chrom != null && viewport.start != null && viewport.end != null) {
    // The restored panels already sit at their saved sites: moving the main
    // view there must not move locked ones along with it.
    withSiteLockSuppressed(() => store.getState().setViewport(viewport.chrom!, viewport.start!, viewport.end!));
  }

  // 7. Apply cluster/analysis state AFTER setViewport so it doesn't get wiped.
  // First drop the previous session's: navigating to an overlapping view keeps
  // clusters and filters, and a session without them (or without frontend state
  // at all) must not inherit them.
  {
    const initial = useBrowserStore.getInitialState() as unknown as Record<string, unknown>;
    const reset: Record<string, unknown> = {};
    for (const key of SESSION_OWNED_ANALYSIS_KEYS) reset[key] = initial[key];
    // Pinned motifs are a preference: a session's own list wins, one without keeps the local list.
    if (frontend && typeof frontend === 'object' && frontend.pinnedMotifs) reset.pinnedMotifs = normalizePinnedMotifs(frontend.pinnedMotifs);
    // Plugin packs' session state: the session's own, or their reset for a session without it.
    for (const ext of storeExtensions()) Object.assign(reset, ext.importSession?.(frontend && typeof frontend === 'object' ? frontend : undefined, store.getState()) ?? {});
    store.setState(reset as any);
  }
  if (frontend && typeof frontend === 'object') {
    const postBatch: Record<string, unknown> = {};
    for (const key of SESSION_POST_VIEWPORT_KEYS) {
      if (key in frontend) {
        postBatch[key] = frontend[key];
      }
    }
    if ('footprintGroups' in postBatch) {
      postBatch.footprintGroups = normalizeFootprintGroups(postBatch.footprintGroups);
    }
    if ('transcriptionStateFilters' in postBatch) {
      postBatch.transcriptionStateFilters = normalizeTranscriptionStateFilters(postBatch.transcriptionStateFilters);
    }
    if ('clusterMergeLog' in postBatch) postBatch.clusterMergeLog = normalizeMergeLog(postBatch.clusterMergeLog);
    postBatch.svCarrierEvidence = normalizeSvCarrierEvidence(postBatch.svCarrierEvidence);
    postBatch.svSplits = normalizeSvSplits(legacySplitDefinitions(frontend));
    const differences = restoreDifferencesSession(frontend);
    postBatch.differencesSession = differences;
    Object.assign(postBatch, restoreHistoricalMembership(postBatch, differences));
    if (postBatch.svSplits) {
      for (const [key, def] of Object.entries(postBatch.svSplits as Record<string, { frozenImport?: boolean }>)) {
        if (!frontend.differencesSession || differences.targets[key]?.frozen) def.frozenImport = true;
      }
    }
    if ('clusterGroupLabels' in postBatch) postBatch.clusterGroupLabels = normalizeClusterGroupLabels(postBatch.clusterGroupLabels);
    if ('selectedFeatures' in postBatch) postBatch.selectedFeatures = normalizeFeatureRefs(postBatch.selectedFeatures);
    // Navigation also reset the dismissed analysis panels restored above.
    if (batch.dismissedPanelTypes) postBatch.dismissedPanelTypes = batch.dismissedPanelTypes;

    // Deserialize Set-typed fields (arrays in JSON → Sets in store)
    deserializeSets(postBatch);
    if (postBatch.peaksByRule) {
      Object.assign(postBatch, validateMatchedState({ ...postBatch, peakRules: postBatch.peakRules ?? store.getState().peakRules } as any));
    }

    if (Object.keys(postBatch).length > 0) {
      store.setState(postBatch as any);
    }
    // Reads hidden with "Exclude selected" (kept in the read actions store).
    applyExcludedReads(frontend.excludedReadIds);
  }

  // 8. Backward compat: panels without contentType default to 'dataset'
  if (frontend && 'panels' in frontend && Array.isArray(frontend.panels)) {
    // The panels as restored above (with earlier migrations), not the raw file.
    const panels = store.getState().panels as any[];
    const needsMigration = panels.some((p: any) => !p.contentType);
    if (needsMigration) {
      store.setState({
        panels: panels.map((p: any) => ({
          ...p,
          contentType: p.contentType || 'dataset',
          datasetId: p.datasetId ?? null,
        })),
      } as any);
    }
  }

  // 8b. Migration: collapsed analysis panels → remove (strip redesign: no minimize for analysis panels)
  {
    const currentPanels = store.getState().panels;
    const migratedPanels = currentPanels.filter((p: any) => p.contentType === 'dataset' || !p.collapsed);
    if (migratedPanels.length !== currentPanels.length) {
      store.setState({ panels: migratedPanels } as any);
    }
  }

  // 8c. Migration: layoutPosition → layoutRow (old sessions used 'row'/'column' strings)
  {
    const currentPanels = store.getState().panels;
    const needsRowMigration = currentPanels.some((p: any) => p.layoutRow === undefined);
    if (needsRowMigration) {
      store.setState({
        panels: currentPanels.map((p: any) => ({
          ...p,
          layoutRow: p.layoutRow ?? (p.layoutPosition === 'column' ? 1 : 0),
        })),
      } as any);
    }
  }

  // 9. Backward compat: if no panels in session, auto-create from datasets
  if (!frontend || !('panels' in frontend) || !Array.isArray(frontend.panels) || frontend.panels.length === 0) {
    // The previous session's panels (and what points at them) don't carry
    // over: default panels for the imported datasets replace them.
    store.setState({
      panels: [],
      selectedDatasets: new Set<string>(),
      selectedPanelIds: new Set<string>(),
      fullViewPanelId: null,
      collapsedRows: new Set<number>(),
    } as any);
    store.getState().initPanelsFromDatasets();
  }

  // 10. The imported session's own history replaces the previous session's
  // (undo must never restore another session's state), empty if it has none:
  // also a session without frontend state at all (a backend-only or older file).
  {
    const historySnapshots = frontend && Array.isArray(frontend.historySnapshots)
      ? normalizeImportedHistorySnapshots(frontend.historySnapshots)
      : [];
    if (frontend && historySnapshots.length > 0) {
      const rawPointer = typeof frontend.historyPointer === 'number'
        ? frontend.historyPointer
        : historySnapshots.length - 1;
      const pointer = Math.max(0, Math.min(historySnapshots.length - 1, rawPointer));
      store.setState({
        _historyStack: historySnapshots,
        _historyPointer: pointer,
      } as any);
    } else {
      store.setState({ _historyStack: [], _historyPointer: -1 } as any);
    }
  }

  // 11. Migration: old sessions with customPeaks but no peakRules
  if (frontend && typeof frontend === 'object') {
    const hasPeakRules = 'peakRules' in frontend && Array.isArray(frontend.peakRules);
    const hasOldCustomPeaks = 'customPeaks' in frontend && Array.isArray(frontend.customPeaks) && (frontend.customPeaks as any[]).length > 0;
    if (!hasPeakRules && hasOldCustomPeaks) {
      // Migrate old customPeaks into peaksByRule for the default custom rule
      store.setState({
        peaksByRule: { 'default-custom': frontend.customPeaks as any },
      } as any);
    }
    // Migrate peakSettings thresholds to default accessibility rule
    if (!hasPeakRules && frontend.peakSettings) {
      const ps = frontend.peakSettings as any;
      const state = store.getState();
      const accessibilityRule = state.peakRules.find((r: any) => r.source === 'accessibility');
      if (accessibilityRule) {
        store.setState({
          peakRules: state.peakRules.map((r: any) =>
            r.id === accessibilityRule.id
              ? {
                  ...r,
                  smoothWidth: ps.smoothWidth ?? r.smoothWidth,
                  thresholds: [
                    ps.thresholdStrong ?? r.thresholds[0],
                    ps.thresholdMedium ?? r.thresholds[1],
                    ps.thresholdWeak ?? r.thresholds[2],
                    ps.thresholdRare ?? r.thresholds[3],
                  ],
                }
              : r
          ),
        } as any);
      }
    }
  }
  // Restored geometry is not the current viewport's geometry. Refresh even
  // when chromosome/coordinates did not change, and discard stale Fit scroll.
  store.setState(state => ({
    refreshGeneration: state.refreshGeneration + 1,
    ...(state.readDisplayMode !== 'all' ? { readScrollOffsets: {} } : {}),
  }));
  // The session's Projection map, signed with the inputs just restored (the bump above changed the refresh counter).
  {
    const restored = store.getState();
    if (restored.readProjection) {
      store.setState({ readProjection: restoreSavedProjection(restored.readProjection, {}, restored) } as any);
    }
  }
}

function normalizeImportedHistorySnapshots(value: unknown): Snapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((snapshot): snapshot is Record<string, unknown> => (
      !!snapshot &&
      typeof snapshot === 'object' &&
      !!(snapshot as Record<string, unknown>).state &&
      typeof (snapshot as Record<string, unknown>).state === 'object'
    ))
    .map((snapshot, index) => ({
      label: typeof snapshot.label === 'string' ? snapshot.label : `Imported snapshot ${index + 1}`,
      timestamp: typeof snapshot.timestamp === 'number' ? snapshot.timestamp : Date.now(),
      state: snapshot.state as Snapshot['state'],
      kind: snapshot.kind as Snapshot['kind'],
      coalesceKey: typeof snapshot.coalesceKey === 'string' ? snapshot.coalesceKey : undefined,
      // A step that closed datasets keeps where they came from, so Undo can reopen them.
      ...(normalizeClosedDatasets(snapshot.closedDatasets)),
    }));
}

function normalizeClosedDatasets(value: unknown): { closedDatasets?: SerializedDataset[] } {
  if (!Array.isArray(value)) return {};
  const closed = value.filter((d): d is SerializedDataset => (
    !!d && typeof d === 'object' &&
    typeof (d as SerializedDataset).id === 'string' &&
    typeof (d as SerializedDataset).label === 'string' &&
    Array.isArray((d as SerializedDataset).paths) &&
    (d as SerializedDataset).paths.length > 0 &&
    (d as SerializedDataset).paths.every(p => typeof p === 'string')
  ));
  return closed.length ? { closedDatasets: closed } : {};
}
