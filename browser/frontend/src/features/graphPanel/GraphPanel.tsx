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
import { drawRuler, drawScene, GRAPH_GUTTER, GRAPH_LANE_GAP, GRAPH_LANE_HEIGHT, GRAPH_RIGHT_PAD, GRAPH_RULER_HEIGHT, laneColor, laneTop } from './canvas';
import { clampViewport, formatBp, formatLocus, fromX, makeTransform, panViewport, parseLocus, zoomViewport, bpScale, type GraphViewport } from './coordinates';
import { buildLayout, laneLabel, type LayoutModel } from './layout';
import { buildScene, COMPACT_LANE_PX, describeSceneHit, planScene, sceneHitAt, sceneInverse, smallDifferenceBp, targetAtX, type Compression, type Scene } from './scene';
import { type LinearView, canFollow, defaultCompared, defaultTarget, effectiveViewport, initialGraphView, initiatorView, restoreProblem, retargetFor, selectableBindings, togglePath, GRAPH_MAX_PATHS } from './state';
import { useGraphStatusStore } from './statusStore';
import { usePanelContentHeightStore } from '../../stores/panelContentHeightStore';
import { genomeKeyFor } from '../../utils/regionNavigation';
import { startTrace, type GraphTrace } from './timings';
import type { GraphApiError, GraphReadBinding, GraphReadSettings, GraphReadsResponse, GraphRegistration, GraphSubgraphResponse, GraphViewState } from './types';
import { MAX_READ_PRIMITIVES, packMolecules, placeReads, placementIndex, type PackedLane, type PlacedMolecule } from './readGeometry';
import { bandHeight, describeReadHit, drawReadBandLabels, drawReads, READ_ROW_GAP, READ_ROW_HEIGHT, type ReadHit, type ReadLayers } from './readCanvas';
import { chromatinStyle } from './chromatinStyle';

const DEBOUNCE_MS = 100;
/** Named visits walked beyond each window edge, so an event exactly at an edge has its flank (graphlift flank_bp). */
const FLANK_BP = 1;

declare global {
  interface Window {
    /** e2e only (with __FIBERBROWSER_E2E_EXPOSE_STORE): each graph panel's last scene, to locate its geometry. */
    __FIBERBROWSER_GRAPH_SCENES__?: Record<string, { scene: Scene; model: LayoutModel; offset: number;
      reads?: { molecules: PlacedMolecule[]; lanes: Record<string, { rows: number; hidden: number }>; hits: ReadHit[]; placeMs?: number; drawMs?: number; serverMs?: number } }>;
  }
}
const STATUS_HEIGHT = 18;
/** Lane height of the panel's natural (content) size. */
const NATURAL_LANE = 34;
const DEFAULT_READS: GraphReadSettings = { show: true, datasets: null };
const READS_DEBOUNCE_MS = 0;   // the topology request is already debounced
/** Rows per lane's read band by default (each row a record; the request holds at most 300 molecules). */
const DEFAULT_ROWS_PER_LANE = 40;

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

  const state = panel?.graphView ?? null;
  const regs = status?.registrations ?? [];
  const reg: GraphRegistration | null = (state?.registrationId ? regs.find(r => r.id === state.registrationId) : null) ?? null;
  const problem = state ? restoreProblem(state, regs) : null;
  const target = reg && state?.targetBinding ? reg.bindings.find(b => b.key === state.targetBinding) ?? null : null;

  // A new panel takes the first registration once the status is known.
  useEffect(() => {
    if (!panelId || !status?.helper.available || state) return;
    if (!regs.length) return;
    setGraphView(panelId, initialGraphView(regs[0], main));
  }, [panelId, status, state, regs, main]);

  // Following a linear panel onto another contig: that contig's target in the same package, if it has one.
  useEffect(() => {
    if (!panelId || !state || !reg || problem) return;
    const next = retargetFor(reg, state, initiatorView(state, panels, main));
    if (next) setGraphView(panelId, next);
  }, [panelId, state, reg, problem, panels, main]);
  const viewport = state && target && !problem ? effectiveViewport(state, target, panels, main) : null;
  // Following: remember where it is, so a closed (or switched) initiator leaves the panel where it was, on its own.
  const lastFollowed = useRef<GraphViewport | null>(null);
  const following = Boolean(state?.linkMode === 'follow' && target && canFollow(target, state ? initiatorView(state, panels, main) : null)
    && (!state?.initiatingReferenceId || state.initiatingReferenceId === initiatorView(state, panels, main)?.reference));
  if (following && viewport) lastFollowed.current = viewport;
  useEffect(() => {
    if (!panelId || !state || !status || state.linkMode !== 'follow' || following || problem) return;
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
        setQuery({ response, loading: false, error: null, generation });
      }).catch(err => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        inflightRef.current = null;
        trace.outcome = 'error';
        const error: GraphApiError = err instanceof GraphRequestError ? err.error : { code: 'network', message: String(err?.message ?? err), retryable: true };
        trace.error = error.code;
        setQuery(q => ({ ...q, loading: false, error, generation }));
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

  // ---------------------------------------------------------------- reads (Gate E)
  // Which loaded datasets bind to this package's paths (explicit identities, checked by the server), and the
  // reads of the bound paths' source windows, requested once the topology says what those windows are.
  const readSettings = state?.reads ?? DEFAULT_READS;
  const datasetKey = useBrowserStore(s => s.datasets.map(d => d.id).join(','));
  const datasetLabels = useBrowserStore(useShallow(s => Object.fromEntries(s.datasets.map(d => [d.id, d.label ?? d.id]))));
  const [readBindings, setReadBindings] = useState<GraphReadBinding[]>([]);
  useEffect(() => {
    if (!reg) { setReadBindings([]); return; }
    const controller = new AbortController();
    getReadBindings(reg.id, controller.signal).then(setReadBindings).catch(() => { if (!controller.signal.aborted) setReadBindings([]); });
    return () => controller.abort();
  }, [reg?.id, datasetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeBindings = useMemo(() => (readSettings.show ? readBindings.filter(b => Object.keys(b.paths).length
    && (readSettings.datasets == null || readSettings.datasets.includes(b.dataset_id))) : []), [readBindings, readSettings]);
  const [reads, setReads] = useState<{ response: GraphReadsResponse | null; loading: boolean; error: GraphApiError | null; forStart?: number; key?: string }>({ response: null, loading: false, error: null });
  const readsGenRef = useRef(0);
  const readsInflightRef = useRef<AbortController | null>(null);
  const readPaths = response && activeBindings.length
    ? response.result.paths.filter(p => activeBindings.some(b => p.binding in b.paths) && p.windows.length)
      .map(p => ({ binding: p.binding, windows: p.windows }))
    : [];
  const readsKey = reg && response && readPaths.length
    ? JSON.stringify([reg.id, reg.revisions.package, readPaths, activeBindings.map(b => [b.dataset_id, b.revision])])
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
        datasets: activeBindings.map(b => ({ dataset_id: b.dataset_id, revision: b.revision })), paths: readPaths }, controller.signal)
        .then(out => { if (generation === readsGenRef.current) setReads({ response: out, loading: false, error: null, forStart, key }); })
        .catch(err => {
          if (controller.signal.aborted || generation !== readsGenRef.current) return;
          const error: GraphApiError = err instanceof GraphRequestError ? err.error : { code: 'network', message: String(err?.message ?? err), retryable: true };
          // A failed load leaves no reads of another window on screen.
          setReads({ response: null, loading: false, error });
        });
    }, READS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [readsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => readsInflightRef.current?.abort(), []);
  const readLayers: ReadLayers = { nuc: readSettings.layers?.nuc ?? true, tf: readSettings.layers?.tf ?? true,
    msp: readSettings.layers?.msp ?? true, m6a: readSettings.layers?.m6a ?? true };
  const readRowHeight = readSettings.rowHeight ?? READ_ROW_HEIGHT;
  const rowsPerLane = readSettings.maxRowsPerLane ?? DEFAULT_ROWS_PER_LANE;
  const activeDatasetIds = useMemo(() => new Set(activeBindings.map(b => b.dataset_id)), [activeBindings]);
  const colormap = useBrowserStore(s => s.activeColormap);
  const style = useMemo(() => chromatinStyle(colormap), [colormap]);

  const compression: Compression = state?.layoutSettings.compression ?? 'log';
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
    const out = planScene(model, { width, gutter: GRAPH_GUTTER, rightPad: GRAPH_RIGHT_PAD, compression, smallBp });
    layoutMsRef.current += performance.now() - t0;
    return out;
  }, [model, width, compression, smallBp]);
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
      laneHeight, laneGap: GRAPH_LANE_GAP, compression, reversed, colors: laneColors, smallBp, plan });
    layoutMsRef.current += performance.now() - t0;
    return out;
  }, [model, plan, width, laneHeight, compression, reversed, smallBp, laneColors]);
  // Molecules along the walk (their x is the scene's occurrence transforms; bands only add height under lanes).
  // Reads are drawn for the window they were loaded for; while the next window's load is in flight the last ones
  // stay, dimmed (they are placed by source coordinate, so where they show they are right; the new edges fill in).
  const readsStale = Boolean(reads.response && reads.key !== readsKey);
  const readsShown = reads.response && (!readsStale || reads.loading) ? reads.response : null;
  const readLayout = useMemo(() => {
    if (!baseScene || !response || !readsShown) return null;
    const t0 = performance.now();
    const index = placementIndex(baseScene, response.result, FLANK_BP);
    const span = response.result.interval.end - response.result.interval.start;
    const placed = placeReads(readsShown.reads.filter(r => activeDatasetIds.has(r.d)), index, MAX_READ_PRIMITIVES,
      span / Math.max(1, baseScene.dataWidth));
    const lanes = packMolecules(placed.molecules, rowsPerLane);
    return { placed, lanes, ms: performance.now() - t0 };
  }, [baseScene, response, readsShown, activeDatasetIds, rowsPerLane]);
  const bands = useMemo(() => {
    if (!readLayout) return null;
    const out: Record<string, number> = {};
    for (const [k, lane] of readLayout.lanes) out[k] = bandHeight(lane, readRowHeight, READ_ROW_GAP);
    return out;
  }, [readLayout, readRowHeight]);
  const scene = useMemo(() => {
    if (!baseScene || !bands || !Object.values(bands).some(Boolean) || !model || !plan) return baseScene;
    return buildScene(model, { width, gutter: GRAPH_GUTTER, rightPad: GRAPH_RIGHT_PAD, rulerHeight: GRAPH_RULER_HEIGHT,
      laneHeight, laneGap: GRAPH_LANE_GAP, compression, reversed, colors: laneColors, smallBp, plan, bands });
  }, [baseScene, bands]); // eslint-disable-line react-hooks/exhaustive-deps
  const readHitsRef = useRef<ReadHit[]>([]);
  const readDrawMsRef = useRef(0);
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
      const tr = performance.now();
      readHitsRef.current = readLayout ? drawReads(ctx, scene, readLayout.lanes, style, readLayers, laneColors, readRowHeight, READ_ROW_GAP,
        readsStale ? 0.45 : 1) : [];
      readDrawMsRef.current = performance.now() - tr;
      ctx.restore();
      // The read bands' compact labels stay in the gutter.
      if (readLayout) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, GRAPH_RULER_HEIGHT, GRAPH_GUTTER - 2, canvasHeight);
        ctx.clip();
        drawReadBandLabels(ctx, scene, readLayout.lanes, laneColors);
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
            placeMs: readLayout.ms, drawMs: readDrawMsRef.current, serverMs: reads.response?.timings.total_ms,
            lanes: Object.fromEntries([...readLayout.lanes].map(([k, l]) => [k, { rows: l.rows.length, hidden: l.hidden }])) } } : {}) };
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
  }, [scene, transform, width, canvasHeight, renderVersion, sceneOffset, readLayout, style, readSettings, readsStale]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- navigation
  const commitViewport = useCallback((next: GraphViewport, detach = false, linearAtStart?: LinearView | null) => {
    if (!panelId || !state || !target) return;
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
  }, [panelId, state, target, main, viewport, following]);

  const drag = useRef<{ x: number; view: GraphViewport; moved: boolean; linear: LinearView | null } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; text: string; cursorX: number | null } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !viewport) return;
    (e.target as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, view: viewport, moved: false,
      linear: state ? initiatorView(state, useBrowserStore.getState().panels, main) : null };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const x = (e.clientX - rect.left) / zoom, y = (e.clientY - rect.top) / zoom;
    if (drag.current && transform && target) {
      const dx = (e.clientX - drag.current.x) / zoom;
      if (Math.abs(dx) > 2) drag.current.moved = true;
      if (drag.current.moved) {
        const deltaBp = (reversed ? dx : -dx) / bpScale(transform);
        commitViewport(panViewport(drag.current.view, deltaBp, target.size, target.size_inferred), false, drag.current.linear);
      }
      return;
    }
    if (!transform) return;
    const inData = x >= transform.left && x <= transform.left + transform.width;
    if (!scene || !model || !inData || y < 0 || y > canvasHeight) { setCursor(null); return; }
    const sx = x - sceneOffset;
    const readHit = readHitsRef.current.find(h => sx >= h.x0 && sx <= h.x1 && y >= h.y0 && y <= h.y1);
    if (readHit) {
      setCursor({ x, y, text: describeReadHit(readHit, sx, id => datasetLabels[id] ?? id, key => laneLabelOf(key)), cursorX: null });
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
  // A click (no drag) on a difference, a slot, a summary or an open end pins its description, with a zoom to it.
  const [pinned, setPinned] = useState<{ x: number; y: number; text: string; span: { start: number; end: number } | null } | null>(null);
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const click = drag.current && !drag.current.moved;
    drag.current = null;
    if (!click || !scene || !model) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const x = (e.clientX - rect.left) / zoom, y = (e.clientY - rect.top) / zoom;
    const hit = sceneHitAt(scene, x - sceneOffset, y);
    const p = hit?.payload;
    if (!hit || !p || p.kind === 'run' || p.kind === 'filler') { setPinned(null); return; }
    const span = p.kind === 'allele' || p.kind === 'base' || p.kind === 'slot' || p.kind === 'complex'
      ? (p.group.kind === 'group' ? p.group.target ?? hit.within?.group.target ?? null : p.group.target)
      : p.kind === 'cluster' ? p.cluster.target : p.kind === 'gap' ? (p.gap ?? p.junction.gap)?.span ?? p.junction.target : null;
    setPinned({ x, y, text: describeSceneHit(hit, x - sceneOffset, model, reversed), span });
  };
  useEffect(() => { setPinned(null); }, [response]);
  /** Zoom to a pinned difference: a window a few times its size (at least 200 bp), where small ones are bubbles. */
  const zoomTo = (span: { start: number; end: number }) => {
    if (!target) return;
    const len = Math.max(200, (span.end - span.start) * 3);
    const mid = (span.start + span.end) / 2;
    commitViewport(clampViewport({ contig: target.path.contig, start: Math.round(mid - len / 2), end: Math.round(mid + len / 2) }, target.size, target.size_inferred), true);
    setPinned(null);
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
    commitViewport(zoomViewport(viewport, e.deltaY > 0 ? 1.25 : 0.8, anchorAt(px), target.size, target.size_inferred, screenFraction(px)), true);
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!transform || !viewport || !target) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const px = (e.clientX - rect.left) / zoom;
    commitViewport(zoomViewport(viewport, e.shiftKey ? 2 : 0.5, anchorAt(px), target.size, target.size_inferred, screenFraction(px)), true);
  };

  // ---------------------------------------------------------------- menu
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [prompt, setPrompt] = useState<'goto' | 'register' | null>(null);
  const [locusText, setLocusText] = useState('');
  const [locusError, setLocusError] = useState<string | null>(null);
  const followable = useMemo(() => panels.filter(p => p.contentType === 'dataset' && p.viewportOverride && target
    && canFollow(target, { ...p.viewportOverride, reference: p.genome || main.reference })), [panels, target, main.reference]);
  const entries: ContextMenuEntry[] = [];
  if (state && reg && target) {
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
    entries.push({ kind: 'separator' });
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
      const layerItem = (key: keyof ReadLayers, label: string) => ({ kind: 'item' as const, action: `rl:${key}`, icon: readLayers[key] ? 'eye' : 'eye-off',
        label: `${readLayers[key] ? '✓ ' : ''}${label}` });
      entries.push({ kind: 'submenu', id: 'reads', icon: 'reads', label: bound.length ? `Reads: ${readSettings.show ? `${shownIds.size} of ${bound.length} datasets` : 'hidden'}` : 'Reads: no dataset binds',
        entries: [
          { kind: 'item' as const, action: 'reads:toggle', icon: readSettings.show ? 'eye' : 'eye-off', disabled: !bound.length,
            label: `${readSettings.show ? '✓ ' : ''}Show reads on the paths`,
            title: 'Molecules of loaded datasets whose assembly is a path of this graph, drawn along their walk' },
          ...bound.map(b => ({ kind: 'item' as const, action: `reads:ds:${b.dataset_id}`, icon: shownIds.has(b.dataset_id) ? 'eye' : 'eye-off',
            label: `${shownIds.has(b.dataset_id) ? '✓ ' : ''}${b.label}`,
            title: `${b.kind === 'lifted' ? 'Live-lift dataset' : 'Dataset on the target'}: ${Object.entries(b.paths).filter(([k]) => state.selectedPathKeys.includes(k)).map(([k, c]) => `${laneLabelOf(k)} ← ${c}`).join(', ') || 'no selected path'}${b.problems.length ? ` · not bound: ${b.problems.join('; ')}` : ''}` })),
          ...readBindings.filter(b => b.problems.length && !Object.keys(b.paths).length).map(b => ({ kind: 'item' as const, action: `reads:none:${b.dataset_id}`,
            icon: 'eye-off', disabled: true, label: `${b.label}: not a path of this graph`, title: b.problems.join('; ') })),
          layerItem('nuc', 'Nucleosomes'), layerItem('msp', 'MSPs / FIRE'), layerItem('tf', 'TF footprints'), layerItem('m6a', 'm6A'),
          ...[5, 7, 10].map(h => ({ kind: 'item' as const, action: `reads:h:${h}`, icon: 'settings', label: `${readRowHeight === h ? '✓ ' : ''}Rows ${h} px` })),
          ...[20, 40, 100].map(n => ({ kind: 'item' as const, action: `reads:rows:${n}`, icon: 'settings', label: `${rowsPerLane === n ? '✓ ' : ''}At most ${n} rows per path` })),
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
    setMenu(null);
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
        const bound = readBindings.filter(b => Object.keys(b.paths).length).map(b => b.dataset_id);
        const shown = new Set(current.datasets ?? bound);
        if (shown.has(id)) shown.delete(id); else shown.add(id);
        next = { ...current, show: true, datasets: bound.every(d => shown.has(d)) ? null : bound.filter(d => shown.has(d)) };
      } else if (action.startsWith('reads:h:')) next = { ...current, rowHeight: Number(action.slice('reads:h:'.length)) };
      else if (action.startsWith('reads:rows:')) next = { ...current, maxRowsPerLane: Number(action.slice('reads:rows:'.length)) };
      else if (action.startsWith('rl:')) {
        const key = action.slice(3) as keyof ReadLayers;
        next = { ...current, layers: { ...readLayers, [key]: !readLayers[key] } };
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
  } else if (!regs.length) {
    body = (
      <Message testId="graph-panel-empty" title="No graph package registered">
        <span className="max-w-md">Register a folder made by <code>fiberbrowser-graph prepare</code>; it is verified before use.</span>
        <RegisterForm />
      </Message>
    );
  } else if (problem) {
    body = (
      <Message testId="graph-panel-stale" title="Graph package unavailable">
        <span>{problem}</span>
        <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate-700 underline dark:text-slate-200"
          onClick={() => setGraphView(panelId, initialGraphView(regs[0], main))}>Use {regs[0].label}</button>
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
          response?.cached ? 'cached' : response?.timings.total_ms != null ? `${response.timings.total_ms < 10 ? response.timings.total_ms.toFixed(1) : Math.round(response.timings.total_ms)} ms` : null,
        ].filter(Boolean).join(' · ')
        : 'Loading the topology…';
    body = (
      <div className="relative" style={{ width }}>
        <canvas ref={canvasRef} data-testid="graph-panel-canvas" data-copilot-track="graph"
          style={{ display: 'block', width, height: canvasHeight, touchAction: 'none', cursor: drag.current ? 'grabbing' : 'grab' }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerLeave={() => { if (!drag.current) setCursor(null); }} onWheel={onWheel} onDoubleClick={onDoubleClick}
          onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }} />
        {/* Lane labels' accessible names (the canvas draws them). */}
        <div className="sr-only">{model?.rows.map(l => <span key={l.key} data-testid="graph-lane-label" title={l.title} style={{ color: laneColor(l) }}>{l.label}</span>)}</div>
        {cursor?.cursorX != null && (
          <div data-testid="graph-cursor" className="pointer-events-none absolute top-0" style={{ left: cursor.cursorX, width: 1, height: canvasHeight, background: 'rgba(100,100,100,0.45)' }} />
        )}
        {pinned && (
          <div data-testid="graph-pinned" className="absolute z-20 max-w-[480px] rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-800 shadow dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            style={{ left: Math.max(0, Math.min(pinned.x + 8, width - 360)), top: Math.min(pinned.y + 10, Math.max(0, canvasHeight - 40)) }}>
            <div className="whitespace-normal">{pinned.text}</div>
            <div className="mt-1 flex justify-end gap-2">
              {pinned.span && <button type="button" data-testid="graph-pinned-zoom" className="text-slate-700 underline dark:text-slate-200" onClick={() => zoomTo(pinned.span!)}>Zoom to it</button>}
              <button type="button" data-testid="graph-pinned-close" className="text-gray-500 underline" onClick={() => setPinned(null)}>Close</button>
            </div>
          </div>
        )}
        {cursor && !pinned && (
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

const OMISSION_LABELS: Record<string, string> = {
  hard_clipped_supplementary: 'hard-clipped supplementaries (tags not scoped to their bases)',
  supplementary_hidden: 'supplementaries (hidden by the dataset setting)',
  record_collisions: 'duplicate records',
  records_without_correspondence: 'records off the paths',
  sampled_out_after_retry: 'sampled out (payload limit)',
  loader_filters: 'left out by the read filters',
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
