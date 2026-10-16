import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { filterByTranscriptionState, type TranscriptionStateFilterResult } from '../../api/transcription';
import { downloadTextFile, exportTimestamp, formatTsv, safeFilenamePart, toPythonLiteral } from '../../utils/analysisExport';
import { Pol2COMView } from '../charts/Pol2COMView';
import { getClusterColor, getClusterLabel } from '../tracks/ReadTrack';
import type { HistogramGroup } from '../charts/HistogramChart';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { useFocusedReadIds, buildStateKeyToDs } from '../../hooks/useFocusedReadIds';
import { consumeRequestedTab, normalizeRequestedTab } from '../../utils/requestedTabs';
import { buildTranscriptionStateRequestKey } from '../../utils/transcriptionStateRequestKey';
import { getDatasetDisplayLabel } from '../../utils/datasetLabels';
import { countElongatingInRange, readStatesByDataset, clusterCohorts } from '../../utils/readStatesByDataset';
import { bootstrapMeanCI, wilsonCountInterval } from '../../utils/statistics';
import { AnalysisButton, AnalysisExportGroup, AnalysisPanelHeader, AnalysisPanelShell, AnalysisRunSummary, AnalysisStatus } from './shared';
import { CooccurrenceTab } from './transcription-state/CooccurrenceTab';
import { DistributionTab } from './transcription-state/DistributionTab';
import { invalidateFilterRequests, isCurrentFilterRequest, nextFilterRequest } from '../../utils/filterRequests';
import { FiltersTab, classifiedTotal } from './transcription-state/FiltersTab';
import { useAnalysisSettingsKey } from '../../hooks/useAnalysisSettingsKey';
import { useRememberedState } from '../../hooks/useRememberedState';
import { useAnalysisLoci } from '../../hooks/useAnalysisLoci';
import { stateKeysAtLocus } from '../../utils/analysisLocus';
import { AnalysisRegionChoice } from './shared/AnalysisRegionChoice';

const TRANSCRIPTION_STATE_TAB_STORAGE_KEY = 'fiberbrowser_transcription_state_tab';
const TRANSCRIPTION_STATE_TABS = ['filters', 'distribution', 'cooccurrence', 'pol2com'] as const;
type TranscriptionStateTab = typeof TRANSCRIPTION_STATE_TABS[number];

/** The panels a Clear resets: the current targets plus any still holding this panel's filter. */
export function transcriptionFilterKeys(
  targetStateKeys: readonly string[],
  sources: Record<string, { target?: string } | null | undefined>,
): string[] {
  const owned = Object.entries(sources)
    .filter(([, source]) => source?.target === 'transcription-filters')
    .map(([key]) => key);
  return [...new Set([...targetStateKeys, ...owned])];
}

function normalizeTranscriptionStateTab(
  tab: string | null | undefined,
  fallback: TranscriptionStateTab = 'filters',
): TranscriptionStateTab {
  return normalizeRequestedTab(tab, TRANSCRIPTION_STATE_TABS, fallback);
}

function consumeRequestedTranscriptionStateTab(): TranscriptionStateTab {
  return consumeRequestedTab(TRANSCRIPTION_STATE_TAB_STORAGE_KEY, TRANSCRIPTION_STATE_TABS, 'filters');
}

export function TranscriptionStatePanel({ isFullView }: { isFullView?: boolean }) {
  const {
    chrom: mainChrom,
    start: mainStart,
    end: mainEnd,
    spanningOnly,
    datasets,
    selectedDatasets,
    selectedGenes,
    clearGeneSelection,
    transcriptionStateFilters,
    setTranscriptionStateFilters,
    resetTranscriptionStateFilters,
    setReadStateDetails,
    setFilteredReadIds,
    clearReadStateDetails,
    filteredReadIds,
    readStateDetails: storedReadStateDetails,
    clusterAssignments,
    clusterOrder,
    analysisSampleSeed,
    activeColormap,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom,
    start: s.start,
    end: s.end,
    spanningOnly: s.spanningOnly,
    datasets: s.datasets,
    selectedDatasets: s.selectedDatasets,
    selectedGenes: s.selectedGenes,
    clearGeneSelection: s.clearGeneSelection,
    transcriptionStateFilters: s.transcriptionStateFilters,
    setTranscriptionStateFilters: s.setTranscriptionStateFilters,
    resetTranscriptionStateFilters: s.resetTranscriptionStateFilters,
    setReadStateDetails: s.setReadStateDetails,
    setFilteredReadIds: s.setFilteredReadIds,
    clearReadStateDetails: s.clearReadStateDetails,
    filteredReadIds: s.filteredReadIds,
    readStateDetails: s.readStateDetails,
    clusterAssignments: s.clusterAssignments,
    clusterOrder: s.clusterOrder,
    analysisSampleSeed: s.analysisSampleSeed,
    activeColormap: s.activeColormap,
  })));

  const [countsLoading, setCountsLoading] = useState(false);
  const [filterLoading, setFilterLoading] = useState(false);
  const [rawSummary, setSummary] = useState<Record<string, TranscriptionStateFilterResult['summary']>>({});
  // The request scope (view, genes, datasets, spanning, sampling) the summary and
  // read states were computed for; shown and exported only while it's current.
  const [summaryScope, setSummaryScope] = useState<string | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useRememberedState<TranscriptionStateTab>('transcription-state:tab', consumeRequestedTranscriptionStateTab, TRANSCRIPTION_STATE_TAB_STORAGE_KEY);
  const [showThresholdSettings, setShowThresholdSettings] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [countsRefreshKey, setCountsRefreshKey] = useState(0);
  const countsRequestSeqRef = useRef(0);
  const filterRequestSeqRef = useRef(0);
  const filterControllerRef = useRef<AbortController | null>(null);
  const loading = countsLoading || filterLoading;

  useEffect(() => {
    const handleOpenTab = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      setActiveTab(normalizeTranscriptionStateTab(tab, activeTab));
    };
    window.addEventListener('fiberbrowser:open-transcription-state-tab', handleOpenTab);
    return () => window.removeEventListener('fiberbrowser:open-transcription-state-tab', handleOpenTab);
  }, [activeTab]);

  // Shared hooks
  const [containerWidth, containerRef] = useContainerWidth(280);
  const { targetDatasetIds, targetStateKeys, stateKeyMap, focusedReadIdSets: focusedReadIds, hasClusterFocus } = useFocusedReadIds();
  // The region analysed: the one the targeted panels show (their own locus or
  // reference), not the main view by default; panels at different regions ask which.
  const targetLoci = useAnalysisLoci(targetStateKeys);
  const locus = targetLoci.length === 1 ? targetLoci[0] : null;
  const regionUnresolved = targetLoci.length > 1;
  const chrom = locus?.chrom ?? mainChrom;
  const start = locus?.start ?? mainStart;
  const end = locus?.end ?? mainEnd;
  const genome = locus?.genome ?? null;
  const locusRef = useRef(locus);
  locusRef.current = locus;

  // Reverse map: stateKey → datasetId (for display labels/colors)
  const stateKeyToDs = useMemo(() => buildStateKeyToDs(stateKeyMap), [stateKeyMap]);
  // Results describe the analysed region's reads: only panels showing it take
  // them (a copy at another locus keeps its own reads). Resolved when results land.
  const mainViewKeys = useCallback((dsId: string): string[] => {
    const keys = stateKeyMap[dsId];
    if (!keys) return [dsId];
    const st = useBrowserStore.getState();
    const at = new Set(stateKeysAtLocus(st, locusRef.current ?? { chrom: st.chrom, start: st.start, end: st.end, genome: null }));
    return keys.filter(sk => at.has(sk));
  }, [stateKeyMap]);
  const getDsForKey = useCallback((sk: string) => datasets.find(d => d.id === (stateKeyToDs[sk] || sk)), [stateKeyToDs, datasets]);

  // Gene names for display
  const geneNames = useMemo(() =>
    selectedGenes.map(g => g.name || g.id).join(', '),
    [selectedGenes]
  );
  const selectedGeneIds = useMemo(
    () => selectedGenes.map(g => g.id),
    [selectedGenes],
  );

  const targetDatasets = useMemo(() =>
    targetDatasetIds.map(id => datasets.find(d => d.id === id)).filter(Boolean) as typeof datasets,
    [datasets, targetDatasetIds]
  );
  // Quality filters change which calls classify a read: counts are keyed to them.
  const settingsKey = useAnalysisSettingsKey();
  const stateCountsRequestKey = useMemo(() => buildTranscriptionStateRequestKey({
    chrom: genome ? `${genome}|${chrom}` : chrom,
    start,
    end,
    spanning: spanningOnly,
    datasetIds: targetDatasetIds,
    geneIds: selectedGeneIds,
    filters: { pause: true, pic: true, elongating: 1, elongating_max: null },
    sampleSeed: analysisSampleSeed,
    analysisSettingsKey: settingsKey,
  }), [analysisSampleSeed, chrom, end, genome, selectedGeneIds, spanningOnly, start, targetDatasetIds, settingsKey]);
  const applyFilterRequestKey = useMemo(() => buildTranscriptionStateRequestKey({
    chrom: genome ? `${genome}|${chrom}` : chrom,
    start,
    end,
    spanning: spanningOnly,
    datasetIds: targetDatasetIds,
    geneIds: selectedGeneIds,
    filters: transcriptionStateFilters,
    sampleSeed: analysisSampleSeed,
    analysisSettingsKey: settingsKey,
  }), [analysisSampleSeed, chrom, end, genome, selectedGeneIds, spanningOnly, start, targetDatasetIds, transcriptionStateFilters, settingsKey]);
  const summaryCurrent = summaryScope === stateCountsRequestKey;
  const summary = useMemo(
    () => (summaryCurrent ? rawSummary : {}) as Record<string, TranscriptionStateFilterResult['summary']>,
    [rawSummary, summaryCurrent],
  );
  const readStateDetails = useMemo(
    () => (summaryCurrent ? storedReadStateDetails : {}) as typeof storedReadStateDetails,
    [storedReadStateDetails, summaryCurrent],
  );

  // Label for target datasets
  const targetDatasetsLabel = useMemo(() => {
    if (selectedDatasets.size === 0) {
      return datasets.length === 1 ? getDatasetDisplayLabel(datasets[0]) : 'All datasets';
    }
    if (targetDatasets.length === 1) {
      return getDatasetDisplayLabel(targetDatasets[0]);
    }
    return `${targetDatasets.length} datasets`;
  }, [datasets, selectedDatasets, targetDatasets]);

  // Check if any filter is active
  const hasActiveFilter = !!(transcriptionStateFilters.pause ||
    transcriptionStateFilters.pic ||
    transcriptionStateFilters.elongating !== null);

  // Check if filter is actually applied (check stateKeys since filteredReadIds may be keyed by stateKey)
  const hasAppliedFilter = useMemo(() => {
    // An empty set is an applied filter (one that matched nothing).
    return targetStateKeys.some(sk => filteredReadIds[sk] != null);
  }, [targetStateKeys, filteredReadIds]);
  const enabledQualityFilterCount = activeColormap.qualityFilters.filter(filter => filter.enabled).length;

  // Auto-fetch counts when genes are selected, scoped to the current viewport
  // and target datasets. Sequence guards prevent stale count payloads from
  // overwriting newer state after rapid navigation or gene changes.
  useEffect(() => {
    if (selectedGenes.length === 0 || targetDatasets.length === 0 || regionUnresolved) {
      countsRequestSeqRef.current += 1;
      setCountsLoading(false);
      return;
    }

    const controller = new AbortController();
    const requestSeq = ++countsRequestSeqRef.current;
    const scope = stateCountsRequestKey;
    setCountsLoading(true);
    setCountsError(null);
    filterByTranscriptionState(
      chrom, start, end, spanningOnly,
      targetDatasetIds,
      selectedGeneIds,
      { pause: true, pic: true, elongating: 1, elongating_max: null },
      analysisSampleSeed,
      { signal: controller.signal, genome },
    )
      .then(result => {
        if (countsRequestSeqRef.current !== requestSeq || controller.signal.aborted) return;
        const summaries: Record<string, TranscriptionStateFilterResult['summary']> = {};
        for (const [dsId, res] of Object.entries(result.results)) {
          summaries[dsId] = res.summary;
          for (const sk of mainViewKeys(dsId)) {
            setReadStateDetails(sk, res.read_states);
          }
        }
        setSummary(summaries);
        setSummaryScope(scope);
      })
      .catch(err => {
        if (controller.signal.aborted || err?.name === 'AbortError') return;
        if (countsRequestSeqRef.current === requestSeq) {
          console.error('Failed to fetch state counts:', err);
          setCountsError(`Transcription states could not be computed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
      .finally(() => {
        if (countsRequestSeqRef.current === requestSeq && !controller.signal.aborted) {
          setCountsLoading(false);
        }
      });

    return () => {
      controller.abort();
      if (countsRequestSeqRef.current === requestSeq) countsRequestSeqRef.current += 1;
      setCountsLoading(false);
    };
  }, [countsRefreshKey, stateCountsRequestKey, selectedGenes.length, targetDatasets.length, regionUnresolved, mainViewKeys, setReadStateDetails]);

  // Apply the current filter selection
  // A pending Apply is for this view, genes and panels: moving on (or closing
  // the panel) drops it, so old read ids never land on the new view.
  // The whole request (spanning mode, sampling and filters included) and its panels.
  const applyScopeKey = `${applyFilterRequestKey}|${targetStateKeys.join(',')}`;
  useEffect(() => {
    filterRequestSeqRef.current += 1;
    filterControllerRef.current?.abort();
    filterControllerRef.current = null;
    setFilterLoading(false);
  }, [applyScopeKey]);
  useEffect(() => () => {
    filterRequestSeqRef.current += 1;
    filterControllerRef.current?.abort();
  }, []);

  const handleApplyFilter = useCallback(async () => {
    if (selectedGenes.length === 0 || targetDatasets.length === 0 || regionUnresolved) return;
    if (!hasActiveFilter) return;

    filterControllerRef.current?.abort();
    const controller = new AbortController();
    filterControllerRef.current = controller;
    const requestSeq = ++filterRequestSeqRef.current;
    // Shared with the toolbar and other filters: their Clear (or a newer filter) supersedes this.
    const sharedRequest = nextFilterRequest();
    const scope = stateCountsRequestKey;
    setFilterLoading(true);
    try {
      const result = await filterByTranscriptionState(
        chrom, start, end, spanningOnly,
        targetDatasetIds,
        selectedGeneIds,
        transcriptionStateFilters,
        analysisSampleSeed,
        { signal: controller.signal, genome },
      );

      if (filterRequestSeqRef.current !== requestSeq || controller.signal.aborted) return;
      if (!isCurrentFilterRequest(sharedRequest)) return;

      // Store results under stateKeys (supports duplicated panels)
      const summaries: Record<string, TranscriptionStateFilterResult['summary']> = {};
      for (const [dsId, res] of Object.entries(result.results)) {
        for (const sk of mainViewKeys(dsId)) {
          setFilteredReadIds(sk, new Set(res.filtered_ids), {
            target: 'transcription-filters',
            label: 'Transcription > Filters',
          });
          setReadStateDetails(sk, res.read_states);
        }
        summaries[dsId] = res.summary;
      }
      // Summaries of an older scope aren't kept alongside this one's.
      setSummary(prev => ({ ...(summaryScope === scope ? prev : {}), ...summaries }));
      setSummaryScope(scope);
      useBrowserStore.getState().pushSnapshot('Apply transcription filter');
    } catch (err) {
      if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') return;
      if (filterRequestSeqRef.current === requestSeq) {
        console.error('Failed to apply filter:', err);
      }
    } finally {
      if (filterRequestSeqRef.current === requestSeq && !controller.signal.aborted) {
        setFilterLoading(false);
        filterControllerRef.current = null;
      }
    }
  }, [chrom, start, end, genome, regionUnresolved, spanningOnly, targetDatasetIds, selectedGenes.length, targetDatasets.length,
      selectedGeneIds, transcriptionStateFilters, hasActiveFilter, setFilteredReadIds,
      setReadStateDetails, analysisSampleSeed, applyFilterRequestKey, mainViewKeys, stateCountsRequestKey, summaryScope]);

  // Clear all filters (scoped to target stateKeys)
  const handleClear = useCallback(() => {
    countsRequestSeqRef.current += 1;
    filterRequestSeqRef.current += 1;
    invalidateFilterRequests();
    filterControllerRef.current?.abort();
    filterControllerRef.current = null;
    setCountsLoading(false);
    setFilterLoading(false);
    resetTranscriptionStateFilters();
    clearReadStateDetails();
    // Every panel this panel filtered, not just the current targets (they may
    // have changed since Apply).
    for (const sk of transcriptionFilterKeys(targetStateKeys, useBrowserStore.getState().readFilterSources)) {
      setFilteredReadIds(sk, null);
    }
    setSummary({});
    setSummaryScope(null);
    setCountsError(null);
    clearGeneSelection();
    useBrowserStore.getState().pushSnapshot('Clear transcription filter');
  }, [resetTranscriptionStateFilters, clearReadStateDetails, setFilteredReadIds, targetStateKeys, clearGeneSelection]);

  // Toggle individual filters
  const togglePause = () => setTranscriptionStateFilters({ pause: !transcriptionStateFilters.pause });
  const togglePic = () => setTranscriptionStateFilters({ pic: !transcriptionStateFilters.pic });

  // Elongating has min/max thresholds. While the filter is on, the controls
  // show the applied values (also after the panel is closed and reopened).
  const appliedElongatingMin = transcriptionStateFilters.elongating;
  const appliedElongatingMax = transcriptionStateFilters.elongating_max ?? null;
  const [elongatingMin, setElongatingMin] = useState(appliedElongatingMin ?? 1);
  const [elongatingMax, setElongatingMax] = useState<number | null>(appliedElongatingMax);
  const [elongatingMaxEnabled, setElongatingMaxEnabled] = useState(appliedElongatingMin != null && appliedElongatingMax != null);
  useEffect(() => {
    if (appliedElongatingMin == null) return;
    setElongatingMin(appliedElongatingMin);
    setElongatingMaxEnabled(appliedElongatingMax != null);
    if (appliedElongatingMax != null) setElongatingMax(appliedElongatingMax);
  }, [appliedElongatingMin, appliedElongatingMax]);
  const toggleElongating = () => {
    if (transcriptionStateFilters.elongating === null) {
      setTranscriptionStateFilters({ elongating: elongatingMin, elongating_max: elongatingMaxEnabled ? elongatingMax : null });
    } else {
      setTranscriptionStateFilters({ elongating: null, elongating_max: null });
    }
  };
  const handleElongatingMinChange = (value: number) => {
    setElongatingMin(value);
    if (transcriptionStateFilters.elongating !== null) {
      setTranscriptionStateFilters({ elongating: value });
    }
  };
  const handleElongatingMaxChange = (value: number | null) => {
    setElongatingMax(value);
    if (transcriptionStateFilters.elongating !== null) {
      setTranscriptionStateFilters({ elongating_max: value });
    }
  };
  const toggleElongatingMax = () => {
    const newEnabled = !elongatingMaxEnabled;
    setElongatingMaxEnabled(newEnabled);
    if (newEnabled && elongatingMax === null) {
      setElongatingMax(5);
    }
    if (transcriptionStateFilters.elongating !== null) {
      setTranscriptionStateFilters({ elongating_max: newEnabled ? (elongatingMax ?? 5) : null });
    }
  };

  // Cluster-focus-filtered summary: re-derive from readStateDetails when focus is active
  const filteredSummary = useMemo(() => {
    if (!hasClusterFocus || Object.keys(readStateDetails).length === 0) return summary;

    const result: typeof summary = { ...summary };
    // One summary per dataset: its panels' focused reads, each counted once.
    const byDataset = readStatesByDataset(targetStateKeys, stateKeyToDs, readStateDetails, focusedReadIds);
    for (const [dsId, { states: dsStates, focus: focusIds }] of Object.entries(byDataset)) {
      if (!focusIds) continue; // a panel of it shows every read: the original summary
      let pause = 0, pic = 0, elong1 = 0, elong3 = 0, elong5 = 0, total = 0;
      const elongDist = { '1': 0, '2': 0, '3': 0, '4+': 0 };
      for (const [readId, rs] of Object.entries(dsStates)) {
        if (!focusIds.has(readId)) continue;
        total++;
        if (rs.pause) pause++;
        if (rs.pic) pic++;
        if (rs.elongating_count >= 1) elong1++;
        if (rs.elongating_count >= 3) elong3++;
        if (rs.elongating_count >= 5) elong5++;
        const ec = rs.elongating_count;
        if (ec === 1) elongDist['1']++;
        else if (ec === 2) elongDist['2']++;
        else if (ec === 3) elongDist['3']++;
        else if (ec >= 4) elongDist['4+']++;
      }
      result[dsId] = {
        ...summary[dsId],
        total_matching: total,
        // The focused reads classified at the genes: the denominator of every rate.
        overlapping_genes: total,
        pause, pic,
        elongating_gte_1: elong1, elongating_gte_3: elong3, elongating_gte_5: elong5,
        elongating_dist: elongDist,
      };
    }
    return result;
  }, [readStateDetails, summary, hasClusterFocus, focusedReadIds, targetStateKeys, stateKeyToDs]);

  // Per-dataset summary data for bar charts (uses cluster-filtered summary)
  const perDatasetBars = useMemo(() => {
    if (Object.keys(filteredSummary).length === 0) return null;
    const classes = [
      { key: 'pause', label: 'Pause', color: '#ef4444' },
      { key: 'pic', label: 'PIC', color: '#3b82f6' },
      { key: 'elongating_gte_1', label: 'Elongating', color: '#22c55e', stacked: true },
    ];

    return classes.map(cls => ({
      ...cls,
      bars: targetDatasets.map(ds => {
        const s = filteredSummary[ds.id];
        if (!s) return { dsId: ds.id, dsLabel: getDatasetDisplayLabel(ds), dsColor: ds.color, count: 0, total: 0, pct: 0, segments: undefined as undefined | { label: string; count: number; pct: number; color: string }[] };
        const count = (s as any)[cls.key] || 0;
        // Rates are of the reads classified at the genes, not of those passing
        // the applied filter (a pause-only filter would give 500% elongating).
        const total = classifiedTotal(s) || 1;
        // Build stacked segments for elongating
        let segments: { label: string; count: number; pct: number; color: string }[] | undefined;
        if (cls.stacked && s.elongating_dist) {
          const d = s.elongating_dist;
          segments = [
            { label: '1', count: d['1'], pct: total > 0 ? (d['1'] / total) * 100 : 0, color: '#bbf7d0' },
            { label: '2', count: d['2'], pct: total > 0 ? (d['2'] / total) * 100 : 0, color: '#4ade80' },
            { label: '3', count: d['3'], pct: total > 0 ? (d['3'] / total) * 100 : 0, color: '#16a34a' },
            { label: '4+', count: d['4+'], pct: total > 0 ? (d['4+'] / total) * 100 : 0, color: '#065f46' },
          ];
        }
        return {
          dsId: ds.id,
          dsLabel: getDatasetDisplayLabel(ds),
          dsColor: ds.color,
          count,
          total,
          pct: total > 0 ? (count / total) * 100 : 0,
          segments,
        };
      }),
    }));
  }, [filteredSummary, targetDatasets]);

  // Get combined summary from all datasets (uses cluster-filtered summary)
  const combinedSummary = useMemo(() => {
    const combined = {
      pause: 0, pic: 0,
      elongating_gte_1: 0, elongating_gte_3: 0, elongating_gte_5: 0,
      elongating_dist: { '1': 0, '2': 0, '3': 0, '4+': 0 },
      total_matching: 0, overlapping_genes: 0
    };
    for (const s of Object.values(filteredSummary)) {
      if (!s) continue;
      combined.pause += s.pause ?? 0;
      combined.pic += s.pic ?? 0;
      combined.elongating_gte_1 += s.elongating_gte_1 ?? 0;
      combined.elongating_gte_3 += s.elongating_gte_3 ?? 0;
      combined.elongating_gte_5 += s.elongating_gte_5 ?? 0;
      if (s.elongating_dist) {
        combined.elongating_dist['1'] += s.elongating_dist['1'] ?? 0;
        combined.elongating_dist['2'] += s.elongating_dist['2'] ?? 0;
        combined.elongating_dist['3'] += s.elongating_dist['3'] ?? 0;
        combined.elongating_dist['4+'] += s.elongating_dist['4+'] ?? 0;
      }
      combined.total_matching += s.total_matching ?? 0;
      combined.overlapping_genes += s.overlapping_genes ?? 0;
    }
    return combined;
  }, [filteredSummary]);

  // Reads with an elongating count inside the exact [min, max] set here (the
  // summary only has >=1/3/5 buckets), within each dataset's focus.
  const elongatingCount = useMemo(() => {
    const exact = countElongatingInRange(
      readStatesByDataset(targetStateKeys, stateKeyToDs, readStateDetails, focusedReadIds),
      elongatingMin, elongatingMaxEnabled ? elongatingMax : null,
    );
    if (exact != null) return exact;
    if (elongatingMin >= 5) return combinedSummary.elongating_gte_5;
    if (elongatingMin >= 3) return combinedSummary.elongating_gte_3;
    return combinedSummary.elongating_gte_1;
  }, [combinedSummary, elongatingMin, elongatingMax, elongatingMaxEnabled, targetStateKeys, stateKeyToDs,
      readStateDetails, focusedReadIds]);

  // Co-occurrence matrices per dataset (filtered by cluster focus + dataset selection)
  const cooccurrenceByDataset = useMemo(() => {
    const states = ['pause', 'pic', 'elongating'] as const;
    const result: Record<string, { matrix: number[][]; rawMatrix: number[][]; totalReads: number }> = {};
    const byDataset = readStatesByDataset(targetStateKeys, stateKeyToDs, readStateDetails, focusedReadIds);
    for (const [dsId, { states: dsStates, focus: focusIds }] of Object.entries(byDataset)) {
      const rawMatrix = states.map(() => states.map(() => 0));
      let totalReads = 0;
      for (const [readId, rs] of Object.entries(dsStates)) {
        if (focusIds && !focusIds.has(readId)) continue; // skip unfocused reads
        totalReads++;
        const flags = [rs.pause, rs.pic, rs.elongating_count >= 1];
        for (let i = 0; i < states.length; i++)
          for (let j = 0; j < states.length; j++)
            if (flags[i] && flags[j]) rawMatrix[i][j]++;
      }
      const maxVal = Math.max(1, ...rawMatrix.flat());
      result[dsId] = {
        rawMatrix,
        totalReads,
        matrix: rawMatrix.map(row => row.map(v => v / maxVal)),
      };
    }
    return result;
  }, [readStateDetails, focusedReadIds, targetStateKeys, stateKeyToDs]);

  // Per-cluster mean elongating-Pol II count, one bar per cluster.
  // Single-dataset mode colors bars by cluster; multi-dataset uses dataset
  // colors with grouped bars (matches the existing distribution charts).
  const perClusterPolII = useMemo<HistogramGroup[]>(() => {
    const orderedClusters: number[] = [];
    const seen = new Set<number>();
    for (const sk of targetStateKeys) {
      const order = clusterOrder[sk];
      const assigns = clusterAssignments[sk];
      if (!assigns) continue;
      const source = order && order.length
        ? order
        : Array.from(new Set(Object.values(assigns))).sort((a, b) => a - b);
      for (const c of source) {
        if (!seen.has(c)) {
          seen.add(c);
          orderedClusters.push(c);
        }
      }
    }
    if (orderedClusters.length === 0) return [];

    // One bar per clustering: a dataset's panels with the same clusters count
    // each read once; a copy clustered on its own gets its own bar.
    const cohorts = clusterCohorts(targetStateKeys, stateKeyToDs, clusterAssignments)
      .filter(c => targetDatasets.some(ds => ds.id === c.datasetId));
    const copies = (dsId: string) => cohorts.filter(c => c.datasetId === dsId).length;
    const multi = cohorts.length > 1;
    return orderedClusters.map(cluster => ({
      label: getClusterLabel(cluster, true),
      bars: cohorts.map(({ datasetId, stateKey, copyIndex }) => {
        const ds = targetDatasets.find(d => d.id === datasetId)!;
        const values: number[] = [];
        const states = readStateDetails[stateKey];
        const assigns = clusterAssignments[stateKey];
        if (states && assigns) {
          for (const [readId, info] of Object.entries(states)) {
            if (assigns[readId] !== cluster) continue;
            values.push(info.elongating_count);
          }
        }
        const value = values.length > 0
          ? values.reduce((sum, current) => sum + current, 0) / values.length
          : 0;
        const ci = bootstrapMeanCI(values, {
          seed: `${analysisSampleSeed}:pol2:${ds.id}${copyIndex ? `:${copyIndex}` : ''}:${cluster}`,
          resamples: 1000,
        });
        return {
          label: `${getDatasetDisplayLabel(ds)}${copies(datasetId) > 1 ? ` (copy ${copyIndex + 1})` : ''}`,
          value,
          ciLow: ci.low,
          ciHigh: ci.high,
          n: ci.n,
          color: multi ? ds.color : getClusterColor(cluster),
        };
      }),
    }));
  }, [analysisSampleSeed, targetStateKeys, targetDatasets, stateKeyToDs, readStateDetails, clusterAssignments, clusterOrder]);

  // Elongating distribution histogram groups (uses cluster-filtered summary)
  const elongatingGroups = useMemo(() => {
    if (Object.keys(filteredSummary).length === 0) return [];
    return ['1', '2', '3', '4+'].map(label => ({
      label,
      bars: targetDatasets.map(ds => {
        const s = filteredSummary[ds.id];
        const count = s?.elongating_dist?.[label as keyof typeof s.elongating_dist] || 0;
        const total = s ? classifiedTotal(s) : 0;
        const ci = wilsonCountInterval(count, total);
        return {
          label: getDatasetDisplayLabel(ds),
          value: count,
          ciLow: ci.low,
          ciHigh: ci.high,
          n: total,
          color: ds.color,
        };
      }),
    }));
  }, [filteredSummary, targetDatasets]);

  const chartWidth = Math.max(200, containerWidth - 24);
  const readStateRowCount = useMemo(
    () => targetStateKeys.reduce((sum, sk) => sum + Object.keys(readStateDetails[sk] || {}).length, 0),
    [readStateDetails, targetStateKeys],
  );
  const analysisInputs = [
    `${selectedGenes.length} gene${selectedGenes.length !== 1 ? 's' : ''}`,
    targetDatasetsLabel,
    spanningOnly ? 'spanning reads' : 'overlapping reads',
  ];
  const analysisOutputs = Object.keys(filteredSummary).length > 0
    ? [
        `${combinedSummary.total_matching.toLocaleString()} matching reads`,
        `${readStateRowCount.toLocaleString()} classified reads`,
      ]
    : [];

  const exportBase = useCallback((suffix: string) => [
    'transcription_state',
    safeFilenamePart(chrom),
    `${start}-${end}`,
    safeFilenamePart(geneNames || 'genes'),
    suffix,
    exportTimestamp(),
  ].join('_'), [chrom, end, geneNames, start]);

  const buildExportPayload = useCallback(() => ({
    kind: 'fiberbrowser.transcription_state.v1',
    exported_at: new Date().toISOString(),
    settings: {
      chrom, start, end,
      spanning: spanningOnly,
      sample_seed: analysisSampleSeed,
      genes: selectedGenes.map(g => ({
        id: g.id,
        name: g.name,
        chrom: g.chrom,
        start: g.start,
        end: g.end,
        strand: g.strand,
      })),
      datasets: targetDatasets.map(ds => ({ id: ds.id, label: ds.label })),
      filters: transcriptionStateFilters,
      active_cluster_focus: hasClusterFocus,
      applied_read_filter: hasAppliedFilter,
    },
    summary: filteredSummary,
    combined_summary: combinedSummary,
    per_cluster_pol2: perClusterPolII.map(g => ({
      cluster: g.label,
      datasets: g.bars.map(b => ({ label: b.label, mean_pol2: b.value })),
    })),
    read_state_details: readStateDetails,
    filtered_read_ids: Object.fromEntries(
      targetStateKeys.map(sk => [sk, filteredReadIds[sk] ? Array.from(filteredReadIds[sk]!) : null])
    ),
  }), [analysisSampleSeed, chrom, combinedSummary, end, filteredReadIds, filteredSummary, hasAppliedFilter, hasClusterFocus, perClusterPolII, readStateDetails, selectedGenes, spanningOnly, start, targetDatasets, targetStateKeys, transcriptionStateFilters]);

  const handleExportJson = useCallback(() => {
    downloadTextFile(
      JSON.stringify(buildExportPayload(), null, 2),
      `${exportBase('state')}.json`,
      'application/json',
    );
    setExportStatus('Exported state JSON');
  }, [buildExportPayload, exportBase]);

  const handleExportTsv = useCallback(() => {
    const rows: unknown[][] = [[
      'dataset_key',
      'dataset_id',
      'dataset_label',
      'read_id',
      'pause',
      'pic',
      'elongating_count',
      'passes_applied_filter',
    ]];
    for (const sk of targetStateKeys) {
      const dsId = stateKeyToDs[sk] || sk;
      const ds = getDsForKey(sk);
      const states = readStateDetails[sk];
      if (!states) continue;
      const filtered = filteredReadIds[sk];
      for (const [readId, stateInfo] of Object.entries(states)) {
        rows.push([
          sk,
          dsId,
          ds?.label ?? dsId,
          readId,
          stateInfo.pause,
          stateInfo.pic,
          stateInfo.elongating_count,
          filtered ? filtered.has(readId) : '',
        ]);
      }
    }
    downloadTextFile(
      formatTsv(rows),
      `${exportBase('read_states')}.tsv`,
      'text/tab-separated-values',
    );
    setExportStatus(`Exported ${Math.max(0, rows.length - 1).toLocaleString()} read-state rows`);
  }, [exportBase, filteredReadIds, getDsForKey, readStateDetails, stateKeyToDs, targetStateKeys]);

  const handleCopyPython = useCallback(async () => {
    const command = [
      'client.filter_by_transcription_state(',
      `gene_ids=${toPythonLiteral(selectedGenes.map(g => g.id))}, `,
      `chrom=${toPythonLiteral(chrom)}, `,
      `start=${start}, `,
      `end=${end}, `,
      `spanning=${toPythonLiteral(spanningOnly)}, `,
      `dataset_ids=${toPythonLiteral(targetDatasetIds)}, `,
      `filters=${toPythonLiteral(transcriptionStateFilters)}, `,
      `sample_seed=${toPythonLiteral(analysisSampleSeed)}`,
      ')',
    ].join('');
    try {
      await navigator.clipboard.writeText(command);
      setExportStatus('Copied Python command');
    } catch {
      setExportStatus('Could not copy Python command');
    }
  }, [analysisSampleSeed, chrom, end, selectedGenes, spanningOnly, start, targetDatasetIds, transcriptionStateFilters]);

  const tsTabs = [
    { key: 'filters' as const, label: 'Filters' },
    { key: 'distribution' as const, label: 'Distribution' },
    { key: 'cooccurrence' as const, label: 'Co-occur' },
    { key: 'pol2com' as const, label: 'Pol II COM' },
  ];

  const elongatingThresholdLabel = `Elongating ≥${elongatingMin}${
    elongatingMaxEnabled ? `–${elongatingMax ?? 5}` : ''
  } Pol II`;

  // Don't show if no genes selected
  if (selectedGenes.length === 0) {
    return (
      <div ref={containerRef} className="text-sm">
        <AnalysisPanelShell
          tabs={tsTabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          theme="amber"
          layout="standard"
          bodyMode="panel"
          showTabs={false}
          header={<AnalysisPanelHeader detail="Sorts the selected genes' reads by Pol II state — paused, pre-initiation (PIC) or elongating — so you can filter the reads to one state." theme="amber" />}
        >
          <AnalysisStatus kind="empty" center title="Select a gene">
            Click a gene to analyze transcription state. Shift+click for multi-select.
          </AnalysisStatus>
        </AnalysisPanelShell>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="text-sm">
      <AnalysisPanelShell
        tabs={tsTabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        theme="amber"
        layout="standard"
        bodyMode="none"
        header={
          <div className="space-y-2">
            <AnalysisPanelHeader detail="Sorts the selected genes' reads by Pol II state — paused, pre-initiation (PIC) or elongating — so you can filter the reads to one state." theme="amber" />
            {/* What it runs on, then its buttons: two wrapping rows, so a narrow
                panel never squeezes the names under the buttons. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" data-testid="transcription-target">
              <span className="min-w-0 break-words text-gray-700 dark:text-gray-200">
                <span className="text-ink-muted">Genes </span>
                <span className="font-semibold">{geneNames}</span>
              </span>
              <span
                className="max-w-full truncate rounded-full bg-gray-100 px-1.5 py-px text-[11px] font-medium text-gray-500 dark:bg-white/10 dark:text-gray-400"
                title={`Applying to ${targetDatasetsLabel}`}
              >
                Applying to {targetDatasetsLabel}
              </span>
            </div>
            {regionUnresolved && <AnalysisRegionChoice loci={targetLoci} what="Transcription states" />}
            <div className="flex flex-wrap items-center gap-1">
              <AnalysisButton
                theme="amber"
                variant="primary"
                size="sm"
                onClick={handleApplyFilter}
                disabled={!hasActiveFilter || loading || regionUnresolved}
                data-tour="transcription-apply"
                title="Filter the reads to the ticked states"
              >
                {loading && hasActiveFilter ? 'Applying...' : 'Apply'}
              </AnalysisButton>
              <AnalysisButton
                theme="amber"
                variant="soft"
                size="sm"
                onClick={handleClear}
                data-tour="transcription-clear"
              >
                Clear
              </AnalysisButton>
              <AnalysisButton
                theme="amber"
                variant="soft"
                size="sm"
                onClick={() => setCountsRefreshKey(k => k + 1)}
                disabled={loading}
                title="Reload transcription-state counts for the selected genes"
              >
                Refresh
              </AnalysisButton>
              <AnalysisExportGroup>
                <AnalysisButton
                  variant="neutral"
                  size="sm"
                  onClick={handleExportJson}
                  disabled={Object.keys(filteredSummary).length === 0}
                  data-tour="transcription-export"
                  title="Export reproducible transcription-state settings and JSON results"
                >
                  JSON
                </AnalysisButton>
                <AnalysisButton
                  variant="neutral"
                  size="sm"
                  onClick={handleExportTsv}
                  disabled={readStateRowCount === 0}
                  title="Export per-read state table as TSV"
                >
                  TSV
                </AnalysisButton>
                <AnalysisButton
                  variant="neutral"
                  size="sm"
                  onClick={handleCopyPython}
                  title="Copy equivalent BrowserClient command"
                >
                  Python
                </AnalysisButton>
              </AnalysisExportGroup>
            </div>
          </div>
        }
        summary={
          <AnalysisRunSummary
            seed={analysisSampleSeed}
            filterActive={hasClusterFocus || hasAppliedFilter}
            filterLabel={hasAppliedFilter ? 'State filter' : 'Cluster focus'}
            filterSource={hasAppliedFilter ? 'transcription-filters' : hasClusterFocus ? 'cluster-detail' : null}
            filterSourceLabel={hasAppliedFilter ? 'Transcription > Filters' : 'Clusters'}
            qualityFilterCount={enabledQualityFilterCount}
            inputs={analysisInputs}
            outputs={analysisOutputs}
            extra={exportStatus ? (
              <span className="text-[11px] text-amber-700 dark:text-amber-300 px-1">
                {exportStatus}
              </span>
            ) : undefined}
          />
        }
      >

      {countsError && (
        <AnalysisStatus kind="error" compact>
          {countsError}
        </AnalysisStatus>
      )}

      {/* === Filters tab === */}
      {activeTab === 'filters' && (
        <FiltersTab
          loading={loading}
          hasSummary={Object.keys(summary).length > 0}
          filters={transcriptionStateFilters}
          onTogglePause={togglePause}
          onTogglePic={togglePic}
          onToggleElongating={toggleElongating}
          combinedSummary={combinedSummary}
          elongatingThresholdLabel={elongatingThresholdLabel}
          elongatingCount={elongatingCount}
          showThresholdSettings={showThresholdSettings}
          setShowThresholdSettings={setShowThresholdSettings}
          elongatingMin={elongatingMin}
          elongatingMax={elongatingMax}
          elongatingMaxEnabled={elongatingMaxEnabled}
          onElongatingMinChange={handleElongatingMinChange}
          onElongatingMaxChange={handleElongatingMaxChange}
          onToggleElongatingMax={toggleElongatingMax}
          hasActiveFilter={hasActiveFilter}
          hasAppliedFilter={hasAppliedFilter}
          perDatasetBars={perDatasetBars}
          targetDatasets={targetDatasets}
          containerWidth={containerWidth}
        />
      )}

      {/* === Distribution tab === */}
      {activeTab === 'distribution' && (
        <DistributionTab
          elongatingGroups={elongatingGroups}
          perClusterPolII={perClusterPolII}
          targetDatasets={targetDatasets}
          filteredSummary={filteredSummary}
          chartWidth={chartWidth}
          isFullView={isFullView}
        />
      )}

      {/* === Co-occurrence tab === */}
      {activeTab === 'cooccurrence' && (
        <CooccurrenceTab
          cooccurrenceByDataset={cooccurrenceByDataset}
          targetDatasets={targetDatasets}
          chartWidth={chartWidth}
          isFullView={isFullView}
        />
      )}

      {/* === Pol II COM tab === */}
      {activeTab === 'pol2com' && (
        <Pol2COMView
          width={chartWidth}
          height={isFullView ? 500 : 300}
          isFullView={isFullView}
        />
      )}
      </AnalysisPanelShell>
    </div>
  );
}
