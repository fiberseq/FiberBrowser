/**
 * The graph-view panel rendered (Gate B): "Graph helper unavailable" with its install hint; a panel with no BAM that
 * follows the main view and draws the real Alu topology on its own ruler; debounced requests with superseded ones
 * aborted and cancelled on the server; two panels with independent viewports; and a linear panel's insertion
 * expansion that cannot reach its canvas.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import alu from './__fixtures__/alu.topology.json';
import { GraphPanel } from './GraphPanel';
import { GRAPH_GUTTER, GRAPH_RIGHT_PAD } from './canvas';
import { targetAtX } from './scene';
import { WHEEL_SETTLE_MS } from '../../hooks/useWheelZoom';
import { PanelHeader } from '../../components/tracks/PanelHeader';
import { foldIn, hostGraphView, membersOf, popOut, setPanelViewMode } from './hostMode';
import { DEFAULT_PEAK_RULES } from '../../types/peak';
import { FireTrack } from '../../components/tracks/FireTrack';
import { GRAPH_PEAK_ROW_HEIGHT } from './peakTrack';
import { useGraphBindingsStore } from './bindingsStore';
import { useConfirmedQualityFilters, useQualityFilterSync } from '../../hooks/useQualityFilterSync';
import { useGraphStatusStore } from './statusStore';
import { useBrowserStore } from '../../stores/browserStore';
import { setupHighDpiCanvas } from '../../utils/canvasUtils';
import { setReferenceSurface } from '../differences/referenceCanvas';
import { makeAxis } from '../differences/axis';
import { initialGraphView } from './state';
import { clearGraphTraces, graphTraces } from './timings';
import { usePanelContentHeightStore } from '../../stores/panelContentHeightStore';
import { useHubData } from '../hub/hubData';
import { DEFAULT_SIGNAL_FILTERS } from '../../utils/signalFilters';
import type { GraphBinding, GraphRead, GraphReadBinding, GraphRegistration, GraphStatus } from './types';
import type { PanelConfig } from '../../types';
import { applyImportedState, collectFrontendState } from '../../api/session';

const bindings = alu.bindings as unknown as GraphBinding[];
const registration: GraphRegistration = {
  id: 'galu', label: 'alu', producer: 'fiberbrowser-graph 0.4.0', build_target: 'test',
  revisions: { package: 'p'.repeat(64), graph: 'g'.repeat(64), db: 'd'.repeat(64), maps: 'm'.repeat(64) },
  bindings, maps: [{ target: 'target', source: 'mat' }, { target: 'target', source: 'pat' }],
};
const available: GraphStatus = {
  helper: { available: true, source: 'companion', producer: 'fiberbrowser-graph 0.4.0' },
  registrations: [registration], registration_errors: [], limits: { target_bp: 50_000, paths: 4, context_bp: 2000 },
};

type Call = { method: string; args: unknown[] };
let calls: WeakMap<HTMLCanvasElement, Call[]>;
let contexts: WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>;
function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const known = contexts.get(canvas);
  if (known) return known;
  const log: Call[] = calls.get(canvas) ?? [];
  calls.set(canvas, log);
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: text.length * 5 }),
    setLineDash: () => {}, getLineDash: () => [],
  };
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop as string];
      return (...args: unknown[]) => { log.push({ method: String(prop), args }); };
    },
    set(t, prop, value) { t[prop as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  contexts.set(canvas, ctx);
  return ctx;
}
const texts = (canvas: HTMLCanvasElement) => (calls.get(canvas) ?? []).filter(c => c.method === 'fillText').map(c => String(c.args[0]));

let host: HTMLDivElement;
let root: Root;
const original = useBrowserStore.getState();
const originalHub = useHubData.getState();
const originalBindings = useGraphBindingsStore.getState();
let fetchMock: ReturnType<typeof vi.fn>;
let pendingResolvers: Array<(r: Response) => void>;

function graphPanel(id: string, graphView?: PanelConfig['graphView']): PanelConfig {
  return { id, contentType: 'graph-view', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...(graphView ? { graphView } : {}) };
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function subgraphBodies(): any[] {
  return fetchMock.mock.calls.filter(c => String(c[0]) === '/api/graph/subgraph').map(c => JSON.parse(String((c[1] as RequestInit).body)));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  calls = new WeakMap();
  contexts = new WeakMap();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) { return recordingContext(this); } as any);
  pendingResolvers = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/graph/subgraph') {
      const req = JSON.parse(String(init!.body));
      const result = { ...(alu.topology as object), interval: req.interval };
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        pendingResolvers.push(() => resolve(respond({ request_id: req.request_id, panel_id: req.panel_id, generation: req.generation, status: 'ok',
          cached: false, result, registration_id: 'galu', revisions: registration.revisions, timings: { queue_ms: 0.1, dispatch_ms: 1.2, total_ms: 1.5 } })));
      });
    }
    if (String(url).startsWith('/api/graph/requests/')) return Promise.resolve(respond({ cancelled: true }));
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useGraphStatusStore.setState({ status: available, loading: false, error: null });
  useConfirmedQualityFilters.setState({ key: null });
  useBrowserStore.setState({ chrom: 'chr3', start: 90_000, end: 100_000, panels: [], currentGenome: 'hg38' } as any);
  clearGraphTraces();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useBrowserStore.setState(original, true);
  useGraphStatusStore.setState({ status: null, loading: false, error: null });
  useHubData.setState(originalHub, true);
  useGraphBindingsStore.setState(originalBindings, true);
  delete window.__FIBERBROWSER_E2E_EXPOSE_STORE;
  delete window.__FIBERBROWSER_GRAPH_SCENES__;
});

async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function answerAll() {
  const resolvers = pendingResolvers.splice(0);
  await act(async () => { for (const r of resolvers) r(undefined as unknown as Response); await vi.advanceTimersByTimeAsync(20); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
}

describe('GraphPanel', () => {
  it.each(['ctrlKey', 'metaKey'])('%s-wheel follows the anchored graph zoom path and coalesces a burst', async modifier => {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    useBrowserStore.setState({ panels: [graphPanel('g1')], start: 92_395, end: 102_395,
      _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0, _historyPaused: false });
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={300} />));
    await settle(160); await answerAll();
    const canvas = host.querySelector<HTMLCanvasElement>('[data-testid="graph-panel-canvas"]')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 50, top: 0, width: 1800, height: 600 } as DOMRect);
    const px = 270;
    const exposed = window.__FIBERBROWSER_GRAPH_SCENES__!.g1;
    const anchor = targetAtX(exposed.scene.targetMap, px - exposed.offset)!.pos;
    const fraction = (px - GRAPH_GUTTER) / (900 - GRAPH_GUTTER - GRAPH_RIGHT_PAD);
    const navigate = vi.spyOn(useBrowserStore.getState(), 'setViewport');
    const beforeRequests = subgraphBodies().length;
    for (let i = 0; i < 10; i++) {
      act(() => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        [modifier]: true, deltaY: -1, clientX: 50 + px * 2 })));
      await settle(10);
    }
    expect(canvas.style.transform).toContain('scaleX');
    expect(navigate).not.toHaveBeenCalled();
    expect(subgraphBodies()).toHaveLength(beforeRequests);
    await settle(WHEEL_SETTLE_MS);
    expect(navigate).toHaveBeenCalledTimes(1);
    const s = useBrowserStore.getState();
    expect(s.end - s.start).toBeCloseTo(10_000 * Math.exp(-0.02), 0);
    expect(Math.abs(s.start + fraction * (s.end - s.start) - anchor)).toBeLessThanOrEqual(1);
    expect(s._historyStack).toHaveLength(2);
    // Topology and any nonlinear anchor correction load after settling, and stay in the same history step.
    for (let i = 0; i < 5; i++) { await settle(200); await answerAll(); }
    expect(useBrowserStore.getState()._historyStack).toHaveLength(2);
    act(() => useBrowserStore.getState().undo());
    expect(useBrowserStore.getState().start).toBe(92_395);
    expect(useBrowserStore.getState().end).toBe(102_395);
  });

  it('plain graph wheel does not zoom; Shift horizontal wheel shares row height with every dataset panel', async () => {
    const other = { ...graphPanel('peer'), contentType: 'dataset', datasetId: 'reads' } as PanelConfig;
    useBrowserStore.setState({ panels: [graphPanel('g1'), other], readRowHeight: 5, fillReadHeight: false });
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={300} />));
    await settle(160); await answerAll();
    const canvas = host.querySelector<HTMLCanvasElement>('[data-testid="graph-panel-canvas"]')!;
    const navigate = vi.spyOn(useBrowserStore.getState(), 'setViewport');
    act(() => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 })));
    await settle(500);
    expect(navigate).not.toHaveBeenCalled();
    act(() => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, shiftKey: true, deltaX: -10, deltaY: 0 })));
    await settle(20);
    const s = useBrowserStore.getState();
    expect(s.readRowHeight).toBeCloseTo(5 * Math.exp(0.02));
    expect(s.panels[0].graphView?.reads?.rowHeight).toBe(s.readRowHeight);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(['split', 'pooled'] as const)('closing a %s host\'s PAT pop-out keeps both bands at full height; one Undo restores the pop-out', async mode => {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    const bound: GraphReadBinding = { dataset_id: 'lifted', label: 'Lifted', kind: 'lifted', revision: 'one',
      paths: { mat: 'chr3_MATERNAL', pat: 'chr3_PATERNAL' }, haps: { mat: 'MAT', pat: 'PAT' }, problems: [], libraries: 1 };
    const reads: GraphRead[] = ['mat', 'pat'].flatMap(b => Array.from({ length: 100 }, (_, i) => ({
      k: `${b}-${i}`, d: 'lifted', lib: 0, q: `${b}-${i}`, rec: 'r', b, c: bound.paths[b], st: '+' as const, sup: false,
      s: 95_000, e: 96_500, cov: [[95_000, 96_500, 0, 1]], ins: [], hap: bound.haps![b],
    })));
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/graph/read_bindings')) return Promise.resolve(respond({ bindings: [bound] }));
      if (url === '/api/graph/reads') return Promise.resolve(respond({ reads, bindings: [], cached: false,
        report: { molecules: 200, records: 200, marks: 0, sampling: { level: 0, fraction: 1, estimated: 200,
          molecules_capped: 0, max_molecules: 300 }, m6a_density_reads: 0, calls_omitted_reads: 0, truncated: false, omitted: {}, shared_qnames: 0 },
        timings: { total_ms: 1 } }));
      return fallback(url, init);
    });
    const base: PanelConfig = { id: 'lift-host', contentType: 'dataset', datasetId: 'lifted', stateKey: 'host-state',
      subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, viewMode: 'graph',
      ...(mode === 'split' ? { liftHap: 'MAT' } : {}) };
    const view = { chrom: 'chr3', start: 97_300, end: 97_500, reference: 'GRCh38' };
    const member: PanelConfig = { ...base, id: 'pat-member', stateKey: 'pat-state', viewMode: 'linear', liftHap: 'PAT',
      graphMemberOf: base.id, collapsedByGraphGroup: base.id, collapsed: true };
    base.graphView = hostGraphView(registration, { registration, binding: bound }, view,
      [{ panelId: base.id, binding: mode === 'split' ? 'mat' : null }, ...(mode === 'split' ? [{ panelId: member.id, binding: 'pat' }] : [])]);
    useGraphBindingsStore.setState({ byDataset: { lifted: [{ registration, binding: bound }] } });
    useBrowserStore.setState({ panels: mode === 'split' ? [base, member] : [base],
      datasets: [{ id: 'lifted', label: 'Lifted', data_type: 'bam_livelift', color: '#123456' } as never],
      ...view, currentGenome: 'GRCh38', clusterAssignments: {}, filteredReadIds: {}, clusterFocus: {}, readSortOrder: {},
      selectedReadIds: {}, _historyStack: [], _historyPointer: -1 });
    await act(async () => root.render(<><GraphPanel panelId={base.id} width={900} height={600} /><span /></>));
    await settle(200);
    await answerAll();
    await settle(20);
    const scene = () => window.__FIBERBROWSER_GRAPH_SCENES__![base.id];
    const bandHeights = () => Object.fromEntries(scene().scene.rows.filter(r => r.bandHeight).map(r => [r.key, r.bandHeight]));
    const before = bandHeights();
    // Only paths that draw reads get a band: the target, without target-aligned reads, has no peak row either.
    expect(Object.keys(before).sort()).toEqual(['mat', 'pat']);
    // Enough overlapping reads to fill the available height, rather than a sparse band's natural size.
    expect(Object.values(before).reduce((a, b) => a + b, 0)).toBeGreaterThan(400);
    let patId = member.id;
    act(() => {
      [patId] = mode === 'split' ? popOut(base.id, [member.id]) : popOut(base.id, [], [{ binding: 'pat', hap: 'PAT' }]);
    });
    const pat = () => useBrowserStore.getState().panels.find(p => p.id === patId)!;
    act(() => useBrowserStore.setState({ clusterAssignments: { [pat().stateKey!]: { 'pat-0': 2 } },
      selectedReadIds: { [pat().stateKey!]: new Set(['pat-0']) }, fullViewPanelId: patId }));
    await act(async () => root.render(<><GraphPanel panelId={base.id} width={900} height={600} />
      <PanelHeader panel={pat()} panelIndex={1} width={800} /></>));
    await settle(20);
    const popped = structuredClone(pat());
    const hostMembers = structuredClone(useBrowserStore.getState().panels[0].graphView!.members);
    const canvas = host.querySelector<HTMLCanvasElement>('canvas')!;
    calls.get(canvas)!.length = 0;
    act(() => host.querySelector<HTMLButtonElement>(`[data-testid="panel-close-${patId}"]`)!.click());
    expect(pat()).toMatchObject({ graphMemberOf: base.id, collapsedByGraphGroup: base.id, collapsed: true });
    expect(useBrowserStore.getState().fullViewPanelId).toBeNull();
    expect(membersOf(useBrowserStore.getState().panels, useBrowserStore.getState().panels[0]).map(m => m.panel.id)).toEqual([base.id, patId]);
    expect(useBrowserStore.getState().panels[0].graphView!.members).toEqual(hostMembers);
    expect(bandHeights()).toEqual(before);
    expect(Object.keys(scene().reads!.lanes).sort()).toEqual(['mat', 'pat']);
    expect(texts(canvas).some(t => t.includes('PAT'))).toBe(true);
    expect(useBrowserStore.getState().activeReadIds[pat().stateKey!]?.length).toBeGreaterThan(0);
    const expectStateKept = () => {
      expect(useBrowserStore.getState().clusterAssignments[pat().stateKey!]).toEqual({ 'pat-0': 2 });
      expect(useBrowserStore.getState().selectedReadIds[pat().stateKey!]).toEqual(new Set(['pat-0']));
    };
    expectStateKept();
    act(() => useBrowserStore.getState().undo());
    expect(pat()).toEqual(popped);
    expect(useBrowserStore.getState().fullViewPanelId).toBe(patId);
    expectStateKept();
    act(() => useBrowserStore.getState().redo());
    await settle(20);
    expect(pat()).toMatchObject({ collapsed: true, collapsedByGraphGroup: base.id });
    expect(bandHeights()).toEqual(before);
    expectStateKept();
  });

  it.each([false, true])('renders an empty legacy graph view with helper availability %s', async helperAvailable => {
    const session = JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/sessions/30x-graph-differences.json'), 'utf8'));
    applyImportedState({ ...session, success: true });
    useGraphStatusStore.setState({ status: { ...available, helper: { ...available.helper, available: helperAvailable }, registrations: [] } });
    await act(async () => root.render(<GraphPanel panelId="panel-graph-view" width={900} height={300} />));
    expect(host.querySelector(helperAvailable ? '[data-testid="graph-panel-empty"]' : '[data-testid="graph-panel-unavailable"]')).not.toBeNull();
    expect(host.querySelector('[data-graph-loading]')?.getAttribute('data-graph-loading')).toBe('false');
    expect(subgraphBodies()).toEqual([]);
    expect((collectFrontendState().panels as PanelConfig[]).find(p => p.contentType === 'graph-view')?.graphView).toEqual({});
  });

  it('initializes an empty legacy graph view when a package is available', async () => {
    useBrowserStore.setState({ panels: [graphPanel('g1', {} as PanelConfig['graphView'])] });
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={300} />));
    expect(useBrowserStore.getState().panels[0].graphView?.registrationId).toBe(registration.id);
    await settle(200);
    expect(subgraphBodies()).toHaveLength(1);
  });

  it('requests graph rows again when a tables-mode scan opens, changes or closes, without reloading topology', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/graph/read_bindings')) return Promise.resolve(respond({ bindings: [
        { dataset_id: 'synthetic', label: 'Synthetic', kind: 'native', revision: 'one', paths: { target: 'chr3' }, problems: [], libraries: 1 },
      ] }));
      if (url === '/api/graph/reads') return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return fallback(url, init);
    });
    useHubData.setState({ scans: [] });
    useBrowserStore.setState({ panels: [graphPanel('g1')], datasets: [{ id: 'synthetic', label: 'Synthetic', data_type: 'bam' } as never] });
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={300} />));
    await settle(160); await answerAll(); await settle(160);
    const requests = () => fetchMock.mock.calls.filter(c => c[0] === '/api/graph/reads').length;
    expect(requests()).toBe(1);
    const topologyRequests = subgraphBodies().length;
    const scan = { scanId: 'table-scan', manifestDigest: 'one', annotate: false, datasets: [{ dataset: 'synthetic', status: 'bound' }] };
    act(() => useHubData.setState({ scans: [scan as never] }));
    await settle(160); expect(requests()).toBe(2);
    act(() => useHubData.setState({ scans: [{ ...scan, manifestDigest: 'two' } as never] }));
    await settle(160); expect(requests()).toBe(3);
    act(() => useHubData.setState({ scans: [] }));
    await settle(160); expect(requests()).toBe(4);
    expect(subgraphBodies()).toHaveLength(topologyRequests);
  });
  it('requests graph rows again when the effective signal filters change (only with signal-tagged datasets)', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/graph/read_bindings')) return Promise.resolve(respond({ bindings: [
        { dataset_id: 'synthetic', label: 'Synthetic', kind: 'native', revision: 'one', paths: { target: 'chr3' }, problems: [], libraries: 1 },
      ] }));
      if (String(url).startsWith('/api/graph/reads')) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return fallback(url, init);
    });
    useHubData.setState({ scans: [] });
    useBrowserStore.setState({ panels: [graphPanel('g1')], signalFilters: { ...DEFAULT_SIGNAL_FILTERS },
      datasets: [{ id: 'synthetic', label: 'Synthetic', data_type: 'bam', signal_tags: true } as never] });
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={300} />));
    await settle(160); await answerAll(); await settle(160);
    const requests = () => fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/graph/reads')).length;
    expect(requests()).toBe(1);
    act(() => useBrowserStore.setState({ signalFilters: { ...DEFAULT_SIGNAL_FILTERS, hideBackground: true } }));
    await settle(160); expect(requests()).toBe(2);
    act(() => useBrowserStore.setState({ signalFilters: { ...DEFAULT_SIGNAL_FILTERS } }));
    await settle(160); expect(requests()).toBe(3);
    // without signal-tagged datasets the filters are inert: no new request
    act(() => useBrowserStore.setState({ datasets: [{ id: 'synthetic', label: 'Synthetic', data_type: 'bam' } as never] }));
    await settle(160);
    const before = requests();
    act(() => useBrowserStore.setState({ signalFilters: { ...DEFAULT_SIGNAL_FILTERS, hideBackground: true } }));
    await settle(160); expect(requests()).toBe(before);
    act(() => useBrowserStore.setState({ signalFilters: { ...DEFAULT_SIGNAL_FILTERS } }));
  });
  it('requests graph rows again when the workspace read settings or quality filters change', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/graph/read_bindings')) return Promise.resolve(respond({ bindings: [
        { dataset_id: 'synthetic', label: 'Synthetic', kind: 'native', revision: 'one', paths: { target: 'chr3' }, problems: [], libraries: 1 },
      ] }));
      if (String(url).startsWith('/api/graph/reads')) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return fallback(url, init);
    });
    useHubData.setState({ scans: [] });
    const colormap = useBrowserStore.getState().activeColormap;
    useBrowserStore.setState({ panels: [graphPanel('g1')], legacyLayerInference: true, legacyNucMinSize: 90,
      hideShortEndFootprints: true, activeColormap: { ...colormap, qualityFilters: [] },
      datasets: [{ id: 'synthetic', label: 'Synthetic', data_type: 'bam' } as never] });
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={300} />));
    await settle(160); await answerAll(); await settle(160);
    const requests = () => fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/graph/reads')).length;
    expect(requests()).toBe(1);
    act(() => useBrowserStore.setState({ legacyLayerInference: false }));
    await settle(160); expect(requests()).toBe(2);
    act(() => useBrowserStore.setState({ legacyNucMinSize: 120 }));
    await settle(160); expect(requests()).toBe(3);
    act(() => useBrowserStore.setState({ hideShortEndFootprints: false }));
    await settle(160); expect(requests()).toBe(4);
    // A quality filter edited locally is not yet the server's: no request until the server confirms it (sync hook).
    act(() => useBrowserStore.setState({ activeColormap: { ...colormap, qualityFilters: [
      { layer: 'nuc', qualityName: 'aq', minValue: 190, enabled: true } as never] } }));
    await settle(160); expect(requests()).toBe(4);
    act(() => useConfirmedQualityFilters.setState({ key: JSON.stringify([{ layer: 'nuc', quality_name: 'aq', min_value: 190 }]), revision: 1 }));
    await settle(160); expect(requests()).toBe(5);
    act(() => useConfirmedQualityFilters.setState({ key: '[]', revision: 2 }));
    await settle(160); expect(requests()).toBe(6);
  });
  it('reloads graph rows once the server confirms new quality settings, never before (delayed settings POST)', async () => {
    let serverFilters = '[]';
    let applyPost: (() => void) | null = null;
    const seen: string[] = [];
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/graph/read_bindings')) return Promise.resolve(respond({ bindings: [
        { dataset_id: 'synthetic', label: 'Synthetic', kind: 'native', revision: 'one', paths: { target: 'chr3' }, problems: [], libraries: 1 },
      ] }));
      if (String(url).startsWith('/api/quality_filters')) {
        const filters = JSON.stringify(JSON.parse(String(init!.body)).filters);
        if (filters === serverFilters) return Promise.resolve(respond({ success: true, changed: false }));
        return new Promise<Response>(resolve => { applyPost = () => { serverFilters = filters; resolve(respond({ success: true, changed: true })); }; });
      }
      if (String(url).startsWith('/api/graph/reads')) {
        // A completed answer, composed with the settings the server has when the request reaches it.
        seen.push(serverFilters);
        return Promise.resolve(respond({ reads: [], bindings: [], cached: false,
          report: { molecules: 0, records: 0, marks: 0, sampling: { level: 0, fraction: 1, estimated: 0, molecules_capped: 0, max_molecules: 300 },
            m6a_density_reads: 0, calls_omitted_reads: 0, truncated: false, omitted: {}, shared_qnames: 0 }, timings: { total_ms: 1 } }));
      }
      return fallback(url, init);
    });
    useHubData.setState({ scans: [] });
    const colormap = useBrowserStore.getState().activeColormap;
    useBrowserStore.setState({ panels: [graphPanel('g1')], activeColormap: { ...colormap, qualityFilters: [] },
      datasets: [{ id: 'synthetic', label: 'Synthetic', data_type: 'bam' } as never] });
    function Sync() {
      useQualityFilterSync(useBrowserStore(s => s.activeColormap?.qualityFilters ?? []), true);
      return null;
    }
    await act(async () => root.render(<><Sync /><GraphPanel panelId="g1" width={900} height={300} /></>));
    await settle(160); await answerAll(); await settle(160);
    const before = seen.length;
    expect(before).toBeGreaterThan(0);
    act(() => useBrowserStore.setState({ activeColormap: { ...colormap, qualityFilters: [
      { layer: 'nuc', qualityName: 'aq', minValue: 190, enabled: true } as never] } }));
    await settle(400);
    // The settings POST has not applied: no graph load went out with the old settings for the new view.
    expect(applyPost).not.toBeNull();
    expect(seen.length).toBe(before);
    await act(async () => { applyPost!(); await vi.advanceTimersByTimeAsync(20); });
    await settle(400);
    expect(seen.length).toBe(before + 1);
    expect(seen[seen.length - 1]).toBe(JSON.stringify([{ layer: 'nuc', quality_name: 'aq', min_value: 190 }]));
  });
  it('a quality edit undone before the server answered (A -> B -> A) still reloads once the server is back on A', async () => {
    let serverFilters = '[]';
    const posts: Array<() => void> = [];
    const seen: string[] = [];
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/graph/read_bindings')) return Promise.resolve(respond({ bindings: [
        { dataset_id: 'synthetic', label: 'Synthetic', kind: 'native', revision: 'one', paths: { target: 'chr3' }, problems: [], libraries: 1 },
      ] }));
      if (String(url).startsWith('/api/quality_filters')) {
        // Applied in the order sent, each when the test lets it.
        const filters = JSON.stringify(JSON.parse(String(init!.body)).filters);
        return new Promise<Response>(resolve => posts.push(() => {
          const changed = filters !== serverFilters;
          serverFilters = filters;
          resolve(respond({ success: true, changed }));
        }));
      }
      if (String(url).startsWith('/api/graph/reads')) {
        seen.push(serverFilters);
        return Promise.resolve(respond({ reads: [], bindings: [], cached: false,
          report: { molecules: 0, records: 0, marks: 0, sampling: { level: 0, fraction: 1, estimated: 0, molecules_capped: 0, max_molecules: 300 },
            m6a_density_reads: 0, calls_omitted_reads: 0, truncated: false, omitted: {}, shared_qnames: 0 }, timings: { total_ms: 1 } }));
      }
      return fallback(url, init);
    });
    useHubData.setState({ scans: [] });
    const colormap = useBrowserStore.getState().activeColormap;
    useBrowserStore.setState({ panels: [graphPanel('g1')], activeColormap: { ...colormap, qualityFilters: [] }, legacyNucMinSize: 90,
      datasets: [{ id: 'synthetic', label: 'Synthetic', data_type: 'bam' } as never] });
    function Sync() {
      useQualityFilterSync(useBrowserStore(s => s.activeColormap?.qualityFilters ?? []), true);
      return null;
    }
    await act(async () => root.render(<><Sync /><GraphPanel panelId="g1" width={900} height={300} /></>));
    await act(async () => { posts.shift()!(); await vi.advanceTimersByTimeAsync(20); });   // the first sync ([]: unchanged)
    await settle(160); await answerAll(); await settle(160);
    const gated = [{ layer: 'nuc', qualityName: 'aq', minValue: 190, enabled: true } as never];
    act(() => useBrowserStore.setState({ activeColormap: { ...colormap, qualityFilters: gated } }));
    await settle(50);
    act(() => useBrowserStore.setState({ activeColormap: { ...colormap, qualityFilters: [] } }));
    await settle(50);
    // The gate reaches the server (its answer is for a superseded edit), and a load goes out while it holds it.
    await act(async () => { posts.shift()!(); await vi.advanceTimersByTimeAsync(20); });
    act(() => useBrowserStore.setState({ legacyNucMinSize: 120 }));
    await settle(400);
    expect(seen[seen.length - 1]).not.toBe('[]');
    // Back to no gate on the server: the rows are asked for again.
    await act(async () => { posts.shift()!(); await vi.advanceTimersByTimeAsync(20); });
    await settle(400);
    expect(seen[seen.length - 1]).toBe('[]');
  });
  it('says the helper is unavailable, with the install hint, and asks for nothing', async () => {
    useGraphStatusStore.setState({ status: { ...available, registrations: [],
      helper: { available: false, source: null, hint: 'Install the graph helper: pip install "fiberbrowser[graph]"', error: 'no graph helper found' } } });
    useBrowserStore.setState({ panels: [graphPanel('g1')] });
    await act(async () => root.render(<GraphPanel panelId="g1" width={800} height={300} />));
    expect(host.querySelector('[data-testid="graph-panel-unavailable"]')?.textContent).toContain('Graph helper unavailable');
    expect(host.querySelector('[data-testid="graph-panel-hint"]')?.textContent).toContain('pip install "fiberbrowser[graph]"');
    await settle(500);
    expect(subgraphBodies()).toEqual([]);
  });

  it('with no BAM, follows the main view and draws the Alu insertions on its own ruler', async () => {
    useBrowserStore.setState({ panels: [graphPanel('g1')] });
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={300} />));
    await settle(0);
    const state = useBrowserStore.getState().panels[0].graphView!;
    expect(state.linkMode).toBe('follow');
    expect(state.registrationId).toBe('galu');
    // A navigation inside the debounce window asks once, for the last view.
    useBrowserStore.setState({ start: 97_300, end: 97_500 });
    await settle(50);
    expect(subgraphBodies()).toEqual([]);
    await settle(120);
    const bodies = subgraphBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ registration_id: 'galu', revisions: registration.revisions, target: 'target',
      interval: { start: 97_300, end: 97_500 }, selected: ['target', 'mat', 'pat'], context_bp: 100, snarls: 'none', generation: 1 });
    expect(bodies[0].request_id).toMatch(/^g1-g1-/);
    await answerAll();
    const canvas = host.querySelector('canvas[data-testid="graph-panel-canvas"]') as HTMLCanvasElement;
    const drawn = texts(canvas);
    expect(drawn).toContain('chr3:97,300-97,500');
    expect(drawn).toContain('+2,353 bp');
    expect(drawn).toContain('+2,350 bp');
    expect(drawn).toEqual(expect.arrayContaining(['target', 'MAT', 'PAT']));
    const panel = host.querySelector('[data-testid="graph-panel"]')!;
    expect(panel.getAttribute('data-graph-lanes')).toBe('target,mat,pat');
    expect(panel.getAttribute('data-graph-complete')).toBe('true');
    expect(host.querySelector('[data-testid="graph-panel-status"]')?.textContent).toMatch(/3 paths · \d+ nodes · \d+ visits · complete/);
    // The trace has every browser stage of that request.
    const trace = graphTraces().at(-1)!;
    expect(trace.respondedAt).toBeGreaterThanOrEqual(trace.dispatchedAt);
    expect(trace.server?.dispatch_ms).toBe(1.2);
  });

  it('small differences: marks by default (zoom-scaled), bubbles from the right-click menu; it reports its natural height', async () => {
    useBrowserStore.setState({ panels: [graphPanel('g1')], start: 92_395, end: 102_395 });
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={600} />));
    await settle(150);
    await answerAll();
    const panel = host.querySelector('[data-testid="graph-panel"]')!;
    expect(Number(panel.getAttribute('data-graph-small-bp'))).toBe(48);   // 10 kb over 840 px: 4 px of bp
    // Natural height: ruler, status line, the target lane full and compact rows for paths whose differences are all
    // marks (the Alu's lead lane is full) — far less than the 600 px body it was given.
    const natural = usePanelContentHeightStore.getState().heights.g1;
    expect(natural).toBeGreaterThan(100);
    expect(natural).toBeLessThan(200);
    const canvas = host.querySelector('canvas[data-testid="graph-panel-canvas"]') as HTMLCanvasElement;
    await act(async () => { canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 20 })); });
    const menu = document.querySelector('[data-testid="graph-panel-menu"]')!;
    expect(menu.textContent).toContain('Show small differences as: marks');
    const open = [...menu.querySelectorAll('*')].find(el => el.textContent?.startsWith('Show small differences as')) as HTMLElement;
    await act(async () => { open.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); open.click(); });
    await settle(0);
    const bubbles = [...document.querySelectorAll('[data-testid="graph-panel-menu"] *')].find(el => el.textContent === 'Bubbles') as HTMLElement;
    expect(bubbles).toBeTruthy();
    await act(async () => { bubbles.click(); });
    await settle(0);
    expect(useBrowserStore.getState().panels[0].graphView!.layoutSettings.smallDifferences).toBe('bubbles');
    expect(panel.getAttribute('data-graph-small-bp')).toBe('0');
    // No new topology request: it is a drawing setting.
    expect(subgraphBodies()).toHaveLength(1);
  });

  it('a newer navigation aborts the running request and cancels its subscriber on the server', async () => {
    useBrowserStore.setState({ panels: [graphPanel('g1')] });
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={300} />));
    await settle(150);
    const first = subgraphBodies()[0];
    useBrowserStore.setState({ start: 91_000, end: 101_000 });
    await settle(150);
    const bodies = subgraphBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].generation).toBe(2);
    const deletes = fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/graph/requests/'));
    expect(deletes.map(c => String(c[0]))).toEqual([`/api/graph/requests/${first.request_id}`]);
    expect((deletes[0][1] as RequestInit).method).toBe('DELETE');
    await answerAll();
    expect(host.querySelector('[data-testid="graph-panel"]')!.getAttribute('data-graph-drawn-start')).toBe('91000');
  });

  it('two panels keep their own viewports: one follows the main view, one navigates on its own', async () => {
    const own = { ...initialGraphView(registration, null), linkMode: 'independent' as const, targetViewport: { contig: 'chr3', start: 5000, end: 6000 } };
    useBrowserStore.setState({ panels: [graphPanel('ga'), graphPanel('gb', own)] });
    await act(async () => root.render(<><GraphPanel panelId="ga" width={600} height={200} /><GraphPanel panelId="gb" width={600} height={200} /></>));
    await settle(150);
    const intervals = () => subgraphBodies().map(b => [b.panel_id, b.interval.start, b.interval.end]);
    expect(intervals()).toEqual(expect.arrayContaining([['ga', 90_000, 100_000], ['gb', 5000, 6000]]));
    await answerAll();
    useBrowserStore.setState({ start: 120_000, end: 130_000 });
    await settle(150);
    expect(intervals().slice(2)).toEqual([['ga', 120_000, 130_000]]);
  });

  it('a restored following panel over another reference navigates on its own and never moves that view', async () => {
    const saved = { ...initialGraphView(registration, { chrom: 'chr3', start: 90_000, end: 100_000, reference: 'hg38' }) };
    expect(saved.linkMode).toBe('follow');
    useBrowserStore.setState({ currentGenome: 'hg19', chrom: 'chr3', start: 200_000, end: 210_000, panels: [graphPanel('g1', saved)] } as any);
    await act(async () => root.render(<GraphPanel panelId="g1" width={900} height={300} />));
    await settle(150);
    const state = useBrowserStore.getState().panels[0].graphView!;
    expect(state.linkMode).toBe('independent');
    expect(state.targetViewport).toEqual(saved.targetViewport);
    expect(subgraphBodies().map(b => b.interval.start)).toEqual([90_000]);
    // Dragging pans the graph panel only.
    const canvas = host.querySelector('canvas[data-testid="graph-panel-canvas"]') as HTMLCanvasElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 900, height: 140, right: 900, bottom: 140, x: 0, y: 0, toJSON() {} } as DOMRect);
    await act(async () => {
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 500, clientY: 60 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 400, clientY: 60 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 400, clientY: 60 }));
    });
    expect(useBrowserStore.getState().start).toBe(200_000);
    expect(useBrowserStore.getState().panels[0].graphView!.targetViewport!.start).toBeGreaterThan(90_000);
  });

  it('a stale saved panel asks for nothing and offers the current package', async () => {
    const saved = { ...initialGraphView(registration, null), graphRevision: 'x'.repeat(64) };
    useBrowserStore.setState({ panels: [graphPanel('g1', saved)] });
    await act(async () => root.render(<GraphPanel panelId="g1" width={600} height={200} />));
    await settle(300);
    expect(host.querySelector('[data-testid="graph-panel-stale"]')?.textContent).toContain('changed since this panel was saved');
    expect(subgraphBodies()).toEqual([]);
  });
});

describe('graph host peak track', () => {
  const ruleId = 'default-accessibility';
  const peak = (start = 97_320, end = 97_350) => ({ start, end, index: 0, layer: 1, score: 0.625, chrom: 'chr3' });
  const scene = () => window.__FIBERBROWSER_GRAPH_SCENES__!['peak-host'].scene;
  const boxes = (index = 0) => Array.from(host.querySelectorAll<HTMLButtonElement>(`[data-testid="graph-peak"][data-peak-index="${index}"]`));
  const peakRows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-testid="graph-peak-row"]'));
  async function openHost() {
    window.__FIBERBROWSER_E2E_EXPOSE_STORE = true;
    const bound: GraphReadBinding = { dataset_id: 'lifted', label: 'Lifted', kind: 'lifted', revision: 'one',
      paths: { mat: 'chr3_MATERNAL', pat: 'chr3_PATERNAL' }, haps: { mat: 'MAT', pat: 'PAT' }, problems: [], libraries: 1 };
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => String(url).startsWith('/api/graph/read_bindings')
      ? Promise.resolve(respond({ bindings: [bound] })) : fallback(url, init));
    const panel: PanelConfig = { id: 'peak-host', contentType: 'dataset', datasetId: 'lifted', stateKey: 'host-state',
      subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, viewMode: 'graph', liftHap: 'MAT' };
    const member: PanelConfig = { ...panel, id: 'peak-member', stateKey: 'member-state', liftHap: 'PAT', viewMode: 'linear',
      graphMemberOf: panel.id, collapsedByGraphGroup: panel.id, collapsed: true };
    panel.graphView = { ...hostGraphView(registration, { registration, binding: bound }, { chrom: 'chr3', start: 90_000, end: 100_000 },
      [{ panelId: panel.id, binding: 'mat' }, { panelId: member.id, binding: 'pat' }]), reads: { show: false, datasets: null } };
    useGraphBindingsStore.setState({ byDataset: { lifted: [{ registration, binding: bound }] } });
    useBrowserStore.setState({ panels: [panel, member], currentGenome: 'GRCh38', peakRules: DEFAULT_PEAK_RULES,
      peaksByRule: {}, selectedPeaks: new Set(), selectedFeatures: [], peakModes: {}, _historyStack: [], _historyPointer: -1,
      datasets: [{ id: 'lifted', label: 'Lifted', data_type: 'bam_livelift', color: '#123456' } as never] });
    await act(async () => root.render(<GraphPanel panelId={panel.id} width={900} height={600} />));
    await settle(200);
    await answerAll();
  }

  it('renders scan results immediately on graph columns with tiers, span/score hover and the shared selection', async () => {
    await openHost();
    expect(boxes()).toHaveLength(0);
    // This is the same action the toolbar scan writes through, after the host is already drawn.
    act(() => useBrowserStore.getState().setPeaksByRule(ruleId, [peak()]));
    expect(new Set(boxes().map(b => b.dataset.path))).toEqual(new Set(['target', 'mat', 'pat']));
    const box = boxes()[0];
    const map = scene().targetMap.find(m => m.t0 <= 97_320 && m.t1 >= 97_350)!;
    const expectedX = map.x0 + (97_320 - map.t0) / (map.t1 - map.t0) * (map.x1 - map.x0);
    expect(parseFloat(box.style.left) + scene().dataLeft).toBeCloseTo(expectedX);
    expect(box.dataset.tier).toBe('2');
    expect(box.title).toContain('chr3:97,320-97,350');
    expect(box.title).toContain('Tier 2 (Medium)');
    expect(box.title).toContain('Score 0.625');
    act(() => useBrowserStore.getState().togglePeakSelection(0));
    expect(boxes().every(b => b.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(boxes()[0].style.borderColor).toBe('rgb(249, 115, 22)');
  });

  it('clicks toggle through the linear store action; Shift/Cmd-click add without losing other picks or modes', async () => {
    await openHost();
    act(() => useBrowserStore.getState().setPeaksByRule(ruleId, [peak(), peak(97_360, 97_370), peak(97_440, 97_460)]));
    const toggle = vi.spyOn(useBrowserStore.getState(), 'togglePeakSelection');
    act(() => boxes()[0].click());
    expect(toggle).toHaveBeenCalledWith(0, 'accessibility');
    expect(useBrowserStore.getState().selectedPeaks).toEqual(new Set([0]));
    act(() => boxes(1)[0].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    act(() => boxes(2)[0].dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })));
    expect(useBrowserStore.getState().selectedPeaks).toEqual(new Set([0, 1, 2]));
    act(() => useBrowserStore.getState().setPeakMode(1, 'nuc'));
    act(() => boxes()[0].click());
    expect(useBrowserStore.getState().selectedPeaks).toEqual(new Set([1, 2]));
    expect(useBrowserStore.getState().peakModes[1]).toBe('nuc');
  });

  it('respects enabled rules, chromosome, genome and folded member scope', async () => {
    await openHost();
    act(() => useBrowserStore.getState().setPeaksByRule(ruleId, [peak(), { ...peak(), chrom: 'chr7' },
      { ...peak(), genome: 'another-assembly' }, { ...peak(), memberPanelId: 'peak-member' },
      { ...peak(), memberPanelId: 'unrelated-panel' }]));
    expect(boxes().length).toBeGreaterThan(0);
    expect(boxes(1)).toHaveLength(0);
    expect(boxes(2)).toHaveLength(0);
    expect(boxes(3).map(b => b.dataset.path)).toEqual(['pat']);
    expect(boxes(4)).toHaveLength(0);
    act(() => useBrowserStore.getState().updatePeakRule(ruleId, { enabled: false }));
    expect(host.querySelectorAll('[data-testid="graph-peak"]')).toHaveLength(0);
    expect(peakRows()).toHaveLength(scene().rows.length);
    act(() => useBrowserStore.getState().updatePeakRule('default-custom', { enabled: false }));
    expect(peakRows()).toHaveLength(0);
  });

  it('shares one fixed-height row per path across rules while preserving member scope and empty rows', async () => {
    await openHost();
    act(() => {
      useBrowserStore.getState().setPeaksByRule(ruleId, [{ ...peak(), memberPanelId: 'peak-host' }]);
      useBrowserStore.getState().setPeaksByRule('default-custom', [{ ...peak(), memberPanelId: 'peak-member' }]);
    });
    expect(peakRows().map(row => row.dataset.path)).toEqual(scene().rows.map(row => row.key));
    for (const row of peakRows()) {
      const path = scene().rows.find(path => path.key === row.dataset.path)!;
      expect(parseFloat(row.style.top)).toBe(path.bandTop);
      expect(parseFloat(row.style.height)).toBe(GRAPH_PEAK_ROW_HEIGHT);
      expect(path.bandHeight).toBe(GRAPH_PEAK_ROW_HEIGHT);
      expect(row.querySelector('span')?.textContent).toBe('Peaks');
    }
    const mat = peakRows().find(row => row.dataset.path === 'mat')!;
    const pat = peakRows().find(row => row.dataset.path === 'pat')!;
    const target = peakRows().find(row => row.dataset.path === 'target')!;
    expect(mat.querySelectorAll('[data-rule-id="default-custom"]')).toHaveLength(0);
    expect(pat.querySelectorAll(`[data-rule-id="${ruleId}"]`)).toHaveLength(0);
    expect(target.querySelectorAll('[data-testid="graph-peak"]')).toHaveLength(0);
    expect(mat.querySelector('span')?.title).toBe('Peaks · Accessibility');
    expect(pat.querySelector('span')?.title).toBe('Peaks · Custom');
    expect(target.querySelector('span')?.title).toBe('Peaks');
    expect(mat.querySelectorAll(`[data-rule-id="${ruleId}"]`).length).toBeGreaterThan(0);
    expect(pat.querySelectorAll('[data-rule-id="default-custom"]').length).toBeGreaterThan(0);
    for (const box of host.querySelectorAll<HTMLButtonElement>('[data-testid="graph-peak"]')) {
      expect(parseFloat(box.style.top)).toBe(2);
      expect(parseFloat(box.style.height)).toBe(GRAPH_PEAK_ROW_HEIGHT - 4);
    }
  });

  it('splits overlapping rules into equal sub-lanes in rule order, using only rules with peaks on that path', async () => {
    await openHost();
    act(() => {
      const s = useBrowserStore.getState();
      useBrowserStore.setState({ peakRules: [...s.peakRules, { ...s.peakRules[0], id: 'empty', name: 'Empty' }] });
      s.setPeaksByRule(ruleId, [peak()]);
      s.setPeaksByRule('default-custom', [{ ...peak(), memberPanelId: 'peak-host' }]);
    });
    expect(peakRows()).toHaveLength(scene().rows.length);
    const mat = peakRows().find(row => row.dataset.path === 'mat')!;
    const first = mat.querySelector<HTMLButtonElement>(`[data-rule-id="${ruleId}"]`)!;
    const second = mat.querySelector<HTMLButtonElement>('[data-rule-id="default-custom"]')!;
    expect(first.style.left).toBe(second.style.left);
    expect(first.style.width).toBe(second.style.width);
    expect(parseFloat(second.style.top) - parseFloat(first.style.top)).toBe(GRAPH_PEAK_ROW_HEIGHT / 2);
    expect(first.style.height).toBe(second.style.height);
    expect(parseFloat(first.style.top) + parseFloat(first.style.height)).toBeLessThanOrEqual(parseFloat(second.style.top));
    expect(parseFloat(second.style.top) + parseFloat(second.style.height)).toBeLessThanOrEqual(GRAPH_PEAK_ROW_HEIGHT);
    expect(first.style.background).not.toBe(second.style.background);
    expect(first.title).toContain('Accessibility · chr3:97,320-97,350');
    expect(second.title).toContain('Custom · chr3:97,320-97,350');
    expect(mat.querySelector('span')?.title).toBe('Peaks · Accessibility, Custom');
    for (const row of peakRows().filter(row => row !== mat)) {
      const box = row.querySelector<HTMLButtonElement>('[data-testid="graph-peak"]')!;
      expect(parseFloat(box.style.top)).toBe(2);
      expect(parseFloat(box.style.height)).toBe(GRAPH_PEAK_ROW_HEIGHT - 4);
    }
  });

  it('uses the full row height for rules whose peaks do not overlap', async () => {
    await openHost();
    act(() => {
      useBrowserStore.getState().setPeaksByRule(ruleId, [peak()]);
      useBrowserStore.getState().setPeaksByRule('default-custom', [peak(97_440, 97_460)]);
    });
    for (const row of peakRows()) {
      expect(row.querySelectorAll('[data-testid="graph-peak"]')).toHaveLength(2);
      for (const box of row.querySelectorAll<HTMLButtonElement>('[data-testid="graph-peak"]')) {
        expect(parseFloat(box.style.top)).toBe(2);
        expect(parseFloat(box.style.height)).toBe(GRAPH_PEAK_ROW_HEIGHT - 4);
      }
    }
  });

  it('draws an insertion-anchored peak over occurrence columns only on its carrying paths', async () => {
    await openHost();
    const slot = scene().targetMap.find(m => m.kind === 'slot' && Math.abs(m.x1 - m.x0) > 20)!;
    expect(slot).toBeDefined();
    act(() => useBrowserStore.getState().setPeaksByRule(ruleId, [{ ...peak(slot.t0 - 10, slot.t0 + 10), graph: { kind: 'insertion' } }]));
    const carriers = scene().occurrences.filter(o => o.x0 < Math.max(slot.x0, slot.x1) && o.x1 > Math.min(slot.x0, slot.x1));
    expect(boxes().length).toBeGreaterThan(0);
    expect(boxes().some(b => b.dataset.path === 'target')).toBe(false);
    expect(new Set(boxes().map(b => b.dataset.path))).toEqual(new Set(carriers.map(o => o.path)));
    for (const b of boxes()) {
      const x = parseFloat(b.style.left) + scene().dataLeft;
      expect(carriers.some(o => o.path === b.dataset.path && Math.abs(x - o.x0) < 0.01)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(Math.min(slot.x0, slot.x1));
      expect(x + parseFloat(b.style.width)).toBeLessThanOrEqual(Math.max(slot.x0, slot.x1));
    }
  });

  it('keeps picks and modes through Linear ⇄ Graph and pop-out/fold; the linear track selects the same peaks', async () => {
    await openHost();
    act(() => useBrowserStore.getState().setPeaksByRule(ruleId, [peak()]));
    act(() => boxes()[0].click());
    act(() => useBrowserStore.getState().setPeakMode(0, 'nuc'));
    act(() => { expect(setPanelViewMode('peak-host', 'linear')).toBeNull(); });
    await act(async () => root.render(<FireTrack width={900} height={50} />));
    expect(useBrowserStore.getState().selectedPeaks).toEqual(new Set([0]));
    expect(useBrowserStore.getState().peakModes[0]).toBe('nuc');
    act(() => { expect(setPanelViewMode('peak-host', 'graph')).toBeNull(); });
    await act(async () => root.render(<GraphPanel panelId="peak-host" width={900} height={600} />));
    await settle(200);
    await answerAll();
    expect(boxes().every(b => b.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(boxes().length).toBeGreaterThan(0);
    act(() => { popOut('peak-host', ['peak-member']); });
    act(() => useBrowserStore.getState().setActiveReadIds('member-state', ['q']));
    await act(async () => root.render(<><GraphPanel panelId="peak-host" width={900} height={600} />
      <FireTrack width={900} height={50} readsKey="member-state" /></>));
    // Peak rows occupy their own band, before the read renderer's inset.
    expect(peakRows()).toHaveLength(scene().rows.length);
    for (const row of peakRows()) expect(parseFloat(row.style.height)).toBe(GRAPH_PEAK_ROW_HEIGHT);
    const linear = host.querySelectorAll('canvas')[1];
    // The linear track toggles off the peak clicked in the graph (97,335 in a 90,000–100,000 view).
    act(() => linear.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 660, clientY: 20 })));
    expect(useBrowserStore.getState().selectedPeaks.size).toBe(0);
    expect(boxes().every(b => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    act(() => { foldIn('peak-host', ['peak-member']); });
    act(() => boxes()[0].click());
    expect(useBrowserStore.getState().selectedPeaks).toEqual(new Set([0]));
    expect(boxes().every(b => b.getAttribute('aria-pressed') === 'true')).toBe(true);
  });
});

describe('screen coordinates', () => {
  it('a canvas inside an insertion-expanded reference surface is not projected in screen mode', () => {
    const surface = document.createElement('div');
    const canvas = document.createElement('canvas');
    surface.appendChild(canvas);
    document.body.appendChild(surface);
    const axis = makeAxis(97_300, 97_500, 600, false, [{ ins_id: 'mat:1', pos: 97_395, length: 2353, hap_label: 'MAT' } as any]);
    expect(axis.blocks).toHaveLength(1);
    setReferenceSurface(surface, { axis, start: 97_300, end: 97_500, width: 600, gutter: 0 });
    const raw = canvas.getContext('2d');
    const projected = setupHighDpiCanvas(canvas, 600, 50);
    const screen = setupHighDpiCanvas(canvas, 600, 50, { coordinates: 'screen' });
    expect(projected).not.toBe(raw);          // the linear tracks' replay through the expanded axis
    expect(screen).toBe(raw);                 // the graph panel draws exactly where it says
    surface.remove();
  });
});
