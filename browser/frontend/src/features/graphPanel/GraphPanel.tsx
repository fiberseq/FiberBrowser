/**
 * The graph-view panel (DESIGN_GRAPH_PANEL.md §1, Gate B): a target backbone and up to three compared paths from a
 * registered graph package, drawn by the thin topology preview (preview.ts) on the panel's own ruler and
 * coordinates. It needs no BAM and no live lift; it never takes the linear panels' insertion expansion, highlights,
 * pan offset or crosshair. Options are in its right-click menu; its rows show only data and a compact label.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import type { AnalysisPanelProps } from '../../plugins/types';
import { ReadContextMenu, type ContextMenuEntry } from '../../components/tracks/read-track/ReadContextMenu';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { cancelSubgraph, querySubgraph, GraphRequestError } from './api';
import { describeHit, drawLanes, drawRuler, GRAPH_GUTTER, GRAPH_LANE_GAP, hitAt, laneColor, laneTop, type HitRegion } from './canvas';
import { clampViewport, formatBp, formatLocus, fromX, makeTransform, panViewport, parseLocus, zoomViewport, bpScale, type GraphViewport } from './coordinates';
import { buildPreview, laneLabel } from './preview';
import { type LinearView, canFollow, defaultCompared, defaultTarget, effectiveViewport, initialGraphView, initiatorView, restoreProblem, retargetFor, selectableBindings, togglePath, GRAPH_MAX_PATHS } from './state';
import { useGraphStatusStore } from './statusStore';
import { genomeKeyFor } from '../../utils/regionNavigation';
import { startTrace, type GraphTrace } from './timings';
import type { GraphApiError, GraphRegistration, GraphSubgraphResponse, GraphViewState } from './types';

const DEBOUNCE_MS = 100;
const STATUS_HEIGHT = 18;

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
        contextBp: state.layoutSettings.contextBp,
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
  const preview = useMemo(() => (response && reg ? buildPreview(response.result, reg.bindings) : null), [response, reg]);
  // Mark layout on the trace of the response it came from.
  const lastTraceRef = useRef<GraphTrace | null>(null);
  useEffect(() => {
    if (!response) return;
    const trace = (window.__FIBERBROWSER_GRAPH_TRACES__ ?? []).find(t => t.panelId === panelId && t.generation === query.generation) ?? null;
    if (trace && trace.laidOutAt === undefined) trace.laidOutAt = performance.now();
    lastTraceRef.current = trace;
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- drawing
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<HitRegion[]>([]);
  const laneHeight = state?.layoutSettings.laneHeight ?? 28;
  const laneCount = preview?.lanes.length ?? state?.selectedPathKeys.length ?? 0;
  const canvasHeight = laneTop(laneCount, laneHeight) + GRAPH_LANE_GAP;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !transform || !viewport) return;
    const ctx = setupHighDpiCanvas(canvas, width, canvasHeight, { coordinates: 'screen' });
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, canvasHeight);
    drawRuler(ctx, transform, viewport, width);
    // The last response's pieces are target coordinates: drawn through the current transform they move with a pan
    // until the next response fills the rest.
    hitsRef.current = preview ? drawLanes(ctx, preview, transform, width, laneHeight, false) : [];
    const trace = lastTraceRef.current;
    if (trace && trace.paintedAt === undefined && preview) {
      requestAnimationFrame(() => {
        if (trace.paintedAt === undefined) { trace.paintedAt = performance.now(); trace.outcome = trace.outcome ?? 'painted'; }
      });
    }
  }, [preview, transform, width, canvasHeight, renderVersion, laneHeight]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const hit = hitAt(hitsRef.current, x, y);
    const inData = x >= transform.left && x <= transform.left + transform.width;
    if (hit) {
      // An insertion reports its boundary and length, never a made-up target base.
      const cursorX = hit.piece.kind === 'insertion' ? null : x;
      setCursor({ x, y, text: describeHit(hit), cursorX });
    } else if (inData && y >= 0 && y <= canvasHeight) {
      setCursor({ x, y, text: `${viewport?.contig}:${Math.floor(fromX(transform, x)).toLocaleString('en-US')}`, cursorX: x });
    } else setCursor(null);
  };
  const onPointerUp = () => { drag.current = null; };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!(e.ctrlKey || e.metaKey) || !transform || !viewport || !target) return;
    e.preventDefault();
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const anchor = fromX(transform, (e.clientX - rect.left) / zoom);
    commitViewport(zoomViewport(viewport, e.deltaY > 0 ? 1.25 : 0.8, anchor, target.size, target.size_inferred), true);
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!transform || !viewport || !target) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const zoom = rect.width > 0 && width > 0 ? rect.width / width : 1;
    const anchor = fromX(transform, (e.clientX - rect.left) / zoom);
    commitViewport(zoomViewport(viewport, e.shiftKey ? 2 : 0.5, anchor, target.size, target.size_inferred), true);
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
      : preview
        ? [`${preview.lanes.length} paths`, `${preview.nodes} nodes`, `${preview.visits} visits`,
          preview.complete ? 'complete' : 'partial', preview.correspondenceComplete ? null : 'correspondence partly inferred',
          ...preview.summaries.slice(0, 2), preview.lanes.some(l => l.unplaced.length) ? `${preview.lanes.reduce((n, l) => n + l.unplaced.length, 0)} unplaced runs` : null,
          preview.lanes.some(l => l.transitions) ? `${preview.lanes.reduce((n, l) => n + l.transitions, 0)} unresolved transitions` : null,
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
        <div className="sr-only">{preview?.lanes.map(l => <span key={l.key} data-testid="graph-lane-label" title={l.title} style={{ color: laneColor(l) }}>{l.label}</span>)}</div>
        {cursor?.cursorX != null && (
          <div data-testid="graph-cursor" className="pointer-events-none absolute top-0" style={{ left: cursor.cursorX, width: 1, height: canvasHeight, background: 'rgba(100,100,100,0.45)' }} />
        )}
        {cursor && (
          <div data-testid="graph-tooltip" className="pointer-events-none absolute z-10 whitespace-nowrap rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-white"
            style={{ left: Math.min(cursor.x + 10, Math.max(0, width - 260)), top: Math.min(cursor.y + 12, canvasHeight - 4) }}>{cursor.text}</div>
        )}
        <div data-testid="graph-panel-status" title={statusText}
          className={`truncate px-1 text-[10px] ${query.error ? 'text-red-600' : 'text-gray-500 dark:text-gray-400'}`} style={{ height: STATUS_HEIGHT, lineHeight: `${STATUS_HEIGHT}px` }}>
          {query.loading && preview ? '… ' : ''}{statusText}
        </div>
      </div>
    );
  }
  return (
    <div ref={rootRef} data-testid="graph-panel" data-graph-panel-id={panelId}
      data-graph-start={viewport?.start ?? ''} data-graph-end={viewport?.end ?? ''}
      data-graph-drawn-start={response?.result.interval.start ?? ''} data-graph-drawn-end={response?.result.interval.end ?? ''}
      data-graph-loading={query.loading ? 'true' : 'false'} data-graph-generation={query.generation}
      data-graph-link={state?.linkMode ?? ''} data-graph-lanes={preview?.lanes.map(l => l.key).join(',') ?? ''}
      data-graph-complete={preview ? String(preview.complete) : ''} data-graph-error={query.error?.code ?? ''}
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

export default GraphPanel;
