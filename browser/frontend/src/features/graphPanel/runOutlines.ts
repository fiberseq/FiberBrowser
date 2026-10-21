/**
 * A graph run's regions on the tube (DESIGN_GRAPH_PRIMARY §3.3): each region's target span is outlined across the
 * lanes it applies to; a carrier-only part (an insertion only some paths carry) is outlined on its carriers' lanes
 * only, where their visits of its nodes are drawn. Computed from the run's own report (the server's columns), so the
 * outlines say what the fit used, whatever the layout packs.
 */
import type { ClusterMatchedRun } from '../../utils/clusterMatchedRun';
import { useBrowserStore } from '../../stores/browserStore';
import { xForTarget, type Scene } from './scene';

export interface RunOutline { x0: number; x1: number; y0: number; y1: number; kind: 'region' | 'carrier' }

interface ColumnFeature { kind: string; region: number; nodes?: string[]; carriers?: string[] }

/** The outlines of a graph run on a host's scene (empty: not this host's target, or no run). */
export function runOutlines(run: ClusterMatchedRun | null | undefined, scene: Scene | null, registrationId: string | null,
  target: string | null, reversed = false): RunOutline[] {
  const g = run?.graph;
  if (!g || !scene || !target || g.registrationId !== registrationId || g.target !== target || !scene.rows.length) return [];
  const out: RunOutline[] = [];
  const top = scene.rows[0].top;
  const bottom = Math.max(...scene.rows.map(r => Math.max(r.top + r.height, r.bandTop + r.bandHeight)));
  for (const r of g.regions) {
    const a = xForTarget(scene.targetMap, r.start, 'start', reversed);
    const b = xForTarget(scene.targetMap, r.end, 'end', reversed);
    if (a == null || b == null) continue;
    out.push({ x0: Math.min(a, b), x1: Math.max(a, b), y0: top, y1: bottom, kind: 'region' });
  }
  const cols = (g.columns ?? {}) as { shared?: ColumnFeature[]; carrier_sets?: { carriers: string[]; features: ColumnFeature[] }[] };
  const bindingOf = new Map(g.observations.map(o => [o.id, o.binding ?? null]));
  const parts: { nodes: Set<string>; lanes: Set<string> | null }[] = [];
  for (const f of cols.shared ?? []) if (f.kind === 'insertion' && f.nodes?.length) parts.push({ nodes: new Set(f.nodes), lanes: null });
  for (const cs of cols.carrier_sets ?? []) {
    const lanes = new Set(cs.carriers.map(c => bindingOf.get(c)).filter((b): b is string => Boolean(b)));
    for (const f of cs.features) if (f.kind === 'insertion' && f.nodes?.length) parts.push({ nodes: new Set(f.nodes), lanes });
  }
  for (const part of parts) {
    const byLane = new Map<string, [number, number]>();
    for (const o of scene.occurrences) {
      if (!part.nodes.has(o.node) || (part.lanes && !part.lanes.has(o.path))) continue;
      const span = byLane.get(o.lane);
      byLane.set(o.lane, span ? [Math.min(span[0], o.x0), Math.max(span[1], o.x1)] : [o.x0, o.x1]);
    }
    for (const [lane, [x0, x1]] of byLane) {
      const row = scene.rows.find(r => r.key === lane);
      if (row) out.push({ x0, x1, y0: row.top, y1: row.top + row.height, kind: 'carrier' });
    }
  }
  return out;
}

export function drawRunOutlines(ctx: CanvasRenderingContext2D, outlines: RunOutline[]): void {
  if (!outlines.length) return;
  ctx.save();
  for (const o of outlines) {
    if (o.kind === 'region') {
      ctx.fillStyle = 'rgba(217, 119, 6, 0.07)';
      ctx.fillRect(o.x0, o.y0, Math.max(1, o.x1 - o.x0), o.y1 - o.y0);
    }
    ctx.strokeStyle = o.kind === 'region' ? 'rgba(217, 119, 6, 0.85)' : 'rgba(124, 58, 237, 0.9)';
    ctx.setLineDash(o.kind === 'region' ? [4, 3] : [2, 2]);
    ctx.lineWidth = 1.25;
    ctx.strokeRect(o.x0 + 0.5, o.y0 + 0.5, Math.max(1, o.x1 - o.x0 - 1), o.y1 - o.y0 - 1);
  }
  ctx.restore();
}

/** A region drawn on a host's graph (Alt/Option-drag): a custom peak on the target contig, selected. */
export function addGraphRegion(start: number, end: number, contig: string): void {
  const st = useBrowserStore.getState();
  st.addCustomPeak(start, end, contig);
  const ruleId = useBrowserStore.getState().getCustomRuleId();
  const peak = useBrowserStore.getState().getAllPeaks().find(p => p.ruleId === ruleId && p.start === start && p.end === end);
  if (peak && !useBrowserStore.getState().selectedPeaks.has(peak.index)) useBrowserStore.getState().togglePeakSelection(peak.index);
}
