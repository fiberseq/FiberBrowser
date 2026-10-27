/**
 * The graph-view panel (DESIGN_GRAPH_PANEL.md §§1, 4): a target backbone and up to three compared paths from a
 * registered graph package, drawn as the joint selected-path bubble layout (layout.ts → scene.ts → canvas.ts) on
 * the panel's own ruler and coordinates: shared sequence once, as one tube with a stripe per path; alleles branch
 * into their path's lane and rejoin; an insertion takes one slot shared by the paths carrying it. It needs no BAM
 * and no live lift; it never takes the linear panels' insertion expansion, highlights, pan offset or crosshair.
 * Options are in its right-click menu; its rows show only data and a compact label.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import type { AnalysisPanelProps } from '../../plugins/types';
import { ReadContextMenu, type ContextMenuEntry } from '../../components/tracks/read-track/ReadContextMenu';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { cancelSubgraph, getReadBindings, querySubgraph, queryReads, GraphRequestError } from './api';
import { judgmentKey, unresolvedFraction, useGraphComplexity, viewKey } from './complexity';
import { drawRuler, drawScene, GRAPH_GUTTER, GRAPH_LANE_GAP, GRAPH_LANE_HEIGHT, GRAPH_RIGHT_PAD, GRAPH_RULER_HEIGHT, laneColor, laneTop } from './canvas';
import { clampViewport, formatBp, formatLocus, fromX, makeTransform, panViewport, parseLocus, zoomViewport, bpScale, type GraphViewport } from './coordinates';
import { buildLayout, laneLabel, type LayoutModel } from './layout';
import { buildScene, COMPACT_LANE_PX, describeSceneHit, planScene, sceneHitAt, sceneInverse, smallDifferenceBp, targetAtX, type Compression, type Scene } from './scene';
import { type LinearView, canFollow, defaultCompared, defaultTarget, effectiveViewport, initialGraphView, initiatorView, restoreProblem, retargetFor, selectableBindings, togglePath, withLayoutDefaults, GRAPH_MAX_PATHS } from './state';
import { onPackageError, useGraphStatusStore } from './statusStore';
import { usePanelContentHeightStore } from '../../stores/panelContentHeightStore';
import { useServerDatasetsStore } from '../../stores/serverDatasetsStore';
import { genomeKeyFor } from '../../utils/regionNavigation';
import { startTrace, type GraphTrace } from './timings';
import type { GraphApiError, GraphReadBinding, GraphReadSettings, GraphReadsReport, GraphReadsResponse, GraphRegistration, GraphSubgraphResponse, GraphViewState } from './types';
import { MAX_READ_PRIMITIVES, packMolecules, placeReads, placementIndex, type PackedLane, type PlacedMolecule } from './readGeometry';
import { addGraphRegion, drawRunOutlines, runOutlines } from './runOutlines';
import { bandHeight, describeReadHit, drawReadBandLabels, drawReads, effectiveReadLayers, emptyDrawStats, READ_ROW_GAP, READ_ROW_HEIGHT, type ReadDrawStats, type ReadHit, type ReadLayers } from './readCanvas';
import { chromatinStyle } from './chromatinStyle';
import { isInsertionGroup, hitGroup, placementsByPath, selectionForHit, sourcePlacements, focusWindow, type GraphSelection, type SourcePlacement } from './inspection';
import { selectGraph } from './selectionStore';
import { bumpNavigation, navigateGraph, navigationToken, showSourceSpan, sourcePanelsFor, tokenCurrent, type NavigationToken } from './navigation';
import { useGraphReadsStore } from './graphReadsStore';
import { moleculeKey, useLiftHover } from '../liveLift/linking/hover';
import { xForTarget } from './scene';
import { conversionTargets, convertStandalone, foldIn, isHost, joinCandidates, joinGraph, membersOf, panelKeyOf, panelView, poppable, setPanelViewMode } from './hostMode';
import { allocateRows, graphPins, packMemberBands, routeRead, STRIP_ROWS, type BandMember, type HostLane, type MemberState } from './memberBands';
import { singleHapPathName } from './labels';
import { popOutPaths } from './popOutKind';
import { firstCarriedColumns } from './columnOrder';
import { graphBindingFor } from './bindingsStore';
import { bandSampled, drawDensityStrips, placeStrips, stripKey, type GraphBandReport, type PlacedBin } from './densityStrip';
import { drawHostBandLabels, type ReadDecoration } from './readCanvas';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { setPinnedLinear, useGraphSettings } from './handoff';
import { copyText } from '../../utils/clipboard';
import { excludeReadsUndoably } from '../../components/tracks/read-track/ReadTrackActions';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { idSetHas, isMoleculeRecordKey, qnameOfId } from '../../utils/recordKeys';
import { branchScopesPanel, readIdSetForClusterRenderScope } from '../../utils/readScopes';

const DEBOUNCE_MS = 100;
/** Named visits walked beyond each window edge, so an event exactly at an edge has its flank (graphlift flank_bp). */
const FLANK_BP = 1;

declare global {
  interface Window {
    /** e2e only: each host's last complexity judgement (its window and unresolved fraction). */
    __FIBERBROWSER_GRAPH_COMPLEXITY__?: Record<string, { view: string; fraction: number }>;
    /** e2e only (with __FIBERBROWSER_E2E_EXPOSE_STORE): each graph panel's last scene, to locate its geometry. */
    __FIBERBROWSER_GRAPH_SCENES__?: Record<string, { scene: Scene; model: LayoutModel; offset: number;
      reads?: { molecules: PlacedMolecule[]; lanes: Record<string, { rows: number; hidden: number }>; hits: ReadHit[]; placeMs?: number; drawMs?: number; serverMs?: number;
        drawn?: ReadDrawStats; layers?: ReadLayers; hovered?: number; hoverKey?: string | null; strips?: number; report?: GraphReadsReport } }>;
  }
}
const STATUS_HEIGHT = 18;
/** Lane height of the panel's natural (content) size. */
const NATURAL_LANE = 34;
const DEFAULT_READS: GraphReadSettings = { show: true, datasets: null };
const READS_DEBOUNCE_MS = 0;   // the topology request is already debounced
/** Rows per lane's read band by default (each row a record; the request holds at most 300 molecules). */
const DEFAULT_ROWS_PER_LANE = 40;
/** QNAMEs a host asks the server to keep in its sample (its members' filters, selections and highlights). */
const MAX_GRAPH_PINS = 2000;

function setGraphView(panelId: string, next: GraphViewState): void {
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === panelId ? { ...p, graphView: next } : p)) }));
}

function Message({ title, children, testId }: { title: string; children?: React.ReactNode; testId: string }) {
  return (
    <div data-testid={testId} className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-[11px] text-gray-500 dark:text-gray-400">
      <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">{title}</span>
      {children}
    </div>
  );
}

function RegisterForm({ onDone, compact = false }: { onDone?: () => void; compact?: boolean }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const register = useGraphStatusStore(s => s.register);
  const submit = async () => {
    if (!path.trim()) return;
    setBusy(true);
    const problem = await register(path.trim());
    setBusy(false);
    setError(problem);
    if (!problem) onDone?.();
  };
  return (
    <form data-testid="graph-panel-register" className={`flex flex-col gap-1 ${compact ? '' : 'w-full max-w-sm'}`}
      onSubmit={e => { e.preventDefault(); void submit(); }}>
      <input data-testid="graph-panel-register-path" value={path} onChange={e => setPath(e.target.value)} autoFocus={compact}
        placeholder="Graph package folder (fiberbrowser-graph prepare)" spellCheck={false}
        className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
      <div className="flex justify-end gap-1">
        {onDone && <button type="button" className="rounded px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700" onClick={onDone}>Cancel</button>}
        <button type="submit" disabled={busy || !path.trim()} data-testid="graph-panel-register-submit"
          className="rounded bg-slate-700 px-2 py-0.5 text-[11px] text-white disabled:opacity-50">{busy ? 'Verifying…' : 'Register'}</button>
      </div>
      {error && <span data-testid="graph-panel-register-error" className="text-left text-[11px] text-red-600">{error}</span>}
    </form>
  );
}

interface QueryState {
  response: GraphSubgraphResponse | null;
  loading: boolean;
  error: GraphApiError | null;
  generation: number;
  /** A host's response: the complexity judgement key of the request it answers. */
  judgment?: string | null;
}

export function GraphPanel({ panelId, width: widthProp, height: heightProp }: AnalysisPanelProps) {
  const panel = useBrowserStore(s => (panelId ? s.panels.find(p => p.id === panelId) : undefined));
  const panels = useBrowserStore(s => s.panels);
  // The main view and its reference (registry id, else FASTA name): following needs the target's assembly.
  const main = useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end, reference: genomeKeyFor(null, s) })));
  const status = useGraphStatusStore(s => s.status);
  const statusError = useGraphStatusStore(s => s.error);
  const loadStatus = useGraphStatusStore(s => s.load);
  const renderVersion = useCanvasRenderVersion();
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Body size: what the host passes, else measured.
  const rootRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) setMeasured({ width: Math.round(r.width), height: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.max(120, Math.floor(widthProp ?? measured.width ?? 0) - 2);
  const bodyHeight = Math.max(60, Math.floor(heightProp ?? measured.height ?? 0));

  const rawState = panel?.graphView ?? null;
  const state = useMemo(() => (rawState ? withLayoutDefaults(rawState) : null), [rawState]);
  // Graph mode of a dataset panel (DESIGN_GRAPH_PRIMARY §1): the panel's own viewport is the only authority, its
  // members' reads are drawn in sub-bands with their own state; the standalone graph-view panel is unchanged.
  const hostMode = isHost(panel);
  const regs = status?.registrations ?? [];
  const reg: GraphRegistration | null = (state?.registrationId ? regs.find(r => r.id === state.registrationId) : null) ?? null;
  const problem = state ? restoreProblem(state, regs) : null;
  const target = reg && state?.targetBinding ? reg.bindings.find(b => b.key === state.targetBinding) ?? null : null;

  // A new panel takes the first registration once the status is known.
  useEffect(() => {
    if (!panelId || !status?.helper.available || state || panel?.contentType === 'dataset') return;
    if (!regs.length) return;
    setGraphView(panelId, initialGraphView(regs[0], main));
  }, [panelId, status, state, regs, main]);

  // Following a linear panel onto another contig: that contig's target in the same package, if it has one.
  useEffect(() => {
    if (!panelId || !state || !reg || problem || hostMode) return;   // a host retargets with its view (handoff.ts)
    const next = retargetFor(reg, state, initiatorView(state, panels, main));
    if (next) setGraphView(panelId, next);
  }, [panelId, state, reg, problem, panels, main]);
  // A host's view: its own viewport (the main view or its own), on its target's contig (else no graph here: the
  // hand-off draws it linear). The request is the helper's ≤ 50 kb; the panel's viewport is never clamped.
  const hostView = hostMode && panel ? panelView(panel, main) : null;
  const viewport = state && target && !problem
    ? (hostMode ? (hostView && canFollow(target, hostView) ? clampViewport({ contig: hostView.chrom, start: hostView.start, end: hostView.end }, target.size, target.size_inferred) : null)
      : effectiveViewport(state, target, panels, main))
    : null;
  // Following: remember where it is, so a closed (or switched) initiator leaves the panel where it was, on its own.
  const lastFollowed = useRef<GraphViewport | null>(null);
  const following = Boolean(!hostMode && state?.linkMode === 'follow' && target && canFollow(target, state ? initiatorView(state, panels, main) : null)
    && (!state?.initiatingReferenceId || state.initiatingReferenceId === initiatorView(state, panels, main)?.reference));
  if (following && viewport) lastFollowed.current = viewport;
  useEffect(() => {
    if (!panelId || !state || !status || state.linkMode !== 'follow' || following || problem || hostMode) return;
    if (reg && retargetFor(reg, state, initiatorView(state, panels, main))) return;   // another contig of the package: retargets
    // Not (or no longer) followable, also a restored state on another reference: on its own where it was.
    setGraphView(panelId, { ...state, linkMode: 'independent', targetViewport: lastFollowed.current ?? state.targetViewport,
      initiatingPanelId: null, initiatingReferenceId: null });
  }, [panelId, state, status, following, reg, problem, panels, main]);
  const reversed = Boolean(panel?.reversed);
  const transform = useMemo(() => (viewport ? makeTransform(viewport, GRAPH_GUTTER, width - GRAPH_GUTTER - 6, reversed) : null),
    [viewport?.start, viewport?.end, width, reversed]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- the topology request
  const [query, setQuery] = useState<QueryState>({ response: null, loading: false, error: null, generation: 0 });
  const generationRef = useRef(0);
  const inflightRef = useRef<{ id: string; controller: AbortController; trace: GraphTrace } | null>(null);
  const navigatedAtRef = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const requestKey = reg && state && viewport && target
    ? JSON.stringify([reg.id, reg.revisions.package, target.key, viewport.start, viewport.end, state.selectedPathKeys, state.layoutSettings.contextBp, reloadToken])
    : null;
  useEffect(() => {
    if (!requestKey || !reg || !state || !viewport || !target || !panelId) return;
    navigatedAtRef.current = performance.now();
    const timer = window.setTimeout(() => {
      const previous = inflightRef.current;
      if (previous) {
        previous.controller.abort();
        cancelSubgraph(previous.id);
        previous.trace.outcome = 'superseded';
      }
      const generation = ++generationRef.current;
      const requestId = `${panelId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(-48)}-g${generation}-${Math.random().toString(36).slice(2, 8)}`;
      const controller = new AbortController();
      const trace = startTrace(panelId, generation, { start: viewport.start, end: viewport.end }, navigatedAtRef.current);
      inflightRef.current = { id: requestId, controller, trace };
      setQuery(q => ({ ...q, loading: true, generation }));
      // What this request is (for the complexity judgement): its own identity, never a later one's (Codex G7 r2).
      const judgment = hostMode && hostView ? judgmentKey(state, hostView) : null;
      querySubgraph({
        registrationId: reg.id, revisions: reg.revisions, requestId, panelId, generation, target: target.key,
        interval: { start: viewport.start, end: viewport.end }, selected: state.selectedPathKeys,
        contextBp: state.layoutSettings.contextBp, flankBp: FLANK_BP,
      }, controller.signal).then(response => {
        if (generation !== generationRef.current) return;
        trace.respondedAt = performance.now();
        trace.server = response.timings;
        trace.cached = response.cached;
        inflightRef.current = null;
        setQuery({ response, loading: false, error: null, generation, judgment });
      }).catch(err => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        inflightRef.current = null;
        trace.outcome = 'error';
        const error: GraphApiError = err instanceof GraphRequestError ? err.error : { code: 'network', message: String(err?.message ?? err), retryable: true };
        trace.error = error.code;
        setQuery(q => ({ ...q, loading: false, error, generation }));
        // The helper refused the window as too complex: it is unresolved (the complexity hand-off, §7.2).
        if (judgment && error.code === 'complexity_limit') useGraphComplexity.getState().set(panelId, judgment, 1);
        // The package changed, went missing or is no longer registered: refresh the status, so the panel shows
        // the unavailable view (with its relink) instead of the last topology.
        if (onPackageError(error.code)) setQuery({ response: null, loading: false, error, generation });
      });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [requestKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving: the request still running loses its subscriber (the server kills a helper job nobody waits for).
  useEffect(() => () => {
    const previous = inflightRef.current;
    if (previous) { previous.controller.abort(); cancelSubgraph(previous.id); }
  }, []);

  const response = query.response;
  // The complexity hand-off (§7.2): a host's topology says how much of its window is unresolved (judged on the
  // topology, never on the scene's packing); the hand-off controller decides.
  useEffect(() => {
    if (!hostMode || !panelId || !hostView || !response || !viewport || !query.judgment) return;
    if (response.result.interval.start !== viewport.start || response.result.interval.end !== viewport.end) return;
    const fraction = unresolvedFraction(response.result);
    // Under the identity of the request it answers (a response superseded by a newer request is not the newer one's).
    useGraphComplexity.getState().set(panelId, query.judgment, fraction);
    if (window.__FIBERBROWSER_E2E_EXPOSE_STORE) (window.__FIBERBROWSER_GRAPH_COMPLEXITY__ ??= {})[panelId] = { view: viewKey(hostView), fraction };
  }, [response]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- reads (Gate E)
  // Which loaded datasets bind to this package's paths (explicit identities, checked by the server), and the
  // reads of the bound paths' source windows, requested once the topology says what those windows are.
  const readSettings = state?.reads ?? DEFAULT_READS;
  // (A dataset's settings change bumps refreshGeneration and its server revision: its bindings are read again.)
  // (A dataset's source identity moves when outputs computed for its records change its rows, nucleosome layers
  // included: its bindings, and their revisions, are read again.)
  const datasetKey = useBrowserStore(s => `${s.datasets.map(d => `${d.id}:${d.source_identity ?? ''}`).join(',')}|${s.refreshGeneration}`);
  // The server's datasets (from the tab heartbeat): one added there after this page opened (a script, another tab)
  // binds too.
  const serverDatasets = useServerDatasetsStore(s => s.key);
  const datasetLabels = useBrowserStore(useShallow(s => Object.fromEntries(s.datasets.map(d => [d.id, d.label ?? d.id]))));
  const [readBindings, setReadBindings] = useState<GraphReadBinding[]>([]);
  // Bumped when a reads request names a dataset revision the server no longer has: the bindings are read again.
  const [bindingsToken, setBindingsToken] = useState(0);
  useEffect(() => {
    if (!reg) { setReadBindings([]); return; }
    const controller = new AbortController();
    getReadBindings(reg.id, controller.signal).then(setReadBindings).catch(() => { if (!controller.signal.aborted) setReadBindings([]); });
    return () => controller.abort();
  }, [reg?.id, datasetKey, serverDatasets, bindingsToken]); // eslint-disable-line react-hooks/exhaustive-deps
  // A read binding saved with the view names its dataset revision (files and map): a dataset that changed since is
  // not drawn until it is chosen again in the Reads menu (restore never re-binds another revision silently).
  const changedBindings = useMemo(() => readBindings.filter(b => readSettings.bound?.some(x => x.dataset_id === b.dataset_id && x.revision !== b.revision)),
    [readBindings, readSettings.bound]);
  // A host draws its members' datasets (the members decide, not the Reads menu's dataset list).
  const members = useMemo(() => (hostMode && panel ? membersOf(panels, panel) : []), [hostMode, panel, panels]);
  const memberDatasetsKey = members.map(m => m.panel.datasetId).join(',');
  // (A host draws its members' current revisions: a member's dataset that changed is simply re-read.)
  const activeBindings = useMemo(() => (readSettings.show ? readBindings.filter(b => Object.keys(b.paths).length
    && (hostMode || !changedBindings.includes(b))
    && (hostMode ? memberDatasetsKey.split(',').includes(b.dataset_id)
      : (readSettings.datasets == null || readSettings.datasets.includes(b.dataset_id)))) : []), [readBindings, readSettings, changedBindings, hostMode, memberDatasetsKey]);
  const [reads, setReads] = useState<{ response: GraphReadsResponse | null; loading: boolean; error: GraphApiError | null; forStart?: number; key?: string }>({ response: null, loading: false, error: null });
  const readsGenRef = useRef(0);
  const readsInflightRef = useRef<AbortController | null>(null);
  const readPaths = response && activeBindings.length
    ? response.result.paths.filter(p => activeBindings.some(b => p.binding in b.paths) && p.windows.length)
      .map(p => ({ binding: p.binding, windows: p.windows }))
    : [];
  // A host's members' id scopes, selections and highlights are kept in the server's sample (pins), so a read a
  // member keeps or selects in its linear view is drawn here too, never sampled out first (G3).
  const filteredForPins = useBrowserStore(s => s.filteredReadIds);
  const selectedForPins = useBrowserStore(s => s.selectedReadIds);
  const pinnedGlobal = useReadActionsStore(s => s.pinnedReadIds);
  const highlightForPins = useReadActionsStore(s => s.highlight);
  const branchForPins = useBrowserStore(s => (s.activeClusterTreeNodeId ? s.clusterTreeNodes[s.activeClusterTreeNodeId] : null));
  const focusForPins = useBrowserStore(s => s.clusterFocus);
  const assignmentsForPins = useBrowserStore(s => s.clusterAssignments);
  const pins = useMemo(() => {
    if (!hostMode) return [] as string[];
    return graphPins(members.map(m => panelKeyOf(m.panel)), { filtered: filteredForPins, selected: selectedForPins,
      focus: focusForPins, assignments: assignmentsForPins, branch: branchForPins, highlight: highlightForPins?.ids ?? null,
      pinned: pinnedGlobal }, MAX_GRAPH_PINS);
  }, [hostMode, members, selectedForPins, filteredForPins, pinnedGlobal, highlightForPins, branchForPins, focusForPins, assignmentsForPins]);
  const pinsKey = pins.join('\u0000');
  // A dataset's source identity moves when outputs computed for its records (nucleosome layers) change its composed
  // rows, while its binding revision (files and map) stays: the reads are requested again.
  const sourceIdentities = useBrowserStore(useShallow(s => Object.fromEntries(s.datasets.map(d => [d.id, d.source_identity ?? '']))));
  const readsKey = reg && response && readPaths.length
    ? JSON.stringify([reg.id, reg.revisions.package, readPaths, activeBindings.map(b => [b.dataset_id, b.revision, sourceIdentities[b.dataset_id] ?? '']), pinsKey])
    : null;
  useEffect(() => {
    if (!readsKey || !reg || !panelId) { if (!readsKey) setReads(r => (r.response || r.loading ? { response: null, loading: false, error: null } : r)); return; }
    const timer = window.setTimeout(() => {
      readsInflightRef.current?.abort();
      const controller = new AbortController();
      readsInflightRef.current = controller;
      const generation = ++readsGenRef.current;
      const forStart = response?.result.interval.start;
      const key = readsKey;
      setReads(r => ({ ...r, loading: true }));
      queryReads({ registrationId: reg.id, revisions: reg.revisions, panelId, generation,
        requestId: `${panelId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(-40)}-r${generation}`,
        datasets: activeBindings.map(b => ({ dataset_id: b.dataset_id, revision: b.revision })), paths: readPaths,
        ...(pins.length ? { pins } : {}) }, controller.signal)
        .then(out => { if (generation === readsGenRef.current) setReads({ response: out, loading: false, error: null, forStart, key }); })
        .catch(err => {
          if (controller.signal.aborted || generation !== readsGenRef.current) return;
          const error: GraphApiError = err instanceof GraphRequestError ? err.error : { code: 'network', message: String(err?.message ?? err), retryable: true };
          // A failed load leaves no reads of another window on screen.
          setReads({ response: null, loading: false, error });
          // A dataset revision the server no longer has: read the bindings again. The package itself changed or
          // went missing: the status, so the panel shows it unavailable (shared with every graph route).
          if (error.code === 'unknown_dataset' || error.code === 'stale_dataset_revision') setBindingsToken(n => n + 1);
          if (onPackageError(error.code)) setQuery(q => ({ ...q, response: null }));
        });
    }, READS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [readsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => readsInflightRef.current?.abort(), []);
  // Remember which dataset revisions this view drew (saved with it; a restore checks them first).
  useEffect(() => {
    if (!panelId || !state || !reads.response || reads.key !== readsKey) return;
    const have = state.reads?.bound ?? [];
    const add = activeBindings.filter(b => !have.some(x => x.dataset_id === b.dataset_id && x.revision === b.revision));
    if (!add.length) return;
    const bound = [...have.filter(x => !add.some(b => b.dataset_id === x.dataset_id)), ...add.map(b => ({ dataset_id: b.dataset_id, revision: b.revision }))];
    setGraphView(panelId, { ...state, reads: { ...(state.reads ?? DEFAULT_READS), bound } });
  }, [reads.response]); // eslint-disable-line react-hooks/exhaustive-deps
  // The toolbar's Layers row (the read tracks' own toggles) decides what the read bands draw; the panel's Reads
  // menu can only hide more. Toggling a layer redraws from the loaded reads, no refetch.
  const enabledModTypes = useBrowserStore(s => s.enabledModTypes) as Record<string, boolean | undefined>;
  const globalLayers = useMemo(() => effectiveReadLayers(enabledModTypes), [enabledModTypes]);
  // Soft clips follow the read tracks' SV display toggle and minimum length (graph features).
  const svDisplayEnabled = useBrowserStore(s => s.svDisplayEnabled);
  const svMinLen = useBrowserStore(s => s.svMinLen);
  const readLayers: ReadLayers = useMemo(() => ({ ...effectiveReadLayers(enabledModTypes, readSettings.layers),
    clipsMinLen: svDisplayEnabled ? svMinLen : null }), [enabledModTypes, readSettings.layers, svDisplayEnabled, svMinLen]);
  const readRowHeight = readSettings.rowHeight ?? READ_ROW_HEIGHT;
  const rowsPerLane = readSettings.maxRowsPerLane ?? DEFAULT_ROWS_PER_LANE;
  // A host fills its body height with rows by default (§6.1); a set row count (or a standalone panel) keeps it.
  const fillHeight = hostMode && readSettings.maxRowsPerLane == null;
  // What fill height depends on (only then: a panel with a set row count is not re-packed when its body resizes).
  const activeDatasetIds = useMemo(() => new Set(activeBindings.map(b => b.dataset_id)), [activeBindings]);
  // The reads this panel draws and its bindings, for the shared molecule hover and "Show source span".
  // Only datasets with reads on a path this panel shows count as drawn here.
  const drawnIdsKey = activeBindings.filter(b => Object.keys(b.paths).some(k => state?.selectedPathKeys.includes(k)))
    .map(b => b.dataset_id).sort().join(',');
  const anyDrawn = Boolean(reads.response);
  useEffect(() => {
    if (!panelId) return;
    useGraphReadsStore.getState().publish(panelId, anyDrawn ? (drawnIdsKey ? drawnIdsKey.split(',') : []) : [], readBindings, reg?.id ?? null);
  }, [panelId, drawnIdsKey, anyDrawn, readBindings, reg?.id]);
  // The folded molecules it drew, on their primary record's path's haplotype (the one a lifted pop-out shows them on),
  // so a grouping or pop-out routes their labels there (graph follow-ups item 5).
  useEffect(() => {
    if (!panelId) return;
    useGraphReadsStore.getState().publishRowHaps(panelId, (reads.response?.reads ?? [])
      .filter(r => r.rk && r.hap && !r.sup && isMoleculeRecordKey(r.rk))
      .map(r => ({ rk: r.rk!, datasetId: r.d, hap: r.hap!, ...(r.ds ? { strand: r.ds } : {}) })));
  }, [panelId, reads.response]);
  useEffect(() => () => { if (panelId) { useGraphReadsStore.getState().clear(panelId); useLiftHover.getState().clear(panelId); } }, [panelId]);
  // The molecule hovered here or in a lifted / source / native panel of the same files (moleculeKey: dataset,
  // library, QNAME): its rows are outlined in every view.
  const hoverKey = useLiftHover(s => s.hover?.key ?? null);
  const colormap = useBrowserStore(s => s.activeColormap);
  const style = useMemo(() => chromatinStyle(colormap), [colormap]);

  const compression: Compression = state?.layoutSettings.compression ?? 'log';
  // Insertions a plain click expanded: drawn at true bp inside the schematic view (by layout group ID).
  const expandedKey = (state?.layoutSettings.expanded ?? []).join(',');
  const expanded = useMemo(() => new Set(expandedKey ? expandedKey.split(',') : []), [expandedKey]);
  const smallMode = state?.layoutSettings.smallDifferences ?? 'marks';
  const drawnSpan = response ? response.result.interval.end - response.result.interval.start : 0;
  const smallBp = smallDifferenceBp(drawnSpan, width - GRAPH_GUTTER - GRAPH_RIGHT_PAD, smallMode);
  const layoutMsRef = useRef(0);
  // The joint layout model: once per response (its identities depend only on the response).
  const model = useMemo(() => {
    if (!response || !reg) return null;
    const t0 = performance.now();
    const m = buildLayout(response.result, reg.bindings);
    layoutMsRef.current = performance.now() - t0;
    return m;
  }, [response, reg]);
  // The scene's plan (marks, clusters, scale, which lanes draw something of their own): per width and settings.
  const plan = useMemo(() => {
    if (!model) return null;
    const t0 = performance.now();
    const out = planScene(model, { width, gutter: GRAPH_GUTTER, rightPad: GRAPH_RIGHT_PAD, compression, smallBp, expanded });
    layoutMsRef.current += performance.now() - t0;
    return out;
  }, [model, width, compression, smallBp, expanded]);
  // Lanes grow with the panel body (28–40 px): thicker tubes when there is room, the saved height a minimum. A lane
  // with nothing of its own drawn (its differences all marks on the shared tube) is a compact label row.
  const minLane = state?.layoutSettings.laneHeight ?? GRAPH_LANE_HEIGHT;
  const rowsWanted = Math.max(1, response?.result.paths.length ?? state?.selectedPathKeys.length ?? 1);
  const fullRows = plan && model ? Math.max(1, model.rows.filter(r => plan.drawnLanes.has(r.key)).length) : rowsWanted;
  const compactRows = rowsWanted - fullRows;
  const compactSpace = compactRows * (COMPACT_LANE_PX + GRAPH_LANE_GAP);
  // With reads the lanes keep their natural thickness: the body's extra height goes to the read bands.
  const laneHeight = activeBindings.length ? Math.max(minLane, NATURAL_LANE - 4)
    : Math.max(minLane, Math.min(40, Math.floor((bodyHeight - GRAPH_RULER_HEIGHT - STATUS_HEIGHT - 12 - compactSpace) / fullRows) - GRAPH_LANE_GAP));
  // Its scene: per plan, lane height and reversal.
  const laneColors = useMemo(() => {
    const colors: Record<string, string> = {};
    for (const r of model?.rows ?? []) colors[r.key] = laneColor(r);
    return colors;
  }, [model]);
  const baseScene = useMemo(() => {
    if (!model || !plan) return null;
    const t0 = performance.now();
    const out = buildScene(model, { width, gutter: GRAPH_GUTTER, rightPad: GRAPH_RIGHT_PAD, rulerHeight: GRAPH_RULER_HEIGHT,
      laneHeight, laneGap: GRAPH_LANE_GAP, compression, reversed, colors: laneColors, smallBp, plan, expanded });
    layoutMsRef.current += performance.now() - t0;
    return out;
  }, [model, plan, width, laneHeight, compression, reversed, smallBp, laneColors, expanded]);
  // Molecules along the walk (their x is the scene's occurrence transforms; bands only add height under lanes).
  // Reads are drawn for the window they were loaded for; while the next window's load is in flight the last ones
  // stay, dimmed (they are placed by source coordinate, so where they show they are right; the new edges fill in).
  const readsStale = Boolean(reads.response && reads.key !== readsKey);
  const readsShown = reads.response && (!readsStale || reads.loading) ? reads.response : null;
  // Host mode: one sub-band per member under each path it binds, each with its own member's state (G3).
  const datasetColors = useBrowserStore(useShallow(s => Object.fromEntries(s.datasets.map(d => [d.id, d.color ?? '#4b5563']))));
  const bandMembers: BandMember[] = useMemo(() => {
    if (!hostMode) return [];
    const multi = new Set(members.map(m => m.panel.datasetId)).size > 1;
    return members.filter(m => m.panel.datasetId).map(({ member, panel: p }) => {
      const ds = datasetLabels[p.datasetId!] ?? p.datasetId!;
      const hap = p.liftHap ?? null;
      // One haplotype (G8): its path's PanSN name, as split members show MAT / PAT (graph follow-ups item 7).
      const one = hap ? null : singleHapPathName(graphBindingFor(p.datasetId), null, state?.targetBinding ?? null);
      const name = p.title || (hap ? (multi ? `${ds} · ${hap}` : hap) : one ? (multi ? `${ds} · ${one}` : one) : ds);
      // Rows route by dataset and haplotype (a lifted member) or dataset (native, on the target): the saved path key
      // is the member's path at the host's target, which a pan onto another contig changes.
      void member;
      // A pooled member leaves the haplotypes its dataset's haplotype members show to them (a popped-out
      // haplotype of a pooled host is not drawn twice on its lane; agy G8 review).
      const excludeHaps = hap ? [] : members.filter(x => x.panel.id !== p.id && x.panel.datasetId === p.datasetId && x.panel.liftHap)
        .map(x => x.panel.liftHap!.toUpperCase());
      return { panelId: p.id, stateKey: panelKeyOf(p), datasetId: p.datasetId!, liftHap: hap, binding: null, excludeHaps,
        strand: p.strand === 'CT' || p.strand === 'GA' ? p.strand : null,
        label: p.strand === 'CT' || p.strand === 'GA' ? `${name} · ${p.strand}` : name, color: datasetColors[p.datasetId!] ?? '#4b5563' };
    });
  }, [hostMode, members, datasetLabels, datasetColors, state?.targetBinding]);
  const clusterAssignmentsAll = useBrowserStore(s => s.clusterAssignments);
  const clusterOrderAll = useBrowserStore(s => s.clusterOrder);
  const clusterFocusAll = useBrowserStore(s => s.clusterFocus);
  const filteredAll = useBrowserStore(s => s.filteredReadIds);
  const sortAll = useBrowserStore(s => s.readSortOrder);
  const selectedAll = useBrowserStore(s => s.selectedReadIds);
  const excludedAll = useReadActionsStore(s => s.excludedReadIds);
  const highlight = useReadActionsStore(s => s.highlight);
  // An active child cluster branch scopes its panels' reads to the branch (as the read track does).
  const activeBranch = useBrowserStore(s => (s.activeClusterTreeNodeId ? s.clusterTreeNodes[s.activeClusterTreeNodeId] : null));
  const memberStates = useMemo(() => {
    const out: Record<string, MemberState> = {};
    for (const m of bandMembers) {
      const assignments = clusterAssignmentsAll[m.stateKey];
      const branch = branchScopesPanel(activeBranch, m.stateKey);
      out[m.panelId] = { assignments, clusterOrder: clusterOrderAll[m.stateKey],
        focus: clusterFocusAll[m.stateKey], filter: filteredAll[m.stateKey] ?? null, sort: sortAll[m.stateKey],
        excluded: excludedAll[m.stateKey],
        branchScope: branch ? readIdSetForClusterRenderScope(assignments, clusterFocusAll[m.stateKey], true) : null };
    }
    return out;
  }, [bandMembers, clusterAssignmentsAll, clusterOrderAll, clusterFocusAll, filteredAll, sortAll, excludedAll, activeBranch]);
  const bandSort = state?.bandSort ?? 'position';
  const fillKey = fillHeight ? `${bodyHeight}|${readRowHeight}|${laneHeight}|${compactSpace}|${fullRows}` : '';
  const readLayout = useMemo(() => {
    if (!baseScene || !response || !readsShown) return null;
    const t0 = performance.now();
    const index = placementIndex(baseScene, response.result, FLANK_BP);
    const span = response.result.interval.end - response.result.interval.start;
    const placed = placeReads(readsShown.reads.filter(r => activeDatasetIds.has(r.d)), index, MAX_READ_PRIMITIVES,
      span / Math.max(1, baseScene.dataWidth));
    let lanes: Map<string, PackedLane | HostLane>;
    let strips = new Map<string, PlacedBin[]>();
    if (hostMode) {
      // Each sub-band's rows: what it needs, or its share of the body height (fill height); a band that draws fewer
      // rows than it has molecules (sampled, capped or past its rows) gets a density strip above them (§6.2 L2).
      const bandsBy = new Map<string, GraphBandReport>((readsShown.report.bands ?? []).map(b => [stripKey(b.dataset_id, b.binding), b]));
      const dsOf = new Map(bandMembers.map(m => [m.panelId, m.datasetId]));
      const sampled = (lane: string, member: string) => bandSampled(bandsBy.get(stripKey(dsOf.get(member) ?? '', lane)));
      // Sort by position: each record's first carried graph column in canonical walk order (§3.2), not its pixels.
      const columns = bandSort === 'position' ? firstCarriedColumns(placed.molecules.map(m => m.read), response.result, reg?.bindings.map(b => b.key)) : null;
      const columnOf = columns ? (m: PlacedMolecule) => columns.get(m.read.k) : undefined;
      const first = packMemberBands(placed.molecules, bandMembers, memberStates, 1_000_000, bandSort, 3, undefined, columnOf);
      const groups = [...first].flatMap(([lane, l]) => l.groups.map(g => ({ lane, member: g.memberId, need: g.rowCount })));
      const key = (lane: string, member: string) => `${lane}\u0000${member}`;
      const rowsOf = new Map<string, number>(), stripOf = new Map<string, number>();
      let alloc = groups.map(g => (fillHeight ? g.need : Math.min(g.need, rowsPerLane)));
      if (fillHeight) {
        const lanesWithBands = new Set(groups.map(g => g.lane)).size;
        const fixed = GRAPH_RULER_HEIGHT + STATUS_HEIGHT + 12 + compactSpace + fullRows * (laneHeight + GRAPH_LANE_GAP)
          + lanesWithBands * (GRAPH_LANE_GAP + READ_ROW_GAP);
        const total = Math.floor(Math.max(0, bodyHeight - fixed) / (readRowHeight + READ_ROW_GAP));
        alloc = allocateRows(groups.map(g => g.need + (sampled(g.lane, g.member) ? STRIP_ROWS : 0)), total, 3);
      }
      groups.forEach((g, i) => {
        const strip = sampled(g.lane, g.member) || alloc[i] < g.need ? STRIP_ROWS : 0;
        stripOf.set(key(g.lane, g.member), strip);
        // The strip's rows come out of the band's share (fill height) or on top of a set row count.
        rowsOf.set(key(g.lane, g.member), fillHeight ? Math.max(strip + 3, alloc[i]) : Math.min(g.need, rowsPerLane) + strip);
      });
      lanes = packMemberBands(placed.molecules, bandMembers, memberStates, (l, m) => rowsOf.get(key(l, m)) ?? rowsPerLane, bandSort, 3,
        (l, m) => stripOf.get(key(l, m)) ?? 0, columnOf);
      strips = placeStrips(readsShown, index);
    } else {
      lanes = packMolecules(placed.molecules, rowsPerLane);
    }
    return { placed, lanes, strips, ms: performance.now() - t0 };
  }, [baseScene, response, readsShown, activeDatasetIds, rowsPerLane, hostMode, bandMembers, memberStates, bandSort, fillKey, reg]); // eslint-disable-line react-hooks/exhaustive-deps
  // The rows each member shows here ("Reads shown" scopes, exports): the host and its folded members (a revealed
  // member's own read track publishes its rows).
  useEffect(() => {
    if (!hostMode || readsStale) return;
    // No reads drawn (off, failed, nothing bound): nothing is shown here, so the lists empty.
    const byMember = new Map<string, Set<string>>();
    if (readLayout) {
    for (const lane of readLayout.lanes.values()) {
      const l = lane as HostLane;
      l.rows.forEach((row, i) => { const id = l.rowMember?.[i]; if (!id) return; const set = byMember.get(id) ?? byMember.set(id, new Set()).get(id)!; for (const m of row) set.add(m.read.aid ?? m.read.q); });
    }
    }
    const store = useBrowserStore.getState();
    for (const m of bandMembers) {
      const p = panels.find(x => x.id === m.panelId);
      if (!p || (p.id !== panelId && !p.collapsedByGraphGroup)) continue;
      const ids = [...(byMember.get(m.panelId) ?? [])];
      const prev = store.activeReadIds[m.stateKey];
      if ((!prev && ids.length) || (prev && (prev.length !== ids.length || prev.some((x, i) => x !== ids[i])))) store.setActiveReadIds(m.stateKey, ids);
    }
  }, [hostMode, readLayout, readsStale, bandMembers]); // eslint-disable-line react-hooks/exhaustive-deps
  // Selected (each member's QNAME set) and highlighted ("Highlight in all panels": QNAME, cohort id or record key).
  const decoration: ReadDecoration | undefined = useMemo(() => {
    if (!hostMode || !readLayout) return undefined;
    const keyOf = new Map(bandMembers.map(m => [m.panelId, m.stateKey]));
    const lane = (k: string) => readLayout.lanes.get(k) as HostLane | undefined;
    return {
      rowMember: (k, r) => lane(k)?.rowMember?.[r],
      rowCluster: (k, r) => lane(k)?.rowCluster?.[r] ?? null,
      selected: (member, m) => Boolean(member && selectedAll[keyOf.get(member) ?? '']?.has(m.read.q)),
      // A scoped highlight (difference carriers) names exact rows per dataset; otherwise every row of the names.
      highlighted: m => {
        if (!highlight) return false;
        if (highlight.scopedRows) { const rows = highlight.scopedRows[m.read.d]; return Boolean(rows && idSetHas(rows, [m.read.aid ?? m.read.q], m.read.rk)); }
        return Boolean(highlight.ids.size && idSetHas(highlight.ids, [m.read.q, m.read.aid], m.read.rk));
      },
    };
  }, [hostMode, readLayout, bandMembers, selectedAll, highlight]);
  const bands = useMemo(() => {
    if (!readLayout) return null;
    const out: Record<string, number> = {};
    for (const [k, lane] of readLayout.lanes) out[k] = bandHeight(lane, readRowHeight, READ_ROW_GAP);
    return out;
  }, [readLayout, readRowHeight]);
  const scene = useMemo(() => {
    if (!baseScene || !bands || !Object.values(bands).some(Boolean) || !model || !plan) return baseScene;
    return buildScene(model, { width, gutter: GRAPH_GUTTER, rightPad: GRAPH_RIGHT_PAD, rulerHeight: GRAPH_RULER_HEIGHT,
      laneHeight, laneGap: GRAPH_LANE_GAP, compression, reversed, colors: laneColors, smallBp, plan, bands, expanded });
  }, [baseScene, bands]); // eslint-disable-line react-hooks/exhaustive-deps
  const readHitsRef = useRef<ReadHit[]>([]);
  const readDrawMsRef = useRef(0);
  const readDrawStatsRef = useRef<ReadDrawStats>(emptyDrawStats());
  const hoveredRowsRef = useRef(0);
  const stripsDrawnRef = useRef(0);
  // Its natural body height (full lanes of NATURAL_LANE px, compact rows, the ruler and the status line): stacked
  // with other panels it takes this, not an equal share of the column (plugin sizeToContent). It only grows for one
  // selection of paths, so panning never makes the panels below jump back and forth.
  const bandSpace = bands ? Object.values(bands).reduce((t, h) => t + (h ? h + GRAPH_LANE_GAP : 0), 0) : 0;
  const natural = GRAPH_RULER_HEIGHT + STATUS_HEIGHT + 12 + compactSpace + bandSpace + fullRows * (Math.max(minLane, NATURAL_LANE) + GRAPH_LANE_GAP);
  // Before the first plan of a selection the estimate (every lane full) is provisional: the first plan sets it.
  const naturalRef = useRef<{ key: string; height: number; planned: boolean }>({ key: '', height: 0, planned: false });
  const selectionKey = (state?.selectedPathKeys ?? []).join(',');
  // A plan counts for this selection only once its response is this selection's (not the previous one's).
  const planned = Boolean(plan) && (response?.result.paths.map(p => p.binding).join(',') ?? '') === selectionKey;
  if (naturalRef.current.key !== selectionKey || (planned && !naturalRef.current.planned)) naturalRef.current = { key: selectionKey, height: natural, planned };
  else if (natural > naturalRef.current.height) naturalRef.current = { ...naturalRef.current, height: natural };
  const naturalHeight = naturalRef.current.height;
  useEffect(() => {
    if (!panelId) return;
    usePanelContentHeightStore.getState().report(panelId, naturalHeight);
  }, [panelId, naturalHeight]);
  useEffect(() => () => { if (panelId) usePanelContentHeightStore.getState().report(panelId, null); }, [panelId]);
  // Mark layout on the trace of the response it came from.
  const lastTraceRef = useRef<GraphTrace | null>(null);
  useEffect(() => {
    if (!response) return;
    const trace = (window.__FIBERBROWSER_GRAPH_TRACES__ ?? []).find(t => t.panelId === panelId && t.generation === query.generation) ?? null;
    if (trace && trace.laidOutAt === undefined) { trace.laidOutAt = performance.now(); trace.layoutMs = layoutMsRef.current; }
    lastTraceRef.current = trace;
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  const laneLabelOf = (key: string) => model?.rows.find(r => r.key === key)?.label ?? key;

  // ---------------------------------------------------------------- drawing
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const graphRun = useBrowserStore(s => s.clusterMatchedRun);
  // Region drawing (Alt/Option-drag, below): its start and the span drawn so far.
  const regionDraw = useRef<{ t0: number; x0: number } | null>(null);
  const [regionPreview, setRegionPreview] = useState<{ x0: number; x1: number } | null>(null);

  const outlines = useMemo(() => (hostMode ? runOutlines(graphRun, scene ?? null, state?.registrationId ?? null,
    state?.targetBinding ?? null, reversed) : []), [hostMode, graphRun, scene, state?.registrationId, state?.targetBinding, reversed]);
  const laneCount = model?.rows.length ?? state?.selectedPathKeys.length ?? 0;
  const canvasHeight = scene?.height ?? laneTop(laneCount, laneHeight) + GRAPH_LANE_GAP;
  // While a pan's new response is on its way, the last scene slides with the viewport (its average scale).
  const drawn = response?.result.interval ?? null;
  const sceneOffset = scene && viewport && drawn && transform
    ? (reversed ? -1 : 1) * (drawn.start - viewport.start) * bpScale(transform) : 0;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !transform || !viewport) return;
    const ctx = setupHighDpiCanvas(canvas, width, canvasHeight, { coordinates: 'screen' });
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, canvasHeight);
    if (scene && model) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(GRAPH_GUTTER - 1, 0, width - GRAPH_GUTTER - GRAPH_RIGHT_PAD + 2, canvasHeight);
      ctx.clip();
      ctx.translate(sceneOffset, 0);
      drawScene(ctx, scene);
      // A graph run's regions (host mode): outlined across the lanes, carrier-only parts on their carriers' lanes.
      drawRunOutlines(ctx, outlines);
      if (regionPreview) {
        ctx.save();
        ctx.fillStyle = 'rgba(37, 99, 235, 0.12)';
        const a = Math.min(regionPreview.x0, regionPreview.x1) - sceneOffset, b = Math.max(regionPreview.x0, regionPreview.x1) - sceneOffset;
        ctx.fillRect(a, 0, Math.max(1, b - a), canvasHeight);
        ctx.restore();
      }
      const tr = performance.now();
      const drawStats = emptyDrawStats();
      readHitsRef.current = readLayout ? drawReads(ctx, scene, readLayout.lanes, style, readLayers, laneColors, readRowHeight, READ_ROW_GAP,
        readsStale ? 0.45 : 1, drawStats, decoration) : [];
      if (readLayout && hostMode && readLayout.strips.size) {
        const dsOf = new Map(bandMembers.map(m => [m.panelId, m.datasetId]));
        const bandsBy = new Map<string, GraphBandReport>((readsShown?.report.bands ?? []).map(b => [stripKey(b.dataset_id, b.binding), b]));
        stripsDrawnRef.current = drawDensityStrips(ctx, scene, readLayout.lanes as Map<string, HostLane>, readLayout.strips, id => dsOf.get(id), bandsBy,
          style, readRowHeight, READ_ROW_GAP, readsStale ? 0.45 : 1, sceneOffset);
      } else stripsDrawnRef.current = 0;
      readDrawStatsRef.current = drawStats;
      let hoveredRows = 0;
      if (hoverKey) {
        ctx.save();
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.5;
        for (const h of readHitsRef.current) {
          const r = h.molecule.read;
          if (moleculeKey(r.d, r.lib, r.q) !== hoverKey) continue;
          hoveredRows++;
          ctx.strokeRect(h.x0 - 1, h.y0 + 0.5, h.x1 - h.x0 + 2, h.y1 - h.y0 - 1);
        }
        ctx.restore();
      }
      hoveredRowsRef.current = hoveredRows;
      readDrawMsRef.current = performance.now() - tr;
      ctx.restore();
      // The read bands' compact labels stay in the gutter.
      if (readLayout) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, GRAPH_RULER_HEIGHT, GRAPH_GUTTER - 2, canvasHeight);
        ctx.clip();
        if (hostMode) drawHostBandLabels(ctx, scene, readLayout.lanes as Map<string, HostLane>, readRowHeight, READ_ROW_GAP);
        else drawReadBandLabels(ctx, scene, readLayout.lanes, laneColors);
        ctx.restore();
      }
      // Gutter labels stay put.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, GRAPH_RULER_HEIGHT, GRAPH_GUTTER - 2, canvasHeight);
      ctx.clip();
      drawScene(ctx, { ...scene, prims: [] });
      ctx.restore();
      const shifted = sceneOffset ? { ...scene, targetMap: scene.targetMap.map(m => ({ ...m, x0: m.x0 + sceneOffset, x1: m.x1 + sceneOffset })) } : scene;
      drawRuler(ctx, shifted, viewport, width, reversed);
      if (window.__FIBERBROWSER_E2E_EXPOSE_STORE && panelId) {
        (window.__FIBERBROWSER_GRAPH_SCENES__ ??= {})[panelId] = { scene, model, offset: sceneOffset,
          ...(readLayout ? { reads: { molecules: readLayout.placed.molecules, hits: readHitsRef.current,
            placeMs: readLayout.ms, drawMs: readDrawMsRef.current, serverMs: reads.response?.timings.total_ms, drawn: readDrawStatsRef.current, layers: readLayers, hovered: hoveredRowsRef.current, hoverKey,
            lanes: Object.fromEntries([...readLayout.lanes].map(([k, l]) => [k, { rows: l.rows.length, hidden: l.hidden,
              ...((l as HostLane).groups ? { groups: (l as HostLane).groups.map(g => ({ member: g.memberId, label: g.label, rows: g.rowCount, reads: g.reads, order: g.order,
                hidden: g.hidden, strip: g.stripRows ?? 0 })) } : {}) }])), strips: stripsDrawnRef.current, report: reads.response?.report } } : {}) };
      }
    } else {
      drawRuler(ctx, null, viewport, width, reversed);
    }
    const trace = lastTraceRef.current;
    if (trace && trace.paintedAt === undefined && scene) {
      requestAnimationFrame(() => {
        if (trace.paintedAt === undefined) { trace.paintedAt = performance.now(); trace.outcome = trace.outcome ?? 'painted'; }
      });
    }
  }, [scene, transform, width, canvasHeight, renderVersion, sceneOffset, readLayout, style, readSettings, readsStale, readLayers, hoverKey, decoration, outlines, regionPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- navigation
  const commitViewport = useCallback((next: GraphViewport, detach = false, linearAtStart?: LinearView | null) => {
    if (!panelId || !state || !target) return;
    bumpNavigation(panelId);   // any correction computed before this move is stale now
    if (hostMode) {
      // The host's own viewport, through the ordinary panel navigation (never a detached graph viewport).
      const store = useBrowserStore.getState();
      const own = store.panels.find(p => p.id === panelId);
      // Its own view: the ordinary panel navigation (site-locked pop-outs move with it; pans coalesce into one step).
      if (own?.viewportOverride && own.viewportOverride.chrom === next.contig) {
        // (Its members in step with it move with it: handoff.ts, the same in both rendering modes.)
        store.setPanelViewport(panelId, next.start, next.end);
      }
      else if (own?.viewportOverride) store.navigatePanelOwnView(panelId, next.contig, next.start, next.end);
      else store.setViewport(next.contig, next.start, next.end);
      return;
    }
    if (state.linkMode === 'follow' && following && !detach) {
      // Following: the graph moves its initiating panel (in that panel's own frame) by the same bp, keeping that
      // panel's width, and follows it back. A drag measures from where the initiator was when it began, so moves
      // arriving before a re-render do not add up.
      const linear = linearAtStart ?? initiatorView(state, useBrowserStore.getState().panels, main);
      const base = linearAtStart ? (drag.current?.view ?? viewport) : viewport;
      if (!linear || !base) return;
      const width = linear.end - linear.start;
      const start = Math.max(0, linear.start + (next.start - base.start));
      const store = useBrowserStore.getState();
      if (state.initiatingPanelId == null) store.setViewport(linear.chrom, start, start + width);
      else store.navigatePanelOwnView(state.initiatingPanelId, linear.chrom, start, start + width);
      return;
    }
    setGraphView(panelId, { ...state, linkMode: 'independent', targetViewport: next, initiatingPanelId: null, initiatingReferenceId: null });
  }, [panelId, state, target, main, viewport, following, hostMode]);

  const drag = useRef<{ x: number; view: GraphViewport; moved: boolean; linear: LinearView | null } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; text: string; cursorX: number | null } | null>(null);
  // Region drawing (graph primary G2, DESIGN_GRAPH_PRIMARY §2.5): Alt/Option-drag on a host's graph draws a target
  // span; it becomes a selected peak (the custom peak rule), so Cluster runs on it in graph columns and in linear
  // panels alike.
  const targetAt = (clientX: number, el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const x = (clientX - rect.left) / zoom;
    const t = scene ? targetAtX(scene.targetMap, x - sceneOffset) : null;
    return t ? { x, t: t.pos } : null;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !viewport) return;
    (e.target as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
    if (hostMode && e.altKey) {
      const at = targetAt(e.clientX, e.target as HTMLCanvasElement);
      if (at) { regionDraw.current = { t0: at.t, x0: at.x }; setRegionPreview({ x0: at.x, x1: at.x }); return; }
    }
    drag.current = { x: e.clientX, view: hostMode && hostView ? { contig: hostView.chrom, start: hostView.start, end: hostView.end } : viewport, moved: false,
      linear: state ? initiatorView(state, useBrowserStore.getState().panels, main) : null };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const x = (e.clientX - rect.left) / zoom, y = (e.clientY - rect.top) / zoom;
    if (regionDraw.current) {
      setRegionPreview({ x0: regionDraw.current.x0, x1: x });
      return;
    }
    if (drag.current && transform && target) {
      const dx = (e.clientX - drag.current.x) / zoom;
      if (Math.abs(dx) > 2) drag.current.moved = true;
      if (drag.current.moved) {
        const deltaBp = (reversed ? dx : -dx) / bpScale(transform);
        commitViewport(hostMode ? hostPan(drag.current.view, deltaBp, target.size, target.size_inferred)
          : panViewport(drag.current.view, deltaBp, target.size, target.size_inferred), false, drag.current.linear);
      }
      return;
    }
    if (!transform) return;
    const inData = x >= transform.left && x <= transform.left + transform.width;
    if (!scene || !model || !inData || y < 0 || y > canvasHeight) { setCursor(null); if (panelId) useLiftHover.getState().clear(panelId); return; }
    const sx = x - sceneOffset;
    const readHit = readHitsRef.current.find(h => sx >= h.x0 && sx <= h.x1 && y >= h.y0 && y <= h.y1);
    if (readHit && panelId) {
      const r = readHit.molecule.read;
      useLiftHover.getState().set({ key: moleculeKey(r.d, r.lib, r.q), datasetId: r.d, panelId,
        source: { chrom: r.c, start: r.s, end: r.e } });
    } else if (panelId) useLiftHover.getState().clear(panelId);
    if (readHit) {
      setCursor({ x, y, text: describeReadHit(readHit, sx, id => datasetLabels[id] ?? readBindings.find(b => b.dataset_id === id)?.label ?? id, key => laneLabelOf(key), readLayers), cursorX: null });
      return;
    }
    const hit = sceneHitAt(scene, sx, y);
    if (hit) {
      // Only target-backed geometry has a target cursor: an insertion reports its boundary and length, never a
      // made-up target base.
      const inv = sceneInverse(scene, sx, y);
      const cursorX = hit.cursor && inv?.kind === 'target' ? x : null;
      setCursor({ x, y, text: describeSceneHit(hit, sx, model, reversed), cursorX });
    } else {
      const t = targetAtX(scene.targetMap, sx);
      if (t && !t.boundary) setCursor({ x, y, text: `${viewport?.contig}:${t.pos.toLocaleString('en-US')}`, cursorX: x });
      else if (t) setCursor({ x, y, text: `Insertion slot at target boundary ${t.pos.toLocaleString('en-US')} (no target sequence)`, cursorX: null });
      else setCursor(null);
    }
  };
  // ---------------------------------------------------------------- selection and inspection (Gate F)
  // A plain click on an insertion expands it (true bp inside the schematic view; again: collapses); on anything else
  // it selects it. ⌘/Ctrl-click opens the inspector; right-click offers Inspect and the source actions in the menu.
  const graphSelection = useBrowserStore(s => s.graphSelection);
  const drawnMolecules = readLayout?.placed.molecules;
  const readsAt = useCallback((spans: { path: string; span: { start: number; end: number } }[]) => {
    if (!drawnMolecules || !activeBindings.length) return null;
    const keys = new Set<string>();
    for (const m of drawnMolecules) {
      const r = m.read;
      if (spans.some(s => s.path === r.b && r.s < Math.max(s.span.end, s.span.start + 1) && r.e > s.span.start)) keys.add(moleculeKey(r.d, r.lib, r.q));
    }
    return { datasetIds: [...activeDatasetIds], molecules: keys.size,
      revisions: Object.fromEntries(activeBindings.map(b => [b.dataset_id, b.revision])) };
  }, [drawnMolecules, activeBindings, activeDatasetIds]);
  const selectionAt = (x: number, y: number): { sel: GraphSelection; hit: NonNullable<ReturnType<typeof sceneHitAt>> } | null => {
    if (!scene || !model || !reg || !state || !panelId) return null;
    const hit = sceneHitAt(scene, x - sceneOffset, y);
    if (!hit) return null;
    const sel = selectionForHit(hit, { panelId, reg, state, model, readsAt, scene }, y, x - sceneOffset);
    if (!sel) return null;
    return { sel: { ...sel, placements: sourcePlacements(sel, response?.result ?? null) }, hit };
  };
  const toggleExpanded = (groupId: string) => {
    if (!panelId || !state) return;
    const now = state.layoutSettings.expanded ?? [];
    const next = now.includes(groupId) ? now.filter(id => id !== groupId) : [...now, groupId].slice(-16);
    setGraphView(panelId, { ...state, layoutSettings: { ...state.layoutSettings, expanded: next } });
  };
  /** The member read row under a point (host mode), with the member panel it belongs to. */
  const readHitAt = (x: number, y: number) => {
    if (readsStale) return null;   // the previous window's reads, dimmed while the next load is in flight
    const sx = x - sceneOffset;
    return readHitsRef.current.find(h => sx >= h.x0 && sx <= h.x1 && y >= h.y0 && y <= h.y1) ?? null;
  };
  /** Select or deselect a read in its member's selection (QNAME, as every read view keeps it); with selection sync on
   * (D14), every other member of the host showing that record follows (§4.3). */
  const setReadSelected = (hit: ReadHit, on?: boolean) => {
    const member = bandMembers.find(m => m.panelId === hit.member);
    if (!member) return;
    const store = useBrowserStore.getState();
    const q = hit.molecule.read.q;
    const next = on ?? !store.selectedReadIds[member.stateKey]?.has(q);
    const targets = [member, ...(state?.syncSelection === false ? [] : bandMembers.filter(m => m !== member && routeRead(hit.molecule.read, m)))];
    for (const m of targets) {
      const has = useBrowserStore.getState().selectedReadIds[m.stateKey]?.has(q) ?? false;
      if (has !== next) useBrowserStore.getState().toggleReadSelection(m.stateKey, q);
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (regionDraw.current) {
      const at = targetAt(e.clientX, e.target as HTMLCanvasElement);
      const t0 = regionDraw.current.t0;
      regionDraw.current = null;
      setRegionPreview(null);
      if (at && Math.abs(at.t - t0) >= 10 && target) addGraphRegion(Math.min(t0, at.t), Math.max(t0, at.t), target.path.contig);
      return;
    }
    const click = drag.current && !drag.current.moved;
    drag.current = null;
    if (!click || !scene || !model) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const x = (e.clientX - rect.left) / zoom, y = (e.clientY - rect.top) / zoom;
    // Shift-click on a read selects it (as in the read tracks).
    const rh = hostMode && e.shiftKey ? readHitAt(x, y) : null;
    if (rh) { setReadSelected(rh); return; }
    const found = selectionAt(x, y);
    if (!found) { if (graphSelection?.panelId === panelId) selectGraph(null); return; }
    if (e.metaKey || e.ctrlKey) { selectGraph(found.sel, true); return; }
    const group = hitGroup(found.hit);
    if (isInsertionGroup(group)) {
      if (compression === 'linear' && target && group.target) {
        // Already at true bp: focus it instead.
        commitViewport(clampViewport({ contig: target.path.contig, ...focusWindow(group.target, target.size) }, target.size, target.size_inferred), true);
      } else toggleExpanded(group.id);
      selectGraph(found.sel, false);
      return;
    }
    selectGraph(found.sel, false);
  };
  // The selected locus' extent on the scene (a faint frame; the inspector has the details).
  const selectedExtent = useMemo(() => {
    if (!scene || !graphSelection || graphSelection.panelId !== panelId) return null;
    let x0 = Infinity, x1 = -Infinity;
    for (const h of scene.hits) {
      const g = (h.payload as { group?: { id: string } }).group?.id ?? (h.payload as { run?: { id: string } }).run?.id
        ?? (h.payload as { junction?: { id: string } }).junction?.id ?? (h.payload as { cluster?: { id: string } }).cluster?.id;
      if (g === graphSelection.locusKey) { x0 = Math.min(x0, h.x0); x1 = Math.max(x1, h.x1); }
    }
    return x1 > x0 ? { x0, x1 } : null;
  }, [scene, graphSelection, panelId]);
  // Anchored zoom: once the new window's scene is drawn, the anchor's target base goes back under the pointer (the
  // layout is nonlinear, so the average-scale zoom is close, not exact). Applied only while its navigation token is
  // current: any newer move, link change or package change drops it; the correction itself schedules none.
  const correction = useRef<{ token: NavigationToken; anchor: number; px: number } | null>(null);
  useEffect(() => {
    const c = correction.current;
    if (!c || !scene || !response || !viewport || !state || !panelId || !target) return;
    // Any newer move, link or package change makes it stale: dropped at once, not kept for a later scene.
    if (!tokenCurrent(c.token, state, viewport)) { correction.current = null; return; }
    if (response.result.interval.start !== viewport.start || response.result.interval.end !== viewport.end) return;
    correction.current = null;
    const x = xForTarget(scene.targetMap, c.anchor, 'start', reversed);
    if (x == null || !transform) return;
    const dx = c.px - x;
    if (Math.abs(dx) < 2) return;
    const deltaBp = Math.round((reversed ? dx : -dx) / Math.max(1e-9, bpScale(transform)));
    if (!deltaBp) return;
    const corrected = panViewport(viewport, deltaBp, target.size, target.size_inferred);
    if (following && !hostMode) navigateGraph(panelId, corrected); else commitViewport(corrected, true);
  }, [scene]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoomAround = (px: number, factor: number) => {
    if (!transform || !viewport || !target || !panelId || !state) return;
    const anchor = anchorAt(px);
    // A host zooms its own viewport with no 50 kb clamp, so zooming out past the hand-off draws it linear (§7.1).
    const next = hostMode && hostView
      ? hostZoom(hostView, factor, anchor, screenFraction(px), target.size, target.size_inferred)
      : clampViewport(zoomViewport(viewport, factor, anchor, target.size, target.size_inferred, screenFraction(px)), target.size, target.size_inferred);
    correction.current = null;
    const now = hostMode && hostView ? hostView : viewport;
    if (next.start === now.start && next.end === now.end) return;   // clamped: nothing moves, nothing to correct
    // Following: the initiator zooms (its own frame) and the graph follows it; on its own: only the graph.
    if (following && !hostMode) navigateGraph(panelId, next); else commitViewport(next, true);
    // The anchor's target base goes back under the pointer once the new scene is drawn; an insertion slot has no
    // target base to anchor (its boundary would jump the slot's edge), so none is scheduled there.
    const t = scene ? targetAtX(scene.targetMap, px - sceneOffset) : null;
    if (t?.boundary) return;
    // A host zoomed past the hand-off draws linear: nothing to correct (a correction would restart its settling).
    if (hostMode && next.end - next.start > useGraphSettings.getState().outBp) return;
    const after = useBrowserStore.getState().panels.find(p => p.id === panelId)?.graphView;
    correction.current = after ? { token: navigationToken(panelId, after, next), anchor, px } : null;
  };
  /** Where x is across the data area (mirrored when reversed): the zoomed window keeps the anchor there. The new
   * layout is nonlinear too, so this is close, not exact (exact anchoring is the Phase F navigation adapter). */
  const screenFraction = (x: number) => {
    const t = transform!;
    const f = Math.max(0, Math.min(1, (x - t.left) / Math.max(1, t.width)));
    return t.reversed ? 1 - f : f;
  };
  /** A zoom anchor: the target position under x on the scene (an insertion's boundary), else the average scale. */
  const anchorAt = (x: number) => {
    const t = scene ? targetAtX(scene.targetMap, x - sceneOffset) : null;
    return t ? t.pos : fromX(transform!, x);
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!(e.ctrlKey || e.metaKey) || !transform || !viewport || !target) return;
    e.preventDefault();
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const px = (e.clientX - rect.left) / zoom;
    zoomAround(px, e.deltaY > 0 ? 1.25 : 0.8);
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!transform || !viewport || !target) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const px = (e.clientX - rect.left) / zoom;
    zoomAround(px, e.shiftKey ? 2 : 0.5);
  };

  // ---------------------------------------------------------------- menu
  const [menu, setMenu] = useState<{ x: number; y: number; sel?: GraphSelection; group?: string | null; read?: ReadHit | null } | null>(null);
  const WHAT_LABEL: Record<string, string> = { insertion: 'Insertion', deletion: 'Deletion', substitution: 'Substitution',
    inversion: 'Inversion', complex: 'Complex region', junction: 'Fragment junction', sequence: 'Sequence', gap: 'Graph gap',
    cluster: 'Clustered differences', 'open end': 'Open end' };
  const [prompt, setPrompt] = useState<'goto' | 'register' | null>(null);
  const [locusText, setLocusText] = useState('');
  const [locusError, setLocusError] = useState<string | null>(null);
  const followable = useMemo(() => panels.filter(p => p.contentType === 'dataset' && p.viewportOverride && target
    && canFollow(target, { ...p.viewportOverride, reference: p.genome || main.reference })), [panels, target, main.reference]);
  const entries: ContextMenuEntry[] = [];
  const handoffSettings = useGraphSettings();
  const labelOfMember = (id: string) => bandMembers.find(m => m.panelId === id)?.label ?? 'panel';
  // A read under the pointer (host mode): the read tracks' read actions, in its member's state.
  if (menu?.read && hostMode) {
    const hit = menu.read;
    const r = hit.molecule.read;
    const member = bandMembers.find(m => m.panelId === hit.member);
    const sk = member?.stateKey ?? '';
    const selected = selectedAll[sk];
    const memberPanel = panels.find(p => p.id === hit.member);
    entries.push({ kind: 'heading', label: `${r.q} · ${member?.label ?? ''}` });
    entries.push({ kind: 'item', action: 'rd:select', icon: 'eye', label: selected?.has(r.q) ? 'Deselect read' : 'Select read',
      title: `In ${member?.label ?? 'its panel'}${state?.syncSelection === false ? '' : ' and every member showing it'} (also Shift-click)` });
    entries.push({ kind: 'item', action: 'rd:highlight', icon: 'target', label: 'Highlight molecule in all panels' });
    if (selected?.size) {
      entries.push({ kind: 'item', action: 'rd:keep', icon: 'filter', label: `Keep only selected reads (${selected.size.toLocaleString()})` });
      entries.push({ kind: 'item', action: 'rd:exclude', icon: 'eye-off', label: `Exclude selected reads (${selected.size.toLocaleString()})` });
    }
    entries.push({ kind: 'item', action: 'rd:copy', icon: 'copy', label: 'Copy read name' });
    if (memberPanel && memberPanel.id !== panelId) {
      entries.push(memberPanel.collapsedByGraphGroup === panelId
        ? { kind: 'item', action: `pop:${memberPanel.id}`, icon: 'panel:graph-view', label: `Pop out ${member?.label}` }
        : { kind: 'item', action: `fold:${memberPanel.id}`, icon: 'panel:graph-view', label: `Fold ${member?.label} into the graph` });
    }
    entries.push({ kind: 'separator' });
  }
  // What is under the pointer first (Inspect, expand, focus, source spans), the panel's settings below.
  const menuPlacements: SourcePlacement[] = menu?.sel?.placements ?? [];
  if (menu?.sel && state && reg && target) {
    const sel = menu.sel;
    const where = sel.target ? (sel.target.end === sel.target.start ? `boundary ${sel.target.start.toLocaleString('en-US')}`
      : `${sel.target.start.toLocaleString('en-US')}-${sel.target.end.toLocaleString('en-US')}`) : 'no target sequence';
    entries.push({ kind: 'heading', label: `${WHAT_LABEL[sel.what] ?? sel.what} · ${where}` });
    entries.push({ kind: 'item', action: 'sel:inspect', icon: 'search', label: 'Inspect', title: 'Paths, both coordinate frames, lengths, sequence and evidence (also ⌘/Ctrl-click)' });
    if (menu.group) {
      const open = (state.layoutSettings.expanded ?? []).includes(menu.group);
      entries.push({ kind: 'item', action: 'sel:expand', icon: 'layers', label: open ? 'Collapse the insertion' : 'Expand the insertion (true bp)',
        title: 'Also a plain click on it' });
    }
    if (sel.target) entries.push({ kind: 'item', action: 'sel:focus', icon: 'target', label: `Focus the target ${sel.target.end === sel.target.start ? 'boundary' : 'span'}` });
    if (menuPlacements.length) {
      const byPath = placementsByPath(menuPlacements);
      const sub: { kind: "item"; action: string; icon: string; label: string; title?: string }[] = [];
      menuPlacements.forEach((pl, i) => {
        const many = (byPath.get(pl.path)?.length ?? 0) > 1;
        const what = `${laneLabelOf(pl.path)} ${pl.span.start.toLocaleString('en-US')}-${pl.span.end.toLocaleString('en-US')}${pl.note ? ` (${pl.note})` : ''}`;
        for (const t of sourcePanelsFor(pl.path, panelId!, reg.id)) sub.push({ kind: 'item', action: `src:panel:${i}:${t.panelId}`, icon: 'target', label: `${what} → ${t.label}` });
        sub.push({ kind: 'item', action: `src:path:${i}`, icon: 'panel:graph-view', label: `${what} → a graph view on the path`,
          title: many ? 'More than one placement of this sequence on the path: each is listed' : 'Its own coordinates; no BAM needed' });
      });
      const ambiguous = [...byPath.values()].some(v => v.length > 1);
      entries.push({ kind: 'submenu', id: 'source', icon: 'target', label: ambiguous ? 'Show source span (choose a placement)' : 'Show source span', entries: sub });
    }
    entries.push({ kind: 'separator' });
  }
  if (state && reg && target && hostMode && panel) {
    // Graph mode of this dataset panel: its view is the panel's own; pop-outs are its members as ordinary panels.
    entries.push({ kind: 'heading', label: `${target.assembly} · ${target.path.contig} · graph mode` });
    entries.push({ kind: 'item', action: 'host:linear', icon: 'reads', label: 'View as linear', title: 'This panel\'s read tracks; its folded members open beside it' });
    entries.push({ kind: 'item', action: 'host:pin', icon: 'pin', label: 'Stay linear',
      title: `Draw linear tracks here until "Resume graph" (otherwise the graph hands off above ${formatBp(handoffSettings.outBp)})` });
    const { folded, missing } = poppable(panels, panel);
    const revealed = members.filter(m => m.panel.id !== panel.id && !m.panel.collapsedByGraphGroup);
    const popEntries: { kind: 'item'; action: string; icon: string; label: string; title?: string }[] = [
      ...folded.map(p => ({ kind: 'item' as const, action: `pop:${p.id}`, icon: 'panel:graph-view', label: `Pop out ${labelOfMember(p.id)}` })),
      ...missing.map(m => ({ kind: 'item' as const, action: `popnew:${m.binding}`, icon: 'panel:graph-view', label: `Pop out ${m.hap} (a new panel)`,
        title: 'A panel of this dataset for that haplotype, starting with this panel\'s state' })),
    ];
    if (folded.length + missing.length > 1) popEntries.push({ kind: 'item', action: 'pop:all', icon: 'panel:graph-view', label: 'Pop out all haplotypes in view' });
    popEntries.push(...revealed.map(m => ({ kind: 'item' as const, action: `fold:${m.panel.id}`, icon: 'panel:graph-view', label: `Fold ${labelOfMember(m.panel.id)} into the graph` })));
    if (revealed.length > 1) popEntries.push({ kind: 'item', action: 'fold:all', icon: 'panel:graph-view', label: 'Fold all pop-outs' });
    if (popEntries.length) entries.push({ kind: 'submenu', id: 'popout', icon: 'panel:graph-view', label: `Pop out (${members.length - 1} member${members.length === 2 ? '' : 's'})`, entries: popEntries });
    const joinable = joinCandidates(panels, panel);
    if (joinable.length) {
      entries.push({ kind: 'submenu', id: 'join', icon: 'layers', label: 'Add panels to this graph…',
        entries: joinable.map(c => ({ kind: 'item' as const, action: `join:${c.panel.id}`, icon: 'layers',
          label: `${c.panel.title || datasetLabels[c.panel.datasetId ?? ''] || c.panel.datasetId}${c.panel.liftHap ? ` · ${c.panel.liftHap}` : ''}` })) });
    }
    entries.push({ kind: 'submenu', id: 'bands', icon: 'settings', label: `Rows without a sort or clusters: ${bandSort === 'length' ? 'longest first' : 'by first carried column'}`,
      entries: [
        { kind: 'item' as const, action: 'band:position', icon: 'settings', label: `${bandSort === 'position' ? '✓ ' : ''}By first carried column` },
        { kind: 'item' as const, action: 'band:length', icon: 'settings', label: `${bandSort === 'length' ? '✓ ' : ''}Longest first` },
      ] });
    entries.push({ kind: 'item', action: 'host:sync', icon: 'eye', label: `${state.syncSelection === false ? '' : '✓ '}Sync selection across the graph`,
      title: 'Selecting a read selects it in every member showing the same record' });
    entries.push({ kind: 'submenu', id: 'handoff', icon: 'settings', label: `Linear above ${formatBp(handoffSettings.outBp)}`,
      entries: [...[[50_000, 40_000], [30_000, 25_000], [20_000, 15_000]].map(([o, i]) => ({ kind: 'item' as const, action: `ho:${o}:${i}`, icon: 'settings',
        label: `${handoffSettings.outBp === o ? '✓ ' : ''}Above ${formatBp(o)} (graph again at ${formatBp(i)})` })),
        { kind: 'item' as const, action: 'ho:complexity', icon: 'settings', label: `${handoffSettings.complexity ? '✓ ' : ''}Also where most of the window is unresolved`,
          title: 'Linear when more than half of the window has no resolved graph correspondence; the graph returns below 30%' }] });
    entries.push({ kind: 'separator' });
  }
  if (state && reg && target && !hostMode) {
    const mainOk = canFollow(target, main);
    entries.push({ kind: 'heading', label: `${target.assembly} · ${target.path.contig}` });
    entries.push({ kind: 'item', action: 'follow:main', icon: 'target', disabled: !mainOk,
      label: `${state.linkMode === 'follow' && state.initiatingPanelId == null ? '✓ ' : ''}Follow the main view`,
      title: mainOk ? `Show the centre of the main view (${main.chrom}), at most 50 kb`
        : `Only a view of ${target.path.contig} on ${target.reference} can be followed (the main view: ${main.chrom} on ${main.reference || 'an unnamed reference'})` });
    for (const p of followable) {
      entries.push({ kind: 'item', action: `follow:${p.id}`, icon: 'target',
        label: `${state.linkMode === 'follow' && state.initiatingPanelId === p.id ? '✓ ' : ''}Follow ${p.title || p.regionLabel || 'its panel'} (${formatLocus({ contig: p.viewportOverride!.chrom, start: p.viewportOverride!.start, end: p.viewportOverride!.end })})` });
    }
    entries.push({ kind: 'item', action: 'independent', icon: 'pin', label: `${state.linkMode === 'independent' ? '✓ ' : ''}Navigate on its own` });
    entries.push({ kind: 'item', action: 'goto', icon: 'search', label: 'Go to a target locus…' });
    const convertible = panel ? conversionTargets(panels, panel) : [];
    if (convertible.length) {
      entries.push({ kind: 'submenu', id: 'convert', icon: 'reads', label: 'Make this the graph view of…',
        entries: convertible.map(p => ({ kind: 'item' as const, action: `conv:${p.id}`, icon: 'reads',
          label: `${p.title || datasetLabels[p.datasetId ?? ''] || p.datasetId}${p.liftHap ? ` · ${p.liftHap}` : ''}`,
          title: 'That dataset panel views its graph here, with its read tools; this panel closes' })) });
    }
    entries.push({ kind: 'separator' });
  }
  if (state && reg && target) {
    entries.push({ kind: 'submenu', id: 'paths', icon: 'layers', label: `Paths (${state.selectedPathKeys.length} of at most ${GRAPH_MAX_PATHS})`,
      entries: selectableBindings(reg, target.key, state.selectedPathKeys).map(b => {
        const on = state.selectedPathKeys.includes(b.key);
        return { kind: 'item' as const, action: `path:${b.key}`, icon: on ? 'eye' : 'eye-off',
          disabled: !on && state.selectedPathKeys.length >= GRAPH_MAX_PATHS,
          label: `${on ? '✓ ' : ''}${laneLabel(b, b.key)} · ${b.assembly}`,
          title: `${b.path.sample}#${b.path.haplotype}#${b.path.contig}` };
      }) });
    entries.push({ kind: 'submenu', id: 'compression', icon: 'settings', label: `Widths: ${compression === 'log' ? 'schematic' : 'true bp'}`,
      entries: [
        { kind: 'item' as const, action: 'cmp:log', icon: 'settings', label: `${compression === 'log' ? '✓ ' : ''}Schematic (long runs compressed)`,
          title: 'Runs over 200 bp take 200 + 100·log2(L/200) units; break marks and labels give true lengths' },
        { kind: 'item' as const, action: 'cmp:linear', icon: 'settings', label: `${compression === 'linear' ? '✓ ' : ''}True bp`,
          title: 'Every base the same width; insertions still get their own slot' },
      ] });
    entries.push({ kind: 'submenu', id: 'small', icon: 'settings', label: `Show small differences as: ${smallMode}`,
      entries: [
        { kind: 'item' as const, action: 'small:marks', icon: 'settings', label: `${smallMode === 'marks' ? '✓ ' : ''}Marks on the shared tube`,
          title: `SNPs and indels below ${smallBp || smallDifferenceBp(50_000, 1000)} bp (scaled with zoom) are ticks, notches and carets on the path's stripe; zoomed in, they become bubbles` },
        { kind: 'item' as const, action: 'small:bubbles', icon: 'settings', label: `${smallMode === 'bubbles' ? '✓ ' : ''}Bubbles`,
          title: 'Every difference branches into its path\'s lane' },
      ] });
    {
      const bound = readBindings.filter(b => Object.keys(b.paths).length);
      const shownIds = new Set(activeBindings.map(b => b.dataset_id));
      // A layer the toolbar's Layers row has off is off here too: the item says so instead of a second switch.
      const layerItem = (key: keyof ReadLayers, label: string) => ({ kind: 'item' as const, action: `rl:${key}`, icon: readLayers[key] ? 'eye' : 'eye-off',
        disabled: !globalLayers[key], label: `${readLayers[key] ? '✓ ' : ''}${label}`,
        title: globalLayers[key] ? 'Hide or show this layer in this graph panel only' : 'Off in the toolbar\'s Layers row (it applies to every read view)' });
      entries.push({ kind: 'submenu', id: 'reads', icon: 'reads', label: bound.length ? `Reads: ${readSettings.show ? `${shownIds.size} of ${bound.length} datasets` : 'hidden'}` : 'Reads: no dataset binds',
        entries: [
          { kind: 'item' as const, action: 'reads:toggle', icon: readSettings.show ? 'eye' : 'eye-off', disabled: !bound.length,
            label: `${readSettings.show ? '✓ ' : ''}Show reads on the paths`,
            title: 'Molecules of loaded datasets whose assembly is a path of this graph, drawn along their walk' },
          ...(hostMode ? [] : bound).map(b => ({ kind: 'item' as const, action: `reads:ds:${b.dataset_id}`, icon: shownIds.has(b.dataset_id) ? 'eye' : 'eye-off',
            label: `${shownIds.has(b.dataset_id) ? '✓ ' : ''}${b.label}${changedBindings.includes(b) ? ' (changed since saved: choose to bind it again)' : ''}`,
            title: `${b.kind === 'lifted' ? 'Live-lift dataset' : 'Dataset on the target'}: ${Object.entries(b.paths).filter(([k]) => state.selectedPathKeys.includes(k)).map(([k, c]) => `${laneLabelOf(k)} ← ${c}`).join(', ') || 'no selected path'}${b.problems.length ? ` · not bound: ${b.problems.join('; ')}` : ''}` })),
          ...readBindings.filter(b => b.problems.length && !Object.keys(b.paths).length).map(b => ({ kind: 'item' as const, action: `reads:none:${b.dataset_id}`,
            icon: 'eye-off', disabled: true, label: `${b.label}: not a path of this graph`, title: b.problems.join('; ') })),
          layerItem('nuc', 'Nucleosomes'), layerItem('msp', 'MSPs / FIRE'), layerItem('tf', 'TF footprints'), layerItem('m6a', 'm6A'),
          ...[5, 7, 10].map(h => ({ kind: 'item' as const, action: `reads:h:${h}`, icon: 'settings', label: `${readRowHeight === h ? '✓ ' : ''}Rows ${h} px` })),
          ...(hostMode ? [{ kind: 'item' as const, action: 'reads:rows:fill', icon: 'settings', label: `${fillHeight ? '✓ ' : ''}Rows fill the panel height` }] : []),
          ...[20, 40, 100].map(n => ({ kind: 'item' as const, action: `reads:rows:${n}`, icon: 'settings',
            label: `${!fillHeight && rowsPerLane === n ? '✓ ' : ''}At most ${n} rows per ${hostMode ? 'band' : 'path'}` })),
        ] });
    }
    entries.push({ kind: 'submenu', id: 'context', icon: 'settings', label: `Graph context: ${state.layoutSettings.contextBp} bp`,
      entries: [0, 100, 500, 2000].map(bp => ({ kind: 'item' as const, action: `ctx:${bp}`, icon: 'settings',
        label: `${state.layoutSettings.contextBp === bp ? '✓ ' : ''}${bp} bp` })) });
    if (regs.length > 1) {
      entries.push({ kind: 'submenu', id: 'registration', icon: 'library', label: 'Graph package',
        entries: regs.map(r => ({ kind: 'item' as const, action: `reg:${r.id}`, icon: 'library', label: `${r.id === reg.id ? '✓ ' : ''}${r.label}` })) });
    }
    entries.push({ kind: 'separator' });
    entries.push({ kind: 'item', action: 'reload', icon: 'reads', label: 'Reload the topology' });
    entries.push({ kind: 'item', action: 'another', icon: 'panel:graph-view', label: 'Open another graph view',
      title: 'A second graph panel, with a viewport of its own' });
  }
  entries.push({ kind: 'item', action: 'register', icon: 'library', label: 'Register a graph package…' });
  const onMenuAction = (action: string) => {
    const at = menu;
    setMenu(null);
    if (hostMode && panelId && panel) {
      const hit = at?.read;
      const member = hit ? bandMembers.find(m => m.panelId === hit.member) : undefined;
      const store = useBrowserStore.getState();
      if (action === 'rd:select' && hit) { setReadSelected(hit); return; }
      if (action === 'rd:highlight' && hit) { useReadActionsStore.getState().highlightReads([hit.molecule.read.q]); return; }
      if (action === 'rd:copy' && hit) { void copyText(hit.molecule.read.q); return; }
      if ((action === 'rd:keep' || action === 'rd:exclude') && member) {
        const ids = [...(store.selectedReadIds[member.stateKey] ?? [])];
        if (!ids.length) return;
        if (action === 'rd:exclude') { excludeReadsUndoably(member.stateKey, ids); return; }
        seedHistoryBaseline(store, 'Before keeping only the selected reads', 'analysis');
        store.setFilteredReadIds(member.stateKey, new Set(ids));
        useBrowserStore.getState().pushSnapshot?.('Keep only selected reads', { kind: 'analysis' });
        return;
      }
      if (action === 'host:linear') { setPanelViewMode(panelId, 'linear'); return; }
      if (action === 'host:pin') { setPinnedLinear(panelId, true); return; }
      if (action === 'host:sync') { setGraphView(panelId, { ...state!, syncSelection: state!.syncSelection === false }); return; }
      if (action.startsWith('band:')) { setGraphView(panelId, { ...state!, bandSort: action.slice(5) as 'position' | 'length' }); return; }
      if (action === 'ho:complexity') { useGraphSettings.getState().set({ complexity: !useGraphSettings.getState().complexity }); return; }
      if (action.startsWith('ho:')) { const [, o, i] = action.split(':'); useGraphSettings.getState().set({ outBp: Number(o), inBp: Number(i) }); return; }
      if (action === 'pop:all') { const { folded, missing } = poppable(panels, panel); popOutPaths(panelId, folded.map(p => p.id), missing); return; }
      if (action.startsWith('popnew:')) { const m = poppable(panels, panel).missing.filter(x => x.binding === action.slice(7)); popOutPaths(panelId, [], m); return; }
      if (action.startsWith('pop:')) { popOutPaths(panelId, [action.slice(4)]); return; }
      if (action === 'fold:all') { foldIn(panelId, members.filter(m => m.panel.id !== panelId).map(m => m.panel.id)); return; }
      if (action.startsWith('fold:')) { foldIn(panelId, [action.slice(5)]); return; }
      if (action.startsWith('join:')) { joinGraph(panelId, [action.slice(5)]); return; }
    }
    if (action.startsWith('conv:') && panelId) { convertStandalone(panelId, action.slice(5)); return; }
    if (at?.sel && panelId && state && target) {
      const sel = at.sel;
      if (action === 'sel:inspect') { selectGraph(sel, true); return; }
      if (action === 'sel:expand' && at.group) { toggleExpanded(at.group); selectGraph(sel, false); return; }
      if (action === 'sel:focus' && sel.target) {
        if (hostMode) commitViewport(clampViewport({ contig: target.path.contig, ...focusWindow(sel.target, target.size) }, target.size, target.size_inferred), true);
        else navigateGraph(panelId, { contig: target.path.contig, ...focusWindow(sel.target, target.size) });
        selectGraph(sel, false);
        return;
      }
      if (action.startsWith('src:')) {
        const [, how, idx, into] = action.split(':');
        const pl = menuPlacements[Number(idx)];
        if (!pl) return;
        const t = how === 'panel' ? sourcePanelsFor(pl.path, panelId!, sel.registrationId).find(x => x.panelId === into) ?? null : null;
        showSourceSpan(panelId, pl, t, sel.registrationId);
        return;
      }
    }
    if (!panelId) return;
    if (action === 'register') { setPrompt('register'); return; }
    if (!state || !reg || !target) return;
    if (action === 'reload') { setReloadToken(n => n + 1); return; }
    if (action === 'another') { useBrowserStore.getState().openAnalysisPanel('graph-view' as never); return; }
    if (action === 'goto') { setLocusText(viewport ? formatLocus(viewport) : ''); setLocusError(null); setPrompt('goto'); return; }
    if (action === 'independent') { setGraphView(panelId, { ...state, linkMode: 'independent', targetViewport: viewport ?? state.targetViewport, initiatingPanelId: null, initiatingReferenceId: null }); return; }
    if (action.startsWith('follow:')) {
      const id = action.slice('follow:'.length);
      const initiating = id === 'main' ? null : id;
      const linear = initiatorView({ ...state, initiatingPanelId: initiating }, panels, main);
      setGraphView(panelId, { ...state, linkMode: 'follow', initiatingPanelId: initiating, initiatingReferenceId: linear?.reference ?? null });
      return;
    }
    if (action.startsWith('path:')) { setGraphView(panelId, togglePath(state, action.slice(5))); return; }
    if (action.startsWith('cmp:')) { setGraphView(panelId, { ...state, layoutSettings: { ...state.layoutSettings, compression: action.slice(4) as Compression } }); return; }
    if (action.startsWith('small:')) { setGraphView(panelId, { ...state, layoutSettings: { ...state.layoutSettings, smallDifferences: action.slice(6) as 'marks' | 'bubbles' } }); return; }
    if (action.startsWith('reads:') || action.startsWith('rl:')) {
      const current = state.reads ?? DEFAULT_READS;
      let next: GraphReadSettings = current;
      if (action === 'reads:toggle') next = { ...current, show: !current.show };
      else if (action.startsWith('reads:ds:')) {
        const id = action.slice('reads:ds:'.length);
        // Chosen again: its current revision is the one bound from now on.
        const fresh = readBindings.find(b => b.dataset_id === id);
        if (fresh && changedBindings.includes(fresh)) {
          next = { ...current, show: true, bound: (current.bound ?? []).map(x => (x.dataset_id === id ? { dataset_id: id, revision: fresh.revision } : x)) };
          setGraphView(panelId, { ...state, reads: next });
          return;
        }
        const bound = readBindings.filter(b => Object.keys(b.paths).length).map(b => b.dataset_id);
        const shown = new Set(current.datasets ?? bound);
        if (shown.has(id)) shown.delete(id); else shown.add(id);
        next = { ...current, show: true, datasets: bound.every(d => shown.has(d)) ? null : bound.filter(d => shown.has(d)) };
      } else if (action.startsWith('reads:h:')) next = { ...current, rowHeight: Number(action.slice('reads:h:'.length)) };
      else if (action === 'reads:rows:fill') { const { maxRowsPerLane: _m, ...rest } = current; next = rest; }
      else if (action.startsWith('reads:rows:')) next = { ...current, maxRowsPerLane: Number(action.slice('reads:rows:'.length)) };
      else if (action.startsWith('rl:')) {
        const key = action.slice(3) as 'nuc' | 'tf' | 'msp' | 'm6a';
        const own = current.layers ?? {};
        next = { ...current, layers: { ...own, [key]: own[key] === false } };
      }
      setGraphView(panelId, { ...state, reads: next });
      return;
    }
    if (action.startsWith('ctx:')) { setGraphView(panelId, { ...state, layoutSettings: { ...state.layoutSettings, contextBp: Number(action.slice(4)) } }); return; }
    if (action.startsWith('reg:')) {
      const next = regs.find(r => r.id === action.slice(4));
      if (next) setGraphView(panelId, initialGraphView(next, main));
    }
  };
  const submitLocus = () => {
    const parsed = parseLocus(locusText);
    if (!parsed || !target || !reg || !state || !panelId) { setLocusError('Type contig:start-end'); return; }
    if (parsed.contig !== target.path.contig) {
      // Another contig: the package's target on it (its mapped paths), else refused.
      const next = defaultTarget(reg, { chrom: parsed.contig, start: parsed.start, end: parsed.end });
      if (!next || next.path.contig !== parsed.contig) { setLocusError(`This package has no target path on ${parsed.contig}`); return; }
      setGraphView(panelId, { ...state, linkMode: 'independent', initiatingPanelId: null, initiatingReferenceId: null,
        targetBinding: next.key, targetReferenceId: next.reference, selectedPathKeys: [next.key, ...defaultCompared(reg, next.key)],
        targetViewport: clampViewport(parsed, next.size, next.size_inferred) });
      setPrompt(null);
      return;
    }
    // A graph host's Go to is a jump of its panel (or the main view): Back (Alt+←) returns to where it was.
    // (On its own view's contig the host moves like a pan, through setPanelViewport: Back moves it, and what is locked
    // to it, the same way.)
    if (hostMode) {
      const own = useBrowserStore.getState().panels.find(p => p.id === panelId)?.viewportOverride;
      useBrowserStore.getState().recordJump(panelId, { likePan: own?.chrom === parsed.contig, to: { chrom: parsed.contig, start: parsed.start, end: parsed.end } });
    }
    commitViewport(clampViewport(parsed, target.size, target.size_inferred), true);
    setPrompt(null);
  };

  // ---------------------------------------------------------------- render
  if (!panelId) return null;
  let body: React.ReactNode;
  if (!status) {
    body = statusError
      ? <Message testId="graph-panel-error" title="Graph status unavailable"><span>{statusError}</span></Message>
      : <Message testId="graph-panel-loading" title="Checking the graph helper…" />;
  } else if (!status.helper.available) {
    body = (
      <Message testId="graph-panel-unavailable" title="Graph helper unavailable">
        <span data-testid="graph-panel-hint" className="max-w-md">{status.helper.hint}</span>
        {status.helper.error && <span className="max-w-md text-[10px] text-gray-400">{status.helper.error}</span>}
        <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate-700 underline dark:text-slate-200" onClick={() => void loadStatus(true)}>Check again</button>
      </Message>
    );
  } else if (!regs.length && !state?.registrationId) {
    body = (
      <Message testId="graph-panel-empty" title="No graph package registered">
        <span className="max-w-md">Register a folder made by <code>fiberbrowser-graph prepare</code>; it is verified before use.</span>
        <RegisterForm />
      </Message>
    );
  } else if (problem) {
    // Restored (or its package went missing): nothing is re-resolved. The saved target and paths stay frozen here,
    // with the package's own error when the server has one, and a relink.
    const errors = status.registration_errors ?? [];
    const saved = state?.targetViewport;
    body = (
      <Message testId="graph-panel-stale" title="Graph package unavailable">
        <span>{problem}</span>
        {saved && <span data-testid="graph-panel-frozen">Saved view, frozen: {state?.targetBinding} {formatLocus(saved)} · {state?.selectedPathKeys.length ?? 0} paths</span>}
        {errors.map(e => (
          <span key={e.package} data-testid="graph-panel-registration-error" className="max-w-md text-[10px] text-gray-500">{e.package}: {e.error}{' '}
            <button type="button" className="text-slate-700 underline dark:text-slate-200" data-testid="graph-panel-relink"
              onClick={() => void useGraphStatusStore.getState().register(e.package)}>Register again</button></span>
        ))}
        <RegisterForm compact />
        {hostMode
          ? <button type="button" data-testid="graph-host-view-linear" className="rounded px-2 py-0.5 text-[11px] text-slate-700 underline dark:text-slate-200"
              onClick={() => setPanelViewMode(panelId, 'linear')}>View as linear</button>
          : regs.length > 0 && <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate-700 underline dark:text-slate-200"
          onClick={() => setGraphView(panelId, initialGraphView(regs[0], main))}>Use {regs[0].label} instead</button>}
      </Message>
    );
  } else if (!state || !viewport || !transform) {
    body = <Message testId="graph-panel-loading" title="Opening the graph…" />;
  } else {
    const statusText = query.error
      ? `${query.error.retryable ? 'Retry' : 'Refused'}: ${query.error.message}`
      : model
        ? [`${model.rows.length} paths`, `${model.stats.nodes} nodes`, `${model.stats.visits} visits`,
          model.complete ? 'complete' : 'partial', model.correspondenceComplete ? null : 'correspondence partly inferred',
          bubbleSummary(model), model.stats.complex ? `${model.stats.complex} complex` : null,
          scene?.clusters ? `${scene.clusters} clustered (zoom in)` : null,
          model.stats.unplaced ? `${model.stats.unplaced} unplaced runs` : null,
          model.stats.unresolved ? `${model.stats.unresolved} unresolved` : null,
          ...model.summaries.slice(0, 2),
          readsSummary(reads, readLayout),
          changedBindings.length ? `not drawn: ${changedBindings.map(b => b.label).join(', ')} changed since this view was saved (Reads menu binds it again)` : null,
          response?.cached ? 'cached' : response?.timings.total_ms != null ? `${response.timings.total_ms < 10 ? response.timings.total_ms.toFixed(1) : Math.round(response.timings.total_ms)} ms` : null,
        ].filter(Boolean).join(' · ')
        : 'Loading the topology…';
    body = (
      <div className="relative" style={{ width }}>
        <canvas ref={canvasRef} data-testid="graph-panel-canvas" data-copilot-track="graph"
          style={{ display: 'block', width, height: canvasHeight, touchAction: 'none', cursor: drag.current ? 'grabbing' : 'grab' }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerLeave={() => { if (!drag.current) setCursor(null); if (panelId) useLiftHover.getState().clear(panelId); }} onWheel={onWheel} onDoubleClick={onDoubleClick}
          onContextMenu={e => {
            e.preventDefault();
            const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
            const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
            const px = (e.clientX - rect.left) / zoom, py = (e.clientY - rect.top) / zoom;
            const read = hostMode ? readHitAt(px, py) : null;
            const found = read ? null : selectionAt(px, py);
            const group = found ? hitGroup(found.hit) : null;
            setMenu({ x: e.clientX, y: e.clientY, sel: found?.sel, group: isInsertionGroup(group) ? group.id : null, read });
          }} />
        {/* Lane labels' accessible names (the canvas draws them). */}
        <div className="sr-only">{model?.rows.map(l => <span key={l.key} data-testid="graph-lane-label" title={l.title} style={{ color: laneColor(l) }}>{l.label}</span>)}</div>
        {cursor?.cursorX != null && (
          <div data-testid="graph-cursor" className="pointer-events-none absolute top-0" style={{ left: cursor.cursorX, width: 1, height: canvasHeight, background: 'rgba(100,100,100,0.45)' }} />
        )}
        {selectedExtent && (
          <div data-testid="graph-selected" data-locus={graphSelection?.locusKey ?? ''} className="pointer-events-none absolute rounded-sm border border-dashed border-stone-500"
            style={{ left: selectedExtent.x0 + sceneOffset - 1, width: selectedExtent.x1 - selectedExtent.x0 + 2, top: GRAPH_RULER_HEIGHT, height: canvasHeight - GRAPH_RULER_HEIGHT - 1 }} />
        )}
        {cursor && (
          <div data-testid="graph-tooltip" className="pointer-events-none absolute z-10 whitespace-nowrap rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-white"
            style={{ left: Math.min(cursor.x + 10, Math.max(0, width - 260)), top: Math.min(cursor.y + 12, canvasHeight - 4) }}>{cursor.text}</div>
        )}
        <div data-testid="graph-panel-status" title={statusText}
          className={`truncate px-1 text-[10px] ${query.error ? 'text-red-600' : 'text-gray-500 dark:text-gray-400'}`} style={{ height: STATUS_HEIGHT, lineHeight: `${STATUS_HEIGHT}px` }}>
          {query.loading && model ? '… ' : ''}{statusText}
        </div>
      </div>
    );
  }
  return (
    <div ref={rootRef} data-testid="graph-panel" data-graph-panel-id={panelId}
      data-graph-start={viewport?.start ?? ''} data-graph-end={viewport?.end ?? ''}
      data-graph-drawn-start={response?.result.interval.start ?? ''} data-graph-drawn-end={response?.result.interval.end ?? ''}
      data-graph-loading={query.loading ? 'true' : 'false'} data-graph-generation={query.generation}
      data-graph-link={state?.linkMode ?? ''} data-graph-lanes={model?.rows.map(l => l.key).join(',') ?? ''}
      data-graph-complete={model ? String(model.complete) : ''} data-graph-error={query.error?.code ?? ''}
      data-graph-bubbles={model ? model.stats.groups : ''}
      data-graph-reads={readLayout ? [...readLayout.lanes.values()].reduce((t, l) => t + l.rows.reduce((u, r) => u + r.length, 0), 0) : ''}
      data-graph-reads-loading={reads.loading ? 'true' : 'false'} data-graph-reads-start={reads.forStart ?? ''} data-graph-compression={compression} data-graph-small-bp={smallBp}
      data-graph-expanded={expandedKey} data-graph-selected={graphSelection?.panelId === panelId ? graphSelection.locusKey : ''}
      className="relative h-full min-h-0 w-full overflow-auto bg-white dark:bg-dark-bg"
      style={{ height: bodyHeight }}
      onContextMenu={e => { if (!(e.target instanceof HTMLCanvasElement)) { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } }}>
      {body}
      {prompt === 'goto' && (
        <form data-testid="graph-panel-goto" className="absolute left-2 top-8 z-20 flex flex-col gap-1 rounded border border-gray-300 bg-white p-2 shadow dark:border-gray-600 dark:bg-gray-800"
          onSubmit={e => { e.preventDefault(); submitLocus(); }}>
          <input data-testid="graph-panel-locus-input" autoFocus value={locusText} onChange={e => setLocusText(e.target.value)} spellCheck={false}
            onKeyDown={e => { if (e.key === 'Escape') setPrompt(null); }}
            className="w-56 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
          {locusError && <span className="text-[11px] text-red-600">{locusError}</span>}
          <span className="text-[10px] text-gray-500">On {target?.assembly} {target?.path.contig}; at most {formatBp(50_000)}</span>
        </form>
      )}
      {prompt === 'register' && (
        <div className="absolute left-2 top-8 z-20 rounded border border-gray-300 bg-white p-2 shadow dark:border-gray-600 dark:bg-gray-800" style={{ width: Math.min(360, width - 16) }}>
          <RegisterForm compact onDone={() => setPrompt(null)} />
        </div>
      )}
      {menu && (
        <ReadContextMenu x={menu.x} y={menu.y} entries={entries} title={viewport ? formatLocus(viewport) : 'Graph view'}
          onAction={onMenuAction} onClose={() => setMenu(null)} testId="graph-panel-menu" label="Graph view options" />
      )}
    </div>
  );
}

/** A host's pan of its own viewport: the width kept (no 50 kb clamp), inside the target when its size is known. */
function hostPan(view: GraphViewport, deltaBp: number, size: number | null, sizeInferred: boolean): GraphViewport {
  const width = view.end - view.start;
  let start = Math.round(view.start + deltaBp);
  const limit = size != null && !sizeInferred ? size : null;
  if (start < 0) start = 0;
  if (limit != null && start + width > limit) start = Math.max(0, limit - width);
  return { contig: view.contig, start, end: start + width };
}

/** A host's zoom about `anchor` (kept at screen fraction `fraction`) on its own viewport: no 50 kb clamp (the hand-off
 * decides what it draws), at least 40 bp, inside the target when its size is known. */
function hostZoom(view: { chrom: string; start: number; end: number }, factor: number, anchor: number, fraction: number,
  size: number | null, sizeInferred: boolean): GraphViewport {
  let width = Math.max(40, Math.round((view.end - view.start) * factor));
  const limit = size != null && !sizeInferred ? size : null;
  if (limit != null) width = Math.min(width, limit);
  let start = Math.round(anchor - fraction * width);
  if (start < 0) start = 0;
  if (limit != null && start + width > limit) start = Math.max(0, limit - width);
  return { contig: view.chrom, start, end: start + width };
}

const OMISSION_LABELS: Record<string, string> = {
  hard_clipped_supplementary: 'hard-clipped supplementaries (tags not scoped to their bases)',
  supplementary_hidden: 'supplementaries (hidden by the dataset setting)',
  record_collisions: 'duplicate records',
  records_without_correspondence: 'records off the paths',
  sampled_out_after_retry: 'sampled out (payload limit)',
  loader_filters: 'left out by the read filters',
  payload_limit: 'molecules over the payload limit',
  records_not_reached: 'records not decoded (payload limit)',
};

/** The status line's reads part: records drawn, molecules, sampling and every omission (never silent). */
function readsSummary(reads: { response: GraphReadsResponse | null; loading: boolean; error: GraphApiError | null },
  layout: { placed: { molecules: PlacedMolecule[]; offLane: number; unplacedBp: number; empty: number; m6aAsDensity: boolean; marksHidden: number };
    lanes: Map<string, PackedLane> } | null): string | null {
  if (reads.error) return `reads: ${reads.error.message}`;
  if (!reads.response) return reads.loading ? 'loading reads…' : null;
  const rep = reads.response.report;
  const drawn = layout ? [...layout.lanes.values()].reduce((t, l) => t + l.rows.reduce((u, r) => u + r.length, 0), 0) : 0;
  const hidden = layout ? [...layout.lanes.values()].reduce((t, l) => t + l.hidden, 0) : 0;
  const parts = [`${drawn} reads (${rep.molecules} molecules)`];
  if (rep.sampling.level) parts.push(`sampled 1/${1 << rep.sampling.level}`);
  if (rep.sampling.molecules_capped) parts.push(`${rep.sampling.molecules_capped} molecules over the ${rep.sampling.max_molecules} cap`);
  if (hidden) parts.push(`${hidden} past the row limit`);
  if (rep.truncated) parts.push('payload limit reached');
  if (rep.m6a_density_reads) parts.push(`m6A as density on ${rep.m6a_density_reads}`);
  if (rep.calls_omitted_reads) parts.push(`calls omitted on ${rep.calls_omitted_reads} (mark budget)`);
  const omitted = Object.entries(rep.omitted ?? {}).map(([k, v]) => `${v} ${OMISSION_LABELS[k] ?? k.replace(/_/g, ' ')}`);
  if (omitted.length) parts.push(`omitted: ${omitted.join(', ')}`);
  if (rep.shared_qnames) parts.push(`${rep.shared_qnames} QNAMEs in two libraries (kept apart)`);
  if (layout?.placed.m6aAsDensity) parts.push('m6A as density (mark budget)');
  if (layout?.placed.marksHidden) parts.push(`calls not drawn on ${layout.placed.marksHidden} (mark budget)`);
  if (layout?.placed.empty) parts.push(`${layout.placed.empty} with nothing in the drawn walk`);
  if (layout?.placed.offLane) parts.push(`${layout.placed.offLane} on paths not shown`);
  if (layout?.placed.unplacedBp) parts.push(`${layout.placed.unplacedBp.toLocaleString('en-US')} read bp not drawn (summarised geometry)`);
  return parts.join(', ');
}

function bubbleSummary(model: LayoutModel): string | null {
  const { insertions, deletions, substitutions, inversions, repeats } = model.stats;
  const parts = [insertions ? `${insertions} ins` : null, deletions ? `${deletions} del` : null, substitutions ? `${substitutions} sub` : null,
    inversions ? `${inversions} inv` : null].filter(Boolean);
  const total = insertions + deletions + substitutions + inversions;
  const alleles = parts.length ? `${total} alleles (${parts.join(', ')})` : 'no differences';
  return repeats ? `${alleles} · ${repeats} repeat visit${repeats === 1 ? '' : 's'}` : alleles;
}

export default GraphPanel;
