import type { FootprintGroup } from '../../types';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { footprintSource } from '../../utils/footprintSource';
import { UndoToast } from '../ui/UndoToast';
import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from 'react';
import { ChevronRight, CoOccupancy, FootprintClasses, Star } from '../ui/Icons';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useConsensusViewStore } from '../../stores/consensusViewStore';
import { analyzeFootprints, type FootprintAnalysisResult } from '../../api/footprints';
import {
  FOOTPRINT_ANALYSIS_TAB_STORAGE_KEY,
  normalizeFootprintAnalysisTab,
  type TabKey,
} from './footprint-analysis/constants';
import { SizesTab } from './footprint-analysis/SizesTab';
import { CartTab } from './footprint-analysis/CartTab';
import { ConsensusTools } from './footprint-analysis/ConsensusTools';
import { selectedRegionLabels } from './footprint-analysis/selectedRegionLabels';
import { panelGenomeLabel, usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { getConsensusStateReads } from '../../api/consensusWorkflow';
import { ConsensusComparison } from './footprint-analysis/ConsensusComparison';
import { DatasetSetupTab } from './footprint-analysis/DatasetSetupTab';
import { CoOccurrenceTab } from './footprint-analysis/CoOccurrenceTab';
import { stateFilterKey } from './footprint-analysis/StateList';
import { savedClassName, savedTierOf } from '../../utils/savedClasses';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { useFocusedReadIds } from '../../hooks/useFocusedReadIds';
import { applyMembershipClusters, computeMembershipClusters, cooccGroupParams, subsetCoOccupancy } from '../../utils/footprintMembership';
import { clusterSelectionLocus, findClusterSelection, footprintInView, resolveClusterSelection } from '../../utils/footprintClusterSelection';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell, AnalysisRunSummary, AnalysisStatus, LayerSelector } from './shared';
import { mapScopedReadIdsToDatasetIds, readScopeSignature } from '../../utils/readScopes';
import { FRONTEND_DIAGNOSTICS } from '../../utils/diagnostics';
import { buildFootprintAnalysisRequestKey } from '../../utils/footprintAnalysisRequestKey';
import { datasetsMissingConsensusChemistry } from '../../utils/datasetChemistry';
import { sameChrom } from '../../utils/chromAliases';
import { mainViewStateKeys } from '../../utils/mainViewPanels';
import { stateKeysAtLocus } from '../../utils/analysisLocus';
import { useAnalysisLoci } from '../../hooks/useAnalysisLoci';
import { AnalysisRegionChoice } from './shared/AnalysisRegionChoice';
import { footprintAnalysisScopes, mergeFootprintScopeResults } from '../../utils/footprintScopes';
import { invalidateFilterRequests, isCurrentFilterRequest, nextFilterRequest } from '../../utils/filterRequests';
import { useAnalysisSettingsKey } from '../../hooks/useAnalysisSettingsKey';
import { useRememberedState } from '../../hooks/useRememberedState';

interface Props {
  isFullView?: boolean;
}

const DEBUG = FRONTEND_DIAGNOSTICS;

function consumeRequestedFootprintAnalysisTab(): TabKey {
  if (typeof window === 'undefined') return 'states';
  const requested = window.sessionStorage.getItem(FOOTPRINT_ANALYSIS_TAB_STORAGE_KEY);
  if (!requested) return 'states';
  window.sessionStorage.removeItem(FOOTPRINT_ANALYSIS_TAB_STORAGE_KEY);
  return normalizeFootprintAnalysisTab(requested);
}


export function FootprintAnalysisPanel({ isFullView }: Props) {
  // The run, its curation and its catalog load: a stringency change reloads the
  // catalog with new primary assignments, so memberships must be recomputed.
  const consensusRevision = useConsensusViewStore(s=>`${s.jobId ?? ''}:${s.curation?.revision ?? 0}:${s.catalogRevision}`);
  const {
    selectedFootprints,
    clearFootprintSelection,
    footprintGroups,
    setFootprintGroups,
    addFootprintGroup,
    updateFootprintGroup,
    removeFootprintGroup,
    chrom, start, end, spanningOnly,
    datasets,
    setClusterAssignments,
    setClusterOrder,
    setClusterPatterns,
    setClusterPeakRegions,
    getAllPeaks, selectedPeaks, clearPeakSelection,
    setFilteredReadIds,
    footprintFilterKey,
    setFootprintFilterKey,
    clickTargetLayer,
    setClickTargetLayer,
    layer,
    setLayer,
    analysisSampleCount,
    analysisSampleSeed,
    peaksLocked,
    activeColormap,
    activeReadIds,
  } = useBrowserStore(useShallow(s => ({
    selectedFootprints: s.selectedFootprints,
    clearFootprintSelection: s.clearFootprintSelection,
    footprintGroups: s.footprintGroups,
    setFootprintGroups: s.setFootprintGroups,
    addFootprintGroup: s.addFootprintGroup,
    updateFootprintGroup: s.updateFootprintGroup,
    removeFootprintGroup: s.removeFootprintGroup,
    chrom: s.chrom, start: s.start, end: s.end, spanningOnly: s.spanningOnly,
    datasets: s.datasets,
    setClusterAssignments: s.setClusterAssignments,
    setClusterOrder: s.setClusterOrder,
    setClusterPatterns: s.setClusterPatterns,
    setClusterPeakRegions: s.setClusterPeakRegions,
    getAllPeaks: s.getAllPeaks, selectedPeaks: s.selectedPeaks, clearPeakSelection: s.clearPeakSelection,
    setFilteredReadIds: s.setFilteredReadIds,
    footprintFilterKey: s.footprintFilterKey,
    setFootprintFilterKey: s.setFootprintFilterKey,
    clickTargetLayer: s.clickTargetLayer,
    setClickTargetLayer: s.setClickTargetLayer,
    layer: s.footprintAnalysisLayer,
    setLayer: s.setFootprintAnalysisLayer,
    analysisSampleCount: s.analysisSampleCount,
    analysisSampleSeed: s.analysisSampleSeed,
    peaksLocked: s.peaksLocked,
    activeColormap: s.activeColormap,
    activeReadIds: s.activeReadIds,
  })));

  const [activeTab, setActiveTab] = useRememberedState<TabKey>('footprint-analysis:tab', consumeRequestedFootprintAnalysisTab, FOOTPRINT_ANALYSIS_TAB_STORAGE_KEY);
  // Bumped by every filter action so a slow response never overrides a newer
  // click, a Clear, or a view change.
  const stateFilterSeqRef = useRef(0);
  const [filterError, setFilterError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  // The analysis result with the request it answers: shown only for the current inputs.
  const [resultEntry, setResultEntry] = useState<{ key: string; res: FootprintAnalysisResult } | null>(null);
  // Co-occupancy of the saved definitions, kept apart from the selected-footprint
  // analysis (which doesn't compute it), with the definitions it was computed for:
  // its per-group rows are in that order.
  const [cooc, setCooc] = useState<{
    data: NonNullable<FootprintAnalysisResult['co_occupancy']>;
    groupIds: string[];
    /** Every input of the request (see cooccSignature): rows are only shown and acted on for the current one. */
    signature: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coOccLoading, setCoOccLoading] = useState(false);
  const clusterLoading = false;
  const [membershipLegend, setMembershipLegend] = useState<{ id: number; count: number; label: string }[] | null>(null);
  const [customGroupEdit, setCustomGroupEdit] = useState<number | null>(null); // sourceIndex for custom group form
  const [customMin, setCustomMin] = useState(0);
  const [customMax, setCustomMax] = useState(300);
  const analysisRequestSeqRef = useRef(0);
  const cooccRequestSeqRef = useRef(0);
  const cooccControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    cooccControllerRef.current?.abort();
    cooccRequestSeqRef.current += 1;
  }, []);

  // layer / setLayer come from the store now (footprintAnalysisLayer) so the
  // read-track cross-highlight can scope to the same layer the user chose.

  useEffect(() => {
    const handleOpenTab = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      setActiveTab(normalizeFootprintAnalysisTab(tab, activeTab));
    };
    window.addEventListener('fiberbrowser:open-footprint-analysis-tab', handleOpenTab);
    return () => window.removeEventListener('fiberbrowser:open-footprint-analysis-tab', handleOpenTab);
  }, [activeTab]);

  // Shared hooks
  const [containerWidth, containerRef] = useContainerWidth(280);
  const { targetDatasetIds, targetStateKeys, stateKeyMap, focusedReadIdArrays: rawFocusedArrays } = useFocusedReadIds();
  // Co-occupancy (and the read filters and clusters it applies) looks at one
  // region: the one the targeted panels show (their own locus or reference),
  // not the main view by default; panels at different regions ask which.
  const targetLoci = useAnalysisLoci(targetStateKeys);
  const coLocus = targetLoci.length === 1 ? targetLoci[0] : null;
  const coRegionUnresolved = targetLoci.length > 1;
  const coChrom = coLocus?.chrom ?? chrom;
  const coStart = coLocus?.start ?? start;
  const coEnd = coLocus?.end ?? end;
  const coLocusRef = useRef(coLocus);
  coLocusRef.current = coLocus;
  /** State keys of the panels showing the analysed region (a copy elsewhere shows other molecules). */
  const analysedKeys = useCallback(() => {
    const st = useBrowserStore.getState();
    return coLocusRef.current ? stateKeysAtLocus(st, coLocusRef.current) : mainViewStateKeys(st);
  }, []);
  // Read filters live under panel state keys (a copy has its own), while the
  // backend answers per dataset: write each dataset's reads to its panels' keys.
  const setDatasetReadFilter = useCallback((dsId: string, ids: Set<string> | null, meta?: Parameters<typeof setFilteredReadIds>[2]) => {
    // Only panels still open and showing the analysed region take it: a
    // late result mustn't recreate a closed panel's state, and a copy at
    // another locus shows other molecules.
    const shown = new Set(analysedKeys());
    for (const sk of stateKeyMap[dsId] ?? [dsId]) {
      if (stateKeyMap[dsId] && !shown.has(sk)) continue;
      setFilteredReadIds(sk, ids, meta);
    }
  }, [setFilteredReadIds, stateKeyMap, analysedKeys]);
  const clearTargetReadFilters = useCallback(() => {
    // The targets, and any panel still holding a filter from this panel (the
    // target selection may have changed since it was applied).
    const owned = Object.entries(useBrowserStore.getState().readFilterSources)
      .filter(([, source]) => source?.target === 'footprint-cooccurrence')
      .map(([key]) => key);
    for (const sk of new Set([...targetStateKeys, ...owned])) setFilteredReadIds(sk, null);
  }, [setFilteredReadIds, targetStateKeys]);

  // Remap focusedReadIdArrays from stateKeys to datasetIds for backend API.
  // Duplicate split panes can point at the same dataset, so merge rather than
  // letting the last selected pane overwrite the earlier one.
  const focusedReadIdArrays = useMemo(() => {
    return mapScopedReadIdsToDatasetIds(rawFocusedArrays, stateKeyMap);
  }, [rawFocusedArrays, stateKeyMap]);
  // Datasets whose targeted panels all show one strand are analyzed on that strand.
  const panelsForStrand = useBrowserStore(s => s.panels);
  const strandByDataset = useMemo(() => {
    const strands = new Map<string, Set<string>>();
    for (const panel of panelsForStrand) {
      if (panel.contentType !== 'dataset' || !panel.datasetId || panel.collapsed) continue;
      if (!targetStateKeys.includes(panel.stateKey ?? panel.datasetId)) continue;
      const set = strands.get(panel.datasetId) ?? new Set<string>();
      set.add(panel.strand ?? 'both');
      strands.set(panel.datasetId, set);
    }
    const out: Record<string, 'CT' | 'GA'> = {};
    for (const [datasetId, set] of strands) {
      const [only] = [...set];
      if (set.size === 1 && (only === 'CT' || only === 'GA')) out[datasetId] = only;
    }
    return out;
  }, [panelsForStrand, targetStateKeys]);
  const strandKey = JSON.stringify(strandByDataset);
  const focusedReadScopeKey = useMemo(
    () => readScopeSignature(focusedReadIdArrays),
    [focusedReadIdArrays],
  );
  const visibleReadIdArrays = useMemo(() => {
    const scoped: Record<string, string[]> = {};
    for (const stateKey of targetStateKeys) {
      const ids = activeReadIds[stateKey];
      if (ids?.length) scoped[stateKey] = ids;
    }
    return mapScopedReadIdsToDatasetIds(scoped, stateKeyMap, {
      preserveEmptyScope: false,
    });
  }, [activeReadIds, stateKeyMap, targetStateKeys]);

  const targetDatasets = useMemo(() =>
    targetDatasetIds.map(id => datasets.find(d => d.id === id)).filter(Boolean) as typeof datasets,
    [datasets, targetDatasetIds]
  );
  const missingFamilyScanChemistry = useMemo(
    () => datasetsMissingConsensusChemistry(datasets, targetDatasetIds),
    [datasets, targetDatasetIds],
  );

  // Derive selected peak regions as pseudo-footprints
  const selectedPeakRegions = useMemo(() => {
    const allPeaks = getAllPeaks();
    return Array.from(selectedPeaks)
      .map(idx => allPeaks.find(p => p.index === idx))
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
      .map(p => ({
        absStart: p.start,
        absEnd: p.end,
        size: p.end - p.start,
        readId: `peak_${p.index}`,
        datasetId: 'peak',
        // Scanned in a panel at another locus or on another assembly.
        chrom: p.chrom ?? null,
        genome: p.genome ?? null,
      }));
  }, [getAllPeaks, selectedPeaks]);

  const nFootprints = selectedFootprints.length;
  const nPeaks = selectedPeakRegions.length;
  const peakResultOffset = nFootprints; // peaks start after footprints in result array
  const enabledFootprintGroups = useMemo(
    () => footprintGroups.filter(g => g.enabled),
    [footprintGroups],
  );
  const cooccFootprintGroups = useMemo(() => {
    const eligible = enabledFootprintGroups.filter(g =>
      // A rule pinned to another chromosome would match reads here at the same
      // coordinates; it applies only on its own chromosome.
      (!g.referenceChrom || sameChrom(g.referenceChrom, coChrom))
      && (g.referenceGenome === undefined || g.referenceGenome === (coLocus?.genome ?? null))
      && ((g.referenceAbsStart != null && g.referenceAbsEnd != null)
        || (g.sourceIndex >= 0 && selectedFootprints[g.sourceIndex] != null))
    );
    const seenAutoFamilies = new Set<string>();
    return eligible.filter(group => {
      if (!group.autoGeneratedFamily || group.familyId == null) return true;
      const key = [
        group.layer ?? 'tf_sr',
        group.familyId,
        group.referenceAbsStart ?? '',
        group.referenceAbsEnd ?? '',
      ].join(':');
      if (seenAutoFamilies.has(key)) return false;
      seenAutoFamilies.add(key);
      return true;
    });
  }, [enabledFootprintGroups, selectedFootprints, coChrom, coLocus?.genome]);
  const hasCartCooccTargets = cooccFootprintGroups.length > 0;
  // When the user cmd-clicks on a TF/FIRE/custom-layer footprint and the panel
  // is currently on "All" (null), auto-promote to that layer so the size
  // histogram + V-plot pull from the right channel. Doesn't override an
  // explicit user selection (only promotes from null → layer).
  //
  // Without analysis details the layer controls are hidden, so the layer
  // simply follows what was clicked (primary calls for nuc/footprint).
  const showDetails = useBrowserStore(s => s.showAnalysisDetails);
  useEffect(() => {
    const layers = new Set(selectedFootprints.map(f => f.layer ?? null));
    const sel = layers.size === 1 ? [...layers][0] : null;
    const target = sel && sel !== 'nuc' && sel !== 'footprint' ? sel : null;
    if (showDetails) {
      if (layer === null && target) setLayer(target);
    } else if (target !== layer) {
      // Mixed or cleared selections go back to all calls, so nothing stays
      // scoped to a layer whose control is hidden.
      setLayer(target);
    }
  }, [selectedFootprints, layer, showDetails]);
  // A click target chosen in details mode shouldn't keep steering clicks
  // once its control is hidden.
  useEffect(() => {
    if (!showDetails && clickTargetLayer !== null) setClickTargetLayer(null);
  }, [showDetails, clickTargetLayer, setClickTargetLayer]);

  // Footprints sent to /api/footprint/analyze. Peaks are NOT included anymore
  // — they shouldn't grab sequence/motifs. Co-occupancy still uses them via
  // selectedPeakRegions where appropriate, but the panel-level analysis is
  // footprint-only.
  const mergedFps = useMemo(() => {
    return selectedFootprints.map(fp => ({
      absStart: fp.absStart, absEnd: fp.absEnd, size: fp.size,
      readId: fp.readId, datasetId: fp.datasetId,
    }));
  }, [selectedFootprints]);
  // Each footprint is analysed in the region it was picked in: one selected in
  // a panel on another chromosome is analysed there, not at the main view.
  const footprintScopes = useMemo(
    () => footprintAnalysisScopes(selectedFootprints, { chrom, start, end }, panelsForStrand),
    [selectedFootprints, chrom, start, end, panelsForStrand],
  );
  const settingsKey = useAnalysisSettingsKey();
  useSplitPanelStore(s => s.reads);
  const sourceScopesKey = useBrowserStore(s => JSON.stringify(footprintScopes.map(scope => footprintSource(s, { sourceIndex: scope.indices[0] } as FootprintGroup, targetDatasetIds))));
  const footprintScopesKey = sourceScopesKey + footprintScopes.map(sc => `${sc.genome ?? ""}|${sc.chrom}:${sc.start}-${sc.end}=${sc.indices.join(',')}`).join(';');
  const analysisRequestKey = useMemo(() => buildFootprintAnalysisRequestKey({
    chrom,
    start,
    end,
    spanning: spanningOnly,
    footprints: mergedFps,
    datasetIds: targetDatasetIds,
    // Strand scope is part of the read scope.
    // Quality filters change the server's calls: part of the scope too.
    readScopeKey: `${focusedReadScopeKey}|${strandKey}|${footprintScopesKey}|${settingsKey}`,
    layer,
    maxReads: analysisSampleCount,
    sampleSeed: analysisSampleSeed,
  }), [
    strandKey, analysisSampleCount, analysisSampleSeed, chrom, end, focusedReadScopeKey,
    layer, mergedFps, spanningOnly, start, targetDatasetIds, footprintScopesKey, settingsKey,
  ]);

  // Auto-analyze when selection, viewport, layer, sampling, or cluster-focus
  // scope changes. This single keyed path replaces the previous selection
  // effect + cluster-focus effect split so old responses cannot race.
  useEffect(() => {
    if (mergedFps.length === 0) {
      analysisRequestSeqRef.current += 1;
      setResultEntry(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const requestSeq = ++analysisRequestSeqRef.current;
    const key = analysisRequestKey;
    const timer = setTimeout(() => {
      if (analysisRequestSeqRef.current !== requestSeq) return;
      setLoading(true);
      setError(null);
      Promise.all(footprintScopes.map(scope => {
        const source = footprintSource(useBrowserStore.getState(), { sourceIndex: scope.indices[0] } as FootprintGroup, targetDatasetIds);
        return analyzeFootprints(
        scope.chrom, scope.start, scope.end, spanningOnly,
        scope.indices.map(i => mergedFps[i]), source.datasetIds, {
        panelGenome: source.genome,
        autoMotifs: false,
        sequences: false,
        motifs: false,
        overlap: true,
        overlapSizes: false,
        profiles: false,
        vplot: false,
        coocc: false,
        readIdsByDataset: source.readIdsByDataset ?? focusedReadIdArrays ?? undefined,
        strandByDataset,
        layer,
        maxReads: analysisSampleCount ?? undefined,
        sampleSeed: analysisSampleSeed,
        signal: controller.signal,
      }).then(res => ({ scope, res })); }))
        .then(parts => {
          const res = mergeFootprintScopeResults(parts);
          if (res && analysisRequestSeqRef.current === requestSeq && !controller.signal.aborted) {
            setResultEntry({ key, res });
          }
        })
        .catch(err => {
          if (controller.signal.aborted || err?.name === 'AbortError') return;
          if (analysisRequestSeqRef.current === requestSeq) {
            setError(err.message || 'Analysis failed');
          }
        })
        .finally(() => {
          if (analysisRequestSeqRef.current === requestSeq && !controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, focusedReadIdArrays ? 300 : 0);

    return () => {
      controller.abort();
      clearTimeout(timer);
      if (analysisRequestSeqRef.current === requestSeq) analysisRequestSeqRef.current += 1;
      setLoading(false);
    };
  }, [analysisRequestKey]);

  // Another footprint (or view, layer, scope) selected: the previous analysis is
  // not shown for it while the new one loads, or if it fails.
  const result = resultEntry?.key === analysisRequestKey ? resultEntry.res : null;

  // The saved definitions as the co-occupancy request sees them.
  const cooccGroupKey = useMemo(() => cooccFootprintGroups
    .map(g => `${g.id}:${g.layer ?? 'any'}:${g.sourceIndex}:${g.referenceChrom ?? ''}:${g.referenceAbsStart ?? ''}-${g.referenceAbsEnd ?? ''}:${g.sizeMin}-${g.sizeMax}:fp${g.minFpCoverage ?? 0}:tgt${g.minTargetCoverage ?? 0}:family${g.familyId ?? ''}:fq${g.minFamilyConfidence ?? 0}`)
    .join('|') + ':' + consensusRevision + ':' + cooccFootprintGroups.map(g=>`${g.consensusJobId ?? ''}:${g.sourceDatasetId ?? ''}:${g.consensusDatasetId ?? ''}:${g.consensusStateId ?? ''}:${g.consensusStrand ?? ''}:${g.consensusTier ?? ''}`).join('|'),
  [cooccFootprintGroups, consensusRevision]);
  // Everything a co-occupancy result depends on.
  const cooccSignature = useMemo(() => JSON.stringify([
    cooccGroupKey, coRegionUnresolved, coLocus?.genome ?? null, coChrom, coStart, coEnd, spanningOnly, targetDatasetIds, focusedReadIdArrays ?? null, layer,
    analysisSampleCount ?? null, analysisSampleSeed, strandKey,
    selectedFootprints.map(fp => `${fp.datasetId}:${fp.readId}:${fp.absStart}-${fp.absEnd}`),
    settingsKey,
  ]), [cooccGroupKey, coRegionUnresolved, coLocus?.genome, coChrom, coStart, coEnd, spanningOnly, targetDatasetIds, focusedReadIdArrays, layer,
    analysisSampleCount, analysisSampleSeed, strandKey, selectedFootprints, settingsKey]);

  // Re-analyze co-occupancy when groups change (2+ groups)
  const analyzeCoOccupancy = useCallback(() => {
    if (coRegionUnresolved) {
      // No region chosen: nothing in flight may land, and no older result stays actionable.
      cooccControllerRef.current?.abort();
      cooccControllerRef.current = null;
      cooccRequestSeqRef.current += 1;
      setCoOccLoading(false);
      return;
    }
    if (cooccFootprintGroups.length < 1) return;

    cooccControllerRef.current?.abort();
    const controller = new AbortController();
    cooccControllerRef.current = controller;
    const requestSeq = ++cooccRequestSeqRef.current;
    setCoOccLoading(true);
    const fps = selectedFootprints.map(fp => ({
      absStart: fp.absStart, absEnd: fp.absEnd, size: fp.size,
      readId: fp.readId, datasetId: fp.datasetId,
    }));
    const groupParams = cooccGroupParams(cooccFootprintGroups);
    const groupIds = cooccFootprintGroups.map(group => group.id);
    const signature = cooccSignature;
    const familyGroup = cooccFootprintGroups.find(group => group.familyId != null);
    const cooccLayer = familyGroup
      ? (familyGroup.layer ?? 'tf_sr')
      : layer;

    analyzeFootprints(coChrom, coStart, coEnd, spanningOnly, fps, targetDatasetIds, {
      panelGenome: coLocus?.genome,
      autoMotifs: false,
      sequences: false,
      motifs: false,
      overlap: false,
      profiles: false,
      vplot: false,
      coocc: true,
      groups: groupParams,
      readIdsByDataset: focusedReadIdArrays ?? undefined,
      strandByDataset,
      layer: cooccLayer,
      maxReads: analysisSampleCount ?? undefined,
      sampleSeed: analysisSampleSeed,
      signal: controller.signal,
    })
      .then(res => {
        if (cooccRequestSeqRef.current !== requestSeq || controller.signal.aborted) return;
        cooccResultSeqRef.current = requestSeq;
        setCooc({ data: res.co_occupancy ?? {}, groupIds, signature });
        // Don't clear footprintFilterKey here — the user's filter should persist
      })
      .catch(err => {
        if (controller.signal.aborted || err?.name === 'AbortError') return;
      })
      .finally(() => {
        if (cooccRequestSeqRef.current === requestSeq && !controller.signal.aborted) {
          setCoOccLoading(false);
          cooccControllerRef.current = null;
        }
      });
  }, [selectedFootprints, cooccFootprintGroups, coRegionUnresolved, coChrom, coStart, coEnd, spanningOnly, targetDatasetIds, focusedReadIdArrays, layer, analysisSampleCount, analysisSampleSeed, consensusRevision, strandKey, cooccSignature]);

  // Auto-trigger co-occupancy when groups change; clear any active filter
  // since the group definitions have changed and old cell keys are stale
  const prevGroupKeyRef = useRef<string>('');
  // Request whose result a pending saved-entry refilter (store.footprintRefilterId) waits for.
  const refilterSeqRef = useRef(0);
  const footprintRefilterId = useBrowserStore(s => s.footprintRefilterId);
  const cooccResultSeqRef = useRef(0);
  const footprintFilterKeyRef = useRef(footprintFilterKey);
  footprintFilterKeyRef.current = footprintFilterKey;

  useEffect(() => {
    const groupKey = cooccGroupKey;
    const groupsChanged = prevGroupKeyRef.current !== '' && groupKey !== prevGroupKeyRef.current;
    prevGroupKeyRef.current = groupKey;

    const cellFilter = footprintFilterKeyRef.current
      && !footprintFilterKeyRef.current.startsWith('state:') && !footprintFilterKeyRef.current.startsWith('cart:');
    // An edited saved entry's filter was cleared by the store (its reads are
    // stale); re-apply it once this request's co-occupancy result arrives.
    // Any explicit filter change clears footprintRefilterId in the store.
    const refilterId = useBrowserStore.getState().footprintRefilterId;
    if (refilterId && (cooccFootprintGroups.length === 0
      || cooccFootprintGroups.find(g => g.id === refilterId)?.consensusStateId)) {
      useBrowserStore.getState().setFootprintRefilterId(null); // class entries don't need it
    }
    if (groupsChanged && cellFilter) {
      // Co-occupancy cell keys refer to the old groups; state and saved-entry
      // filters stay valid (the store drops a removed entry's filter itself).
      setFootprintFilterKey(null);
      clearTargetReadFilters();
    }

    if (cooccFootprintGroups.length >= 1) {
      analyzeCoOccupancy();
      // Wait for this request's result, not the one already on screen.
      if (useBrowserStore.getState().footprintRefilterId) refilterSeqRef.current = cooccRequestSeqRef.current;
    }
  }, [cooccFootprintGroups, analyzeCoOccupancy, clearTargetReadFilters, consensusRevision, cooccGroupKey]);

  // The co-occupancy result, only when it was computed for exactly the current
  // definitions and view: an older result's rows would be labelled, filtered
  // and exported as the new definitions.
  const currentCooc = cooc && !coOccLoading && !coRegionUnresolved && cooc.signature === cooccSignature
    && cooc.groupIds.length === cooccFootprintGroups.length
    && cooc.groupIds.every((id, i) => cooccFootprintGroups[i]?.id === id)
    ? cooc.data : null;
  const coocResult = useMemo(
    () => (currentCooc ? { co_occupancy: currentCooc } as FootprintAnalysisResult : null),
    [currentCooc],
  );

  // Cluster reads by which saved footprints they carry (e.g. A+B, A only,
  // B only, neither), from the co-occupancy membership already computed.
  // Cluster ids are shared across datasets so the same pattern lines up.
  // Which footprints to cluster by: remembered per locus (the span of the saved
  // footprints in this view, else the view), kept to those offered; default all
  // of up to three, else the first three, preferring the ones in view.
  const cooccLocus = useMemo(() => clusterSelectionLocus(cooccFootprintGroups, { chrom: coChrom, start: coStart, end: coEnd }), [cooccFootprintGroups, coChrom, coStart, coEnd]);
  const rememberedClusterSelection = useBrowserStore(s => findClusterSelection(s.cooccClusterSelections, cooccLocus));
  const clusterSelection = useMemo(() => resolveClusterSelection(
    cooccFootprintGroups.map(g => g.id),
    rememberedClusterSelection?.groupIds,
    cooccFootprintGroups.filter(g => footprintInView(g, { chrom: coChrom, start: coStart, end: coEnd })).map(g => g.id),
  ), [cooccFootprintGroups, rememberedClusterSelection, coChrom, coStart, coEnd]);
  const handleClusterSelectionChange = useCallback((groupIds: string[]) => {
    useBrowserStore.getState().setCooccClusterSelection({ ...cooccLocus, groupIds });
  }, [cooccLocus]);

  const handleClusterByGroups = useCallback((groupIds: string[]) => {
    // Only the chosen footprints, in the groups' order; their per-group rows are subset the same way.
    const indices = cooccFootprintGroups.map((g, i) => (groupIds.includes(g.id) ? i : -1)).filter(i => i >= 0);
    const groups = indices.map(i => cooccFootprintGroups[i]);
    if (groups.length === 0) return;
    if (!currentCooc) {
      setFilterError('Footprint membership is still being computed; try again in a moment.');
      return;
    }
    stateFilterSeqRef.current += 1; // a pending class filter no longer applies
    const clusters = computeMembershipClusters(subsetCoOccupancy(currentCooc, indices), groups, targetDatasetIds);
    if (!clusters) {
      setFilterError('No reads in view could be assigned; check that the saved footprints are in view.');
      return;
    }
    setFilterError(null);
    // The memberships describe the analysed region's reads: a copy at another locus keeps its clusters.
    const shown = new Set(analysedKeys());
    const shownKeyMap = Object.fromEntries(Object.entries(stateKeyMap)
      .map(([dsId, keys]) => [dsId, keys.filter(sk => shown.has(sk))]));
    applyMembershipClusters(clusters, groups, shownKeyMap, coStart, selectedFootprints);
    setMembershipLegend(clusters.legend);
  }, [cooccFootprintGroups, currentCooc, targetDatasetIds, stateKeyMap, selectedFootprints, coStart, analysedKeys]);

  const chartWidth = Math.max(200, containerWidth - 16);


  // Click handler for co-occupancy cells
  const handleCellClick = useCallback((dsId: string, pairIndex: number, cellName: string, ids?: string[]) => {
    const key = `${dsId}:${pairIndex}:${cellName}`;
    stateFilterSeqRef.current += 1; // a pending class filter no longer applies
    if (footprintFilterKey === key) {
      // Toggle off: clear filter for ALL target datasets
      setFootprintFilterKey(null);
      clearTargetReadFilters();
    } else {
      // Toggle on: clear any previous filter, then set new one
      clearTargetReadFilters();
      setFootprintFilterKey(key);
      if (ids) setDatasetReadFilter(dsId, new Set(ids), {
        target: 'footprint-cooccurrence',
        label: 'Footprints > Co-occupancy',
      });
    }
  }, [footprintFilterKey, clearTargetReadFilters, setDatasetReadFilter]);

  // Cart entry → "Filter to reads with this footprint" handler.
  // Reuses the per_group occupancy data from the most recent analysis when
  // available (computed during the Co-occ tab render). Falls back to a
  // per-dataset union of ids_with across all enabled groups.
  const handleClearCartFilter = useCallback(() => {
    stateFilterSeqRef.current += 1;
    invalidateFilterRequests();
    setFilterError(null);
    setFootprintFilterKey(null);
    clearTargetReadFilters();
  }, [clearTargetReadFilters, setFootprintFilterKey]);

  useEffect(() => () => { stateFilterSeqRef.current += 1; }, []);
  // A class filter requested for another view or read scope no longer applies.
  // The target panels too: closing one of two copies of a dataset keeps its ID in the target list.
  const targetScopeKey = `${targetDatasetIds.join('\t')}|${targetStateKeys.join('\t')}`;
  // Also when the analysed region moves (a panel navigating on its own, its reference).
  const coLocusKey = `${coLocus?.genome ?? ''}|${coChrom}:${coStart}-${coEnd}|${coRegionUnresolved}`;
  useEffect(() => { stateFilterSeqRef.current += 1; }, [chrom, start, end, targetScopeKey, coLocusKey]);

  // Show only reads whose best-fit consensus state is `stateId`. Other
  // datasets show no reads (matching saved-entry filters) rather than all.
  // `targets`: the datasets (and, for a one-strand class, the DAF strand) whose members are shown.
  const applyStateReadFilter = useCallback(async (
    jobId: string, targets: string | { datasetId: string; consensusDatasetId?: string | null; strand?: string | null; tier?: string | null }[], stateId: string, name: string, filterKey: string, label: string,
    stage?: string | null,
  ) => {
    const seq = ++stateFilterSeqRef.current;
    // Also a read-filter request like the toolbar's: a Clear there (or a newer
    // filter from anywhere) supersedes it.
    const request = nextFilterRequest();
    setFilterError(null);
    const wanted = typeof targets === 'string' ? [{ datasetId: targets, strand: null, tier: null }] : targets;
    try {
      const responses = await Promise.all(wanted.map(t => getConsensusStateReads(jobId, t.consensusDatasetId ?? t.datasetId, stateId, undefined, stage, t.strand ?? null, t.tier ?? null)));
      if (seq !== stateFilterSeqRef.current || !isCurrentFilterRequest(request)) return;
      const byDataset = new Map<string, Set<string>>();
      wanted.forEach((t, i) => {
        const ids = byDataset.get(t.datasetId) ?? new Set<string>();
        for (const id of responses[i].read_ids) ids.add(id);
        byDataset.set(t.datasetId, ids);
      });
      if (![...byDataset.values()].some(ids => ids.size)) {
        setFilterError(`No reads have “${name}” as their best-fit class in this view.`);
        return;
      }
      for (const id of targetDatasetIds) {
        setDatasetReadFilter(id, byDataset.get(id) ?? new Set(), { target: 'footprint-cooccurrence', label });
      }
      setFootprintFilterKey(filterKey);
    } catch (requestError) {
      if (seq !== stateFilterSeqRef.current) return;
      setFilterError(requestError instanceof Error ? requestError.message : 'Could not filter reads by footprint class.');
    }
  }, [setDatasetReadFilter, setFootprintFilterKey, targetDatasetIds]);

  const handleFilterState = useCallback((datasetId: string, stateId: string, name: string) => {
    const key = stateFilterKey(datasetId, stateId);
    const jobId = useConsensusViewStore.getState().jobId;
    if (footprintFilterKey === key || !jobId) {
      handleClearCartFilter();
      return;
    }
    void applyStateReadFilter(jobId, datasetId, stateId, name, key, 'Footprints > Classes');
  }, [applyStateReadFilter, footprintFilterKey, handleClearCartFilter]);

  // A saved recaller class across its picked channels, in the run it was saved from, counted as it counts.
  const handleFilterSavedClass = useCallback((groups: typeof footprintGroups) => {
    const g = groups[0]; const info = g?.savedClass;
    if (!info || !g.consensusJobId || !g.consensusStateId) return;
    const key = `cart:saved:${info.id}`;
    if (footprintFilterKey === key) { handleClearCartFilter(); return; }
    void applyStateReadFilter(g.consensusJobId,
      groups.filter(x => x.sourceDatasetId).map(x => ({ datasetId: x.sourceDatasetId!, consensusDatasetId: x.consensusDatasetId, strand: x.consensusStrand ?? null, tier: savedTierOf(x) })),
      g.consensusStateId, savedClassName(info, g.consensusTier), key, 'Footprints > Saved', g.consensusStage);
  }, [applyStateReadFilter, footprintFilterKey, handleClearCartFilter]);

  const handleApplyCartFilter = useCallback(async (g: typeof footprintGroups[number]) => {
    if (g.consensusStateId && g.consensusJobId && g.sourceDatasetId) {
      await applyStateReadFilter(g.consensusJobId, [{ datasetId: g.sourceDatasetId, consensusDatasetId: g.consensusDatasetId, strand: g.consensusStrand ?? null, tier: savedTierOf(g) }], g.consensusStateId, g.name,
        `cart:${g.id}`, 'Footprints > Saved', g.consensusStage);
      return;
    }
    stateFilterSeqRef.current += 1; // a pending class filter no longer applies
    if (!cooccFootprintGroups.some(eg => eg.id === g.id)) {
      setFilterError(`"${g.name}" needs a pinned reference position before it can filter reads by occupancy.`);
      return;
    }
    // Its row in the result computed for the current definitions (by identity:
    // positions shift when another definition is turned off).
    const groupIdx = currentCooc ? cooc!.groupIds.indexOf(g.id) : -1;
    if (groupIdx < 0) {
      setFilterError('Footprint membership is still being computed; try again in a moment.');
      return;
    }
    // Refuse to apply if we don't actually have an id list — otherwise the
    // user ends up with a filter key set but no ids, which looks like "all
    // reads gone" and was previously unrecoverable without a page reload.
    const missingForDatasets: string[] = [];
    const readyByDataset: Record<string, string[]> = {};
    for (const dsId of targetDatasetIds) {
      const ids = currentCooc?.[dsId]?.per_group?.[groupIdx]?.ids_with;
      if (!ids || ids.length === 0) {
        missingForDatasets.push(dsId);
      } else {
        readyByDataset[dsId] = ids;
      }
    }
    if (missingForDatasets.length === targetDatasetIds.length) {
      setFilterError(
        `No reads match "${g.name}" in this viewport — filter not applied. ` +
        `Try widening size/overlap or adjusting the layer, or open Co-occ to re-run the analysis.`
      );
      return;
    }
    setFilterError(null);
    setFootprintFilterKey(`cart:${g.id}`);
    for (const dsId of targetDatasetIds) {
      const ids = readyByDataset[dsId];
      // Empty set when that dataset has no matches — explicit so the ReadTrack
      // nudge can offer a "Clear filter" escape hatch.
      setDatasetReadFilter(dsId, new Set(ids ?? []), {
        target: 'footprint-cooccurrence',
        label: 'Footprints > Saved',
      });
    }
  }, [applyStateReadFilter, cooccFootprintGroups, cooc, currentCooc, setDatasetReadFilter, setFootprintFilterKey, targetDatasetIds]);

  // After an edited saved entry's co-occupancy is recomputed, re-apply its
  // filter with the new reads (or clear it, with a message, if none match).
  useEffect(() => {
    const id = footprintRefilterId;
    if (!id || !currentCooc || cooccResultSeqRef.current < refilterSeqRef.current) return;
    useBrowserStore.getState().setFootprintRefilterId(null);
    // The user picked (or cleared) a filter meanwhile, or removed the entry: leave it.
    if (useBrowserStore.getState().footprintFilterKey !== null) return;
    const group = cooccFootprintGroups.find(g => g.id === id);
    if (group) void handleApplyCartFilter(group);
  }, [footprintRefilterId, currentCooc, cooccFootprintGroups, handleApplyCartFilter]);

  // Active cart filter ID derived from footprintFilterKey (when key is "cart:<id>")
  const activeCartFilterId = footprintFilterKey?.startsWith('cart:')
    ? footprintFilterKey.slice(5)
    : null;

  // A saved class is one definition however many datasets/strands it covers.
  const savedDefinitions = footprintGroups.filter(g => !g.savedClass).length + new Set(footprintGroups.flatMap(g => g.savedClass ? [g.savedClass.id] : [])).size;
  const tabs: { key: TabKey; label: string; icon: ReactNode }[] = [
    { key: 'states', label: 'Classes', icon: <FootprintClasses size={13} /> },
    { key: 'saved', label: `Saved${savedDefinitions > 0 ? ` (${savedDefinitions})` : ''}`, icon: <Star size={13} /> },
    { key: 'co-occ', label: 'Co-occupancy', icon: <CoOccupancy size={13} /> },
  ];

  const hasSelection = nFootprints > 0 || nPeaks > 0;
  const enabledQualityFilterCount = activeColormap.qualityFilters.filter(filter => filter.enabled).length;
  const multipleDatasets = targetDatasetIds.length > 1;
  // Co-occupancy cell filters belong to that tab; state/saved filters persist.
  const cooccCellFilterActive = !!footprintFilterKey && !footprintFilterKey.startsWith('cart:') && !footprintFilterKey.startsWith('state:');

  const selectionHeader = hasSelection ? (
    <AnalysisPanelHeader
      theme="emerald"
      title={`${nFootprints + nPeaks} region${(nFootprints + nPeaks) !== 1 ? 's' : ''} selected`}
      meta={
        <>
          ({nFootprints > 0 ? `${nFootprints} footprint${nFootprints !== 1 ? 's' : ''}` : ''}
          {nFootprints > 0 && nPeaks > 0 ? ', ' : ''}
          {nPeaks > 0 ? `${nPeaks} peak${nPeaks !== 1 ? 's' : ''}` : ''})
        </>
      }
      detail={
        <>
          {/* Each on its own chromosome and reference (a peak picked in a dm6 panel is on dm6's). */}
          {selectedRegionLabels(selectedFootprints, selectedPeakRegions, {
            ...useBrowserStore.getState(),
            referenceName: key => panelGenomeLabel(usePanelGenomeStore.getState().genomes[key], key),
          }).join(', ')}
        </>
      }
      actions={
        <>
          {nFootprints > 0 && (
            <AnalysisButton onClick={clearFootprintSelection} variant="dangerOutline" className="whitespace-nowrap" title="Deselect footprints">
              {nPeaks > 0 ? 'Clear footprints' : 'Clear'}
            </AnalysisButton>
          )}
          {nPeaks > 0 && (
            <AnalysisButton onClick={clearPeakSelection} variant="dangerOutline" className="whitespace-nowrap" title="Deselect peaks">
              {nFootprints > 0 ? 'Clear peaks' : 'Clear'}
            </AnalysisButton>
          )}
        </>
      }
    />
  ) : undefined;

  const filterNotice = filterError ? (
    <AnalysisStatus kind="warning" compact>{filterError}</AnalysisStatus>
  ) : null;
  const filterBanner = footprintFilterKey ? (
    <div className="flex items-center justify-between rounded bg-emerald-50 px-2 py-1 text-[11px] dark:bg-emerald-900/20">
      <span className="text-emerald-700 dark:text-emerald-300">
        {footprintFilterKey.startsWith('state:') || footprintFilterKey.startsWith('cart:saved:') ? 'Reads filtered to one footprint class' : 'Reads filtered by footprint occupancy'}
      </span>
      <AnalysisButton onClick={handleClearCartFilter} variant="dangerOutline" className="ml-2">
        Clear filter
      </AnalysisButton>
    </div>
  ) : null;

  return (
    <div ref={containerRef} className="text-sm">
      <AnalysisPanelShell
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={(key) => {
          if (activeTab === 'co-occ' && key !== 'co-occ' && cooccCellFilterActive) handleClearCartFilter();
          setActiveTab(key);
        }}
        theme="emerald"
        className=""
        tabsFirst
        tabBarClassName="sticky top-0 z-20 bg-surface px-2"
        bodyMode="none"
        header={selectionHeader ? <div className="px-3 pt-3">{selectionHeader}</div> : undefined}
        summary={filterBanner || filterNotice ? <div className="space-y-1 px-3 pt-3">{filterBanner}{filterNotice}</div> : undefined}
      >
      <div className="space-y-3 p-3 text-[12px] leading-[18px]">

      {/* === States: find states, filter to one, tick the ones to compare === */}
      {activeTab === 'states' && (
        <div className="space-y-3">
          {missingFamilyScanChemistry.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50/60 p-2 dark:border-amber-700 dark:bg-amber-950/20">
              <DatasetSetupTab datasetIds={missingFamilyScanChemistry.map(dataset => dataset.id)} />
            </div>
          )}

          {nFootprints > 0 && (
            <section className="space-y-2 rounded border border-emerald-200 p-2 dark:border-emerald-900" data-testid="selected-footprint-rule">
              <h3 className="text-xs font-semibold text-emerald-800 dark:text-emerald-200">Selected footprint</h3>
              {loading && <AnalysisStatus kind="loading" compact>Analyzing…</AnalysisStatus>}
              {error && <AnalysisStatus kind="error" compact>{error}</AnalysisStatus>}
              {result?.warnings && result.warnings.length > 0 && (
                <AnalysisStatus kind="warning" compact>{result.warnings.map((w, i) => <div key={i}>{w}</div>)}</AnalysisStatus>
              )}
              {result && (
                <SizesTab
                  result={result}
                  isFullView={isFullView}
                  selectedFootprints={selectedFootprints}
                  targetDatasets={targetDatasets}
                  chartWidth={chartWidth}
                  footprintGroups={footprintGroups}
                  addFootprintGroup={addFootprintGroup}
                  updateFootprintGroup={updateFootprintGroup}
                  removeFootprintGroup={removeFootprintGroup}
                  customGroupEdit={customGroupEdit}
                  setCustomGroupEdit={setCustomGroupEdit}
                  customMin={customMin}
                  setCustomMin={setCustomMin}
                  customMax={customMax}
                  setCustomMax={setCustomMax}
                  hideCartList
                />
              )}
              {showDetails && <details className="text-xs" data-testid="manual-analysis-layers">
                <summary className="cursor-pointer text-gray-500">Layer and click target</summary>
                <div className="space-y-1.5 pt-2">
                  <LayerSelector value={layer} onChange={setLayer} allLabel="All" title="Layer" variant="chips" showAllFpOption />
                  <LayerSelector value={clickTargetLayer} onChange={setClickTargetLayer} allLabel="Best" title="Click target" variant="chips" />
                </div>
              </details>}
            </section>
          )}

          {!missingFamilyScanChemistry.length && nFootprints === 0 && (
            <p className="text-ink-muted" data-testid="footprints-intro">
              Find the recurrent footprint classes in a region, or Cmd/Ctrl-click a footprint on a read to save a size rule for it.
              Add to Saved keeps a class in this session (Saved tab); the toolbar’s Save downloads the whole session.
            </p>
          )}

          <ConsensusTools
            datasetIds={targetDatasetIds}
            peaks={selectedPeakRegions}
            activeFilterKey={footprintFilterKey}
            onFilterState={handleFilterState}
          />

          <details className="fb-disc" data-testid="compare-datasets">
            <summary><ChevronRight size={12} className="fb-disc-chevron" aria-hidden="true" />{multipleDatasets ? 'Compare strands and datasets' : 'Compare strands'}</summary>
            <div className="fb-disc-body text-xs"><ConsensusComparison/></div>
          </details>

          {missingFamilyScanChemistry.length === 0 && targetDatasetIds.length > 0 && (
            <details className="fb-disc" data-testid="dataset-assay-types">
              <summary><ChevronRight size={12} className="fb-disc-chevron" aria-hidden="true" />Dataset assay types</summary>
              <div className="fb-disc-body text-xs"><DatasetSetupTab datasetIds={targetDatasetIds} /></div>
            </details>
          )}
        </div>
      )}

      {/* === Saved: definitions that color reads, filter, and drive co-occupancy === */}
      {activeTab === 'saved' && (
        <CartTab
          footprintGroups={footprintGroups}
          setFootprintGroups={setFootprintGroups}
          updateFootprintGroup={updateFootprintGroup}
          removeFootprintGroup={removeFootprintGroup}
          activeFilterId={activeCartFilterId}
          onApplyFilter={handleApplyCartFilter}
          onFilterSavedClass={handleFilterSavedClass}
          onClearFilter={handleClearCartFilter}
          targetDatasetIds={targetDatasetIds}
          chartWidth={chartWidth}
        />
      )}

      {/* === Co-occupancy === */}
      {activeTab === 'co-occ' && (
        <div className="space-y-2">
          {coRegionUnresolved && <AnalysisRegionChoice loci={targetLoci} what="Co-occupancy" />}
          <AnalysisRunSummary
            seed={analysisSampleSeed}
            analysisCap={analysisSampleCount}
            showAnalysisCap
            // An occupancy filter already has its green "Clear filter" bar above (L11).
            filterActive={focusedReadIdArrays !== null}
            filterLabel="Cluster focus"
            filterSource={focusedReadIdArrays !== null ? 'cluster-detail' : null}
            filterSourceLabel="Clusters"
            qualityFilterCount={enabledQualityFilterCount}
            peaksLocked={peaksLocked}
            inputs={[
              `${cooccFootprintGroups.length} compared definition${cooccFootprintGroups.length !== 1 ? 's' : ''}`,
              `${targetDatasets.length} dataset${targetDatasets.length !== 1 ? 's' : ''}`,
            ]}
            outputs={[]}
          />
          <CoOccurrenceTab
            result={coocResult}
            footprintGroups={cooccFootprintGroups}
            targetDatasets={targetDatasets}
            coOccLoading={coOccLoading}
            clusterLoading={clusterLoading}
            footprintFilterKey={footprintFilterKey}
            currentLayer={layer}
            handleCellClick={handleCellClick}
            handleClusterByGroups={handleClusterByGroups}
            membershipLegend={membershipLegend}
            clusterSelection={clusterSelection}
            onClusterSelectionChange={handleClusterSelectionChange}
          />
        </div>
      )}
      </div>
      </AnalysisPanelShell>
      {/* Removing a saved class or Clear all: one step back for a few seconds. */}
      <UndoToast scope="footprints" className="sticky bottom-2 z-30 mx-3" />
    </div>
  );
}
