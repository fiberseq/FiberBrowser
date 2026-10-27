import { idSetHas, recordKey } from '../utils/recordKeys';
import { beginProgressiveAnalysis, cancelProgressiveAnalysis, displayedScope, needsDisplayPreview } from '../utils/progressiveAnalysis';
import { AnalysisProgressLine } from './controls/AnalysisProgressLine';
import { scanEquivalentRegions, scanUnsharedRegions } from '../utils/equivalentScanning';
import { peakScanScope } from '../utils/peakScanScope';
import { waitForViewIdle } from '../utils/viewIdle';
import { AUTO_SCAN_BUDGET_MS, armScanBudget, scanStoppedNote } from '../utils/scanBudget';
import { clusterBasisRunner } from '../utils/clusterRunExtensions';
import { hasOrdinaryPeakSelection, isScannedRule } from '../utils/matchedRegions';
import { linkChoseViewport } from '../utils/sessionLinks';
import { registerClusterRunner, registerScanRunner } from '../utils/clusterRunner';
import { invalidateFilterRequests, isCurrentFilterRequest, nextFilterRequest } from '../utils/filterRequests';
import { alignWindowPeaks, otherLocusWindows } from '../utils/locusPeaks';
import { captureRunViews, clusterRequestLocus, runViewsStillCurrent } from '../utils/panelRunScope';
import { serverScanSource } from '../utils/peakScanSources';
import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { useBrowserStore, getTargetDatasetIds, getStateKeyMap, isLinkedGroup } from '../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { CrashRecoveryBanner } from './controls/CrashRecoveryBanner';
import { GenomeMismatchBanner } from './controls/GenomeMismatchBanner';
import { PreviewSessionPrompt } from './controls/PreviewSessionPrompt';
import { DafRunHost } from './controls/daf-run/DafRunHost';
import { LibraryHost } from './controls/library/LibraryHost';
import { RegionsHost } from './controls/regions/RegionsHost';
import { useAutoSave } from '../hooks/useAutoSave';
import { useSettingsHistory } from '../hooks/useSettingsHistory';
import { useSessionLog } from '../hooks/useSessionLog';
import { loadAutoSave } from '../stores/historyStorage';
import { getTracks, getTrackData, type TrackListEntry } from '../api/tracks';
import { fetchApiResponse } from '../api/sharedFetch';
import { useDafcStore } from '../stores/dafcStore';
import { scanPeaks } from '../api/peaks';
import { clusterAllReads, assignToClusters } from '../api/clustering';
import { performanceSamplingNote } from '../utils/performanceProfile';
import { mergeClusterOrder } from '../utils/clusterOrder';
import { clusterReferenceScope, clusterRunLabel, restoredClusteringState, savedClusterStateForPanels } from '../stores/clusterSlice';
import { panelGenomeLabel, usePanelGenomeStore } from '../stores/panelGenomeStore';
import { getDatasets } from '../api/datasets';
import { getStatus } from '../api/status';
import { filterReadsByAnalysisRule, sortReads, autozoom } from '../api/readOperations';
import { getChromosomes } from '../api/reference';
import { detectSignalPeaks, getAnnotationProfile } from '../api/annotations';
import { syncPrimerConfigFromStorage } from '../utils/primerConfigSync';
import { SmartSearchInput } from './controls/SmartSearchInput';
import { ViewToggles, ZoomControls } from './controls/ZoomControls';
import { ClusterPanel } from './controls/ClusterPanel';
import { RunResultLines } from './controls/RunResultLines';
import { useChromeZoom } from './controls/ToolbarGroups';
import { NavBar } from './controls/NavBar';
import { Sidebar } from './controls/Sidebar';
import { TrackContainer } from './tracks/TrackContainer';
import { ExportPanel } from './ExportPanel';
import { ExportDataDialog } from './ExportDataDialog';
import { GenomeOverview } from './GenomeOverview';
import { ChromSelector } from './controls/ChromSelector';
import { HistoryQuickControls } from './controls/HistoryQuickControls';
import { BarChart, X } from './ui/Icons';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useAppCommand } from '../hooks/useAppCommand';
import { useUrlSync } from '../hooks/useUrlSync';
import { useUrlPanel } from '../hooks/useUrlPanel';
import { useJupyterPolling } from '../hooks/useJupyterPolling';
import { useDafcPolling } from '../hooks/useDafcPolling';
import { useDafcStatusBootstrap } from '../hooks/useDafcStatusBootstrap';
import { useBrowserDataFetch } from '../hooks/useBrowserDataFetch';
import { useDragAndDrop } from '../hooks/useDragAndDrop';
import { useAnnotationFetch } from '../hooks/useAnnotationFetch';
import { useSplitPanelStore } from '../stores/splitPanelStore';
import { beginRun, setRunResult } from '../stores/runResultStore';
import { formatShare } from '../utils/denominators';
import { foldedInShownGraph } from '../stores/graphMembership';
import { extendedPeakScan } from '../utils/peakScanExtensions';
import { clusterRunHeadline, clusterRunPlan, clusterWindows as sharedClusterWindows, panelTargetLabel, selectedClusterPeakRegions, type ClusterWindow } from '../utils/clusterTargets';
import { splitShowsAll } from '../utils/splitLocus';
import { resolveSplitPanels } from '../utils/splitPanels';
import { SplitPanelsDialogHost } from './controls/SplitPanelsDialog';
import { clusterSelectedFeatures, featurePeakRegions, featuresInView } from '../utils/featureClustering';
import { KeyboardShortcutsModal } from './controls/KeyboardShortcutsModal';
import { CommandPaletteHost } from './controls/CommandPalette';
import { ServerFileBrowserHost } from './controls/files/ServerFileBrowser';
import { FRONTEND_DIAGNOSTICS } from '../utils/diagnostics';
import { seedHistoryBaseline, serializeState, type SerializedState } from '../stores/historySlice';
import { CLUSTER_RULE_MODE_PREFIX, type AnalysisFilterRule, type AnalysisSortRule, type ClusterFeatureRuleTerm, type PeakMode, type TranscriptionStateRuleKind } from '../types';
import { analysisFilterLabel, analysisRuleTermProblem, filterRuleRequestFields, intersectWithCurrentFilter, normalizeAnalysisRuleScope, normalizeTranscriptionStateRuleKind, resolveClusterRuleRegions, sortRuleRequestFields, type FeatureHubRequest } from '../utils/analysisRules';
import { filterRegionGroups, groupStillShown } from '../utils/filterScopes';
import { logPerfTiming, nowMs } from '../utils/perfDebug';
import { clusterBranchDynamicScopeKey, isClusterBranchAtViewport } from '../utils/clusterBranches';
import { liftHapsForRound, resolveSortRequestScope, selectedPeakWindowsForSort, sortRounds, sortViewGroups, mergeScopedSortOrder, sortStateStillCurrent, sortMovesVisibleReads } from '../utils/sortScope';
import { clusterChartRunPeaks } from './controls/cluster-detail/clusterChartScope';
import { sameChrom } from '../utils/chromAliases';
import { formatCoordinates } from '../utils/coordinates';
import { isCurrentSortRequest, nextSortRequest } from '../utils/sortRequests';
import { installRenderFigureBridge } from '../utils/renderFigureBridge';
import { useQualityFilterSync } from '../hooks/useQualityFilterSync';
import { SessionRestoreHost } from './controls/sidebar/file/SessionRestoreHost';
import { ConnectClusterHost } from './controls/sidebar/file/ConnectClusterDialog';
import { isLabServerPage } from '../utils/labServer';
import { useLiveFigureState } from '../hooks/useLiveFigureState';
import { useRecentTracksSync } from '../hooks/useRecentTracksSync';
import { useTourTabAutostart } from '../hooks/useTourTabAutostart';
import { SandboxBanner } from './controls/SandboxBanner';
import { NavigationModeToggle, PER_PANEL_NAV_REASON } from './controls/NavigationModeToggle';
import { isMainViewPanel } from '../utils/panelNavigation';
import { usePanelGenomeSync } from '../hooks/usePanelGenomeSync';
import { BrowserHosts } from '../plugins/browserHosts';
import { panelTraits } from '../utils/panelExtensions';
import { isSandboxPage, isWorkspacePage } from '../utils/sandbox';
import { qualityGatesPayload } from '../utils/ruleMatching';
import { nucConditionsPayload, ruleTermPayload, type RuleTermPayload } from '../actions/ruleTermPayload';

const DEBUG = FRONTEND_DIAGNOSTICS;

// Reads that fall outside a subcluster (or overlap no clustering peak) go to the
// "Unassigned" dead bucket rather than vanishing from the assignment map.
const UNASSIGNED_CLUSTER_ID = -1;

function branchReadIdsForDatasets(
  branch: { parentId: string | null; assignments: Record<string, Record<string, number>>; readScope?: Record<string, string[]> } | null | undefined,
  datasetIds: string[],
  keyMap: Record<string, string[]>,
): Record<string, string[]> | undefined {
  if (!branch?.parentId) return undefined;
  const scoped: Record<string, string[]> = {};
  for (const dsId of datasetIds) {
    const ids = new Set<string>();
    for (const sk of keyMap[dsId] ?? [dsId]) {
      const scopedIds = branch.readScope?.[sk] ?? Object.keys(branch.assignments[sk] ?? {});
      for (const readId of scopedIds) {
        ids.add(readId);
      }
    }
    scoped[dsId] = [...ids];
  }
  return scoped;
}

function branchReadScopeForStateKeys(
  readIdsByDataset: Record<string, string[]>,
  keyMap: Record<string, string[]>,
): Record<string, string[]> {
  const scope: Record<string, string[]> = {};
  for (const [dsId, ids] of Object.entries(readIdsByDataset)) {
    for (const sk of keyMap[dsId] ?? [dsId]) {
      scope[sk] = [...ids];
    }
  }
  return scope;
}

export function Browser() {
  // The UI size, held down for the top bar and toolbar while it would leave the reads too little room (audit H5).
  const chromeZoom = useChromeZoom();
  const isRenderMode = typeof window !== 'undefined' && window.__FIBERBROWSER_RENDER_MODE;
  // Grouped Zustand selectors — reduces listener count from ~33 to 3
  // Group 1: Viewport + data (changes on navigation)
  const {
    chrom, start, end, datasets,
    loading, error, spanningOnly, downsampleCount, showGenomeOverview,
    peakRules, peaksByRule, peaksLocked, publicMode, setBrowserError,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end, datasets: s.datasets,
    loading: s.loading, error: s.error, spanningOnly: s.spanningOnly,
    downsampleCount: s.downsampleCount, showGenomeOverview: s.showGenomeOverview,
    peakRules: s.peakRules, peaksByRule: s.peaksByRule, peaksLocked: s.peaksLocked, publicMode: s.publicMode,
    setBrowserError: s.setError,
  })));
  const perPanelNavigation = useBrowserStore(s => s.navigationMode === 'perPanel');
  usePanelGenomeSync();

  // Group 2: Cluster + analysis state
  const {
    clusterAssignments, clusterPatterns, clusterCentroids, clusterPeakWidths, clusterPeakRegions, clusterFeatureRules, dynamicClustering, dynamicOverlapMode,
    selectedPeaks, clusterPeakMode, clusterK, clusterMethod, subnucleosomalThreshold, accessibilityThreshold,
    syncPeaksToBackend, activeReadIds, selectedGenes, peakModes,
    selectedDatasets, selectedFootprints, selectedReadIds,
    analysisSampleCount, analysisSampleSeed,
    activeClusterBranch,
  } = useBrowserStore(useShallow(s => ({
    clusterAssignments: s.clusterAssignments, clusterPatterns: s.clusterPatterns,
    clusterCentroids: s.clusterCentroids, clusterPeakWidths: s.clusterPeakWidths, dynamicOverlapMode: s.dynamicOverlapMode,
    clusterPeakRegions: s.clusterPeakRegions, clusterFeatureRules: s.clusterFeatureRules, dynamicClustering: s.dynamicClustering,
    selectedPeaks: s.selectedPeaks, clusterPeakMode: s.clusterPeakMode, clusterK: s.clusterK, clusterMethod: s.clusterMethod,
    subnucleosomalThreshold: s.subnucleosomalThreshold, accessibilityThreshold: s.accessibilityThreshold,
    syncPeaksToBackend: s.syncPeaksToBackend, activeReadIds: s.activeReadIds,
    selectedGenes: s.selectedGenes, peakModes: s.peakModes,
    selectedDatasets: s.selectedDatasets,
    selectedFootprints: s.selectedFootprints, selectedReadIds: s.selectedReadIds,
    analysisSampleCount: s.analysisSampleCount, analysisSampleSeed: s.analysisSampleSeed,
    activeClusterBranch: s.activeClusterTreeNodeId ? s.clusterTreeNodes[s.activeClusterTreeNodeId] : null,
  })));

  // Group 3: Layout + UI config
  const { viewMode, autozoomDistance, panels } = useBrowserStore(useShallow(s => ({
    viewMode: s.viewMode, autozoomDistance: s.autozoomDistance, panels: s.panels,
  })));
  const activeQualityFilters = useBrowserStore(s => s.activeColormap.qualityFilters);
  const legacyLayerInference = useBrowserStore(s => s.legacyLayerInference);
  const legacyNucMinSize = useBrowserStore(s => s.legacyNucMinSize);
  const hideShortEndFootprints = useBrowserStore(s => s.hideShortEndFootprints);

  // DAF-C state
  const dafcLoaded = useDafcStore(s => s.dafcLoaded);

  const [trackList, setTrackList] = useState<TrackListEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  // An automatic scan stopped by its time budget: the Scan control says so until a scan runs or the view moves.
  const [scanStopped, setScanStopped] = useState<string | null>(null);
  useEffect(() => { setScanStopped(null); }, [chrom, start, end]);
  const [clustering, setClustering] = useState(false);

  // Export panel state
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [showExportDataDialog, setShowExportDataDialog] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // --- Extracted hooks ---
  const { handleCopyLink, linkCopied, initialPositionSet, suppressViewportSnapshotKey } = useUrlSync();
  useUrlPanel();
  useJupyterPolling();
  useTourTabAutostart();
  useDafcPolling();
  useDafcStatusBootstrap(!isRenderMode);
  useBrowserDataFetch(trackList, setTrackList, window.innerWidth);
  useAnnotationFetch();
  // Split panels whose reads are not known yet (a reopened session, redo): resolved from their rule.
  const panelsForSplit = useBrowserStore(s => s.panels);
  useEffect(() => { if (panelsForSplit.some(p => p.readSubset)) void resolveSplitPanels(); }, [panelsForSplit]);
  const { dragOver, handleDragEnter, handleDragLeave, handleDragOver, handleDrop } = useDragAndDrop();
  useAutoSave();
  useSettingsHistory();
  useSessionLog();

  useLiveFigureState();
  useRecentTracksSync();
  useEffect(() => (isRenderMode ? installRenderFigureBridge({
    loadStartupData: () => getTracks().then(res => setTrackList(res.tracks)),
  }) : undefined), [isRenderMode]);

  // Render-mode settlement: in headless render mode, mark ready after the
  // viewport stabilizes + the canvases have had two paint cycles. The Node
  // worker layers its own canvas-count-stable check on top, so this is the
  // optimistic "the React tree has applied the injected state" signal.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.__FIBERBROWSER_RENDER_MODE) return;
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      window.__fiberbrowserMarkRenderReady?.({
        chrom, start, end,
        panelCount: panels.length,
        canvasCount: document.querySelectorAll('canvas').length,
      });
    };
    // Two RAF cycles + a small idle delay so layout + initial paint complete
    // before we flip the flag. The worker still polls canvas-count stability.
    const raf1 = window.requestAnimationFrame(() => {
      const raf2 = window.requestAnimationFrame(() => {
        window.setTimeout(finish, 50);
      });
      void raf2;
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf1);
    };
  }, [chrom, start, end, panels]);

  // Quality filters affect working-set construction and every downstream
  // analysis, so sync them even when the settings/editor panel is closed.
  const initialQualityFilterSync = useQualityFilterSync(activeQualityFilters, !isRenderMode);

  // Legacy layer inference affects broad/working-set cache construction and
  // therefore every analysis that consumes compact reads.
  useEffect(() => {
    if (isRenderMode) return;
    fetchApiResponse('/api/legacy_layer_inference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: legacyLayerInference, nuc_min_size: legacyNucMinSize }),
    }).catch(err => console.error('Failed to sync legacy layer inference settings:', err));
  }, [legacyLayerInference, legacyNucMinSize, isRenderMode]);

  // Read-end footprints under 90 bp are dropped when the server loads reads, so
  // the read track and every analysis see the same calls. Reads (and analysis
  // results) already loaded are fetched again once the server has the setting.
  useEffect(() => {
    if (isRenderMode) return;
    fetchApiResponse('/api/read_end_footprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hide_short: hideShortEndFootprints }),
    })
      .then(res => res.json())
      .then((body: { changed?: boolean; hide_short?: boolean }) => {
        const store = useBrowserStore.getState();
        // Reads are fetched again under the confirmed setting (it is in their URL);
        // analyses through the refresh generation.
        if (typeof body?.hide_short === 'boolean') store.setAppliedHideShortEndFootprints(body.hide_short);
        if (body?.changed) store.triggerRefresh();
      })
      .catch(err => console.error('Failed to sync the read-end footprint setting:', err));
  }, [hideShortEndFootprints, isRenderMode]);

  // Fetch available tracks, datasets, and config on mount
  useEffect(() => {
    if (isRenderMode) return;
    // Idempotent default metaprofile seed — runs once per session-restore.
    // No-op when the seeded composite already exists in the cart.
    useBrowserStore.getState().seedDefaultMetaprofile();
    // Auto-hydrate the catalog (only) from the last autosave so loaded
    // tracks persist across reloads. The cart is intentionally NOT
    // restored here — users get a fresh cart (with just the seeded default
    // metaprofile) and must use the crash-recovery banner's Restore button
    // to get their previous cart configuration back. Viewport/datasets
    // also stay behind the explicit Restore flow.
    loadAutoSave().then(async (entry) => {
      if (!entry) return;
      const saved = entry.state;
      const store = useBrowserStore.getState();
      // Saved track presets always rehydrate — they're a small library and
      // the user expects them to persist independently of the active cart.
      if (saved.savedTracks && saved.savedTracks.length > 0 && store.savedTracks.length === 0) {
        store.setSavedTracks(saved.savedTracks);
      }
      if (store.catalog.length > 0) return; // catalog already hydrated
      if (!saved.catalog || saved.catalog.length === 0) return;
      store.setCatalog(saved.catalog);
      // Backend track indices are process-local, so catalog sources stay
      // metadata-only until a visible cart source or enabled rule needs them.
      useBrowserStore.getState().triggerRefresh();
    }).catch(() => {});
    getTracks().then(res => setTrackList(res.tracks)).catch(() => {});
    const initialDatasets = getDatasets();
    const initialStatus = getStatus(!initialPositionSet.current && !linkChoseViewport()).then(res => {
      if (res.config?.prefetch_multiplier) {
        useBrowserStore.getState().setPrefetchMultiplier(res.config.prefetch_multiplier);
      }
      syncPrimerConfigFromStorage(res.primer_config).catch(() => {});
      if (res.has_fasta) {
        useBrowserStore.getState().setHasFasta(true);
        if (res.fasta_path) useBrowserStore.getState().setFastaPath(res.fasta_path);
      }
      // Hydrate the active genome so the frontend knows which reference the
      // backend already has loaded (e.g. carried over from a previous
      // session's template in public / session-isolation mode). Without this
      // the sidebar reads "no genome" and the GTF auto-load check in
      // App.tsx may skip re-fetching genes since it only gates on hasFasta.
      if (res.current_genome) {
        useBrowserStore.getState().setCurrentGenome(res.current_genome);
        // Bump refreshGeneration once the genome name is known so any
        // data-fetch effects (genes in viewport, gene track, etc.) re-run
        // against the right GTF.
        useBrowserStore.getState().triggerRefresh();
      }
      const currentView = useBrowserStore.getState();
      if (!initialPositionSet.current && `${currentView.chrom}:${currentView.start}-${currentView.end}` !== openingViewport.current) {
        initialPositionSet.current = true; // navigation or a session restore won the startup race
      }
      if (res.initial_position && !initialPositionSet.current && !linkChoseViewport()) {
        initialPositionSet.current = true;
        // Skip the server-driven initial position in render mode — the
        // headless worker has already called setState({chrom, start, end})
        // for the requested region, and racing setViewport here clobbers
        // it back to the server's default. (FiberCNN render-with-filter bug:
        // renders always landed on chr2L instead of the requested chr3R.)
        if (!window.__FIBERBROWSER_RENDER_MODE) {
          const targetKey = `${res.initial_position.chrom}:${res.initial_position.start}-${res.initial_position.end}`;
          const current = useBrowserStore.getState();
          suppressViewportSnapshotKey.current = `${current.chrom}:${current.start}-${current.end}` === targetKey ? null : targetKey;
          useBrowserStore.getState().setViewport(res.initial_position.chrom, res.initial_position.start, res.initial_position.end);
          if (DEBUG) console.log(`Initial position: ${res.initial_position.chrom}:${res.initial_position.start}-${res.initial_position.end} (${res.initial_position.gene_name})`);
        }
      }
      if (res.public_mode) {
        useBrowserStore.getState().setPublicMode(true);
      }
    }).catch(() => {});
    // Settle reference, position and quality gates before the first reads;
    // the initial quality confirmation must not restart an already loading view.
    Promise.all([initialDatasets, initialStatus, initialQualityFilterSync]).then(([res]) => {
      useBrowserStore.getState().setDatasets(res.datasets);
      useBrowserStore.getState().initModTypeDefaults();
    }).catch(() => {});

  }, [isRenderMode, initialPositionSet, suppressViewportSnapshotKey, initialQualityFilterSync]);

  // Re-fetch tracks/chroms/status when refreshGeneration is bumped (replaces window.refreshBrowserTracks)
  // IMPORTANT: This effect must NOT navigate the viewport. Dataset/track additions trigger
  // refreshGeneration, and navigating here would reset the user's position + clustering.
  // Genome-change navigation is handled explicitly by the genome loading handlers.
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);
  // Where the main view was when the page opened: once the user has gone
  // somewhere else, a later initial position (e.g. once a dataset on another
  // assembly got its own reference and no longer blocks it) must not move it.
  const openingViewport = useRef<string | null>(null);
  if (openingViewport.current === null) {
    const s0 = useBrowserStore.getState();
    openingViewport.current = `${s0.chrom}:${s0.start}-${s0.end}`;
  }
  useEffect(() => {
    if (isRenderMode) return;
    if (refreshGeneration === 0) return; // skip initial mount
    getTracks().then(res => setTrackList(res.tracks)).catch(() => {});
    getChromosomes().then(res => {
      useBrowserStore.getState().setChroms(res.chroms);
    }).catch(() => {});
    getStatus(!initialPositionSet.current && !linkChoseViewport()).then(res => {
      syncPrimerConfigFromStorage(res.primer_config).catch(() => {});
      if (res.has_fasta) {
        useBrowserStore.getState().setHasFasta(true);
        if (res.fasta_path) useBrowserStore.getState().setFastaPath(res.fasta_path);
      }
      // Rehydrate current_genome without calling triggerRefresh here — this
      // handler ALREADY runs because refreshGeneration bumped, and calling
      // triggerRefresh would self-trigger an infinite loop of /api/reads
      // fetches. The mount handler above bumps once; that's sufficient.
      if (res.current_genome) {
        useBrowserStore.getState().setCurrentGenome(res.current_genome);
      }
      // Only set initial position on first load (before user has navigated).
      // Skip in render mode — see comment above.
      const st = useBrowserStore.getState();
      if (!initialPositionSet.current && `${st.chrom}:${st.start}-${st.end}` !== openingViewport.current) {
        initialPositionSet.current = true;  // the user has moved the view since it opened
      }
      if (res.initial_position && !initialPositionSet.current && !window.__FIBERBROWSER_RENDER_MODE && !linkChoseViewport()) {
        initialPositionSet.current = true;
        const targetKey = `${res.initial_position.chrom}:${res.initial_position.start}-${res.initial_position.end}`;
        const current = useBrowserStore.getState();
        suppressViewportSnapshotKey.current = `${current.chrom}:${current.start}-${current.end}` === targetKey ? null : targetKey;
        useBrowserStore.getState().setViewport(res.initial_position.chrom, res.initial_position.start, res.initial_position.end);
        if (DEBUG) console.log(`Updated position after dataset load: ${res.initial_position.chrom}:${res.initial_position.start}-${res.initial_position.end}`);
      }
    }).catch(() => {});
  }, [refreshGeneration, isRenderMode, initialPositionSet, suppressViewportSnapshotKey]);

  // Dynamic re-clustering when the viewport changes. Combinatorial uses binary
  // patterns; other methods (kmeans, etc.) use per-cluster centroids.
  const lastDynamicClusterRef = useRef<{ chrom: string; start: number; end: number } | null>(null);
  const activeClusterBranchDynamicKey = useMemo(
    () => clusterBranchDynamicScopeKey(activeClusterBranch),
    [activeClusterBranch],
  );

  useEffect(() => {
    const hasPatterns = Object.keys(clusterPatterns).length > 0;
    const hasCentroids = Object.keys(clusterCentroids).length > 0;
    if (DEBUG) console.log(`[DynamicCluster Effect] Triggered: dynamicClustering=${dynamicClustering}, patterns=${Object.keys(clusterPatterns).length}, centroids=${Object.keys(clusterCentroids).length}, peakRegions=${clusterPeakRegions.length}`);

    if (!dynamicClustering || (!hasPatterns && !hasCentroids) || clusterPeakRegions.length === 0) {
      if (DEBUG) console.log(`[DynamicCluster Effect] Skipped: missing prerequisites`);
      return;
    }

    // Right after a restore, the saved clusters are for this exact view.
    const restoredView = useBrowserStore.getState().restoredClusterViewport;
    if (restoredView) {
      useBrowserStore.setState({ restoredClusterViewport: null } as any);
      if (restoredView.chrom === chrom && restoredView.start === start && restoredView.end === end) {
        lastDynamicClusterRef.current = { chrom, start, end };
        return;
      }
    }

    if (isClusterBranchAtViewport(activeClusterBranch, chrom, start, end)) {
      if (DEBUG) console.log('[DynamicCluster Effect] Skipped: preserving active cluster branch snapshot at its saved viewport');
      lastDynamicClusterRef.current = { chrom, start, end };
      return;
    }

    const peaksInView = clusterPeakRegions.some(
      p => p.start < end && p.end > start
    );

    if (DEBUG) {
      console.log(`[DynamicCluster Effect] Viewport: ${start}-${end}, peaksInView=${peaksInView}`);
      clusterPeakRegions.forEach((p, i) => {
        const visible = p.start < end && p.end > start;
        console.log(`[DynamicCluster Effect]   Peak ${i}: ${p.start}-${p.end}, visible=${visible}`);
      });
    }

    if (!peaksInView) {
      if (DEBUG) console.log('[DynamicCluster Effect] All cluster peaks out of view, disabling');
      useBrowserStore.getState().setDynamicClustering(false);
      return;
    }

    const lastCluster = lastDynamicClusterRef.current;
    if (lastCluster && lastCluster.chrom === chrom && lastCluster.start === start && lastCluster.end === end) {
      if (DEBUG) console.log(`[DynamicCluster Effect] Skipped: same viewport`);
      return;
    }

    if (DEBUG) console.log(`[DynamicCluster Effect] Will re-cluster in 300ms`);

    const controller = new AbortController();
    const timeoutId = setTimeout(async () => {
      lastDynamicClusterRef.current = { chrom, start, end };

      const datasetIds = getTargetDatasetIds(selectedDatasets, panels, datasets);
      if (datasetIds.length === 0) return;
      const keyMap = getStateKeyMap(selectedDatasets, panels, datasets);
      const dynamicReadIds = branchReadIdsForDatasets(activeClusterBranch, datasetIds, keyMap);

      if (DEBUG) {
        console.log(`[DynamicCluster] Assigning reads to ${Object.keys(clusterPatterns).length} clusters`);
        console.log(`[DynamicCluster] Peak regions (absolute): ${clusterPeakRegions.map(p => `${p.start}-${p.end}`).join(', ')}`);
        console.log(`[DynamicCluster] Patterns: ${JSON.stringify(clusterPatterns)}`);
        if (dynamicReadIds) {
          console.log(`[DynamicCluster] Branch scope: ${Object.values(dynamicReadIds).reduce((n, ids) => n + ids.length, 0)} reads`);
        }
      }

      try {
        const peakRegionsWithMode = clusterPeakRegions.map(p => ({
          start: p.start,
          end: p.end,
          mode: (p.mode || 'accessibility') as import('../types').PeakMode
        }));

        const useCentroids = Object.keys(clusterPatterns).length === 0 && Object.keys(clusterCentroids).length > 0;
        const res = await assignToClusters(
          chrom, start, end,
          peakRegionsWithMode,
          clusterPatterns,
          datasetIds,
          spanningOnly,
          subnucleosomalThreshold,
          accessibilityThreshold,
          {
            sampleSeed: analysisSampleSeed,
            clusterFeatureRules,
            readIds: dynamicReadIds,
            ...(panels.some(p => p.liftHap) ? { viewports: sharedClusterWindows(useBrowserStore.getState(), datasetIds)
              .map(({ panel: _panel, ...view }) => ({ ...view, read_ids: dynamicReadIds?.[view.dataset_id] ?? view.read_ids })) } : {}),
            signal: controller.signal,
            overlapMode: dynamicOverlapMode,
            ...(useCentroids ? {
              centroids: clusterCentroids,
              peakWidths: clusterPeakWidths,
            } : {}),
          }
        );

        for (const [datasetId, result] of Object.entries(res.results)) {
          if (DEBUG) console.log(`[DynamicCluster] Result for ${datasetId}:`, {
            assignmentCount: Object.keys(result.assignments || {}).length,
            clusterCounts: result.cluster_counts,
          });
          for (const sk of (keyMap[datasetId] ?? [datasetId])) {
            // Dynamic (navigation-driven) reassignment is a partial viewport
            // projection. Merge it into live state for a stable cohort, but
            // never mirror it into the saved tree node.
            useBrowserStore.getState().setClusterAssignments(
              sk,
              result.assignments || {},
              { mirror: false, merge: true },
            );
            if (result.cluster_counts) {
              const counts = result.cluster_counts as Record<number, number>;
              const order = mergeClusterOrder(
                useBrowserStore.getState().clusterOrder[sk],
                Object.entries(counts).map(([id, n]) => [parseInt(id), n] as [number, number]),
              );
              if (order) useBrowserStore.getState().setClusterOrder(sk, order, { mirror: false });
            }
          }
        }

        if (DEBUG) console.log('[DynamicCluster] Complete:', Object.fromEntries(
          Object.entries(res.results).map(([k, v]) => [k, {
            reads: Object.keys(v.assignments || {}).length,
            clusters: v.cluster_counts
          }])
        ));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Dynamic clustering failed:', err);
      }
    }, 300);

    return () => { clearTimeout(timeoutId); controller.abort(); };
  }, [chrom, start, end, dynamicClustering, clusterPatterns, clusterCentroids, clusterPeakWidths, dynamicOverlapMode, clusterPeakRegions, clusterFeatureRules, activeClusterBranchDynamicKey, datasets, selectedDatasets, panels, spanningOnly, subnucleosomalThreshold, accessibilityThreshold, analysisSampleSeed]);

  // Helper: collect read IDs for scanning
  const collectScanReadIds = useCallback(() => {
    const targetDsIds = getTargetDatasetIds(selectedDatasets, panels, datasets);
    const targetDatasets = targetDsIds.map(id => datasets.find(d => d.id === id)).filter((d): d is typeof datasets[0] => !!d);
    const scanKeyMap = getStateKeyMap(selectedDatasets, panels, datasets);
    const readIdsByDataset: Record<string, string[]> = {};
    let totalReads = 0;
    const emptyDisplayedDatasets = new Set<string>();
    for (const ds of targetDatasets) {
      const stateKeys = scanKeyMap[ds.id] || [ds.id];
      // Union over the dataset's panels (a CT | GA split scans both strands;
      // one strand panel scans that strand).
      const ids = new Set<string>();
      for (const sk of stateKeys) for (const id of activeReadIds[sk] ?? []) ids.add(id);
      if (ids.size > 0) {
        readIdsByDataset[ds.id] = [...ids];
        totalReads += ids.size;
        continue;
      }
      // An empty/loading display never expands into an unscoped full scan.
      emptyDisplayedDatasets.add(ds.id);
    }
    const scanTargets = targetDatasets.filter(ds => !emptyDisplayedDatasets.has(ds.id));
    const loadedDatasetIds = Object.keys(readIdsByDataset);
    return { targetDsIds, targetDatasets: scanTargets, readIdsByDataset, loadedDatasetIds, totalReads };
  }, [datasets, selectedDatasets, panels, activeReadIds]);

  // Per-rule scan handler — scans peaks for a single rule
  const scanPeaksForRule = useCallback(async (ruleId: string, signal?: AbortSignal) => {
    const state = useBrowserStore.getState();
    if (signal?.aborted) return;
    if (state.peaksLocked) {
      if (DEBUG) console.log(`[Scan rule] Skipped "${ruleId}" because peaks are locked`);
      return;
    }
    const rule = state.peakRules.find(r => r.id === ruleId);
    if (!rule || !isScannedRule(rule)) return;

    const { targetDatasets, readIdsByDataset, loadedDatasetIds } = collectScanReadIds();
    if (targetDatasets.length === 0) return;
    const scanSingle = targetDatasets.length === 1;
    const singleDatasetId = scanSingle ? targetDatasets[0].id : undefined;
    const scanDatasetIds = loadedDatasetIds.length > 0
      ? loadedDatasetIds
      : targetDatasets.map(d => d.id);

    if (DEBUG) console.log(`=== Scan rule "${rule.name}" (${rule.source}) ===`);

    // Results are for this view: once the view moved or the scan was cancelled,
    // they'd be the previous region's peaks.
    const scanScope = peakScanScope(state, ruleId);
    const stillCurrent = () => {
      const now = useBrowserStore.getState();
      return !signal?.aborted && now.chrom === chrom && now.start === start && now.end === end
        && peakScanScope(now, ruleId) === scanScope;
    };
    // Signal sources read one dataset: the targeted (selected) one, through
    // its panel's profile key.
    const scanDataset = targetDatasets[0];
    const profileKeyFor = (datasetId: string | undefined) => {
      if (!datasetId) return undefined;
      const st = useBrowserStore.getState();
      const panel = st.panels.find(p => p.contentType === 'dataset' && p.datasetId === datasetId && isMainViewPanel(p)
        && (st.selectedDatasets.size === 0 || st.selectedDatasets.has(p.id)));
      return panel?.stateKey ?? datasetId;
    };
    const profileFor = (datasetId: string | undefined) => {
      const profiles = useBrowserStore.getState().datasetProfiles;
      const key = profileKeyFor(datasetId);
      return (key ? profiles[key] : undefined) ?? (datasetId ? profiles[datasetId] : undefined);
    };

    try {
      // Built-in sources, modification marks and any interval layer route through scanPeaks
      const scanSource = serverScanSource(rule.source);
      if (scanSource) {
        const thresholds = {
          smoothWidth: rule.smoothWidth,
          thresholdStrong: rule.thresholds[0],
          thresholdMedium: rule.thresholds[1],
          thresholdWeak: rule.thresholds[2],
          thresholdRare: rule.thresholds[3],
        };
        // A host drawing its graph on this view's contig: the scan runs on graph node columns, every haplotype
        // pooled per column (graph features; features/graphPanel/graphScan.ts).
        const graphRes = await extendedPeakScan(useBrowserStore.getState(), {
          chrom, start, end, source: scanSource, minWidth: rule.minPeakWidth, minReads: rule.minReads, thresholds,
          sampleSeed: analysisSampleSeed, signal,
        });
        if (graphRes) {
          if (!stillCurrent()) return;
          const graphPeaks: import('../types').FirePeak[] = graphRes.peaks.map(p => ({
            start: p.start, end: p.end, index: p.index, layer: p.layer, score: p.score, threshold: p.threshold, width: p.width,
            ...(p.graph && p.graph.kind !== 'target' ? { sourceLabel: `Graph: ${p.graph.label ? `insertion ${p.graph.label}` : 'insertion'}` } : {}),
          }));
          if (rule.source === 'accessibility' || rule.source === 'fire') {
            useBrowserStore.setState({ fireSignal: graphRes.signal ?? [], fireTrackType: 'none' });
          }
          useBrowserStore.getState().setPeaksByRule(rule.id, graphPeaks);
          useBrowserStore.getState().setCorrespondenceScans(rule.id, {});
          if (graphRes.signal) useBrowserStore.getState().setPeakSignalCache(rule.id, graphRes.signal);
          return;
        }
        const pooled = await scanEquivalentRegions(state, rule, scanSource, signal);
        if (Object.keys(pooled.summaries).length) {
          const specific = await scanUnsharedRegions(state, rule, scanSource, pooled, signal);
          if (!stillCurrent()) return;
          useBrowserStore.getState().setPeaksByRule(rule.id, [...pooled.peaks, ...specific]);
          useBrowserStore.getState().setCorrespondenceScans(rule.id, pooled.summaries);
          return;
        }
        const scanStarted = nowMs();
        const res = await scanPeaks(
          chrom, start, end, rule.minPeakWidth, rule.minReads,
          undefined, undefined,
          thresholds,
          singleDatasetId,
          Object.keys(readIdsByDataset).length > 0 ? readIdsByDataset : undefined,
          scanSource,
          true,  // returnSignal for visualization
          analysisSampleSeed,
          scanDatasetIds,
          signal ? { signal } : undefined,
        );
        logPerfTiming('peak.scan', nowMs() - scanStarted, {
          ruleId: rule.id,
          source: rule.source,
          region: `${chrom}:${start}-${end}`,
          datasets: scanDatasetIds.length,
          loadedDatasets: loadedDatasetIds.length,
          peaks: res.peaks.length,
          reads: res.n_reads,
          serverMs: res.server_elapsed_ms,
          serverTimings: res.server_timings,
        }, 75);

        if (DEBUG) console.log(`=== Rule "${rule.name}" Results: ${res.peaks.length} peaks ===`);

        const peaks: import('../types').FirePeak[] = res.peaks.map((p: any) => ({
          start: p.start, end: p.end, index: p.index,
          layer: p.layer, score: p.score, threshold: p.threshold,
        }));
        // Panels at other loci get their own peaks, tagged with their chromosome.
        for (const w of otherLocusWindows(useBrowserStore.getState().panels, chrom, start, end)) {
          if (signal?.aborted) return;
          // The reads those panels show (strand, filters and focus applied).
          const active = useBrowserStore.getState().activeReadIds;
          const windowReadIds: Record<string, string[]> = {};
          for (const [ds, keys] of Object.entries(w.stateKeys)) {
            const ids = new Set(keys.flatMap(k => active[k] ?? []));
            if (ids.size > 0) windowReadIds[ds] = [...ids];
          }
          const windowDatasets = Object.keys(windowReadIds);
          if (windowDatasets.length === 0) continue;
          try {
            const other = await scanPeaks(
              w.chrom, w.start, w.end, rule.minPeakWidth, rule.minReads,
              undefined, undefined, thresholds,
              windowDatasets.length === 1 ? windowDatasets[0] : undefined,
              windowReadIds, scanSource, false, analysisSampleSeed, windowDatasets,
              signal ? { signal } : undefined,
              // A panel on another assembly is scanned on its reference.
              w.genome ?? null,
            );
            for (const p of other.peaks as Array<{ start: number; end: number; layer?: number; score?: number; threshold?: number }>) {
              // Where it overlaps the main view, the main scan's peaks stand;
              // where two windows overlap, the first's.
              if (!w.genome && w.chrom === chrom && p.start < end && p.end > start) continue;
              if (peaks.some(q => (q.genome ?? null) === (w.genome ?? null) && sameChrom(q.chrom ?? chrom, w.chrom) && p.start < q.end && p.end > q.start)) continue;
              peaks.push({ start: p.start, end: p.end, index: 0, layer: p.layer, score: p.score, threshold: p.threshold, chrom: w.chrom,
                ...(w.genome ? { genome: w.genome } : {}) });
            }
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            console.warn(`Scan of ${w.chrom}:${w.start}-${w.end} failed:`, err);
          }
        }

        if (!stillCurrent()) return;
        // Keep the historical signal cache without writing peaks twice. The
        // FireTrack now renders rule peaks from peaksByRule below.
        if (rule.source === 'accessibility' || rule.source === 'fire') {
          useBrowserStore.setState({ fireSignal: res.signal ?? [], fireTrackType: 'none' });
        }
        useBrowserStore.getState().setPeaksByRule(rule.id, peaks);
        useBrowserStore.getState().setCorrespondenceScans(rule.id, pooled.summaries);
        // Cache signal for visualization in PeakDetectionPanel
        if (res.signal) {
          useBrowserStore.getState().setPeakSignalCache(rule.id, res.signal);
        }
        return;
      }

      // Signal-based sources: fetch signal array, detect peaks
      let signalValues: number[] | undefined;

      if (rule.source.startsWith('track:')) {
        const trackIdx = parseInt(rule.source.split(':')[1], 10);
        const res = await getTrackData(trackIdx, chrom, start, end, 2000);
        signalValues = res.values;
      } else if (rule.source.startsWith('annot:')) {
        const typeName = rule.source.split(':').slice(1).join(':');
        const datasetId = scanDataset?.id;
        if (!datasetId) return;
        const annotFiles = useBrowserStore.getState().annotationFiles;
        const activeTypes = annotFiles.filter(f => f.active).flatMap(f => f.annotationTypes ?? []);
        if (!activeTypes.some(t => t.name === typeName)) {
          useBrowserStore.getState().setError(`Annotation type "${typeName}" not found in active files.`);
          return;
        }
        const res = await getAnnotationProfile(chrom, start, end, datasetId, [typeName], 2000);
        signalValues = res.profiles?.[typeName];
      } else if (rule.source === 'profile:mod') {
        signalValues = profileFor(scanDataset?.id)?.mod;
      } else if (rule.source === 'profile:fire') {
        signalValues = profileFor(scanDataset?.id)?.fire;
      } else if (rule.source.startsWith('profile:rule:')) {
        const colormapRuleId = rule.source.split(':').slice(2).join(':');
        signalValues = profileFor(scanDataset?.id)?.rules?.[colormapRuleId];
      } else if (rule.source === 'fire_signal') {
        signalValues = useBrowserStore.getState().fireSignal;
      } else {
        useBrowserStore.getState().setError(`Peak rule "${rule.name}": its source "${rule.source}" can't be scanned.`);
        return;
      }

      if (!stillCurrent()) return;
      if (!signalValues || signalValues.length < 3) {
        if (DEBUG) console.warn('No signal data for', rule.source);
        return;
      }

      // Cache signal for visualization before detecting peaks
      useBrowserStore.getState().setPeakSignalCache(rule.id, signalValues);

      const res = await detectSignalPeaks(signalValues, chrom, start, end, rule.name, {
        minWidth: rule.minPeakWidth,
        thresholdValue: rule.thresholds[3],
      });
      const peaks = res.peaks.map((p: any) => ({
        start: p.start, end: p.end, index: 0,
        score: p.score, threshold: p.threshold, layer: 0,
      }));
      if (!stillCurrent()) return;
      useBrowserStore.getState().setPeaksByRule(rule.id, peaks);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error(`Scan failed for rule "${rule.name}":`, err);
    }
  }, [chrom, start, end, datasets, collectScanReadIds, analysisSampleSeed]);

  // Combined scan: scan all enabled non-custom rules in parallel
  const handleScanPeaks = useCallback(async (signal?: AbortSignal) => {
    if (datasets.length === 0) return;
    const state = useBrowserStore.getState();
    if (signal?.aborted) return;
    if (state.peaksLocked) {
      if (DEBUG) console.log('[Scan peaks] Skipped because peaks are locked');
      return;
    }
    const rulesToScan = state.peakRules.filter(r => r.enabled && isScannedRule(r));
    if (rulesToScan.length === 0) return;

    setScanning(true);
    setScanStopped(null);
    try {
      const scans = Promise.all(rulesToScan.map(r => scanPeaksForRule(r.id, signal)));
      // A cancelled scan stops showing "Scanning peaks..." at once, whatever request it still waits on (its results
      // are for a view or scope that is gone, and are dropped when they arrive).
      await (signal ? Promise.race([scans, new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
      })]) : scans);
    } finally {
      setScanning(false);
    }
  }, [scanPeaksForRule, datasets]);

  // Auto-scan peaks when reads are loaded (new viewport)
  const handleScanPeaksRef = useRef(handleScanPeaks);
  useEffect(() => { handleScanPeaksRef.current = handleScanPeaks; }, [handleScanPeaks]);
  useEffect(() => {
    registerScanRunner(() => handleScanPeaksRef.current());
    return () => registerScanRunner(null);
  }, []);

  const lastScanRegionRef = useRef<string>('');
  type AutoScanJob = { key: string; controller: AbortController; timer: ReturnType<typeof setTimeout> | null; idle: number | null };
  const autoScanRef = useRef<AutoScanJob | null>(null);
  const cancelAutoScan = useCallback(() => {
    const job = autoScanRef.current;
    if (!job) return;
    job.controller.abort();
    if (job.timer) clearTimeout(job.timer);
    if (job.idle !== null) {
      const w = window as unknown as { cancelIdleCallback?: (handle: number) => void };
      w.cancelIdleCallback?.(job.idle);
    }
    autoScanRef.current = null;
  }, []);
  useEffect(() => cancelAutoScan, [cancelAutoScan]); // on unmount

  useEffect(() => {
    if (datasets.length === 0) return;
    if (peaksLocked) {
      cancelAutoScan();
      if (DEBUG) console.log('[AutoScan Effect] Skipped: peaks are locked');
      return;
    }

    // Check if any non-custom enabled rules need scanning (no peaks yet)
    const state = useBrowserStore.getState();
    // Panels at other loci are scanned with the main view; one moving rescans.
    // (Its datasets are part of the key; so is a window going away, whose peaks must go too.)
    // Whether a window's reads have loaded is part of it: a window scanned
    // before its reads arrived was skipped and is scanned once they do.
    const otherLociKey = otherLocusWindows(panels, chrom, start, end)
      .map(w => {
        const keys = Object.values(w.stateKeys).flat();
        const loaded = keys.some(k => (activeReadIds[k]?.length ?? 0) > 0) ? 'r' : '-';
        const strands = panels.filter(p => keys.includes(p.stateKey ?? p.datasetId ?? '') && p.viewportOverride).map(p => p.strand ?? '').sort().join('');
        return `${w.genome ? `${w.genome}|` : ''}${w.chrom}:${w.start}-${w.end}[${[...w.datasetIds].sort().join(',')}${strands}]${loaded}`;
      }).join(';');
    const lastScan = lastScanRegionRef.current;
    const correspondenceKey = JSON.stringify(state.peakRules.filter(r => r.source === 'matched').map(r => state.peaksByRule[r.id]));
    const needsScan = state.peakRules.some(r =>
      r.enabled && isScannedRule(r) && !(state.peaksByRule[r.id]?.length > 0)
    ) || !lastScan.includes(`:maps=${correspondenceKey}:others=`)
      || (lastScan.includes(':others=') ? !lastScan.endsWith(`:others=${otherLociKey}`) : otherLociKey !== '');

    const ordinarySelection = hasOrdinaryPeakSelection(state);
    if (dynamicClustering || ordinarySelection) cancelAutoScan(); // don't replace peaks now
    if (!needsScan || dynamicClustering || ordinarySelection) {
      if (DEBUG) console.log(`[AutoScan Effect] Skipped: needsScan=${needsScan}, dynamicClustering=${dynamicClustering}, selectedPeaks=${selectedPeaks.size}`);
      return;
    }

    const datasetIds = getTargetDatasetIds(selectedDatasets, panels, datasets);
    const autoScanKeyMap = getStateKeyMap(selectedDatasets, panels, datasets);

    const loadedDatasetIds = datasetIds.filter(id => {
      const sks = autoScanKeyMap[id] || [id];
      return sks.some(sk => (activeReadIds[sk]?.length || 0) > 0);
    });
    const loadedCount = loadedDatasetIds.length;
    if (loadedCount === 0) {
      cancelAutoScan(); // a scan for the previous view is stale now
      return;
    }

    const ruleKeys = state.peakRules.filter(r => r.enabled && isScannedRule(r)).map(r => r.id).join(',');
    const loadedKey = loadedDatasetIds.slice().sort().join(',');
    const regionKey = `${chrom}:${start}-${end}:${datasetIds.length}ds:loaded=${loadedKey}:${ruleKeys}:maps=${correspondenceKey}:others=${otherLociKey}`;

    if (lastScanRegionRef.current === regionKey) return;
    // Already scheduled or scanning this region: let it finish. (A scan's own
    // updates re-run this effect; cancelling then would mean it never lands.)
    if (autoScanRef.current?.key === regionKey) return;
    cancelAutoScan();

    const controller = new AbortController();
    const job: AutoScanJob = { key: regionKey, controller, timer: null, idle: null };
    autoScanRef.current = job;
    const debounceMs = datasetIds.length > 1 ? 1200 : 900;
    job.timer = setTimeout(() => {
      const run = () => {
        if (controller.signal.aborted) return;
        if (DEBUG) console.log(`Auto-scanning peaks for ${regionKey}`);
        // An automatic scan has a time budget: one the server can't answer in time (busy with other work) stops,
        // so "Scanning peaks..." never stays up. It is not retried automatically for this view (no loop of
        // minute-long attempts); Scan runs it again.
        let disarm: (() => void) | null = null;
        waitForViewIdle(controller.signal)
          .then(() => {
            if (controller.signal.aborted) return;
            disarm = armScanBudget(controller, () => {
              console.warn(`Automatic peak scan of ${chrom}:${start}-${end} stopped after ${AUTO_SCAN_BUDGET_MS / 1000} s; press Scan to run it.`);
              lastScanRegionRef.current = regionKey;
              setScanStopped(scanStoppedNote());
            });
            return handleScanPeaksRef.current(controller.signal);
          })
          .then(() => {
            if (controller.signal.aborted) return;
            lastScanRegionRef.current = regionKey; // scanned: don't repeat for this view
          })
          .catch(() => { /* failed: leave the region unscanned so it is retried */ })
          .finally(() => {
            disarm?.();
            if (autoScanRef.current === job) autoScanRef.current = null;
          });
      };
      const w = window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
      if (w.requestIdleCallback) job.idle = w.requestIdleCallback(run, { timeout: 2500 });
      else run();
    }, debounceMs);
  }, [chrom, start, end, activeReadIds, datasets, selectedDatasets, panels, peakRules, peaksByRule, selectedPeaks, dynamicClustering, peaksLocked]);

  // Listen for re-scan requests from PeakDetectionPanel
  const scanPeaksForRuleRef = useRef(scanPeaksForRule);
  useEffect(() => { scanPeaksForRuleRef.current = scanPeaksForRule; }, [scanPeaksForRule]);

  useEffect(() => {
    const handler = (e: Event) => {
      const ruleId = (e as CustomEvent).detail?.ruleId;
      if (ruleId) {
        scanPeaksForRuleRef.current(ruleId);
      } else {
        // Re-scan all enabled non-custom rules
        handleScanPeaksRef.current();
      }
    };
    window.addEventListener('fiberhmm:rescan-rule', handler);
    return () => window.removeEventListener('fiberhmm:rescan-rule', handler);
  }, []);

  // Sync peaks to backend for Jupyter API access after navigation settles.
  // Empty peak sets intentionally use one stable key, so panning across an
  // empty/default state does not POST to Jupyter on every viewport change.
  const peakSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peakSyncIdleRef = useRef<number | null>(null);
  const lastPeakSyncKeyRef = useRef<string>('');
  const pendingPeakSyncKeyRef = useRef<string>('');
  useEffect(() => {
    const state = useBrowserStore.getState();
    const allPeaks = state.getAllPeaks();
    const selectedKey = Array.from(selectedPeaks).sort((a, b) => a - b).join(',');
    const peakKey = allPeaks.length === 0
      ? `empty:selected=${selectedKey}`
      : `${chrom}:${allPeaks
        .map(p => `${p.ruleId ?? ''}:${p.index}:${p.start}-${p.end}:${p.layer ?? 0}:${selectedPeaks.has(p.index) ? 1 : 0}`)
        .join('|')}`;

    if (lastPeakSyncKeyRef.current === peakKey) {
      return;
    }
    pendingPeakSyncKeyRef.current = peakKey;

    if (peakSyncTimerRef.current) clearTimeout(peakSyncTimerRef.current);
    if (peakSyncIdleRef.current !== null) {
      const w = window as unknown as { cancelIdleCallback?: (handle: number) => void };
      if (w.cancelIdleCallback) w.cancelIdleCallback(peakSyncIdleRef.current);
      else clearTimeout(peakSyncIdleRef.current);
      peakSyncIdleRef.current = null;
    }

    peakSyncTimerRef.current = setTimeout(() => {
      const run = () => {
        if (pendingPeakSyncKeyRef.current !== peakKey) return;
        lastPeakSyncKeyRef.current = peakKey;
        pendingPeakSyncKeyRef.current = '';
        void syncPeaksToBackend();
      };
      const w = window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      };
      peakSyncIdleRef.current = w.requestIdleCallback
        ? w.requestIdleCallback(run, { timeout: 3000 })
        : window.setTimeout(run, 0);
    }, 1500);

    return () => {
      if (peakSyncTimerRef.current) clearTimeout(peakSyncTimerRef.current);
      if (peakSyncIdleRef.current !== null) {
        const w = window as unknown as { cancelIdleCallback?: (handle: number) => void };
        if (w.cancelIdleCallback) w.cancelIdleCallback(peakSyncIdleRef.current);
        else clearTimeout(peakSyncIdleRef.current);
        peakSyncIdleRef.current = null;
      }
      if (pendingPeakSyncKeyRef.current === peakKey) {
        pendingPeakSyncKeyRef.current = '';
      }
    };
  }, [peaksByRule, selectedPeaks, chrom, syncPeaksToBackend]);

  // Debounced viewport snapshot — push history entry 500ms after navigation settles.
  // _historyPaused (set for 600ms after undo/redo) suppresses the push so redo isn't broken.
  const navSnapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevViewportRef = useRef<string>('');
  const lastStableViewportSnapshotRef = useRef<SerializedState | null>(null);
  const pendingViewportStartSnapshotRef = useRef<SerializedState | null>(null);
  useEffect(() => {
    const key = `${chrom}:${start}-${end}`;
    if (suppressViewportSnapshotKey.current === key) {
      if (navSnapshotTimer.current) {
        clearTimeout(navSnapshotTimer.current);
        navSnapshotTimer.current = null;
      }
      pendingViewportStartSnapshotRef.current = null;
      prevViewportRef.current = key;
      lastStableViewportSnapshotRef.current = serializeState(useBrowserStore.getState());
      suppressViewportSnapshotKey.current = null;
      return;
    }
    if (prevViewportRef.current === key || prevViewportRef.current === '') {
      prevViewportRef.current = key;
      if (!navSnapshotTimer.current) {
        lastStableViewportSnapshotRef.current = serializeState(useBrowserStore.getState());
      }
      return;
    }
    if (!navSnapshotTimer.current) {
      pendingViewportStartSnapshotRef.current = lastStableViewportSnapshotRef.current;
    }
    prevViewportRef.current = key;
    if (navSnapshotTimer.current) clearTimeout(navSnapshotTimer.current);
    navSnapshotTimer.current = setTimeout(() => {
      const store = useBrowserStore.getState();
      if ((store._historyStack?.length ?? 0) === 0 && pendingViewportStartSnapshotRef.current) {
        store.pushSerializedSnapshot('Before navigation', pendingViewportStartSnapshotRef.current, { kind: 'navigation' });
      }
      store.pushSnapshot(`Navigate to ${formatCoordinates(chrom, start, end)}`, { kind: 'navigation' });
      lastStableViewportSnapshotRef.current = serializeState(useBrowserStore.getState());
      pendingViewportStartSnapshotRef.current = null;
      navSnapshotTimer.current = null;
    }, 500);
    return () => { if (navSnapshotTimer.current) clearTimeout(navSnapshotTimer.current); };
  }, [chrom, start, end, suppressViewportSnapshotKey]);

  // Enable keyboard shortcuts
  const toggleShortcutsModal = useCallback(() => setShowShortcuts(v => !v), []);
  // While Export is open, keys belong to it, not the view behind (other dialogs say aria-modal).
  useKeyboardShortcuts({ onScanPeaks: handleScanPeaks, onToggleShortcutsModal: toggleShortcutsModal, modalOpen: showExportPanel || showExportDataDialog });
  // The two export dialogs are never open together (one Escape, one modal).
  const openExportFigure = useCallback(() => { setShowExportDataDialog(false); setShowExportPanel(true); }, []);
  const openExportData = useCallback(() => { setShowExportPanel(false); setShowExportDataDialog(true); }, []);
  useAppCommand('export-figure', () => { if (isRenderMode) return false; openExportFigure(); return true; });
  // Export data… (File > Export Data…, the command palette, ⌘⇧E in the web browser too).
  useAppCommand('export-data', () => { if (isRenderMode) return false; openExportData(); return true; });
  useEffect(() => {
    if (isRenderMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'e') return;
      event.preventDefault();
      openExportData();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isRenderMode, openExportData]);
  useAppCommand('keyboard-shortcuts', () => { setShowShortcuts(true); return true; });

  // Build peak regions from selected indices
  // Reads the store when called, so a selection or mode set just before
  // (Copilot, the tour, a cluster rule) is what gets clustered.
  // The same regions the toolbar's "Applies to" plans with (utils/clusterTargets.ts).
  const getSelectedPeakRegions = useCallback(() => selectedClusterPeakRegions(useBrowserStore.getState()), []);

  const layerFromSortTerm = useCallback((term: ClusterFeatureRuleTerm | undefined): string | null | undefined => {
    if (!term) return undefined;
    if (term.source === 'label_rule') {
      const targets = term.rule?.targetLayers ?? [];
      return targets.length === 1 ? targets[0] || null : undefined;
    }
    if (term.source === 'footprint_group') return term.group?.layer ?? null;
    return term.layer ?? null;
  }, []);

  // Size, conditions, quality gates and a labeling rule's nucleosome conditions (actions/ruleTermPayload.ts).
  const rulePayloadFromSortTerm = useCallback((term: ClusterFeatureRuleTerm | undefined) => ruleTermPayload(term), []);

  const transcriptionStateFromTerm = useCallback((term: ClusterFeatureRuleTerm | undefined): TranscriptionStateRuleKind | null => {
    if (term?.source !== 'transcription_state') return null;
    return normalizeTranscriptionStateRuleKind(term.transcriptionState);
  }, []);

  const geneIdsForAnalysisRule = useCallback((rule: Pick<AnalysisSortRule | AnalysisFilterRule, 'scope'>): string[] => {
    const scope = normalizeAnalysisRuleScope(rule.scope);
    if (scope.kind === 'gene') {
      if (scope.geneId) {
        const match = selectedGenes.find(gene => gene.id === scope.geneId);
        if (match) return [match.id];
      }
      if (scope.geneName) {
        const match = selectedGenes.find(gene => (gene.name || '').toLowerCase() === scope.geneName!.toLowerCase());
        if (match) return [match.id];
      }
      if (selectedGenes[0]?.id) return [selectedGenes[0].id];
      return scope.geneId ? [scope.geneId] : [];
    }
    return selectedGenes.map(gene => gene.id).filter(Boolean);
  }, [selectedGenes]);

  // Each clustering run's number: a run's results apply only while it is the latest.
  const clusterRunRef = useRef(0);
  useEffect(() => () => cancelProgressiveAnalysis(), []);

  // Clustering handler
  const handleCluster = useCallback(async () => {
    cancelProgressiveAnalysis();
    // Current values, not this render's: Copilot and the tour set the method,
    // K or selection just before calling this.
    const {
      datasets, selectedDatasets, panels, chrom, start, end, clusterK, clusterMethod,
      subnucleosomalThreshold, accessibilityThreshold, spanningOnly, analysisSampleCount,
      analysisSampleSeed, clusterFeatureRules,
    } = useBrowserStore.getState();
    if (datasets.length === 0) return;
    // This run's outcome replaces the last one's (beside the toolbar, not a global banner that outlives it).
    const resultRun = beginRun('cluster');
    // (`panelIds`: the panels it clustered; the line says "(panel closed)" once they have all gone.)
    const report = (tone: 'error' | 'note' | 'done', text: string, panelIds?: string[]) =>
      setRunResult('cluster', { tone, text, ...(panelIds?.length ? { panelIds } : {}) }, resultRun);

    // The plan the toolbar showed (utils/clusterTargets.ts clusterRunPlan: what the run clusters on, and which panels),
    // followed here: the Cluster tooltip, the Panels chip and this result line say what this run does (round 3, R6/B5).
    const referenceName = (genome: string | null) => (genome ? panelGenomeLabel(usePanelGenomeStore.getState().genomes[genome], genome) : (useBrowserStore.getState().currentGenome || 'the main genome'));
    const targetPlan = clusterRunPlan(useBrowserStore.getState(), referenceName);
    const { basis } = targetPlan;
    // Refused before any request (the feature path too) rather than clustering other panels than the targeted ones.
    if (basis.regions.length > 0 && targetPlan.refusal) {
      report('error', targetPlan.refusal);
      return;
    }
    if (targetPlan.advice) setRunResult('cluster', { tone: 'note', ...targetPlan.advice }, resultRun);
    const extensionRun = clusterBasisRunner(basis.kind);
    if (extensionRun) {
      ++clusterRunRef.current;
      setClustering(true);
      try { await extensionRun(useBrowserStore.getState(), basis, report); }
      catch (error) { report('error', error instanceof Error ? error.message : String(error)); }
      finally { setClustering(false); }
      return;
    }
    if (basis.kind === 'matched') { report('error', 'This build cannot cluster linked regions.'); return; }
    useBrowserStore.setState({ clusterMatchedRun: null });
    // Combinatorial on selected features: the Accessibility panel's grouping code (utils/featureClustering.ts), so the
    // groups, names and colours are those of "Group reads by variant" / "Split by combination pattern".
    if (basis.kind === 'combinatorial') {
      const runId = ++clusterRunRef.current;
      setClustering(true);
      try {
        const error = await clusterSelectedFeatures();
        if (runId === clusterRunRef.current) {
          if (error) report('error', error);
          else report('done', `${clusterRunHeadline(targetPlan).replace(/^Group reads/, 'Grouped the reads')}.`);
        }
      } finally {
        if (runId === clusterRunRef.current) setClustering(false);
      }
      return;
    }

    const datasetIds = getTargetDatasetIds(selectedDatasets, panels, datasets);
    const peakRegions = [...basis.regions];

    if (peakRegions.length === 0) {
      report('error', `Nothing to cluster on: select peaks in the peak track${basis.unused ? ` (${basis.unused})` : ''}.`);
      return;
    }

    // Only filter reads when there's an explicit user-specified filter
    // (cluster focus or filteredReadIds). Previously this used activeReadIds
    // which was the *display sample*, causing clustering to ignore the
    // reads that got sampled out.
    const state = useBrowserStore.getState();
    const keyMap = getStateKeyMap(selectedDatasets, panels, datasets);
    const readIdsMap: Record<string, string[]> = {};
    let hasExplicitFilter = false;
    let hasClusterSubsetFilter = false;
    const selectedSourceClusters = new Set<number>();
    const focusedSourceClusters = new Set<number>();

    for (const dsId of datasetIds) {
      const stateKeys = keyMap[dsId] || [dsId];
      for (const sk of stateKeys) {
        const assignments = state.clusterAssignments[sk];
        // A read filter applies inside a cluster subset too: the subset's reads
        // that pass it (possibly none).
        const readFilter = state.filteredReadIds[sk];
        const passing = (ids: string[]) => (readFilter ? ids.filter(id => idSetHas(readFilter, [id], recordKey(id))) : ids);
        const selected = state.selectedClusters[sk];
        if (selected && selected.size > 0 && assignments) {
          const ids: string[] = [];
          for (const [readId, cluster] of Object.entries(assignments)) {
            if (selected.has(cluster)) ids.push(readId);
          }
          if (ids.length > 0) {
            readIdsMap[dsId] = passing(ids);
            hasExplicitFilter = true;
            hasClusterSubsetFilter = true;
            for (const cluster of selected) selectedSourceClusters.add(cluster);
            break;
          }
        }

        // Cluster focus: user drilled into specific clusters
        const focus = state.clusterFocus[sk];
        if (focus && focus.size > 0 && assignments) {
          const ids: string[] = [];
          for (const [readId, cluster] of Object.entries(assignments)) {
            if (focus.has(cluster)) ids.push(readId);
          }
          if (ids.length > 0) {
            readIdsMap[dsId] = passing(ids);
            hasExplicitFilter = true;
            hasClusterSubsetFilter = true;
            for (const cluster of focus) focusedSourceClusters.add(cluster);
            break;
          }
        }

        // Inside a subcluster branch, a plain Cluster run should retry that
        // branch, not jump back out to every read in the viewport.
        const activeNode = state.activeClusterTreeNodeId
          ? state.clusterTreeNodes[state.activeClusterTreeNodeId]
          : null;
        if (!readIdsMap[dsId] && activeNode?.parentId && assignments && Object.keys(assignments).length > 0) {
          readIdsMap[dsId] = passing(Object.keys(assignments));
          hasExplicitFilter = true;
          break;
        }

        // Filtered read IDs: user applied a read filter
        const filter = state.filteredReadIds[sk];
        if (!readIdsMap[dsId] && filter && filter.size > 0) {
          readIdsMap[dsId] = Array.from(filter);
          hasExplicitFilter = true;
          break;
        }
      }
    }

    const modeCounts: Record<string, number> = {};
    for (const p of peakRegions) {
      const mode = p.mode || 'accessibility';
      modeCounts[mode] = (modeCounts[mode] || 0) + 1;
    }

    if (DEBUG) {
      const filterDesc = hasExplicitFilter
        ? `filtered to ${Object.values(readIdsMap).reduce((n, ids) => n + ids.length, 0)} reads across ${Object.keys(readIdsMap).length} datasets`
        : 'all working set reads';
      console.log(`Clustering ${datasetIds.length} dataset(s) with method=${clusterMethod}, k=${clusterK}, ${peakRegions.length} peaks, ${filterDesc}`);
      console.log(`  Peak modes: ${JSON.stringify(modeCounts)}`);
      console.log(`  Peak regions (absolute): ${peakRegions.map(p => `${p.start}-${p.end}`).join(', ')}`);
    }

    const sourceClusterIds = [...(selectedSourceClusters.size > 0 ? selectedSourceClusters : focusedSourceClusters)]
      .sort((a, b) => a - b);
    // Subclustering branches the active node ATOMICALLY (see commitSubcluster).
    // No detach-to-null before the async backend call, so a React re-render
    // can't re-apply the parent and let the result mirror back into it.
    const subclusterRun = hasClusterSubsetFilter;

    // The same windows "Applies to" plans with (utils/clusterTargets.ts): a cluster subset, a read filter, a split
    // panel's own reads (the panel itself stays out of the request).
    const clusterWindows: Array<Omit<ClusterWindow, 'panel'> & { peak_regions?: Array<{ start: number; end: number; mode?: string }> }>
      = sharedClusterWindows(state, datasetIds).map(({ panel: _panel, ...view }) => view);
    // One reference per run: peaks on two assemblies are refused, panels on
    // another reference than the peaks' are left out (clusterReferenceScope).
    const referenceScope=clusterReferenceScope(state,clusterWindows,peakRegions,referenceName);
    // A panel on a contig of its own (utils/panelExtensions.ts traits) says what that means here.
    const hints=new Set(clusterWindows.map(view=>panelTraits(panels.find(p=>(p.stateKey??p.datasetId)===view.result_key)).clusterScopeHint).filter(Boolean));
    const altHint=[...hints].map(h=>` ${h}`).join('');
    if(!referenceScope.ok){
      report('error',referenceScope.message+altHint);
      return;
    }
    // What was left out, as "Applies to" said it (the long reference note stays for refusals).
    const leftOutRows=targetPlan.rows.filter(r=>r.reason&&!r.inRun&&r.shortReason!=='no reads pass the filter'&&r.shortReason!=='no reads');
    const scopeNotes=referenceScope.note
      ?[leftOutRows.length?`Not clustered: ${leftOutRows.map(r=>`${r.short} (${r.reason})`).join('; ')}.`:referenceScope.note+altHint]:[];
    if(referenceScope.leftOut.length>0){
      for(const view of referenceScope.leftOut){
        clusterWindows.splice(clusterWindows.indexOf(view),1);
        if(!clusterWindows.some(other=>other.dataset_id===view.dataset_id)){
          datasetIds.splice(datasetIds.indexOf(view.dataset_id),1);
          delete readIdsMap[view.dataset_id];
        }
      }
    }
    // Only the run's reference's peaks (a peak in a panel on another assembly isn't one of them).
    peakRegions.splice(0,peakRegions.length,...referenceScope.peaks);
    if(peakRegions.length===0){
      report('error','Select or draw peaks in one of the panels to cluster them together.');
      return;
    }
    // Stored with their reference, so the cluster charts use the peaks of the panel they plot.
    const runGenome=referenceScope.genome;
    const runPeakRegions=runGenome?peakRegions.map(p=>({...p,genome:runGenome})):peakRegions;
    const filteredToNothing=clusterWindows.filter(view=>view.read_ids?.length===0);
    if(filteredToNothing.length>0){
      for(const view of filteredToNothing)clusterWindows.splice(clusterWindows.indexOf(view),1);
      if(clusterWindows.length===0){
        report('error','No reads pass the read filter, so there is nothing to cluster. Clear the filter to cluster every read.');
        return;
      }
    }
    // Datasets whose every panel is filtered to nothing aren't clustered.
    // (A graph host's folded members of other datasets are windows too: their datasets join the run.)
    const windowDatasets=[...new Set(clusterWindows.map(view=>view.dataset_id))];
    const runDatasetIds=[...new Set([...(filteredToNothing.length>0?datasetIds.filter(id=>clusterWindows.some(view=>view.dataset_id===id)):datasetIds),...windowDatasets])];
    // Panels at other loci: each window gets its own matched peaks (see
    // alignWindowPeaks); the shared list is their offsets from the main start.
    let requestPeaks: Array<{ start: number; end: number; mode?: string }> = peakRegions.map(({ start: s, end: e, mode }) => ({ start: s, end: e, mode }));
    // On a panel's own reference the request names the first window's locus
    // (the main locus is a chromosome of the main assembly) and that reference.
    const requestLocus=clusterRequestLocus({chrom,start,end},clusterWindows,runGenome);
    // Each window's own matched peaks (kept for the cluster charts of that panel).
    let windowPeaks: Record<string, Array<{ start: number; end: number; mode?: string }>> | null = null;
    const atOtherLoci=clusterWindows.some(view=>view.chrom!==chrom||view.start!==start||view.end!==end);
    if(atOtherLoci){
      const aligned=alignWindowPeaks(clusterWindows,peakRegions,chrom);
      if(!aligned){
        report('error','Select or draw peaks in one of the panels to cluster them together.');
        return;
      }
      for(const view of clusterWindows)Object.assign(view,{peak_regions:aligned.byWindow[view.result_key]});
      windowPeaks=aligned.byWindow;
      const first=clusterWindows[0];
      requestPeaks=aligned.byWindow[first.result_key].map(p=>({...p,start:requestLocus.start+(p.start-first.start),end:requestLocus.start+(p.end-first.start)}));
      if(aligned.note)scopeNotes.push(aligned.note);
    }
    // Said with the run's result (what was left out), not before it as an error.
    const windowChroms=[...new Set(clusterWindows.map(view=>view.chrom))];
    // Preserve the established extra_chroms path for aligned haplotype views.
    // Explicit window queries only extend it to independently moved windows.
    // Windows at other loci always go explicitly: each is read at its own
    // peaks, coordinates and genomic context.
    const useExistingChromPath=!runGenome&&!atOtherLoci&&filteredToNothing.length===0&&clusterWindows.length>0&&windowChroms.includes(chrom)
      &&clusterWindows.every(view=>view.start===start&&view.end===end&&!view.read_ids&&!('strand' in view)&&!view.lift_hap)
      &&datasetIds.every(id=>windowChroms.every(c=>clusterWindows.some(view=>view.dataset_id===id&&view.chrom===c)));
    const extraChroms=useExistingChromPath?windowChroms.filter(value=>value!==chrom):undefined;

    // The branch and chromosome this run belongs to: results that arrive after
    // the user switched branch, moved to another chromosome or started another
    // run would land on the wrong branch, so they are dropped.
    const runId = ++clusterRunRef.current;
    let startBranch = useBrowserStore.getState().activeClusterTreeNodeId;
    // Where every clustered panel is (its locus, reference and state key): a
    // panel moved elsewhere meanwhile (Each panel navigates: the main locus
    // doesn't move) must not get the old locus's clusters.
    const runViews = captureRunViews(useBrowserStore.getState(), clusterWindows.map(view => view.result_key));
    const original = useBrowserStore.getState();
    const previewWindows = clusterWindows.map(view => ({ ...view,
      read_ids: displayedScope(original.activeReadIds[view.result_key], view.read_ids
        ?? (hasExplicitFilter ? readIdsMap[view.dataset_id] : undefined)),
    }));
    const preview = original.clusterPreparationCount != null && needsDisplayPreview(previewWindows.map((view, i) => ({
      shown: view.read_ids, full: clusterWindows[i].read_ids ?? (hasExplicitFilter ? readIdsMap[view.dataset_id] : undefined),
    })));
    const progressive = beginProgressiveAnalysis('cluster', clusterWindows.map(view => view.result_key));
    let previewApplied = false;
    setClustering(true);
    try {
      for (const isPreview of preview ? [true, false] : [false]) {
      if (!progressive.current()) return;
      const res = await clusterAllReads(
        requestLocus.chrom, requestLocus.start, requestLocus.end,
        requestPeaks as typeof peakRegions,
        clusterK,
        spanningOnly,
        runDatasetIds,
        clusterMethod,
        hasExplicitFilter ? readIdsMap : undefined,
        analysisSampleCount ?? undefined,
        subnucleosomalThreshold,
        accessibilityThreshold,
        extraChroms,
        analysisSampleSeed,
        clusterFeatureRules,
        isPreview ? previewWindows : useExistingChromPath?undefined:clusterWindows,
        { resolution: original.clusterResolution, panelGenome: runGenome, signal: progressive.signal },
      );

      if (DEBUG && res.timings) {
        console.log('Cluster backend timings:', res.timings);
      }

      const now = useBrowserStore.getState();
      if (runId !== clusterRunRef.current || !progressive.current()) return;  // a newer run replaces this one
      if (now.activeClusterTreeNodeId !== startBranch || now.chrom !== chrom || !runViewsStillCurrent(runViews, now)) {
        report('error','Clustering finished after the branch, chromosome or a clustered panel\'s locus changed, so its results were not applied. Cluster again here.');
        return;
      }

      if (!progressive.commit(() => {
      seedHistoryBaseline(useBrowserStore.getState(), 'Before clustering', 'clustering');

      // Flatten backend results to stateKey -> { readId -> cluster }.
      const resultsByKey: Record<string, Record<string, number>> = {};
      const preparationSamples = { ...now.clusterPreparationSamples };
      useBrowserStore.setState(s => ({ panels: s.panels.map(p => clusterWindows.some(w => w.result_key === (p.stateKey ?? p.datasetId)) ? { ...p, liftGroupByHaplotype: false } : p) }));
      for (const [resultKey, result] of Object.entries(res.results)) {
        const keys=!isPreview&&useExistingChromPath?clusterWindows.filter(view=>(view.chrom===chrom?view.dataset_id:`${view.dataset_id}_${view.chrom}`)===resultKey).map(view=>view.result_key):[resultKey];
        for (const key of keys.length ? keys : [resultKey]) {
          resultsByKey[key] = result.assignments || {};
          const inherited = original.clusterPreparationSamples[key];
          if (isPreview) {
            const view = previewWindows.find(view => view.result_key === key)!;
            preparationSamples[key] = { dataset_id: view.dataset_id, result_key: key,
              chrom: view.chrom, start: view.start, end: view.end, method: 'displayed_reads_v1',
              sample_seed: analysisSampleSeed, target_names: view.read_ids.length,
              selected_names: view.read_ids.length, total_alignments: view.read_ids.length,
              prepared_reads: view.read_ids.length, used: Object.keys(result.assignments || {}).length,
              fingerprint: `display:${runId}:${key}` };
          } else if (result.preparation_sampling) preparationSamples[key] = result.preparation_sampling;
          else if ((subclusterRun || hasExplicitFilter) && inherited) {
            preparationSamples[key] = { ...inherited, used: Object.keys(result.assignments || {}).length };
          }
          else delete preparationSamples[key];
        }
      }

      // Clustering a handful of reads into many clusters looks like a result
      // but isn't one; say so instead of silently producing 1-read clusters.
      const MIN_READS_PER_CLUSTER = 10;
      const needsK = clusterMethod === 'kmeans' || clusterMethod === 'minibatch';
      // Datasets are clustered together, so count the whole fitted population
      // (backend result keys, not duplicate panel aliases).
      const clusteredReads = Object.values(res.results)
        .reduce((total, result) => total + Object.keys(result.assignments ?? {}).length, 0);
      // What was clustered, where (the panels' names), then what was left out and any warning.
      const clusteredPanelConfigs = Object.entries(resultsByKey).filter(([, a]) => Object.keys(a).length > 0)
        .flatMap(([key]) => panels.filter(p => (p.stateKey ?? p.datasetId) === key && p.contentType === 'dataset'));
      const clusteredPanels = [...new Set(clusteredPanelConfigs.map(panel => panelTargetLabel(useBrowserStore.getState(), panel).short))];
      if (!isPreview) {
      report(clusteredReads > 0 ? 'done' : 'error', clusteredReads > 0
        ? `Clustered ${clusteredReads.toLocaleString()} read${clusteredReads === 1 ? '' : 's'}${clusteredPanels.length ? ` in ${clusteredPanels.join(', ')}` : ''} at ${basis.what}`
          + `${basis.unused ? ` (${basis.unused})` : ''}.`
        : 'No reads covered the selected peaks, so nothing was clustered.', clusteredPanelConfigs.map(p => p.id));
      if (res.joint_cohort && clusteredPanelConfigs.some(p => datasets.find(d => d.id === p.datasetId)?.data_type === 'bam_livelift')) {
        const joint = res.joint_cohort;
        report('note', `Joint cohort: ${joint.shared_molecules.toLocaleString()} shared molecules (provenance group + read name); ${joint.policy === 'by_molecule' ? `${joint.removed_rows} duplicate rows removed` : 'native and lifted copies kept'}.`);
        for (const [key, result] of Object.entries(res.results)) if (result.cohort) {
          const c = result.cohort;
          report('note', `${key}: ${Object.keys(result.assignments ?? {}).length} clustered cohort rows; ${c.folded ? 'folding enabled' : 'one row per record/orientation/placement'}. Loaded cohort: ${c.records} records, ${c.supplementary_rows} supplementary rows, ${c.alternative_rows} alternative rows, ${c.excluded_alt} alternatives excluded.`);
        }
      }
      for (const note of scopeNotes) report('note', note);
      const performanceNote = performanceSamplingNote(res.results);
      if (performanceNote) report('note', performanceNote);
      if (needsK && clusteredReads > 0 && clusteredReads < clusterK * MIN_READS_PER_CLUSTER) {
        report('note',
          `Only ${clusteredReads} read${clusteredReads === 1 ? '' : 's'} were clustered into up to ${clusterK} clusters, so the clusters may not be meaningful. `
          + 'Zoom out, turn off "Full-length", or use fewer clusters.',
        );
      }

      }
      if (subclusterRun && !previewApplied) {
        // Ensure a parent node exists to branch from (e.g. clusters loaded from a
        // session before any tree was captured). commitSubcluster then folds
        // non-subset reads into the hidden -1 bucket and leaves the parent intact.
        if (!useBrowserStore.getState().activeClusterTreeNodeId) {
          useBrowserStore.getState().captureActiveClusterTreeNode({ name: 'All reads' });
        }
        const clusterLabel = sourceClusterIds.length > 0
          ? sourceClusterIds.map(cluster => cluster === UNASSIGNED_CLUSTER_ID ? 'Unassigned' : `C${cluster}`).join('+')
          : 'focused';
        useBrowserStore.setState({ clusterPreparationSamples: preparationSamples });
        useBrowserStore.getState().commitSubcluster(resultsByKey, {
          sourceClusterIds,
          sourceLabel: `from ${clusterLabel}`,
          name: `Subcluster ${clusterLabel}`,
          readScope: branchReadScopeForStateKeys(readIdsMap, keyMap),
        });
      } else {
        useBrowserStore.setState({ clusterPreparationSamples: preparationSamples });
        for (const [sk, assigns] of Object.entries(resultsByKey)) {
          const completed = subclusterRun && previewApplied
            ? { ...Object.fromEntries(Object.keys(now.clusterAssignments[sk] ?? {}).map(id => [id, UNASSIGNED_CLUSTER_ID])), ...assigns }
            : assigns;
          useBrowserStore.getState().setClusterAssignments(sk, completed);
          if (subclusterRun && previewApplied) useBrowserStore.setState(current => ({
            clusterFocus: { ...current.clusterFocus, [sk]: new Set(Object.values(assigns).filter(id => id !== UNASSIGNED_CLUSTER_ID)) },
          }));
        }
      }

      // Dynamic-clustering definition mirrors onto the now-active node (the new
      // child for a subcluster run, or the root for a full run). Combinatorial
      // uses binary patterns; other methods (kmeans, etc.) use per-cluster
      // centroids. Either enables dynamic reassignment as the viewport changes.
      if (res.cluster_patterns && clusterMethod === 'combinatorial') {
        useBrowserStore.getState().setClusterPatterns(res.cluster_patterns);
        useBrowserStore.getState().setClusterCentroids({}, []);
        useBrowserStore.getState().setClusterPeakRegions(runPeakRegions);
        useBrowserStore.getState().setDynamicClustering(true);
        lastDynamicClusterRef.current = { chrom, start, end };
      } else if (res.cluster_centroids && Object.keys(res.cluster_centroids).length > 0) {
        useBrowserStore.getState().setClusterPatterns({});
        useBrowserStore.getState().setClusterCentroids(res.cluster_centroids, res.cluster_peak_widths ?? []);
        useBrowserStore.getState().setClusterPeakRegions(runPeakRegions);
        useBrowserStore.getState().setDynamicClustering(true);
        lastDynamicClusterRef.current = { chrom, start, end };
      } else {
        useBrowserStore.getState().setClusterPatterns({});
        useBrowserStore.getState().setClusterCentroids({}, []);
        useBrowserStore.getState().setClusterPeakRegions(runPeakRegions);
        useBrowserStore.getState().setDynamicClustering(false);
      }

      // With each window's view (locus and reference), so its charts use them only there.
      useBrowserStore.getState().setClusterWindowPeaks(windowPeaks ? {
        regions: runPeakRegions,
        byKey: windowPeaks,
        views: Object.fromEntries(clusterWindows.map(view => [view.result_key, { chrom: view.chrom, start: view.start, end: view.end, genome: runGenome ?? null }])),
      } : null);

      // Global dynamic assignment has one chromosome/coordinate scope and no
      // strand. Keep independent-window and one-strand results frozen until an
      // explicit rerun.
      if(panels.some(panel=>(panel.viewportOverride||panel.strand||panel.readSubset)&&panel.datasetId&&datasetIds.includes(panel.datasetId))){
        useBrowserStore.getState().setDynamicClustering(false);
      }

      // A preview remains fixed while the original full scope is refined.
      if (Object.keys(resultsByKey).some(key => preparationSamples[key])) {
        useBrowserStore.getState().setDynamicClustering(false);
      }

      // A full (non-subcluster) run must persist its result into the root node;
      // subcluster runs already created their node atomically above.
      if (!subclusterRun || previewApplied) {
        const afterClusterState = useBrowserStore.getState();
        if (afterClusterState.activeClusterTreeNodeId) {
          afterClusterState.syncActiveClusterTreeNode();
        } else {
          afterClusterState.captureActiveClusterTreeNode({ name: 'All reads' });
        }
      }

      if (DEBUG) console.log('Unified clustering complete:', Object.fromEntries(
        Object.entries(res.results).map(([k, v]) => [k, v.cluster_counts])
      ));

      useBrowserStore.getState().pushSnapshot(`${isPreview ? 'Preview: ' : ''}${clusterRunLabel(clusterMethod, clusterK, original.clusterResolution)}`);
      })) return;
      startBranch = useBrowserStore.getState().activeClusterTreeNodeId;
      if (isPreview) {
        previewApplied = true;
        setClustering(false);
        progressive.refine();
        // Give the preview a paint before starting the full request.
        await new Promise(resolve => setTimeout(resolve, 100));
      } else progressive.complete();
      }
    } catch (err) {
      if (progressive.signal.aborted) return;
      progressive.cancel();
      console.error('Clustering failed:', err);
      if (runId === clusterRunRef.current) report('error', err instanceof Error ? err.message : String(err));
    } finally {
      progressive.dispose();
      if (runId === clusterRunRef.current) setClustering(false);
    }
  }, [chrom, start, end, datasets, selectedDatasets, panels, getSelectedPeakRegions, clusterK, clusterMethod, subnucleosomalThreshold, accessibilityThreshold, spanningOnly, analysisSampleCount, analysisSampleSeed, clusterFeatureRules]);

  // Run-cluster bridge: the Copilot apply_cluster_rule action switches the
  // cluster mode then fires fiberhmm:run-cluster to actually run clustering —
  // the same thing clicking "Cluster Reads" (handleCluster) does. The listener
  // was lost in the v2.11 cluster refactor, leaving apply_cluster_rule a no-op;
  // re-wire it here, next to the rescan-rule handler, via a ref to dodge stale
  // closures over handleCluster.
  const handleClusterRef = useRef(handleCluster);
  useEffect(() => { handleClusterRef.current = handleCluster; }, [handleCluster]);
  useEffect(() => {
    const handler = () => { void handleClusterRef.current(); };
    window.addEventListener('fiberhmm:run-cluster', handler);
    registerClusterRunner(() => handleClusterRef.current());
    return () => {
      window.removeEventListener('fiberhmm:run-cluster', handler);
      registerClusterRunner(null);
    };
  }, []);

  const [sorting, setSorting] = useState(false);

  // Each sort takes a number; a newer sort supersedes a pending one.
  // Unified sort handler
  const handleSort = useCallback(async (
    sortBy: string,
    rule?: import('../types').ColorRule,
    analysisSortRule?: AnalysisSortRule,
    options?: { preserveClusterOrder?: boolean },
  ) => {
    const request = nextSortRequest();
    const sortRun = beginRun('sort');
    const reportSort = (tone: 'error' | 'note' | 'done', text: string) => setRunResult('sort', { tone, text, alwaysShow: tone === 'note' }, sortRun);
    const branch = useBrowserStore.getState().activeClusterTreeNodeId ?? null;
    // A late answer for another branch or sort doesn't apply; a view whose
    // panels moved meanwhile (checked per view below) neither.
    const superseded = () => {
      if (!isCurrentSortRequest(request)) return true;
      if ((useBrowserStore.getState().activeClusterTreeNodeId ?? null) !== branch) {
        reportSort('error', 'The cluster branch changed while sorting. Sort again on the current branch.');
        return true;
      }
      return false;
    };

    // Only shown read panels are targets; a split's collapsed source stays untouched. A member folded into a shown
    // graph counts as shown (its sub-band is in the host's graph; the band orders its rows by this sort).
    const targetPanels = panels.filter(p => !p.collapsed || foldedInShownGraph(p, panels));
    const keyMap = getStateKeyMap(selectedDatasets, targetPanels, []);
    const datasetIds = Object.keys(keyMap);
    // Each target panel is sorted at its own locus and reference.
    const stateKeyToDs: Record<string, string> = {};
    for (const dsId of datasetIds) for (const sk of (keyMap[dsId]?.length ? keyMap[dsId] : [dsId])) stateKeyToDs[sk] = dsId;
    const groups = sortViewGroups({
      stateKeys: Object.keys(stateKeyToDs),
      stateKeyToDs,
      panels: targetPanels,
      main: { chrom, start, end },
      rule: analysisSortRule,
      allPeaks: useBrowserStore.getState().getAllPeaks(),
      selectedPeaks,
      peakModes,
      selectedGenes,
    });
    if (groups.length === 0) {
      reportSort('error', 'Choose a read panel to sort.');
      return;
    }

    // Parse layer-aware sort encoding: "occupancy@<layer>".
    // Plain values (similarity, rule, etc.) pass through unchanged.
    let backendSortBy = sortBy;
    let sortLayer: string | undefined;
    let sortRulePayload: RuleTermPayload | undefined;
    let sortDescending = true;
    let sortTranscriptionState: TranscriptionStateRuleKind | null = null;
    let sortGeneIds: string[] | undefined;
    let sortMoleculeMetric: string | undefined;
    let sortFeatureHub: FeatureHubRequest | undefined;
    if (analysisSortRule) {
      const term = analysisSortRule.terms[0];
      const problem = analysisRuleTermProblem(term);
      if (problem) {
        reportSort('error', `Sort rule "${analysisSortRule.name}" ${problem}.`);
        return;
      }
      sortTranscriptionState = transcriptionStateFromTerm(term);
      sortGeneIds = sortTranscriptionState ? geneIdsForAnalysisRule(analysisSortRule) : undefined;
      if (sortTranscriptionState && (!sortGeneIds || sortGeneIds.length === 0)) {
        reportSort('error', `Sort rule "${analysisSortRule.name}" needs a selected gene.`);
        return;
      }
      if (groups.every(group => group.windows.length === 0)) {
        reportSort('error', `Sort rule "${analysisSortRule.name}" has no regions in scope.`);
        return;
      }
      sortLayer = layerFromSortTerm(term) ?? undefined;
      sortDescending = analysisSortRule.descending;
      // Molecule metric and hub hit terms read no layer.
      const layerFree = sortRuleRequestFields(analysisSortRule);
      if (sortTranscriptionState) {
        backendSortBy = 'transcription_state';
        sortLayer = undefined;
        sortRulePayload = undefined;
      } else if (layerFree) {
        backendSortBy = layerFree.sortBy;
        sortLayer = undefined;
        sortRulePayload = undefined;
        if (layerFree.sortBy === 'value') sortMoleculeMetric = layerFree.moleculeMetric;
        else sortFeatureHub = layerFree.featureHub;
      } else if (analysisSortRule.metric === 'count' || analysisSortRule.metric === 'value') {
        // ('value' belongs to molecule metrics: a layer term saved with it counts.)
        backendSortBy = 'rule';
        sortRulePayload = rulePayloadFromSortTerm(term);
      } else {
        backendSortBy = analysisSortRule.metric === 'rate'
          ? 'fp_rate'
          : analysisSortRule.metric;
      }
    }
    if (sortBy.includes('@')) {
      const atIdx = sortBy.indexOf('@');
      backendSortBy = sortBy.slice(0, atIdx);
      const clusteringMode = sortBy.slice(atIdx + 1);
      // Map clustering mode IDs → actual layer names the backend recognizes.
      // 'accessibility' isn't a layer — resolve to msp when present, else let
      // the backend fall through to primary intervals by passing undefined.
      if (clusteringMode === 'accessibility') {
        sortLayer = datasets.some(d => d.available_layers?.msp) ? 'msp' : undefined;
        if (!sortLayer) backendSortBy = 'accessibility';
      } else {
        sortLayer = clusteringMode;
      }
    }

    const initial = useBrowserStore.getState();
    let expected = initial;
    const changedPanels = new Set<string>();
    const progressive = beginProgressiveAnalysis('sort', Object.keys(stateKeyToDs));
    // Similarity/projection order cluster centroids or a shared map, whose
    // definition must use the complete fitted cohort.
    const preview = !['similarity', 'projection'].includes(backendSortBy)
      && Object.keys(stateKeyToDs).some(key => initial.activeReadIds[key]?.length);
    // Where each view's panels are when Sort is asked (before any request, preview or full): checked again just
    // before each round's orders are applied, so a panel moved during the preview gets neither.
    const sentViews = groups.map(group => captureRunViews(initial, Object.values(group.stateKeysByDataset).flat()));
    setSorting(true);
    try {
      for (const isPreview of preview ? [true, false] : [false]) {
      if (!progressive.current()) return;
      const results: Array<{
        stateKey: string; scoped: boolean;
        result: { cluster_order?: number[]; read_sort_order?: string[]; no_op_reason?: string };
      }> = [];
      const panelReadIds = Object.fromEntries(sharedClusterWindows({ ...initial, selectedDatasets: new Set() }, datasetIds)
        .filter(w => w.read_ids !== undefined).map(w => [w.result_key, w.read_ids!]));
      const resultViews: number[] = [];
      let responseError = false;
      for (const [groupIndex, group] of groups.entries()) {
        // A rule with no region in this view: nothing to sort here.
        if (analysisSortRule && group.windows.length === 0) continue;
        // FirePeak start/end are absolute genomic coordinates; the backend compares against absolute read midpoints.
        const groupPeakRegions = group.peaks.map(p => [p.start, p.end]);
        const scopeWindows = analysisSortRule ? group.windows : selectedPeakWindowsForSort(group.peaks, selectedPeaks);
        for (const round of sortRounds(group.datasetIds, group.stateKeysByDataset)) {
          const roundIds = Object.keys(round);
          const sortState = initial;
          const sentAssignments = Object.fromEntries(roundIds.map(id => [id, sortState.clusterAssignments[round[id]]]));
          const { readIds: sortReadIds, clusterAssignments: sortClusterAssignments } = resolveSortRequestScope({
            datasetIds: roundIds,
            sortKeyMap: Object.fromEntries(roundIds.map(id => [id, [round[id]]])),
            clusterAssignments: sortState.clusterAssignments,
            selectedClusters: sortState.selectedClusters,
            clusterFocus: sortState.clusterFocus,
            filteredReadIds: sortState.filteredReadIds,
            activeClusterTreeNodeId: sortState.activeClusterTreeNodeId,
            clusterTreeNodes: sortState.clusterTreeNodes,
            panelReadIds,
          });
          if (isPreview) {
            const full = { ...sortReadIds };
            for (const id of roundIds) sortReadIds[id] = displayedScope(initial.activeReadIds[round[id]], sortReadIds[id]);
            // The display already holds the round's whole scope (e.g. a split panel's frozen reads): only the full
            // request, not the same reads sorted twice.
            if (roundIds.every(id => full[id] !== undefined && new Set(full[id]).size === sortReadIds[id].length)) continue;
          }
          // A split lifted panel sorts its own haplotype's rows (one state key per dataset in a round).
          const liftHapByDataset = liftHapsForRound(round, targetPanels);
          const res = await sortReads(group.chrom, group.start, group.end, spanningOnly, roundIds, backendSortBy, {
            ...(Object.keys(liftHapByDataset).length ? { liftHapByDataset } : {}),
            rule: sortRulePayload ?? (rule ? {
              size_min: rule.sizeMin, size_max: rule.sizeMax, conditions: rule.conditions,
              quality_gates: qualityGatesPayload(rule.qualityGates),
              ...nucConditionsPayload(rule),
            } : undefined),
            descending: sortDescending,
            moleculeMetric: sortMoleculeMetric,
            featureHub: sortFeatureHub,
            linked: isLinkedGroup(roundIds, panels.filter(p => round[p.datasetId ?? ''] === (p.stateKey ?? p.datasetId))),
            // (Similarity after a graph run: the run's regions, which the datasets do not hold; graph features review.)
            peakRegions: backendSortBy === 'similarity' && !sortState.clusterPeakRegions.length && sortState.clusterMatchedRun?.graph?.regions?.length
              ? sortState.clusterMatchedRun.graph.regions.map(r => [r.start, r.end])
              : groupPeakRegions.length > 0 ? groupPeakRegions : undefined,
            selectedPeakWindows: scopeWindows,
            layer: sortLayer,
            transcriptionState: sortTranscriptionState,
            geneIds: sortGeneIds,
            readIds: Object.keys(sortReadIds).length > 0 ? sortReadIds : undefined,
            clusterAssignments: Object.keys(sortClusterAssignments).length > 0 ? sortClusterAssignments : undefined,
            sampleSeed: analysisSampleSeed,
            signal: progressive.signal,
            // The Projection tab's map: the clustering's peaks (this view's own
            // matched peaks for a run over several loci), rules and threshold.
            projection: backendSortBy === 'projection' ? {
              // (A graph run keeps its regions in the run, not in clusterPeakRegions; graph features review.)
              peakRegions: clusterChartRunPeaks(sortState.clusterPeakRegions.length ? sortState.clusterPeakRegions
                : (sortState.clusterMatchedRun?.graph?.regions ?? []), sortState.clusterWindowPeaks, roundIds.map(id => round[id]),
                { chrom: group.chrom, start: group.start, end: group.end, genome: group.genome ?? null }, chrom)
                .map(p => ({ start: p.start, end: p.end, mode: p.mode || 'accessibility' })),
              clusterFeatureRules: sortState.clusterFeatureRules,
              subnucleosomalThreshold: sortState.subnucleosomalThreshold,
              // The map is of every clustered read (as the Projection tab draws it),
              // even when only selected or focused clusters are sorted.
              clusterAssignments: Object.fromEntries(Object.entries(sentAssignments)
                .filter((entry): entry is [string, Record<string, number>] => !!entry[1])),
            } : undefined,
            // A panel on another assembly: its reference (chromosomes, genes).
            panelGenome: group.genome ?? null,
          });
          if (superseded() || !progressive.current()) return;
          if (res.error) { responseError = true; reportSort('error', res.error); continue; }
          for (const [dsId, result] of Object.entries(res.results)) {
            if (round[dsId]) {
              results.push({ stateKey: round[dsId], scoped: sortReadIds[dsId] !== undefined, result });
              resultViews.push(groupIndex);
            }
          }
        }
      }

      if (superseded() || !progressive.current()) return;
      // No preview request was needed: straight to the full sort.
      if (isPreview && results.length === 0 && !responseError) continue;
      // Only the orders for panels still showing the view they were asked for
      // (a panel moved meanwhile, even while another view was being sorted,
      // keeps its order) and still for the clusters they were computed on
      // (reclustered, merged or restored meanwhile: they are for other clusters).
      const nowState = useBrowserStore.getState();
      const shown = sentViews.map(views => runViewsStillCurrent(views, nowState));
      const movedViews = shown.filter(ok => !ok).length;
      const applicable = results.filter(({ stateKey }, i) => runViewsStillCurrent(sentViews[resultViews[i]].filter(view => view.stateKey === stateKey), nowState)
        && sortStateStillCurrent(expected, nowState, stateKey));
      if (applicable.length < results.length) {
        reportSort(applicable.length ? 'note' : 'error', movedViews > 0
          ? 'The sort finished after the panels it was for moved, so it was not applied there. Sort again here.'
          : 'The clusters, filters or read order changed while sorting, so it was not applied there. Sort again.');
      }
      if (applicable.length === 0) {
        if (results.length === 0 && !responseError) reportSort('error', 'No reads to sort in the target panels. Check the region and filters.');
        return;
      }
      const updates = applicable.flatMap(({ stateKey: sk, scoped, result }) => {
        if (result.no_op_reason) {
          if (!isPreview) reportSort('note', result.no_op_reason);
          return [];
        }
        if (!result.read_sort_order?.length && !result.cluster_order?.length) {
          if (!isPreview) reportSort('error', 'No reads to sort in the target panels. Check the region and filters.');
          return [];
        }
        const oldClusters = nowState.clusterOrder[sk] ?? [];
        const order = options?.preserveClusterOrder || !result.cluster_order?.length ? oldClusters
          : mergeScopedSortOrder(oldClusters, result.cluster_order, scoped);
        const oldReads = nowState.readSortOrder[sk] ?? [];
        // Similarity only orders clusters; keep the order within each cluster.
        const reads = result.read_sort_order?.length
          ? mergeScopedSortOrder(oldReads, result.read_sort_order, scoped) : oldReads;
        const same = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((v, i) => v === b[i]);
        if (same(order, oldClusters) && same(reads, oldReads) && !nowState.jupyterReadOrder[sk]?.length) return [];
        return [{ sk, order, reads }];
      });
      if (updates.length === 0 && !isPreview) {
        progressive.complete();
        if (changedPanels.size) {
          reportSort('done', `Sorted the full active subset in ${changedPanels.size} panel${changedPanels.size === 1 ? '' : 's'}.`);
          return;
        }
        if (applicable.every(({ result }) => !result.no_op_reason && (result.cluster_order?.length || result.read_sort_order?.length))) {
          reportSort('note', options?.preserveClusterOrder && backendSortBy === 'similarity'
            ? 'Cluster order is locked. Unlock it to sort by similarity.' : 'Reads are already in this order.');
        }
        return;
      }
      if (!isPreview && updates.every(({ sk, order, reads }) => (nowState.activeReadIds[sk]?.length ?? 0) > 1
        && !sortMovesVisibleReads(nowState.activeReadIds[sk], reads, order, nowState.clusterAssignments[sk] ?? {}))) {
        reportSort('note', 'The displayed reads are already in this order.');
      }
      if (!progressive.commit(() => {
      if (updates.length) {
      seedHistoryBaseline(useBrowserStore.getState(), 'Before sorting', 'sorting');
      for (const { sk, order, reads } of updates) {
        changedPanels.add(sk);
        useBrowserStore.getState().setClusterOrder(sk, order);
        useBrowserStore.getState().setReadSortOrder(sk, reads);
        // An explicit toolbar sort takes over from an imported read order.
        useBrowserStore.setState(s => ({ jupyterReadOrder: { ...s.jupyterReadOrder, [sk]: [] } }));
      }

      if (!isPreview) reportSort('done', `Sorted the full active subset in ${changedPanels.size} panel${changedPanels.size === 1 ? '' : 's'}.`);
      // The Sort selector shows this choice again after Undo or a reopened session.
      useBrowserStore.setState({ sortSelection: rule ? `rule:${rule.id}` : sortBy });
      useBrowserStore.getState().pushSnapshot(`${isPreview ? 'Preview: ' : ''}Sort by ${analysisSortRule?.name || sortBy}`);
      }
      })) return;
      expected = useBrowserStore.getState();
      if (isPreview) {
        setSorting(false);
        progressive.refine();
        await new Promise(resolve => setTimeout(resolve, 100));
      } else progressive.complete();
      }
    } catch (err) {
      if (!isCurrentSortRequest(request) || progressive.signal.aborted) return;
      progressive.cancel();
      console.error('Sort failed:', err);
      reportSort('error', `Sort failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      progressive.dispose();
      if (isCurrentSortRequest(request)) setSorting(false);
    }
  }, [chrom, start, end, datasets, selectedDatasets, panels, spanningOnly,
      selectedPeaks, peakModes, selectedGenes, analysisSampleSeed, layerFromSortTerm, rulePayloadFromSortTerm,
      transcriptionStateFromTerm, geneIdsForAnalysisRule]);

  const handleFilter = useCallback(async (analysisFilterRule: AnalysisFilterRule) => {
    if (datasets.length === 0) return;
    const request = nextFilterRequest();
    const filterRun = beginRun('filter');
    const reportFilter = (tone: 'error' | 'note' | 'done', text: string, panelIds?: string[]) =>
      setRunResult('filter', { tone, text, ...(panelIds?.length ? { panelIds } : {}) }, filterRun);

    const datasetIds = getTargetDatasetIds(selectedDatasets, panels, datasets);
    if (datasetIds.length === 0) return;

    // Each target panel is filtered at the region it shows: panels at their own
    // locus get their own request, with the rule's scope resolved there.
    const keyMap = getStateKeyMap(selectedDatasets, panels, datasets);
    const stateKeyToDs: Record<string, string> = {};
    for (const dsId of datasetIds) for (const sk of (keyMap[dsId] ?? [dsId])) stateKeyToDs[sk] = dsId;
    const main = { chrom, start, end };
    const groups = filterRegionGroups({
      stateKeys: Object.keys(stateKeyToDs),
      stateKeyToDs,
      panels,
      main,
      rule: analysisFilterRule,
      // FirePeak start/end are absolute genomic coordinates; the backend compares against absolute read midpoints.
      allPeaks: useBrowserStore.getState().getAllPeaks(),
      selectedPeaks,
      peakModes,
      selectedGenes,
    }).filter(group => group.windows.length > 0);
    if (groups.length === 0) {
      reportFilter('error', `Filter rule "${analysisFilterRule.name}" has no regions in scope.`);
      return;
    }

    const term = analysisFilterRule.terms[0];
    const problem = analysisRuleTermProblem(term);
    if (problem) {
      reportFilter('error', `Filter rule "${analysisFilterRule.name}" ${problem}.`);
      return;
    }
    const transcriptionState = transcriptionStateFromTerm(term);
    const geneIds = transcriptionState ? geneIdsForAnalysisRule(analysisFilterRule) : undefined;
    if (transcriptionState && (!geneIds || geneIds.length === 0)) {
      reportFilter('error', `Filter rule "${analysisFilterRule.name}" needs a selected gene.`);
      return;
    }
    // Molecule metric ('value', between) and hub hit terms read no layer and send no size rule.
    const fields = filterRuleRequestFields(analysisFilterRule);
    const sortLayer = transcriptionState || fields.layerFree ? undefined : layerFromSortTerm(term) ?? undefined;
    const rulePayload = !fields.layerFree && fields.metric === 'count'
      ? rulePayloadFromSortTerm(term)
      : undefined;
    const combine = analysisFilterRule.combine === 'and';

    try {
      const responses = await Promise.all(groups.map(group => filterReadsByAnalysisRule(
        group.chrom, group.start, group.end, spanningOnly, group.datasetIds, {
        metric: fields.metric,
        operator: fields.operator,
        threshold: fields.threshold,
        thresholdMax: fields.thresholdMax,
        moleculeMetric: fields.moleculeMetric,
        featureHub: fields.featureHub,
        rule: rulePayload,
        peakRegions: group.peakRegions.length > 0 ? group.peakRegions : undefined,
        scopeWindows: group.windows,
        layer: sortLayer,
        transcriptionState,
        geneIds,
        sampleSeed: analysisSampleSeed,
        // A panel on another assembly: its genes and chromosomes.
        panelGenome: group.genome ?? null,
      })));

      // Superseded, or the view moved on (navigation clears filters): these read
      // IDs describe the old region and would hide valid reads here.
      // Each group is checked against where its panels are now (the main
      // locus for those following it): in Each panel navigates the main locus
      // doesn't move, and a panel moved meanwhile keeps its own reads.
      const now = useBrowserStore.getState();
      if (!isCurrentFilterRequest(request)) return;
      const shown = groups.map(group => groupStillShown(group, now.panels, { chrom: now.chrom, start: now.start, end: now.end }));
      if (!shown.some(Boolean)) return;
      seedHistoryBaseline(useBrowserStore.getState(), 'Before read filter', 'filtering');
      let kept = 0, total = 0;
      const filteredKeys = new Set<string>();
      groups.forEach((group, i) => {
        if (!shown[i]) return;
        for (const [dsId, result] of Object.entries(responses[i].results)) {
          for (const sk of (group.stateKeysByDataset[dsId] ?? [])) {
            filteredKeys.add(sk);
            // 'and': only the reads the panel's current filter keeps too (no filter: all of them).
            const current = combine ? now.filteredReadIds[sk] : null;
            const ids = intersectWithCurrentFilter(result.read_ids, current);
            useBrowserStore.getState().setFilteredReadIds(sk, ids, {
              target: 'analysis-filter',
              label: analysisFilterLabel(analysisFilterRule.name, current ? now.readFilterSources[sk] ?? {} : null),
            });
            if (combine) {
              kept += ids.size;
              total += current ? current.size : result.total ?? 0;
            }
          }
          if (combine) continue;
          kept += result.filtered ?? result.read_ids.length;
          total += result.total ?? 0;
          if (DEBUG) console.log(`Filtered ${dsId} at ${group.chrom}:${group.start}-${group.end}: ${analysisFilterRule.name}, reads=${result.filtered}/${result.total}`);
        }
      });

      useBrowserStore.getState().setFootprintFilterKey(null);
      useBrowserStore.getState().pushSnapshot(`Filter by ${analysisFilterRule.name}`);
      const filterName = combine ? `${analysisFilterRule.name} (within the current filter)` : analysisFilterRule.name;
      reportFilter(kept > 0 ? 'done' : 'note', total > 0
        ? `${filterName}: kept ${formatShare(kept, total, 'reads', { pct: true })}.`
        : `${filterName}: applied.`,
      // The panels it filtered (not the ones skipped or moved meanwhile): the line says so once they have closed.
      now.panels.filter(p => p.contentType === 'dataset' && filteredKeys.has((p.stateKey ?? p.datasetId)!)).map(p => p.id));
    } catch (err) {
      if (!isCurrentFilterRequest(request)) return;
      console.error('Analysis filter failed:', err);
      reportFilter('error', `Filter failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [analysisSampleSeed, chrom, datasets, end, geneIdsForAnalysisRule, layerFromSortTerm, panels, peakModes, rulePayloadFromSortTerm, selectedDatasets, selectedGenes, selectedPeaks, spanningOnly, start, transcriptionStateFromTerm]);

  const handleClearFilter = useCallback(() => {
    // Supersedes pending filters, the UI's and Copilot's alike.
    invalidateFilterRequests();
    const datasetIds = getTargetDatasetIds(selectedDatasets, panels, datasets);
    const keyMap = getStateKeyMap(selectedDatasets, panels, datasets);
    const state = useBrowserStore.getState();
    const hasFilter = datasetIds.some(dsId =>
      // An applied filter that matched nothing (an empty set) is still one to clear.
      (keyMap[dsId] ?? [dsId]).some(sk => state.filteredReadIds[sk] != null)
    );
    if (!hasFilter && !state.footprintFilterKey) return;
    seedHistoryBaseline(state, 'Before clearing read filter', 'filtering');
    for (const dsId of datasetIds) {
      for (const sk of (keyMap[dsId] ?? [dsId])) {
        useBrowserStore.getState().setFilteredReadIds(sk, null);
      }
    }
    useBrowserStore.getState().setFootprintFilterKey(null);
    useBrowserStore.getState().pushSnapshot('Clear read filter');
  }, [datasets, panels, selectedDatasets]);

  // Autozoom - find optimal window with most spanning reads
  const handleAutozoom = useCallback(async () => {
    if (datasets.length === 0) return;

    const datasetIds = getTargetDatasetIds(selectedDatasets, panels, datasets);

    try {
      useBrowserStore.getState().setLoading(true);
      const res = await autozoom(
        chrom, start, end,
        spanningOnly,
        datasetIds,
        autozoomDistance,
        5
      );

      if (res.success && res.start !== undefined && res.end !== undefined) {
        if (DEBUG) console.log(`Autozoom: ${res.chrom}:${res.start}-${res.end} (${res.spanning_reads} spanning reads)`);
        useBrowserStore.getState().setViewport(res.chrom || chrom, res.start, res.end);
      } else {
        if (DEBUG) console.log(`Autozoom failed: ${res.message || 'Unknown error'}`);
        useBrowserStore.getState().setError(res.message || 'No optimal window found');
      }
    } catch (err) {
      console.error('Autozoom failed:', err);
      useBrowserStore.getState().setError('Autozoom failed');
    } finally {
      useBrowserStore.getState().setLoading(false);
    }
  }, [chrom, start, end, datasets, selectedDatasets, panels, spanningOnly, autozoomDistance]);

  // The command bus (menu bar, command palette): the sidebar's Autozoom and Copy Link, the Filter group's Clear.
  useAppCommand('autozoom', () => { if (datasets.length === 0) return false; void handleAutozoom(); return true; });
  useAppCommand('copy-link', () => { handleCopyLink(); return true; });
  useAppCommand('clear-read-filter', () => { handleClearFilter(); return true; });

  // Analysis panels are opened explicitly: Cmd+click on target element, or via sidebar.
  // No auto-open effects — they were too disruptive.

  // Pending cluster restore — apply saved clustering after cross-viewport navigation
  const pendingClusterRestore = useBrowserStore(s => s.pendingClusterRestore);
  useEffect(() => {
    if (!pendingClusterRestore || loading) return;
    const state = useBrowserStore.getState();
    const saved = state.savedClusters.find(sc => sc.id === pendingClusterRestore);
    if (!saved) {
      state.setPendingClusterRestore(null);
      return;
    }
    // Wait for reads to be loaded (at least one dataset has activeReadIds)
    const hasLoaded = Object.values(state.activeReadIds).some(ids => ids.length > 0);
    if (!hasLoaded) return;

    // Remap datasetId → stateKey(s) (each panel's own result where saved) and apply
    const { assignments: newAssignments, order: newOrder } = savedClusterStateForPanels(saved, state);

    const customRuleId = state.getCustomRuleId();
    const restoredCustomPeaks = saved.customPeaks.map((p, i) => ({
      start: p.start, end: p.end, index: 0, layer: 0, isCustom: true as const,
      ...(p.chrom ? { chrom: p.chrom } : {}),
    }));

    // Write custom peaks through the peaksByRule system
    state.setPeaksByRule(customRuleId, restoredCustomPeaks);

    useBrowserStore.setState({
      ...restoredClusteringState(saved, useBrowserStore.getState(), newAssignments),
      clusterAssignments: newAssignments,
      clusterOrder: newOrder,
      clusterPatterns: saved.patterns,
      clusterPeakRegions: saved.peakRegions,
      clusterWindowPeaks: saved.windowPeaks ?? null,
      selectedPeaks: new Set(saved.selectedPeakIndices),
      peakModes: saved.peakModes as Record<number, any>,
      clusterMethod: saved.clusterMethod,
      clusterK: saved.clusterK,
      clusterResolution: saved.clusterResolution ?? 1,
      subnucleosomalThreshold: saved.subnucleosomalThreshold,
      accessibilityThreshold: saved.accessibilityThreshold,
      pendingClusterRestore: null,
    } as any);
    // An undo step of its own (Redo after Undo brings the clusters back too).
    useBrowserStore.getState().pushSnapshot(`Restore clustering ${saved.name}`, { kind: 'clustering' });
  }, [pendingClusterRestore, loading, activeReadIds]);

  return (
    <div
      data-browser-root
      className="h-full flex flex-col relative overflow-y-auto"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-50 bg-blue-500/10 border-4 border-dashed border-blue-500 rounded-lg flex items-center justify-center pointer-events-none">
          <div className="bg-white dark:bg-gray-800 rounded-xl px-8 py-6 shadow-xl text-center">
            <div className="text-3xl mb-2 text-blue-500">
              <svg xmlns="http://www.w3.org/2000/svg" className="inline h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <div className="text-lg font-semibold text-gray-700 dark:text-gray-200">Drop files to load</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">BAM, BigBed, BigWig, BED, GTF, GFF3, cool/mcool, or a saved session (.json)</div>
          </div>
        </div>
      )}
      {/* Crash recovery banner — disabled in public mode (no session save) */}
      {!publicMode && !isSandboxPage() && <CrashRecoveryBanner />}
      {!isRenderMode && <GenomeMismatchBanner />}
      {!isRenderMode && <PreviewSessionPrompt />}
      {!publicMode && !isRenderMode && !isSandboxPage() && <DafRunHost />}
      {!publicMode && !isRenderMode && !isSandboxPage() && <LibraryHost />}
      {!isRenderMode && <RegionsHost />}
      {/* A tour tab: its own sandbox session */}
      {(isSandboxPage() || isWorkspacePage()) && !isRenderMode && <SandboxBanner />}

      {/* Row 1: NavBar — search + zoom + utilities. Figure renders show only the tracks. */}
      {!isRenderMode && (<>
      <div data-testid="scaled-main-controls" style={{ zoom: chromeZoom }} className="shrink-0">
      <NavBar
        loading={loading}
        scanning={scanning}
        clustering={clustering}
        onExport={openExportFigure}
        onExportData={openExportData}
        onShowShortcuts={() => setShowShortcuts(true)}
        history={<HistoryQuickControls />}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1" data-toolbar-set="navigation">
          <NavigationModeToggle />
          {/* Each panel navigates: the main locus controls are off (each panel has its own). */}
          <fieldset
            disabled={perPanelNavigation}
            className={`contents${perPanelNavigation ? ' [&>*]:opacity-40' : ''}`}
            data-testid="main-navigation-controls"
            aria-describedby={perPanelNavigation ? 'per-panel-nav-reason' : undefined}
          >
          {perPanelNavigation && <span id="per-panel-nav-reason" className="sr-only">{PER_PANEL_NAV_REASON}</span>}
          <ChromSelector />
          <button
            onClick={() => useBrowserStore.getState().toggleGenomeOverview()}
            className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] transition-colors ${showGenomeOverview ? 'text-blue-600 bg-blue-500/10 dark:text-blue-300' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10'}`}
            title={`${showGenomeOverview ? 'Hide' : 'Show'} genome map (G)`}
            aria-label={`${showGenomeOverview ? 'Hide' : 'Show'} genome map`}
            aria-pressed={showGenomeOverview}
            data-testid="coverage-map-toggle"
          >
            <BarChart size={13} />
            <span className="hidden min-[1700px]:inline">Genome map</span>
          </button>
          <SmartSearchInput disabled={perPanelNavigation} disabledReason={PER_PANEL_NAV_REASON} />
          <ZoomControls />
          </fieldset>
          <ViewToggles navDisabled={perPanelNavigation} />
        </div>
      </NavBar>

      {/* Optional chromosome-wide coverage navigation. Off reserves no space. */}
      {showGenomeOverview && <GenomeOverview />}

      {/* Row 2: Operations toolbar — read/display layers, clustering, datasets. */}
      <div
        className="relative z-[35] bg-white/85 dark:bg-dark-bg/85 backdrop-blur-[20px] border-b border-line/80 dark:border-white/10 px-1.5 pb-1 pt-0.5 sm:px-2 shadow-toolbar dark:shadow-toolbar-dark"
        data-testid="operations-toolbar"
      >
        <div className="flex items-start gap-2">
          <ClusterPanel
            onCluster={handleCluster}
            onSort={handleSort}
            sorting={sorting}
            onFilter={handleFilter}
            onClearFilter={handleClearFilter}
            onScanPeaks={handleScanPeaks}
            scanning={scanning}
            scanNote={scanStopped}
            clustering={clustering}
          />

          {/* Layout / Equal widths and Tour sit at the right of the analysis strip,
              keyboard shortcuts and Reset view with the toolbar's utility icons,
              so this row holds only the read tools. */}
        </div>
      </div>

      </div>

      </>)}

      {!isRenderMode && <AnalysisProgressLine />}
      {!isRenderMode && <RunResultLines />}

      {error && !isRenderMode && (
        <div className="flex items-start gap-3 border-b border-red-300 bg-red-100 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
          <div className="min-w-0 flex-1 whitespace-pre-line">{error}</div>
          <button
            type="button"
            onClick={() => setBrowserError(null)}
            className="shrink-0 rounded p-0.5 text-red-500 hover:bg-red-200/60 dark:text-red-300 dark:hover:bg-red-950/40"
            aria-label="Dismiss error"
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-[240px] overflow-hidden relative flex flex-row" data-testid="tracks-region">
        <div className="flex-1 overflow-hidden relative bg-white">
          <TrackContainer
            onScanPeaks={handleScanPeaks}
            scanning={scanning}
          />
        </div>

        {!isRenderMode && <Sidebar
          onExport={openExportFigure}
          onCopyLink={handleCopyLink}
          linkCopied={linkCopied}
          onAutozoom={handleAutozoom}
        />}
      </div>

      {/* Export Panel Modal */}
      {showExportPanel && (
        <ExportPanel onClose={() => setShowExportPanel(false)} />
      )}
      {showExportDataDialog && (
        <ExportDataDialog onClose={() => setShowExportDataDialog(false)} />
      )}

      {/* Keyboard Shortcuts Modal */}
      <KeyboardShortcutsModal open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      {/* The command palette (⌘K / Ctrl+K): every action, panel and setting, and Go to a locus or gene. */}
      {!isRenderMode && <CommandPaletteHost />}
      {!isRenderMode && <SplitPanelsDialogHost />}
      {/* Plugin packs' background hooks and dialogs (plugins/browserHosts.tsx). */}
      <BrowserHosts renderMode={Boolean(isRenderMode)} />
      {!publicMode && <ServerFileBrowserHost />}
      {!publicMode && <SessionRestoreHost />}
      {!publicMode && !isLabServerPage() && <ConnectClusterHost />}
    </div>
  );
}
