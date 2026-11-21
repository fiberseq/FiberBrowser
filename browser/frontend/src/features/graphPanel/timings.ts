/**
 * Navigation-to-topology traces (DESIGN_GRAPH_PANEL.md §7): every stage of one graph request, measured in the
 * browser from the navigation that asked for it to the paint that showed it. Kept in memory (the last 500);
 * the e2e spec reads them from `window.__FIBERBROWSER_GRAPH_TRACES__`.
 */
export interface GraphTrace {
  panelId: string;
  generation: number;
  interval: { start: number; end: number };
  /** performance.now() marks. */
  navigatedAt: number;
  dispatchedAt: number;
  respondedAt?: number;
  laidOutAt?: number;
  /** The joint layout's own compute time (model + scene), ms. */
  layoutMs?: number;
  paintedAt?: number;
  /** Server-side: queue, helper dispatch → frame, total; bytes; cache hit. */
  server?: { queue_ms?: number; dispatch_ms?: number; total_ms?: number; startup_ms?: number | null; frame_bytes?: number };
  cached?: boolean;
  outcome?: 'painted' | 'superseded' | 'error';
  error?: string;
}

const traces: GraphTrace[] = [];
const MAX_TRACES = 500;

declare global {
  interface Window { __FIBERBROWSER_GRAPH_TRACES__?: GraphTrace[] }
}

export function startTrace(panelId: string, generation: number, interval: { start: number; end: number }, navigatedAt: number): GraphTrace {
  const trace: GraphTrace = { panelId, generation, interval, navigatedAt, dispatchedAt: performance.now() };
  traces.push(trace);
  if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
  if (typeof window !== 'undefined') window.__FIBERBROWSER_GRAPH_TRACES__ = traces;
  return trace;
}

export function graphTraces(): readonly GraphTrace[] {
  return traces;
}

export function clearGraphTraces(): void {
  traces.length = 0;
}
