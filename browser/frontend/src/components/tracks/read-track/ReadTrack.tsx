import { splitAway, splitPinnedAway } from '../../../utils/splitLocus';
import { useLiftCorrespondence } from '../../../features/liveLift/useLiftCorrespondence';
import { isBamBacked } from '../../../utils/datasetKinds';
import { markReadViewDrawn } from '../../../utils/viewIdle';
import { SplitAwayBanner } from './SplitAwayBanner';
import { useRef, useEffect, useLayoutEffect, useMemo, useCallback, useState } from 'react';
import { usePanelDisplayStore as useBrowserStore } from '../../../hooks/usePanelDisplayStore';
import { annotationViewportKey, type ReadAnnotation } from '../../../stores/annotationSlice';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { relatedFamilyRefs } from '../../../utils/consensusTrack';
import { useNativeLattice } from '../../../hooks/useNativeLattice';
import { useEphemeralStore } from '../../../stores/ephemeralStore';
import { useShallow } from 'zustand/react/shallow';
import { DEBUG } from '../../../stores/utils';
import { buildRuleMatchContext, getMatchingRuleId, hydrateOrthogonalTracks, peaksForPanelChrom, rulesNeedOrthogonalTrackData } from '../../../utils/ruleMatching';
import type { Props, CompactRead, ReadsResponse, SvSummary } from './types';
import type { DatasetProfile, OrthogonalTrackViewportData } from '../../../types/dataset';
import type { FirePeak } from '../../../types';
import { EMPTY_OBJECT, EMPTY_STRING_ARRAY, EMPTY_NUMBER_ARRAY, SIDEBAR_WIDTH, getClusterColor } from './constants';
import { makeDataViewportKey, readFilterFitsRequest, useReadTrackData } from './useReadTrackData';
import { useReadTrackMouse } from './useReadTrackMouse';
import { useLiveLiftAxis } from '../../../features/liveLift/useLiveLiftAxis';
import { ExpansionOverlay, DifferenceGuide } from '../../../features/liveLift/ExpansionOverlay';
import { ReadTrackActions } from './ReadTrackActions';
import { useReadActionsStore } from '../../../stores/readActionsStore';
import { drawReadTrack } from './ReadTrackCanvas';
import { ReadTooltip, ClusterTooltip } from './ReadTrackTooltip';
import { SvTooltip } from './SvTooltip';
import { SV_BAND_HEIGHT, visibleSvSummary } from './svDrawing';
import { useTrackFeedStore } from '../../../stores/trackFeedStore';
import { useSvSplitRefresh } from './useSvSplitRefresh';
import { formatReadStatus, readFilterCounts } from './readCounts';
import { isTopLocusStep } from '../../../utils/topLoci';
import { findDatasetReadsLocus } from '../../../utils/datasetReadsLocus';
import { ReadSampleNotice } from './ReadSampleNotice';
import { takeFirstReadsJump, viewportKey } from '../../../utils/firstReadsJump';
import { DEFAULT_MIN_FOOTPRINTS, minFootprintsNoticeApplies } from '../../../stores/uiSlice';
import { FindReadsControl } from './FindReadsControl';
import { blockingProblemFor, findReadsPromptAllowed, useGenomeCheckStore } from '../../../stores/genomeCheckStore';
import { GenomeMismatchNotice } from '../../controls/GenomeMismatchBanner';
import { signalCountText } from '../../../utils/signalFilters';
import { useReadStatusStore } from '../../../stores/readStatusStore';
import { syncBrowserReadOrder } from '../../../api/jupyter';
import { getMetaprofileSourceEntries } from '../../../utils/layerColors';
import { useCanvasRenderVersion } from '../../../utils/canvasUtils';
import { usePanOffsetTransform } from '../../../hooks/usePanOffsetTransform';
import { installTrackSelectionGuard } from '../../../utils/pointerDrag';
import { layerQualitiesNeeded, qualityLayerKey } from './layerQualityNeeds';
import { computeReadTrackLayout } from './layout';
import { clusterAssignmentForRead, clusteredReadIdSet } from './readFilter';
import { logPerfTiming, nowMs } from '../../../utils/perfDebug';
import { isLayerCacheEnabled } from '../../../utils/layerCache';
import { branchScopesPanel, readIdSetForClusterRenderScope } from '../../../utils/readScopes';
import {
  expandStrandRescueLayerRequest,
} from '../../../utils/strandRescue';
import { discoverTfFamilyGroups } from '../../../utils/tfFamilies';
import { ArrowLeft, X } from '../../ui/Icons';
import { EmptyViewTips } from './EmptyViewTips';
import { ZOOMED_OUT_BANNER_HEIGHT, ZoomedOutCard } from './ZoomedOutCard';
import { windowAtLimit } from '../../../utils/readLimit';
import { revealSetting } from '../../../utils/revealSetting';
import { READ_LIMIT_SETTINGS } from '../../controls/sidebar/view/ReadDisplayLimits';
import { splitReadFilter, useSplitPanelStore } from '../../../stores/splitPanelStore';

const EMPTY_ANNOTATIONS: Record<string, ReadAnnotation[]> = {};
const EMPTY_PEAKS: FirePeak[] = [];
/** The default Min footprints is turned off only when it hid at least this many reads in view. */
const AUTO_RELAX_MIN_HIDDEN = 10;

const METHYLATION_LAYER_KEYS = new Set(['m6a', 'mod', 'm5c', 'deam']);
const PRIMARY_INTERVAL_LAYER_KEYS = new Set(['footprint', 'subnuc']);
const SERVER_METAPROFILE_EXCLUDED_KEYS = new Set([
  'm6a', 'mod', 'm5c', 'deam', 'deam_opportunity',
]);
const READ_ORDER_SYNC_DELAY_MS = 3000;
const EMPTY_TRACK_DATA: Record<number, OrthogonalTrackViewportData> = {};

const readOrderSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleBrowserReadOrderSync(datasetId: string, readIds: string[]) {
  const previous = readOrderSyncTimers.get(datasetId);
  if (previous) clearTimeout(previous);

  const idsSnapshot = [...readIds];
  const timer = setTimeout(() => {
    readOrderSyncTimers.delete(datasetId);
    void syncBrowserReadOrder(datasetId, idsSnapshot).catch(() => undefined);
  }, READ_ORDER_SYNC_DELAY_MS);
  readOrderSyncTimers.set(datasetId, timer);
}

const NO_READS: CompactRead[] = [];

function datasetProfileFromServerMetaprofile(meta: ReadsResponse['metaprofile'] | null | undefined): DatasetProfile | null {
  if (!meta) return null;
  const layers = { ...(meta.layers ?? {}) };
  if (!layers.nuc && meta.nucleosome_profile?.length) {
    layers.nuc = meta.nucleosome_profile;
  }
  if (!layers.footprint && layers.nuc) {
    layers.footprint = layers.nuc;
  }
  if (!layers.nuc && layers.footprint) {
    layers.nuc = layers.footprint;
  }
  return {
    mod: layers.m6a ?? layers.mod ?? [],
    fire: layers.fire ?? [],
    rules: {},
    layers,
  };
}


const metaprofileLayerKey = (layer: string | null | undefined): string | null => {
  const key = qualityLayerKey(layer);
  if (!key) return null;
  return key === 'footprint' ? 'nuc' : key;
};


export function ReadTrack({
  width, height, datasetId: datasetIdProp, stateKey: stateKeyProp, datasetLabel, datasetColor,
  overrideChrom, overrideStart, overrideEnd, overrideFilteredIds, panelLabel, readStrand, liftHap,
  disableSpanning = false,
  linkedSessionId, linkedRegion,
  linkedBoundsStart, linkedBoundsEnd,
  linkedSortBy,
  linkedFilteredIds,
  excludeIds,
  linkedHighlightIds,
  onVisibleReadsChange,
  onViewportChange,
  gutterWidth,
  publishFeed = false,
  panScope: panScopeProp,
  genome,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const consensusView=useConsensusViewStore(useShallow(s=>({jobId:s.jobId,selection:s.selection,selections:s.selections,catalog:s.catalog,latticeHits:s.latticeHits,latticeStyle:s.latticeStyle})));
  const canvasRenderVersion = useCanvasRenderVersion();

  // Grouped Zustand selectors — reduces listener count from ~50 to 4 per ReadTrack instance
  // Group 1: Viewport + data (changes on navigation)
  const {
    chrom: storeChrom, start: storeStart, end: storeEnd, spanningOnly: storeSpanningOnly,
    genes, getAllPeaks, peaksByRule, peakRules, datasets,
    downsampleCount, readDisplayMode, allReadsDisplayCap, backgroundReadCap, readStateDetails,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end, spanningOnly: s.spanningOnly,
    genes: s.genes, getAllPeaks: s.getAllPeaks, peaksByRule: s.peaksByRule, peakRules: s.peakRules,
    datasets: s.datasets, downsampleCount: s.downsampleCount,
    readDisplayMode: s.readDisplayMode, allReadsDisplayCap: s.allReadsDisplayCap,
    backgroundReadCap: s.backgroundReadCap,
    readStateDetails: s.readStateDetails,
  })));

  // Group 2: Config (rarely changes)
  const {
    enabledModTypes, fillSmallGaps, fillGapSize, hideTerminalGaps, terminalGapThreshold,
    minFpQuality, minFootprints, minFootprintsAuto, minFootprintsNotice, showDuplicateReads, modificationOverlays,
    enabledMetaProfiles, cachedLayerTypes,
    legacyLayerInference, legacyNucMinSize,
    enabledCigarTypes, anyCigarEnabled, isReversed, activeColormap, orthogonalTracks,
    fillReadHeight, exportFullReadTracks, exportMatchedReadCount, exportMatchedReadFetchCount,
    showReadTooltip, maxRegionForReads, showCoverageHistogram: storeShowCoverageHistogram,
    readRowHeight: storeReadRowHeight, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth,
    readScrollOffsets,
    footprintGroups, selectedFamilyGroupId, compositeTracks,
    svDisplayEnabled, svMinLen, svMinSupport,
  } = useBrowserStore(useShallow(s => ({
    enabledModTypes: s.enabledModTypes, fillSmallGaps: s.fillSmallGaps,
    fillGapSize: s.fillGapSize, hideTerminalGaps: s.hideTerminalGaps,
    terminalGapThreshold: s.terminalGapThreshold, minFpQuality: s.minFpQuality,
    minFootprints: s.minFootprints,
    minFootprintsAuto: s.minFootprintsAuto,
    minFootprintsNotice: s.minFootprintsNotice,
    showDuplicateReads: s.showDuplicateReads,
    modificationOverlays: s.modificationOverlays,
    enabledMetaProfiles: s.enabledMetaProfiles, cachedLayerTypes: s.cachedLayerTypes,
    legacyLayerInference: s.legacyLayerInference, legacyNucMinSize: s.legacyNucMinSize,
    enabledCigarTypes: s.enabledCigarTypes, anyCigarEnabled: s.anyCigarEnabled,
    isReversed: s.isReversed, activeColormap: s.activeColormap,
    orthogonalTracks: s.orthogonalTracks, fillReadHeight: s.fillReadHeight,
    exportFullReadTracks: s.exportFullReadTracks,
    exportMatchedReadCount: s.exportMatchedReadCount,
    exportMatchedReadFetchCount: s.exportMatchedReadFetchCount,
    showReadTooltip: s.showReadTooltip, showCoverageHistogram: s.showCoverageHistogram,
    maxRegionForReads: s.maxRegionForReads,
    readSeparatorMode: s.readSeparatorMode,
    readSeparatorMinHeight: s.readSeparatorMinHeight,
    readSeparatorWidth: s.readSeparatorWidth,
    readRowHeight: s.readRowHeight, readScrollOffsets: s.readScrollOffsets,
    footprintGroups: s.footprintGroups,
    selectedFamilyGroupId: s.selectedFamilyGroupId,
    compositeTracks: s.compositeTracks,
    svDisplayEnabled: s.svDisplayEnabled, svMinLen: s.svMinLen, svMinSupport: s.svMinSupport,
  })));

  // The coverage histogram and the SV summary are rows of their own above a
  // dataset panel's reads now (CoverageTrack, SvTrack; fb-n11-tracks), fed from
  // useTrackFeedStore (published below). A read track outside a panel's rows
  // (the split views) has no such rows: it keeps them drawn above its reads.
  const showCoverageHistogram = publishFeed ? false : storeShowCoverageHistogram;

  const needsOrthogonalRuleData = useMemo(
    () => rulesNeedOrthogonalTrackData(activeColormap.rules),
    [activeColormap.rules],
  );
  const orthogonalTrackData = useBrowserStore(useShallow(s =>
    needsOrthogonalRuleData ? s.orthogonalTrackData : EMPTY_TRACK_DATA
  ));
  const orthogonalTracksForRules = useMemo(
    () => needsOrthogonalRuleData ? hydrateOrthogonalTracks(orthogonalTracks, orthogonalTrackData) : orthogonalTracks,
    [needsOrthogonalRuleData, orthogonalTracks, orthogonalTrackData],
  );

  // Group 3: Cluster state (changes on cluster operations)
  const {
    clusterAssignments, clusterOrder, selectedClusters, readSortOrder, filteredReadIds, clusterFocus,
    selectedFootprints, footprintCrossHighlight, footprintAnalysisLayer, activeClusterBranch,
  } = useBrowserStore(useShallow(s => ({
    clusterAssignments: s.clusterAssignments, clusterOrder: s.clusterOrder, selectedClusters: s.selectedClusters,
    readSortOrder: s.readSortOrder, filteredReadIds: s.filteredReadIds,
    clusterFocus: s.clusterFocus,
    selectedFootprints: s.selectedFootprints,
    footprintCrossHighlight: s.footprintCrossHighlight,
    footprintAnalysisLayer: s.footprintAnalysisLayer,
    activeClusterBranch: s.activeClusterTreeNodeId ? s.clusterTreeNodes[s.activeClusterTreeNodeId] : null,
  })));

  // Group 4: Jupyter state (changes on Jupyter push)
  const {
    jupyterHighlights, jupyterMarkers, jupyterFootprintColors,
    jupyterReadOrder, jupyterReadFilter, jupyterPushedReads, datasetProfiles,
  } = useBrowserStore(useShallow(s => ({
    jupyterHighlights: s.jupyterHighlights, jupyterMarkers: s.jupyterMarkers,
    jupyterFootprintColors: s.jupyterFootprintColors, jupyterReadOrder: s.jupyterReadOrder,
    jupyterReadFilter: s.jupyterReadFilter, jupyterPushedReads: s.jupyterPushedReads,
    datasetProfiles: s.datasetProfiles,
  })));

  // Group 5: Annotation state
  const {
    annotationOverlays: allAnnotationOverlays,
    annotationOverlaysByDataset,
    annotationOverlaysByViewport,
    annotationOverlaysViewport,
    annotationColors,
    enabledAnnotationTypes,
    annotationOpacityMin,
    annotationOpacityMax,
    annotationThresholds,
  } = useBrowserStore(useShallow(s => ({
    annotationOverlays: s.annotationOverlays,
    annotationOverlaysByDataset: s.annotationOverlaysByDataset,
    annotationOverlaysByViewport: s.annotationOverlaysByViewport,
    annotationOverlaysViewport: s.annotationOverlaysViewport,
    annotationColors: s.annotationColors,
    enabledAnnotationTypes: s.enabledAnnotationTypes,
    annotationOpacityMin: s.annotationOpacityMin,
    annotationOpacityMax: s.annotationOpacityMax,
    annotationThresholds: s.annotationThresholds,
  })));

  // Ephemeral state (panning)
  const isPanning = useEphemeralStore(s => s.isPanning);

  // Derive datasetId from props or use first dataset from store
  const datasetId = datasetIdProp ?? datasets[0]?.id ?? 'default';
  const highlightedConsensusFamilies=useMemo(()=>new Set([...relatedFamilyRefs(consensusView.selections,consensusView.catalog,consensusView.jobId)]
    .map(key=>JSON.parse(key) as [string,string]).filter(([id])=>id===datasetId).map(([,family])=>family)),[consensusView.selections,consensusView.catalog,consensusView.jobId,datasetId]);
  const selectedConsensusFamilies=new Set(consensusView.selections.filter(s=>s.jobId===consensusView.jobId&&s.datasetId===datasetId).map(s=>s.family));
  // stateKey: unique key for per-panel state (clusters, filters, sort). Duplicated panels get their own key.
  const stateKey = stateKeyProp ?? datasetId;
  // A panel with its own navigation (onViewportChange) pans on its own; the
  // others follow the main view and slide together while one is dragged.
  const panScope = panScopeProp ?? (onViewportChange ? `panel:${stateKey}` : 'main');

  // Get per-dataset scroll offset
  const readScrollOffset = readScrollOffsets[stateKey] ?? 0;

  // Use override values if provided (for split view), otherwise use store values
  const chrom = overrideChrom ?? storeChrom;
  const start = overrideStart ?? storeStart;
  const end = overrideEnd ?? storeEnd;
  const spanningOnly = disableSpanning ? false : storeSpanningOnly;

  // Get per-panel state (stateKey is unique per panel for duplicates, falls back to datasetId)
  const myClusterAssignments = clusterAssignments[stateKey] ?? EMPTY_OBJECT;
  const myClusterOrder = clusterOrder[stateKey] ?? EMPTY_NUMBER_ARRAY;
  const myReadSortOrder = readSortOrder[stateKey] ?? EMPTY_STRING_ARRAY;
  const myClusterFocus = clusterFocus[stateKey] ?? null;
  const mySelectedClusters = selectedClusters[stateKey] ?? null;
  const hasClusterFocus = myClusterFocus !== null && myClusterFocus.size > 0;
  const clusteredReadIds = useMemo(
    () => clusteredReadIdSet(myClusterAssignments),
    [myClusterAssignments],
  );
  // Resolve the exact visible read IDs from the FRONTEND's authoritative per-node
  // cluster assignments and fetch by ID. The backend can only resolve cluster
  // numbers (`cluster_focus`) against its single most-recent assignment map,
  // which is wrong as soon as a cluster tree exists — switching branches would
  // otherwise re-fetch the previously-clustered reads (or none). Driving the
  // fetch from the live projection makes every child branch show exactly its
  // own reads.
  // Only panels in the branch; a copy made while viewing it shows all its reads.
  const branchReadScopeActive = branchScopesPanel(activeClusterBranch, stateKey);
  const branchReadIds = useMemo(() => {
    return readIdSetForClusterRenderScope(
      myClusterAssignments,
      branchReadScopeActive ? myClusterFocus : null,
      branchReadScopeActive,
    );
  }, [branchReadScopeActive, myClusterFocus, myClusterAssignments]);
  // Preserve root-level hide/show membership across payload-changing refetches
  // (notably the include_methylation transition when Deam is enabled).
  const rootClusterFocusReadIds = useMemo(() => (
    branchReadScopeActive
      ? null
      : readIdSetForClusterRenderScope(myClusterAssignments, myClusterFocus, false)
  ), [branchReadScopeActive, myClusterFocus, myClusterAssignments]);

  const myJupyterOrder = jupyterReadOrder[datasetId] ?? EMPTY_STRING_ARRAY;
  const myReadStateDetails = readStateDetails[stateKey] ?? null;
  const myJupyterFilter = jupyterReadFilter[datasetId] || null;
  const hasJupyterFilter = myJupyterFilter && myJupyterFilter.length > 0;
  const jupyterFilterSet = useMemo(() =>
    hasJupyterFilter ? new Set(myJupyterFilter) : null, [hasJupyterFilter, myJupyterFilter]);

  const myJupyterHighlights = useMemo(() =>
    jupyterHighlights.filter(h => h.dataset_id === datasetId),
    [jupyterHighlights, datasetId]);

  // A "Split into panels" panel (utils/splitPanels.ts) shows its subset of the reads, within its own read filter.
  const splitReads = useSplitPanelStore(s => s.reads[stateKey]);
  // Away from where it was split its reads aren't classified (utils/splitLocus.ts): a banner says so,
  // or (Show all reads here) every read in view, unfiltered.
  const splitPanel = useBrowserStore(s => (splitReads ? s.panels.find(p => p.contentType === 'dataset' && p.readSubset && (p.stateKey ?? p.datasetId) === stateKey) : undefined));
  const splitIsAway = splitAway(splitPanel?.readSubset, { chrom, start, end }, splitPanel);
  const splitAllHere = splitIsAway && Boolean(splitPanel?.readSubset?.showAllAway);
  // A split panel on its own contig (an insert-expanded Carriers panel) stays there; it says when its split went away.
  const splitPinned = useBrowserStore(s => splitPinnedAway(splitPanel?.readSubset, splitPanel, s.panels, { chrom: s.chrom, start: s.start, end: s.end }));
  const showSplitAwayBanner = Boolean(splitPanel && ((splitReads && splitIsAway && !splitAllHere) || splitPinned));
  const subsetFilter = useMemo(() => (splitAllHere ? filteredReadIds[stateKey] : splitReadFilter(splitReads, filteredReadIds[stateKey])),
    [splitAllHere, splitReads, filteredReadIds, stateKey]);
  const myFilteredReadIds = overrideFilteredIds ?? subsetFilter;

  const hasCluster = Object.keys(myClusterAssignments).length > 0;
  // No filter is null; an applied filter that matched nothing (an empty set)
  // shows no reads.
  const hasFilter = myFilteredReadIds != null;
  const regionWidth = end - start;
  const sidebarWidth = gutterWidth ?? (hasCluster ? SIDEBAR_WIDTH : 0);
  const { axis: liveLiftAxis, viewKey: liveLiftView, panel } = useLiveLiftAxis(chrom, start, end, Math.max(1, width - sidebarWidth), isReversed);

  const currentDataset = datasets.find(d => d.id === datasetId);
  const isBAM = isBamBacked(currentDataset);
  const layerType = currentDataset?.layer_type;
  const layerColors = useMemo(() => {
    const colors: Record<string, string> = {};
    for (const [layerId, meta] of Object.entries(currentDataset?.derived_layers ?? {})) {
      if (meta.color) colors[layerId] = meta.color;
    }
    return colors;
  }, [currentDataset?.derived_layers]);
  const layerAvailableInDataset = (dataset: typeof datasets[number] | undefined, key: string) => {
    const datasetLayers = dataset?.available_layers ?? {};
    const datasetLayerType = dataset?.layer_type;
    const datasetIsBam = isBamBacked(dataset);
    const hasExplicitLayerMap = !!dataset?.available_layers;
    if (datasetLayers[key]) return true;
    if (datasetLayerType === key) return true;
    if (key === 'm6a' && (datasetLayers.mod || datasetLayerType === 'mod')) return true;
    if (key === 'mod' && (datasetLayers.m6a || datasetLayerType === 'm6a')) return true;
    if (key === 'fire') return !!(datasetLayers.fire || datasetLayers.msp || datasetLayerType === 'msp');
    if (datasetIsBam && !hasExplicitLayerMap) {
      return key === 'footprint' || key === 'nuc' || key === 'tf' || key === 'fire' || key === 'msp' || key === 'mod' || key === 'm6a';
    }
    return false;
  };
  const layerAvailableForDataset = (key: string) => layerAvailableInDataset(currentDataset, key);
  const layerNeedsPayload = (key: string) =>
    key !== 'deam_opportunity'
    && !PRIMARY_INTERVAL_LAYER_KEYS.has(key)
    && !METHYLATION_LAYER_KEYS.has(key);
  const activeMetaprofileSourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const composite of compositeTracks) {
      if (!composite.visible || composite.kind !== 'metaprofile') continue;
      for (const source of composite.sources) {
        if (!source.visible || source.ref.kind !== 'metaprofile') continue;
        const key = metaprofileLayerKey(source.ref.ruleId === 'mod' ? 'm6a' : source.ref.ruleId);
        if (key) ids.add(key);
      }
    }
    return ids;
  }, [compositeTracks]);
  const layerBackedMetaprofileSourceIds = useMemo(() => {
    const ids = new Set<string>();
    if (!currentDataset) return ids;
    for (const entry of getMetaprofileSourceEntries([currentDataset])) {
      const key = metaprofileLayerKey(entry.key === 'mod' ? 'm6a' : entry.key);
      if (!key) continue;
      if (SERVER_METAPROFILE_EXCLUDED_KEYS.has(key)) continue;
      ids.add(key);
    }
    return ids;
  }, [currentDataset]);
  const serverMetaprofileLayers = useMemo(() => {
    const active = Array.from(activeMetaprofileSourceIds).sort();
    if (active.length === 0) return [];
    if (active.some(key => !layerBackedMetaprofileSourceIds.has(key))) return [];
    return active;
  }, [activeMetaprofileSourceIds, layerBackedMetaprofileSourceIds]);
  const cachedMetaprofileSourceIds = useMemo(() => {
    const ids = new Set<string>();
    if (!currentDataset) return ids;
    for (const entry of getMetaprofileSourceEntries([currentDataset])) {
      const key = metaprofileLayerKey(entry.key === 'mod' ? 'm6a' : entry.key);
      if (!key) continue;
      if (isLayerCacheEnabled(key, cachedLayerTypes)) ids.add(key);
    }
    return ids;
  }, [currentDataset, cachedLayerTypes]);
  const batchCachedMetaprofileSourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of getMetaprofileSourceEntries(datasets)) {
      const key = metaprofileLayerKey(entry.key === 'mod' ? 'm6a' : entry.key);
      if (!key) continue;
      if (isLayerCacheEnabled(key, cachedLayerTypes)) ids.add(key);
    }
    return ids;
  }, [datasets, cachedLayerTypes]);
  const wantsMethylation = Array.from(METHYLATION_LAYER_KEYS).some(key =>
    !!enabledModTypes[key] ||
    !!enabledMetaProfiles[key] ||
    activeMetaprofileSourceIds.has(key) ||
    cachedMetaprofileSourceIds.has(key)
  );
  const hasMethylationLayer = Array.from(METHYLATION_LAYER_KEYS).some(layerAvailableForDataset);
  const needsMethylation = wantsMethylation && hasMethylationLayer;
  const batchWantsMethylation = Array.from(METHYLATION_LAYER_KEYS).some(key =>
    !!enabledModTypes[key] ||
    !!enabledMetaProfiles[key] ||
    activeMetaprofileSourceIds.has(key) ||
    batchCachedMetaprofileSourceIds.has(key)
  );
  const batchNeedsMethylation = batchWantsMethylation && Array.from(METHYLATION_LAYER_KEYS).some(key =>
    datasets.some(dataset => layerAvailableInDataset(dataset, key))
  );
  const buildRequestedLayers = (targetDatasets: Array<typeof datasets[number]>, cachedSourceIds: Set<string>) => {
    const names = new Set<string>();
    const addIfNeeded = (key: string, enabled: boolean | undefined) => {
      if (!enabled) return;
      const canonicalKey = key === 'msp' ? 'fire' : key;
      if (!layerNeedsPayload(canonicalKey)) return;
      // FIRE has had several storage forms (`fire`, legacy `msp`, raw BAM
      // as/al tags). If the user explicitly leaves FIRE on, preserve that
      // intent through cluster-focus/filter refetches even when metadata for a
      // particular loaded dataset is incomplete.
      if (canonicalKey === 'fire') {
        names.add('fire');
        return;
      }
      if (targetDatasets.some(dataset => layerAvailableInDataset(dataset, canonicalKey))) {
        names.add(canonicalKey);
      }
    };
    Object.entries(enabledModTypes).forEach(([key, enabled]) => addIfNeeded(key, enabled));
    Object.entries(enabledMetaProfiles).forEach(([key, enabled]) => addIfNeeded(key, enabled));
    cachedSourceIds.forEach(key => addIfNeeded(key, true));
    activeMetaprofileSourceIds.forEach(key => addIfNeeded(key, true));
    if (footprintAnalysisLayer) addIfNeeded(footprintAnalysisLayer, true);
    const availableLayerNames = targetDatasets.flatMap(dataset =>
      Object.entries(dataset.available_layers ?? {})
        .filter(([_name, present]) => present)
        .map(([name]) => name)
    );
    const expanded = new Set(expandStrandRescueLayerRequest(names, availableLayerNames));
    // tf_consensus is a virtual display capability for producer-native fi/fq on
    // tf_sr, and a Browser-projected layer after targeted scans. Request the
    // native carrier when it exists; the backend resolves scan-generated
    // family layers to their physical tf/tf_sr source.
    if (expanded.has('tf_consensus') && availableLayerNames.includes('tf_sr')) {
      expanded.add('tf_sr');
    }
    return Array.from(expanded).sort();
  };
  const requestedLayers = useMemo(() => {
    return buildRequestedLayers(currentDataset ? [currentDataset] : [], cachedMetaprofileSourceIds);
  }, [enabledModTypes, enabledMetaProfiles, cachedMetaprofileSourceIds, activeMetaprofileSourceIds, footprintAnalysisLayer, currentDataset, layerType, isBAM]);
  const batchRequestedLayers = useMemo(() => {
    return buildRequestedLayers(datasets, batchCachedMetaprofileSourceIds);
  }, [enabledModTypes, enabledMetaProfiles, batchCachedMetaprofileSourceIds, activeMetaprofileSourceIds, footprintAnalysisLayer, datasets]);
  // Edge ambiguity (soft/loose) draws each footprint edge from the per-edge
  // sharpness dims (el/er, lq/rq). For BigBed those live in the nuc/tf LAYER
  // payload + its quality arrays, which only ship when include_layers AND
  // include_layer_qualities are requested. nuc/tf are primary-interval layers
  // so they never enter requestedLayers — force both flags on here, otherwise
  // BigBed footprints render edge-data-free and the modes look identical.
  // (BAM carries edge bytes on the primary stream regardless, so it already
  // worked.) strict ignores edge geometry, so it's exempt.
  const edgeAmbiguityActive = !!activeColormap.edgeAmbiguity
    && (activeColormap.edgeAmbiguity.mode === 'soft' || activeColormap.edgeAmbiguity.mode === 'loose')
    && (activeColormap.edgeAmbiguity.applyNuc || activeColormap.edgeAmbiguity.applyTf);
  const needsLayers = requestedLayers.length > 0 || edgeAmbiguityActive;
  const needsLayerQualitiesFor = useCallback(
    (layers: string[]) => layerQualitiesNeeded(layers, activeColormap),
    [activeColormap],
  );
  const needsLayerQualities = useMemo(
    () => needsLayerQualitiesFor(requestedLayers) || edgeAmbiguityActive,
    [needsLayerQualitiesFor, requestedLayers, edgeAmbiguityActive],
  );
  const batchNeedsLayerQualities = useMemo(
    () => needsLayerQualitiesFor(batchRequestedLayers) || edgeAmbiguityActive,
    [needsLayerQualitiesFor, batchRequestedLayers, edgeAmbiguityActive],
  );
  const needsCigar = isBAM && anyCigarEnabled();
  const hasPushedReads = !!(jupyterPushedReads && jupyterPushedReads.length > 0);
  const filterFitsRequest = useMemo(
    () => !hasFilter || readFilterFitsRequest(myFilteredReadIds),
    [hasFilter, myFilteredReadIds],
  );
  // Reads hidden here with "Exclude selected" (read menu) join the panel's exclusions;
  // reads gone to by name stay in the display sample (pins).
  const excludedFromMenu = useReadActionsStore(s => s.excludedReadIds[stateKey]);
  const pinnedReadIds = useReadActionsStore(s => s.pinnedReadIds);
  const readHighlightIds = useReadActionsStore(s => s.highlight?.ids ?? null);
  const effectiveExcludeIds = useMemo(() => {
    if (!excludedFromMenu || excludedFromMenu.size === 0) return excludeIds;
    if (!excludeIds || excludeIds.size === 0) return excludedFromMenu;
    return new Set([...excludeIds, ...excludedFromMenu]);
  }, [excludeIds, excludedFromMenu]);

  const canUseServerMetaprofile = serverMetaprofileLayers.length > 0
    && serverMetaprofileLayers.length === activeMetaprofileSourceIds.size
    && !hasCluster
    && !linkedSessionId
    && datasets.length <= 1
    && !hasPushedReads
    && !hasJupyterFilter
    && !linkedFilteredIds
    && (!excludeIds || excludeIds.size === 0)
    && (!excludedFromMenu || excludedFromMenu.size === 0)
    // The server profile honours a filter only when it fits in the request's
    // filter_ids (ID count and encoded size); otherwise it would cover every read.
    && filterFitsRequest;

  const matchedExportActive = exportMatchedReadCount != null;
  const renderFillReadHeight = matchedExportActive ? false : fillReadHeight;
  const renderReadRowHeight = matchedExportActive && storeReadRowHeight === 'auto'
    ? 1
    : storeReadRowHeight;

  // --- Data fetching hook ---
  const {
    reads, totalReads, totalOverlappingReads, totalSpanningReads, loading, hasMethylationData,
    workingReads, hiddenByMinFootprints, workingSampling, warning, fetchFailed,
    displayReads, profileReads, displaySampleCount, fetchSequenceRef, currentDataSequenceRef, dataSequence,
    coverageData, coverageMax, coverageReads, coverageLiveLift, dataViewportKey, serverMetaprofile, fulfilledReadFetchCount,
    overlayMarks, svSummary,
  } = useReadTrackData({
    stateKey, readStrand, liftHap,
    chrom, start, end, datasetId, spanningOnly, width, isBAM,
    height: Math.max(0, height - (datasetLabel ? 16 : 0) - (showCoverageHistogram ? 30 : 0)),
    needsMethylation, needsLayers, requestedLayers, needsLayerQualities,
    batchNeedsMethylation, batchRequestedLayers, batchNeedsLayerQualities,
    useServerMetaprofile: canUseServerMetaprofile,
    serverMetaprofileLayers,
    needsCigar, needsMismatches: Boolean(enabledCigarTypes?.mismatches), fillSmallGaps, fillGapSize, hideTerminalGaps,
    terminalGapThreshold, minFpQuality, minFootprints, showDuplicateReads, downsampleCount, readDisplayMode, allReadsDisplayCap,
    backgroundReadCap,
    readRowHeight: renderReadRowHeight,
    readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth,
    exportMatchedReadCount, exportMatchedReadFetchCount,
    legacyLayerInference, legacyNucMinSize,
    hasPushedReads, jupyterPushedReads, overrideFilteredIds,
    linkedSessionId, linkedRegion, linkedSortBy, panelLabel,
    hasClusterFocus, myClusterFocus, hasFilter, myFilteredReadIds,
    myClusterAssignments, myClusterOrder, myReadSortOrder, hasCluster,
    myJupyterOrder, hasJupyterFilter: !!hasJupyterFilter, jupyterFilterSet,
    linkedFilteredIds, excludeIds: effectiveExcludeIds,
    branchReadIds, branchReadScopeActive, rootClusterFocusReadIds, clusteredReadIds,
    pinnedReadIds,
    minSvLen: svMinLen,
    svSummaryEnabled: svDisplayEnabled && isBAM,
  });

  // The SV summary band (fb-n9-sv): this view's SV clusters at the min size;
  // no band when nothing in view passes it.
  const svVisibleSummary = useMemo(
    () => (svDisplayEnabled && isBAM && dataViewportKey === makeDataViewportKey(chrom, start, end, datasetId, linkedSessionId, linkedRegion, readStrand, liftHap)
      ? visibleSvSummary(svSummary, svMinLen, svMinSupport) : null),
    [svDisplayEnabled, isBAM, svSummary, svMinLen, svMinSupport, dataViewportKey, chrom, start, end, datasetId, linkedSessionId, linkedRegion, readStrand, liftHap],
  );
  const svBand = !publishFeed && svVisibleSummary && regionWidth <= maxRegionForReads ? SV_BAND_HEIGHT : 0;
  // A panel's rows start right below the header (the SV and coverage rows are their own tracks).
  const topBandsHeight = (showCoverageHistogram ? 30 : 0) + svBand;
  useSvSplitRefresh({ stateKey, datasetId, chrom, start, end, enabled: isBAM && !linkedSessionId });

  // Reads left over from the previous view (the new request is still pending,
  // or failed) are drawn by nothing and must not be hit or read either: their
  // intervals would pair with the new chrom/start.
  const currentDataViewportKey = makeDataViewportKey(chrom, start, end, datasetId, linkedSessionId, linkedRegion, readStrand, liftHap);
  // A live-lift panel: coverage may be a separate feed-driven row; publishFeed
  // suppresses only the embedded histogram, not its map correspondence.
  const liftCorrespondence = useLiftCorrespondence(currentDataset, chrom, start, end, liftHap,
    storeShowCoverageHistogram && regionWidth <= maxRegionForReads);
  const isDataViewportStale = dataViewportKey !== currentDataViewportKey;

  // Family-tagged BAMs carry compact `fi`/`fq` dimensions on tf_sr. Keep an
  // automatically generated, viewport-scoped set of family cart entries for
  // this dataset; manually created/pinned entries are never removed.
  // Walking every read is expensive, so it depends only on the reads, never
  // on the saved definitions (other panels' auto-family writes change those).
  const discoveredFamilyGroups = useMemo(
    () => (isDataViewportStale ? [] : discoverTfFamilyGroups(reads, chrom, start, datasetId, stateKey)),
    [reads, chrom, start, datasetId, stateKey, isDataViewportStale],
  );
  useEffect(() => {
    // Reads from another view would publish families at the wrong locus.
    if (loading || isDataViewportStale) return;
    const state = useBrowserStore.getState();
    const currentAuto = state.footprintGroups.filter(group => (
      group.autoGeneratedFamily && group.sourceViewKey === stateKey
    ));
    const currentById = new Map(currentAuto.map(group => [group.id, group]));
    const mergedAuto = discoveredFamilyGroups.map(group => {
      const existing = currentById.get(group.id);
      if (!existing) return group;
      return {
        ...group,
        ...existing,
        id: group.id,
        familyId: group.familyId,
        autoGeneratedFamily: true,
        sourceDatasetId: group.sourceDatasetId,
        sourceViewKey: group.sourceViewKey,
        referenceAbsStart: group.referenceAbsStart,
        referenceAbsEnd: group.referenceAbsEnd,
        familyModelAbsStart: group.familyModelAbsStart,
        familyModelAbsEnd: group.familyModelAbsEnd,
      };
    });
    const summarize = (groups: typeof currentAuto) => groups.map(group => [
      group.id,
      group.referenceAbsStart,
      group.referenceAbsEnd,
      group.familyModelAbsStart,
      group.familyModelAbsEnd,
      group.familyId,
    ]);
    if (JSON.stringify(summarize(currentAuto)) === JSON.stringify(summarize(mergedAuto))) {
      return;
    }
    state.setAutoFamilyGroups(stateKey, mergedAuto);
    if (mergedAuto.length > 0 && !state.footprintAnalysisLayer) {
      state.setFootprintAnalysisLayer('tf_sr');
    }
  }, [loading, isDataViewportStale, stateKey, discoveredFamilyGroups]);

  const { renderHeight, renderReadScrollOffset } = useMemo(() => {
    const headerHeight = datasetLabel ? 16 : 0;
    const histogramHeight = topBandsHeight;
    const expandsCurrentMode = readDisplayMode === 'all' || matchedExportActive;
    if (!exportFullReadTracks || !expandsCurrentMode || displayReads.length === 0) {
      return { renderHeight: height, renderReadScrollOffset: readScrollOffset };
    }

    const layout = computeReadTrackLayout(
      displayReads.length,
      height,
      headerHeight,
      histogramHeight,
      renderFillReadHeight,
      renderReadRowHeight,
      0,
      readSeparatorMode,
      readSeparatorMinHeight,
      readSeparatorWidth,
    );
    const fullHeight = headerHeight + histogramHeight + layout.totalContentHeight;
    return {
      renderHeight: Math.max(height, Math.ceil(fullHeight)),
      renderReadScrollOffset: 0,
    };
  }, [
    datasetLabel,
    displayReads.length,
    exportFullReadTracks,
    height,
    matchedExportActive,
    readDisplayMode,
    readScrollOffset,
    readSeparatorMode,
    readSeparatorMinHeight,
    readSeparatorWidth,
    renderFillReadHeight,
    renderReadRowHeight,
    showCoverageHistogram,
    topBandsHeight,
  ]);

  const hitTestReads = isDataViewportStale ? NO_READS : displayReads;

  // --- Mouse interaction hook ---
  const {
    dragCluster, dragY, hoverCluster, hoverY,
    selectedReadIds, hoveredRead, hoveredSv,
    handleMouseDown, handleClick, handleMouseMove, handleMouseUp,
    handleMouseLeave, handleWheel,
    handleContextMenu, handleKeyDown, contextTarget, closeContextMenu, selectFootprintAt, selectReadById,
  } = useReadTrackMouse({
    axis: liveLiftAxis,
    displayReads: hitTestReads, width, height, sidebarWidth, regionWidth, start, end, chrom, datasetId, stateKey,
    datasetLabel, datasetColor,
    hasCluster, myClusterAssignments, myClusterOrder, myClusterFocus, hasClusterFocus, mySelectedClusters,
    isPanning, isReversed, fillReadHeight: renderFillReadHeight, storeReadRowHeight: renderReadRowHeight, readScrollOffset,
    readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth,
    showReadTooltip, showCoverageHistogram,
    linkedBoundsStart, linkedSessionId, onViewportChange, panScope, genome,
    svEnabled: svDisplayEnabled && isBAM, svMinLen, svBandHeight: svBand, svSummary: svVisibleSummary,
  });

  // Cluster counts shown in tooltips should match the full cluster assignment,
  // not just the currently rendered/sample-limited rows.
  const clusterCounts = useMemo(() => {
    if (!hasCluster) return new Map<number, number>();
    const counts = new Map<number, number>();
    for (const cluster of Object.values(myClusterAssignments)) {
      counts.set(cluster, (counts.get(cluster) || 0) + 1);
    }
    return counts;
  }, [hasCluster, myClusterAssignments]);

  const visibleClusterCounts = useMemo(() => {
    if (!hasCluster || displayReads.length === 0) return new Map<number, number>();
    const counts = new Map<number, number>();
    for (const read of displayReads) {
      const cluster = clusterAssignmentForRead(myClusterAssignments, read.id);
      if (cluster !== undefined) {
        counts.set(cluster, (counts.get(cluster) || 0) + 1);
      }
    }
    return counts;
  }, [hasCluster, displayReads, myClusterAssignments]);

  // Compute cluster consensus for transcription states
  const clusterStateConsensus = useMemo(() => {
    if (!hasCluster || !myReadStateDetails) {
      return new Map<number, { pause: number; pic: number; elongating: number; total: number }>();
    }

    const consensus = new Map<number, { pause: number; pic: number; elongating: number; total: number }>();

    for (const [readId, cluster] of Object.entries(myClusterAssignments)) {
      const states = myReadStateDetails[readId];
      if (!states) continue;

      if (!consensus.has(cluster)) {
        consensus.set(cluster, { pause: 0, pic: 0, elongating: 0, total: 0 });
      }
      const c = consensus.get(cluster)!;
      c.total++;
      if (states.pause) c.pause++;
      if (states.pic) c.pic++;
      if (states.elongating_count >= 1) c.elongating++;
    }

    return consensus;
  }, [hasCluster, myClusterAssignments, myReadStateDetails]);

  // Compute and report visible read IDs to parent (for coordinated filtering)
  // Unset until the first report, so a window with no visible reads reports its empty set.
  const prevVisibleIdsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onVisibleReadsChange || !reads || reads.length === 0 || !linkedSessionId || linkedBoundsStart === undefined) {
      return;
    }

    const visibleStart = start - linkedBoundsStart;
    const visibleEnd = end - linkedBoundsStart;

    const visibleIds = new Set<string>();
    for (const read of reads) {
      const isVisible = read.intervals.some(([intStart, intEnd]) => {
        return intEnd > visibleStart && intStart < visibleEnd;
      });
      if (isVisible) {
        visibleIds.add(read.id);
      }
    }

    const visibleKey = Array.from(visibleIds).sort().join(',');
    if (visibleKey !== prevVisibleIdsRef.current) {
      prevVisibleIdsRef.current = visibleKey;
      onVisibleReadsChange(visibleIds);
    }
  }, [reads, start, end, linkedBoundsStart, linkedSessionId, onVisibleReadsChange]);

  // Store active read IDs in the store (for use by analysis operations)
  const setActiveReadIds = useBrowserStore(state => state.setActiveReadIds);
  const prevActiveIdsKeyRef = useRef<string>('');
  useEffect(() => {
    if (loading || isDataViewportStale || currentDataSequenceRef.current === 0) return;
    const ids = displayReads.map(r => r.id);
    const idsKey = ids.join('\0');
    if (idsKey !== prevActiveIdsKeyRef.current) {
      prevActiveIdsKeyRef.current = idsKey;
      setActiveReadIds(stateKey, ids);
      scheduleBrowserReadOrderSync(datasetId, ids);
    }
  }, [displayReads, datasetId, stateKey, setActiveReadIds, currentDataSequenceRef, loading, isDataViewportStale]);

  // computeMetaprofileFromReads - for metaprofile calculation
  const computeMetaprofileFromReads = useCallback((
    readsForProfile: CompactRead[],
    viewWidth: number,
    ruleCtx: import('../../../utils/ruleMatching').RuleMatchContext,
    resolution: number = 500
  ): { mod: number[]; fire: number[]; rules: Record<string, number[]>; layers: Record<string, number[]> } => {
    const modProfile = new Float32Array(resolution);
    const fireDiff = new Float32Array(resolution + 1);
    const metaprofileRules = activeColormap.rules.filter(rule => activeMetaprofileSourceIds.has(rule.id));
    const ruleDiffs: Record<string, Float32Array> = {};
    for (const rule of metaprofileRules) {
      ruleDiffs[rule.id] = new Float32Array(resolution + 1);
    }
    const layerDiffs: Record<string, Float32Array> = {};
    const layerPointProfiles: Record<string, Float32Array> = {};
    const binSize = viewWidth / resolution;

    const coverageDiff = new Float32Array(resolution + 1);

    // Per-type modification counters, written into the layers dict so the
    // existing `enabledMetaProfiles.{m6a,m5c,deam}` toggles pick them up
    // without any extra plumbing. Legacy `modProfile` still tracks the union
    // (methyl) field for back-compat with the 'mod' toggle.
    const getOrAllocLayer = (name: string) => {
      let arr = layerDiffs[name];
      if (!arr) {
        arr = new Float32Array(resolution + 1);
        layerDiffs[name] = arr;
      }
      return arr;
    };
    const getOrAllocPointLayer = (name: string) => {
      let arr = layerPointProfiles[name];
      if (!arr) {
        arr = new Float32Array(resolution);
        layerPointProfiles[name] = arr;
      }
      return arr;
    };
    const addRange = (diff: Float32Array, intStart: number, intEnd: number) => {
      if (intEnd <= 0 || intStart >= viewWidth) return;
      const startBin = Math.max(0, Math.floor(Math.max(0, intStart) / binSize));
      const endBinExclusive = Math.min(resolution, Math.ceil(Math.min(viewWidth, intEnd) / binSize));
      if (endBinExclusive <= startBin) return;
      diff[startBin]++;
      diff[endBinExclusive]--;
    };

    for (const read of readsForProfile) {
      if (read.methyl) {
        for (const pos of read.methyl) {
          if (pos < 0 || pos >= viewWidth) continue;
          const bin = Math.min(resolution - 1, Math.floor(pos / binSize));
          modProfile[bin]++;
        }
      }

      if (read.methyl_m6a && read.methyl_m6a.length > 0) {
        const arr = getOrAllocPointLayer('m6a');
        for (const pos of read.methyl_m6a) {
          if (pos < 0 || pos >= viewWidth) continue;
          arr[Math.min(resolution - 1, Math.floor(pos / binSize))]++;
        }
      }
      if (read.methyl_m5c && read.methyl_m5c.length > 0) {
        const arr = getOrAllocPointLayer('m5c');
        for (const pos of read.methyl_m5c) {
          if (pos < 0 || pos >= viewWidth) continue;
          arr[Math.min(resolution - 1, Math.floor(pos / binSize))]++;
        }
      }
      if (read.deam && read.deam.length > 0) {
        const arr = getOrAllocPointLayer('deam');
        for (const [pos] of read.deam) {
          if (pos < 0 || pos >= viewWidth) continue;
          arr[Math.min(resolution - 1, Math.floor(pos / binSize))]++;
        }
      }

      // Determine read span from all intervals (footprints + gaps)
      let readStart = Infinity, readEnd = -Infinity;
      for (const [intervalStart, intervalEnd, size] of read.intervals) {
        if (intervalStart < readStart) readStart = intervalStart;
        if (intervalEnd > readEnd) readEnd = intervalEnd;

        if (metaprofileRules.length === 0) continue;
        if (size <= 0) continue;
        if (size < 10) continue;

        const ruleId = getMatchingRuleId(intervalStart, intervalEnd, size, metaprofileRules, ruleCtx);

        if (ruleId && ruleDiffs[ruleId]) {
          addRange(ruleDiffs[ruleId], intervalStart, intervalEnd);
        }
      }

      // Per-layer presence profiles — iterate read.layers[name].intervals.
      // Quality filters were applied at working-set construction so the
      // intervals here reflect the filtered state automatically.
      if (read.layers) {
        for (const [layerName, layer] of Object.entries(read.layers)) {
          const ivs = layer?.intervals;
          if (!ivs || ivs.length === 0) continue;
          const profileLayerName = layerName === 'msp' ? 'fire' : layerName;
          let arr = layerDiffs[profileLayerName];
          if (!arr) {
            arr = new Float32Array(resolution + 1);
            layerDiffs[profileLayerName] = arr;
          }
          for (const [intStart, intEnd, size] of ivs) {
            if (size <= 0) continue;
            addRange(arr, intStart, intEnd);
          }
        }
      }

      // FIRE density profile
      if (read.fire) {
        for (const [fStart, fEnd] of read.fire) {
          addRange(fireDiff, fStart, fEnd);
        }
      }

      // Increment coverage bins for this read's span
      if (readStart < readEnd) {
        addRange(coverageDiff, readStart, readEnd);
      }
    }

    const coverage = new Float32Array(resolution);
    const fireProfile = new Float32Array(resolution);
    const ruleProfiles: Record<string, number[]> = {};
    const layerProfiles: Record<string, number[]> = {};
    let coverageRunning = 0;
    let fireRunning = 0;
    const ruleRunning = new Map<string, number>();
    const layerRunning = new Map<string, number>();
    for (const id of Object.keys(ruleDiffs)) ruleRunning.set(id, 0);
    for (const id of Object.keys(layerDiffs)) layerRunning.set(id, 0);
    for (const id of Object.keys(layerPointProfiles)) {
      if (!layerProfiles[id]) layerProfiles[id] = new Array(resolution).fill(0);
    }

    // Normalize by per-position coverage to account for non-spanning reads
    for (let bin = 0; bin < resolution; bin++) {
      coverageRunning += coverageDiff[bin];
      coverage[bin] = coverageRunning;
      fireRunning += fireDiff[bin];
      fireProfile[bin] = fireRunning;
      for (const [ruleId, diff] of Object.entries(ruleDiffs)) {
        const next = (ruleRunning.get(ruleId) ?? 0) + diff[bin];
        ruleRunning.set(ruleId, next);
        if (!ruleProfiles[ruleId]) ruleProfiles[ruleId] = new Array(resolution).fill(0);
        ruleProfiles[ruleId][bin] = next;
      }
      for (const [layerName, diff] of Object.entries(layerDiffs)) {
        const next = (layerRunning.get(layerName) ?? 0) + diff[bin];
        layerRunning.set(layerName, next);
        if (!layerProfiles[layerName]) layerProfiles[layerName] = new Array(resolution).fill(0);
        layerProfiles[layerName][bin] = next;
      }
      for (const [layerName, points] of Object.entries(layerPointProfiles)) {
        if (!layerProfiles[layerName]) layerProfiles[layerName] = new Array(resolution).fill(0);
        layerProfiles[layerName][bin] += points[bin];
      }

      if (coverage[bin] > 0) {
        modProfile[bin] /= coverage[bin];
        fireProfile[bin] /= coverage[bin];
        for (const rule of metaprofileRules) {
          if (ruleProfiles[rule.id]) ruleProfiles[rule.id][bin] /= coverage[bin];
        }
        for (const layerName in layerProfiles) {
          layerProfiles[layerName][bin] /= coverage[bin];
        }
      }
    }

    return { mod: Array.from(modProfile), fire: Array.from(fireProfile), rules: ruleProfiles, layers: layerProfiles };
  }, [activeColormap, activeMetaprofileSourceIds]);

  // Compute metaprofile from the profile read pool, not the final drawn
  // sample, so profile tracks do not shift when Fit-mode sampling changes.
  const metaprofileIdleRef = useRef<number | null>(null);
  useEffect(() => {
    const cancelScheduledMetaprofile = () => {
      if (metaprofileIdleRef.current === null) return;
      const w = window as unknown as { cancelIdleCallback?: (handle: number) => void };
      if (w.cancelIdleCallback) w.cancelIdleCallback(metaprofileIdleRef.current);
      else clearTimeout(metaprofileIdleRef.current);
      metaprofileIdleRef.current = null;
    };

    const fetchSeq = fetchSequenceRef.current;
    const dataSeq = currentDataSequenceRef.current;
    if (DEBUG) console.log(`[META ${datasetId}] Effect: loading=${loading}, fetchSeq=${fetchSeq}, dataSeq=${dataSeq}, reads=${profileReads?.length || 0}`);

    if (loading) {
      cancelScheduledMetaprofile();
      if (DEBUG) console.log(`[META ${datasetId}] SKIP: loading=true`);
      return;
    }

    if (dataSeq !== fetchSeq) {
      cancelScheduledMetaprofile();
      if (DEBUG) console.log(`[META ${datasetId}] SKIP: stale data (dataSeq=${dataSeq} != fetchSeq=${fetchSeq})`);
      // The latest request failed: the old view's curve would sit under the
      // new axis, so show none.
      if (fetchFailed) {
        useBrowserStore.getState().setDatasetProfiles((prev) => ({
          ...prev,
          [stateKey]: { mod: [], fire: [], rules: {}, layers: {} },
        }));
      }
      return;
    }

    if (canUseServerMetaprofile) {
      cancelScheduledMetaprofile();
      // No server profile for this view (zoomed out past the read limit, or
      // none computed): an empty profile, not the previous view's curve.
      const profile = datasetProfileFromServerMetaprofile(serverMetaprofile)
        ?? { mod: [], fire: [], rules: {}, layers: {} };
      useBrowserStore.getState().setDatasetProfiles((prev) => ({
        ...prev,
        [stateKey]: profile,
      }));
      return;
    }

    if (!profileReads || profileReads.length === 0 || end <= start) {
      cancelScheduledMetaprofile();
      if (DEBUG) console.log(`[META ${datasetId}] SKIP: no reads or invalid viewport`);
      // Replace the previous view's curve with an empty (computed) profile so
      // the track reads "No data" instead of a stale curve or "computing…".
      useBrowserStore.getState().setDatasetProfiles((prev) => ({
        ...prev,
        [stateKey]: { mod: [], fire: [], rules: {}, layers: {} },
      }));
      return;
    }

    cancelScheduledMetaprofile();
    const runMetaprofile = () => {
      metaprofileIdleRef.current = null;
      if (fetchSequenceRef.current !== fetchSeq || currentDataSequenceRef.current !== dataSeq) return;

      const viewWidth = end - start;
      if (DEBUG) console.log(`[META ${datasetId}] Computing profile: viewport=${start}-${end}, reads=${profileReads.length}`);

      const ruleCtx = buildRuleMatchContext(genes, peaksForPanelChrom(getAllPeaks(), chrom, useBrowserStore.getState().chrom), orthogonalTracksForRules, start, end, activeColormap.rules, chrom);

      const profile = computeMetaprofileFromReads(profileReads, viewWidth, ruleCtx);

      useBrowserStore.getState().setDatasetProfiles((prev) => ({
        ...prev,
        [stateKey]: profile
      }));

      const hasClusterData = Object.keys(myClusterAssignments).length > 0;
      if (hasClusterData) {
        const clusterIds = new Set<number>();
        for (const c of Object.values(myClusterAssignments)) {
          clusterIds.add(c);
        }
        // Store per-cluster profiles keyed by every layer the metaprofile
        // computer produces (color rules + dataset-declared layers + built-in
        // mod/fire). Cluster detail panels pick which profiles to render from
        // their enabled metaprofile settings.
        const perCluster: Record<number, Record<string, number[]>> = {};
        for (const clusterId of clusterIds) {
          const clusterReads = profileReads.filter(
            r => clusterAssignmentForRead(myClusterAssignments, r.id) === clusterId,
          );
          if (clusterReads.length === 0) continue;
          const cp = computeMetaprofileFromReads(clusterReads, viewWidth, ruleCtx);
          const combined: Record<string, number[]> = {};
          // Rules first, then layers — layer-based profiles override same-key
          // rule profiles because they're the authoritative source when both
          // exist (mirrors MetaTrack precedence).
          for (const [k, v] of Object.entries(cp.rules)) combined[k] = v;
          for (const [k, v] of Object.entries(cp.layers)) {
            combined[k] = v;
            // Legacy alias: `footprint` layer also appears under `nuc` so the
            // top-level `nuc` toggle works for BAM datasets that only expose a
            // `footprint` layer (same aliasing as MetaTrack).
            if (k === 'footprint') combined.nuc = v;
          }
          if (cp.mod) combined.mod = cp.mod;
          if (cp.fire?.some(v => v > 0) && !combined.fire) combined.fire = cp.fire;
          perCluster[clusterId] = combined;
        }
        useBrowserStore.getState().setClusterProfiles(stateKey, perCluster);
      }
    };

    const scheduleMetaprofile = () => {
      const w = window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      };
      metaprofileIdleRef.current = w.requestIdleCallback
        ? w.requestIdleCallback(() => {
          try { runMetaprofile(); } catch (err) { console.error('Error computing metaprofile:', err); }
        }, { timeout: 1200 })
        : window.setTimeout(() => {
          try { runMetaprofile(); } catch (err) { console.error('Error computing metaprofile:', err); }
        }, 0);
    };

    scheduleMetaprofile();
    return cancelScheduledMetaprofile;
  }, [loading, fetchFailed, end, start, datasetId, dataSequence,
      canUseServerMetaprofile, serverMetaprofile, stateKey,
      profileReads, computeMetaprofileFromReads, genes, getAllPeaks, orthogonalTracksForRules, myClusterAssignments, activeColormap]);

  // Build Jupyter highlight lookup
  const jupyterReadHighlights = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of myJupyterHighlights) {
      if (h.type === 'read' && h.read_ids) {
        for (const rid of h.read_ids) {
          map.set(rid, h.color);
        }
      }
    }
    return map;
  }, [myJupyterHighlights]);

  // Build Jupyter footprint color lookup
  const jupyterFootprintColorMap = useMemo(() => {
    const map = new Map<string, Array<{ start: number; end: number; color: string }>>();
    for (const fc of jupyterFootprintColors) {
      for (const [readId, colors] of Object.entries(fc.footprint_colors)) {
        const existing = map.get(readId) || [];
        map.set(readId, [...existing, ...colors]);
      }
    }
    return map;
  }, [jupyterFootprintColors]);

  // Flatten Jupyter markers
  const allJupyterMarkers = useMemo(() =>
    jupyterMarkers.flatMap(m => m.markers),
    [jupyterMarkers]);

  // This dataset's annotations (a file tied to another dataset, or another
  // dataset's read with the same name, stays off); the flat dict for older servers.
  // Positions are relative to the view they were fetched for: a panel at its
  // own locus uses the overlays fetched for it (none until they arrive).
  const atMainView = chrom === storeChrom && start === storeStart && end === storeEnd;
  const viewportOverlays = atMainView ? null : annotationOverlaysByViewport?.[annotationViewportKey(chrom, start, end)];
  // The main view's overlays are for the view they were fetched for: after the
  // view moves (and until a refresh succeeds) they would land offset.
  const mainOverlaysFit = annotationOverlaysViewport == null
    || annotationOverlaysViewport === annotationViewportKey(chrom, start, end);
  const myAnnotationOverlays = atMainView
    ? (mainOverlaysFit ? (annotationOverlaysByDataset?.[datasetId] ?? allAnnotationOverlays) : EMPTY_ANNOTATIONS)
    : (viewportOverlays ? (viewportOverlays.byDataset[datasetId] ?? viewportOverlays.annotations) : EMPTY_ANNOTATIONS);

  // Memoize allPeaks from rule-based system
  const mainChrom = useBrowserStore(s => s.chrom);
  // Peaks are scanned from the reads in view: a panel without reads here (another
  // dataset's locus or genome) draws none over its empty track (M16).
  // (Zoomed out past read level no reads are fetched: the peaks still show.)
  const panelHasReads = displayReads.length > 0 || end - start > maxRegionForReads;
  const allPeaks = useMemo(() => (panelHasReads ? peaksForPanelChrom(getAllPeaks(), chrom, mainChrom) : EMPTY_PEAKS),
    [peaksByRule, peakRules, chrom, mainChrom, panelHasReads]);
  const latticeReadIds = useMemo(() => {
    const layout = computeReadTrackLayout(
      displayReads.length, renderHeight, datasetLabel ? 16 : 0,
      topBandsHeight, renderFillReadHeight, renderReadRowHeight,
      renderReadScrollOffset, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth,
    );
    const stride = layout.rowHeight + layout.rowGap;
    const lo = Math.max(0, Math.floor(layout.scrollAdjust / stride) - 1);
    const hi = Math.min(displayReads.length,
      Math.ceil((layout.scrollAdjust + layout.trackHeight) / stride) + 1);
    return displayReads.slice(lo, hi);
  }, [displayReads, renderHeight, datasetLabel, topBandsHeight, renderFillReadHeight,
    renderReadRowHeight, renderReadScrollOffset, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth]);
  const actionsLayout = useMemo(() => computeReadTrackLayout(
    hitTestReads.length, renderHeight, datasetLabel ? 16 : 0,
    topBandsHeight, renderFillReadHeight, renderReadRowHeight,
    renderReadScrollOffset, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth,
  ), [hitTestReads.length, renderHeight, datasetLabel, topBandsHeight, renderFillReadHeight,
    renderReadRowHeight, renderReadScrollOffset, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth]);
  const {lattice:nativeLattice,latticeMessage}=useNativeLattice(datasetId,chrom,start,end,latticeReadIds,
    datasets.find(d=>d.id===datasetId)?.family_scan_chemistry??undefined);

  // Render to canvas
  const drawLoadingState = loading && displayReads.length === 0;
  const zoomedOutPastReads = regionWidth > maxRegionForReads && !linkedSessionId;
  // The zoomed-out banner: dismissed in this panel stays dismissed (while it is open).
  const [zoomedOutDismissed, setZoomedOutDismissed] = useState(false);
  const zoomedOutBannerShown = zoomedOutPastReads && !isDataViewportStale && !zoomedOutDismissed;
  const hasStaleDisplayReads = displayReads.length > 0 && isDataViewportStale;
  useEffect(() => {
    if (!isDataViewportStale) return;
    prevActiveIdsKeyRef.current = '';
    setActiveReadIds(stateKey, []);
  }, [isDataViewportStale, setActiveReadIds, stateKey]);

  // Redraw on entering/leaving an export: figures leave out on-screen hints.
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.dataset.readTrackReady = 'false';
    if (hasStaleDisplayReads) {
      // While the new view loads, the previous frame stays up; if its request
      // failed, the old region's reads must not stay drawn under the new axis.
      if (fetchFailed) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (isPanning && displayReads.length > 0) return;

    const drawStarted = nowMs();
    drawReadTrack({
      axis: liveLiftAxis,
      canvas,
      displayReads,
      width,
      selectedConsensusFamilies,
      relatedConsensusFamilies:highlightedConsensusFamilies,
      consensusViewJobId:consensusView.jobId,
      nativeLattice,latticeShowHits:consensusView.latticeHits,latticeStyle:consensusView.latticeStyle,
      height: renderHeight,
      regionWidth,
      chrom, genome,
      start,
      end,
      loading: drawLoadingState,
      datasetId,
      stateKey,
      datasetLabel,
      datasetColor,
      sidebarWidth,
      hasCluster,
      myClusterAssignments,
      myClusterOrder,
      hasClusterFocus,
      myClusterFocus,
      mySelectedClusters,
      enabledModTypes,
      enabledCigarTypes,
      isBAM,
      layerType,
      fillReadHeight: renderFillReadHeight,
      storeReadRowHeight: renderReadRowHeight,
      readScrollOffset: renderReadScrollOffset,
      readSeparatorMode,
      readSeparatorMinHeight,
      readSeparatorWidth,
      showCoverageHistogram,
      isReversed,
      activeColormap,
      genes,
      allPeaks,
      orthogonalTracks: orthogonalTracksForRules,
      modificationOverlays,
      overlayMarks,
      jupyterReadHighlights,
      jupyterFootprintColorMap,
      allJupyterMarkers,
      linkedBoundsStart,
      linkedSessionId,
      linkedHighlightIds,
      readHighlightIds: exportInProgress ? null : readHighlightIds,
      selectedReadIds,
      selectedFootprints,
      footprintCrossHighlight,
      footprintGroups,
      selectedFamilyGroupId,
      footprintAnalysisLayer,
      clusterStateConsensus,
      hasFilter,
      myFilteredReadIds,
      maxRegionForReads,
      coverageData: coverageData ?? undefined,
      coverageMax,
      coverageLiveLift,
      annotationOverlays: myAnnotationOverlays ?? undefined,
      annotationColors,
      enabledAnnotationTypes,
      annotationOpacityMin,
      annotationOpacityMax,
      annotationThresholds,
      layerColors,
      svEnabled: svDisplayEnabled && isBAM,
      liftCorrespondence,
      liftHap,
      svMinLen,
      svBandHeight: svBand,
      svSummary: svVisibleSummary,
      coverageFooterHeight: zoomedOutBannerShown && !exportInProgress ? ZOOMED_OUT_BANNER_HEIGHT : 0,
    });
    const drawMs = nowMs() - drawStarted;
    logPerfTiming('read.draw', drawMs, {
      datasetId,
      stateKey,
      region: `${chrom}:${start}-${end}`,
      reads: displayReads.length,
      width,
      height: renderHeight,
      rules: activeColormap.rules.length,
      enabledRules: activeColormap.rules.filter(rule => rule.enabled).length,
      gradientRules: activeColormap.rules.filter(rule => rule.enabled && rule.colorMode === 'size_gradient').length,
      footprintGroups: footprintGroups.filter(group => group.enabled).length,
      layers: Object.keys(enabledModTypes).filter(key => enabledModTypes[key]).sort(),
      cigar: Object.values(enabledCigarTypes).some(Boolean),
      annotations: Object.values(enabledAnnotationTypes ?? {}).filter(Boolean).length,
      hasCluster,
      hasFilter,
      panning: isPanning,
    }, 16);

    canvas.dataset.readTrackReady = String(!loading && !fetchFailed && !isDataViewportStale
      && currentDataSequenceRef.current !== 0 && currentDataSequenceRef.current === fetchSequenceRef.current);
    if (!loading && !isPanning && currentDataSequenceRef.current !== 0 && currentDataSequenceRef.current === fetchSequenceRef.current) {
      markReadViewDrawn();
      // This view's reads are drawn: its pan offset (not another view's) is done.
      const { panOffset: currentPanOffset, panScope: currentPanScope, setPanOffset } = useEphemeralStore.getState();
      if (currentPanOffset !== 0 && currentPanScope === panScope) setPanOffset(0);
    }
  }, [loading, dataSequence, isDataViewportStale, displayReads, width, renderHeight, regionWidth, chrom, start, end, hasCluster, myClusterAssignments, myClusterOrder, drawLoadingState, hasStaleDisplayReads, fetchFailed, genes, allPeaks, hasFilter, myFilteredReadIds, datasetLabel, datasetColor, sidebarWidth, enabledModTypes, enabledCigarTypes, isBAM, layerType, modificationOverlays, overlayMarks, jupyterReadHighlights, jupyterFootprintColorMap, allJupyterMarkers, hasClusterFocus, myClusterFocus, mySelectedClusters, linkedBoundsStart, linkedHighlightIds, clusterStateConsensus, isReversed, activeColormap, orthogonalTracksForRules, renderFillReadHeight, renderReadRowHeight, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth, renderReadScrollOffset, selectedReadIds, showCoverageHistogram, maxRegionForReads, selectedFootprints, footprintCrossHighlight, footprintGroups, selectedFamilyGroupId, footprintAnalysisLayer, coverageData, coverageMax, coverageLiveLift, myAnnotationOverlays, annotationColors, enabledAnnotationTypes, annotationOpacityMin, annotationOpacityMax, annotationThresholds, layerColors, isPanning, canvasRenderVersion, consensusView, highlightedConsensusFamilies, nativeLattice, exportInProgress, readHighlightIds, svDisplayEnabled, svMinLen, svBand, svVisibleSummary, zoomedOutBannerShown, liftCorrespondence, liftHap, liveLiftAxis]);

  // What this panel loaded and shows, for Copilot's troubleshooting diagnostics.
  useEffect(() => {
    useBrowserStore.getState().setReadTrackStatus(stateKey, {
      datasetId, chrom, start, end,
      loading, fetchFailed, warning: warning ?? null,
      zoomedOut: zoomedOutPastReads,
      stale: isDataViewportStale,
      displayed: displayReads.length,
      working: workingReads,
      inScope: totalReads,
      overlapping: totalOverlappingReads,
      spanning: totalSpanningReads,
      strand: readStrand ?? null,
    });
  }, [stateKey, datasetId, chrom, start, end, loading, fetchFailed, warning, zoomedOutPastReads, isDataViewportStale,
      displayReads.length, workingReads, totalReads, totalOverlappingReads, totalSpanningReads, readStrand]);
  useEffect(() => () => useBrowserStore.getState().setReadTrackStatus(stateKey, null), [stateKey]);

  // The rows drawn from these reads (SV summary, coverage): what they show, kept
  // from the last settled view while the next one loads (no row jumps on a pan).
  const settledFeed = useRef<{ reads: CompactRead[]; sv: SvSummary | null; chrom: string; start: number; end: number } | null>(null);
  // A failed fetch leaves nothing to show (not the last view's reads under a new axis).
  if (fetchFailed && !loading) settledFeed.current = null;
  if (!loading && !isDataViewportStale && !fetchFailed) {
    const prev = settledFeed.current;
    const reads = zoomedOutPastReads ? NO_READS : displayReads;
    if (!prev || prev.reads !== reads || prev.sv !== svVisibleSummary || prev.chrom !== chrom || prev.start !== start || prev.end !== end) {
      settledFeed.current = { reads, sv: svVisibleSummary, chrom, start, end };
    }
  }
  const feedSnapshot = settledFeed.current;
  useEffect(() => {
    if (!stateKey || !publishFeed) return;
    useTrackFeedStore.getState().publish(stateKey, {
      datasetId, chrom, start, end, isReversed, sidebarWidth,
      linkedOffset: linkedBoundsStart !== undefined ? linkedBoundsStart - start : 0,
      reads: feedSnapshot?.reads ?? NO_READS,
      liftCorrespondence,
      dataChrom: feedSnapshot?.chrom ?? chrom,
      dataStart: feedSnapshot?.start ?? start,
      dataEnd: feedSnapshot?.end ?? end,
      sv: feedSnapshot?.sv ?? null,
      zoomedOut: zoomedOutPastReads,
      panScope,
      linked: Boolean(linkedSessionId),
    });
  }, [stateKey, publishFeed, datasetId, chrom, start, end, isReversed, sidebarWidth, linkedBoundsStart, feedSnapshot, zoomedOutPastReads, panScope, linkedSessionId, liftCorrespondence]);
  useEffect(() => () => { if (stateKey && publishFeed) useTrackFeedStore.getState().drop(stateKey); }, [stateKey, publishFeed]);

  const { text: statusText, title: statusTitle } = formatReadStatus({
    loading,
    displayed: displayReads.length,
    serverReturned: reads.length,
    working: workingReads,
    inScope: totalReads,
    overlapping: totalOverlappingReads,
    spanning: totalSpanningReads,
  });
  const signalSummary = useBrowserStore(s => s.signalCounts[stateKey]?.counts);
  const signalStatusTitle = signalSummary ? `${statusTitle}; Signal: ${signalCountText(signalSummary)} (before call filters and sampling)` : statusTitle;
  const setReadStatus = useReadStatusStore(st => st.setStatus);
  useEffect(() => {
    if (!stateKey) return;
    setReadStatus(stateKey, { text: statusText, title: signalStatusTitle });
  }, [setReadStatus, stateKey, statusText, signalStatusTitle]);
  useEffect(() => () => { if (stateKey) setReadStatus(stateKey, null); }, [setReadStatus, stateKey]);

  const cursorClass = isPanning
    ? 'cursor-grabbing'
    : dragCluster !== null
      ? 'cursor-grabbing'
      : 'cursor-grab';
  usePanOffsetTransform(canvasRef, { scope: panScope });
  useEffect(() => { installTrackSelectionGuard(); }, []);

  // Track interaction hints — show on first empty render, dismiss on interaction
  const [hintsHidden, setHintsHidden] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('fiberhmm_track_hints_dismissed') === '1'
  );
  // Diagnostic nudges take priority over the generic hints — when a specific
  // cause is hiding all reads, tell the user and offer a one-click recovery.
  // Read-filter wins over Span because an active filter is a more specific /
  // usually-more-recent user action than the persistent Span default.
  // (a split panel's subset is its reads, not a filter to clear)
  const filterEmptied = !loading && displayReads.length === 0 && hasFilter && !splitReads;
  // Min footprints hid every read in view (the server says how many): short
  // reads and amplicons rarely carry that many footprints.
  const minFootprintsEmptied = !loading && !isDataViewportStale && displayReads.length === 0
    && minFootprints > 0 && hiddenByMinFootprints > 0 && !filterEmptied;
  const showSpanNudge = !loading && displayReads.length === 0 && spanningOnly && totalSpanningReads === 0 && totalOverlappingReads > 0 && !filterEmptied && !minFootprintsEmptied;
  const showFilterNudge = filterEmptied;
  const showMinFootprintsNudge = minFootprintsEmptied;
  // The default (untouched) Min footprints hid this dataset's reads: it suits
  // long reads, not this data; turn it off once and say so (the notice below).
  const autoRelaxLabel = currentDataset?.label || datasetLabel || datasetId;
  useEffect(() => {
    if (!minFootprintsEmptied || !minFootprintsAuto || minFootprints !== DEFAULT_MIN_FOOTPRINTS) return;
    if (hiddenByMinFootprints < AUTO_RELAX_MIN_HIDDEN) return;
    useBrowserStore.getState().relaxDefaultMinFootprints({ datasetId, label: autoRelaxLabel, hidden: hiddenByMinFootprints });
  }, [minFootprintsEmptied, minFootprintsAuto, minFootprints, hiddenByMinFootprints, datasetId, autoRelaxLabel]);
  const showMinFootprintsNotice = minFootprintsNoticeApplies(minFootprintsNotice, datasetId, minFootprints) && !loading && displayReads.length > 0;

  // Aggressive read-filter nudge — when a footprint-count / FP-quality read
  // filter is removing most of the in-scope reads, surface a dismissable
  // warning that deep-links to the setting. Modeled on the Span nudge, but
  // Span is intentionally excluded (it has its own nudge). Re-arms whenever the
  // filter values change so a fresh extreme setting warns again.
  const [aggressiveFilterDismissed, setAggressiveFilterDismissed] = useState(false);
  useEffect(() => { setAggressiveFilterDismissed(false); }, [minFootprints, minFpQuality]);
  const hasReadFilterSetting = minFootprints > 0 || minFpQuality > 0;
  const filterCounts = readFilterCounts(totalReads, workingReads, workingSampling, spanningOnly);
  const filteredOutCount = filterCounts.hidden;
  const filteredFraction = filterCounts.fraction;
  // In a one-strand panel the other strand's reads aren't filtered out by
  // these settings, so the counts can't tell what the settings remove.
  const showAggressiveFilterNudge =
    !loading && !isDataViewportStale && !readStrand && !splitReads && !hasFilter && !hasClusterFocus && !hasJupyterFilter
    && hasReadFilterSetting && filterCounts.total > 0 && filteredFraction > 0.5
    && !showSpanNudge && !showFilterNudge && !showMinFootprintsNudge && !aggressiveFilterDismissed;
  const openReadFilters = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
      detail: { sectionId: 'view', subsectionId: 'view.advanced', source: 'aggressive-filter-nudge' },
    }));
  }, []);

  // Zoomed out past the read window no reads are fetched (the panel draws coverage): its own card says so.
  const showZoomedOutCard = zoomedOutBannerShown;
  const showEmptyCard = !loading && !zoomedOutPastReads && displayReads.length === 0 && !showSpanNudge && !showFilterNudge && !showMinFootprintsNudge && !showAggressiveFilterNudge
    && !showSplitAwayBanner;
  // On the wrong reference the reads' locus means nothing: say so instead (services/genome_check.py).
  const genomeProblem = useGenomeCheckStore(s => blockingProblemFor(s.check, datasetId));
  // The interaction tips wait while the card has a problem to explain (a wrong reference),
  // and need room: in a short panel (e.g. a haplotype comparison's stacked views) the
  // card says only that there are no reads, uncut (M18).
  const showHints = showEmptyCard && !hintsHidden && !genomeProblem && height >= 220;
  // Take the user to this dataset's reads when the current view has none
  // (e.g. two datasets from different loci opened together).
  // The search always ends: at a locus, with the reason there is none (shown
  // in the card, e.g. no reads of this dataset map to the loaded genome), or
  // when the user cancels it.
  const [findingReads, setFindingReads] = useState(false);
  const [findReadsMessage, setFindReadsMessage] = useState<string | null>(null);
  const findReadsRef = useRef<AbortController | null>(null);
  useEffect(() => () => findReadsRef.current?.abort(), []);
  // Another dataset or chromosome: a search still running is for the old one.
  useEffect(() => {
    findReadsRef.current?.abort();
    setFindReadsMessage(null);
  }, [datasetId, chrom]);
  const cancelFindReads = useCallback(() => { findReadsRef.current?.abort(); }, []);
  /** Go to this dataset's reads; with `onlyFrom`, only if the view is still that one when the answer comes. */
  const goToDatasetReads = useCallback(async (onlyFrom?: string) => {
    findReadsRef.current?.abort();
    const controller = new AbortController();
    findReadsRef.current = controller;
    setFindingReads(true);
    setFindReadsMessage(null);
    try {
      // The best-covered loci for this dataset, deepest first (next one each
      // time), fitted to their reads and checked against the read filters.
      const result = await findDatasetReadsLocus(datasetId, Math.max(1000, end - start), { signal: controller.signal });
      if (findReadsRef.current !== controller || controller.signal.aborted) return;  // superseded
      if (isTopLocusStep(result)) {
        const store = useBrowserStore.getState();
        if (onlyFrom !== undefined && viewportKey(store.chrom, store.start, store.end) !== onlyFrom) return;
        store.setViewport(result.window.chrom, result.window.start, result.window.end);
      } else if (result.reason !== 'cancelled') {
        setFindReadsMessage(result.message);
      }
    } finally {
      if (findReadsRef.current === controller) findReadsRef.current = null;
      if (findReadsRef.current === null) setFindingReads(false);
    }
  }, [datasetId, end, start]);
  // Newly opened data whose first view has none of its reads: go to them
  // (utils/firstReadsJump; a view moved by anything else cancels it).
  useEffect(() => {
    if (loading || isDataViewportStale || fetchFailed || overrideChrom != null || readStrand) return;
    const here = viewportKey(chrom, start, end);
    if (!takeFirstReadsJump(datasetId, here)) return;
    if (displayReads.length > 0 || totalOverlappingReads > 0 || hiddenByMinFootprints > 0) return;
    void goToDatasetReads(here);
  }, [loading, isDataViewportStale, fetchFailed, overrideChrom, readStrand, chrom, start, end, datasetId,
    displayReads.length, totalOverlappingReads, hiddenByMinFootprints, goToDatasetReads]);
  const dismissHints = useCallback(() => {
    setHintsHidden(true);
    try { localStorage.setItem('fiberhmm_track_hints_dismissed', '1'); } catch {}
  }, []);

  return (
    <div
      className="relative w-full overflow-hidden"
      style={{ height: renderHeight }}
      data-read-track-dataset-id={datasetId}
      data-read-track-state-key={stateKey}
      data-read-track-working-count={workingReads}
      data-read-track-derived-count={displaySampleCount}
      data-read-track-render-count={displayReads.length}
      data-read-track-fetch-count={fulfilledReadFetchCount}
      data-read-track-loading={loading ? 'true' : 'false'}
      data-read-track-error={fetchFailed ? `Could not load reads for ${datasetLabel || currentDataset?.label || datasetId}. Reload the region, then export again.` : undefined}
      data-consensus-highlight-families={[...highlightedConsensusFamilies].join(',')}
      data-native-lattice-read-count={nativeLattice?Object.keys(nativeLattice.reads).length:0}
      data-read-track-export-expanded={exportFullReadTracks && (readDisplayMode === 'all' || matchedExportActive) ? 'true' : undefined}
    >
      <ExpansionOverlay axis={liveLiftAxis} viewKey={liveLiftView} sidebar={sidebarWidth} panel={panel} />
      <DifferenceGuide axis={liveLiftAxis} viewKey={liveLiftView} chrom={chrom} sidebar={sidebarWidth} />
      {!isDataViewportStale && <ReadSampleNotice datasetId={datasetId} sampling={workingSampling} />}
      {latticeMessage&&<div data-testid={`native-lattice-status-${datasetId}`} className="absolute bottom-0 left-1 z-20 bg-white/90 dark:bg-gray-900/90 text-[11px] text-gray-600 dark:text-gray-300 px-1 pointer-events-none">{latticeMessage}</div>}
      {/* The read count ("584/3,170 visible") is shown in the panel header (readStatusStore). */}
      {warning && !loading && (
        <div className="absolute top-1 left-1 z-20 max-w-[80%]" data-render-hide="true">
          <div className="bg-amber-50 dark:bg-amber-900/50 border border-amber-300 dark:border-amber-600 rounded px-2 py-1 text-xs text-amber-800 dark:text-amber-200 shadow-sm">
            {warning}
          </div>
        </div>
      )}
      {showSpanNudge && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none" data-render-hide="true">
          <div className="bg-amber-50 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-600/60 rounded-lg px-5 py-4 shadow-md pointer-events-auto max-w-md">
            <div className="text-sm font-medium text-amber-900 dark:text-amber-100 mb-1">
              No reads cover this whole view in {datasetLabel || datasetId}
            </div>
            <div className="text-xs text-amber-800 dark:text-amber-200/90 mb-3 leading-relaxed">
              <span className="font-mono bg-amber-100 dark:bg-amber-900/60 px-1 py-0.5 rounded border border-amber-300/60 dark:border-amber-700">Full-length</span> is on, and none of this dataset&apos;s reads span the whole view.
              Turn it off to show its {totalOverlappingReads.toLocaleString()} overlapping read{totalOverlappingReads !== 1 ? 's' : ''}, or zoom in.
            </div>
            <button
              onClick={() => useBrowserStore.getState().setSpanningOnly(false)}
              className="px-3 py-1 text-xs font-medium bg-amber-600 hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600 text-white rounded shadow-sm"
            >
              Show all reads
            </button>
          </div>
        </div>
      )}
      {showFilterNudge && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none" data-render-hide="true">
          <div className="bg-rose-50 dark:bg-rose-900/40 border border-rose-300 dark:border-rose-600/60 rounded-lg px-5 py-4 shadow-md pointer-events-auto max-w-md">
            <div className="text-sm font-medium text-rose-900 dark:text-rose-100 mb-1">
              Filter is hiding every read in this viewport
            </div>
            <div className="text-xs text-rose-800 dark:text-rose-200/90 mb-3 leading-relaxed">
              A read-ID filter is active (cluster focus, footprint cart, or Jupyter push)
              and none of its ids match the current region. Clear it to see all reads again.
            </div>
            <button
              onClick={() => {
                // Clear every filter surface that could be driving the empty state —
                // the user just wants their reads back.
                const store = useBrowserStore.getState();
                store.setFilteredReadIds(stateKey, null);
                if (typeof (store as unknown as { setFootprintFilterKey?: (k: string | null) => void }).setFootprintFilterKey === 'function') {
                  (store as unknown as { setFootprintFilterKey: (k: string | null) => void }).setFootprintFilterKey(null);
                }
                store.clearClusterFocus?.();
              }}
              className="px-3 py-1 text-xs font-medium bg-rose-600 hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-600 text-white rounded shadow-sm"
            >
              Clear filter
            </button>
          </div>
        </div>
      )}
      {showMinFootprintsNudge && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none" data-render-hide="true">
          <div className="bg-amber-50 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-600/60 rounded-lg px-5 py-4 shadow-md pointer-events-auto max-w-md" data-testid={`min-footprints-hidden-${datasetId}`}>
            <div className="text-sm font-medium text-amber-900 dark:text-amber-100 mb-1">
              {hiddenByMinFootprints.toLocaleString()} read{hiddenByMinFootprints !== 1 ? 's' : ''} hidden by Min footprints ≥ {minFootprints}
            </div>
            <div className="text-xs text-amber-800 dark:text-amber-200/90 mb-3 leading-relaxed">
              Every read of {currentDataset?.label || datasetLabel || 'this dataset'} in view has fewer than {minFootprints} footprints
              (short reads and amplicons rarely have more). The read filter, not the data, is why this panel is empty.
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => useBrowserStore.getState().setMinFootprints(0)}
                className="px-3 py-1 text-xs font-medium bg-amber-600 hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600 text-white rounded shadow-sm"
                data-testid={`min-footprints-show-all-${datasetId}`}
              >
                Show all reads
              </button>
              <button
                type="button"
                onClick={openReadFilters}
                className="px-3 py-1 text-xs font-medium border border-amber-400 dark:border-amber-600 text-amber-900 dark:text-amber-100 rounded hover:bg-amber-100 dark:hover:bg-amber-900/60"
              >
                Read filters…
              </button>
            </div>
          </div>
        </div>
      )}
      {showMinFootprintsNotice && minFootprintsNotice && (
        <div className="absolute top-1 left-1/2 -translate-x-1/2 z-20 max-w-[92%] pointer-events-none" data-render-hide="true">
          <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/50 border border-amber-300 dark:border-amber-600 rounded px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200 shadow-sm pointer-events-auto" data-testid={`min-footprints-notice-${datasetId}`}>
            <div className="min-w-0">
              <span className="font-medium">Min footprints is off</span>
              {': '}none of the {minFootprintsNotice.hidden.toLocaleString()} reads of {minFootprintsNotice.label} in view had {DEFAULT_MIN_FOOTPRINTS} footprints (short reads).{' '}
              <button
                type="button"
                onClick={() => useBrowserStore.getState().setMinFootprints(DEFAULT_MIN_FOOTPRINTS)}
                className="font-medium underline underline-offset-2 hover:no-underline"
              >
                Turn it back on
              </button>
            </div>
            <button
              type="button"
              onClick={() => useBrowserStore.getState().dismissMinFootprintsNotice()}
              aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-200/60 dark:text-amber-300 dark:hover:bg-amber-950/40"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
      {showAggressiveFilterNudge && (
        <div className="absolute top-1 left-1/2 -translate-x-1/2 z-20 max-w-[92%] pointer-events-none" data-render-hide="true">
          <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/50 border border-amber-300 dark:border-amber-600 rounded px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200 shadow-sm pointer-events-auto">
            <div className="min-w-0">
              <span className="font-medium">Read filter is hiding {Math.round(filteredFraction * 100)}% of reads</span>
              {' '}({filteredOutCount.toLocaleString()} of {filterCounts.total.toLocaleString()} {filterCounts.sampled ? 'sampled reads' : 'in view'}).{' '}
              <button
                type="button"
                onClick={openReadFilters}
                className="font-medium underline underline-offset-2 hover:no-underline"
              >
                Adjust read filters
              </button>
            </div>
            <button
              type="button"
              onClick={() => setAggressiveFilterDismissed(true)}
              aria-label="Dismiss filter warning"
              className="shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-200/60 dark:text-amber-300 dark:hover:bg-amber-950/40"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
      {showZoomedOutCard && (
        <ZoomedOutCard
          datasetId={datasetId}
          width={regionWidth}
          limit={maxRegionForReads}
          reads={coverageReads}
          // Only a panel showing the main view moves it (another locus' panel has its own view).
          onZoom={overrideChrom == null ? () => {
            const target = windowAtLimit(start, end, maxRegionForReads);
            useBrowserStore.getState().setViewport(chrom, target.start, target.end);
          } : undefined}
          onRaise={limit => useBrowserStore.getState().setMaxRegionForReads(limit)}
          onOpenSetting={() => { void revealSetting(READ_LIMIT_SETTINGS.showReadsUpTo); }}
          onDismiss={() => setZoomedOutDismissed(true)}
        />
      )}
      {showSplitAwayBanner && splitPanel && <SplitAwayBanner panel={splitPanel} pinned={splitPinned} />}
      {showEmptyCard && (
        <div className={`absolute inset-0 z-20 flex justify-center p-1 pointer-events-none ${height >= 220 ? 'items-center' : 'items-start pt-2'}`} data-render-hide="true">
          {/* In a short track the card scrolls rather than being cut top and bottom (M14). */}
          <div className="max-h-full overflow-y-auto bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm rounded-lg px-4 py-3 shadow-sm border border-gray-200 dark:border-white/10 pointer-events-auto" data-testid={`read-track-empty-card-${datasetId}`}>
            <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
              <div className="font-medium text-gray-700 dark:text-gray-200">No reads in this view</div>
              {genomeProblem && <GenomeMismatchNotice problem={genomeProblem} />}
              {findReadsPromptAllowed(totalOverlappingReads, overrideChrom, genomeProblem) && (
                <FindReadsControl
                  datasetId={datasetId}
                  label={currentDataset?.label || datasetLabel || 'this dataset'}
                  finding={findingReads}
                  message={findReadsMessage}
                  onFind={() => void goToDatasetReads()}
                  onCancel={cancelFindReads}
                />
              )}
              {showHints && <EmptyViewTips />}
            </div>
            {showHints && (
              <button
                onClick={dismissHints}
                className="mt-2 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                Hide tips
              </button>
            )}
          </div>
        </div>
      )}
      {hasClusterFocus && (
        <div className="absolute top-1 left-1 z-10">
          <button
            onClick={() => useBrowserStore.getState().clearClusterFocus()}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-600 text-white rounded-fb shadow-chip hover:bg-blue-700"
            title="Show all clusters (click to reset)"
          >
            <ArrowLeft size={12} aria-hidden="true" />Show All
          </button>
          <span className="ml-2 text-xs text-gray-500 bg-white/80 px-1 rounded">
            {(() => {
              const focused = Array.from(myClusterFocus!).sort((a, b) => a - b);
              const allClusters = new Set(myClusterOrder);
              const hidden = [...allClusters].filter(c => !myClusterFocus!.has(c)).sort((a, b) => a - b);

              if (hidden.length > 0 && hidden.length < focused.length) {
                return `Hiding: ${hidden.join(', ')}`;
              } else {
                return `Showing: ${focused.join(', ')}`;
              }
            })()}
          </span>
          <span className="ml-1 text-xs text-gray-400">
            (cluster clicks select; use the Clusters panel actions)
          </span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={width}
        height={renderHeight}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        // Focusable so the keyboard reaches the read menu (Shift+F10 or the menu key).
        tabIndex={0}
        aria-label={`Reads${datasetLabel ? ` of ${datasetLabel}` : ''}: drag to pan; Shift+F10 or right-click for read actions`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        title="Drag to pan. Right-click a read for actions; Shift+click selects a read, Cmd/Ctrl+click a footprint. Cmd/Ctrl+scroll zooms row height."
        className={`block select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${cursorClass}`}
        draggable={false}
        // SVG/PDF figures place reads as one high-resolution image.
        data-figure-raster="true"
        // Copilot flash-overlay metadata. The spotlight machinery scans
        // [data-copilot-track="reads"] to find canvases it can flash a
        // genomic-coordinate region on (e.g. for select_read /
        // relabel_footprint actions). sidebarWidth / regionWidth let it
        // compute the pixel offset from a base-pair coordinate without
        // having to re-derive ReadTrack's internal layout math.
        data-copilot-track="reads"
        data-track-chrom={chrom}
        data-track-start={start}
        data-track-end={end}
        data-track-sidebar={sidebarWidth}
        data-track-region-width={regionWidth}
      />
      {dragCluster !== null && dragY !== null && (
        <div
          className="absolute left-0 pointer-events-none bg-black/20 border-t-2 border-b-2 border-blue-500"
          style={{
            top: dragY - 10,
            height: 20,
            width: sidebarWidth,
            backgroundColor: getClusterColor(dragCluster),
            opacity: 0.7,
          }}
        />
      )}
      <ReadTrackActions
        stateKey={stateKey}
        datasetId={datasetId}
        chrom={chrom}
        start={start}
        end={end}
        linkedBoundsStart={linkedBoundsStart}
        onViewportChange={onViewportChange}
        linked={Boolean(linkedSessionId)}
        reads={hitTestReads}
        layout={actionsLayout}
        rowsTop={(datasetLabel ? 16 : 0) + topBandsHeight}
        svSummary={svVisibleSummary}
        svEnabled={svDisplayEnabled && isBAM}
        svMinLen={svMinLen}
        width={width}
        sidebarWidth={sidebarWidth}
        regionWidth={regionWidth}
        isReversed={isReversed}
        contextTarget={contextTarget}
        closeContextMenu={closeContextMenu}
        selectFootprintAt={selectFootprintAt}
        selectReadById={selectReadById}
      />
      {hoveredRead && !isPanning && !contextTarget && (
        <ReadTooltip
          hoveredRead={hoveredRead}
          width={width}
          height={renderHeight}
          chrom={chrom}
          start={linkedBoundsStart ?? start}  // linked-session reads are relative to the session's bounds
          myClusterAssignments={myClusterAssignments}
          myReadStateDetails={myReadStateDetails}
          annotationOverlays={myAnnotationOverlays}
          annotationColors={annotationColors}
        />
      )}
      {hoveredSv && !isPanning && !contextTarget && (
        <SvTooltip hover={hoveredSv} width={width} height={renderHeight} datasetId={datasetId} chrom={chrom} />
      )}
      {hoverCluster !== null && hoverY !== null && dragCluster === null && (
        <ClusterTooltip
          hoverCluster={hoverCluster}
          hoverY={hoverY}
          sidebarWidth={sidebarWidth}
          height={renderHeight}
          clusterCounts={clusterCounts}
          visibleClusterCounts={visibleClusterCounts}
          clusterStateConsensus={clusterStateConsensus}
        />
      )}
    </div>
  );
}
