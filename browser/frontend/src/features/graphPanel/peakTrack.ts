import type { FirePeak } from '../../types';
import type { Scene } from './scene';

export const GRAPH_PEAK_ROW_HEIGHT = 16;
export const GRAPH_PEAK_SELECTED_COLOR = '#f97316';

export interface GraphPeakSpan { x0: number; x1: number }

/** Target spans use the piecewise map, never the viewport's average bp/pixel scale. An insertion's
 * anchor has no target bases: draw only the actual occurrence columns carried by this path in its slot.
 * Use path, not lane: folded family members have placements in their lead's lane. */
export function graphPeakSpans(scene: Scene, peak: FirePeak, path: string): GraphPeakSpan[] {
  const spans: GraphPeakSpan[] = [];
  for (const m of scene.targetMap) {
    if (m.kind === 'slot') {
      if (m.t0 < peak.start || m.t0 >= peak.end) continue;
      const left = Math.min(m.x0, m.x1), right = Math.max(m.x0, m.x1);
      // A small insertion drawn as a mark has a zero-width target slot. Its allele visits still
      // have real placements over the mark; don't pick up neighbouring target visits at this x.
      const marked = new Set<string>();
      if (right === left) for (const h of scene.hits) {
        if (h.payload.kind !== 'slot' || h.payload.group.target?.start !== m.t0 || left < h.x0 || left > h.x1) continue;
        for (const a of h.payload.group.alts.flatMap(a => [a, ...(a.family?.members ?? [])])) {
          for (const v of [...a.visits, ...Object.values(a.byCarrier ?? {}).flat()]) marked.add(v.occ.id);
        }
      }
      for (const o of scene.occurrences) {
        if (o.path !== path) continue;
        if (marked.has(o.occ)) { spans.push({ x0: o.x0, x1: o.x1 }); continue; }
        const x0 = Math.max(left, o.x0), x1 = Math.min(right, o.x1);
        if (x1 > x0) spans.push({ x0, x1 });
      }
    } else if (peak.graph?.kind !== 'insertion' && m.t1 > m.t0) {
      const start = Math.max(peak.start, m.t0), end = Math.min(peak.end, m.t1);
      if (end <= start) continue;
      const at = (t: number) => m.x0 + (t - m.t0) / (m.t1 - m.t0) * (m.x1 - m.x0);
      const a = at(start), b = at(end);
      spans.push({ x0: Math.min(a, b), x1: Math.max(a, b) });
    }
  }
  // One hit per contiguous piece, even when several node visits share its columns.
  const merged: GraphPeakSpan[] = [];
  for (const span of spans.sort((a, b) => a.x0 - b.x0)) {
    const last = merged[merged.length - 1];
    if (last && span.x0 <= last.x1 + 0.01) last.x1 = Math.max(last.x1, span.x1);
    else merged.push({ ...span });
  }
  return merged;
}

export function graphPeakTitle(peak: FirePeak, chrom: string, ruleName: string): string {
  const tier = ['Strong', 'Medium', 'Weak', 'Rare'][peak.layer ?? 0] ?? String((peak.layer ?? 0) + 1);
  return `${ruleName} · ${peak.chrom ?? chrom}:${peak.start.toLocaleString('en-US')}-${peak.end.toLocaleString('en-US')} · Tier ${(peak.layer ?? 0) + 1} (${tier}) · Score ${peak.score == null ? '—' : peak.score.toFixed(3)}${peak.graph?.kind === 'insertion' ? ' · insertion' : ''}`;
}
