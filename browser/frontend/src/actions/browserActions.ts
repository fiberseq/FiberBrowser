import { autoCullClusters, clusterAllReads, dissolveCluster, type PeakRegionWithMode } from '../api/clustering';
import { performanceSamplingNote } from '../utils/performanceProfile';
import { clusteringBeforeMerge, recordAppliedMerge, storedMergeSettings } from '../utils/clusterMergeActions';
import { filterReadsByAnalysisRule, sortReads } from '../api/readOperations';
import { fetchApiResponse } from '../api/sharedFetch';
import { downloadSession } from '../api/session';
import { getTrackAnnotations } from '../api/tracks';
import { searchGene } from '../api/reference';
import { getStateKeyMap, getTargetDatasetIds, isLinkedGroup, useBrowserStore } from '../stores/browserStore';
import { seedHistoryBaseline } from '../stores/historySlice';
import { clusterRunLabel } from '../stores/clusterSlice';
import { chartRoundStillCurrent, clusterMergeInputs, type ClusterMergeInputs } from '../components/controls/cluster-detail/clusterChartScope';
import type { ClusterOperationRound } from '../components/controls/cluster-detail/clusterOperationRounds';
import type { PanelView } from '../utils/panelScope';
import { addJasparMotifsByName } from '../utils/motifLoader';
import { analyzeFootprints } from '../api/footprints';
import { applyMembershipClusters, computeMembershipClusters, cooccGroupParams } from '../utils/footprintMembership';
import { clusterSelectionLocus, findClusterSelection, footprintInView, resolveClusterSelection } from '../utils/footprintClusterSelection';
import type {
  AnalysisFilterRule,
  AnalysisSortRule,
  CaptureRegion,
  ClusterFeatureRule,
  ClusterFeatureRuleTerm,
  ClusterMetricCohort,
  ColorRule,
  FirePeak,
  Gene,
  OverlapCondition,
  PanelConfig,
  PrimerPair,
  TranscriptionStateRuleKind,
} from '../types';
import { analysisFilterLabel, analysisRuleTermProblem, filterRuleRequestFields, intersectWithCurrentFilter, normalizeAnalysisRuleScope, normalizeTranscriptionStateRuleKind, resolveClusterRuleRegions, sortRuleRequestFields } from '../utils/analysisRules';
import { highlightForAction, COPILOT_ANCHORS, type HighlightOptions } from '../utils/copilotAnchors';
import { isStrandedDafDataset } from '../utils/datasetChemistry';
import { findTopLocus, isTopLocusStep } from '../utils/topLoci';
import { runUiCluster, runUiScan } from '../utils/clusterRunner';
import { invalidateFilterRequests, isCurrentFilterRequest, nextFilterRequest } from '../utils/filterRequests';
import { isCurrentSortRequest, nextSortRequest } from '../utils/sortRequests';
import { liftHapsForRound, resolveSortRequestScope, sortRounds } from '../utils/sortScope';
import { registerBackendMotifTrack, registerTrack, removeTrackAtIndex, setTrackNameFilter } from '../utils/trackLoader';
import { CLUSTER_RULE_MODE_PREFIX } from '../types';
import { sameChrom } from '../utils/chromAliases';
import { ruleTermPayload } from './ruleTermPayload';
import { openSidebarSection } from '../utils/tutorialAnchors';
import { conditionById, conditionHolds } from '../utils/tutorialMilestones';

export interface BrowserAction {
  type: string;
  [key: string]: unknown;
}

function valueAsString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function valueAsNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function valueAsBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// Keep in parity with COPILOT_API_UNSAFE_PATTERNS in
// browser/services/natural_language_commands.py. This is the client-side
// defense-in-depth guard (the backend builds the safe catalog), so any route
// blocked there MUST be blocked here too.
const COPILOT_API_BLOCKED = [
  /^\/api\/nl\//,            // block the whole NL surface (stream/setup/agent_step), not just /plan
  /^\/api\/shutdown$/,
  /^\/api\/quit$/,
  /^\/api\/cancel_shutdown$/,
  /^\/api\/new-window$/,
  /^\/api\/pick_/,
  /^\/api\/pick-file$/,      // hyphen variant — `pick_` alone doesn't match it
  /^\/api\/load_/,
  /^\/api\/diagnose_bam$/,
  /^\/api\/datasets\/add$/,
  /^\/api\/datasets\/add_url$/,
  /^\/api\/datasets\/upload$/,
  /^\/api\/datasets\/drop_window$/,
  /^\/api\/files\/upload$/,
  /^\/api\/s3\//,
  /^\/api\/add_track$/,
  /^\/api\/tracks\/add_motif_file$/,
  /^\/api\/bigbed\/names$/,
  /^\/api\/annotations\/add$/,
  /^\/api\/annotations\/browse$/,
  /^\/api\/overlays\/add$/,
  /^\/api\/primer_blast_db\/build$/,
  /^\/api\/footprint\/derived_layers\/(load|export)$/,
  /^\/api\/footprint\/rules\/(load|save)$/,
  /^\/api\/motifs\/load/,
  // Routes that take server file paths or change the loaded reference.
  // (primer_config's fasta_path/blast_db_path are caught by the key rules.)
  /^\/api\/dafc\/load$/,
  /^\/api\/files\//,
  /^\/api\/gtf$/,
  /^\/api\/jupyter\/motifs\/load_file$/,
  /^\/api\/session\/(read|check_files|import)$/,
  /^\/api\/datasets\/add_grouped$/,
  // New DAF-seq run: starts host processes on host files (routers/pipeline.py).
  /^\/api\/pipeline\//,
  /^\/api\/qc\//,
];

// Method-specific blocks (the other methods only read). Parity: COPILOT_API_UNSAFE_METHOD_ROUTES.
const COPILOT_API_BLOCKED_METHOD_ROUTES = new Set([
  'POST /api/reference_pairs',  // takes FASTA/annotation paths, replaces the reference
]);

const COPILOT_BLOCKED_BODY_KEYS = new Set([
  'path', 'paths', 'file', 'files', 'file_path', 'filepath', 'folder', 'dir', 'directory',
  'output', 'output_dir', 'output_folder', 'bam_path', 'fasta_path', 'gtf_path',
  'bundle_path', 'url', 'urls', 's3_url', 'bucket', 'prefix', 'profile', 'endpoint_url',
  'fasta', 'annotation', 'gtf', 'bam', 'bigbed', 'cool',
]);

// Keys ending like this name files, folders or remote locations (cool_file,
// blast_db_path, ...), whatever the route. Parity: COPILOT_API_BLOCKED_KEY_SUFFIXES.
const COPILOT_BLOCKED_KEY_SUFFIXES = ['_path', '_paths', '_file', '_files', '_dir', '_folder', '_url', '_urls'];

function isBlockedKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, '_');
  return COPILOT_BLOCKED_BODY_KEYS.has(normalized) || COPILOT_BLOCKED_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

/**
 * The /api path an action targets, or null when fetch or the server could
 * rewrite it (dot segments, percent-encoding, backslashes, empty segments,
 * fragments): the blocklist must see the route that actually runs.
 * Parity: canonical_copilot_api_path.
 */
/** A fit without a reassignment model (no patterns or centroids used) still brings its molecule metric cohort,
 * which merges and the map rank against: it replaces an earlier fit's (none: {}) in the store and on the active
 * cluster-tree node, as setClusterPatterns does with a model. */
export function adoptFitMetricCohort(cohort?: ClusterMetricCohort): void {
  const next = { ...(cohort ?? {}) };
  useBrowserStore.setState(state => {
    const id = state.activeClusterTreeNodeId;
    const node = id ? state.clusterTreeNodes[id] : undefined;
    return {
      clusterMetricCohort: next,
      ...(id && node ? { clusterTreeNodes: { ...state.clusterTreeNodes, [id]: { ...node, metricCohort: next } } } : {}),
    };
  });
}

export function canonicalApiPath(path: string): string | null {
  const raw = path.split('?', 1)[0];
  if (path.includes('#') || !raw.startsWith('/api/')) return null;
  for (const segment of raw.split('/').slice(1)) {
    if (segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_.:~{}-]+$/.test(segment)) return null;
  }
  return raw;
}

function findBlockedBodyKey(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const hit = findBlockedBodyKey(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isBlockedKey(key)) return key;
    const hit = findBlockedBodyKey(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function findBlockedQueryKey(path: string): string | null {
  try {
    const query = path.split('?', 2)[1] ?? '';
    const params = new URLSearchParams(query);
    for (const key of params.keys()) {
      if (isBlockedKey(key)) return key;
    }
  } catch {
    return null;
  }
  return null;
}

export function browserApiAllowed(method: string, path: string, body?: unknown): { allowed: boolean; reason?: string } {
  const methodNorm = method.toUpperCase();
  if (!['GET', 'POST', 'DELETE'].includes(methodNorm)) {
    return { allowed: false, reason: `Method ${methodNorm} is not allowed from browser actions.` };
  }
  const pathOnly = canonicalApiPath(path);
  if (pathOnly === null) {
    return { allowed: false, reason: "Browser actions must use a plain same-origin /api path (no '.' or '..' segments, encoded characters or fragments)." };
  }
  if (COPILOT_API_BLOCKED_METHOD_ROUTES.has(`${methodNorm} ${pathOnly}`) || COPILOT_API_BLOCKED.some(pattern => pattern.test(pathOnly))) {
    return { allowed: false, reason: 'This route is blocked because it can access local files, spawn processes, reconfigure credentials, or control server lifecycle.' };
  }
  const queryKey = findBlockedQueryKey(path);
  if (queryKey) {
    return { allowed: false, reason: `Query parameter "${queryKey}" can reference files or credentials.` };
  }
  const bodyKey = findBlockedBodyKey(body);
  if (bodyKey) {
    return { allowed: false, reason: `Body field "${bodyKey}" can reference files or credentials.` };
  }
  return { allowed: true };
}

function makeGene(value: unknown): Gene | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const chrom = valueAsString(raw.chrom);
  const start = valueAsNumber(raw.start, NaN);
  const end = valueAsNumber(raw.end, NaN);
  if (!chrom || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    id: valueAsString(raw.id, valueAsString(raw.name, 'gene')),
    name: typeof raw.name === 'string' ? raw.name : null,
    chrom,
    start,
    end,
    strand: valueAsString(raw.strand, '+'),
    biotype: 'gene',
    exons: [],
  };
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function truncateText(text: string, max = 1200): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [truncated ${text.length - max} chars]`;
}

function isRemoteTrackUrl(path: string): boolean {
  try {
    const parsed = new URL(path);
    return ['http:', 'https:', 's3:', 'ucsc:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 100,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolve => window.setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function findNearestPeak(chrom: string, position: number, tolerance: number): { peak: FirePeak; distance: number } | null {
  const peaks = useBrowserStore.getState().getAllPeaks()
    .filter(p => !p.chrom || sameChrom(p.chrom, chrom))
    .map(p => ({
      peak: p,
      distance: p.start <= position && p.end >= position
        ? 0
        : Math.min(Math.abs(p.start - position), Math.abs(p.end - position)),
    }))
    .sort((a, b) => a.distance - b.distance);
  const nearest = peaks[0];
  if (!nearest || nearest.distance > tolerance) return null;
  return nearest;
}

/**
 * A Copilot api_call to /api/cluster_all or /api/cluster, run as the browser's
 * own clustering so the result is applied and shown: the query's region (if
 * any) is visited, the body's method and k are set, then the body's peak
 * regions, else the selected peaks, else every peak in view are clustered.
 */
/** Backend sort/filter routes whose results the browser applies to its panels. */
const READ_RESULT_PATHS = new Set([
  '/api/sort_reads', '/api/filter', '/api/filter_by_analysis_rule', '/api/filter_by_transcription_state',
]);

/**
 * Run a sort/filter api_call and apply its results to the target panels showing
 * the view, with the same guards as the typed rule actions: a newer sort/filter
 * (or a Clear), a moved view or a branch change drops the result.
 */
async function readResultsViaApiCall(path: string, apiPath: string, body: unknown): Promise<string> {
  const query = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {};
  // The routes take the region in the query; one given in the body goes there.
  for (const key of ['chrom', 'start', 'end', 'spanning']) {
    if (!query.has(key) && b[key] !== undefined && b[key] !== null) query.set(key, String(b[key]));
    delete b[key];
  }
  const store = useBrowserStore.getState();
  const targetChrom = query.get('chrom');
  const targetStart = Number(query.get('start'));
  const targetEnd = Number(query.get('end'));
  if (targetChrom && Number.isFinite(targetStart) && Number.isFinite(targetEnd) && targetEnd > targetStart
    && (targetChrom !== store.chrom || targetStart !== store.start || targetEnd !== store.end)) {
    store.pushViewportHistory({ chrom: store.chrom, start: store.start, end: store.end });
    store.setViewport(targetChrom, targetStart, targetEnd);
  }
  const now = useBrowserStore.getState();
  query.set('chrom', now.chrom);
  query.set('start', String(now.start));
  query.set('end', String(now.end));
  const kind: 'sort' | 'filter' = apiPath === '/api/sort_reads' ? 'sort' : 'filter';
  const seq = kind === 'sort' ? nextSortRequest() : nextFilterRequest();
  const view = { chrom: now.chrom, start: now.start, end: now.end };
  const branch = now.activeClusterTreeNodeId ?? null;
  const response = await fetchApiResponse(`${apiPath}?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  if (!response.ok) throw new Error(`POST ${apiPath} failed: ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  const stale = staleRuleResult(kind, seq, view);
  if (stale) return `POST ${apiPath}: ${stale}`;
  const after = useBrowserStore.getState();
  if ((after.activeClusterTreeNodeId ?? null) !== branch) {
    return `POST ${apiPath}: the cluster branch changed before the results arrived; not applied.`;
  }
  // Per-dataset results; /api/filter answers for one dataset (the named one, else the first).
  let results: Record<string, Record<string, unknown>> = {};
  if (payload.results && typeof payload.results === 'object') {
    results = payload.results as Record<string, Record<string, unknown>>;
  } else if (Array.isArray(payload.read_ids)) {
    const dsId = query.get('dataset_id') || valueAsString(b.dataset_id) || after.datasets[0]?.id;
    if (dsId) results = { [dsId]: payload };
  }
  const keyMap = mainViewKeyMap(getStateKeyMap(after.selectedDatasets, after.panels, after.datasets), after);
  const bodyAssignments = b.cluster_assignments && typeof b.cluster_assignments === 'object'
    ? b.cluster_assignments as Record<string, unknown> : {};
  let applied = 0;
  seedHistoryBaseline(after, kind === 'sort' ? 'Before sorting' : 'Before read filter', kind === 'sort' ? 'sorting' : 'filtering');
  for (const [dsId, result] of Object.entries(results)) {
    if (!result || typeof result !== 'object') continue;
    for (const sk of keyMap[dsId] ?? []) {
      if (kind === 'sort') {
        const readOrder = Array.isArray(result.read_sort_order) ? result.read_sort_order.map(String) : null;
        const clusterOrder = Array.isArray(result.cluster_order) ? result.cluster_order.map(Number) : [];
        // The cluster order is in the clustering the server sorted: the call's
        // own, else the dataset's stored one, which a copy clustered on its own doesn't share.
        if (clusterOrder.length > 0 && (bodyAssignments[dsId] || sk === dsId)) after.setClusterOrder(sk, clusterOrder);
        if (readOrder) after.setReadSortOrder(sk, readOrder);
      } else {
        const ids = Array.isArray(result.read_ids) ? result.read_ids
          : Array.isArray(result.filtered_ids) ? result.filtered_ids : null;
        if (!ids) continue;
        after.setFilteredReadIds(sk, new Set(ids.map(String)), {
          target: apiPath === '/api/filter_by_transcription_state' ? 'transcription-filters' : 'analysis-filter',
          label: `Copilot > ${apiPath.replace('/api/', '')}`,
        });
      }
      applied += 1;
    }
  }
  if (applied === 0) return `POST ${apiPath}: no panel showing the view matched the results; nothing changed.`;
  useBrowserStore.getState().pushSnapshot(kind === 'sort' ? 'Copilot sort' : 'Copilot filter');
  return `${kind === 'sort' ? 'Sorted' : 'Filtered'} ${applied} panel${applied === 1 ? '' : 's'} (POST ${apiPath}).`;
}

async function clusterViaApiCall(path: string, body: unknown): Promise<string> {
  const query = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const at = (key: string) => b[key] ?? query.get(key) ?? undefined;
  // Query-string values are strings: '6861000' is a number here.
  const num = (value: unknown) => (typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  const targetChrom = valueAsString(at('chrom'));
  const targetStart = num(at('start'));
  const targetEnd = num(at('end'));
  // The datasets the call names (dataset_ids list, comma list, or dataset_id).
  const rawIds = at('dataset_ids') ?? at('dataset_id');
  const datasetIds = (Array.isArray(rawIds) ? rawIds : typeof rawIds === 'string' ? rawIds.split(',') : [])
    .map(id => String(id).trim()).filter(Boolean);
  const store = useBrowserStore.getState();
  if (targetChrom && Number.isFinite(targetStart) && Number.isFinite(targetEnd) && targetEnd > targetStart
    && (targetChrom !== store.chrom || targetStart !== store.start || targetEnd !== store.end)) {
    store.pushViewportHistory({ chrom: store.chrom, start: store.start, end: store.end });
    store.setViewport(targetChrom, targetStart, targetEnd);
  }
  const settings = useBrowserStore.getState() as unknown as {
    setClusterMethod?: (m: string) => void; setClusterK?: (k: number) => void;
  };
  const method = valueAsString(at('method'));
  if (method) settings.setClusterMethod?.(method);
  const k = num(at('k'));
  if (Number.isFinite(k) && k > 0) settings.setClusterK?.(Math.round(k));

  const given = Array.isArray(b.peak_regions) ? b.peak_regions : null;
  if (given && given.length > 0) {
    const regions: PeakRegionWithMode[] = [];
    for (const r of given) {
      const start = Array.isArray(r) ? Number(r[0]) : Number((r as Record<string, unknown>)?.start);
      const end = Array.isArray(r) ? Number(r[1]) : Number((r as Record<string, unknown>)?.end);
      const mode = Array.isArray(r) ? undefined : (r as Record<string, unknown>)?.mode;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        regions.push({ start, end, ...(typeof mode === 'string' ? { mode: mode as PeakRegionWithMode['mode'] } : {}) });
      }
    }
    // Rule-mode regions (cluster_rule:<id>) need their rule definitions: the
    // call's own, else the browser's saved rules of that id.
    const bodyRules = Array.isArray(b.cluster_feature_rules) ? b.cluster_feature_rules as ClusterFeatureRule[] : [];
    return clusterPeakRegions(regions, 'requested peak region(s)', { datasetIds, clusterFeatureRules: bodyRules });
  }
  const st = useBrowserStore.getState();
  if (st.selectedPeaks.size > 0) {
    // The Cluster button runs on the selected panels: for named datasets,
    // select just their panels for this run, then give the selection back.
    const viaButton = await withDatasetSelection(datasetIds, () => clusterSelectedLikeButton('selected peak(s)'));
    if (viaButton) return viaButton;
  }
  const peaksInView = () => {
    const now = useBrowserStore.getState();
    return now.getAllPeaks()
      .filter(p => (!p.chrom || sameChrom(p.chrom, now.chrom)) && p.end > now.start && p.start < now.end)
      .map(peakRegionFromPeak);
  };
  let inView = peaksInView();
  if (inView.length === 0) {
    // A region just visited has no peaks scanned yet: scan as the Scan button does.
    st.setPeaksLocked(false);
    if (await runUiScan()) inView = peaksInView();
  }
  return clusterPeakRegions(inView, 'peak(s) in view', { datasetIds });
}

/**
 * Run with the panels of the named datasets selected (all selected panels when
 * none are named). Named datasets with no panel: null, never the user's own
 * selection (the caller falls back to clustering by dataset).
 */
async function withDatasetSelection<T>(datasetIds: string[], run: () => Promise<T>): Promise<T | null> {
  if (datasetIds.length === 0) return run();
  const st = useBrowserStore.getState();
  const before = st.selectedDatasets;
  const keys = datasetKeyMap(datasetIds, st);
  const targets = new Set(st.panels
    .filter(p => p.contentType === 'dataset' && p.datasetId && (keys[p.datasetId] ?? []).includes(p.stateKey ?? p.datasetId))
    .map(p => p.id));
  if (targets.size === 0) return null;
  useBrowserStore.setState({ selectedDatasets: targets });
  try {
    return await run();
  } finally {
    if (useBrowserStore.getState().selectedDatasets === targets) useBrowserStore.setState({ selectedDatasets: before });
  }
}

function peakRegionFromPeak(peak: FirePeak): PeakRegionWithMode {
  const state = useBrowserStore.getState();
  return {
    start: peak.start,
    end: peak.end,
    mode: state.peakModes[peak.index] || 'accessibility',
  };
}

function allPeakWindows(): number[][] {
  return useBrowserStore.getState().getAllPeaks().map(peak => [peak.start, peak.end]);
}

/**
 * What a Copilot dissolve / merge sends (fb-n6-integ): the same as the
 * Clusters panel's buttons (clusterMergeInputs): the clustered panels of these
 * datasets showing the charts' view (the others are counted as left out), that
 * view's locus, reference and peaks, one panel per dataset per request.
 */
function copilotMergeInputs(datasetIds: string[]): ClusterMergeInputs {
  const state = useBrowserStore.getState();
  const keyMap = getStateKeyMap(state.selectedDatasets, state.panels, state.datasets);
  const keys: string[] = [];
  const stateKeyToDs: Record<string, string> = {};
  for (const dsId of datasetIds) {
    for (const sk of keyMap[dsId] ?? [dsId]) {
      if (keys.includes(sk) || Object.keys(state.clusterAssignments[sk] ?? {}).length === 0) continue;
      keys.push(sk);
      stateKeyToDs[sk] = dsId;
    }
  }
  return clusterMergeInputs(state, keys, stateKeyToDs);
}

/**
 * A dissolve/merge round's answer still applies only if nothing it was
 * computed from changed while it ran: each panel still shows the view and has
 * the assignments sent (chartRoundStillCurrent), and the same cluster branch.
 */
function copilotRoundStillCurrent(round: ClusterOperationRound, view: PanelView, branch: string | null): boolean {
  const now = useBrowserStore.getState();
  if ((now.activeClusterTreeNodeId ?? null) !== branch) return false;
  return chartRoundStillCurrent(round, view, now);
}

function resolveAnalysisRuleWindows(rule: Pick<AnalysisSortRule | AnalysisFilterRule, 'scope'>): number[][] {
  const state = useBrowserStore.getState();
  return resolveClusterRuleRegions(rule, {
    allPeaks: state.getAllPeaks(),
    selectedPeaks: state.selectedPeaks,
    peakModes: state.peakModes,
    mode: 'accessibility',
    chrom: state.chrom,
    viewportStart: state.start,
    viewportEnd: state.end,
    selectedGenes: state.selectedGenes,
  }).map(region => [region.start, region.end]);
}

function layerFromAnalysisTerm(term: ClusterFeatureRuleTerm | undefined): string | null | undefined {
  if (!term) return undefined;
  if (term.source === 'label_rule') {
    const targets = term.rule?.targetLayers ?? [];
    return targets.length === 1 ? targets[0] || null : undefined;
  }
  if (term.source === 'footprint_group') return term.group?.layer ?? null;
  return term.layer ?? null;
}

/** Size, conditions, quality gates and a labeling rule's nucleosome conditions (actions/ruleTermPayload.ts). */
function rulePayloadFromAnalysisTerm(term: ClusterFeatureRuleTerm | undefined) {
  return ruleTermPayload(term);
}

function transcriptionStateFromAnalysisTerm(term: ClusterFeatureRuleTerm | undefined): TranscriptionStateRuleKind | null {
  if (term?.source !== 'transcription_state') return null;
  return normalizeTranscriptionStateRuleKind(term.transcriptionState);
}

function geneIdsForAnalysisRule(rule: Pick<AnalysisSortRule | AnalysisFilterRule, 'scope'>): string[] {
  const state = useBrowserStore.getState();
  const scope = normalizeAnalysisRuleScope(rule.scope);
  if (scope.kind === 'gene') {
    if (scope.geneId) {
      const match = state.selectedGenes.find(gene => gene.id === scope.geneId);
      if (match) return [match.id];
    }
    if (scope.geneName) {
      const match = state.selectedGenes.find(gene => (gene.name || '').toLowerCase() === scope.geneName!.toLowerCase());
      if (match) return [match.id];
    }
    if (state.selectedGenes[0]?.id) return [state.selectedGenes[0].id];
    return scope.geneId ? [scope.geneId] : [];
  }
  return state.selectedGenes.map(gene => gene.id).filter(Boolean);
}

/**
 * Why a rule sort/filter result no longer applies (a newer request, a Clear, or
 * the view moved), or null. Sorts share their generation with the Sort button
 * (utils/sortRequests); filters with the Rules panel's filter and Clear
 * (utils/filterRequests).
 */
function staleRuleResult(kind: 'sort' | 'filter', seq: number, at: { chrom: string; start: number; end: number }): string | null {
  const current = kind === 'sort' ? isCurrentSortRequest(seq) : isCurrentFilterRequest(seq);
  if (!current) return 'superseded by a newer request or a Clear; not applied.';
  const now = useBrowserStore.getState();
  if (now.chrom !== at.chrom || now.start !== at.start || now.end !== at.end) {
    return 'the view moved before the results arrived; not applied.';
  }
  return null;
}

/**
 * Sort requests, one per round: round i takes each dataset's i-th panel state
 * key, so every panel is sorted with its own clusters and read scope.
 */
/** Backend routes that create motif tracks (the Tracks panel registers what they return). */
const MOTIF_CREATION_PATHS = new Set([
  '/api/tracks/add_motif_sequence', '/api/tracks/add_motif_pwm',
  '/api/tracks/add_motif_jaspar', '/api/tracks/add_motif_file',
]);

/** Register the motif track(s) a motif-creation response describes; returns how many. */
function registerApiMotifTracks(payload: unknown, body: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const res = payload as Record<string, unknown>;
  if (res.success === false) return 0;
  const requested = body && typeof body === 'object' ? (body as Record<string, unknown>).threshold : undefined;
  const threshold = typeof requested === 'number' ? requested : useBrowserStore.getState().motifThreshold;
  const tracks = Array.isArray(res.tracks) ? res.tracks as Array<Record<string, unknown>> : [res];
  let registered = 0;
  for (const track of tracks) {
    const trackIndex = typeof track.track_index === 'number' ? track.track_index : null;
    const trackPath = typeof track.path === 'string' ? track.path : '';
    if (trackIndex == null || !trackPath) continue;
    const result = registerBackendMotifTrack({
      track_index: trackIndex,
      path: trackPath,
      label: typeof track.label === 'string' ? track.label : trackPath,
      motif_name: typeof track.motif_name === 'string' ? track.motif_name : undefined,
      threshold: typeof track.threshold === 'number' ? track.threshold : threshold,
    });
    if (result.success) registered += 1;
  }
  if (registered > 0) useBrowserStore.getState().triggerRefresh();
  return registered;
}

/**
 * Motif tracks loaded on the backend: the displayed list, plus catalog motifs
 * registered but not yet in it (the track list refreshes a moment later).
 */
function loadedMotifTracks(): Array<{ index: number; label: string }> {
  const st = useBrowserStore.getState();
  const tracks = st.orthogonalTracks.filter(t => t.category === 'motif').map(t => ({ index: t.index, label: t.label }));
  const known = new Set(tracks.map(t => t.index));
  for (const entry of st.catalog) {
    if (entry.kind !== 'motif' || entry.loaded === false || typeof entry.trackIndex !== 'number') continue;
    if (known.has(entry.trackIndex)) continue;
    known.add(entry.trackIndex);
    tracks.push({ index: entry.trackIndex, label: entry.label });
  }
  return tracks;
}

/**
 * State keys of the target panels that show the main view (not a copy at
 * another locus). A key no panel holds any more drops out, except the dataset's
 * own key for a dataset without panels.
 */
function mainViewKeyMap(
  keyMap: Record<string, string[]>,
  st: { panels: PanelConfig[]; chrom: string; start: number; end: number },
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [dsId, keys] of Object.entries(keyMap)) {
    out[dsId] = keys.filter(key => {
      const holders = st.panels.filter(p => p.contentType === 'dataset' && p.datasetId === dsId && (p.stateKey ?? p.datasetId) === key);
      if (holders.length === 0) return key === dsId;
      return holders.every(p => {
        const v = p.viewportOverride;
        return !v || (v.chrom === st.chrom && v.start === st.start && v.end === st.end);
      });
    });
  }
  return out;
}

/**
 * The panel state keys a per-panel cluster action (focus, hide, select) acts
 * on: the selected panels (only the named dataset's, when `dataset_id` is
 * given), else the named or first dataset's own panel. Copies clustered on
 * their own keep separate cluster ids, so each is addressed by its key.
 */
function actionStateKeys(action: BrowserAction): string[] {
  const st = useBrowserStore.getState();
  const requested = valueAsString(action.dataset_id);
  const selected = st.panels.filter(p => p.contentType === 'dataset' && p.datasetId
    && st.selectedDatasets.has(p.id) && (!requested || p.datasetId === requested));
  const keys = [...new Set(selected.map(p => p.stateKey ?? p.datasetId!))];
  if (keys.length > 0) return keys;
  const fallback = requested || st.datasets[0]?.id;
  return fallback ? [fallback] : [];
}

/** The copy Copilot opened last: what a follow-up "unlink it" refers to. */
let lastCopilotCopyId: string | null = null;
/** The panel selection when it was opened: once the user selects something else, that wins. */
let lastCopilotCopySelection: Set<string> | null = null;

/** Cluster on the selected peaks the way the Cluster button does (panel-aware: copies at other loci, strand panels). */
async function clusterSelectedLikeButton(label: string): Promise<string | null> {
  const mode = useBrowserStore.getState().clusterPeakMode;
  // A cluster rule in the Cluster group would make the button use its regions
  // instead: for this run, the selected peaks themselves (each with its own
  // mode), then the rule comes back.
  const ruleMode = typeof mode === 'string' && mode.startsWith(CLUSTER_RULE_MODE_PREFIX) ? mode : null;
  const plain = 'accessibility' as typeof mode;
  const before = useBrowserStore.getState().clusterAssignments;
  if (ruleMode) useBrowserStore.setState({ clusterPeakMode: plain });
  let ran: boolean;
  try {
    ran = await runUiCluster();
  } finally {
    if (ruleMode && useBrowserStore.getState().clusterPeakMode === plain) {
      useBrowserStore.setState({ clusterPeakMode: ruleMode });
    }
  }
  if (!ran) return null;
  const s = useBrowserStore.getState();
  // Only panels this run clustered (their assignment maps were replaced).
  const changed = Object.entries(s.clusterAssignments).filter(([key, a]) => a && a !== before[key]);
  if (changed.length === 0) {
    return `Clustering on the ${label} did not run${s.error ? `: ${s.error}` : ' (no peaks or no reads to cluster)'}.`;
  }
  const assigned = changed.reduce((n, [, a]) => n + Object.values(a).filter(c => c >= 0).length, 0);
  const clusters = new Set(changed.flatMap(([, a]) => Object.values(a).filter(c => c >= 0))).size;
  if (assigned === 0) return `Clustering on the ${label} assigned no reads to clusters (no reads cover the peaks?).`;
  return `Clustered ${assigned.toLocaleString()} reads into ${clusters} clusters on the ${label}.`;
}

/** Generation of Copilot peak-region clusterings: a newer one supersedes a pending one. */
let clusterRequestSeq = 0;

/**
 * State keys to cluster for explicitly named datasets: each one's selected
 * panels, else all its panels, else the dataset itself (no panel).
 */
function datasetKeyMap(datasetIds: string[], st: { selectedDatasets: Set<string>; panels: PanelConfig[] }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const dsId of datasetIds) {
    const own = st.panels.filter(p => p.contentType === 'dataset' && p.datasetId === dsId);
    const chosen = own.filter(p => st.selectedDatasets.has(p.id));
    const keys = [...new Set((chosen.length > 0 ? chosen : own).map(p => p.stateKey ?? dsId))];
    out[dsId] = keys.length > 0 ? keys : [dsId];
  }
  return out;
}

/**
 * Cluster reads on the given (main-view) peak regions, panel by panel: copies
 * of a dataset with their own filter or focus are separate requests (at most
 * one panel per dataset each), and each result goes back to its own panel.
 * A result is dropped if a newer clustering started, the view or the active
 * branch changed, or that panel's assignments were replaced meanwhile.
 */
async function clusterPeakRegions(
  peakRegions: PeakRegionWithMode[],
  label = 'selected peak(s)',
  options: { datasetIds?: string[]; clusterFeatureRules?: ClusterFeatureRule[] } = {},
): Promise<string> {
  const state = useBrowserStore.getState();
  const {
    chrom, start, end, datasets, selectedDatasets, panels, clusterK, clusterMethod,
    spanningOnly, analysisSampleCount, subnucleosomalThreshold, accessibilityThreshold,
    analysisSampleSeed,
  } = state;

  if (datasets.length === 0) return 'No datasets are loaded.';
  if (peakRegions.length === 0) return 'No peak regions were available for clustering.';

  const requested = (options.datasetIds ?? []).filter(Boolean);
  const unknown = requested.filter(id => !datasets.some(d => d.id === id));
  if (requested.length > 0 && unknown.length === requested.length) {
    return `No loaded dataset matches ${requested.join(', ')}.`;
  }
  const datasetIds = requested.length > 0
    ? requested.filter(id => !unknown.includes(id))
    : getTargetDatasetIds(selectedDatasets, panels, datasets);
  const keyMap = requested.length > 0
    ? datasetKeyMap(datasetIds, state)
    : getStateKeyMap(selectedDatasets, panels, datasets);
  // The regions are the main view's, so only panels showing it are clustered
  // (a copy at another locus keeps its own clustering).
  const mainKeys = mainViewKeyMap(keyMap, state);
  const runIds = datasetIds.filter(id => (mainKeys[id]?.length ?? 0) > 0);
  if (runIds.length === 0) return 'No target panel shows the main view, so nothing was clustered.';

  // A panel's read scope: its cluster focus, else its read filter (an empty
  // filter is an applied one that matched nothing), else every read.
  const scopeOf = (sk: string): string[] | null | 'none' => {
    const focus = state.clusterFocus[sk];
    const assignments = state.clusterAssignments[sk];
    if (focus && focus.size > 0 && assignments) {
      const ids = Object.entries(assignments).filter(([, c]) => focus.has(c)).map(([id]) => id);
      if (ids.length > 0) return ids;
    }
    const filter = state.filteredReadIds[sk];
    if (filter) return filter.size > 0 ? Array.from(filter) : 'none';
    return null;
  };

  // The rules rule-mode regions refer to: the caller's, plus the saved ones
  // (as the Cluster button sends) for ids the caller didn't define.
  const givenRules = options.clusterFeatureRules ?? [];
  const featureRules = [...givenRules,
    ...(state.clusterFeatureRules ?? []).filter(rule => !givenRules.some(given => given.id === rule.id))];
  // A one-strand panel (CT or GA) is clustered on its strand's reads only.
  const strandOf = (sk: string) => panels.find(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === sk)?.strand ?? null;

  const seq = ++clusterRequestSeq;
  const performanceNotes = new Set<string>();
  const view = { chrom, start, end, branch: state.activeClusterTreeNodeId ?? null };
  const sources: Record<string, Record<string, number> | undefined> = {};
  for (const keys of Object.values(mainKeys)) for (const sk of keys) sources[sk] = state.clusterAssignments[sk];

  let clusteredReads = 0;
  let appliedPanels = 0;
  let filteredOut = 0;
  let skipped = 0;
  let lastPatterns: Record<string, unknown> | undefined;
  let lastMetricCohort: import('../types').ClusterMetricCohort | undefined;
  let seeded = false;
  for (const round of sortRounds(runIds, mainKeys)) {
    const readIdsMap: Record<string, string[]> = {};
    const roundIds: string[] = [];
    for (const [dsId, sk] of Object.entries(round)) {
      const scope = scopeOf(sk);
      if (scope === 'none') { filteredOut += 1; continue; }
      roundIds.push(dsId);
      if (scope) readIdsMap[dsId] = scope;
    }
    if (roundIds.length === 0) continue;
    // With a one-strand panel in the round, every panel goes as its own
    // window (the backend restricts strands only there); results then come
    // back under each panel's key.
    const windows = roundIds.some(dsId => strandOf(round[dsId]))
      ? roundIds.map(dsId => {
        const strand = strandOf(round[dsId]);
        return {
          dataset_id: dsId, result_key: round[dsId], chrom, start, end,
          ...(readIdsMap[dsId] ? { read_ids: readIdsMap[dsId] } : {}),
          ...(strand ? { strand } : {}),
        };
      })
      : undefined;
    const res = await clusterAllReads(
      chrom, start, end, peakRegions, clusterK, spanningOnly, roundIds, clusterMethod,
      Object.keys(readIdsMap).length > 0 ? readIdsMap : undefined,
      analysisSampleCount ?? undefined, subnucleosomalThreshold, accessibilityThreshold,
      undefined, analysisSampleSeed, featureRules, windows,
      { preparationSampleCount: useBrowserStore.getState().clusterPreparationCount },
    );
    const now = useBrowserStore.getState();
    if (seq !== clusterRequestSeq) return `Clustering on the ${label} was superseded by a newer clustering; not applied.`;
    if (now.chrom !== view.chrom || now.start !== view.start || now.end !== view.end
      || (now.activeClusterTreeNodeId ?? null) !== view.branch) {
      return `Clustering on the ${label} was dropped: the view or cluster branch changed while it ran.`;
    }
    let appliedHere = false;
    for (const [resultKey, result] of Object.entries(res.results)) {
      // Windows answer under the panel key, the plain request under the dataset id.
      const dsId = windows ? windows.find(w => w.result_key === resultKey)?.dataset_id : resultKey;
      const sk = dsId ? round[dsId] : undefined;
      if (!dsId || !sk) continue;
      const hasPanels = now.panels.some(p => p.contentType === 'dataset' && p.datasetId === dsId);
      const stillShown = now.panels.some(p => p.contentType === 'dataset' && (p.stateKey ?? p.datasetId) === sk)
        || (sk === dsId && !hasPanels);
      if (!stillShown || useBrowserStore.getState().clusterAssignments[sk] !== sources[sk]) { skipped += 1; continue; }
      if (!seeded) { seedHistoryBaseline(useBrowserStore.getState(), 'Before clustering', 'clustering'); seeded = true; }
      const assignments = result.assignments || {};
      const preparationSamples = { ...useBrowserStore.getState().clusterPreparationSamples };
      if (result.preparation_sampling) preparationSamples[sk] = result.preparation_sampling;
      else if (readIdsMap[dsId] && preparationSamples[sk]) {
        preparationSamples[sk] = { ...preparationSamples[sk], used: Object.keys(assignments).length };
      }
      else delete preparationSamples[sk];
      useBrowserStore.setState({ clusterPreparationSamples: preparationSamples });
      if (preparationSamples[sk]) useBrowserStore.getState().setDynamicClustering(false);
      useBrowserStore.getState().setClusterAssignments(sk, assignments);
      sources[sk] = useBrowserStore.getState().clusterAssignments[sk];
      clusteredReads += Object.keys(assignments).length;
      appliedPanels += 1;
      appliedHere = true;
    }
    if (appliedHere) {
      lastPatterns = res.cluster_patterns as Record<string, unknown> | undefined;
      lastMetricCohort = res.cluster_metric_cohort;
      const note = performanceSamplingNote(res.results);
      if (note) performanceNotes.add(note);
    }
  }

  if (appliedPanels === 0) {
    if (filteredOut > 0 && skipped === 0) return 'No reads pass the read filter, so there is nothing to cluster. Clear the filter first.';
    return `Clustering on the ${label} changed nothing${skipped ? ` (${skipped} panel(s) changed while it ran)` : ''}.`;
  }
  if (lastPatterns && clusterMethod === 'combinatorial') {
    useBrowserStore.getState().setClusterPatterns(lastPatterns as never, lastMetricCohort);
    useBrowserStore.getState().setClusterPeakRegions(peakRegions);
    useBrowserStore.getState().setDynamicClustering(true);
  } else {
    useBrowserStore.getState().setClusterPatterns({});
    adoptFitMetricCohort(lastMetricCohort);
    useBrowserStore.getState().setClusterPeakRegions(peakRegions);
    useBrowserStore.getState().setDynamicClustering(false);
  }

  useBrowserStore.getState().pushSnapshot(clusterRunLabel(clusterMethod, clusterK));
  const notes = [
    unknown.length ? `${unknown.join(', ')} not loaded` : '',
    skipped ? `${skipped} panel(s) changed while it ran and were left as they are` : '',
    filteredOut ? `${filteredOut} panel(s) filtered to no reads` : '',
  ].filter(Boolean);
  return `Clustered ${clusteredReads.toLocaleString()} reads in ${appliedPanels} panel(s) on ${label}${notes.length ? ` (${notes.join('; ')})` : ''}.`
    + (performanceNotes.size ? ` ${[...performanceNotes].join(' ')}` : '');
}

async function selectPeakAt(chrom: string, position: number, tolerance: number, label = 'nearest peak'): Promise<FirePeak | null> {
  let nearest = findNearestPeak(chrom, position, tolerance);
  if (!nearest) {
    const store = useBrowserStore.getState();
    store.setPeaksLocked(false);
    if (!(await runUiScan())) {
      window.dispatchEvent(new CustomEvent('fiberhmm:rescan-rule'));
      await waitFor(() => Boolean(findNearestPeak(chrom, position, tolerance)), 9000, 150);
    }
    nearest = findNearestPeak(chrom, position, tolerance);
  }
  if (!nearest) return null;
  useBrowserStore.getState().replacePeakSelection([nearest.peak.index]);
  return nearest.peak;
}

export async function executeBrowserAction(
  action: BrowserAction,
  highlight: HighlightOptions = {},
): Promise<string> {
  // Tutorial gating (evaluated when the step is reached, since earlier steps
  // change the state): skip_if drops a step whose goal already holds;
  // requires first points the user at a missing prerequisite and waits for it.
  const skipIf = valueAsString((action as any).skip_if);
  if (skipIf && await conditionHolds(skipIf)) {
    return `⏭ Already done (${conditionById(skipIf)?.description ?? skipIf}); step skipped.`;
  }
  const requires = valueAsString((action as any).requires);
  if (requires && !(await conditionHolds(requires))) {
    const condition = conditionById(requires);
    const outcome = await highlightForAction({
      type: 'try_it',
      text: condition?.hint ?? `First: ${requires}.`,
      anchor: condition?.anchor,
      wait_condition: requires,
    }, { ...highlight, description: undefined, progress: highlight.progress ? `${highlight.progress} · first` : undefined });
    if (outcome === 'end') return '⏹ Walkthrough ended.';
  }

  // Tutorial spotlight: flash the panel + ring the button this action will
  // touch. In non-tutorial mode this is a ~700 ms green pulse; in tutorial
  // mode it also pops a small explanation bubble and (optionally) waits for
  // the user to click "Next →" before continuing.
  const outcome = await highlightForAction(action as unknown as Record<string, unknown>, highlight);

  const type = valueAsString(action.type);

  // The user's turn: report whether they did it, so the runner can tell.
  if (type === 'try_it') {
    const text = valueAsString((action as any).text, 'Try it');
    if (outcome === 'done') return `✅ Done: ${text}`;
    if (outcome === 'end') return '⏹ Walkthrough ended.';
    return `⏭ Skipped${outcome === 'timeout' ? ' (timed out)' : ''}: ${text}`;
  }

  // Hybrid tutorial mode: actions explicitly marked `manualOnly` skip the
  // executor entirely. The spotlight above already flashed the panel + the
  // anchor button + (in tutorial mode) showed the manualHow popover with
  // waitForClick, so the user has been pointed at where to do this step
  // themselves. Return a "📌 Manual step" message so the panel UI marks
  // it as instructional (success) rather than a silent skip.
  // Optional-chain on the lookup because tests mock the copilotAnchors
  // module and may not provide COPILOT_ANCHORS.
  const anchor = COPILOT_ANCHORS?.[type];
  if (anchor?.manualOnly) {
    const how = anchor.manualHow?.(action as unknown as Record<string, unknown>) ?? null;
    return how
      ? `📌 Manual step: ${how}`
      : `📌 Manual step: ${anchor.describe(action as unknown as Record<string, unknown>)}`;
  }

  const state = useBrowserStore.getState();
  const { chrom, start, end } = state;

  if (type === 'navigate_region') {
    const nextChrom = valueAsString(action.chrom, chrom);
    const nextStart = valueAsNumber(action.start, start);
    const nextEnd = valueAsNumber(action.end, end);
    state.pushViewportHistory({ chrom: state.chrom, start: state.start, end: state.end });
    state.setViewport(nextChrom, nextStart, nextEnd);
    const gene = makeGene(action.gene);
    const tss = action.gene && typeof action.gene === 'object'
      ? valueAsNumber((action.gene as Record<string, unknown>).tss, NaN)
      : NaN;
    if (gene && Number.isFinite(tss)) {
      useBrowserStore.setState({
        showRelativeCoords: true,
        relativeTSS: tss,
        relativeGene: gene,
        selectedGenes: [gene],
      } as any);
    }
    return `Viewport set to ${nextChrom}:${nextStart.toLocaleString()}-${nextEnd.toLocaleString()}`;
  }

  if (type === 'scan_peaks') {
    useBrowserStore.getState().setPeaksLocked(false);
    // The Scan button's own run, awaited: the next action sees the new peaks.
    if (await runUiScan()) return 'Scanned peaks for enabled peak rules.';
    await new Promise(resolve => window.setTimeout(resolve, 100));
    window.dispatchEvent(new CustomEvent('fiberhmm:rescan-rule'));
    return 'Peak rescan queued for enabled peak rules.';
  }

  if (type === 'set_peaks_locked') {
    const locked = valueAsBoolean(action.locked);
    useBrowserStore.getState().setPeaksLocked(locked);
    return locked ? 'Peaks locked.' : 'Peaks unlocked.';
  }

  if (type === 'add_region_label_rule') {
    const regionStart = valueAsNumber(action.start, start);
    const regionEnd = valueAsNumber(action.end, end);
    const layer = valueAsString(action.layer, 'tf');
    const condition: OverlapCondition = {
      target: 'region',
      regionChrom: valueAsString(action.chrom, chrom),
      regionStart,
      regionEnd,
      regionLabel: valueAsString(action.region_label, valueAsString(action.label, 'Browser action region')),
    };
    const rawSizeMax = action.size_max;
    const sizeMax = typeof rawSizeMax === 'number' && Number.isFinite(rawSizeMax) ? rawSizeMax : null;
    const rule: ColorRule = {
      id: `browser-action-${Date.now()}`,
      name: valueAsString(action.label, 'Browser action label'),
      color: valueAsString(action.color, '#22c55e'),
      opacity: 1,
      sizeMin: valueAsNumber(action.size_min, 1),
      sizeMax,
      targetLayers: layer ? [layer] : [],
      conditions: [condition],
      enabled: true,
    };
    useBrowserStore.getState().addColormapRuleAtTop(rule);
    return `Prepended labeling rule "${rule.name}" for ${condition.regionLabel}.`;
  }

  if (type === 'select_peak_at') {
    const targetChrom = valueAsString(action.chrom, chrom);
    const position = valueAsNumber(action.position, Math.round((start + end) / 2));
    const tolerance = valueAsNumber(action.tolerance_bp, 500);
    const peak = await selectPeakAt(targetChrom, position, tolerance, valueAsString(action.label, 'nearest peak'));
    if (!peak) {
      return `No detected peak within ${tolerance} bp of ${targetChrom}:${position.toLocaleString()}.`;
    }
    return `Selected peak ${peak.index} (${peak.start.toLocaleString()}-${peak.end.toLocaleString()}).`;
  }

  if (type === 'cluster_by_saved_footprints') {
    // Same as Footprints > Co-occupancy > "Cluster reads by N footprints", with
    // the footprints ticked there for this locus (default: up to the first three).
    const state = useBrowserStore.getState();
    const bare = (c: string) => c.replace(/^chr/i, '');
    const placed = state.footprintGroups.filter(g => g.enabled && !g.autoGeneratedFamily
      && g.referenceAbsStart != null && g.referenceAbsEnd != null
      && (!g.referenceChrom || bare(g.referenceChrom) === bare(chrom)));
    if (placed.length === 0) return 'No enabled saved footprints with a position on this chromosome.';
    const view = { chrom, start, end };
    const remembered = findClusterSelection(state.cooccClusterSelections, clusterSelectionLocus(placed, view));
    const chosenIds = resolveClusterSelection(placed.map(g => g.id), remembered?.groupIds,
      placed.filter(g => footprintInView(g, view)).map(g => g.id));
    const groups = placed.filter(g => chosenIds.includes(g.id));
    if (groups.length === 0) return 'No saved footprints are ticked to cluster by (Footprints > Co-occupancy > Cluster by).';
    // The analysis covers the main view, so only panels showing it take the
    // clusters (a copy at another locus keeps its own).
    const keyMap = mainViewKeyMap(getStateKeyMap(state.selectedDatasets, state.panels, state.datasets), state);
    const datasetIds = getTargetDatasetIds(state.selectedDatasets, state.panels, state.datasets)
      .filter(id => (keyMap[id]?.length ?? 0) > 0);
    if (datasetIds.length === 0) return 'cluster_by_saved_footprints: no dataset panel shows the main view.';
    // What the result replaces: a branch switch or a new clustering meanwhile
    // (same view) makes it belong to clusters no longer shown.
    const branchBefore = state.activeClusterTreeNodeId;
    const assignmentsBefore = Object.fromEntries(Object.values(keyMap).flat().map(key => [key, state.clusterAssignments[key]]));
    const res = await analyzeFootprints(chrom, start, end, state.spanningOnly, [], datasetIds, {
      autoMotifs: false, sequences: false, motifs: false, overlap: false, profiles: false, vplot: false, coocc: true,
      groups: cooccGroupParams(groups),
      maxReads: state.analysisSampleCount ?? undefined,
      sampleSeed: state.analysisSampleSeed,
    });
    const moved = useBrowserStore.getState();
    if (moved.chrom !== chrom || moved.start !== start || moved.end !== end) {
      return 'cluster_by_saved_footprints: the view moved while the analysis ran; nothing was applied.';
    }
    if (moved.activeClusterTreeNodeId !== branchBefore
      || Object.entries(assignmentsBefore).some(([key, a]) => moved.clusterAssignments[key] !== a)) {
      return 'cluster_by_saved_footprints: the clustering changed while the analysis ran; nothing was applied.';
    }
    const clusters = computeMembershipClusters(res.co_occupancy ?? {}, groups, datasetIds);
    if (!clusters) return 'No reads in view could be assigned to the saved footprints.';
    // Panels closed or moved elsewhere while the analysis ran don't take it.
    applyMembershipClusters(clusters, groups, mainViewKeyMap(keyMap, useBrowserStore.getState()), start);
    return `Clustered ${clusters.legend.reduce((n, e) => n + e.count, 0).toLocaleString()} reads by footprint: `
      + clusters.legend.map(e => `C${e.id} ${e.label} (${e.count})`).join('; ');
  }

  if (type === 'cluster_selected_peaks') {
    const selected = Array.from(useBrowserStore.getState().selectedPeaks)
      .map(idx => useBrowserStore.getState().getAllPeaks().find(p => p.index === idx))
      .filter((p): p is FirePeak => p !== undefined)
      .map(peakRegionFromPeak);
    if (selected.length > 0) {
      const viaButton = await clusterSelectedLikeButton('selected peak(s)');
      if (viaButton) return viaButton;
    }
    return clusterPeakRegions(selected, 'selected peak(s)');
  }

  if (type === 'cluster_peak_at_gene_tss') {
    const gene = makeGene(action.gene);
    const targetChrom = valueAsString(action.chrom, gene?.chrom || chrom);
    const tss = valueAsNumber(action.tss ?? (action.gene as Record<string, unknown> | undefined)?.tss, NaN);
    const tolerance = valueAsNumber(action.tolerance_bp, 500);
    if (!targetChrom || !Number.isFinite(tss)) {
      throw new Error('Cannot cluster at gene TSS without a resolved chrom/TSS.');
    }

    const padding = valueAsNumber(action.padding_bp, 5000);
    const regionStart = Math.max(0, gene ? gene.start - padding : tss - padding);
    const regionEnd = gene ? gene.end + padding : tss + padding;
    const current = useBrowserStore.getState();
    if (!sameChrom(current.chrom, targetChrom) || tss < current.start || tss > current.end) {
      current.pushViewportHistory({ chrom: current.chrom, start: current.start, end: current.end });
      current.setViewport(targetChrom, regionStart, regionEnd);
      if (gene) {
        useBrowserStore.setState({
          showRelativeCoords: true,
          relativeTSS: tss,
          relativeGene: gene,
          selectedGenes: [gene],
        } as any);
      }
      await waitFor(() => {
        const s = useBrowserStore.getState();
        return sameChrom(s.chrom, targetChrom) && s.start === regionStart && s.end === regionEnd;
      }, 1000, 50);
      await waitFor(() => Object.values(useBrowserStore.getState().activeReadIds).some(ids => ids.length > 0), 10000, 150);
    }

    const peak = await selectPeakAt(targetChrom, tss, tolerance, `${gene?.name || targetChrom} TSS peak`);
    if (!peak) {
      throw new Error(`No detected peak within ${tolerance} bp of ${targetChrom}:${Math.round(tss).toLocaleString()}.`);
    }
    // selectPeakAt selected it: cluster as the button would.
    const viaButton = await clusterSelectedLikeButton(`${gene?.name || targetChrom} TSS peak`);
    if (viaButton) return viaButton;
    return clusterPeakRegions([peakRegionFromPeak(peak)], `${gene?.name || targetChrom} TSS peak`);
  }

  if (type === 'query_motif_overlaps') {
    const targetChrom = valueAsString(action.chrom, chrom);
    const targetStart = valueAsNumber(action.start, start);
    const targetEnd = valueAsNumber(action.end, end);
    const motifTracks = loadedMotifTracks();
    if (motifTracks.length === 0) return 'No motif tracks are loaded.';
    const hits: string[] = [];
    const failed: string[] = [];
    // The track list holds no intervals (the viewport's live in
    // orthogonalTrackData, for the view only): ask for the target region.
    for (const track of motifTracks) {
      let intervals: Array<{ start: number; end: number; name?: string }> = [];
      try {
        intervals = (await getTrackAnnotations(track.index, targetChrom, Math.floor(targetStart), Math.ceil(targetEnd))).intervals ?? [];
      } catch {
        // The view's cached intervals answer only for a target inside the view.
        const view = useBrowserStore.getState();
        if (sameChrom(view.chrom, targetChrom) && targetStart >= view.start && targetEnd <= view.end) {
          intervals = view.orthogonalTrackData[track.index]?.intervals ?? [];
        } else {
          failed.push(track.label);
          continue;
        }
      }
      for (const iv of intervals) {
        if (overlap(targetStart, targetEnd, iv.start, iv.end)) {
          hits.push(`${track.label}${iv.name ? `:${iv.name}` : ''} ${targetChrom}:${iv.start}-${iv.end}`);
        }
      }
    }
    const unanswered = failed.length ? ` Could not query ${failed.join(', ')}.` : '';
    if (hits.length === 0) {
      if (failed.length === motifTracks.length) throw new Error(`Motif query failed for ${targetChrom}:${targetStart}-${targetEnd}.`);
      return `No loaded motif track intervals overlap the target region.${unanswered}`;
    }
    return `Motif overlaps: ${hits.slice(0, 8).join('; ')}${hits.length > 8 ? `; +${hits.length - 8} more` : ''}.${unanswered}`;
  }

  if (type === 'api_call') {
    const method = valueAsString(action.method, 'GET').toUpperCase();
    const path = valueAsString(action.path);
    const safety = browserApiAllowed(method, path, action.body);
    if (!safety.allowed || action.allowed === false) {
      throw new Error(valueAsString(action.blocked_reason, safety.reason || 'API call blocked by browser-action safety rules.'));
    }
    // Clustering through the raw API would only return assignments the browser
    // never shows: run it as the Cluster button does (per panel, displayed).
    const apiPath = canonicalApiPath(path);
    if (method === 'POST' && (apiPath === '/api/cluster_all' || apiPath === '/api/cluster')) {
      return clusterViaApiCall(path, action.body);
    }
    // Exporting a session means saving one, as Save session does (with the
    // browser's own state: panels, capture regions, view).
    if (method === 'POST' && apiPath === '/api/session/export') {
      const filename = await downloadSession(useBrowserStore.getState().sessionName || null);
      return `Saved the session as ${filename}.`;
    }
    // Sorts and filters come back as read orders and read IDs: shown in the
    // panels, as the Sort and Filter controls do.
    if (method === 'POST' && apiPath && READ_RESULT_PATHS.has(apiPath)) {
      return readResultsViaApiCall(path, apiPath, action.body);
    }
    const init: RequestInit = { method };
    if (method !== 'GET' && action.body !== null && action.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(action.body);
    }
    const response = await fetchApiResponse(path, init);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status}`);
    }
    // A motif the backend just made is shown like one added from the Tracks panel.
    if (method === 'POST' && apiPath && MOTIF_CREATION_PATHS.has(apiPath)) {
      const registered = registerApiMotifTracks(payload, action.body);
      if (registered > 0) {
        return `${method} ${path} -> added ${registered} motif track${registered === 1 ? '' : 's'} to the browser.`;
      }
    }
    const maybeRegion = payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>).region ?? payload)
      : null;
    if (maybeRegion && typeof maybeRegion === 'object') {
      const raw = maybeRegion as Record<string, unknown>;
      const nextChrom = valueAsString(raw.chrom);
      const nextStart = valueAsNumber(raw.start, NaN);
      const nextEnd = valueAsNumber(raw.end, NaN);
      if (nextChrom && Number.isFinite(nextStart) && Number.isFinite(nextEnd)) {
        useBrowserStore.getState().setViewport(nextChrom, nextStart, nextEnd);
      }
    }
    return `${method} ${path} -> ${truncateText(JSON.stringify(payload))}`;
  }

  // Tutorial-friendly UI actions: drive the store directly so the panel +
  // spotlight machinery (highlightForAction above) can show the user what's
  // happening. Prefer these over api_call when the model wants the user to
  // *see* the change (open a panel, add a rule, etc.).
  if (type === 'open_panel') {
    const panelType = valueAsString(action.panel_type ?? (action as any).panelType);
    if (!panelType) return 'open_panel: no panel_type supplied; skipped.';
    const store = useBrowserStore.getState() as unknown as {
      openAnalysisPanel?: (type: string) => void;
    };
    store.openAnalysisPanel?.(panelType);
    const tab = valueAsString(action.tab);
    if (tab && typeof window !== 'undefined') {
      // Mirror the AnalysisRunSummary deep-link convention used elsewhere:
      // the panel reads its initial active tab from sessionStorage.
      window.sessionStorage?.setItem(`fiberbrowser_${panelType.replace(/-/g, '_')}_tab`, tab);
    }
    return `Opened ${panelType}${tab ? ` (${tab} tab)` : ''}.`;
  }

  // View-only steps a tutorial uses to show the user around.
  if (type === 'open_sidebar') {
    const section = valueAsString(action.section);
    if (!section) return 'open_sidebar: no section supplied; skipped.';
    useBrowserStore.getState().setSidebarOpen(true);
    openSidebarSection(section, valueAsString(action.subsection) || undefined);
    return `Opened the ${section} sidebar section.`;
  }

  if (type === 'close_panel') {
    const panelType = valueAsString(action.panel_type ?? (action as any).panelType);
    const panel = useBrowserStore.getState().panels.find(p => p.contentType === panelType);
    if (!panelType || panelType === 'dataset' || !panel) return `close_panel: no open ${panelType || 'analysis'} panel; skipped.`;
    useBrowserStore.getState().removePanel(panel.id);
    return `Closed the ${panelType} panel.`;
  }

  if (type === 'zoom_view') {
    const zoomIn = valueAsString(action.direction) === 'in';
    const steps = Math.max(1, Math.min(10, Math.round(valueAsNumber(action.steps, 1))));
    for (let i = 0; i < steps; i += 1) {
      if (zoomIn) useBrowserStore.getState().zoomIn();
      else useBrowserStore.getState().zoomOut();
    }
    return `Zoomed ${zoomIn ? 'in' : 'out'}${steps > 1 ? ` ${steps} steps` : ''}.`;
  }

  if (type === 'pan_view') {
    const left = valueAsString(action.direction) === 'left';
    if (left) useBrowserStore.getState().panLeft();
    else useBrowserStore.getState().panRight();
    return `Panned ${left ? 'left' : 'right'}.`;
  }

  if (type === 'add_cluster_rule') {
    const name = valueAsString(action.name, 'New cluster rule');
    const terms = Array.isArray(action.terms) ? action.terms : [];
    const scope = (action.scope && typeof action.scope === 'object') ? action.scope : { kind: 'selectedPeaks' };
    if (terms.length === 0) return 'add_cluster_rule: terms is empty; skipped.';
    const store = useBrowserStore.getState() as unknown as {
      openAnalysisPanel?: (type: string) => void;
      addClusterFeatureRule?: (rule: Record<string, unknown>) => void;
    };
    // Open the Rules panel + park it on the Cluster tab so the user
    // sees the new rule land where they'd otherwise have to navigate to.
    store.openAnalysisPanel?.('cluster-features');
    if (typeof window !== 'undefined') {
      window.sessionStorage?.setItem('fiberbrowser_analysis_rules_tab', 'cluster');
    }
    store.addClusterFeatureRule?.({
      id: `copilot_${Date.now()}`,
      name,
      enabled: true,
      scope,
      terms,
    });
    return `Added cluster rule "${name}" (${terms.length} term${terms.length === 1 ? '' : 's'}).`;
  }

  if (type === 'add_sort_rule' || type === 'add_filter_rule') {
    const isFilter = type === 'add_filter_rule';
    const name = valueAsString(action.name, isFilter ? 'New filter rule' : 'New sort rule');
    const terms = Array.isArray(action.terms) ? action.terms : [];
    const scope = (action.scope && typeof action.scope === 'object') ? action.scope : { kind: 'selectedPeaks' };
    const metric = valueAsString(action.metric, 'count');
    if (terms.length === 0) return `${type}: terms is empty; skipped.`;
    const store = useBrowserStore.getState() as unknown as {
      openAnalysisPanel?: (type: string) => void;
      addAnalysisSortRule?: (rule: Record<string, unknown>) => void;
      addAnalysisFilterRule?: (rule: Record<string, unknown>) => void;
    };
    store.openAnalysisPanel?.('cluster-features');
    if (typeof window !== 'undefined') {
      window.sessionStorage?.setItem('fiberbrowser_analysis_rules_tab', isFilter ? 'filter' : 'sort');
    }
    const base = {
      id: `copilot_${Date.now()}`,
      name,
      enabled: true,
      scope,
      terms,
      metric,
    };
    if (isFilter) {
      store.addAnalysisFilterRule?.({
        ...base,
        operator: valueAsString(action.operator, 'gte'),
        threshold: valueAsNumber(action.threshold, 1),
        // 'between' bound and AND with the current filter (terms may be molecule_metric / feature_hub).
        ...(action.threshold_max != null ? { thresholdMax: valueAsNumber(action.threshold_max, 0) } : {}),
        ...(action.combine === 'and' ? { combine: 'and' } : {}),
      });
    } else {
      store.addAnalysisSortRule?.({
        ...base,
        descending: action.descending !== false,
      });
    }
    return `Added ${isFilter ? 'filter' : 'sort'} rule "${name}".`;
  }

  if (type === 'hide_cluster') {
    const clusterId = valueAsNumber(action.cluster_id, NaN);
    if (!Number.isFinite(clusterId)) return 'hide_cluster: no cluster_id; skipped.';
    const keys = actionStateKeys(action);
    if (keys.length === 0) return 'hide_cluster: no dataset available.';
    const store = useBrowserStore.getState();
    seedHistoryBaseline(store, 'Before hiding cluster', 'clustering');
    // As the Clusters panel's Hide: drop it from the visible set (clusterFocus),
    // keeping clusters already hidden hidden and the order as it is. The last
    // visible cluster stays.
    const hidden: string[] = [];
    for (const key of keys) {
      const now = useBrowserStore.getState();
      const all = [...new Set(Object.values(now.clusterAssignments[key] ?? {}))].filter(c => c >= 0);
      if (!all.includes(clusterId)) continue;
      const visible = now.clusterFocus[key] ?? new Set(all);
      if (!visible.has(clusterId)) { hidden.push(key); continue; }
      const next = new Set(all.filter(c => visible.has(c) && c !== clusterId));
      if (next.size === 0) continue;
      // (Part of this action's one step, recorded below.)
      store.setClusterFocus(key, next.size >= all.length ? null : next, { record: false });
      hidden.push(key);
    }
    if (hidden.length === 0) return `hide_cluster: cluster ${clusterId} isn't a visible cluster that can be hidden (the last visible cluster stays).`;
    store.pushSnapshot(`Hide cluster ${clusterId}`, { kind: 'clustering' });
    store.openAnalysisPanel('cluster-detail');
    return `Hid cluster ${clusterId} in ${hidden.join(', ')}.`;
  }

  if (type === 'focus_cluster') {
    const clusterId = valueAsNumber(action.cluster_id, NaN);
    if (!Number.isFinite(clusterId)) return 'focus_cluster: no cluster_id; skipped.';
    const keys = actionStateKeys(action);
    if (keys.length === 0) return 'focus_cluster: no dataset available.';
    const store = useBrowserStore.getState();
    // One undo step for every panel (stabilize 3, item 2).
    store.focusClustersIn(keys, new Set([clusterId]), `Focus cluster ${clusterId}`);
    store.openAnalysisPanel('cluster-detail');
    return `Focused on cluster ${clusterId} in ${keys.join(', ')} (others dimmed).`;
  }

  if (type === 'dissolve_cluster') {
    const clusterId = valueAsNumber(action.cluster_id, NaN);
    if (!Number.isFinite(clusterId)) return 'dissolve_cluster: no cluster_id; skipped.';
    const store = useBrowserStore.getState();
    const requestedId = valueAsString(action.dataset_id);
    const datasetIds = requestedId
      ? [requestedId]
      : getTargetDatasetIds(store.selectedDatasets, store.panels, store.datasets);
    if (datasetIds.length === 0) return 'dissolve_cluster: no dataset available.';
    // As the Clusters panel's Delete: the panels at the charts' view, with its locus, reference and peaks.
    const { keys, leftOut: skippedOtherLoci, view, peakRegions, rounds } = copilotMergeInputs(datasetIds);
    if (keys.length === 0) return 'dissolve_cluster: no clustered panel to act on.';
    if (peakRegions.length === 0) return 'dissolve_cluster: no cluster peak regions are available.';
    store.openAnalysisPanel?.('cluster-detail');
    let dissolvedAny = false;
    seedHistoryBaseline(store, 'Before dissolving cluster', 'clustering');
    const before = clusteringBeforeMerge();
    const changedKeys: string[] = [];
    const branch = store.activeClusterTreeNodeId ?? null;
    let stale = 0;
    // Each round's panels get their own results back. Whatever was applied (even if a later round fails) is one
    // undo step and can be unmerged, as auto_cull_clusters does (Codex review, stabilize 3 group B round 1).
    try {
      for (const round of rounds) {
        const res = await dissolveCluster(
          view.chrom, view.start, view.end, clusterId,
          round.assignments,
          peakRegions,
          Object.keys(round.keyByDataset),
          store.spanningOnly,
          store.subnucleosomalThreshold,
          store.accessibilityThreshold,
          store.analysisSampleSeed,
          store.clusterFeatureRules,
          view.genome,
          // Metric columns rank against the fit's cohort, as the fit did.
          { metricCohort: store.clusterMetricCohort },
        );
        // The view, branch or clustering changed while this ran: it no longer applies.
        if (!copilotRoundStillCurrent(round, view, branch)) { stale += Object.keys(round.keyByDataset).length; continue; }
        for (const [dsId, result] of Object.entries(res.results ?? {})) {
          const sk = round.keyByDataset[dsId];
          if (!sk || !result) continue;
          const now = useBrowserStore.getState();
          now.setClusterAssignments(sk, result.assignments || {});
          const currentOrder = now.clusterOrder[sk];
          if (currentOrder) now.setClusterOrder(sk, currentOrder.filter(c => c !== clusterId));
          if (now.clusterFocus[sk]?.has(clusterId)) now.setClusterFocus(sk, null, { record: false });
          now.pruneClusterSelection(sk, [clusterId]);
          dissolvedAny = true;
          changedKeys.push(sk);
        }
      }
    } finally {
      // As the Clusters panel does: the reassignment model still has the dissolved cluster.
      if (dissolvedAny) {
        useBrowserStore.getState().setDynamicClustering(false);
        recordAppliedMerge(before, changedKeys, { label: `Delete C${clusterId}`, kind: 'dissolve' });
        // Its one undo step (the focus it cleared is part of it; stabilize 3, item 2).
        useBrowserStore.getState().pushSnapshot(`Delete C${clusterId}`, { kind: 'clustering' });
      }
    }
    if (stale === keys.length) return `dissolve_cluster: the clustering changed while it ran; nothing was applied.`;
    return `Dissolved cluster ${clusterId} in ${keys.length - stale} clustered panel(s)`
      + `${skippedOtherLoci ? ` (${skippedOtherLoci} panel(s) at another locus left as they are)` : ''}`
      + `${stale ? `; ${stale} panel(s) changed meanwhile and were left as they are` : ''}.`;
  }

  // ── Layer / display toggles ───────────────────────────────────────
  if (type === 'toggle_layer') {
    const layer = valueAsString(action.layer);
    const enabled = action.enabled !== false;
    if (!layer) return 'toggle_layer: no layer; skipped.';
    const store = useBrowserStore.getState() as unknown as {
      toggleModType?: (layer: string, enabled: boolean) => void;
    };
    store.toggleModType?.(layer, enabled);
    return `${enabled ? 'Showed' : 'Hid'} ${layer} layer.`;
  }

  if (type === 'set_quality_filter') {
    const value = valueAsNumber(action.value, 0);
    (useBrowserStore.getState() as unknown as { setMinFpQuality?: (v: number) => void })
      .setMinFpQuality?.(Math.max(0, Math.round(value)));
    return `Min FP quality set to ${Math.round(value)}.`;
  }

  if (type === 'set_min_footprints') {
    const value = valueAsNumber(action.value, 0);
    (useBrowserStore.getState() as unknown as { setMinFootprints?: (v: number) => void })
      .setMinFootprints?.(Math.max(0, Math.round(value)));
    return `Min footprints per read set to ${Math.round(value)}.`;
  }

  if (type === 'set_spanning_only') {
    const enabled = action.enabled !== false;
    (useBrowserStore.getState() as unknown as { setSpanningOnly?: (v: boolean) => void })
      .setSpanningOnly?.(enabled);
    return `Span filter ${enabled ? 'enabled' : 'disabled'}.`;
  }

  // ── Color rules ───────────────────────────────────────────────────
  if (type === 'remove_color_rule' || type === 'toggle_color_rule') {
    const ruleId = valueAsString(action.rule_id);
    const ruleName = valueAsString(action.rule_name).toLowerCase();
    const store = useBrowserStore.getState() as unknown as {
      openAnalysisPanel?: (type: string) => void;
      activeColormap?: { rules?: Array<{ id: string; name: string }> };
      removeColormapRule?: (id: string) => void;
      updateColormapRule?: (id: string, updates: Record<string, unknown>) => void;
    };
    const rules = store.activeColormap?.rules ?? [];
    let targetId = ruleId;
    if (!targetId && ruleName) {
      // The default accessibility rule was renamed from "Accessibility (FIRE)".
      const aliases = ruleName === 'accessibility (fire)' || ruleName === 'accessibility'
        ? ['accessibility', 'accessibility (fire)'] : [ruleName];
      targetId = rules.find(r => aliases.includes(r.name.toLowerCase()))?.id ?? '';
    }
    if (!targetId) return `${type}: no rule matched.`;
    store.openAnalysisPanel?.('colormap');
    if (type === 'remove_color_rule') {
      store.removeColormapRule?.(targetId);
      return `Removed color rule ${targetId}.`;
    }
    store.updateColormapRule?.(targetId, { enabled: action.enabled !== false });
    return `${action.enabled !== false ? 'Enabled' : 'Disabled'} color rule ${targetId}.`;
  }

  if (type === 'clear_color_rules') {
    (useBrowserStore.getState() as unknown as {
      setActiveColormap?: (cm: Record<string, unknown>) => void;
    }).setActiveColormap?.({ rules: [] });
    return 'Cleared all color rules.';
  }

  // ── Track operations ──────────────────────────────────────────────
  if (type === 'add_track_from_url') {
    const path = valueAsString(action.path);
    if (!path) return 'add_track_from_url: no path; skipped.';
    if (!isRemoteTrackUrl(path)) {
      return 'add_track_from_url blocked: only http(s), s3, or ucsc URLs are allowed from Copilot actions.';
    }
    // The track browser's own path: catalog, cart row and refresh stay in sync.
    const res = await registerTrack({
      pathOrUrl: path,
      label: valueAsString(action.track_label) || undefined,
      renderMode: valueAsString(action.render_mode) || undefined,
      source: 'online',
    });
    if (!res.success) return `add_track failed: ${res.message ?? 'the server refused the track'}`;
    useBrowserStore.getState().triggerRefresh();
    return `Added track ${path}.`;
  }

  if (type === 'remove_track') {
    const idx = valueAsNumber(action.track_index, NaN);
    if (!Number.isFinite(idx)) return 'remove_track: no track_index; skipped.';
    // Cart and catalog entries go too; filters and rule references follow the index shift.
    await removeTrackAtIndex(idx);
    return `Removed track #${idx}.`;
  }

  if (type === 'set_track_filter') {
    const idx = valueAsNumber(action.track_index, NaN);
    if (!Number.isFinite(idx)) return 'set_track_filter: no track_index; skipped.';
    const names = (Array.isArray(action.filter_names) ? action.filter_names : [])
      .map(name => String(name).trim()).filter(Boolean);
    await setTrackNameFilter(idx, names);
    return `Set track #${idx} filter to ${names.length} name(s).`;
  }

  // ── Apply saved rules / cluster ops ───────────────────────────────
  if (type === 'apply_cluster_rule' || type === 'apply_sort_rule' || type === 'apply_filter_rule') {
    const kind = type === 'apply_cluster_rule' ? 'cluster'
      : type === 'apply_sort_rule' ? 'sort' : 'filter';
    const ruleId = valueAsString(action.rule_id);
    const ruleName = valueAsString(action.rule_name).toLowerCase();
    const store = useBrowserStore.getState();
    const list = kind === 'cluster' ? store.clusterFeatureRules
      : kind === 'sort' ? store.analysisSortRules
      : store.analysisFilterRules;
    let rule = ruleId ? list?.find(r => r.id === ruleId) : undefined;
    if (!rule && ruleName) rule = list?.find(r => r.name.toLowerCase() === ruleName);
    if (!rule) return `${type}: no rule matched.`;

    if (kind === 'cluster') {
      // Switch cluster mode + dispatch the cluster button.
      store.setClusterPeakMode?.(`cluster_rule:${rule.id}`);
      // Awaited, so a following action sees the new clusters.
      if (!(await runUiCluster())) window.dispatchEvent(new CustomEvent('fiberhmm:run-cluster'));
      return `Applied cluster rule "${rule.name}" (mode=cluster_rule:${rule.id}).`;
    }

    // The sort/filter request covers the main view, so only panels showing it
    // take the results (a copy at another locus keeps its own order/filter).
    const keyMap = mainViewKeyMap(getStateKeyMap(store.selectedDatasets, store.panels, store.datasets), store);
    const datasetIds = getTargetDatasetIds(store.selectedDatasets, store.panels, store.datasets)
      .filter(id => (keyMap[id]?.length ?? 0) > 0);
    if (datasetIds.length === 0) return `${type}: no dataset panel shows the main view.`;
    const peakRegions = allPeakWindows();
    const requestSeq = kind === 'sort' ? nextSortRequest() : nextFilterRequest();
    // A sort answers for the cluster branch active now.
    const requestBranch = useBrowserStore.getState().activeClusterTreeNodeId ?? null;
    const scopeWindows = resolveAnalysisRuleWindows(rule as AnalysisSortRule | AnalysisFilterRule);
    if (scopeWindows.length === 0) return `${type}: rule "${rule.name}" has no regions in scope.`;

    if (kind === 'sort') {
      const sortRule = rule as AnalysisSortRule;
      const term = sortRule.terms[0];
      const problem = analysisRuleTermProblem(term);
      if (problem) return `apply_sort_rule: rule "${sortRule.name}" ${problem}.`;
      const transcriptionState = transcriptionStateFromAnalysisTerm(term);
      const geneIds = transcriptionState ? geneIdsForAnalysisRule(sortRule) : undefined;
      if (transcriptionState && (!geneIds || geneIds.length === 0)) {
        return `apply_sort_rule: rule "${sortRule.name}" needs a selected gene.`;
      }
      // Molecule metric ('value') and hub hit ('feature_hub') terms read no layer.
      const layerFree = sortRuleRequestFields(sortRule);
      // ('value' belongs to molecule metrics: a layer term saved with it counts.)
      const countSort = sortRule.metric === 'count' || sortRule.metric === 'value';
      const backendSortBy = transcriptionState
        ? 'transcription_state'
        : layerFree
          ? layerFree.sortBy
          : countSort
          ? 'rule'
          : sortRule.metric === 'rate'
            ? 'fp_rate'
            : sortRule.metric;
      // Each panel sorts its own clusters and read scope (as the Sort button
      // does): one request per round, each round at most one panel per dataset.
      const rounds = sortRounds(datasetIds, keyMap);
      const results: Array<{
        stateKey: string; sentAssignments: Record<string, number> | undefined;
        result: { cluster_order?: number[]; read_sort_order?: string[] };
      }> = [];
      for (const round of rounds) {
        const roundIds = Object.keys(round);
        const now = useBrowserStore.getState();
        const sentAssignments = Object.fromEntries(roundIds.map(id => [id, now.clusterAssignments[round[id]]]));
        const scope = resolveSortRequestScope({
          datasetIds: roundIds,
          sortKeyMap: Object.fromEntries(roundIds.map(id => [id, [round[id]]])),
          clusterAssignments: now.clusterAssignments,
          selectedClusters: now.selectedClusters,
          clusterFocus: now.clusterFocus,
          filteredReadIds: now.filteredReadIds,
          activeClusterTreeNodeId: now.activeClusterTreeNodeId,
          clusterTreeNodes: now.clusterTreeNodes,
        });
        const res = await sortReads(chrom, start, end, store.spanningOnly, roundIds, backendSortBy, {
          rule: !transcriptionState && !layerFree && countSort ? rulePayloadFromAnalysisTerm(term) : undefined,
          ...(layerFree?.sortBy === 'value' ? { moleculeMetric: layerFree.moleculeMetric } : {}),
          ...(layerFree?.sortBy === 'feature_hub' ? { featureHub: layerFree.featureHub } : {}),
          descending: sortRule.descending !== false,
          linked: isLinkedGroup(roundIds, store.panels),
          peakRegions: peakRegions.length > 0 ? peakRegions : undefined,
          selectedPeakWindows: scopeWindows,
          layer: transcriptionState || layerFree ? undefined : layerFromAnalysisTerm(term),
          transcriptionState,
          geneIds,
          readIds: Object.keys(scope.readIds).length > 0 ? scope.readIds : undefined,
          clusterAssignments: Object.keys(scope.clusterAssignments).length > 0 ? scope.clusterAssignments : undefined,
          sampleSeed: store.analysisSampleSeed,
          liftHapByDataset: liftHapsForRound(round, store.panels),
        });
        const staleSort = staleRuleResult(kind, requestSeq, { chrom, start, end });
        if (staleSort) return `${type}: ${staleSort}`;
        if ((useBrowserStore.getState().activeClusterTreeNodeId ?? null) !== requestBranch) {
          return `${type}: the cluster branch changed before the results arrived; not applied.`;
        }
        for (const [dsId, result] of Object.entries(res.results)) {
          if (round[dsId]) results.push({ stateKey: round[dsId], sentAssignments: sentAssignments[dsId], result });
        }
      }
      // Panels closed or moved elsewhere while the request ran don't take it.
      const liveKeys = new Set(Object.values(mainViewKeyMap(keyMap, useBrowserStore.getState())).flat());
      seedHistoryBaseline(store, 'Before sorting', 'sorting');
      for (const { stateKey, sentAssignments, result } of results) {
        if (!liveKeys.has(stateKey)) continue;
        // Reclustered, merged or restored meanwhile: the order is for other clusters.
        if (useBrowserStore.getState().clusterAssignments[stateKey] !== sentAssignments) continue;
        if (result.cluster_order && result.cluster_order.length > 0) store.setClusterOrder(stateKey, result.cluster_order);
        if (result.read_sort_order) store.setReadSortOrder(stateKey, result.read_sort_order);
      }
      return `Applied sort rule "${sortRule.name}".`;
    }

    // filter
    const filterRule = rule as AnalysisFilterRule;
    const term = filterRule.terms[0];
    const problem = analysisRuleTermProblem(term);
    if (problem) return `apply_filter_rule: rule "${filterRule.name}" ${problem}.`;
    const transcriptionState = transcriptionStateFromAnalysisTerm(term);
    const geneIds = transcriptionState ? geneIdsForAnalysisRule(filterRule) : undefined;
    if (transcriptionState && (!geneIds || geneIds.length === 0)) {
      return `apply_filter_rule: rule "${filterRule.name}" needs a selected gene.`;
    }
    // Molecule metric ('value', between) and hub hit terms read no layer and send no size rule.
    const fields = filterRuleRequestFields(filterRule);
    const combine = filterRule.combine === 'and';
    const res = await filterReadsByAnalysisRule(chrom, start, end, store.spanningOnly, datasetIds, {
      metric: fields.metric,
      operator: fields.operator,
      threshold: fields.threshold,
      thresholdMax: fields.thresholdMax,
      moleculeMetric: fields.moleculeMetric,
      featureHub: fields.featureHub,
      rule: !fields.layerFree && fields.metric === 'count' ? rulePayloadFromAnalysisTerm(term) : undefined,
      peakRegions: peakRegions.length > 0 ? peakRegions : undefined,
      scopeWindows,
      layer: fields.layerFree ? undefined : layerFromAnalysisTerm(term),
      transcriptionState,
      geneIds,
      sampleSeed: store.analysisSampleSeed,
    });
    const staleFilter = staleRuleResult(kind, requestSeq, { chrom, start, end });
    if (staleFilter) return `${type}: ${staleFilter}`;
    if (action.pin !== false) {
      const now = useBrowserStore.getState();
      const liveKeys = mainViewKeyMap(keyMap, now);
      seedHistoryBaseline(store, 'Before read filter', 'filtering');
      for (const [dsId, result] of Object.entries(res.results)) {
        for (const sk of (liveKeys[dsId] ?? [])) {
          // 'and': only the reads the panel's current filter keeps too.
          const current = combine ? now.filteredReadIds[sk] : null;
          store.setFilteredReadIds(sk, intersectWithCurrentFilter(result.read_ids ?? [], current), {
            target: 'analysis-filter',
            label: analysisFilterLabel(filterRule.name, current ? now.readFilterSources[sk] ?? {} : null),
          });
        }
      }
      store.setFootprintFilterKey(null);
    }
    return `Applied filter rule "${filterRule.name}"${combine ? ' within the current filter' : ''}${action.pin !== false ? ' (pinned)' : ''}.`;
  }

  if (type === 'select_cluster_reads') {
    const clusterId = valueAsNumber(action.cluster_id, NaN);
    if (!Number.isFinite(clusterId)) return 'select_cluster_reads: no cluster_id; skipped.';
    const keys = actionStateKeys(action);
    if (keys.length === 0) return 'select_cluster_reads: no dataset.';
    const store = useBrowserStore.getState();
    let selectedCount = 0;
    for (const key of keys) {
      const assignments = store.clusterAssignments[key] ?? {};
      const matching = new Set(Object.entries(assignments).filter(([, c]) => c === clusterId).map(([id]) => id));
      store.setReadSelection(key, matching);
      selectedCount += matching.size;
    }
    return `Selected ${selectedCount} read${selectedCount === 1 ? '' : 's'} in cluster ${clusterId}.`;
  }

  if (type === 'auto_cull_clusters') {
    const stored = storedMergeSettings();
    const minFraction = valueAsNumber(action.min_fraction, stored.minFraction);
    const maxSim = valueAsNumber(action.max_cosine_similarity, stored.maxSimilarity);
    // An explicit similarity cutoff is a cosine request; else the stored "Merge by".
    const mergeBy = action.max_cosine_similarity != null ? { strategy: 'cosine', threshold: maxSim } : stored.mergeBy;
    const mergeSettings = { minFraction, maxSimilarity: maxSim, strategy: mergeBy.strategy as typeof stored.strategy, threshold: mergeBy.threshold ?? maxSim };
    const store = useBrowserStore.getState();
    const datasetIds = getTargetDatasetIds(store.selectedDatasets, store.panels, store.datasets);
    if (datasetIds.length === 0) return 'auto_cull_clusters: no dataset available.';
    // As the Clusters panel's Merge: the panels at the charts' view, with its locus, reference and peaks.
    const { keys, leftOut: skippedOtherLoci, view, peakRegions, rounds } = copilotMergeInputs(datasetIds);
    if (keys.length === 0) return 'auto_cull_clusters: no clustered panel to act on.';
    if (peakRegions.length === 0) return 'auto_cull_clusters: no cluster peak regions are available.';
    seedHistoryBaseline(store, 'Before auto-cull', 'clustering');
    const branch = store.activeClusterTreeNodeId ?? null;
    let merged = 0;
    let stale = 0;
    const before = clusteringBeforeMerge();
    const changedKeys: string[] = [];
    try {
      // Each round's panels get their own results back.
      for (const round of rounds) {
        const res = await autoCullClusters(
          view.chrom, view.start, view.end,
          round.assignments,
          peakRegions,
          Object.keys(round.keyByDataset),
          store.spanningOnly,
          store.subnucleosomalThreshold,
          store.accessibilityThreshold,
          minFraction,
          maxSim,
          store.analysisSampleSeed,
          store.clusterFeatureRules,
          view.genome,
          mergeBy,
          { metricCohort: store.clusterMetricCohort },
        );
        const dissolvedIds = new Set((res.dissolved ?? []).map(d => d.cluster));
        if (dissolvedIds.size === 0) continue;
        if (!copilotRoundStillCurrent(round, view, branch)) { stale += Object.keys(round.keyByDataset).length; continue; }
        merged += dissolvedIds.size;
        for (const [dsId, result] of Object.entries(res.results ?? {})) {
          const sk = round.keyByDataset[dsId];
          if (!sk || !result) continue;
          const now = useBrowserStore.getState();
          now.setClusterAssignments(sk, result.assignments || {});
          changedKeys.push(sk);
          const currentOrder = now.clusterOrder[sk];
          if (currentOrder) now.setClusterOrder(sk, currentOrder.filter(c => !dissolvedIds.has(c)));
          now.setClusterFocus(sk, null, { record: false });
          now.pruneClusterSelection(sk, dissolvedIds);
        }
      }
    } finally {
      // As the Clusters panel does: the reassignment model still has the merged-away clusters.
      // Whatever was applied (even if a later panel's request fails) can be unmerged, as one undo step.
      if (changedKeys.length > 0) {
        useBrowserStore.getState().setDynamicClustering(false);
        recordAppliedMerge(before, changedKeys, { label: 'Merge similar clusters', kind: 'similar', settings: mergeSettings });
        useBrowserStore.getState().pushSnapshot('Merge similar clusters', { kind: 'clustering' });
      }
    }
    return `Merged away ${merged} cluster${merged === 1 ? '' : 's'} across ${keys.length} clustered panel(s) (min_fraction=${minFraction}, merge_by=${mergeSettings.strategy} ${mergeSettings.threshold})`
      + `${skippedOtherLoci ? `; ${skippedOtherLoci} panel(s) at another locus left as they are` : ''}`
      + `${stale ? `; ${stale} panel(s) changed while it ran and were left as they are` : ''}.`;
  }

  // ── Annotations / Capture ─────────────────────────────────────────
  if (type === 'toggle_annotation_visibility') {
    const name = valueAsString(action.name);
    const enabled = action.enabled !== false;
    (useBrowserStore.getState() as unknown as {
      toggleAnnotationType?: (name: string, enabled: boolean) => void;
    }).toggleAnnotationType?.(name, enabled);
    return `${enabled ? 'Showed' : 'Hid'} ${name} annotations.`;
  }

  if (type === 'add_capture_region') {
    const regionChrom = valueAsString(action.chrom);
    const regionStart = valueAsNumber(action.start, 0);
    const regionEnd = valueAsNumber(action.end, 0);
    const store = useBrowserStore.getState();
    // Named and padded like a region added from the Capture panel (exports read name/padding).
    const region: CaptureRegion = {
      id: `copilot_capture_${Date.now()}`,
      name: valueAsString(action.region_label) || `region_${store.captureRegions.length + 1}`,
      chrom: regionChrom,
      start: regionStart,
      end: regionEnd,
      padding: store.capturePadding,
      addedAt: Date.now(),
      source: 'custom',
    };
    store.addCaptureRegion(region);
    return `Captured ${regionChrom}:${regionStart}-${regionEnd}.`;
  }

  if (type === 'clear_capture_regions') {
    (useBrowserStore.getState() as unknown as {
      clearCaptureRegions?: () => void;
    }).clearCaptureRegions?.();
    return 'Cleared capture regions.';
  }

  // ── Footprint Analysis ────────────────────────────────────────────
  if (type === 'analyze_footprints') {
    const store = useBrowserStore.getState() as unknown as {
      openAnalysisPanel?: (type: string) => void;
    };
    // The panel auto-analyzes off a useEffect keyed on selection / viewport /
    // layer / sampling, so opening it is enough to run with current settings.
    // (The old fiberhmm:run-footprint-analyze event lost its listener in the
    // v2.11 refactor — opening the panel is the live trigger now.)
    store.openAnalysisPanel?.('footprint-analysis');
    return 'Opened Footprint Analysis; it runs automatically with current settings.';
  }

  if (type === 'add_footprint_group') {
    const group = {
      name: valueAsString(action.name, 'Footprint class'),
      layer: valueAsString(action.layer, 'tf'),
      sizeMin: valueAsNumber(action.size_min, 1),
      sizeMax: valueAsNumber(action.size_max, 89),
      color: valueAsString(action.color, '#22c55e'),
      enabled: true,
    };
    (useBrowserStore.getState() as unknown as {
      addFootprintGroup?: (group: Record<string, unknown>) => void;
      openAnalysisPanel?: (type: string) => void;
    }).addFootprintGroup?.(group);
    return `Added footprint class "${group.name}" (${group.layer}, ${group.sizeMin}-${group.sizeMax} bp).`;
  }

  if (type === 'remove_footprint_group') {
    const groupId = valueAsString(action.group_id);
    const groupName = valueAsString(action.group_name).toLowerCase();
    const store = useBrowserStore.getState() as unknown as {
      footprintGroups?: Array<{ id: string; name: string }>;
      removeFootprintGroup?: (id: string) => void;
    };
    let targetId = groupId;
    if (!targetId && groupName) {
      targetId = store.footprintGroups?.find(g => g.name.toLowerCase() === groupName)?.id ?? '';
    }
    if (!targetId) return 'remove_footprint_group: no group matched.';
    store.removeFootprintGroup?.(targetId);
    return `Removed footprint class ${targetId}.`;
  }

  // ── Reproducibility settings ──────────────────────────────────────
  if (type === 'set_cluster_method') {
    const method = valueAsString(action.method);
    (useBrowserStore.getState() as unknown as { setClusterMethod?: (m: string) => void })
      .setClusterMethod?.(method);
    return `Cluster method = ${method}.`;
  }

  if (type === 'set_cluster_k') {
    const k = valueAsNumber(action.k, 5);
    (useBrowserStore.getState() as unknown as { setClusterK?: (k: number) => void })
      .setClusterK?.(k);
    return `k = ${k}.`;
  }

  if (type === 'set_accessibility_threshold') {
    // The validator sends a percentage (5-95); the store holds a fraction.
    const raw = valueAsNumber(action.value, NaN);
    if (!Number.isFinite(raw)) return 'set_accessibility_threshold: no value; skipped.';
    const fraction = raw > 1 ? raw / 100 : raw;
    useBrowserStore.getState().setAccessibilityThreshold(Math.min(0.95, Math.max(0.05, fraction)));
    return `Accessibility threshold = ${Math.round(fraction * 100)}%.`;
  }

  if (type === 'set_subnucleosomal_threshold') {
    const bp = valueAsNumber(action.value, NaN);
    if (!Number.isFinite(bp)) return 'set_subnucleosomal_threshold: no value; skipped.';
    useBrowserStore.getState().setSubnucleosomalThreshold(Math.round(bp));
    return `Subnucleosomal threshold = ${Math.round(bp)} bp.`;
  }

  if (type === 'navigate_gene') {
    // Agent tool calls arrive unnormalized (the plan flow resolves genes on the server).
    const query = valueAsString(action.gene) || valueAsString(action.gene_name) || valueAsString(action.name);
    if (!query) return 'navigate_gene: no gene; skipped.';
    const hit = await searchGene(query);
    if (!hit.found || !hit.chrom || !Number.isFinite(hit.start) || !Number.isFinite(hit.end)) {
      return `Gene "${query}" not found${hit.suggestions?.length ? ` (did you mean ${hit.suggestions.slice(0, 3).join(', ')}?)` : ''}.`;
    }
    const padding = valueAsNumber(action.padding_bp, 5000);
    const nextStart = Math.max(0, (hit.start as number) - padding);
    const nextEnd = (hit.end as number) + padding;
    state.pushViewportHistory({ chrom, start, end });
    useBrowserStore.getState().setViewport(hit.chrom, nextStart, nextEnd);
    return `Navigated to ${hit.gene_name || query} (${hit.chrom}:${nextStart.toLocaleString()}-${nextEnd.toLocaleString()}).`;
  }

  if (type === 'set_sample_seed') {
    const seed = valueAsString(action.seed);
    (useBrowserStore.getState() as unknown as { setAnalysisSampleSeed?: (s: string) => void })
      .setAnalysisSampleSeed?.(seed);
    return `Sample seed = ${seed}.`;
  }

  // ── Selection / reset ─────────────────────────────────────────────
  if (type === 'clear_selected_peaks') {
    useBrowserStore.getState().clearPeakSelection();
    return 'Cleared selected peaks.';
  }

  if (type === 'clear_selected_reads') {
    useBrowserStore.setState({ selectedReadIds: {} } as any);
    return 'Cleared selected reads.';
  }

  if (type === 'reset_view') {
    (useBrowserStore.getState() as unknown as { resetView?: () => void }).resetView?.();
    return 'Reset viewport to default.';
  }

  if (type === 'remove_cluster_rule' || type === 'remove_sort_rule' || type === 'remove_filter_rule') {
    const ruleId = valueAsString(action.rule_id);
    const ruleName = valueAsString(action.rule_name).toLowerCase();
    const store = useBrowserStore.getState() as unknown as {
      openAnalysisPanel?: (type: string) => void;
      clusterFeatureRules?: Array<{ id: string; name: string }>;
      analysisSortRules?: Array<{ id: string; name: string }>;
      analysisFilterRules?: Array<{ id: string; name: string }>;
      removeClusterFeatureRule?: (id: string) => void;
      removeAnalysisSortRule?: (id: string) => void;
      removeAnalysisFilterRule?: (id: string) => void;
    };
    const kind = type === 'remove_cluster_rule' ? 'cluster'
      : type === 'remove_sort_rule' ? 'sort'
      : 'filter';
    const list = kind === 'cluster' ? store.clusterFeatureRules
      : kind === 'sort' ? store.analysisSortRules
      : store.analysisFilterRules;
    let targetId = ruleId;
    if (!targetId && ruleName && list) {
      targetId = list.find(r => r.name.toLowerCase() === ruleName)?.id ?? '';
    }
    if (!targetId) return `${type}: no rule matched id="${ruleId}" name="${ruleName}".`;
    store.openAnalysisPanel?.('cluster-features');
    if (typeof window !== 'undefined') {
      window.sessionStorage?.setItem('fiberbrowser_analysis_rules_tab', kind);
    }
    if (kind === 'cluster') store.removeClusterFeatureRule?.(targetId);
    else if (kind === 'sort') store.removeAnalysisSortRule?.(targetId);
    else store.removeAnalysisFilterRule?.(targetId);
    return `Removed ${kind} rule ${targetId}.`;
  }

  if (type === 'clear_filter') {
    const store = useBrowserStore.getState() as unknown as {
      datasets?: Array<{ id: string }>;
      filteredReadIds?: Record<string, Set<string> | null>;
      setFilteredReadIds?: (datasetId: string, ids: Set<string> | null) => void;
    };
    const explicit = valueAsString(action.dataset_id);
    // Filters are kept per panel state key: a copy of a dataset has its own.
    const panels = useBrowserStore.getState().panels;
    const datasetIds = explicit ? [explicit] : (store.datasets ?? []).map(d => d.id);
    const keys = new Set<string>(datasetIds);
    for (const p of panels) {
      if (p.contentType === 'dataset' && p.datasetId && datasetIds.includes(p.datasetId)) keys.add(p.stateKey ?? p.datasetId);
    }
    if (!explicit) for (const key of Object.keys(store.filteredReadIds ?? {})) keys.add(key);
    // An empty set is an applied filter too (one that matched nothing).
    const targets = [...keys].filter(key => store.filteredReadIds?.[key] != null);
    // A pending Rules filter (the panel's or Copilot's) must not land after this.
    invalidateFilterRequests();
    if (targets.length > 0) seedHistoryBaseline(useBrowserStore.getState(), 'Before clearing read filter', 'filtering');
    for (const key of targets) store.setFilteredReadIds?.(key, null);
    const cleared = targets.length;
    return `Cleared filter on ${cleared} panel${cleared === 1 ? '' : 's'}.`;
  }

  if (type === 'design_primers_for_region') {
    const targetChrom = valueAsString(action.chrom, chrom);
    const targetStart = valueAsNumber(action.start, start);
    const targetEnd = valueAsNumber(action.end, end);
    const mode = valueAsString(action.mode, 'standard') as 'standard' | 'dafc' | '4c';
    const store = useBrowserStore.getState() as unknown as {
      openAnalysisPanel?: (type: string) => void;
      setPrimerMode?: (mode: 'standard' | 'dafc' | '4c') => void;
      setPrimerTarget?: (start: number, end: number, chrom?: string | null) => void;
    };
    store.openAnalysisPanel?.('primer-design');
    store.setPrimerMode?.(mode);
    if (Number.isFinite(targetStart) && Number.isFinite(targetEnd)) {
      store.setPrimerTarget?.(targetStart, targetEnd, targetChrom);
    }
    if (mode === 'dafc') {
      // 3C pairs primers across two loci; the action carries only one region.
      return '📌 Manual step: the Primers panel is set to 3C; enter the second locus there and click Design Primers.';
    }
    const body = {
      chrom: targetChrom,
      start: Math.floor(targetStart),
      end: Math.floor(targetEnd),
    };
    // Each mode has its own endpoint (4C designs from the viewpoint region).
    const route = mode === '4c' ? '/api/design_4c_primers' : '/api/design_primers';
    const response = await fetchApiResponse(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return `design_primers failed: ${response.status}`;
    const payload = await response.json().catch(() => null) as {
      success?: boolean; message?: string; error?: string; pairs?: PrimerPair[]; pair?: PrimerPair;
    } | null;
    // Into the Primers panel the way its Design button stores results.
    const found = payload?.pairs?.length ? payload.pairs : payload?.pair ? [payload.pair] : [];
    if (!payload || payload.success === false || found.length === 0) {
      const reason = payload?.message || payload?.error || 'no candidate pairs';
      useBrowserStore.getState().setPrimerError(reason);
      return `design_primers (${mode}) found no primers: ${reason}.`;
    }
    const pairs = found.map(pair => ({
      ...pair, designChrom: body.chrom, designTargetStart: body.start, designTargetEnd: body.end,
    }));
    const primerStore = useBrowserStore.getState();
    primerStore.setDesignResults(pairs);
    primerStore.setPrimerPair(pairs[0]);
    return `Designed ${pairs.length} ${mode} primer pair${pairs.length === 1 ? '' : 's'} for ${targetChrom}:${targetStart.toLocaleString()}-${targetEnd.toLocaleString()}.`;
  }

  // ── Dataset Layout panel (v2.11 merge) ────────────────────────────
  if (type === 'set_dataset_label') {
    const datasetId = valueAsString(action.dataset_id);
    const labelText = valueAsString(action.label_text);
    if (!datasetId || !labelText) return 'set_dataset_label: need dataset_id and label_text; skipped.';
    (useBrowserStore.getState() as unknown as { setDatasetLabel?: (id: string, label: string) => void })
      .setDatasetLabel?.(datasetId, labelText);
    return `Renamed dataset ${datasetId} to "${labelText}".`;
  }

  if (type === 'merge_datasets' || type === 'unmerge_dataset') {
    // The store merges the panels in selectedPanelIds (the layout editor's
    // selection); Copilot means the selected panels, else every shown one.
    const store = useBrowserStore.getState();
    const shown = store.panels.filter(p => p.contentType === 'dataset' && p.datasetId && !p.collapsed);
    const picked = store.selectedPanelIds.size > 0
      ? shown.filter(p => store.selectedPanelIds.has(p.id))
      : store.selectedDatasets.size > 0 ? shown.filter(p => store.selectedDatasets.has(p.id)) : shown;
    const before = store.datasets.map(d => d.id).join('\n');
    if (type === 'merge_datasets') {
      const datasetIds = [...new Set(picked.map(p => p.datasetId!))];
      if (datasetIds.length < 2) return 'merge_datasets: select at least two dataset panels to merge; nothing merged.';
      useBrowserStore.setState({ selectedPanelIds: new Set(picked.map(p => p.id)) });
      await store.mergeSelectedPanels();
    } else {
      if (picked.length !== 1) return 'unmerge_dataset: select the one merged dataset panel to split; nothing changed.';
      useBrowserStore.setState({ selectedPanelIds: new Set([picked[0].id]) });
      await store.unmergeSelectedPanel();
    }
    if (useBrowserStore.getState().datasets.map(d => d.id).join('\n') === before) {
      return `${type}: nothing changed${useBrowserStore.getState().error ? ` (${useBrowserStore.getState().error})` : ''}.`;
    }
    return type === 'merge_datasets' ? 'Merged the selected datasets.' : 'Unmerged the selected dataset.';
  }

  if (type === 'link_datasets' || type === 'unlink_dataset') {
    // Copilot names datasets (or panels): every panel of a named dataset counts.
    const st = useBrowserStore.getState();
    const named = type === 'link_datasets'
      ? (Array.isArray(action.panel_ids) ? action.panel_ids.map(v => valueAsString(v)).filter(Boolean) : [])
      : [valueAsString(action.panel_id)].filter(Boolean);
    const panelIds = st.panels
      .filter(p => p.contentType === 'dataset'
        && (named.includes(p.id) || (p.datasetId != null && named.includes(p.datasetId)) || (p.stateKey != null && named.includes(p.stateKey))))
      .map(p => p.id);
    if (type === 'link_datasets') {
      if (named.length < 2) return 'link_datasets: need at least two panel_ids; skipped.';
      if (panelIds.length < 2) return `link_datasets: fewer than two panels match ${named.join(', ')}; nothing linked.`;
      st.linkPanels(panelIds);
      return `Linked ${panelIds.length} panels.`;
    }
    if (named.length === 0) return 'unlink_dataset: no panel_id; skipped.';
    const linked = panelIds.filter(id => st.panels.find(p => p.id === id)?.linkGroup);
    if (linked.length === 0) return `unlink_dataset: no linked panel matches ${named[0]}; nothing changed.`;
    for (const id of linked) st.unlinkPanel(id);
    return `Unlinked ${named[0]}.`;
  }

  // ── Cluster selection + merge (v2.11 merge) ───────────────────────
  if (type === 'toggle_cluster_selection' || type === 'set_cluster_selection' || type === 'clear_cluster_selection') {
    const keys = actionStateKeys(action);
    if (keys.length === 0) return `${type}: no dataset.`;
    const store = useBrowserStore.getState();
    if (type === 'clear_cluster_selection') {
      for (const key of keys) store.clearClusterSelection(key);
      return 'Cleared cluster selection.';
    }
    if (type === 'toggle_cluster_selection') {
      const clusterId = valueAsNumber(action.cluster_id, NaN);
      if (!Number.isFinite(clusterId)) return 'toggle_cluster_selection: no cluster_id; skipped.';
      for (const key of keys) {
        const next = new Set(store.selectedClusters[key] ?? []);
        if (next.has(clusterId)) next.delete(clusterId); else next.add(clusterId);
        store.setClusterSelection(key, next);
      }
      return `Toggled selection of cluster ${clusterId}.`;
    }
    const ids = Array.isArray(action.cluster_ids)
      ? action.cluster_ids.map(n => valueAsNumber(n, NaN)).filter(Number.isFinite) : [];
    if (ids.length === 0) return 'set_cluster_selection: no cluster_ids; skipped.';
    for (const key of keys) store.setClusterSelection(key, ids);
    return `Selected ${ids.length} cluster(s).`;
  }

  if (type === 'merge_clusters') {
    const datasetIds = Array.isArray(action.dataset_ids)
      ? action.dataset_ids.map(v => valueAsString(v)).filter(Boolean) : undefined;
    const store = useBrowserStore.getState() as unknown as {
      mergeSelectedClusters?: (datasetIds?: string[]) => number;
    };
    if (!store.mergeSelectedClusters) return 'merge_clusters: unavailable; skipped.';
    // Selections and assignments live under each panel's state key: a named
    // dataset means its target panels' keys (a copy's own key included).
    let keys: string[] | undefined;
    if (datasetIds?.length) {
      const st = useBrowserStore.getState();
      const keyMap = getStateKeyMap(st.selectedDatasets, st.panels, st.datasets);
      keys = [...new Set(datasetIds.flatMap(id => keyMap[id]?.length ? keyMap[id] : [id]))];
    }
    const merged = store.mergeSelectedClusters(keys);
    if (!merged) return 'merge_clusters: nothing merged (select at least two clusters in a panel first).';
    return `Merged the selected clusters in ${merged} panel${merged === 1 ? '' : 's'}.`;
  }

  // ── Panels: strands, copies at other loci, best-covered loci ───────
  if (type === 'set_panel_strand' || type === 'split_panel_by_strand') {
    const st = useBrowserStore.getState();
    // Selected panels, else every panel of a strand-specific (DAF-seq) dataset.
    const daf = st.panels.filter(p => p.contentType === 'dataset' && !p.collapsed && p.datasetId
      && isStrandedDafDataset(st.datasets.find(d => d.id === p.datasetId)));
    const selected = daf.filter(p => st.selectedDatasets.has(p.id));
    const targets = selected.length > 0 ? selected : daf;
    if (targets.length === 0) return 'No DAF-seq panel to show by strand (strands apply to DddA/DddB data).';
    if (type === 'split_panel_by_strand') {
      for (const p of targets) useBrowserStore.getState().splitPanelByStrand(p.id);
      return `Split ${targets.length} panel${targets.length === 1 ? '' : 's'} into CT | GA.`;
    }
    const raw = valueAsString(action.strand, 'both').toUpperCase();
    const strand = raw === 'CT' || raw === 'GA' ? raw : null;
    for (const p of targets) useBrowserStore.getState().setPanelStrand(p.id, strand);
    return strand ? `Showing only ${strand}-strand reads.` : 'Showing both strands.';
  }

  if (type === 'open_panel_copy') {
    const st = useBrowserStore.getState();
    const panels = st.panels.filter(p => p.contentType === 'dataset' && p.datasetId && !p.collapsed);
    const source = panels.find(p => st.selectedDatasets.has(p.id)) ?? panels[0];
    if (!source) return 'No dataset panel to copy.';
    const hasRegion = typeof action.chrom === 'string' && Number.isFinite(Number(action.start)) && Number.isFinite(Number(action.end));
    const copy = st.openPanelAtSite(source.id, hasRegion ? undefined : { linked: true });
    if (!copy) return 'Could not copy the panel.';
    lastCopilotCopyId = copy;
    lastCopilotCopySelection = useBrowserStore.getState().selectedDatasets;
    if (hasRegion) {
      useBrowserStore.getState().navigatePanel(copy, String(action.chrom), Number(action.start), Number(action.end));
      return `Opened a copy at ${action.chrom}:${Number(action.start).toLocaleString()}-${Number(action.end).toLocaleString()} (unlinked).`;
    }
    return 'Opened a linked copy of the panel; unlink it to move it on its own.';
  }

  if (type === 'set_panel_linked') {
    const st = useBrowserStore.getState();
    const copies = st.panels.filter(p => p.viewportOverride);
    const selected = copies.filter(p => st.selectedDatasets.has(p.id));
    // "Unlink it" right after opening a copy means that copy (not every copy,
    // nor a copy that was already selected), until the user selects something else.
    const lastCopy = copies.find(p => p.id === lastCopilotCopyId);
    const freshCopy = lastCopy && st.selectedDatasets === lastCopilotCopySelection ? lastCopy : null;
    const targets = freshCopy ? [freshCopy] : selected.length > 0 ? selected : lastCopy ? [lastCopy] : copies;
    if (targets.length === 0) return 'No panel copy to link or unlink (add one with + in a panel header).';
    const linked = action.linked !== false;
    for (const p of targets) useBrowserStore.getState().setPanelSiteLocked(p.id, linked);
    return `${linked ? 'Linked' : 'Unlinked'} ${targets.length} panel cop${targets.length === 1 ? 'y' : 'ies'}.`;
  }

  if (type === 'go_to_top_locus') {
    const step = await findTopLocus(Math.max(1, end - start));
    if (!isTopLocusStep(step)) return step.message;
    state.pushViewportHistory({ chrom, start, end });
    useBrowserStore.getState().setViewport(step.window.chrom, step.window.start, step.window.end);
    return `Locus ${step.index + 1} of ${step.total}: depth ${step.window.depth.toLocaleString()} at ${step.window.chrom}:${step.window.start.toLocaleString()}.`;
  }

  if (type === 'set_cluster_order_lock') {
    const locked = action.locked !== false;
    window.dispatchEvent(new CustomEvent('fiberhmm:set-cluster-order-lock', { detail: { locked } }));
    return `Cluster order ${locked ? 'locked' : 'unlocked'}.`;
  }

  // ── Cluster trees / branches + dynamic reassignment (v2.12) ───────
  if (type === 'subcluster_clusters') {
    const ids = Array.isArray(action.cluster_ids)
      ? action.cluster_ids.map(n => valueAsNumber(n, NaN)).filter(Number.isFinite) : [];
    if (ids.length === 0) return 'subcluster_clusters: no cluster_ids; skipped.';
    const keys = actionStateKeys(action);
    if (keys.length === 0) return 'subcluster_clusters: no dataset.';
    // Select the clusters to drill into, then run clustering — handleCluster
    // (Browser.tsx) detects the subset selection and branches via commitSubcluster.
    // Awaited, so a following action sees the subclusters.
    for (const key of keys) useBrowserStore.getState().setClusterSelection(key, ids);
    // The Cluster button runs on the selected panels: select exactly the target
    // panels for this run, then give the user's selection back.
    const before = useBrowserStore.getState().selectedDatasets;
    const targets = new Set(useBrowserStore.getState().panels
      .filter(p => p.contentType === 'dataset' && p.datasetId && keys.includes(p.stateKey ?? p.datasetId))
      .map(p => p.id));
    if (targets.size > 0) useBrowserStore.setState({ selectedDatasets: targets });
    try {
      if (!(await runUiCluster())) window.dispatchEvent(new CustomEvent('fiberhmm:run-cluster'));
    } finally {
      if (targets.size > 0 && useBrowserStore.getState().selectedDatasets === targets) {
        useBrowserStore.setState({ selectedDatasets: before });
      }
    }
    return `Subclustering ${ids.length} cluster(s): ${ids.join(', ')}.`;
  }

  if (type === 'set_dynamic_clustering') {
    const enabled = action.enabled !== false;
    (useBrowserStore.getState() as unknown as { setDynamicClustering?: (b: boolean) => void })
      .setDynamicClustering?.(enabled);
    return `Dynamic cluster reassignment ${enabled ? 'enabled' : 'disabled'}.`;
  }

  if (type === 'set_dynamic_overlap_mode') {
    const mode = valueAsString(action.mode);
    (useBrowserStore.getState() as unknown as { setDynamicOverlapMode?: (m: 'conservative' | 'aggressive') => void })
      .setDynamicOverlapMode?.(mode === 'conservative' ? 'conservative' : 'aggressive');
    return `Dynamic overlap mode set to ${mode}.`;
  }

  if (type === 'capture_cluster_branch') {
    const name = valueAsString(action.name);
    const id = (useBrowserStore.getState() as unknown as {
      captureActiveClusterTreeNode?: (opts?: { name?: string }) => string | null;
    }).captureActiveClusterTreeNode?.(name ? { name } : undefined);
    return id ? `Saved current clustering as branch${name ? ` "${name}"` : ''}.`
      : 'capture_cluster_branch: nothing to save (no active clustering).';
  }

  if (type === 'switch_cluster_branch' || type === 'rename_cluster_branch' || type === 'delete_cluster_branch') {
    const store = useBrowserStore.getState() as unknown as {
      clusterTreeNodes?: Record<string, { name?: string }>;
      activeClusterTreeNodeId?: string | null;
      applyClusterTreeNode?: (id: string) => void;
      renameClusterTreeNode?: (id: string, name: string) => void;
      deleteClusterTreeNode?: (id: string) => void;
    };
    const nodes = store.clusterTreeNodes ?? {};
    const wantName = valueAsString(action.name).toLowerCase();
    const resolveByName = (n: string): string | undefined =>
      Object.entries(nodes).find(([, node]) => (node.name ?? '').toLowerCase() === n)?.[0];

    if (type === 'rename_cluster_branch') {
      const newName = valueAsString(action.new_name);
      if (!newName) return 'rename_cluster_branch: no new_name; skipped.';
      const id = wantName ? resolveByName(wantName) : (store.activeClusterTreeNodeId ?? undefined);
      if (!id) return `rename_cluster_branch: branch ${wantName ? `"${action.name}"` : '(active)'} not found.`;
      store.renameClusterTreeNode?.(id, newName);
      return `Renamed cluster branch to "${newName}".`;
    }

    if (!wantName) return `${type}: no branch name; skipped.`;
    const id = resolveByName(wantName);
    if (!id) return `${type}: branch "${action.name}" not found.`;
    if (type === 'switch_cluster_branch') {
      store.applyClusterTreeNode?.(id);
      return `Switched to cluster branch "${action.name}".`;
    }
    store.deleteClusterTreeNode?.(id);
    return `Deleted cluster branch "${action.name}".`;
  }

  // ── Read display controls (v2.11 merge) ───────────────────────────
  if (type === 'set_read_separator_mode') {
    const mode = valueAsString(action.mode);
    (useBrowserStore.getState() as unknown as { setReadSeparatorMode?: (m: string) => void })
      .setReadSeparatorMode?.(mode);
    return `Read separators set to ${mode}.`;
  }

  if (type === 'set_read_separator_min_height') {
    const value = Math.max(0, Math.round(valueAsNumber(action.value, 0)));
    (useBrowserStore.getState() as unknown as { setReadSeparatorMinHeight?: (n: number) => void })
      .setReadSeparatorMinHeight?.(value);
    return `Separator min height set to ${value}px.`;
  }

  if (type === 'set_read_separator_width') {
    const value = Math.max(0, Math.round(valueAsNumber(action.value, 0)));
    (useBrowserStore.getState() as unknown as { setReadSeparatorWidth?: (n: number) => void })
      .setReadSeparatorWidth?.(value);
    return `Separator width set to ${value}px.`;
  }

  if (type === 'set_fill_read_height') {
    const enabled = action.enabled !== false;
    (useBrowserStore.getState() as unknown as { setFillReadHeight?: (b: boolean) => void })
      .setFillReadHeight?.(enabled);
    return `Fill read height ${enabled ? 'enabled' : 'disabled'}.`;
  }

  if (type === 'set_read_row_height') {
    const raw = action.value;
    const height: number | 'auto' = (typeof raw === 'string' && raw.toLowerCase() === 'auto')
      ? 'auto' : Math.round(valueAsNumber(raw, NaN));
    if (height !== 'auto' && !Number.isFinite(height)) return 'set_read_row_height: bad value; skipped.';
    (useBrowserStore.getState() as unknown as { setReadRowHeight?: (h: number | 'auto') => void })
      .setReadRowHeight?.(height);
    return `Read row height set to ${height}.`;
  }

  if (type === 'set_layer_background_opacity') {
    const layer = valueAsString(action.layer);
    if (!layer) return 'set_layer_background_opacity: no layer; skipped.';
    const opacity = Math.max(0, Math.min(1, valueAsNumber(action.opacity, 0)));
    (useBrowserStore.getState() as unknown as { setLayerBackgroundOpacity?: (l: string, o: number) => void })
      .setLayerBackgroundOpacity?.(layer, opacity);
    return `${layer} background opacity set to ${opacity.toFixed(2)}.`;
  }

  // ── Motif tools (v2.11 merge) ─────────────────────────────────────
  if (type === 'set_motif_threshold') {
    const value = Math.max(0.5, Math.min(1, valueAsNumber(action.value, 0.85)));
    (useBrowserStore.getState() as unknown as { setMotifThreshold?: (v: number) => void })
      .setMotifThreshold?.(value);
    return `Motif score threshold set to ${value.toFixed(2)}.`;
  }

  if (type === 'load_jaspar_motifs') {
    const names = Array.isArray(action.names) ? action.names.map(v => valueAsString(v)).filter(Boolean) : [];
    if (names.length === 0) return 'load_jaspar_motifs: no names; skipped.';
    // Awaited, so a later action in the plan (query_motif_overlaps, ...) sees
    // the motifs; a failure fails this step.
    const motifCount = () => useBrowserStore.getState().orthogonalTracks.filter(t => t.category === 'motif').length;
    const before = motifCount();
    const result = await addJasparMotifsByName(names);
    if (!result.success) throw new Error(result.message || 'Could not load motifs');
    // The track list refreshes after the load; wait for the new tracks to show.
    await waitFor(() => motifCount() > before, 8000, 100);
    return result.message || `Loaded JASPAR motif track(s): ${names.join(', ')}.`;
  }

  return `Skipped unsupported action type "${type}".`;
}

export async function executeBrowserActions(
  actions: BrowserAction[],
  highlight: HighlightOptions = {},
): Promise<string[]> {
  const messages: string[] = [];
  for (const action of actions) {
    messages.push(await executeBrowserAction(action, highlight));
  }
  return messages;
}
