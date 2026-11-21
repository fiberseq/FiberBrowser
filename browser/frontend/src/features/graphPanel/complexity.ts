/**
 * The complexity hand-off (DESIGN_GRAPH_PRIMARY §7.2; graph primary G7). Besides the width rule, a host draws
 * linear when more than half of its window's target span is unresolved in the topology, and returns to the graph
 * once less than 30% is. It is judged on the topology (never on how the scene packs it), so zooming and display
 * packing never trigger it.
 *
 * A target base is unresolved when the target path has no visit there (a coverage gap, an open end), or when no
 * compared path with a plan has a resolved correspondence covering it (a map anchor or an inferred fill). A compared
 * path without a plan is not counted. A helper limit cut (a `*_limit` summary, such as the selected-node limit at
 * chr21 50 kb) leaves the whole window unresolved: what the helper returned is a truncated walk.
 *
 * While the host is drawn linear for this reason its graph body is not mounted, so the hand-off controller asks the
 * topology for the settled window itself (`probeComplexity`) to know when to come back.
 */
import { create } from 'zustand';
import type { GraphTopology, GraphViewState, Span } from './types';
import { querySubgraph } from './api';
import type { PanelConfig } from '../../types';

export const COMPLEXITY_OUT = 0.5;
export const COMPLEXITY_IN = 0.3;

function union(spans: Span[], clip: Span): Span[] {
  const parts = spans.map(s => ({ start: Math.max(s.start, clip.start), end: Math.min(s.end, clip.end) }))
    .filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of parts) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end); else out.push({ ...s });
  }
  return out;
}

const RESOLVED = new Set(['map_anchor', 'inferred_fill']);

/** The fraction (0–1) of a topology's target window that is unresolved. */
export function unresolvedFraction(topology: GraphTopology): number {
  const w = topology.interval;
  const width = w.end - w.start;
  if (width <= 0) return 0;
  if ((topology.summaries ?? []).some(s => typeof s.reason === 'string' && s.reason.endsWith('_limit'))) return 1;
  const target = topology.paths.find(p => p.binding === topology.target);
  const seen = union((target?.occurrences ?? []).map(o => o.path_span), w);
  // Compared paths with a plan: target spans their resolved correspondences cover.
  const compared = topology.paths.filter(p => p.binding !== topology.target && p.plan);
  const covered = compared.map(p => union((p.plan!.candidates ?? []).filter(c => RESOLVED.has(c.correspondence)).map(c => c.target), w));
  // Unresolved bp: outside the target's visits, or outside some compared path's resolved spans.
  const cuts = new Set<number>([w.start, w.end]);
  for (const list of [seen, ...covered]) for (const s of list) { cuts.add(s.start); cuts.add(s.end); }
  const xs = [...cuts].sort((a, b) => a - b);
  const inside = (list: Span[], x: number) => list.some(s => s.start <= x && x < s.end);
  let bad = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], b = xs[i + 1];
    if (b <= a) continue;
    if (!inside(seen, a) || covered.some(list => !inside(list, a))) bad += b - a;
  }
  return bad / width;
}

/** What the complexity rule wants, from what the host shows (null: no opinion, the fraction is not known). */
export function complexityShown(prev: 'graph' | 'linear', fraction: number | null | undefined, byComplexity: boolean): 'graph' | 'linear' | null {
  if (fraction == null) return null;
  if (prev === 'graph') return fraction > COMPLEXITY_OUT ? 'linear' : 'graph';
  // Linear for this reason: back below 30%. Linear for another (the width): this rule does not hold it there.
  if (!byComplexity) return fraction > COMPLEXITY_OUT ? 'linear' : 'graph';
  return fraction < COMPLEXITY_IN ? 'graph' : 'linear';
}

export const viewKey = (v: { chrom: string; start: number; end: number }) => `${v.chrom}:${v.start}-${v.end}`;

/** What a judgement is of: the whole topology request (package and revision, target, paths, context) at a window,
 * so a changed path selection or package is judged again (Codex G7 review). */
export function judgmentKey(gv: GraphViewState | undefined | null, v: { chrom: string; start: number; end: number }): string {
  return JSON.stringify([gv?.registrationId ?? null, gv?.packageRevision ?? null, gv?.targetBinding ?? null, gv?.selectedPathKeys ?? [],
    gv?.layoutSettings?.contextBp ?? 0, viewKey(v)]);
}

interface ComplexityState {
  /** Per host: the topology request (judgmentKey) it was judged for, and the unresolved fraction there. */
  byHost: Record<string, { view: string; fraction: number }>;
  set: (hostId: string, view: string, fraction: number) => void;
}

export const useGraphComplexity = create<ComplexityState>(set => ({
  byHost: {},
  set: (hostId, view, fraction) => set(s => {
    const prev = s.byHost[hostId];
    if (prev && prev.view === view && prev.fraction === fraction) return s;
    return { byHost: { ...s.byHost, [hostId]: { view, fraction } } };
  }),
}));

/** The host's unresolved fraction for its window and topology request (undefined: not judged for them). */
export function complexityFor(host: PanelConfig, view: { chrom: string; start: number; end: number }): number | undefined {
  const c = useGraphComplexity.getState().byHost[host.id];
  return c && c.view === judgmentKey(host.graphView, view) ? c.fraction : undefined;
}

const probing = new Map<string, AbortController>();

/** Ask the topology of a linear host's settled window (its graph body is not mounted) and record its fraction. */
export function probeComplexity(host: PanelConfig, view: { chrom: string; start: number; end: number },
  reg: { id: string; revisions: { package: string; graph: string; db: string; maps: string } }): void {
  const gv = host.graphView;
  if (!gv?.targetBinding) return;
  const key = judgmentKey(gv, view);
  const running = probing.get(host.id);
  if (running) running.abort();
  const controller = new AbortController();
  probing.set(host.id, controller);
  const requestId = `${host.id.replace(/[^A-Za-z0-9._:-]/g, '_').slice(-40)}-cx-${Math.random().toString(36).slice(2, 8)}`;
  querySubgraph({ registrationId: reg.id, revisions: reg.revisions, requestId, panelId: `${host.id}#complexity`, generation: 0,
    target: gv.targetBinding, interval: { start: view.start, end: view.end }, selected: gv.selectedPathKeys,
    contextBp: gv.layoutSettings.contextBp, flankBp: 1 }, controller.signal)
    .then(r => { if (probing.get(host.id) === controller) { probing.delete(host.id); useGraphComplexity.getState().set(host.id, key, unresolvedFraction(r.result)); } })
    .catch(err => {
      if (probing.get(host.id) !== controller) return;
      probing.delete(host.id);
      // The helper refused the window as too complex: unresolved, as the graph body records it (agy G7 review).
      if (err?.error?.code === 'complexity_limit') useGraphComplexity.getState().set(host.id, key, 1);
    });
}
