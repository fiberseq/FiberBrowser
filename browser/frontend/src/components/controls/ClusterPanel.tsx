import { useCallback, useEffect, useMemo, useState } from 'react';
import { sampledFitCount } from '../../utils/clusterPreparation';
import { FEATURE_FILTERS, FEATURE_SORT, featureNames, filterBySelectedFeatures, selectableKindsPhrase, selectedKindNotes, sortBySelectedFeatures, type FeatureFilterMode } from '../../utils/featureClustering';
import { FeatureSelectionChip, useFeaturesInView } from './FeatureSelectionChip';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { beginRun, setRunResult } from '../../stores/runResultStore';
import { autoCullClusters } from '../../api/clustering';
import { clusteringBeforeMerge, recordAppliedMerge, storedMergeSettings } from '../../utils/clusterMergeActions';
import { currentMergeSettings, describeMergeSettings } from '../../utils/mergeStrategies';
import { generateLayerColors } from '../../utils/peakColors';
import { CLUSTER_RULE_MODE_PREFIX } from '../../types';
import type { AnalysisFilterRule, AnalysisSortRule, PeakMode, ColorRule } from '../../types';
import {
  clusterRuleUsesSelectedPeaks,
  normalizeAnalysisRuleScope,
  resolveClusterFeatureRuleName,
  resolveClusterRuleRegions,
  summarizeAnalysisRuleScope,
} from '../../utils/analysisRules';
import { ListIcon, Peaks, Pencil, ReadClusters, Sliders, Trash, X } from '../ui/Icons';
import { ToolbarGroup, ToolbarRow, type ToolbarGroupSpec } from './ToolbarGroups';
import { ActionButton } from '../ui/ActionButton';
import { QualityQuickControls, QualitySummary } from './quality/QualityQuickControls';
import { AnalysisButton, AnalysisSelect } from './shared';
import { getCanonicalLayerEntries, getLayerLabel } from '../../utils/layerColors';
import { buildStateKeyToDs, useFocusedReadIds } from '../../hooks/useFocusedReadIds';
import { chartRoundStillCurrent, clusterMergeInputs } from './cluster-detail/clusterChartScope';
import { ReadDisplayToolbarControls } from './ReadDisplayToolbarControls';
import { LayerToggles } from './shared/LayerToggles';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { useAppCommand } from '../../hooks/useAppCommand';
import { HighlightToolbarGroup } from './HighlightToolbarGroup';
import { ClusterAppliesTo, useClusterTargetPlan } from './cluster/ClusterAppliesTo';
import { clusterRunHeadline } from '../../utils/clusterTargets';

/** Derive clustering/sort mode options from the loaded datasets' available layers.
 *
 * Rules:
 *   - Show `accessibility` (→ FIRE/accessibility) whenever accessible intervals
 *     or footprint-derived accessibility are available.
 *   - Show `nuc` (→ "Nuc" if TF layer present, else "FP") whenever ns/nl is
 *     available. Backend routes to layers.nuc or size-filtered primary.
 *   - Show `tf` (→ TF) ONLY when an explicit TF layer exists. Legacy
 *     size-threshold TF is noisy and already subsumed by FP/Nuc; we hide it
 *     to avoid confusion and duplicated entries.
 *   - Show `mod` when methylation is available.
 *   - Show arbitrary custom layers (fp_v2, pol2, ...) as their own options.
 */
export function deriveModeOptions(
  datasets: Array<{
    available_layers?: Partial<Record<string, boolean>>;
    derived_layers?: Record<string, { label?: string; source_layer?: string; sourceLayer?: string; color?: string | null }>;
  }>,
) {
  const options: { id: PeakMode; label: string }[] = [];
  const seen = new Set<string>();

  const has = (name: string) => datasets.some(d => d.available_layers?.[name]);
  const hasTf = has('tf');

  // FIRE is a real layer source when present; use the layer mode directly so
  // the toolbar label and backend mode agree. Keep the legacy accessibility
  // heuristic only for older footprint-only datasets.
  if (has('msp') || has('fire')) {
    options.push({ id: 'fire', label: getLayerLabel('fire') });
    seen.add('fire');
    seen.add('msp');
  } else if (has('nuc') || has('footprint')) {
    options.push({ id: 'accessibility', label: 'Accessibility' });
    seen.add('accessibility');
  }

  for (const entry of getCanonicalLayerEntries(datasets)) {
    let id = entry.key as PeakMode;
    if (entry.key === 'footprint') id = 'nuc';
    if (entry.key === 'm6a') seen.add('mod');
    if (seen.has(id)) continue;
    options.push({ id, label: entry.label });
    seen.add(id);
  }

  const skipAsCustom = new Set([
    'accessibility', 'nuc', 'tf', 'msp', 'fire', 'mod', 'modification',
    'footprint', 'm6a', 'm5c', 'deam',
  ]);
  for (const d of datasets) {
    if (!d.available_layers) continue;
    for (const [name, present] of Object.entries(d.available_layers)) {
      if (!present || skipAsCustom.has(name) || seen.has(name)) continue;
      options.push({ id: name, label: name });
      seen.add(name);
    }
  }

  if (options.length === 0) {
    options.push({ id: 'accessibility', label: 'Accessibility' });
  }

  return options;
}

const CLUSTER_METHODS: Array<{
  id: string; label: string; needsK: boolean; needsThreshold: boolean; needsResolution?: boolean; help?: string;
}> = [
  { id: 'combinatorial', label: 'Combinatorial', needsK: false, needsThreshold: true },
  { id: 'hdbscan', label: 'HDBSCAN', needsK: false, needsThreshold: false },
  { id: 'agglom', label: 'Hierarchical', needsK: false, needsThreshold: false },
  { id: 'minibatch', label: 'K-means (fast)', needsK: true, needsThreshold: false },
  { id: 'kmeans', label: 'K-means (exact)', needsK: true, needsThreshold: false },
  {
    id: 'graph',
    label: 'Neighbourhoods (t-SNE graph)',
    needsK: false,
    needsThreshold: false,
    needsResolution: true,
    help: 'Groups reads by the same nearest-neighbour graph the t-SNE map (Clusters > Projection) is drawn from, '
      + 'and picks the number of groups itself; resolution: higher gives more, smaller groups. Unlike k-means it '
      + 'is not misled by t-SNE\u2019s distorted distances and group sizes. The same reads and seed give the same groups.',
  },
];

/** Help for the Sort option "By projection (t-SNE)". */
export const SORT_BY_PROJECTION_HELP = 'Orders reads along the t-SNE map (Clusters > Projection): clusters follow a path '
  + 'across the map and each cluster\u2019s reads a nearest-neighbour path through it, so reads that are neighbours on the '
  + 'map sit next to each other here. Needs clusters.';

/** Peak strength tiers (layer 0-3 of a tiered peak rule). */
const PEAK_TIERS = ['Strong', 'Medium', 'Weak', 'Rare'];
/** Display order; overflowRank: which go to More first when the row is too narrow (least used first). */
const TOOLBAR_GROUPS: ToolbarGroupSpec[] = [
  { id: 'reads', overflowRank: 3 },
  { id: 'layers', overflowRank: 4 },
  { id: 'peaks', overflowRank: 6 },
  { id: 'cluster', overflowRank: 5 },
  { id: 'sort', overflowRank: 2 },
  { id: 'filter', overflowRank: 1 },
  { id: 'highlight', overflowRank: 1.5 },
  { id: 'quality', overflowRank: 0 },
];

interface ClusterPanelProps {
  onCluster: () => void;
  onSort: (sortBy: string, rule?: ColorRule, analysisSortRule?: AnalysisSortRule, options?: { preserveClusterOrder?: boolean }) => void;
  onFilter: (rule: AnalysisFilterRule) => void;
  onClearFilter: () => void;
  onScanPeaks?: () => void;
  scanning?: boolean;
  /** An automatic scan was stopped (its time budget): shown beside Scan until a scan runs or the view moves. */
  scanNote?: string | null;
  clustering?: boolean;
  sorting?: boolean;
}

export function ClusterPanel({
  onCluster,
  onSort,
  onFilter,
  onClearFilter,
  onScanPeaks,
  scanning,
  scanNote,
  clustering,
  sorting,
}: ClusterPanelProps) {
  const {
    selectedPeaks,
    chrom,
    start,
    end,
    clearPeakSelection,
    deleteSelectedPeaks,
    peakDrawMode,
    setPeakDrawMode,
    setPeakDrawStart,
    clusterAssignments,
    clusterOrder,
    selectedClusters,
    clusterFocus,
    clusterTreeNodes,
    activeClusterTreeNodeId,
    peakModes,
    setClusterAssignments,
    setClusterOrder,
    resetClusterState,
    clearClusterSelection,
    setClusterFocus,
    selectPeaksByLayer,
    openAnalysisPanel,
    activeColormap,
    clusterMethod,
    setClusterMethod,
    clusterPreparationCount,
    setClusterPreparationCount,
    clusterPreparationSamples,
    clusterK,
    setClusterK,
    clusterResolution,
    setClusterResolution,
    accessibilityThreshold,
    setAccessibilityThreshold,
    clusterPeakMode,
    setClusterPeakMode,
    subnucleosomalThreshold,
    spanningOnly,
    analysisSampleSeed,
    clusterFeatureRules,
    analysisSortRules,
    analysisFilterRules,
    filteredReadIds,
    selectedGenes,
    peakRules,
    peaksByRule,
    peaksLocked,
    togglePeaksLocked,
    getAllPeaks,
    datasets,
  } = useBrowserStore(useShallow(s => ({
    selectedPeaks: s.selectedPeaks,
    chrom: s.chrom,
    start: s.start,
    end: s.end,
    clearPeakSelection: s.clearPeakSelection,
    deleteSelectedPeaks: s.deleteSelectedPeaks,
    peakDrawMode: s.peakDrawMode,
    setPeakDrawMode: s.setPeakDrawMode,
    setPeakDrawStart: s.setPeakDrawStart,
    clusterAssignments: s.clusterAssignments,
    clusterOrder: s.clusterOrder,
    selectedClusters: s.selectedClusters,
    clusterFocus: s.clusterFocus,
    clusterTreeNodes: s.clusterTreeNodes,
    activeClusterTreeNodeId: s.activeClusterTreeNodeId,
    peakModes: s.peakModes,
    setClusterAssignments: s.setClusterAssignments,
    setClusterOrder: s.setClusterOrder,
    resetClusterState: s.resetClusterState,
    clearClusterSelection: s.clearClusterSelection,
    setClusterFocus: s.setClusterFocus,
    selectPeaksByLayer: s.selectPeaksByLayer,
    openAnalysisPanel: s.openAnalysisPanel,
    activeColormap: s.activeColormap,
    clusterMethod: s.clusterMethod,
    setClusterMethod: s.setClusterMethod,
    clusterPreparationCount: s.clusterPreparationCount,
    setClusterPreparationCount: s.setClusterPreparationCount,
    clusterPreparationSamples: s.clusterPreparationSamples,
    clusterK: s.clusterK,
    setClusterK: s.setClusterK,
    clusterResolution: s.clusterResolution,
    setClusterResolution: s.setClusterResolution,
    accessibilityThreshold: s.accessibilityThreshold,
    setAccessibilityThreshold: s.setAccessibilityThreshold,
    clusterPeakMode: s.clusterPeakMode,
    setClusterPeakMode: s.setClusterPeakMode,
    subnucleosomalThreshold: s.subnucleosomalThreshold,
    spanningOnly: s.spanningOnly,
    analysisSampleSeed: s.analysisSampleSeed,
    clusterFeatureRules: s.clusterFeatureRules,
    analysisSortRules: s.analysisSortRules,
    analysisFilterRules: s.analysisFilterRules,
    filteredReadIds: s.filteredReadIds,
    selectedGenes: s.selectedGenes,
    peakRules: s.peakRules,
    peaksByRule: s.peaksByRule,
    peaksLocked: s.peaksLocked,
    togglePeaksLocked: s.togglePeaksLocked,
    getAllPeaks: s.getAllPeaks,
    datasets: s.datasets,
  })));

  const { targetDatasetIds, targetStateKeys, stateKeyMap } = useFocusedReadIds();
  const stateKeyToDs = useMemo(() => buildStateKeyToDs(stateKeyMap), [stateKeyMap]);
  const clusteredStateKeys = useMemo(() => (
    targetStateKeys.filter(sk => clusterAssignments[sk] && Object.keys(clusterAssignments[sk]).length > 0)
  ), [clusterAssignments, targetStateKeys]);
  const [autoCulling, setAutoCulling] = useState(false);
  const [autoCullResult, setAutoCullResult] = useState<string | null>(null);
  const [lockClusterOrder, setLockClusterOrder] = useState(false);

  // Copilot bridge: the set_cluster_order_lock action drives this toggle.
  // lockClusterOrder is component-local useState (not in the store), so the
  // runner hands it off via a window event rather than a store action.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ locked?: boolean }>).detail;
      setLockClusterOrder(Boolean(detail?.locked));
    };
    window.addEventListener('fiberhmm:set-cluster-order-lock', handler);
    return () => window.removeEventListener('fiberhmm:set-cluster-order-lock', handler);
  }, []);

  const peakModeOptions = useMemo(() => deriveModeOptions(datasets), [datasets]);
  const enabledClusterFeatureRules = useMemo(
    () => clusterFeatureRules.filter(rule => rule.enabled && rule.terms.length > 0),
    [clusterFeatureRules],
  );
  const clusterModeOptions = useMemo(() => [
    ...peakModeOptions,
    ...enabledClusterFeatureRules.map(rule => ({
      id: `${CLUSTER_RULE_MODE_PREFIX}${rule.id}` as PeakMode,
      label: resolveClusterFeatureRuleName(rule),
    })),
  ], [peakModeOptions, enabledClusterFeatureRules]);
  const activeClusterRuleId = typeof clusterPeakMode === 'string' && clusterPeakMode.startsWith(CLUSTER_RULE_MODE_PREFIX)
    ? clusterPeakMode.slice(CLUSTER_RULE_MODE_PREFIX.length)
    : null;
  const activeClusterFeatureRule = activeClusterRuleId
    ? clusterFeatureRules.find(rule => rule.id === activeClusterRuleId)
    : undefined;
  const activeClusterScope = normalizeAnalysisRuleScope(activeClusterFeatureRule?.scope);

  useEffect(() => {
    if (clusterModeOptions.some(option => option.id === clusterPeakMode)) return;
    const fallback = clusterModeOptions[0]?.id;
    if (fallback) setClusterPeakMode(fallback);
  }, [clusterPeakMode, clusterModeOptions, setClusterPeakMode]);

  /** Sort dropdown: one entry per detected layer, showing "% <Layer>"
   *  (occupancy — fraction of scope covered by that layer). Scope is the
   *  selected peaks when present, else the full viewport.
   *
   *  Values: `occupancy@<layer>` so Browser.tsx parses the layer and sends
   *  sort_by='occupancy' with the layer param to the backend.
   */
  const sortOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (const m of peakModeOptions) {
      if (m.id === 'modification' || m.id === 'mod') continue;  // density is a separate concern
      out.push({ value: `occupancy@${m.id}`, label: `% ${m.label}` });
    }
    return out;
  }, [peakModeOptions]);

  // The choice the reads were last sorted by (restored with Undo and saved sessions).
  const sortSelection = useBrowserStore(s => s.sortSelection);
  const [sortBy, setSortBy] = useState(() => useBrowserStore.getState().sortSelection ?? 'occupancy@nuc');
  useEffect(() => {
    setSortBy(sortSelection ?? 'occupancy@nuc');
  }, [sortSelection]);
  const enabledAnalysisSortRules = useMemo(
    () => analysisSortRules.filter(rule => rule.enabled && rule.terms.length > 0),
    [analysisSortRules],
  );
  const enabledAnalysisFilterRules = useMemo(
    () => analysisFilterRules.filter(rule => rule.enabled && rule.terms.length > 0),
    [analysisFilterRules],
  );
  const [filterBy, setFilterBy] = useState('');
  const hasAppliedReadFilter = useMemo(
    // An empty set is an applied filter (one that matched nothing).
    () => Object.values(filteredReadIds).some(ids => ids != null),
    [filteredReadIds],
  );

  // Selected features (the channels above the reads): Cluster, Sort and Filter act on them.
  const selectedFeatures = useFeaturesInView();
  const hasFeatures = selectedFeatures.length > 0;
  const featureLabel = hasFeatures ? featureNames(selectedFeatures) : '';
  useEffect(() => {
    if (filterBy.startsWith('features:') && hasFeatures) return;
    if (filterBy && enabledAnalysisFilterRules.some(rule => rule.id === filterBy)) return;
    setFilterBy(enabledAnalysisFilterRules[0]?.id ?? '');
  }, [enabledAnalysisFilterRules, filterBy, hasFeatures]);

  /** Default color rules that are subsumed by explicit layers — hide from
   *  the sort dropdown when their layer is available to avoid duplicate
   *  entries like "TF" appearing both as a layer option and a rule option.
   */
  const ruleIdsSubsumedByLayers = useMemo(() => {
    const hide = new Set<string>();
    const has = (n: string) => datasets.some(d => d.available_layers?.[n]);
    if (has('tf')) {
      hide.add('tf');       // default "TF" rule: subsumed by TF layer
      hide.add('subnuc');   // default "Subnucleosomal" rule: subsumed by TF + nuc split
    }
    if (has('nuc') || has('footprint')) {
      hide.add('nuc');      // default "Nucleosome" rule: subsumed by nuc layer
    }
    return hide;
  }, [datasets]);

  const [featureSorting, setFeatureSorting] = useState(false);
  const sortBusy = sorting || featureSorting;
  const panelsForSort = useBrowserStore(s => s.panels);
  const sortKeys = targetStateKeys.filter(key => panelsForSort.some(p => p.contentType === 'dataset' && !p.collapsed && (p.stateKey ?? p.datasetId) === key));
  const sortClusteredKeys = clusteredStateKeys.filter(key => sortKeys.includes(key));
  const hasSortClusters = sortClusteredKeys.length > 0;
  const sortChoices = useMemo(() => {
    const layerLabels = new Set(sortOptions.map(option => option.label));
    const ruleOptions = activeColormap.rules
      .filter(r => r.enabled && !ruleIdsSubsumedByLayers.has(r.id))
      .map(rule => ({ value: `rule:${rule.id}`, label: layerLabels.has(`% ${rule.name}`) ? `% ${rule.name} (coloring rule)` : `% ${rule.name}` }));
    const taken = new Set([...layerLabels, ...ruleOptions.map(option => option.label)]);
    return [
      ...sortOptions, ...ruleOptions,
      ...(hasFeatures || sortBy === FEATURE_SORT ? [{ value: FEATURE_SORT, label: 'Membership at selected features' }] : []),
      ...enabledAnalysisSortRules.map(rule => ({ value: `analysis_sort_rule:${rule.id}`, label: taken.has(rule.name) ? `${rule.name} (sort rule)` : rule.name })),
      ...(hasSortClusters ? [{ value: 'similarity', label: 'Similarity' }, { value: 'projection', label: 'By projection (t-SNE)' }] : []),
    ];
  }, [sortOptions, activeColormap.rules, ruleIdsSubsumedByLayers, hasFeatures, sortBy, enabledAnalysisSortRules, hasSortClusters]);
  // A dataset without a nucleosome layer starts with one of its actual layers.
  useEffect(() => {
    if (datasets.length > 0 && !sortSelection && sortBy.startsWith('occupancy@') && !sortOptions.some(o => o.value === sortBy) && sortOptions.length) {
      setSortBy(sortOptions[0].value);
    }
  }, [datasets.length, sortSelection, sortBy, sortOptions]);
  const sortDisabledReason = !sortKeys.length ? 'Open a BAM or choose a read panel to sort.'
    : sortKeys.every(key => filteredReadIds[key]?.size === 0)
      ? 'No reads pass the filters in the target panels. Clear or change the filter first.'
    : sortBy === FEATURE_SORT && !hasFeatures ? 'Select features in the channels above the reads first.'
    : (sortBy === 'similarity' || sortBy === 'projection') && !hasSortClusters ? 'Cluster the target panels first, or choose another sort.'
    : sortBy === 'similarity' && lockClusterOrder ? 'Cluster order is locked. Unlock it to sort by similarity.'
    : sortBy === 'similarity' && sortClusteredKeys.every(key => new Set(Object.values(clusterAssignments[key])).size < 2)
      ? 'Similarity needs at least two clusters in a target panel. Choose another sort.'
    : !sortChoices.some(o => o.value === sortBy) ? 'This sort is no longer available. Choose a layer or an enabled rule.'
    : null;

  const handleSort = () => {
    if (sortBusy) return;
    if (sortDisabledReason) {
      setRunResult('sort', { tone: 'error', text: sortDisabledReason }, beginRun('sort'));
      return;
    }
    if (sortBy === FEATURE_SORT) {
      const run = beginRun('sort');
      setFeatureSorting(true);
      void sortBySelectedFeatures()
        .then(error => { if (error) setRunResult('sort', { tone: 'error', text: error }, run); })
        .finally(() => setFeatureSorting(false));
      return;
    }
    if (sortBy.startsWith('analysis_sort_rule:')) {
      const ruleId = sortBy.slice('analysis_sort_rule:'.length);
      const rule = enabledAnalysisSortRules.find(candidate => candidate.id === ruleId);
      if (rule) onSort(sortBy, undefined, rule, { preserveClusterOrder: lockClusterOrder });
      return;
    }
    if (sortBy.startsWith('rule:')) {
      const ruleId = sortBy.slice(5);
      const rule = activeColormap.rules.find(r => r.id === ruleId);
      if (rule) onSort('rule', rule, undefined, { preserveClusterOrder: lockClusterOrder });
    } else if (sortBy.startsWith('occupancy@')) {
      // Layer-aware occupancy sort: layer encoded after '@'
      onSort(sortBy, undefined, undefined, { preserveClusterOrder: lockClusterOrder });
    } else {
      onSort(sortBy, undefined, undefined, { preserveClusterOrder: lockClusterOrder });
    }
  };

  const handleFilter = () => {
    if (filterBy.startsWith('features:')) {
      void filterBySelectedFeatures(filterBy.slice('features:'.length) as FeatureFilterMode)
        .then(error => { if (error) useBrowserStore.getState().setError(error); });
      return;
    }
    const rule = enabledAnalysisFilterRules.find(candidate => candidate.id === filterBy);
    if (rule) onFilter(rule);
  };

  // The command bus (command palette, menu bar): the group buttons, where they could be clicked.
  useAppCommand('sort-reads', (args) => {
    // { by: 'projection' } (the palette's Sort reads by projection): that option, chosen and run.
    const by = (args as { by?: unknown } | undefined)?.by;
    if (by === 'projection') {
      if (sortBusy) return true;
      if (!hasSortClusters) {
        setRunResult('sort', { tone: 'error', text: 'Cluster the target panels first.' }, beginRun('sort'));
        return true;
      }
      setSortBy(by);
      onSort(by, undefined, undefined, { preserveClusterOrder: lockClusterOrder });
      return true;
    }
    handleSort();
    return true;
  });
  useAppCommand('filter-reads', () => {
    if (!enabledAnalysisFilterRules.some(candidate => candidate.id === filterBy) && !(filterBy.startsWith('features:') && hasFeatures)) return false;
    handleFilter();
    return true;
  });

  const openAnalysisRulesTab = useCallback((tab: 'peaks' | 'cluster' | 'sort' | 'filter') => {
    window.sessionStorage.setItem('fiberbrowser_analysis_rules_tab', tab);
    openAnalysisPanel('cluster-features');
    window.dispatchEvent(new CustomEvent('fiberbrowser:open-analysis-rules-tab', { detail: { tab } }));
  }, [openAnalysisPanel]);

  const allPeaks = useMemo(() => getAllPeaks(), [peaksByRule, peakRules]);
  const activeRuleIgnoresSelectedPeaks = !!activeClusterFeatureRule && !clusterRuleUsesSelectedPeaks(activeClusterFeatureRule);
  const activeClusterRuleRegions = useMemo<Array<{ start: number; end: number; mode?: PeakMode }>>(() => {
    if (!activeClusterFeatureRule) return [];
    return resolveClusterRuleRegions(activeClusterFeatureRule, {
      allPeaks,
      selectedPeaks,
      peakModes,
      mode: clusterPeakMode,
      chrom,
      viewportStart: start,
      viewportEnd: end,
      selectedGenes,
    });
  }, [activeClusterFeatureRule, allPeaks, chrom, clusterPeakMode, end, peakModes, selectedGenes, selectedPeaks, start]);
  const activeRuleHasNoRegions = !!activeClusterFeatureRule && activeClusterRuleRegions.length === 0;
  // What the next run clusters on and where (utils/clusterTargets.ts clusterRunPlan): the plan the run follows, so the
  // button's tooltip, the Panels chip and the result line say what it does (round 3, R6/B5).
  const runPlan = useClusterTargetPlan();
  const canRunCluster = runPlan.basis.kind !== 'none';
  // A plan that would be refused (a targeted panel it can't include), or has no panel to cluster: Cluster is off and
  // says why, rather than running into a red "did not run" (round 4, Q7).
  const clusterBlockedReason = canRunCluster ? (runPlan.refusal ?? (runPlan.where === 'no panel' ? runPlan.summary : null))
    : activeClusterFeatureRule ? 'no regions in view'
      : runPlan.basis.unused ? `select peaks to cluster (${runPlan.basis.unused})`
        : allPeaks.length === 0 ? `scan peaks or select features (shift-click ${selectableKindsPhrase()}) first` : 'select peaks or features to cluster';
  // As the Scan and Cluster buttons: not while they would be disabled.
  useAppCommand('scan-peaks', () => {
    if (!onScanPeaks || peaksLocked || scanning) return false;
    void onScanPeaks();
    return true;
  });
  useAppCommand('cluster-reads', () => {
    if (clusterBlockedReason || clustering) return false;
    onCluster();
    return true;
  });
  // Merge similar clusters sends what the Clusters panel's map previews and its
  // own Merge button sends (clusterMergeInputs): the clustered panels showing
  // the charts' view, that view's locus, reference and peaks.
  const autoCullPeakCount = useBrowserStore(s => clusterMergeInputs(s, clusteredStateKeys, stateKeyToDs).peakRegions.length);
  const totalPeaks = allPeaks.length;
  const customRuleId = useBrowserStore(s => s.getCustomRuleId());
  const mergeSummary = useBrowserStore(s => describeMergeSettings(currentMergeSettings(s)));
  const customPeaks = peaksByRule[customRuleId] || [];
  const hasCustomSelected = [...selectedPeaks].some(i => customPeaks.some(p => p.index === i));
  const hasClusterAssignments = Object.values(clusterAssignments).some(a => Object.keys(a).length > 0);
  const selectedClusterCount = useMemo(
    () => clusteredStateKeys.reduce((sum, sk) => sum + (selectedClusters[sk]?.size ?? 0), 0),
    [clusteredStateKeys, selectedClusters],
  );
  const focusedClusterCount = useMemo(
    () => clusteredStateKeys.reduce((sum, sk) => sum + (clusterFocus[sk]?.size ?? 0), 0),
    [clusterFocus, clusteredStateKeys],
  );
  const activeClusterBranch = activeClusterTreeNodeId ? clusterTreeNodes[activeClusterTreeNodeId] : null;
  const clusterRunScopeLabel = selectedClusterCount > 0
    ? `${selectedClusterCount} selected cluster${selectedClusterCount === 1 ? '' : 's'}`
    : focusedClusterCount > 0
      ? `${focusedClusterCount} focused cluster${focusedClusterCount === 1 ? '' : 's'}`
      : activeClusterBranch?.parentId
        ? activeClusterBranch.name
        : null;
  const clusterRunLabel = clusterRunScopeLabel ? 'Subcluster' : 'Cluster';
  // "Cluster at 1 selected peak in Carriers · ticked SVs group reads only with Combinatorial": the plan, with the
  // layer (or state) notes of the features it uses, never of kinds that aren't selected.
  const clusterRunTitle = (() => {
    const { basis } = runPlan;
    const usedFeatures = basis.kind === 'feature-regions' || basis.kind === 'combinatorial' ? basis.features : [];
    const kindNotes = basis.kind === 'combinatorial' ? selectedKindNotes(usedFeatures, 'stateNote') : selectedKindNotes(usedFeatures, 'layerNote');
    const head = `${clusterRunHeadline(runPlan, clusterRunLabel)}${kindNotes.length ? ` (${kindNotes.join('; ')})` : ''}`
      + `${clusterRunScopeLabel ? ` within ${clusterRunScopeLabel}` : ''}`;
    return [head, ...runPlan.notes].join(' · ');
  })();
  const currentMethod = CLUSTER_METHODS.find(m => m.id === clusterMethod) || CLUSTER_METHODS[0];
  const canAutoCull = clusteredStateKeys.length > 0 && autoCullPeakCount > 0 && !autoCulling;

  const handleAutoCull = useCallback(async () => {
    if (!canAutoCull) return;

    setAutoCulling(true);
    setAutoCullResult(null);
    // Whatever was applied (even if a later round fails) is one undo step, and Unmerge can revert it.
    let changedKeys: string[] = [];
    let finish = () => {};
    let merged = 0;
    try {
      // The panels showing the charts' view (its locus and reference; the others
      // are left as they are); two panels of one dataset go in separate rounds
      // (one assignment map per dataset per request), and each round's result
      // goes back to its own panel only if that panel still shows that view and
      // its clusters are still the ones sent (not cleared, switched or merged meanwhile).
      const { view, peakRegions: mergePeaks, rounds, leftOut } = clusterMergeInputs(useBrowserStore.getState(), clusteredStateKeys, stateKeyToDs);
      let small = 0;
      let stale = false;
      let snapshotSeeded = false;
      const mergeSettings = storedMergeSettings();
      const before = clusteringBeforeMerge();
      changedKeys = [];
      finish = () => {
        if (changedKeys.length === 0) return;
        // The reassignment model still has the merged-away clusters; left on, the
        // next pan would bring them back (as after a manual merge).
        useBrowserStore.getState().setDynamicClustering(false);
        recordAppliedMerge(before, changedKeys, { label: 'Merge similar clusters', kind: 'similar', settings: mergeSettings });
        useBrowserStore.getState().pushSnapshot(`Merge ${merged} cluster${merged === 1 ? '' : 's'}`, { kind: 'clustering' });
        changedKeys = [];
      };
      for (const round of rounds) {
        const res = await autoCullClusters(
          view.chrom,
          view.start,
          view.end,
          round.assignments,
          mergePeaks,
          Object.keys(round.keyByDataset),
          spanningOnly,
          subnucleosomalThreshold,
          accessibilityThreshold,
          mergeSettings.minFraction,
          mergeSettings.maxSimilarity,
          analysisSampleSeed,
          clusterFeatureRules,
          view.genome,
          mergeSettings.mergeBy,
        );
        if (!chartRoundStillCurrent(round, view, useBrowserStore.getState())) { stale = true; continue; }
        if (res.dissolved.length === 0) continue;
        if (!snapshotSeeded) seedHistoryBaseline(useBrowserStore.getState(), 'Before merging clusters', 'clustering');
        snapshotSeeded = true;
        merged += res.dissolved.length;
        small += res.dissolved.filter(d => d.reason.startsWith('low abundance')).length;
        const dissolvedIds = new Set(res.dissolved.map(d => d.cluster));
        for (const [dsId, result] of Object.entries(res.results)) {
          const sk = round.keyByDataset[dsId];
          if (!sk) continue;
          setClusterAssignments(sk, result.assignments);
          changedKeys.push(sk);
          const currentOrder = useBrowserStore.getState().clusterOrder[sk];
          if (currentOrder) {
            setClusterOrder(sk, currentOrder.filter(clusterId => !dissolvedIds.has(clusterId)));
          }
          setClusterFocus(sk, null);
          useBrowserStore.getState().pruneClusterSelection(sk, dissolvedIds);
        }
      }

      const note = leftOut > 0 ? ` (${leftOut} panel${leftOut !== 1 ? 's' : ''} at another locus left as ${leftOut !== 1 ? 'they are' : 'it is'})` : '';
      if (merged === 0) {
        setAutoCullResult(stale ? 'Clusters changed meanwhile; not applied' : `Nothing to merge${note}`);
        setTimeout(() => setAutoCullResult(null), 2500);
        return;
      }

      const similar = merged - small;
      finish();
      setAutoCullResult([
        small ? `${small} small` : '',
        similar ? `${similar} alike` : '',
      ].filter(Boolean).join(' + ') + ` merged${note} · Unmerge in Clusters`);
      setTimeout(() => setAutoCullResult(null), 6000);
    } catch (err) {
      console.error('Auto-cull failed:', err);
      setAutoCullResult('Merge failed');
      setTimeout(() => setAutoCullResult(null), 3000);
    } finally {
      finish();
      setAutoCulling(false);
    }
  }, [
    accessibilityThreshold,
    analysisSampleSeed,
    canAutoCull,
    clusterFeatureRules,
    clusteredStateKeys,
    setClusterAssignments,
    setClusterFocus,
    setClusterOrder,
    spanningOnly,
    stateKeyToDs,
    subnucleosomalThreshold,
  ]);

  // Layer counts for peak selection buttons (across all rules with gradients)
  const accessibilityRule = peakRules.find(r => r.source === 'accessibility' && r.enabled);
  const accPeaks = accessibilityRule ? (peaksByRule[accessibilityRule.id] || []) : [];
  const accLayerColors = accessibilityRule ? generateLayerColors(accessibilityRule.color, accessibilityRule.opacity, accessibilityRule.useGradient) : [];
  const layerCounts = [0, 1, 2, 3].map(i =>
    accPeaks.filter((p: any) => p.layer === i).length
  );

  const rulesButton = (tab: 'peaks' | 'cluster' | 'sort' | 'filter', testId: string, what: string) => (
    <button
      type="button"
      data-testid={testId}
      onClick={() => openAnalysisRulesTab(tab)}
      className="fb-btn-ghost gap-1 px-1.5 py-[3px] text-[11px]"
      title={`${what}: open Rules › ${tab.charAt(0).toUpperCase()}${tab.slice(1)}`}
    >
      <Sliders size={12} aria-hidden="true" />
      Rules
    </button>
  );

  return (
    <ToolbarRow groups={TOOLBAR_GROUPS}>
      <ToolbarGroup id="reads" label="Reads" summary={<ReadDisplayToolbarControls mode="compact" />}>
        <ReadDisplayToolbarControls mode="advanced" />
      </ToolbarGroup>

      <ToolbarGroup id="layers" label="Layers" defaultOpen>
        <LayerToggles compact wrap />
      </ToolbarGroup>

      <ToolbarGroup
        id="peaks"
        label="Peaks"
        summary={(
          <>
            {/* Fixed minimum widths: these change on every navigation (none /
                scanning / N of M), and a changing width re-wraps the toolbar. */}
            <span className="inline-block min-w-[6rem] text-gray-600 dark:text-gray-400">
              {totalPeaks === 0 ? (scanNote && !scanning ? '' : 'none') : `${selectedPeaks.size} of ${totalPeaks} selected`}
              {customPeaks.length > 0 && (
                <span className="text-amber-600 ml-1">({customPeaks.length} custom)</span>
              )}
              {scanNote && !scanning && (
                <span role="status" data-testid="peak-scan-stopped" className={`text-amber-700 dark:text-amber-400${totalPeaks ? ' ml-1' : ''}`}>{scanNote}</span>
              )}
            </span>
          </>
        )}
        action={(
          <>
            {onScanPeaks && (
              <ActionButton
                data-testid="peak-scan-button"
                data-copilot-anchor="scan-peaks-button"
                tone="peaks"
                icon={<Peaks size={13} aria-hidden="true" />}
                onClick={() => onScanPeaks()}
                busy={scanning}
                disabledReason={peaksLocked ? 'Unlock peaks before scanning new peaks' : null}
                className="min-w-[4.75rem]"
                title="Scan this view for peaks (all enabled peak rules)"
              >
                {/* Its label stays while busy (the spinner and the status bar's "Scanning peaks…" say it): a wider
                    "Scanning…" moved Quality to the next toolbar row and back on every pan (round 3). */}
                Scan
              </ActionButton>
            )}
          </>
        )}
      >
        {/* Select every peak of one strength tier (from the accessibility rule). */}
        {accPeaks.length > 0 && accLayerColors.length > 0 && (
          <div className="flex items-center gap-1" role="group" aria-label="Select peaks by strength">
            <span className="text-[11px] text-ink-muted">Select</span>
            {accLayerColors.map((lc, i) => (
              <button
                key={i}
                type="button"
                onClick={() => selectPeaksByLayer(i)}
                disabled={layerCounts[i] === 0}
                className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-white/10 dark:text-gray-200 dark:hover:bg-white/10"
                title={`Select all ${PEAK_TIERS[i]?.toLowerCase() ?? `layer ${i}`} peaks (${layerCounts[i]})`}
                data-testid={`peak-select-tier-${i}`}
              >
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm border" style={{ backgroundColor: lc.fill, borderColor: lc.stroke }} />
                {PEAK_TIERS[i] ?? `Layer ${i}`}
                <span className="tabular-nums text-ink-muted">{layerCounts[i]}</span>
              </button>
            ))}
          </div>
        )}

        <AnalysisButton
          data-testid="peak-lock-toggle"
          data-copilot-anchor="peaks-lock-toggle"
          aria-pressed={peaksLocked}
          onClick={togglePeaksLocked}
          disabled={!peaksLocked && totalPeaks === 0}
          theme="amber"
          variant={peaksLocked ? 'primary' : 'soft'}
          size="sm"
          className="px-2.5"
          title={peaksLocked
            ? 'Unlock peaks to allow automatic or manual rescanning'
            : 'Lock the current detected and selected peaks; autoscan and rescan will not replace them'}
        >
          {peaksLocked ? 'Locked' : 'Lock'}
        </AnalysisButton>

        {rulesButton('peaks', 'peak-rules-button', 'Peak detection rules')}

        {/* Draw peak toggle */}
        {peakDrawMode ? (
          <AnalysisButton
            data-testid="peak-draw-cancel"
            onClick={() => {
              setPeakDrawMode(false);
              setPeakDrawStart(null);
            }}
            theme="violet"
            variant="primary"
            size="sm"
            className="inline-flex items-center gap-1 px-2.5"
            title="Cancel drawing mode"
          >
            <X size={12} /> Cancel Draw
          </AnalysisButton>
        ) : (
          <AnalysisButton
            data-testid="peak-draw-toggle"
            onClick={() => setPeakDrawMode(true)}
            theme="violet"
            variant="soft"
            size="sm"
            className="inline-flex items-center gap-1 px-2.5"
            title="Click on the track to define a custom peak region"
          >
            <Pencil size={12} /> Draw
          </AnalysisButton>
        )}

        {/* Delete selected custom peaks */}
        {hasCustomSelected && (
          <AnalysisButton
            data-testid="peak-delete-selected"
            onClick={deleteSelectedPeaks}
            variant="dangerOutline"
            size="sm"
            className="inline-flex items-center gap-1 px-2.5"
            title="Delete selected custom peaks"
          >
            <Trash size={12} />
          </AnalysisButton>
        )}

        {/* Clear all peak selections */}
        <AnalysisButton
          data-testid="peak-clear-selection"
          onClick={clearPeakSelection}
          variant="neutral"
          size="sm"
          className="px-2.5"
          title="Clear all peak selections"
        >
          Clear
        </AnalysisButton>
      </ToolbarGroup>

      <ToolbarGroup
        id="cluster"
        label="Cluster"
        action={(
          <span className="inline-flex items-center gap-1">
          <ActionButton
            data-testid="cluster-run-button"
            data-copilot-anchor="cluster-button"
            tone="cluster"
            icon={<ReadClusters size={13} aria-hidden="true" />}
            onClick={onCluster}
            busy={clustering}
            disabledReason={clusterBlockedReason ? clusterBlockedReason.charAt(0).toUpperCase() + clusterBlockedReason.slice(1) : null}
            title={clusterRunTitle}
          >
            {/* (Its label stays while busy, as Scan's: the toolbar row doesn't reflow.) */}
            {clusterRunLabel}
          </ActionButton>
          {/* Why Cluster can't run ('scan peaks first' / 'select peaks to
              cluster'): in the button's tooltip and for screen readers, not as
              text in the toolbar, so the row stays short and doesn't shift. */}
          {clusterBlockedReason && !clustering && (
            <span
              data-testid="cluster-blocked-hint"
              className="sr-only"
            >
              {clusterBlockedReason}
            </span>
          )}
          {/* Which panels the run clusters, said before it runs (and the picker to choose them). */}
          <ClusterAppliesTo />
          </span>
        )}
      >
        <div className="relative flex items-center gap-1">
          <AnalysisSelect
            value={clusterPeakMode}
            onChange={value => setClusterPeakMode(value)}
            options={clusterModeOptions.map(m => ({ value: m.id, label: m.label }))}
            selectClassName="text-xs py-0.5"
            title="Feature extraction mode for selected peaks"
          />
          {rulesButton('cluster', 'cluster-feature-rules-button', 'Cluster rules')}
        </div>
        {hasFeatures && !activeClusterFeatureRule && <FeatureSelectionChip peaksAlsoSelected={selectedPeaks.size > 0} />}
        {activeRuleHasNoRegions && (
          <span
            className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700 ring-1 ring-red-200 dark:bg-red-950/30 dark:text-red-300 dark:ring-red-900/60"
            title="The active cluster rule scope does not contain any usable regions in the current view."
          >
            no regions in scope
          </span>
        )}
        {!activeRuleHasNoRegions && activeRuleIgnoresSelectedPeaks && selectedPeaks.size > 0 && (
          <span
            className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-900/60"
            title="The active cluster rule has its own scope, so selected peaks are kept for inspection but not used by this cluster run."
          >
            using {summarizeAnalysisRuleScope(activeClusterScope)}
          </span>
        )}
        <span data-copilot-anchor="cluster-mode-select" className="inline-flex">
        <AnalysisSelect
          value={clusterMethod}
          onChange={setClusterMethod}
          options={CLUSTER_METHODS.map(m => ({ value: m.id, label: m.label }))}
          selectClassName="text-xs py-0.5"
          title={currentMethod.help
            ?? (currentMethod.needsK ? `${currentMethod.label} (K=${clusterK})` : currentMethod.label)}
        />
        </span>
        <select
          aria-label="Clustering working set"
          data-testid="cluster-preparation-select"
          value={clusterPreparationCount == null ? '' : '10000'}
          onChange={e => setClusterPreparationCount(e.target.value ? 10000 : null)}
          className="input-tool text-xs py-0.5"
          title="Show an initial fit of the displayed reads, then refine the full active subset in the background. A new operation cancels the older refinement."
        >
          <option value="10000">Preview, then full</option>
          <option value="">Full run only</option>
        </select>
        {sampledFitCount(clusterPreparationSamples, clusteredStateKeys) > 0 && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="cluster-sample-status">
            Sampled fit: {sampledFitCount(clusterPreparationSamples, clusteredStateKeys).toLocaleString()} fibers
          </span>
        )}
        <AnalysisButton
          data-testid="cluster-auto-cull-button"
          data-copilot-anchor="cluster-auto-cull-button"
          onClick={handleAutoCull}
          disabled={!canAutoCull}
          theme="amber"
          variant="soft"
          size="sm"
          className="inline-flex items-center gap-1 px-2.5"
          title={clusteredStateKeys.length === 0
            ? 'Run clustering first'
            : `Merge clusters ${mergeSummary}: the smaller of two alike clusters goes, its reads to the nearest remaining cluster. Change the settings and preview on the map in Clusters → Overview. Unmerge (in Clusters) switches back.`}
        >
          <Trash size={12} /> {autoCulling ? 'Merging…' : 'Merge similar clusters'}
        </AnalysisButton>
        {hasClusterAssignments && (
          <>
            <AnalysisButton
              data-testid="cluster-detail-button"
              onClick={() => openAnalysisPanel('cluster-detail')}
              theme="cyan"
              variant="soft"
              size="sm"
              className="px-2.5"
              title="Open the Clusters panel: branches, profiles, proportions and saved snapshots"
            >
              Detail
            </AnalysisButton>
            <AnalysisButton
              data-testid="cluster-clear-button"
              onClick={resetClusterState}
              variant="dangerOutline"
              size="sm"
              className="px-2.5"
              title="Clear clustering assignments, branch tree, cluster focus, and cluster sort order"
            >
              Clear clusters
            </AnalysisButton>
          </>
        )}
        {autoCullResult && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">{autoCullResult}</span>
        )}
        {currentMethod.needsK && (
          <div className="flex items-center gap-0.5">
            <span className="text-xs text-gray-500 dark:text-gray-400">K:</span>
            <input
              data-testid="cluster-k-input"
              data-copilot-anchor="cluster-k-input"
              type="number"
              min={2}
              max={30}
              value={clusterK}
              onChange={e => setClusterK(parseInt(e.target.value, 10) || 5)}
              className="input-tool w-14 text-xs"
              title="Number of clusters"
            />
          </div>
        )}
        {currentMethod.needsResolution && (
          <div className="flex items-center gap-0.5">
            <span className="text-xs text-gray-500 dark:text-gray-400">Resolution:</span>
            <input
              data-testid="cluster-resolution-input"
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={clusterResolution}
              onChange={e => {
                const value = parseFloat(e.target.value);
                if (Number.isFinite(value) && value > 0) setClusterResolution(value);
              }}
              className="input-tool w-14 text-xs"
              title="Higher resolution gives more, smaller groups (1 = standard modularity)"
            />
          </div>
        )}
        {currentMethod.needsThreshold && (
          <div className="flex items-center gap-0.5">
            <input
              data-copilot-anchor="accessibility-threshold-input"
              type="number"
              min={5}
              max={95}
              step={5}
              value={Math.round(accessibilityThreshold * 100)}
              onChange={e => setAccessibilityThreshold((parseInt(e.target.value, 10) || 50) / 100)}
              className="input-tool w-14 text-xs"
              title="Percent of bases that must be accessible to call a peak 'open'"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">%</span>
          </div>
        )}
      </ToolbarGroup>

      <ToolbarGroup
        id="sort"
        label="Sort"
        action={(
          <ActionButton
            data-testid="sort-run-button"
            tone="sort"
            icon={<ListIcon size={13} aria-hidden="true" />}
            onClick={handleSort}
            busy={sortBusy}
            disabledReason={sortDisabledReason}
            title={sortBy === FEATURE_SORT ? `Sort reads by membership at ${featureLabel || 'the selected features'}: members of more of them first, then by pattern` : `Sort reads by ${sortBy}`}
          >
            Sort
          </ActionButton>
        )}
      >
        <AnalysisSelect
          value={sortBy}
          onChange={setSortBy}
          options={sortChoices.some(o => o.value === sortBy) ? sortChoices : [
            { value: sortBy, label: `${sortBy === 'projection' ? 'By projection (t-SNE)' : sortBy === 'similarity' ? 'Similarity' : 'Previous sort'} (unavailable)` }, ...sortChoices,
          ]}
          selectClassName="text-xs py-0.5"
          title={sortBy === 'projection' ? SORT_BY_PROJECTION_HELP : 'Selected peaks set the sort region; with none selected, use each panel’s view. Known reads keep their order when panning or zooming.'}
        />
        {rulesButton('sort', 'sort-rules-button', 'Sort rules')}
        {hasClusterAssignments && (
          <AnalysisButton
            data-testid="sort-lock-cluster-order"
            data-copilot-anchor="cluster-order-lock-toggle"
            onClick={() => setLockClusterOrder(v => !v)}
            theme={lockClusterOrder ? 'amber' : 'slate'}
            variant={lockClusterOrder ? 'primary' : 'neutral'}
            size="sm"
            title={lockClusterOrder ? 'Sorting will keep the current cluster order' : 'Allow sorting to reorder clusters'}
          >
            {lockClusterOrder ? 'Order locked' : 'Lock order'}
          </AnalysisButton>
        )}
      </ToolbarGroup>

      <ToolbarGroup
        id="filter"
        label="Filter"
        action={(
          <ActionButton
            data-testid="filter-run-button"
            tone="filter"
            icon={<Sliders size={13} aria-hidden="true" />}
            onClick={handleFilter}
            disabledReason={filterBy ? null : 'Choose a filter rule first (define one in the Rules panel), or select features'}
            title={filterBy.startsWith('features:') ? FEATURE_FILTERS.find(f => f.value === filterBy)?.title : 'Filter reads by the selected analysis rule'}
          >
            Filter
          </ActionButton>
        )}
      >
        <AnalysisSelect
          value={filterBy}
          onChange={setFilterBy}
          options={[
            { value: '', label: 'No filter rules' },
            ...(hasFeatures ? FEATURE_FILTERS.map(f => ({ value: f.value, label: f.label })) : []),
            ...enabledAnalysisFilterRules.map(rule => ({ value: rule.id, label: rule.name })),
          ]}
          selectClassName="text-xs py-0.5"
          title="Reusable analysis filter rule"
        />
        {rulesButton('filter', 'filter-rules-button', 'Filter rules')}
        <AnalysisButton
          data-testid="filter-clear-button"
          onClick={onClearFilter}
          disabled={!hasAppliedReadFilter}
          variant="neutral"
          size="sm"
          title="Clear active read filter"
        >
          Clear
        </AnalysisButton>
      </ToolbarGroup>

      <HighlightToolbarGroup />

      {/* The open controls state each filter themselves: the summary is only for the folded group. */}
      <ToolbarGroup id="quality" label="Quality" summary={<QualitySummary />} summaryInPanel={false}>
        <QualityQuickControls />
      </ToolbarGroup>
    </ToolbarRow>
  );
}
