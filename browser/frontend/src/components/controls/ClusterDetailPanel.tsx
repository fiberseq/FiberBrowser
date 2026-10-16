import { panelReversed } from '../../hooks/usePanelDisplayStore';
import { openRegionPanels } from '../../utils/regionPanels';
import { getClusterColor } from '../tracks/ReadTrack';
import { currentMatchedRun, matchedRunCounts } from '../../utils/clusterMatchedRun';
import { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { dissolveCluster, autoCullClusters, fetchClusterVPlot, fetchClusterProjection, type ClusterVPlotData, type VPlotMode, type ProjectionResponse, type ProjectionMethod } from '../../api/clustering';
import { getCompactReads } from '../../api/readOperations';
import { formatProjectionTsv, indexProjection, projectionFilename, projectionInputSignature } from '../../utils/projectionExport';
import { referenceAt } from '../../utils/dataExportActions';
import { downloadTextFile } from '../../utils/analysisExport';
import { registerDataExport } from '../../utils/dataExportRegistry';
import { CLUSTER_PROJECTION_PLACEHOLDER } from '../../utils/builtinDataExports';
import type { CompactReadLike } from '../../utils/ruleMatching';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { useFocusedReadIds, buildStateKeyToDs } from '../../hooks/useFocusedReadIds';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { consumeRequestedTab, normalizeRequestedTab } from '../../utils/requestedTabs';
import { useRunResult } from '../../stores/runResultStore';
import { CompositionTabContent } from './cluster-detail/CompositionTabContent';
import { EnrichmentTabContent } from './cluster-detail/EnrichmentTabContent';
import { OverviewTabContent } from './cluster-detail/OverviewTabContent';
import { ProfilesTabContent } from './cluster-detail/ProfilesTabContent';
import { ProjectionMap, type ProjectionView } from './cluster-detail/ProjectionMap';
import { MergeToggleChip } from './cluster-detail/MergeToggleChip';
import {
  effectiveOverviewMode,
  nextMapFocus,
  overviewColumns,
  overviewModeOptions,
  OVERVIEW_SIDE_BY_SIDE_MIN_WIDTH,
  type OverviewMode,
} from './cluster-detail/projectionMapModel';
import { mergeLogStatus, mergedClusters, type MergedClusterInfo } from '../../stores/clusterMergeLog';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { currentMergeSettings, describeMergeSettings, type MergeStrategy } from '../../utils/mergeStrategies';
import { clusteringBeforeMerge, recordAppliedMerge } from '../../utils/clusterMergeActions';
import { SavedClustersTab } from './cluster-detail/SavedClustersTab';
import { VPlotTabContent } from './cluster-detail/VPlotTabContent';
import { ClusterBranchMap, hasClusterBranches } from './cluster-detail/ClusterBranchMap';
import { clusterOperationRounds } from './cluster-detail/clusterOperationRounds';
import { chartRoundStillCurrent, clusterChartScope, clusterChartScopeNote, clusterMergeInputs, clusterMergePeaks, scopedClusters } from './cluster-detail/clusterChartScope';
import { getGenes } from '../../api/reference';
import type { Gene } from '../../types';
import { panelGenomeLabel, usePanelGenomeStore } from '../../stores/panelGenomeStore';
import {
  AnalysisButton,
  AnalysisPanelHeader,
  AnalysisPanelShell,
  AnalysisRunSummary,
  AnalysisSelect,
  AnalysisStatus,
  AnalysisSubTabBar,
  AnalysisToggleGroup,
  ClusterFocusBadge,
  HiddenTabTargets,
} from './shared';
import { buildRuleMatchContext, computePerClusterEnrichment, hydrateOrthogonalTracks, rulesNeedOrthogonalTrackData } from '../../utils/ruleMatching';
import type { EnrichmentResult } from '../../utils/ruleMatching';
import { clusterCohorts } from '../../utils/readStatesByDataset';
import type { OrthogonalTrackViewportData } from '../../types/dataset';
import { useAnalysisSettingsKey } from '../../hooks/useAnalysisSettingsKey';
import {
  buildClusterAssignmentSignature,
  buildClusterEnrichmentRequestKey,
  buildClusterProjectionRequestKey,
  buildClusterVplotRequestKey,
} from '../../utils/clusterDetailRequestKey';
import { Check, ReadClusters, Sliders } from '../ui/Icons';
import { useRememberedState } from '../../hooks/useRememberedState';

const CLUSTER_DETAIL_TAB_STORAGE_KEY = 'fiberbrowser_cluster_detail_tab';
// 'projection' is not a tab of its own: the read map is part of Overview (fb-n5-projection);
// asking for it (deep links, the tour, older remembered tabs) opens Overview with the map.
const CLUSTER_DETAIL_TABS = ['overview', 'profiles', 'composition', 'vplot', 'enrichment', 'projection', 'saved'] as const;
/** The tabs shown as sub-tabs of Charts. */
const CHART_TABS = new Set<string>(['profiles', 'composition', 'vplot', 'enrichment']);
const OVERVIEW_MODE_LABELS: Record<OverviewMode, string> = { profiles: 'Profiles', both: 'Profiles + map', map: 'Map' };
const EMPTY_TRACK_DATA: Record<number, OrthogonalTrackViewportData> = {};
type ClusterDetailTab = typeof CLUSTER_DETAIL_TABS[number];

function normalizeClusterDetailTab(
  tab: string | null | undefined,
  fallback: ClusterDetailTab = 'overview',
): ClusterDetailTab {
  return normalizeRequestedTab(tab, CLUSTER_DETAIL_TABS, fallback);
}

function consumeRequestedClusterDetailTab(): ClusterDetailTab {
  return consumeRequestedTab(CLUSTER_DETAIL_TAB_STORAGE_KEY, CLUSTER_DETAIL_TABS, 'overview');
}

export function ClusterDetailPanel({ isFullView }: { isFullView?: boolean }) {
  const {
    chrom: mainChrom,
    clusterAssignments,
    clusterOrder,
    clusterPeakRegions,
    clusterWindowPeaks,
    clusterFeatureRules,
    setClusterOrder,
    setClusterAssignments,
    selectedClusters,
    setClusterSelection,
    toggleClusterSelection,
    clearClusterSelection,
    mergeSelectedClusters,
    clusterTreeNodes,
    clusterTreeRootIds,
    activeClusterTreeNodeId,
    applyClusterTreeNode,
    deleteClusterTreeNode,
    renameClusterTreeNode,
    captureActiveClusterTreeNode,
    clusterProfiles,
    clusterFocus,
    setClusterFocus,
    dynamicClustering,
    setDynamicClustering,
    dynamicOverlapMode,
    setDynamicOverlapMode,
    datasets,
    panels,
    getAllPeaks, selectedPeaks, peakModes,
    spanningOnly,
    subnucleosomalThreshold, accessibilityThreshold,
    savedClusters, saveCurrentClustering, removeSavedCluster, updateSavedClusterName,
    clearSavedClusters, restoreSavedCluster,
    activeColormap, genes, orthogonalTracks,
    enabledMetaProfiles,
    analysisSampleCount,
    peaksLocked,
    analysisSampleSeed,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom,
    clusterAssignments: s.clusterAssignments,
    clusterOrder: s.clusterOrder,
    clusterPeakRegions: s.clusterPeakRegions,
    clusterWindowPeaks: s.clusterWindowPeaks,
    clusterFeatureRules: s.clusterFeatureRules,
    setClusterOrder: s.setClusterOrder,
    setClusterAssignments: s.setClusterAssignments,
    selectedClusters: s.selectedClusters,
    setClusterSelection: s.setClusterSelection,
    toggleClusterSelection: s.toggleClusterSelection,
    clearClusterSelection: s.clearClusterSelection,
    mergeSelectedClusters: s.mergeSelectedClusters,
    clusterTreeNodes: s.clusterTreeNodes,
    clusterTreeRootIds: s.clusterTreeRootIds,
    activeClusterTreeNodeId: s.activeClusterTreeNodeId,
    applyClusterTreeNode: s.applyClusterTreeNode,
    deleteClusterTreeNode: s.deleteClusterTreeNode,
    renameClusterTreeNode: s.renameClusterTreeNode,
    captureActiveClusterTreeNode: s.captureActiveClusterTreeNode,
    clusterProfiles: s.clusterProfiles,
    clusterFocus: s.clusterFocus,
    setClusterFocus: s.setClusterFocus,
    dynamicClustering: s.dynamicClustering,
    setDynamicClustering: s.setDynamicClustering,
    dynamicOverlapMode: s.dynamicOverlapMode,
    setDynamicOverlapMode: s.setDynamicOverlapMode,
    datasets: s.datasets,
    panels: s.panels,
    getAllPeaks: s.getAllPeaks, selectedPeaks: s.selectedPeaks, peakModes: s.peakModes,
    spanningOnly: s.spanningOnly,
    subnucleosomalThreshold: s.subnucleosomalThreshold, accessibilityThreshold: s.accessibilityThreshold,
    savedClusters: s.savedClusters, saveCurrentClustering: s.saveCurrentClustering,
    removeSavedCluster: s.removeSavedCluster, updateSavedClusterName: s.updateSavedClusterName,
    clearSavedClusters: s.clearSavedClusters, restoreSavedCluster: s.restoreSavedCluster,
    activeColormap: s.activeColormap, genes: s.genes, orthogonalTracks: s.orthogonalTracks,
    enabledMetaProfiles: s.enabledMetaProfiles,
    analysisSampleCount: s.analysisSampleCount,
    peaksLocked: s.peaksLocked,
    analysisSampleSeed: s.analysisSampleSeed,
  })));

  // What the panels show (panelScope): the charts plot a clustered panel's own view.
  const scopeState = useBrowserStore(useShallow(s => ({
    panels: s.panels, chrom: s.chrom, start: s.start, end: s.end, navigationMode: s.navigationMode,
    selectedDatasets: s.selectedDatasets, lastMovedPanels: s.lastMovedPanels, collapsedRows: s.collapsedRows,
    fullViewPanelId: s.fullViewPanelId, currentGenome: s.currentGenome, fastaPath: s.fastaPath,
  })));
  const panelGenomes = usePanelGenomeStore(s => s.genomes);

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

  const [dissolving, setDissolving] = useState<number | null>(null);
  const [culling, setCulling] = useState(false);
  const [cullResult, setCullResult] = useState<string | null>(null);
  const runResult = useRunResult('cluster');
  const matchedGroupIds = useBrowserStore(useShallow(s => s.peakRules.filter(r => r.source === 'matched').map(r => r.id)));
  const [activeTab, setActiveTab] = useRememberedState<ClusterDetailTab>('cluster-detail:tab', consumeRequestedClusterDetailTab, CLUSTER_DETAIL_TAB_STORAGE_KEY);
  const [lastChartTab, setLastChartTab] = useRememberedState<ClusterDetailTab>('cluster-detail:last-chart', () => 'profiles');
  // Overview: the cluster profiles, the read map, or both side by side (wide panels).
  const [overviewMode, setOverviewMode] = useRememberedState<OverviewMode>('cluster-detail:overview-mode', () => 'both');
  const [containerWidth, containerRef] = useContainerWidth(400);
  // Every way to a chart (sub-tab, Charts, a deep link, a button) makes it the one Charts reopens.
  const showTab = useCallback((key: ClusterDetailTab) => {
    if (key === 'projection') {
      // The map lives in Overview: show it (beside the profiles when there's room).
      setActiveTab('overview');
      setOverviewMode(mode => (mode === 'both' && containerWidth >= OVERVIEW_SIDE_BY_SIDE_MIN_WIDTH ? 'both' : 'map'));
      return;
    }
    setActiveTab(key);
    if (CHART_TABS.has(key)) setLastChartTab(key);
  }, [containerWidth, setActiveTab, setLastChartTab, setOverviewMode]);
  // A chart shown any other way (a request when the panel opened) is the one Charts reopens too.
  useEffect(() => {
    if (activeTab === 'projection') showTab('projection');
    else if (CHART_TABS.has(activeTab)) setLastChartTab(activeTab);
  }, [activeTab, setLastChartTab, showTab]);
  const [saveFeedback, setSaveFeedback] = useState(false);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);

  // V-plot state
  // V-plots with the request they answer: shown only for the current settings.
  const [vplotEntry, setVplotEntry] = useState<{ key: string; data: Record<string, Record<number, ClusterVPlotData>> } | null>(null);
  const [vplotError, setVplotError] = useState<string | null>(null);
  const [vplotLoading, setVplotLoading] = useState(false);
  const [vplotSizeBin, setVplotSizeBin] = useState(10);
  const [vplotPosBin, setVplotPosBin] = useState(10);
  const [vplotSizeMin, setVplotSizeMin] = useState(10);
  const [vplotSizeMax, setVplotSizeMax] = useState(300);
  const [vplotLog, setVplotLog] = useState(true);
  const [vplotSmooth, setVplotSmooth] = useState(1.0);
  // New: layer source (null = primary, 'tf' = LLR-recalled TF subset),
  // normalization mode, and a preset dropdown for quick size-range swaps.
  const [vplotLayer, setVplotLayer] = useState<string | null>(null);
  const [vplotNormalize, setVplotNormalize] = useState<'per_cluster' | 'shared'>('per_cluster');
  const [vplotMode, setVplotMode] = useState<VPlotMode>('midpoint');
  const [vplotRowNormalize, setVplotRowNormalize] = useState(false);
  const [showVplotSettings, setShowVplotSettings] = useState(false);

  // Enrichment state
  const [enrichmentReads, setEnrichmentReads] = useState<Record<string, CompactReadLike[]> | null>(null);
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);
  const [enrichmentViewportKey, setEnrichmentViewportKey] = useState('');
  const [enrichmentError, setEnrichmentError] = useState<string | null>(null);
  // A panel with a locus of its own: its genes (the store's are the main view's).
  const [enrichmentGenes, setEnrichmentGenes] = useState<Gene[] | null>(null);

  // Projection (PCA / UMAP / t-SNE) state
  // t-SNE by default: it keeps each read's nearest neighbours together.
  const [projectionMethod, setProjectionMethod] = useState<ProjectionMethod>('tsne');
  const [projectionView, setProjectionView] = useState<ProjectionView>('before');
  const [showMergeSettings, setShowMergeSettings] = useState(false);
  // Tagged with the request it answers: shown (and Merge now offered) only
  // while every input still matches, so a preview can't stand for other settings.
  const [projectionFetched, setProjectionFetched] = useState<{ key: string; data: ProjectionResponse } | null>(null);
  const [projectionLoading, setProjectionLoading] = useState(false);
  const [projectionError, setProjectionError] = useState<string | null>(null);
  const [projectionHighlightDs, setProjectionHighlightDs] = useState<Set<string> | null>(null);
  // Shared with the toolbar's merge button and Copilot: what you preview here is what merges.
  const mergeSettings = useBrowserStore(useShallow(s => currentMergeSettings(s)));
  const projectionMinFraction = mergeSettings.minFraction;
  const projectionMaxCosine = mergeSettings.maxSimilarity;
  const onMergeSettings = useCallback(
    (patch: { minFraction?: number; strategy?: MergeStrategy; threshold?: number }) => useBrowserStore.getState().setMergeSettings(patch),
    [],
  );
  const vplotRequestSeqRef = useRef(0);
  const enrichmentRequestSeqRef = useRef(0);
  const projectionRequestSeqRef = useRef(0);

  useEffect(() => {
    const handleOpenTab = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      showTab(normalizeClusterDetailTab(tab, activeTab));
    };
    window.addEventListener('fiberbrowser:open-cluster-detail-tab', handleOpenTab);
    return () => window.removeEventListener('fiberbrowser:open-cluster-detail-tab', handleOpenTab);
  }, [activeTab, showTab]);

  const { targetDatasetIds, targetStateKeys, stateKeyMap } = useFocusedReadIds();
  const enabledQualityFilterCount = activeColormap.qualityFilters.filter(filter => filter.enabled).length;

  // Reverse map: stateKey → datasetId (for display labels/colors)
  const stateKeyToDs = useMemo(() => buildStateKeyToDs(stateKeyMap), [stateKeyMap]);
  const getDsForKey = useCallback((sk: string) => datasets.find(d => d.id === (stateKeyToDs[sk] || sk)), [stateKeyToDs, datasets]);
  // A split panel (Split into panels) is named and coloured after its group, so panels of one dataset tell apart.
  const splitPanels = useMemo(() => panels.filter(p => p.readSubset).map(p => [p.stateKey ?? '', p.readSubset!.label, p.readSubset!.colour] as const), [panels]);
  const keyLabel = useCallback((sk: string) => {
    const split = splitPanels.find(([key]) => key === sk);
    const label = getDsForKey(sk)?.label;
    return split ? `${label ?? sk} · ${split[1]}` : label;
  }, [splitPanels, getDsForKey]);
  const keyColor = useCallback((sk: string) => splitPanels.find(([key]) => key === sk)?.[2] ?? getDsForKey(sk)?.color, [splitPanels, getDsForKey]);

  const hasClusterAssignments = Object.values(clusterAssignments).some(
    a => Object.keys(a).length > 0
  );
  // The read map is drawn (and fetched) only while Overview shows it.
  const overviewShown = effectiveOverviewMode(overviewMode, containerWidth);
  const mapVisible = activeTab === 'overview' && overviewShown !== 'profiles';

  const savedMatchedRun = useBrowserStore(s => s.clusterMatchedRun);
  const matchedRun = useMemo(() => currentMatchedRun(savedMatchedRun, clusterAssignments), [savedMatchedRun, clusterAssignments]);

  // stateKeys with cluster data (respects selectedDatasets + link groups + duplicates)
  const datasetIds = useMemo(() => {
    // A joint fit has its own cluster IDs. The folded source panel may still
    // hold the earlier split, which must not enter its counts or profiles.
    const runKeys = new Set(matchedRun?.windows.map(w => w.stateKey));
    const keys = targetStateKeys.some(key => runKeys.has(key))
      ? targetStateKeys.filter(key => runKeys.has(key)) : targetStateKeys;
    return keys.filter(sk =>
      clusterAssignments[sk] && Object.keys(clusterAssignments[sk]).length > 0
    );
  }, [targetStateKeys, clusterAssignments, matchedRun]);


  // V-plots, the projection, enrichment, dissolve and merge read one region's
  // reads: a clustered panel's own view (its locus and reference; see
  // clusterChartScope), not the main locus, which is stale while each panel
  // navigates. Clustered panels showing another view are left out (the tabs say so).
  const chartScope = useMemo(() => clusterChartScope(scopeState, datasetIds), [scopeState, datasetIds]);
  const chartView = chartScope.view;
  const isReversed = useBrowserStore(s => panelReversed(s, chartView.panelId ?? null));
  const { chrom, start, end } = chartView;
  const viewGenome = chartView.genome;
  const analysisKeys = chartScope.keys;
  const offLocusNote = clusterChartScopeNote(chartScope, key => panelGenomeLabel(panelGenomes[key], key));

  const actualDatasetIds = useMemo(
    () => [...new Set(analysisKeys.map(sk => stateKeyToDs[sk] || sk))],
    [analysisKeys, stateKeyToDs],
  );

  // Requests carry assignments per dataset: panels sharing one (copies, strand
  // halves) each clustered on their own, so each goes in its own round.
  const analysisRounds = useMemo(
    () => clusterOperationRounds(analysisKeys, stateKeyToDs, clusterAssignments),
    [clusterAssignments, analysisKeys, stateKeyToDs],
  );
  // A projection shares axes across one round's panels: the first one.
  const projectionRound = analysisRounds[0] ?? null;
  const projectionDatasetIds = useMemo(
    () => Object.keys(projectionRound?.keyByDataset ?? {}),
    [projectionRound],
  );
  const projectionNote = [
    analysisRounds.length > 1
      ? 'Several panels show the same dataset with their own clusters; this projection shows the first of each. Select one panel to project it.'
      : null,
    offLocusNote,
  ].filter(Boolean).join(' ') || null;

  // Unmounted panels don't apply late results.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * What a dissolve/merge sends, as it is now: the clustered panels showing the
   * charts' view (a panel at another locus or reference is skipped), that
   * view's locus, reference and peaks, in rounds (clusterMergeInputs: the
   * toolbar's button and Copilot send the same).
   */
  const mergeInputsNow = useCallback(
    () => clusterMergeInputs(useBrowserStore.getState(), datasetIds, stateKeyToDs),
    [datasetIds, stateKeyToDs],
  );

  const clusteredReadTotal = useMemo(
    () => datasetIds.reduce((sum, sk) => sum + Object.keys(clusterAssignments[sk] || {}).length, 0),
    [clusterAssignments, datasetIds],
  );
  const clusterAssignmentSignature = useMemo(
    () => buildClusterAssignmentSignature(clusterAssignments, analysisKeys),
    [clusterAssignments, analysisKeys],
  );

  // Quality filters and layer inference change the reads every cluster plot is
  // computed from: part of each plot's request key.
  const settingsKey = useAnalysisSettingsKey();
  const vplotRequestKey = useMemo(() => `${buildClusterVplotRequestKey({
    chrom,
    start,
    end,
    sizeBin: vplotSizeBin,
    posBin: vplotPosBin,
    sizeMin: vplotSizeMin,
    sizeMax: vplotSizeMax,
    logNorm: vplotLog,
    smooth: vplotSmooth,
    layer: vplotLayer,
    normalize: vplotNormalize,
    mode: vplotMode,
    rowNormalize: vplotRowNormalize,
    sampleSeed: analysisSampleSeed,
    assignmentSignature: clusterAssignmentSignature,
  })}|${viewGenome ?? ''}|${settingsKey}`, [
    analysisSampleSeed, chrom, clusterAssignmentSignature, end, start, viewGenome, vplotLayer,
    vplotLog, vplotNormalize, vplotPosBin, vplotSizeBin, vplotSizeMax,
    vplotSizeMin, vplotSmooth, settingsKey, vplotMode, vplotRowNormalize,
  ]);

  // Rules match TF calls and any layer they target, which live in each
  // read's layers rather than its top-level intervals.
  const enrichmentLayers = useMemo(() => {
    const layers = new Set<string>(['tf']);
    for (const rule of activeColormap.rules) {
      if (rule.enabled) for (const layer of rule.targetLayers ?? []) layers.add(layer);
    }
    return [...layers].sort();
  }, [activeColormap.rules]);
  const enrichmentRequestKey = useMemo(() => `${buildClusterEnrichmentRequestKey({
    chrom,
    start,
    end,
    datasetIds: actualDatasetIds,
    layers: enrichmentLayers,
    // The enrichment reads are fetched through the quality filters.
    analysisSettingsKey: settingsKey,
  })}|${viewGenome ?? ''}|${chartView.followsMain ? 'main' : 'own'}`, [actualDatasetIds, chrom, end, enrichmentLayers, start, settingsKey, viewGenome, chartView.followsMain]);

  // The peaks the clustering was built on (merging and dissolving compare the
  // clusters on those), else the selected peaks. The Projection preview and the
  // merge it previews both use this list, so the preview is what Merge does.
  // Only those on the plotted view's reference and chromosome (a run on another
  // panel's reference doesn't lend its peaks); none: the server's stored peaks.
  // (clusterMergePeaks: every Merge / Delete button and Copilot use the same.)
  const peakRegions = useMemo(
    () => clusterMergePeaks({ chrom: mainChrom, clusterPeakRegions, clusterWindowPeaks, selectedPeaks, peakModes, getAllPeaks }, analysisKeys, chartView),
    [clusterPeakRegions, clusterWindowPeaks, analysisKeys, getAllPeaks, selectedPeaks, peakModes, chartView, mainChrom],
  );
  const peakRegionsKey = useMemo(
    () => peakRegions.map(p => `${p.start}-${p.end}:${p.mode}`).join(','),
    [peakRegions],
  );

  const projectionRequestKey = useMemo(() => buildClusterProjectionRequestKey({
    chrom,
    start,
    end,
    datasetIds: projectionDatasetIds,
    method: projectionMethod,
    spanning: spanningOnly,
    simulateAutocull: projectionView !== 'before',
    minFraction: projectionMinFraction,
    maxCosineSimilarity: projectionMaxCosine,
    mergeStrategy: mergeSettings.strategy,
    mergeThreshold: mergeSettings.threshold,
    subnucleosomalThreshold,
    accessibilityThreshold,
    sampleSeed: analysisSampleSeed,
    assignmentSignature: clusterAssignmentSignature,
  }), [
    accessibilityThreshold, analysisSampleSeed, chrom, projectionDatasetIds,
    clusterAssignmentSignature, end, projectionMaxCosine, projectionMethod,
    projectionMinFraction, projectionView, spanningOnly, start,
    subnucleosomalThreshold, mergeSettings.strategy, mergeSettings.threshold,
  ]);

  const clusterFeatureRulesKey = useMemo(() => JSON.stringify(clusterFeatureRules ?? []), [clusterFeatureRules]);
  // The panel whose view it is too (the kept map is checked against that panel's view).
  const projectionFullKey = `${projectionRequestKey}|${viewGenome ?? ''}|${chartView.followsMain ? '' : chartView.panelId ?? ''}|${peakRegionsKey}|${clusterFeatureRulesKey}|${settingsKey}`;
  const projectionData = projectionFetched?.key === projectionFullKey ? projectionFetched.data : null;

  // Fetch cluster V-plots when tab is active
  useEffect(() => {
    if (activeTab !== 'vplot' || !hasClusterAssignments) {
      vplotRequestSeqRef.current += 1;
      setVplotLoading(false);
      return;
    }
    const controller = new AbortController();
    const requestSeq = ++vplotRequestSeqRef.current;
    const key = vplotRequestKey;
    setVplotError(null);
    const timer = setTimeout(() => {
      if (vplotRequestSeqRef.current !== requestSeq) return;
      setVplotLoading(true);
      Promise.all(analysisRounds.map(round => fetchClusterVPlot(chrom, start, end, {
        sizeBin: vplotSizeBin, posBin: vplotPosBin,
        sizeMin: vplotSizeMin, sizeMax: vplotSizeMax, logNorm: vplotLog, smooth: vplotSmooth,
        layer: vplotLayer, normalize: vplotNormalize, sampleSeed: analysisSampleSeed,
        mode: vplotMode, rowNormalize: vplotRowNormalize,
        clusterAssignments: round.assignments,
        panelGenome: viewGenome,
        signal: controller.signal,
      }).then(res => ({ round, res }))))
        .then(answers => {
          if (vplotRequestSeqRef.current !== requestSeq || controller.signal.aborted) return;
          // Each panel's V-plots, from the round that carried its assignments.
          const byPanel: Record<string, Record<number, ClusterVPlotData>> = {};
          for (const { round, res } of answers) {
            if (!res.success) continue;
            for (const [dsId, sk] of Object.entries(round.keyByDataset)) {
              if (res.data[dsId]) byPanel[sk] = res.data[dsId];
            }
          }
          setVplotEntry({ key, data: byPanel });
        })
        .catch(err => {
          if (controller.signal.aborted || err?.name === 'AbortError') return;
          if (vplotRequestSeqRef.current === requestSeq) {
            setVplotError(`V-plots could not be computed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
        .finally(() => {
          if (vplotRequestSeqRef.current === requestSeq && !controller.signal.aborted) {
            setVplotLoading(false);
          }
        });
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (vplotRequestSeqRef.current === requestSeq) vplotRequestSeqRef.current += 1;
      setVplotLoading(false);
    };
  }, [activeTab, hasClusterAssignments, vplotRequestKey]);

  // Changed settings (layer, bins, clusters…): the old plots aren't shown for them.
  const vplotData = vplotEntry?.key === vplotRequestKey ? vplotEntry.data : null;

  // Fetch reads for enrichment tab when activated
  const enabledRules = activeColormap.rules.filter(r => r.enabled);
  const hasRules = enabledRules.length > 0;

  useEffect(() => {
    if (activeTab !== 'enrichment' || !hasClusterAssignments || !hasRules) {
      enrichmentRequestSeqRef.current += 1;
      setEnrichmentLoading(false);
      return;
    }

    if (enrichmentRequestKey === enrichmentViewportKey && enrichmentReads) return;

    const controller = new AbortController();
    const requestSeq = ++enrichmentRequestSeqRef.current;
    const isCurrent = () => enrichmentRequestSeqRef.current === requestSeq && !controller.signal.aborted;
    const timer = setTimeout(async () => {
      if (!isCurrent()) return;
      setEnrichmentLoading(true);
      setEnrichmentError(null);
      try {
        const allReads: Record<string, CompactReadLike[]> = {};
        const ownGenes = chartView.followsMain ? Promise.resolve(null)
          : getGenes(chrom, start, end, { signal: controller.signal }, viewGenome).then(res => res.genes ?? []);
        // Fetch reads for each dataset.
        await Promise.all(actualDatasetIds.map(async (dsId) => {
          const params = new URLSearchParams({
            chrom, start: start.toString(), end: end.toString(), dataset_id: dsId,
            include_layers: 'true', layer_names: enrichmentLayers.join(','),
          });
          const data = await getCompactReads<{ reads?: CompactReadLike[] }>(
            params,
            { signal: controller.signal },
          );
          if (isCurrent()) {
            allReads[dsId] = data.reads || [];
          }
        }));
        const viewGenes = await ownGenes;
        if (isCurrent()) {
          setEnrichmentReads(allReads);
          setEnrichmentGenes(viewGenes);
          setEnrichmentViewportKey(enrichmentRequestKey);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (isCurrent()) {
          console.error('Enrichment reads fetch failed:', err);
          setEnrichmentError(err instanceof Error ? err.message : 'Could not load the reads for enrichment');
        }
      } finally {
        if (isCurrent()) setEnrichmentLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (enrichmentRequestSeqRef.current === requestSeq) enrichmentRequestSeqRef.current += 1;
      setEnrichmentLoading(false);
    };
  }, [activeTab, hasClusterAssignments, hasRules, enrichmentRequestKey, enrichmentViewportKey, enrichmentReads]);

  // Fetch the map while Overview shows it / settings change (debounced)
  useEffect(() => {
    if (!mapVisible || !hasClusterAssignments || analysisKeys.length === 0) {
      projectionRequestSeqRef.current += 1;
      setProjectionLoading(false);
      return;
    }
    const controller = new AbortController();
    const requestSeq = ++projectionRequestSeqRef.current;
    const isCurrent = () => projectionRequestSeqRef.current === requestSeq && !controller.signal.aborted;
    const wantSimulate = projectionView !== 'before';
    const requestKey = projectionFullKey;
    // The inputs this map is drawn from, for the exports that reuse it: the
    // plotted view's (a panel's own locus and reference, else the main view).
    const mapPanelId = chartView.followsMain ? null : chartView.panelId;
    const inputSignature = projectionInputSignature({ ...useBrowserStore.getState(), chrom, start, end, genome: viewGenome ?? null });
    const timer = setTimeout(async () => {
      if (!isCurrent()) return;
      setProjectionLoading(true);
      setProjectionError(null);
      try {
        // The same peaks Merge uses (see peakRegions); none falls back to the
        // peaks stored with the dataset's clustering on the server.
        const result = await fetchClusterProjection(
          chrom, start, end,
          projectionDatasetIds,
          peakRegions,
          projectionMethod,
          spanningOnly,
          {
            simulateAutocull: wantSimulate,
            minFraction: projectionMinFraction,
            maxCosineSimilarity: projectionMaxCosine,
            mergeStrategy: mergeSettings.strategy,
            mergeThreshold: mergeSettings.threshold,
            subnucleosomalThreshold,
            accessibilityThreshold,
            sampleSeed: analysisSampleSeed,
            clusterFeatureRules,
            clusterAssignments: projectionRound?.assignments ?? {},
            panelGenome: viewGenome,
            signal: controller.signal,
          }
        );
        if (isCurrent()) {
          setProjectionFetched({ key: requestKey, data: result });
          // Kept for the cluster-assignment export and the session, tagged with
          // the inputs that shaped it (a different map replaces or clears it).
          useBrowserStore.getState().setReadProjection(result.n_reads > 0
            ? indexProjection(result, { chrom, start, end, panelId: mapPanelId, genome: viewGenome ?? null }, inputSignature)
            : null);
        }
      } catch (err: any) {
        if (isCurrent() && err?.name !== 'AbortError') {
          console.error('Projection fetch failed:', err);
          setProjectionError(err?.message || 'Projection failed');
          useBrowserStore.getState().setReadProjection(null);
        }
      } finally {
        if (isCurrent()) setProjectionLoading(false);
      }
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (projectionRequestSeqRef.current === requestSeq) projectionRequestSeqRef.current += 1;
      setProjectionLoading(false);
    };
  }, [mapVisible, hasClusterAssignments, analysisKeys.length, projectionFullKey]);

  // Export: the shown map again (from the server's cache), with each DAF read's strand.
  const exportProjection = useCallback(async () => {
    const shown = projectionFetched?.key === projectionFullKey ? projectionFetched.data : null;
    if (!shown || shown.n_reads === 0) return;
    let data = shown;
    try {
      data = await fetchClusterProjection(
        chrom, start, end, projectionDatasetIds, peakRegions, projectionMethod, spanningOnly,
        {
          subnucleosomalThreshold,
          accessibilityThreshold,
          sampleSeed: analysisSampleSeed,
          clusterFeatureRules,
          clusterAssignments: projectionRound?.assignments ?? {},
          includeStrands: true,
          panelGenome: viewGenome,
        },
      );
    } catch (err) {
      console.error('Projection export: strands unavailable, exporting without them', err);
    }
    // Provenance: the merge preview's settings, and the merges behind the clusters on show.
    const st = useBrowserStore.getState();
    const mergeStatus = mergeLogStatus(st.clusterMergeLog, st.clusterAssignments);
    const mergeProvenance: Record<string, unknown> = {
      ...(projectionView !== 'before' ? {
        merge_strategy: mergeSettings.strategy,
        merge_threshold: mergeSettings.threshold,
        merge_min_fraction: mergeSettings.minFraction,
      } : {}),
      ...(mergeStatus === 'merged' && st.clusterMergeLog ? {
        cluster_merges: st.clusterMergeLog.steps.map(step => `${step.label}${step.settings ? ` (${describeMergeSettings(step.settings)})` : ''}`).join('; '),
      } : {}),
      ...(mergeStatus === 'original' ? { cluster_merges: 'none (shown before merging)' } : {}),
    };
    downloadTextFile(
      // fb-n3-export: the grouping on show (After / side by side) and the map's reference.
      formatProjectionTsv(data, { reference: referenceAt(st, { chrom, start, end }, data.dataset_ids), ...mergeProvenance }, { view: projectionView, shown }),
      projectionFilename(data.method, chrom, start, end),
      'text/tab-separated-values',
    );
  }, [accessibilityThreshold, analysisSampleSeed, chrom, clusterFeatureRules, end, peakRegions, projectionDatasetIds,
      projectionFetched, projectionFullKey, projectionMethod, projectionRound, projectionView, spanningOnly, start, subnucleosomalThreshold, viewGenome,
      mergeSettings]);

  // Export data (fb-r4-export): while a map is shown, its Projection coordinates entry downloads it directly.
  const exportProjectionRef = useRef(exportProjection);
  exportProjectionRef.current = exportProjection;
  const shownProjection = projectionFetched?.key === projectionFullKey ? projectionFetched.data : null;
  useEffect(() => {
    if (!shownProjection || shownProjection.n_reads === 0) return;
    registerDataExport({
      ...CLUSTER_PROJECTION_PLACEHOLDER,
      action: 'download',
      description: 'The map shown in Clusters > Projection: each read\'s x/y, cluster and strand, with the map\'s settings as # lines.',
      available: () => ({ ok: true, detail: `${shownProjection.n_reads.toLocaleString()} reads on the ${shownProjection.method || 'projection'} map` }),
      run: () => exportProjectionRef.current(),
    });
    return () => { registerDataExport(CLUSTER_PROJECTION_PLACEHOLDER); };
  }, [shownProjection]);

  // Enrichment counts each molecule once: panels showing the same dataset with
  // the same clustering are one cohort, and a copy clustered differently (its
  // cluster IDs mean other groups) is left out, with a note, rather than pooled.
  const enrichmentCohorts = useMemo(() => {
    const cohorts = clusterCohorts(analysisKeys, stateKeyToDs, clusterAssignments);
    return {
      keys: cohorts.filter(c => c.copyIndex === 0).map(c => c.stateKey),
      separate: cohorts.filter(c => c.copyIndex > 0).length,
    };
  }, [analysisKeys, stateKeyToDs, clusterAssignments]);
  const enrichmentCopyNote = enrichmentCohorts.separate > 0
    ? `${enrichmentCohorts.separate} panel${enrichmentCohorts.separate !== 1 ? 's' : ''} showing a dataset again with ${enrichmentCohorts.separate !== 1 ? 'their' : 'its'} own clustering ${enrichmentCohorts.separate !== 1 ? 'are' : 'is'} left out: each molecule is counted once.`
    : null;

  // Compute per-cluster enrichment from cached reads
  const enrichmentData = useMemo(() => {
    if (!enrichmentReads || !hasClusterAssignments || !hasRules) return null;
    // Only reads fetched for the current rules, layers and view: after a
    // change (or a failed refresh) older reads would undercount matches.
    if (enrichmentViewportKey !== enrichmentRequestKey) return null;

    const ruleCtx = buildRuleMatchContext(enrichmentGenes ?? genes, getAllPeaks(), orthogonalTracksForRules, start, end, activeColormap.rules, chrom);
    // Merge results across datasets/stateKeys
    const merged = new Map<string, Map<number, EnrichmentResult>>();
    for (const rule of enabledRules) {
      merged.set(rule.id, new Map());
    }

    for (const sk of enrichmentCohorts.keys) {
      const dsId = stateKeyToDs[sk] || sk;
      const reads = enrichmentReads[dsId];
      if (!reads) continue;
      const assignments = clusterAssignments[sk];
      if (!assignments || Object.keys(assignments).length === 0) continue;

      const result = computePerClusterEnrichment(reads, enabledRules, assignments, ruleCtx);
      // Merge into combined results
      for (const [ruleId, clusterMap] of result) {
        const mergedMap = merged.get(ruleId)!;
        for (const [cluster, entry] of clusterMap) {
          const existing = mergedMap.get(cluster);
          if (existing) {
            existing.matched += entry.matched;
            existing.total += entry.total;
          } else {
            mergedMap.set(cluster, { ...entry });
          }
        }
      }
    }

    return merged;
  }, [enrichmentReads, enrichmentGenes, hasClusterAssignments, hasRules, genes, getAllPeaks, orthogonalTracksForRules,
      start, end, activeColormap, enabledRules, enrichmentCohorts, stateKeyToDs, clusterAssignments,
      enrichmentViewportKey, enrichmentRequestKey]);


  const handleDissolve = useCallback(async (clusterToDissolve: number) => {
    const { keys, leftOut: skipped, view, peakRegions: mergePeaks, rounds } = mergeInputsNow();
    if (keys.length === 0) return;

    setDissolving(clusterToDissolve);
    const before = clusteringBeforeMerge();
    const changedKeys: string[] = [];
    // Whatever was applied (even if a later round fails) is one undo step, and Unmerge can revert it.
    let finished = false;
    const finish = () => {
      if (finished || changedKeys.length === 0) return;
      finished = true;
      // The reassignment model still has the dissolved cluster; left on, the
      // next pan would bring it back (as after a manual merge).
      setDynamicClustering(false);
      recordAppliedMerge(before, changedKeys, { label: `Delete C${clusterToDissolve}`, kind: 'dissolve' });
      useBrowserStore.getState().pushSnapshot(`Dissolve cluster ${clusterToDissolve}`, { kind: 'clustering' });
    };
    try {
      let dissolvedAny = false;
      // One request per round: each panel of a dataset sends and gets back its own clusters.
      for (const round of rounds) {
        const res = await dissolveCluster(
          view.chrom, view.start, view.end,
          clusterToDissolve,
          round.assignments,
          mergePeaks,
          Object.keys(round.keyByDataset),
          spanningOnly,
          subnucleosomalThreshold,
          accessibilityThreshold,
          analysisSampleSeed,
          clusterFeatureRules,
          view.genome,
        );
        // Navigated, restored or changed meanwhile: these results are for other clusters.
        if (!mountedRef.current || !chartRoundStillCurrent(round, view, useBrowserStore.getState())) continue;
        if (!dissolvedAny) seedHistoryBaseline(useBrowserStore.getState(), 'Before dissolving cluster', 'clustering');
        dissolvedAny = true;
        for (const [dsId, result] of Object.entries(res.results)) {
          const sk = round.keyByDataset[dsId];
          if (!sk) continue;
          setClusterAssignments(sk, result.assignments);
          changedKeys.push(sk);
          const currentOrder = useBrowserStore.getState().clusterOrder[sk];
          if (currentOrder) {
            setClusterOrder(sk, currentOrder.filter(c => c !== clusterToDissolve));
          }
          if (useBrowserStore.getState().clusterFocus[sk]?.has(clusterToDissolve)) {
            setClusterFocus(sk, null);
          }
          useBrowserStore.getState().pruneClusterSelection(sk, [clusterToDissolve]);
        }
      }
      if (skipped > 0) console.info(`Dissolve: ${skipped} panel(s) at another locus left as they are.`);
      if (dissolvedAny) finish();
    } catch (err) {
      console.error('Dissolve failed:', err);
    } finally {
      finish();
      if (mountedRef.current) setDissolving(null);
    }
  }, [mergeInputsNow, spanningOnly,
      subnucleosomalThreshold, accessibilityThreshold, analysisSampleSeed, clusterFeatureRules, setClusterAssignments,
      setClusterOrder, setClusterFocus, setDynamicClustering]);

  const handleAutoCull = useCallback(async () => {
    const { keys, leftOut: skipped, view, peakRegions: mergePeaks, rounds } = mergeInputsNow();
    if (keys.length === 0) return;

    setCulling(true);
    setCullResult(null);
    // The stored settings: what the map previews is what merges.
    const settings = currentMergeSettings(useBrowserStore.getState());
    const before = clusteringBeforeMerge();
    const changedKeys: string[] = [];
    // Whatever was applied (even if a later round fails or the panel closes) is one undo step, and Unmerge can revert it.
    let finished = false;
    const finish = () => {
      if (finished || changedKeys.length === 0) return;
      finished = true;
      // The reassignment model still has the merged-away clusters (see dissolve).
      setDynamicClustering(false);
      recordAppliedMerge(before, changedKeys, { label: 'Merge similar clusters', kind: 'similar', settings });
      useBrowserStore.getState().pushSnapshot('Merge similar clusters', { kind: 'clustering' });
    };
    try {
      let merged = 0;
      let stale = false;
      let snapshotSeeded = false;
      for (const round of rounds) {
        const res = await autoCullClusters(
          view.chrom, view.start, view.end,
          round.assignments,
          mergePeaks,
          Object.keys(round.keyByDataset),
          spanningOnly,
          subnucleosomalThreshold,
          accessibilityThreshold,
          settings.minFraction,
          settings.maxSimilarity,
          analysisSampleSeed,
          clusterFeatureRules,
          view.genome,
          { strategy: settings.strategy, threshold: settings.threshold },
        );
        if (!mountedRef.current) return;
        if (!chartRoundStillCurrent(round, view, useBrowserStore.getState())) { stale = true; continue; }
        if (res.dissolved.length === 0) continue;
        if (!snapshotSeeded) seedHistoryBaseline(useBrowserStore.getState(), 'Before merging clusters', 'clustering');
        snapshotSeeded = true;
        merged += res.dissolved.length;
        const dissolvedIds = new Set(res.dissolved.map(d => d.cluster));
        for (const [dsId, result] of Object.entries(res.results)) {
          const sk = round.keyByDataset[dsId];
          if (!sk) continue;
          setClusterAssignments(sk, result.assignments);
          changedKeys.push(sk);
          const currentOrder = useBrowserStore.getState().clusterOrder[sk];
          if (currentOrder) {
            setClusterOrder(sk, currentOrder.filter(c => !dissolvedIds.has(c)));
          }
          setClusterFocus(sk, null);
          useBrowserStore.getState().pruneClusterSelection(sk, dissolvedIds);
        }
      }

      const note = skipped > 0 ? ` (${skipped} panel${skipped !== 1 ? 's' : ''} at another locus left as ${skipped !== 1 ? 'they are' : 'it is'})` : '';
      if (merged === 0) {
        setCullResult(stale ? 'Clusters changed meanwhile; not applied' : `Nothing to merge${note}`);
        setTimeout(() => setCullResult(null), 2000);
        return;
      }
      finish();
      setCullResult(`Merged ${merged} cluster${merged !== 1 ? 's' : ''}${note}`);
      setTimeout(() => setCullResult(null), 3000);
    } catch (err) {
      console.error('Auto-cull failed:', err);
      if (mountedRef.current) {
        setCullResult('Cull failed');
        setTimeout(() => setCullResult(null), 2000);
      }
    } finally {
      finish();
      if (mountedRef.current) setCulling(false);
    }
  }, [mergeInputsNow, spanningOnly,
      subnucleosomalThreshold, accessibilityThreshold, analysisSampleSeed, clusterFeatureRules, setClusterAssignments,
      setClusterOrder, setClusterFocus, setDynamicClustering]);

  // Every clustered panel's clusters (the cluster list, Profiles, Composition):
  // their counts per panel, the focus (the first panel's) and the picked clusters.
  const allScope = useMemo(
    () => scopedClusters(datasetIds, { clusterAssignments, clusterOrder, clusterFocus, selectedClusters }),
    [datasetIds, clusterAssignments, clusterOrder, clusterFocus, selectedClusters],
  );
  const clusterData = hasClusterAssignments ? allScope.clusters : [];
  const visibleClusterIds = allScope.focus;
  const visibleClusterData = hasClusterAssignments ? allScope.visible : [];
  const selectedClusterIds = allScope.selected;

  // The read map, the V-plots and Differences show (and focus or pick in) their
  // own panels only: a clustered panel they leave out (another locus or
  // reference, a second clustering of a dataset) is neither shown nor changed.
  const mapKeys = useMemo(() => Object.values(projectionRound?.keyByDataset ?? {}), [projectionRound]);
  const mapScope = useMemo(
    () => scopedClusters(mapKeys, { clusterAssignments, clusterOrder, clusterFocus, selectedClusters }),
    [mapKeys, clusterAssignments, clusterOrder, clusterFocus, selectedClusters],
  );
  const vplotScope = useMemo(
    () => scopedClusters(analysisKeys, { clusterAssignments, clusterOrder, clusterFocus, selectedClusters }),
    [analysisKeys, clusterAssignments, clusterOrder, clusterFocus, selectedClusters],
  );
  const differencesScope = useMemo(
    () => scopedClusters(enrichmentCohorts.keys, { clusterAssignments, clusterOrder, clusterFocus, selectedClusters }),
    [enrichmentCohorts.keys, clusterAssignments, clusterOrder, clusterFocus, selectedClusters],
  );

  // The read map and its legend focus clusters exactly as the cluster list does
  // (the read panel and charts show only the focused ones), in the map's panels.
  const focusFromMap = useCallback((cluster: number, additive: boolean) => {
    if (mapKeys.length === 0) return;
    const st = useBrowserStore.getState();
    const current = st.clusterFocus[mapKeys[0]] ?? null;
    const next = nextMapFocus(current, cluster, additive, mapScope.clusters.map(cd => cd.cluster));
    // One undo step per click, whatever the number of panels on the map.
    st.focusClustersIn(mapKeys, next, next ? `Focus ${[...next].sort((a, b) => a - b).map(c => `C${c}`).join(', ')}` : 'Show all clusters');
  }, [mapKeys, mapScope]);
  const clearMapFocus = useCallback(() => {
    const st = useBrowserStore.getState();
    // Nothing focused on the map's panels: nothing to clear (and no undo step).
    if (!mapKeys.some(key => st.clusterFocus[key] != null)) return;
    st.focusClustersIn(mapKeys, null, 'Show all clusters');
  }, [mapKeys]);
  const showReadInPanels = useCallback((readId: string) => {
    useReadActionsStore.getState().highlightReads([readId]);
  }, []);

  // Unmerge: the clusters merged into each cluster on show, to split back one at a time.
  const clusterMergeLog = useBrowserStore(s => s.clusterMergeLog);
  const mergedInto = useMemo(() => {
    if (mergeLogStatus(clusterMergeLog, clusterAssignments) !== 'merged') return {};
    const out: Record<number, MergedClusterInfo[]> = {};
    for (const info of mergedClusters(clusterMergeLog)) {
      if (info.target === null) continue;
      (out[info.target] ??= []).push(info);
    }
    return out;
  }, [clusterMergeLog, clusterAssignments]);
  const splitBack = useCallback((stepId: string, cluster: number) => {
    useBrowserStore.getState().splitBackMergedCluster(stepId, cluster);
  }, []);

  const proportionClusterData = useMemo(() => {
    const visibleSet = visibleClusterIds;
    if (selectedClusterIds.size > 0) {
      return clusterData.filter(cd =>
        selectedClusterIds.has(cd.cluster) && (!visibleSet || visibleSet.has(cd.cluster))
      );
    }
    return visibleClusterData;
  }, [clusterData, selectedClusterIds, visibleClusterData, visibleClusterIds]);

  const matchedComposition = useMemo(() => matchedRun ? matchedRunCounts(matchedRun).map(cd => ({ ...cd, color: getClusterColor(cd.cluster) })) : null, [matchedRun]);

  // Cross-dataset proportions
  const proportions = useMemo(() => {
    if (datasetIds.length < 2 || proportionClusterData.length === 0) return null;

    // Always use all assigned reads as the denominator. Restricting the
    // denominator to selected/visible clusters can turn a single selected
    // cluster into 100% in every dataset and defeats coverage-aware rate
    // comparisons.
    const totalsPerDs = datasetIds.map((_, i) =>
      clusterData.reduce((sum, cd) => sum + cd.counts[i], 0)
    );

    const result = new Map<number, number[]>();
    const counts = new Map<number, number[]>();
    const comparisonCounts = new Map<number, number[]>(
      clusterData.map(cd => [cd.cluster, [...cd.counts]]),
    );
    const colors = new Map<number, string>(
      clusterData.map(cd => [cd.cluster, cd.color]),
    );

    for (const cd of proportionClusterData) {
      const fractions = cd.counts.map((count, i) =>
        totalsPerDs[i] > 0 ? count / totalsPerDs[i] : 0
      );
      result.set(cd.cluster, fractions);
      counts.set(cd.cluster, [...cd.counts]);
    }

    const label = selectedClusterIds.size > 0
      ? 'Selected Cluster Proportions'
      : visibleClusterIds
        ? 'Visible Cluster Proportions'
        : 'Cluster Proportions';

    return {
      proportions: result,
      counts,
      comparisonCounts,
      comparisonClusterIds: clusterData.map(cd => cd.cluster),
      datasetTotals: totalsPerDs,
      colors,
      clusterIds: proportionClusterData.map(cd => cd.cluster),
      label,
    };
  }, [clusterData, datasetIds, proportionClusterData, selectedClusterIds.size, visibleClusterIds]);

  // Combined per-layer profiles per cluster for the overview sparkline —
  // averaged across datasets. Shape: { cluster → layerKey → number[] }. Each
  // overview card renders one overlay chart with one series per active
  // metaprofile layer, using the canonical layer colors. MUST be declared before
  // any early return — React requires the same hook calls in the same order
  // on every render.
  const combinedProfiles = useMemo(() => {
    const result: Record<number, Record<string, number[]>> = {};
    for (const cd of clusterData) {
      const byLayer: Record<string, number[]> = {};
      // Collect every layer key any dataset has for this cluster, then
      // average the profile across datasets per layer.
      const layerKeys = new Set<string>();
      for (const dsId of datasetIds) {
        const perCluster = clusterProfiles[dsId]?.[cd.cluster];
        if (perCluster) for (const k of Object.keys(perCluster)) layerKeys.add(k);
      }
      for (const layerKey of layerKeys) {
        const profiles = datasetIds
          .map(dsId => clusterProfiles[dsId]?.[cd.cluster]?.[layerKey])
          .filter((p): p is number[] => !!p);
        if (profiles.length === 0) continue;
        const len = profiles[0].length;
        const combined = new Array(len).fill(0);
        for (const p of profiles) {
          for (let i = 0; i < len; i++) combined[i] += p[i];
        }
        for (let i = 0; i < len; i++) combined[i] /= profiles.length;
        byLayer[layerKey] = combined;
      }
      if (Object.keys(byLayer).length > 0) result[cd.cluster] = byLayer;
    }
    return result;
  }, [clusterData, clusterProfiles, datasetIds]);

  useEffect(() => {
    if (!hasClusterAssignments) return;
    if (clusterTreeRootIds.length === 0) {
      captureActiveClusterTreeNode({ name: 'All reads' });
      return;
    }
    if (!activeClusterTreeNodeId && clusterTreeRootIds[0]) {
      // By itself (a split into panels or a strand copy cleared the active branch): an SV split it holds stays.
      applyClusterTreeNode(clusterTreeRootIds[0], { keepSameSvSplits: true });
    }
  }, [
    activeClusterTreeNodeId,
    applyClusterTreeNode,
    captureActiveClusterTreeNode,
    clusterTreeRootIds,
    hasClusterAssignments,
  ]);

  if (!hasClusterAssignments && savedClusters.length === 0) {
    return (
      <AnalysisStatus kind="empty" center className="flex h-full flex-col items-center justify-center p-4" icon={<ReadClusters size={20} />}>
        No clusters computed. Select peaks and click Cluster.
      </AnalysisStatus>
    );
  }

  // If no active clusters but have saved ones, force saved tab
  if (!hasClusterAssignments && savedClusters.length > 0 && activeTab !== 'saved') {
    // Use setTimeout to avoid setState during render
    setTimeout(() => setActiveTab('saved'), 0);
  }

  const multiDs = datasetIds.length > 1;
  const chartWidth = Math.max(200, containerWidth - 24);
  const profileHeight = 36;

  // Three top-level tabs (Overview, Charts, Saved), the charts as sub-tabs:
  // the bar fits a narrow panel, and every chart is one click from Charts.
  const chartTabs: Array<{ key: ClusterDetailTab; label: string }> = hasClusterAssignments ? [
    { key: 'profiles', label: 'Profiles' },
    { key: 'composition', label: 'Composition' },
    { key: 'vplot', label: 'V-Plot' },
    ...(hasRules ? [{ key: 'enrichment' as const, label: 'Differences' }] : []),
  ] : [];
  const isChartTab = chartTabs.some(tab => tab.key === activeTab);
  const selectChart = showTab;
  const clusterTabs: Array<{ key: ClusterDetailTab | 'charts'; label: string }> = [
    ...(hasClusterAssignments ? [
      { key: 'overview' as const, label: 'Overview' },
      { key: 'charts' as const, label: 'Charts' },
    ] : []),
    { key: 'saved' as const, label: savedClusters.length > 0 ? `Saved (${savedClusters.length})` : 'Saved' },
  ];
  const topTab: ClusterDetailTab | 'charts' = isChartTab ? 'charts' : activeTab;
  const onTopTabChange = (key: ClusterDetailTab | 'charts') => {
    if (key !== 'charts') { setActiveTab(key); return; }
    const last = lastChartTab;
    selectChart(chartTabs.some(tab => tab.key === last) ? last : 'profiles');
  };
  const clusterHeaderTitle = hasClusterAssignments
    ? `${clusterData.length} clusters`
    : 'Saved clusters';
  const clusterHeaderDetail = hasClusterAssignments
    ? `${clusteredReadTotal.toLocaleString()} assigned reads${multiDs ? ` · ${datasetIds.length} dataset views` : ''}`
    : `${savedClusters.length} saved snapshot${savedClusters.length !== 1 ? 's' : ''}`;
  const vplotLayerLabel = vplotLayer === null ? 'HMM calls' : (vplotLayer === 'msp' || vplotLayer === 'fire') ? 'Accessibility' : vplotLayer;
  const vplotSettingsSummary = `${vplotLayerLabel} · ${vplotSizeMin}-${vplotSizeMax}bp · ${vplotPosBin}bp bins`;

  return (
    <div ref={containerRef}>
      <AnalysisPanelShell
        tabs={clusterTabs}
        activeTab={topTab}
        onTabChange={onTopTabChange}
        theme="cyan"
        layout="standard"
        bodyMode="none"
        bodyClassName="!space-y-2"
        header={
          <AnalysisPanelHeader
            theme="cyan"
            title={clusterHeaderTitle}
            meta={clusterHeaderDetail}
            actions={hasClusterAssignments ? (
              <>
                {clusterData.length > 2 && (
                  <AnalysisButton
                    variant={cullResult ? 'success' : 'warning'}
                    onClick={handleAutoCull}
                    disabled={culling || dissolving !== null}
                    data-copilot-anchor="cluster-panel-auto-cull"
                    title={`Merge clusters ${describeMergeSettings(mergeSettings)}: the smaller of two alike clusters goes, its reads to the nearest remaining cluster. Unmerge switches back.`}
                  >
                    {culling ? 'Merging…' : cullResult || 'Merge similar clusters'}
                  </AnalysisButton>
                )}
                {clusterData.length > 2 && (
                  <AnalysisButton
                    variant="outline"
                    onClick={() => { showTab('projection'); setProjectionView('side-by-side'); setShowMergeSettings(true); }}
                    data-testid="merge-settings-button"
                    title="Merge settings: how clusters are judged alike, the smallest cluster size, and a preview on the read map before merging"
                    aria-label="Merge settings"
                    className="inline-flex items-center"
                  >
                    <Sliders size={12} />
                  </AnalysisButton>
                )}
                <AnalysisButton
                  theme="cyan"
                  variant={saveFeedback ? 'success' : 'soft'}
                  onClick={() => {
                    saveCurrentClustering();
                    setSaveFeedback(true);
                    setTimeout(() => setSaveFeedback(false), 2000);
                  }}
                  title="Snapshot current clustering to cart"
                  data-tour="cluster-snapshot"
                >
                  {saveFeedback ? <span className="inline-flex items-center gap-1"><Check size={11} strokeWidth={2.5} aria-hidden="true" />Snapshotted</span> : 'Snapshot'}
                </AnalysisButton>
              </>
            ) : undefined}
          />
        }
        summary={hasClusterAssignments ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300" data-testid="cluster-dynamic-row">
              <label
                className="inline-flex items-center gap-1"
                title="Keep every read in its nearest cluster as you move along the genome (reads spanning the clustered peaks are matched to the stored cluster patterns). Reads that overlap none of the clustered peaks go to Unassigned."
              >
                <input
                  type="checkbox"
                  checked={dynamicClustering}
                  onChange={e => setDynamicClustering(e.target.checked)}
                  data-testid="cluster-dynamic-toggle"
                  data-copilot-anchor="cluster-dynamic-toggle"
                />
                Dynamic reassignment
              </label>
              {dynamicClustering && (
                <span data-copilot-anchor="cluster-dynamic-overlap">
                  <AnalysisSelect
                    value={dynamicOverlapMode}
                    onChange={value => setDynamicOverlapMode(value as 'conservative' | 'aggressive')}
                    options={[
                      { value: 'conservative', label: 'Conservative' },
                      { value: 'aggressive', label: 'Aggressive' },
                    ]}
                    selectClassName="text-[11px] py-0"
                    title="Conservative: a read must overlap every clustered peak to be reassigned (else Unassigned). Aggressive: a read overlapping any of them is assigned by the peaks it does overlap."
                  />
                </span>
              )}
            </span>
            <AnalysisRunSummary
              seed={analysisSampleSeed}
              analysisCap={analysisSampleCount}
              showAnalysisCap
              filterActive={visibleClusterIds !== null}
              filterLabel={visibleClusterIds ? 'Cluster focus' : 'Filtered'}
              filterSource={visibleClusterIds !== null ? 'cluster-detail' : null}
              filterSourceLabel="Clusters"
              qualityFilterCount={enabledQualityFilterCount}
              peaksLocked={peaksLocked}
              inputs={[
                `${datasetIds.length} dataset view${datasetIds.length !== 1 ? 's' : ''}`,
                `${peakRegions.length} peak region${peakRegions.length !== 1 ? 's' : ''}`,
                `${clusteredReadTotal.toLocaleString()} assigned reads`,
              ]}
              outputs={[
                `${clusterData.length} cluster${clusterData.length !== 1 ? 's' : ''}`,
                visibleClusterIds ? `${visibleClusterData.length} focused` : 'all clusters visible',
              ]}
            />
            <ClusterFocusBadge
              active={visibleClusterIds !== null}
              theme="cyan"
              label={visibleClusterIds ? `Showing ${visibleClusterIds.size}/${clusterData.length}` : undefined}
            />
            {!mapVisible && <MergeToggleChip />}
          </div>
        ) : undefined}
      >

      {(runResult || matchedRun?.details) && (
        <div className={`px-2 py-1 text-[11px] ${runResult?.tone === 'error' ? 'text-red-700 dark:text-red-300'
          : runResult?.tone === 'note' ? 'text-amber-700 dark:text-amber-300' : 'text-ink-secondary'}`} data-testid="cluster-detail-run-note">
          {runResult?.tone === 'error' ? runResult.text : matchedRun?.details ?? runResult?.text}
          {matchedRun?.groups.filter(id => matchedGroupIds.includes(id)).map(id => <button key={id} type="button" className="ml-1 underline" data-testid={`cluster-open-panels-${id}`}
            onClick={() => openRegionPanels(id)}>Open as panels</button>)}
          {runResult?.action && <button type="button" className="ml-1 underline" data-testid="cluster-detail-run-action"
            onClick={() => useBrowserStore.getState().openAnalysisPanel(runResult.action!.panel)}>{runResult.action.label}</button>}
        </div>
      )}

      {/* The branch tree only once there is more than one branch: a lone
          "All reads" root repeats the header. */}
      {hasClusterAssignments && hasClusterBranches(clusterTreeNodes, clusterTreeRootIds) && (
        <ClusterBranchMap
          nodes={clusterTreeNodes}
          rootIds={clusterTreeRootIds}
          activeId={activeClusterTreeNodeId}
          onSelect={id => applyClusterTreeNode(id)}
          onDelete={deleteClusterTreeNode}
          onRename={renameClusterTreeNode}
        />
      )}

      {/* === Overview tab === */}
      {isChartTab && (
        <AnalysisSubTabBar tabs={chartTabs} activeTab={activeTab} onTabChange={selectChart} label="Chart" theme="cyan" />
      )}
      {/* Deep links, the tour and Copilot ask for 'projection': the map in Overview. */}
      {/* One group keeps the map target from covering the first chart target. */}
      {hasClusterAssignments && (
        <HiddenTabTargets tabs={[
          ...(!isChartTab ? chartTabs : []),
          { key: 'projection' as const, label: 'Map' },
        ]} onTabChange={showTab} />
      )}
      {activeTab === 'overview' && hasClusterAssignments && (() => {
        const options = overviewModeOptions(containerWidth);
        const shown = overviewShown;
        const bodyWidth = Math.max(240, containerWidth - 24);
        const columns = shown === 'both' ? overviewColumns(bodyWidth) : null;
        const listWidth = columns ? columns.list : bodyWidth;
        const mapWidth = columns ? columns.map : bodyWidth;
        const maxMapHeight = typeof window !== 'undefined' ? Math.max(320, Math.min(760, window.innerHeight - 260)) : 640;
        const overview = (
          <OverviewTabContent
            clusterData={clusterData}
            datasetIds={datasetIds}
            multiDs={multiDs}
            clusterFocus={clusterFocus}
            setClusterFocus={setClusterFocus}
            clusterOrder={clusterOrder}
            setClusterOrder={setClusterOrder}
            selectedClusters={selectedClusters}
            setClusterSelection={setClusterSelection}
            toggleClusterSelection={toggleClusterSelection}
            clearClusterSelection={clearClusterSelection}
            mergeSelectedClusters={mergeSelectedClusters}
            combinedProfiles={combinedProfiles}
            enabledMetaProfiles={enabledMetaProfiles}
            proportions={proportions}
            chartWidth={Math.max(200, listWidth - 12)}
            containerWidth={listWidth + 8}
            profileHeight={profileHeight}
            isReversed={isReversed}
            dissolving={dissolving}
            onDissolve={handleDissolve}
            getDatasetLabel={sk => keyLabel(sk) || sk}
            mergedInto={mergedInto}
            onSplitBack={splitBack}
          />
        );
        const map = (
          <ProjectionMap
            projectionData={projectionData}
            projectionLoading={projectionLoading}
            projectionError={projectionError}
            projectionNote={projectionNote}
            projectionMethod={projectionMethod}
            setProjectionMethod={setProjectionMethod}
            projectionView={projectionView}
            setProjectionView={setProjectionView}
            projectionHighlightDs={projectionHighlightDs}
            setProjectionHighlightDs={setProjectionHighlightDs}
            merge={mergeSettings}
            onMergeSettings={onMergeSettings}
            showMergeSettings={showMergeSettings}
            setShowMergeSettings={setShowMergeSettings}
            width={mapWidth}
            maxHeight={maxMapHeight}
            datasets={datasets.filter(d => projectionDatasetIds.includes(d.id))}
            onApplyAutocull={handleAutoCull}
            culling={culling}
            onExport={exportProjection}
            clusters={mapScope.clusters}
            focus={mapScope.focus}
            selected={mapScope.selected}
            onFocusCluster={focusFromMap}
            onClearFocus={clearMapFocus}
            onShowRead={showReadInPanels}
          />
        );
        return (
          <>
            <div className="flex items-center gap-2" data-testid="cluster-overview-mode">
              <AnalysisToggleGroup
                value={shown}
                onChange={value => { if (value) setOverviewMode(value); }}
                theme="cyan"
                options={options.map(mode => ({
                  value: mode,
                  label: OVERVIEW_MODE_LABELS[mode],
                  title: mode === 'profiles'
                    ? 'Each cluster with its average profile'
                    : mode === 'map'
                      ? 'The read map (t-SNE): each read a dot, coloured by cluster'
                      : 'The cluster profiles beside the read map',
                }))}
              />
              {shown !== 'profiles' && (
                <span className="text-[11px] text-ink-secondary">Clicking a cluster on the map focuses it everywhere</span>
              )}
            </div>
            {shown === 'profiles' && overview}
            {shown === 'map' && map}
            {shown === 'both' && (
              <div className="flex items-start gap-3" data-testid="cluster-overview-both">
                <div className="shrink-0 space-y-2" style={{ width: listWidth }}>{overview}</div>
                <div className="min-w-0 flex-1">{map}</div>
              </div>
            )}
          </>
        );
      })()}

      {/* === Profiles tab === */}
      {/* One chart per actively-displayed metaprofile layer, nested under
          each dataset. Metaprofile layers are managed with the track settings. */}
      {activeTab === 'profiles' && (
        <ProfilesTabContent
          datasetIds={datasetIds}
          multiDs={multiDs}
          visibleClusterData={visibleClusterData}
          clusterProfiles={clusterProfiles}
          enabledMetaProfiles={enabledMetaProfiles}
          chartWidth={chartWidth}
          isFullView={isFullView}
          isReversed={isReversed}
          getDatasetLabel={sk => keyLabel(sk)}
          getDatasetColor={sk => keyColor(sk)}
        />
      )}

      {/* === Composition tab === */}
      {activeTab === 'composition' && (
        <CompositionTabContent
          datasetIds={matchedRun ? matchedRun.windows.map(w => w.key) : datasetIds}
          multiDs={matchedRun ? matchedRun.windows.length > 1 : multiDs}
          visibleClusterData={matchedComposition ?? visibleClusterData}
          allClusterData={matchedComposition ?? clusterData}
          chartWidth={chartWidth}
          isFullView={isFullView}
          getDatasetLabel={sk => matchedRun?.windows.find(w => w.key === sk)?.label ?? keyLabel(sk)}
        />
      )}

      {/* === V-Plot tab === */}
      {(activeTab === 'vplot' || activeTab === 'enrichment') && offLocusNote && (
        <div className="px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300" data-testid="cluster-detail-off-locus-note">
          {offLocusNote}
        </div>
      )}
      {activeTab === 'vplot' && (
        <VPlotTabContent
          vplotData={vplotData}
          vplotError={vplotError}
          vplotLoading={vplotLoading}
          showVplotSettings={showVplotSettings}
          setShowVplotSettings={setShowVplotSettings}
          vplotSettingsSummary={vplotSettingsSummary}
          vplotSizeBin={vplotSizeBin}
          setVplotSizeBin={setVplotSizeBin}
          vplotPosBin={vplotPosBin}
          setVplotPosBin={setVplotPosBin}
          vplotSizeMin={vplotSizeMin}
          setVplotSizeMin={setVplotSizeMin}
          vplotSizeMax={vplotSizeMax}
          setVplotSizeMax={setVplotSizeMax}
          vplotLog={vplotLog}
          setVplotLog={setVplotLog}
          vplotSmooth={vplotSmooth}
          setVplotSmooth={setVplotSmooth}
          vplotNormalize={vplotNormalize}
          setVplotNormalize={setVplotNormalize}
          vplotLayer={vplotLayer}
          setVplotLayer={setVplotLayer}
          vplotMode={vplotMode}
          setVplotMode={setVplotMode}
          vplotRowNormalize={vplotRowNormalize}
          setVplotRowNormalize={setVplotRowNormalize}
          pickKeys={analysisKeys}
          start={start}
          end={end}
          datasetIds={analysisKeys}
          multiDs={analysisKeys.length > 1}
          visibleClusterData={vplotScope.visible}
          chartWidth={chartWidth}
          isFullView={isFullView}
          getDatasetLabel={sk => keyLabel(sk)}
          getDatasetColor={sk => keyColor(sk)}
        />
      )}

      {/* === Enrichment tab === */}
      {activeTab === 'enrichment' && enrichmentCopyNote && (
        <div className="px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300" data-testid="cluster-detail-enrichment-copy-note">
          {enrichmentCopyNote}
        </div>
      )}
      {activeTab === 'enrichment' && (
        <EnrichmentTabContent
          enrichmentData={enrichmentData}
          enrichmentLoading={enrichmentLoading}
          enrichmentError={enrichmentError}
          enabledRules={enabledRules}
          clusterData={differencesScope.visible}
          allClusterData={differencesScope.clusters}
          containerWidth={containerWidth}
          pickKeys={enrichmentCohorts.keys}
        />
      )}

      {/* === Saved tab === */}
      {activeTab === 'saved' && (
        <SavedClustersTab
          savedClusters={savedClusters}
          // Snapshots record the main locus (saveCurrentClustering).
          chrom={scopeState.chrom}
          start={scopeState.start}
          end={scopeState.end}
          editingNameId={editingNameId}
          setEditingNameId={setEditingNameId}
          updateSavedClusterName={updateSavedClusterName}
          restoreSavedCluster={restoreSavedCluster}
          removeSavedCluster={removeSavedCluster}
          clearSavedClusters={clearSavedClusters}
        />
      )}
      </AnalysisPanelShell>
    </div>
  );
}
