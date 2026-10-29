/**
 * The graph-view panel rendered (Gate B): "Graph helper unavailable" with its install hint; a panel with no BAM that
 * follows the main view and draws the real Alu topology on its own ruler; debounced requests with superseded ones
 * aborted and cancelled on the server; two panels with independent viewports; and a linear panel's insertion
 * expansion that cannot reach its canvas.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import alu from './__fixtures__/alu.topology.json';
import { GraphPanel } from './GraphPanel';
import { useGraphStatusStore } from './statusStore';
import { useBrowserStore } from '../../stores/browserStore';
import { setupHighDpiCanvas } from '../../utils/canvasUtils';
import { setReferenceSurface } from '../differences/referenceCanvas';
import { makeAxis } from '../differences/axis';
import { initialGraphView } from './state';
import { clearGraphTraces, graphTraces } from './timings';
import { usePanelContentHeightStore } from '../../stores/panelContentHeightStore';
import { useHubData } from '../hub/hubData';
import type { GraphBinding, GraphRegistration, GraphStatus } from './types';
import type { PanelConfig } from '../../types';

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
