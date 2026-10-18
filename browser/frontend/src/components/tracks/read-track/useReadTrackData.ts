import { keepsSignal } from '../../../utils/signalFilters';
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { liveLiftViewKey } from '../../../features/liveLift/persistence';
import {
  cancelReadPrefetch,
  compactReadsAllQueryKey,
  compactReadsQueryKey,
  getCompactReads,
  getCompactReadsAll,
  getLinkedCompactReads,
  linkedCompactReadsQueryKey,
} from '../../../api/readOperations';
import { getCoverage, type CoverageLiftOptions, type LiveLiftCoverage } from '../../../api/coverage';
import { getOverlayMarks } from '../../../api/overlays';
import { registerReadSet } from '../../../api/readSets';
import type { CompactRead, ReadsResponse, SvSummary, WorkingSampling } from './types';
import { SV_MIN_LEN_DEFAULT } from './svDrawing';
import { hydrateDerivedReadLayers } from './derivedLayers';
import { DEBUG } from '../../../stores/utils';
import {
  clusterAssignmentForRead,
  readIdKeys,
  filterReadsByBranchScope,
  filterReadsByReadIdSet,
  stripSegmentSuffix,
} from './readFilter';
import type { ReadDisplayMode, ReadSeparatorMode } from '../../../stores/uiSlice';
import { logPerfTiming, nowMs } from '../../../utils/perfDebug';
import { computeReadRowGap } from './layout';
import { getBrowserPerformanceProfile } from '../../../utils/performanceProfile';

/** The lift identity, haplotype and refresh also identify coverage: the same region can now mean other molecules. */
export function coverageRequestKey(datasetId: string, chrom: string, start: number, end: number, bins: number,
  includeDuplicates = false, lift?: CoverageLiftOptions): string {
  return `${datasetId}|${chrom}:${start}-${end}|${bins}${includeDuplicates ? '|dup' : ''}`
    + (lift ? `|${JSON.stringify([lift.liftHap ?? '', lift.liftKey ?? '', lift.refreshGeneration])}` : '');
}

const EMPTY_OVERLAY_MARKS: Record<string, Record<string, number[]>> = {};
import { normalizeAnnotationLayer } from '../../../utils/layerAliases';

const SET_KEY_SEPARATOR = '\u0001';
const DEFAULT_ALL_READS_DISPLAY_CAP = 2_000;
const MAX_QUERY_FILTER_IDS = 5_000;
const MAX_QUERY_FILTER_BYTES = 32_000;

function sortedSetValues(values?: Set<string | number> | null): string[] {
  if (!values || values.size === 0) return [];
  return Array.from(values, value => String(value)).sort();
}

function sortedSetKey(values?: Set<string | number> | null): string {
  return sortedSetValues(values).join(SET_KEY_SEPARATOR);
}

export function requestFilterParamFromSets(...sets: Array<Set<string> | null | undefined>): string {
  const activeSets = sets
    .map(normalizeRequestReadIds)
    .filter((set): set is Set<string> => !!set && set.size > 0);
  if (activeSets.length === 0) return '';

  const [smallest, ...rest] = [...activeSets].sort((a, b) => a.size - b.size);
  if (smallest.size > MAX_QUERY_FILTER_IDS) return '';

  const ids = Array.from(smallest).filter(id => rest.every(set => set.has(id)));
  if (ids.length === 0 || ids.length > MAX_QUERY_FILTER_IDS) return '';
  const param = ids.sort().join(',');
  // URLSearchParams escapes commas, slashes, and other QNAME characters. Cap
  // the encoded query, not just the ID count, to avoid HTTP 414/431 failures.
  if (new URLSearchParams({ filter_ids: param }).toString().length > MAX_QUERY_FILTER_BYTES) return '';
  return param;
}

/**
 * The ids of a filter too large for filter_ids (the same intersection), for a registered read set (filter_set):
 * a split panel's subset of thousands of reads. Null when there is no filter or it fits filter_ids.
 */
export function largeRequestFilterIds(...sets: Array<Set<string> | null | undefined>): string[] | null {
  if (requestFilterParamFromSets(...sets) !== '') return null;
  const activeSets = sets.map(normalizeRequestReadIds).filter((set): set is Set<string> => !!set && set.size > 0);
  if (activeSets.length === 0) return null;
  const [smallest, ...rest] = [...activeSets].sort((a, b) => a.size - b.size);
  const ids = Array.from(smallest).filter(id => rest.every(set => set.has(id)));
  return ids.length ? ids.sort() : null;
}

/** A short key for a list of ids (FNV-1a over the names, with the count). */
export function idsKey(ids: string[]): string {
  let h = 2166136261;
  for (const id of ids) { for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); h = Math.imul(h ^ 10, 16777619); }
  return `${ids.length}:${(h >>> 0).toString(36)}`;
}

/** Whether a read filter fits in a request's filter_ids (else the server sees every read). */
export function readFilterFitsRequest(ids?: Set<string> | null): boolean {
  return requestFilterParamFromSets(ids) !== '';
}

export function normalizeRequestReadIds(
  values?: Set<string> | null,
): Set<string> | null {
  if (!values || values.size === 0) return null;
  return new Set(Array.from(values, value => String(value).replace(/_\d+$/, '')));
}

export function clusterCohortNeedsFullPool(
  cohortIds: Set<string> | null | undefined,
  requestFilterParam: string,
): boolean {
  return !!cohortIds && cohortIds.size > 0 && !requestFilterParam;
}

export function canBatchReadDatasets(
  datasetCount: number,
  needsCigar: boolean,
  requestFilterParam: string,
  clusteredIds: Set<string> | null | undefined,
  preferIndividual = false,
): boolean {
  return datasetCount > 1
    && !preferIndividual
    && !needsCigar
    && !requestFilterParam
    && (!clusteredIds || clusteredIds.size === 0);
}

export function displayCapacity(
  height: number,
  readRowHeight: number | 'auto',
  readSeparatorMode: ReadSeparatorMode,
  readSeparatorMinHeight: number,
  readSeparatorWidth: number,
): number {
  // height is the actual logical space for rows, excluding header/histogram.
  // Never impose a minimum that exceeds the visible viewport at larger UI sizes.
  const trackHeight = Math.max(0, height);
  if (readRowHeight === 'auto') return Math.max(1, Math.floor(trackHeight));
  return Math.max(1, Math.floor(
    trackHeight / (readRowHeight + computeReadRowGap(
      readRowHeight,
      readSeparatorMode,
      readSeparatorMinHeight,
      readSeparatorWidth,
    )),
  ));
}

function stableDisplayHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sampleReadsForFit(reads: CompactRead[], limit: number, seed: string): CompactRead[] {
  if (limit <= 0) return [];
  if (reads.length <= limit) return reads;
  return reads
    .map((read, index) => ({
      read,
      index,
      hash: stableDisplayHash(`${seed}:${read.analysis_id ?? read.id}`),
    }))
    .sort((a, b) => a.hash - b.hash || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map(item => item.read);
}

/**
 * The display sample plus the pinned reads it lacks (a read gone to by name),
 * in the order of `pool` (the sorted reads), so the pinned read sits among its
 * neighbours.
 */
export function keepPinnedReads(sample: CompactRead[], pool: CompactRead[], pinnedKey: string): CompactRead[] {
  if (!pinnedKey || sample.length === pool.length) return sample;
  const pins = new Set(pinnedKey.split(','));
  const kept = new Set(sample);
  return pool.filter(r => kept.has(r) || readIdKeys(r).some(id => pins.has(id) || pins.has(stripSegmentSuffix(id))));
}

export function makeDataViewportKey(
  chrom: string,
  start: number,
  end: number,
  datasetId: string,
  linkedSessionId?: string,
  linkedRegion?: string,
  readStrand?: string | null,
  liftHap?: string | null,
): string {
  // The strand (and a live-lift panel's haplotype) is part of what the loaded reads are (switching it makes them stale).
  return [chrom, start, end, datasetId, linkedSessionId ?? '', linkedRegion ?? '', readStrand ?? ''].join('|')
    + (liftHap ? `|hap:${liftHap}` : '');
}

interface UseReadTrackDataParams {
  stateKey?: string;
  /** DAF-seq panel shown for one strand (CT or GA); the server filters the reads. */
  readStrand?: 'CT' | 'GA' | null;
  /** Live-lift panel shown for one haplotype ('MAT'/'PAT'); the server filters the rows (a rule, not ids). */
  liftHap?: string | null;
  chrom: string;
  start: number;
  end: number;
  datasetId: string;
  spanningOnly: boolean;
  width: number;
  height: number;
  isBAM: boolean;
  needsMethylation: boolean;
  needsLayers: boolean;
  requestedLayers: string[];
  needsLayerQualities: boolean;
  batchNeedsMethylation?: boolean;
  batchRequestedLayers?: string[];
  batchNeedsLayerQualities?: boolean;
  useServerMetaprofile: boolean;
  serverMetaprofileLayers: string[];
  needsCigar: boolean;
  needsMismatches?: boolean;
  fillSmallGaps: boolean;
  fillGapSize: number;
  hideTerminalGaps: boolean;
  terminalGapThreshold: number;
  minFpQuality: number;
  minFootprints: number;
  showDuplicateReads: boolean;
  downsampleCount: number | null;
  readDisplayMode: ReadDisplayMode;
  allReadsDisplayCap: number;
  backgroundReadCap: number | null;
  readRowHeight: number | 'auto';
  readSeparatorMode: ReadSeparatorMode;
  readSeparatorMinHeight: number;
  readSeparatorWidth: number;
  exportMatchedReadCount: number | null;
  exportMatchedReadFetchCount: number | null;
  legacyLayerInference: boolean;
  legacyNucMinSize: number;
  hasPushedReads: boolean;
  jupyterPushedReads: unknown[] | null;
  overrideFilteredIds?: Set<string>;
  linkedSessionId?: string;
  linkedRegion?: 'x' | 'y';
  linkedSortBy?: 'x' | 'y';
  panelLabel?: string;
  hasClusterFocus: boolean;
  myClusterFocus: Set<number> | null;
  hasFilter: boolean;
  myFilteredReadIds: Set<string> | null | undefined;
  // For display reads derivation
  myClusterAssignments: Record<string, number>;
  myClusterOrder: number[];
  myReadSortOrder: string[];
  hasCluster: boolean;
  myJupyterOrder: string[];
  hasJupyterFilter: boolean;
  jupyterFilterSet: Set<string> | null;
  linkedFilteredIds?: Set<string> | null;
  excludeIds?: Set<string>;
  branchReadIds?: Set<string> | null;
  branchReadScopeActive?: boolean;
  rootClusterFocusReadIds?: Set<string> | null;
  clusteredReadIds?: Set<string> | null;
  /** Reads the display sample keeps when in view (a read gone to by name): server and client sampling. */
  pinnedReadIds?: string[];
  /** Smallest SV (bp) in each read's `sv` events and the SV summary (fb-n9-sv). */
  minSvLen?: number;
  /** Ask for the SV summary across the reads in view (the SV display is on). */
  svSummaryEnabled?: boolean;
}

interface CompactAllReadsResponse {
  width: number;
  datasets: Record<string, ReadsResponse>;
  sample_seed?: string;
  server_elapsed_ms?: number;
}

export function useReadTrackData(params: UseReadTrackDataParams) {
  const {
    stateKey, readStrand, liftHap,
    chrom, start, end, datasetId, spanningOnly, width, height, isBAM,
    needsMethylation, needsLayers, requestedLayers, needsLayerQualities, batchNeedsMethylation, batchRequestedLayers, batchNeedsLayerQualities,
    useServerMetaprofile, serverMetaprofileLayers,
    needsCigar, needsMismatches = true, fillSmallGaps, fillGapSize, hideTerminalGaps,
    terminalGapThreshold, minFpQuality, minFootprints, showDuplicateReads, downsampleCount, readDisplayMode, allReadsDisplayCap, backgroundReadCap, readRowHeight,
    readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth,
    exportMatchedReadCount, exportMatchedReadFetchCount,
    legacyLayerInference, legacyNucMinSize,
    hasPushedReads, jupyterPushedReads, overrideFilteredIds,
    linkedSessionId, linkedRegion, linkedSortBy, panelLabel,
    hasClusterFocus, myClusterFocus, hasFilter, myFilteredReadIds,
    myClusterAssignments, myClusterOrder, myReadSortOrder, hasCluster,
    myJupyterOrder, hasJupyterFilter, jupyterFilterSet,
    linkedFilteredIds, excludeIds, branchReadIds, branchReadScopeActive,
    rootClusterFocusReadIds, clusteredReadIds, pinnedReadIds,
    minSvLen = SV_MIN_LEN_DEFAULT, svSummaryEnabled = true,
  } = params;
  const pinnedKey = (pinnedReadIds ?? []).join(',');

  // Watch refreshGeneration so triggerRefresh() (crash recovery, undo/redo) re-fetches reads
  const signalFilters = useBrowserStore(s => s.signalFilters);
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);
  const liftKey = useBrowserStore(s => s.datasets.find(d => d.id === datasetId)?.live_lift?.key);
  const insertionIds = useBrowserStore(s => {
    const panel = s.panels.find(p => p.datasetId === datasetId && (p.stateKey ?? p.datasetId) === (stateKey ?? datasetId));
    return (s.liveLiftExpansions?.[liveLiftViewKey(panel)] ?? [])
      .filter(e => e.datasetId === datasetId && e.chrom === chrom && e.pos >= start && e.pos <= end)
      .flatMap(e => e.alleles?.map(a => a.ins_id) ?? [e.ins_id]).sort().join(',');
  });
  useEffect(() => {
    useBrowserStore.getState().setSignalCounts(stateKey ?? datasetId, null);
    return () => { useBrowserStore.getState().setSignalCounts(stateKey ?? datasetId, null); };
  }, [stateKey, datasetId, chrom, start, end, refreshGeneration]);
  const maxRegionForReads = useBrowserStore(s => s.maxRegionForReads);
  const sampleSeed = useBrowserStore(s => s.analysisSampleSeed);
  // The read-end footprint setting the server has confirmed: part of each read
  // URL, so a request made before the server switched is never reused after.
  const readEndFootprints = useBrowserStore(s => (s.appliedHideShortEndFootprints ? 'hide' : 'show'));
  const batchDatasetIds = useBrowserStore(s => s.datasets.map(d => d.id).filter(Boolean).sort().join(','));
  const batchSourceIdentity = useBrowserStore(s => JSON.stringify(s.datasets
    .filter(d => d.id).map(d => [d.id, d.source_identity ?? d.paths ?? d.path ?? d.id])
    .sort(([a], [b]) => String(a).localeCompare(String(b)))));
  const batchNeedsSvSummary = useBrowserStore(s => s.svDisplayEnabled && s.datasets.some(d => d.data_type === 'bam'));
  // A panel at its own locus (a copy elsewhere) fetches only its dataset: the
  // combined request would load every dataset at that locus for nothing.
  const showsMainView = useBrowserStore(s => s.chrom === chrom && s.start === start && s.end === end);
  // "Load all": every read in view, not the deep view's display sample.
  const loadAllReads = useBrowserStore(s => Boolean(s.loadAllReads?.[datasetId]));

  const [reads, setReads] = useState<CompactRead[]>([]);
  const [totalReads, setTotalReads] = useState(0);
  const [totalOverlappingReads, setTotalOverlappingReads] = useState(0);
  const [totalSpanningReads, setTotalSpanningReads] = useState(0);
  const [workingReads, setWorkingReads] = useState(0);
  /** Reads in view the Min footprints filter hid (only when it hid them all). */
  const [hiddenByMinFootprints, setHiddenByMinFootprints] = useState(0);
  /** A deep view's reads were sampled on the server: how many of how many. */
  const [workingSampling, setWorkingSampling] = useState<WorkingSampling | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMethylationData, setHasMethylationData] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  /** The latest read request failed: the reads held are another view's. */
  const [fetchFailed, setFetchFailed] = useState(false);
  const [dataViewportKey, setDataViewportKey] = useState('');
  const [serverMetaprofile, setServerMetaprofile] = useState<ReadsResponse['metaprofile'] | null>(null);
  /** SV clusters across the reads in view (server-side, before display sampling). */
  const [svSummary, setSvSummary] = useState<SvSummary | null>(null);
  const [fulfilledReadFetchCount, setFulfilledReadFetchCount] = useState(0);

  // Zoomed-out coverage data
  // Zoomed-out coverage, tagged with the request it answers: another region's
  // (still loading here, or failed) is never shown under this one's axis.
  const [coverage, setCoverage] = useState<{ key: string; data: number[]; max: number; reads: number | null;
    live_lift?: LiveLiftCoverage } | null>(null);

  // Track the last completed compact-read request. Store/layout updates can
  // re-run this hook without changing the actual API request; avoid logging and
  // recomputing the same backend working set unless refreshGeneration changes.
  const lastCompletedRequestRef = useRef<{ key: string; refreshGeneration: number } | null>(null);

  // Track fetch generations to ensure data-viewport alignment
  const fetchSequenceRef = useRef(0);
  const currentDataSequenceRef = useRef(0);
  // The same, as state: "this request's data is current" is a render signal too (integ/fb35 smoke: a refetch
  // deduplicated after an await, e.g. registerReadSet for a large split panel, made the data current with no
  // render, and the metaprofile effect that had bailed on the stale sequence never ran again).
  const [dataSequence, setDataSequence] = useState(0);
  const requestedLayersKey = requestedLayers.join(SET_KEY_SEPARATOR);
  const batchRequestedLayersKey = (batchRequestedLayers ?? requestedLayers).join(SET_KEY_SEPARATOR);
  const serverMetaprofileLayersKey = serverMetaprofileLayers.join(SET_KEY_SEPARATOR);
  const overrideFilteredIdsKey = sortedSetKey(overrideFilteredIds);
  const rootClusterFocusReadIdsKey = sortedSetKey(rootClusterFocusReadIds);
  const rootClusterFocusRequestIds = useMemo(
    () => normalizeRequestReadIds(rootClusterFocusReadIds),
    [rootClusterFocusReadIdsKey, rootClusterFocusReadIds],
  );
  const clusteredReadIdsKey = sortedSetKey(clusteredReadIds);
  const clusteredRequestIds = useMemo(
    () => normalizeRequestReadIds(clusteredReadIds),
    [clusteredReadIdsKey, clusteredReadIds],
  );
  const branchReadIdsKey = sortedSetKey(branchReadIds);
  // Raw read IDs: requestFilterParamFromSets strips the segment suffix itself,
  // exactly once (stripping twice turns a_1_2 into a, which the server misses).
  const requestFilterIdsParam = useMemo(() => (
    requestFilterParamFromSets(
      overrideFilteredIds,
      branchReadScopeActive ? branchReadIds ?? new Set<string>() : null,
      hasFilter ? myFilteredReadIds ?? null : null,
      rootClusterFocusReadIds,
      clusteredReadIds,
    )
  ), [overrideFilteredIdsKey, overrideFilteredIds, branchReadIdsKey, branchReadScopeActive, branchReadIds, hasFilter, myFilteredReadIds, rootClusterFocusReadIdsKey, rootClusterFocusReadIds, clusteredReadIdsKey, clusteredReadIds]);
  // A filter too large for filter_ids (a split panel's thousands of reads): a registered read set, filter_set.
  // Only a read filter goes this way (cluster cohorts keep their full-pool path).
  // The same sets as filter_ids (cluster focus and cohort too), so the server samples exactly the reads shown.
  const largeFilterIds = useMemo(() => (requestFilterIdsParam || !hasFilter ? null : largeRequestFilterIds(
    overrideFilteredIds,
    branchReadScopeActive ? branchReadIds ?? new Set<string>() : null,
    myFilteredReadIds ?? null,
    rootClusterFocusReadIds,
    clusteredReadIds,
  )), [requestFilterIdsParam, hasFilter, overrideFilteredIdsKey, overrideFilteredIds, branchReadIdsKey, branchReadScopeActive, branchReadIds, myFilteredReadIds,
    rootClusterFocusReadIdsKey, rootClusterFocusReadIds, clusteredReadIdsKey, clusteredReadIds]);
  const largeFilterKey = useMemo(() => (largeFilterIds ? idsKey(largeFilterIds) : ''), [largeFilterIds]);
  const requestFilterKey = requestFilterIdsParam || (largeFilterKey ? `set:${largeFilterKey}` : '');

  useEffect(() => () => cancelReadPrefetch(datasetId), [datasetId, refreshGeneration]);

  // Fetch active reads from server
  useEffect(() => {
    const controller = new AbortController();
    const cancelled = () => controller.signal.aborted;

    const thisSequence = ++fetchSequenceRef.current;
    if (DEBUG) console.log(`[FETCH ${datasetId}] Effect triggered: seq=${thisSequence}, viewport=${start}-${end}, currentDataSeq=${currentDataSequenceRef.current}`);

    const fetchReads = async () => {
      if (!chrom || end <= start) {
        if (DEBUG) console.log(`[FETCH ${datasetId}] Skipping - invalid viewport`);
        lastCompletedRequestRef.current = null;
        setDataViewportKey('');
        setServerMetaprofile(null);
        setSvSummary(null);
        setFulfilledReadFetchCount(0);
        // A fetch this one superseded (aborted) never clears its loading flag.
        setLoading(false);
        return;
      }

      const requestViewportKey = makeDataViewportKey(chrom, start, end, datasetId, linkedSessionId, linkedRegion, readStrand, liftHap);
      const regionWidth = end - start;
      if (regionWidth > maxRegionForReads && !linkedSessionId) {
        setReads([]);
        setTotalReads(0);
        setTotalOverlappingReads(0);
        setTotalSpanningReads(0);
        setWorkingReads(0);
        setHiddenByMinFootprints(0);
        setDataViewportKey(requestViewportKey);
        setServerMetaprofile(null);
        setSvSummary(null);
        setFulfilledReadFetchCount(0);
        currentDataSequenceRef.current = thisSequence;
        setDataSequence(thisSequence);
        lastCompletedRequestRef.current = null;
        setLoading(false);
        return;
      }

      if (hasPushedReads && jupyterPushedReads) {
        setReads(jupyterPushedReads as CompactRead[]);
        setTotalReads(jupyterPushedReads.length);
        setTotalOverlappingReads(jupyterPushedReads.length);
        setTotalSpanningReads(jupyterPushedReads.length);
        setWorkingReads(jupyterPushedReads.length);
        setHiddenByMinFootprints(0);
        setHasMethylationData(false);
        setDataViewportKey(requestViewportKey);
        setServerMetaprofile(null);
        setSvSummary(null);
        setFulfilledReadFetchCount(Number.MAX_SAFE_INTEGER);
        currentDataSequenceRef.current = thisSequence;
        setDataSequence(thisSequence);
        lastCompletedRequestRef.current = null;
        setLoading(false);
        return;
      }

      setLoading(true);
      setFetchFailed(false);
      if (DEBUG) console.log(`[FETCH ${datasetId}] Starting fetch: seq=${thisSequence}, loading=true`);

      const displayMax = Math.max(1, Math.min(200_000, allReadsDisplayCap || DEFAULT_ALL_READS_DISPLAY_CAP));
      const profileCap = backgroundReadCap == null
        ? 0
        : Math.max(1, Math.min(1_000_000, backgroundReadCap));
      const desiredDisplayCount = exportMatchedReadFetchCount != null
        ? Math.min(exportMatchedReadFetchCount, displayMax)
        : readDisplayMode === 'all'
          ? displayMax
          : Math.min(
            downsampleCount && downsampleCount > 0 ? downsampleCount : Number.POSITIVE_INFINITY,
            displayCapacity(height, readRowHeight, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth),
            displayMax,
          );
      const displayFetchCap = Math.max(1, Math.floor(desiredDisplayCount));
      // A clustered cohort larger than the safe query-string ID cap cannot be
      // represented with filter_ids. Fetch the full current-dataset pool and
      // retain the ordinary focus/branch filters below. Do not hard-filter all
      // cluster assignments here: dynamic clustering intentionally preserves
      // old assignments briefly while a new viewport is being recomputed.
      const fetchFullClusterPool = clusterCohortNeedsFullPool(
        rootClusterFocusRequestIds ?? clusteredRequestIds,
        requestFilterKey,
      );
      const maxReads = fetchFullClusterPool
        ? 0
        : useServerMetaprofile
          ? displayFetchCap
          : profileCap === 0
            ? 0
            : Math.max(profileCap, displayFetchCap);
      const serverProfileMaxReads = backgroundReadCap == null ? 0 : profileCap;
      const fulfilledRequestCount = maxReads <= 0 ? Number.MAX_SAFE_INTEGER : maxReads;

      try {
        let data: ReadsResponse;
        let completedRequestKey: string | null = null;
        let requestKind: 'single' | 'batch' | 'linked' = 'single';
        let requestMs: number | null = null;
        let batchServerMs: number | undefined;

        if (linkedSessionId && linkedRegion) {
          requestKind = 'linked';
          if (DEBUG) console.log(`[${panelLabel}] Fetching LINKED reads: session=${linkedSessionId}, region=${linkedRegion}, sortBy=${linkedSortBy || 'x'}`);

          const fetchParams = new URLSearchParams({
            session_id: linkedSessionId,
            region: linkedRegion,
            max_reads: maxReads.toString(),
            sort_by: linkedSortBy || 'x',
            hide_terminal_gaps: hideTerminalGaps.toString(),
            terminal_gap_threshold: terminalGapThreshold.toString(),
            infer_legacy_layers: legacyLayerInference.toString(),
            legacy_nuc_min_size: legacyNucMinSize.toString(),
            include_duplicates: showDuplicateReads.toString(),
            sample_seed: sampleSeed,
            read_end_footprints: readEndFootprints,
          });
          if (pinnedKey) fetchParams.set('pin_ids', pinnedKey);
          const requestKey = linkedCompactReadsQueryKey(fetchParams);
          const lastCompleted = lastCompletedRequestRef.current;
          if (lastCompleted?.key === requestKey && lastCompleted.refreshGeneration === refreshGeneration) {
            // Session-relative reads stay valid across pans within the session's
            // bounds: mark them current for this viewport, or the track treats
            // them as stale and never redraws.
            setDataViewportKey(requestViewportKey);
            currentDataSequenceRef.current = thisSequence;
            setDataSequence(thisSequence);
            setLoading(false);
            return;
          }

          const requestStarted = nowMs();
          data = await getLinkedCompactReads<ReadsResponse>(fetchParams, { signal: controller.signal });
          requestMs = nowMs() - requestStarted;
          completedRequestKey = requestKey;

          if (!cancelled()) {
            if (DEBUG) console.log(`[${panelLabel}] Received ${data.reads?.length || 0} LINKED reads (paired with other panel)`);
          }
        } else {
          const fetchParams = new URLSearchParams({
            chrom,
            start: start.toString(),
            end: end.toString(),
            viewport_start: start.toString(),
            viewport_end: end.toString(),
            max_reads: maxReads.toString(),
            spanning: spanningOnly.toString(),
            dataset_id: datasetId,
            include_methylation: needsMethylation.toString(),
            include_layers: needsLayers.toString(),
            include_layer_qualities: needsLayerQualities.toString(),
            include_cigar: needsCigar.toString(),
            include_mismatches: needsMismatches.toString(),
            include_duplicates: showDuplicateReads.toString(),
            ml_threshold: '125',
            hide_terminal_gaps: hideTerminalGaps.toString(),
            terminal_gap_threshold: terminalGapThreshold.toString(),
            infer_legacy_layers: legacyLayerInference.toString(),
            legacy_nuc_min_size: legacyNucMinSize.toString(),
            sample_seed: sampleSeed,
            read_end_footprints: readEndFootprints,
            min_sv_len: String(minSvLen),
            include_sv_summary: String(svSummaryEnabled),
          });
          fetchParams.set('refresh_generation', String(refreshGeneration));
          const source = useBrowserStore.getState().datasets.find(d => d.id === datasetId);
          fetchParams.set('source_identity', JSON.stringify(source?.source_identity ?? source?.paths ?? source?.path ?? datasetId));
          if (loadAllReads) fetchParams.set('full_working_set', 'true');
          if (requestedLayersKey) {
            fetchParams.set('layer_names', requestedLayersKey.split(SET_KEY_SEPARATOR).join(','));
          }
          if (useServerMetaprofile) {
            fetchParams.set('include_metaprofile', 'true');
            fetchParams.set('profile_max_reads', serverProfileMaxReads.toString());
            if (serverMetaprofileLayersKey) {
              fetchParams.set('metaprofile_layers', serverMetaprofileLayersKey.split(SET_KEY_SEPARATOR).join(','));
            }
          }

          if (panelLabel) {
            if (DEBUG) console.log(`[${panelLabel}] Fetching reads: ${chrom}:${start}-${end}, spanning=${spanningOnly}, filter=${overrideFilteredIds?.size || 0} IDs`);
          } else {
            if (DEBUG) console.log(`[Regular view] Fetching: ${chrom}:${start}-${end}, spanning=${spanningOnly}`);
          }

          if (isBAM && minFpQuality > 0) {
            fetchParams.set('min_fp_quality', minFpQuality.toString());
          }

          if (minFootprints > 0) {
            fetchParams.set('min_footprints', minFootprints.toString());
          }

          if (fillSmallGaps && fillGapSize > 0) {
            fetchParams.set('fill_gap_size', fillGapSize.toString());
          }

          // NOTE: cluster_focus (cluster numbers) is intentionally NOT sent. The
          // backend resolves it against its single most-recent assignment map,
          // which is wrong once a cluster tree exists. Instead the frontend
          // resolves the visible read IDs from the active node and sends them as
          // filter_ids (see branchReadIds in ReadTrack).
          if (requestFilterIdsParam) {
            fetchParams.set('filter_ids', requestFilterIdsParam);
          } else if (largeFilterIds) {
            fetchParams.set('filter_set', await registerReadSet(largeFilterIds, largeFilterKey));
            if (cancelled()) return;
          }
          // A read gone to by name stays in the server's display sample.
          if (pinnedKey) {
            fetchParams.set('pin_ids', pinnedKey);
          }
          if (readStrand) {
            fetchParams.set('strand', readStrand);
            fetchParams.set('include_methylation', 'true');
          }
          if (liftHap) fetchParams.set('lift_hap', liftHap);
          if (insertionIds) fetchParams.set('insertion_ids', insertionIds);

          // A one-strand panel filters on the server per request, which the
          // combined multi-dataset request doesn't do.
          // compact_all serves SV events at the cache floor only (50 bp).
          const canBatchDatasets = !readStrand && !liftHap && !insertionIds && showsMainView && minSvLen >= SV_MIN_LEN_DEFAULT && canBatchReadDatasets(
            batchDatasetIds.split(',').filter(Boolean).length,
            needsCigar,
            requestFilterKey,
            clusteredRequestIds,
            // Independent dense loads can stream and retain each cohort for navigation.
            getBrowserPerformanceProfile().tier === 'high' && displayFetchCap >= 2000,
          );
          let batchParams: URLSearchParams | null = null;
          if (canBatchDatasets) {
            batchParams = new URLSearchParams(fetchParams);
            batchParams.delete('dataset_id');
            batchParams.set('dataset_ids', batchDatasetIds);
            // Every panel asks for the same group; its identity must match too.
            batchParams.set('source_identity', batchSourceIdentity);
            batchParams.set('include_sv_summary', String(batchNeedsSvSummary));
            batchParams.set('include_methylation', (batchNeedsMethylation ?? needsMethylation).toString());
            batchParams.set('include_layers', (batchRequestedLayersKey.length > 0 || (batchNeedsLayerQualities ?? false)).toString());
            batchParams.set('include_layer_qualities', (batchNeedsLayerQualities ?? needsLayerQualities).toString());
            if (batchRequestedLayersKey) {
              batchParams.set('layer_names', batchRequestedLayersKey.split(SET_KEY_SEPARATOR).join(','));
            } else {
              batchParams.delete('layer_names');
            }
            batchParams.set('include_metaprofile', 'false');
            batchParams.set('coverage_sample', (!spanningOnly).toString());
          }
          const requestKey = batchParams
            ? compactReadsAllQueryKey(batchParams)
            : compactReadsQueryKey(fetchParams);
          const lastCompleted = lastCompletedRequestRef.current;
          if (lastCompleted?.key === requestKey && lastCompleted.refreshGeneration === refreshGeneration) {
            currentDataSequenceRef.current = thisSequence;
            setDataSequence(thisSequence);
            setLoading(false);
            return;
          }

          if (batchParams) {
            requestKind = 'batch';
            const requestStarted = nowMs();
            const batch = await getCompactReadsAll<CompactAllReadsResponse>(batchParams, { signal: controller.signal });
            requestMs = nowMs() - requestStarted;
            batchServerMs = batch.server_elapsed_ms;
            data = batch.datasets?.[datasetId] ?? {
              count: 0,
              total: 0,
              width: end - start,
              reads: [],
              dataset_id: datasetId,
              warning: `No reads returned for dataset ${datasetId}`,
            };
          } else {
            requestKind = 'single';
            const requestStarted = nowMs();
            try {
              data = await getCompactReads<ReadsResponse>(fetchParams, {
                signal: controller.signal,
                onReadProgress: partial => {
                  if (cancelled()) return;
                  const limit = Number(fetchParams.get('max_reads') || 0);
                  setReads(hydrateDerivedReadLayers(limit > 0 ? partial.reads.slice(0, limit) : partial.reads));
                  setDataViewportKey(requestViewportKey);
                  setServerMetaprofile(null);
                  setSvSummary(null);
                },
              });
            } catch (error) {
              // A read set the server no longer holds (a restart, many panels): register it again, once.
              if (!largeFilterIds || cancelled()) throw error;
              fetchParams.set('filter_set', await registerReadSet(largeFilterIds, largeFilterKey, true));
              data = await getCompactReads<ReadsResponse>(fetchParams, { signal: controller.signal });
            }
            requestMs = nowMs() - requestStarted;
          }
          completedRequestKey = requestKey;

          if (!cancelled() && panelLabel) {
            if (DEBUG) console.log(`[${panelLabel}] Received: ${data.reads.length} reads (${data.total} total, ${data.total_spanning} spanning)`);
          }
        }

        if (!cancelled()) {
          if (requestMs !== null) {
            const datasetServerMs = data.server_elapsed_ms;
            const serverMs = requestKind === 'batch'
              ? (batchServerMs ?? datasetServerMs)
              : datasetServerMs;
            const clientOverheadMs = typeof serverMs === 'number'
              ? Math.max(0, requestMs - serverMs)
              : undefined;
            logPerfTiming('read.fetch', requestMs, {
              kind: requestKind,
              datasetId,
              region: `${chrom}:${start}-${end}`,
              reads: data.reads?.length ?? 0,
              display: data.display_count ?? data.count ?? 0,
              working: data.working_count,
              inScope: data.total_in_scope ?? data.total,
              spanning: data.total_spanning,
              serverMs,
              serverTimings: data.server_timings,
              datasetServerMs: requestKind === 'batch' ? datasetServerMs : undefined,
              clientOverheadMs: clientOverheadMs === undefined ? undefined : Math.round(clientOverheadMs * 10) / 10,
              layers: requestedLayers,
              layerQualities: needsLayerQualities,
              methylation: needsMethylation,
              cigar: needsCigar,
              spanningOnly,
            }, 75);
          }
          if (DEBUG) console.log(`[FETCH ${datasetId}] Data arrived: seq=${thisSequence}, reads=${(data.reads || []).length}, fetchSeq=${fetchSequenceRef.current}`);
          const nextReads = hydrateDerivedReadLayers(data.reads || []);
          const nextDisplayCount = data.display_count ?? data.count ?? nextReads.length;
          const nextWorkingCount = data.working_count ?? nextDisplayCount;
          const nextInScopeCount = data.total_in_scope ?? data.total ?? nextWorkingCount;
          const nextOverlappingCount = data.total_overlapping ?? nextInScopeCount;
          setReads(nextReads);
          setTotalReads(nextInScopeCount);
          setTotalOverlappingReads(nextOverlappingCount);
          setTotalSpanningReads(data.total_spanning ?? nextWorkingCount);
          setWorkingReads(nextWorkingCount);
          setHiddenByMinFootprints(typeof data.hidden_by_min_footprints === 'number' ? data.hidden_by_min_footprints : 0);
          setWorkingSampling(data.working_sampling ?? null);
          useBrowserStore.getState().setSignalCounts(stateKey ?? datasetId, data.signal_counts
            ? { datasetId, locus: requestViewportKey, counts: data.signal_counts } : null);
          setHasMethylationData(data.has_methylation || false);
          setDataViewportKey(requestViewportKey);
          setServerMetaprofile(data.metaprofile ?? null);
          setSvSummary(data.sv_summary ?? null);
          // Generic layer auto-detection: any layer name in the response gets
          // an enabledModTypes entry + is stamped onto the dataset so the UI
          // can gate toggles on actual data presence. Supports arbitrary custom
          // annotation types from the fiberseq MA spec.
          // Default-on for primary segmentation layers: nuc + TF. Secondary
          // layers (FIRE/accessibility, deam, methylation, arbitrary custom
          // types) remain opt-in to keep navigation lean and the display calm.
          const layers = data.available_layers;
          if (layers && Array.isArray(layers) && layers.length > 0) {
            const store = useBrowserStore.getState();
            const current = store.enabledModTypes;
            // Auto-enable newly-discovered primary layers only.
            const newlyDiscovered = layers.filter(n => {
              const key = normalizeAnnotationLayer(n) ?? n;
              return !(key in current);
            });
            if (newlyDiscovered.length > 0) {
              newlyDiscovered.forEach(layerName => {
                const key = normalizeAnnotationLayer(layerName) ?? layerName;
                const defaultOn = key === 'nuc' || key === 'tf';
                if (defaultOn || !(key in current)) {
                  store.toggleModType(layerName as any, defaultOn);
                }
              });
            }
            // Always stamp discovered layers onto this dataset so ViewSection
            // can filter toggles by dataset presence. Runs every fetch because
            // different viewports can expose different layers; merges, never replaces.
            store.mergeDatasetAvailableLayers(datasetId, layers);
          }
          if (data.warning) {
            setWarning(data.warning);
            console.warn(`[${datasetId}] Server warning: ${data.warning}`);
          } else {
            setWarning(null);
          }
          if (completedRequestKey) {
            lastCompletedRequestRef.current = { key: completedRequestKey, refreshGeneration };
          }
          setFulfilledReadFetchCount(fulfilledRequestCount);
          currentDataSequenceRef.current = thisSequence;
          setDataSequence(thisSequence);
          if (DEBUG) console.log(`[FETCH ${datasetId}] Data sequence set: currentDataSeq=${thisSequence}`);
        } else {
          if (DEBUG) console.log(`[FETCH ${datasetId}] Data arrived but cancelled: seq=${thisSequence}`);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Failed to fetch reads:', err);
        // The track keeps no reads from the previous view (see ReadTrack): say why it's empty.
        if (!cancelled()) {
          setReads([]);
          setWarning('Could not load reads for this region.');
          setFetchFailed(true);
        }
      } finally {
        if (!cancelled()) {
          setLoading(false);
        }
      }
    };

    fetchReads();
    return () => { controller.abort(); };
  }, [chrom, start, end, datasetId, needsMethylation, needsLayers, requestedLayersKey, needsLayerQualities, batchNeedsMethylation, batchRequestedLayersKey, batchNeedsLayerQualities, useServerMetaprofile, serverMetaprofileLayersKey, needsCigar, needsMismatches, fillSmallGaps, fillGapSize, hideTerminalGaps, terminalGapThreshold, legacyLayerInference, legacyNucMinSize, showDuplicateReads, isBAM, minFpQuality, minFootprints, spanningOnly, readDisplayMode, downsampleCount, allReadsDisplayCap, backgroundReadCap, height, readRowHeight, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth, exportMatchedReadFetchCount, hasPushedReads, jupyterPushedReads, requestFilterIdsParam, requestFilterKey, rootClusterFocusReadIdsKey, clusteredReadIdsKey, linkedSessionId, linkedRegion, linkedSortBy, panelLabel, refreshGeneration, maxRegionForReads, sampleSeed, batchDatasetIds, batchSourceIdentity, batchNeedsSvSummary, readStrand, liftHap, showsMainView, readEndFootprints, pinnedKey, minSvLen, svSummaryEnabled, loadAllReads, insertionIds]);

  // Fetch coverage data when zoomed out past maxRegionForReads
  useEffect(() => {
    const regionWidth = end - start;
    if (regionWidth <= maxRegionForReads || linkedSessionId || !chrom || end <= start) {
      setCoverage(null);
      return;
    }

    const controller = new AbortController();
    const bins = Math.max(100, Math.min(width, 2000));
    const lift = { liftHap, liftKey, refreshGeneration };
    const key = coverageRequestKey(datasetId, chrom, start, end, bins, showDuplicateReads, lift);

    getCoverage(chrom, start, end, bins, datasetId, { signal: controller.signal }, showDuplicateReads, lift)
      .then(result => {
        if (controller.signal.aborted) return;
        setCoverage({ key, data: result.coverage, max: result.max,
          reads: typeof result.reads === 'number' ? result.reads : null, live_lift: result.live_lift });
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Failed to fetch zoomed-out coverage:', err);
        setCoverage(null);
      });

    return () => controller.abort();
  }, [chrom, start, end, datasetId, width, linkedSessionId, maxRegionForReads, showDuplicateReads, liftHap, liftKey, refreshGeneration]);

  // Derive displayReads: apply client-side filters and ordering only
  const { displayReads, profileReads, displaySampleCount } = useMemo(() => {
    const deriveStarted = nowMs();
    const finish = (
      result: { displayReads: CompactRead[]; profileReads: CompactRead[]; displaySampleCount: number },
      reason: string,
    ) => {
      logPerfTiming('read.derive', nowMs() - deriveStarted, {
        datasetId,
        reason,
        inputReads: reads?.length ?? 0,
        displayReads: result.displayReads.length,
        profileReads: result.profileReads.length,
        linked: Boolean(linkedSessionId && linkedRegion),
        hasFilter,
        hasCluster,
        hasClusterFocus,
        jupyterFilter: hasJupyterFilter,
        sorted: myReadSortOrder.length > 0 || myJupyterOrder.length > 0 || hasCluster,
      }, 30);
      return result;
    };

    if (!reads || reads.length === 0) {
      return finish({ displayReads: [], profileReads: [], displaySampleCount: 0 }, 'empty');
    }
    const duplicateFilteredReads = reads.filter(read => (showDuplicateReads || !read.duplicate) && keepsSignal(read.signal, signalFilters));

    const displayMax = Math.max(1, Math.min(200_000, allReadsDisplayCap || DEFAULT_ALL_READS_DISPLAY_CAP));
    const profileLimit = backgroundReadCap == null
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.min(1_000_000, backgroundReadCap));
    const fitLimit = exportMatchedReadCount != null
      ? Math.min(exportMatchedReadCount, displayMax)
      : readDisplayMode === 'all'
        ? Number.POSITIVE_INFINITY
        : Math.min(
          downsampleCount && downsampleCount > 0 ? downsampleCount : Number.POSITIVE_INFINITY,
          displayCapacity(height, readRowHeight, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth),
          displayMax,
        );
    const sampleDisplayReads = exportMatchedReadCount != null || readDisplayMode !== 'all';
    const finalize = (sortedReads: CompactRead[]) => ({
      profileReads: profileLimit === Number.POSITIVE_INFINITY
        ? sortedReads
        : sampleReadsForFit(sortedReads, Math.floor(profileLimit), sampleSeed),
      displayReads: keepPinnedReads(
        sampleDisplayReads
          ? sampleReadsForFit(sortedReads, Math.max(1, Math.floor(fitLimit)), sampleSeed)
          : sortedReads.slice(0, displayMax),
        sortedReads,
        pinnedKey,
      ),
      displaySampleCount: sortedReads.length,
    });

    if (linkedSessionId && linkedRegion) {
      let filteredReads = duplicateFilteredReads;

      // null: no filter. An empty set is a filter that matches nothing (e.g. the
      // two windows share no molecules), not "no filter".
      if (linkedFilteredIds) {
        filteredReads = filterReadsByReadIdSet(duplicateFilteredReads, linkedFilteredIds);
        if (DEBUG) console.log(`[${panelLabel}] Coordinated filter: ${reads.length} -> ${filteredReads.length} reads`);
      }

      return finish(finalize(filteredReads), 'linked');
    }

    try {
      let filteredReads = duplicateFilteredReads;

      if (excludeIds && excludeIds.size > 0) {
        filteredReads = filteredReads.filter(r => {
          return !readIdKeys(r).some(id => excludeIds.has(id) || excludeIds.has(stripSegmentSuffix(id)));
        });
      }

      if (hasJupyterFilter && jupyterFilterSet) {
        filteredReads = filterReadsByReadIdSet(filteredReads, jupyterFilterSet);
      }

      if (hasFilter && myFilteredReadIds) {
        const beforeCount = filteredReads.length;
        filteredReads = myFilteredReadIds.size === 0 ? [] : filterReadsByReadIdSet(filteredReads, myFilteredReadIds);

        if (panelLabel) {
          if (DEBUG) console.log(`[${panelLabel}] Filter: ${beforeCount} reads -> ${filteredReads.length} (filter has ${myFilteredReadIds.size} IDs)`);
          if (filteredReads.length === 0 && beforeCount > 0) {
            const sampleReadIds = reads.slice(0, 3).map(r => r.id);
            const sampleFilterIds = Array.from(myFilteredReadIds).slice(0, 3);
              if (DEBUG) console.log(`  Sample read IDs: ${sampleReadIds.join(', ')}`);
            if (DEBUG) console.log(`  Sample filter IDs: ${sampleFilterIds.join(', ')}`);
          }
        }
      }

      filteredReads = filterReadsByBranchScope(filteredReads, !!branchReadScopeActive, branchReadIds);

      if (hasClusterFocus && myClusterFocus) {
        filteredReads = filteredReads.filter(r => {
          const cluster = clusterAssignmentForRead(myClusterAssignments, r.analysis_id ?? r.id);
          return cluster !== undefined && myClusterFocus.has(cluster);
        });
      }

      let sorted = filteredReads;
      if (myJupyterOrder.length > 0) {
        const orderMap = new Map(myJupyterOrder.map((id, i) => [id, i]));
        sorted = [...filteredReads].sort((a, b) => {
          const posA = orderMap.get(a.id) ?? 999999;
          const posB = orderMap.get(b.id) ?? 999999;
          return posA - posB;
        });
      } else if (myReadSortOrder.length > 0 && hasCluster && myClusterOrder.length > 0) {
        const clusterOrderMap = new Map(myClusterOrder.map((c, i) => [c, i]));
        const readOrderMap = new Map(myReadSortOrder.map((id, i) => [id, i]));
        sorted = [...filteredReads].sort((a, b) => {
          const ca = clusterAssignmentForRead(myClusterAssignments, a.analysis_id ?? a.id) ?? 999;
          const cb = clusterAssignmentForRead(myClusterAssignments, b.analysis_id ?? b.id) ?? 999;
          const clusterDiff = (clusterOrderMap.get(ca) ?? 999) - (clusterOrderMap.get(cb) ?? 999);
          if (clusterDiff !== 0) return clusterDiff;
          return (readOrderMap.get(a.id) ?? 999999) - (readOrderMap.get(b.id) ?? 999999);
        });
      } else if (myReadSortOrder.length > 0) {
        const readOrderMap = new Map(myReadSortOrder.map((id, i) => [id, i]));
        sorted = [...filteredReads].sort((a, b) => {
          return (readOrderMap.get(a.id) ?? 999999) - (readOrderMap.get(b.id) ?? 999999);
        });
      } else if (hasCluster && myClusterOrder.length > 0) {
        const orderMap = new Map(myClusterOrder.map((c, i) => [c, i]));
        sorted = [...filteredReads].sort((a, b) => {
          const ca = clusterAssignmentForRead(myClusterAssignments, a.analysis_id ?? a.id) ?? 999;
          const cb = clusterAssignmentForRead(myClusterAssignments, b.analysis_id ?? b.id) ?? 999;
          const posA = orderMap.get(ca) ?? 999;
          const posB = orderMap.get(cb) ?? 999;
          return posA - posB;
        });
      } else if (hasCluster) {
        sorted = [...filteredReads].sort((a, b) => {
          const ca = clusterAssignmentForRead(myClusterAssignments, a.analysis_id ?? a.id) ?? 999;
          const cb = clusterAssignmentForRead(myClusterAssignments, b.analysis_id ?? b.id) ?? 999;
          return ca - cb;
        });
      }

      return finish(finalize(sorted), 'standard');
    } catch (err) {
      console.error('Error deriving display reads:', err);
      return finish({ displayReads: [], profileReads: [], displaySampleCount: 0 }, 'error');
    }
  }, [reads, signalFilters, showDuplicateReads, datasetId, hasJupyterFilter, jupyterFilterSet, hasFilter, myFilteredReadIds,
      myJupyterOrder, myReadSortOrder, hasCluster, myClusterOrder, myClusterAssignments, hasClusterFocus, myClusterFocus,
      linkedSessionId, linkedRegion, linkedFilteredIds, excludeIds, branchReadIds, branchReadScopeActive, panelLabel,
      readDisplayMode, downsampleCount, allReadsDisplayCap, backgroundReadCap, height, readRowHeight, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth, exportMatchedReadCount, sampleSeed, pinnedKey]);

  // Fetch overlay marks when region or overlays change. They belong to this
  // panel's region (a copy at another locus fetches its own), so they're kept
  // here rather than in the shared store, tagged with the region they're for.
  const modificationOverlays = useBrowserStore(s => s.modificationOverlays);
  const overlayRegionKey = `${chrom}:${start}-${end}`;
  const [panelOverlayMarks, setPanelOverlayMarks] = useState<{ key: string; marks: Record<string, Record<string, number[]>> }>({ key: '', marks: {} });
  useEffect(() => {
    if (modificationOverlays.length === 0) return;
    const controller = new AbortController();
    const key = `${chrom}:${start}-${end}`;

    const fetchAllOverlayMarks = async () => {
      for (const overlay of modificationOverlays) {
        if (controller.signal.aborted) return;
        try {
          const result = await getOverlayMarks(overlay.id, chrom, start, end, { signal: controller.signal });
          if (!controller.signal.aborted && result.marks) {
            setPanelOverlayMarks(prev => ({
              key,
              marks: { ...(prev.key === key ? prev.marks : {}), [overlay.id]: result.marks },
            }));
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          console.error(`Failed to fetch overlay marks for ${overlay.id}:`, err);
        }
      }
    };

    fetchAllOverlayMarks();
    return () => { controller.abort(); };
  }, [chrom, start, end, modificationOverlays]);

  const coverageKey = coverageRequestKey(datasetId, chrom, start, end, Math.max(100, Math.min(width, 2000)), showDuplicateReads,
    { liftHap, liftKey, refreshGeneration });
  const currentCoverage = coverage && coverage.key === coverageKey ? coverage : null;
  const coverageData = currentCoverage?.data ?? null;
  const coverageMax = currentCoverage?.max ?? 0;
  const coverageReads = currentCoverage?.reads ?? null;

  const overlayMarks = panelOverlayMarks.key === overlayRegionKey ? panelOverlayMarks.marks : EMPTY_OVERLAY_MARKS;

  return {
    overlayMarks,
    reads,
    totalReads,
    totalOverlappingReads,
    totalSpanningReads,
    workingReads,
    hiddenByMinFootprints,
    workingSampling,
    loading,
    fetchFailed,
    hasMethylationData,
    warning,
    displayReads,
    profileReads,
    displaySampleCount,
    fetchSequenceRef,
    currentDataSequenceRef,
    dataSequence,
    coverageData,
    coverageMax,
    coverageReads,
    coverageLiveLift: currentCoverage?.live_lift ?? null,
    dataViewportKey,
    serverMetaprofile,
    fulfilledReadFetchCount,
    svSummary,
  };
}
