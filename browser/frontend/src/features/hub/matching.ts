/**
 * Matching hub hits across frames ("find shared", DESIGN §5.4). Two hits of one feature type from different frames
 * (a scan in this genome and a lifted scan of an assembly, or the MAT and PAT hits of one scan) are the same feature
 * when:
 *
 * - in this genome's coordinates (each hit's own, or its lift), their intervals overlap by at least 50% reciprocally;
 *   a point feature (zero width) matches when the anchors are at most `D_MATCH` bp apart;
 * - or, on a graph package's columns, their column sets overlap by at least 50% reciprocally. This is how hits inside
 *   an insertion (no place on this genome) match: only hits on paths that carry those columns can share them.
 *
 * Hits of one set in one frame are never matched to each other (a scan reports each feature once per frame). A hit
 * whose lift is split is matched by its kept placement, like any other.
 */
import { sameChrom } from '../../utils/chromAliases';
import { displaySpan, type Placeable } from './frames';
import type { Frame, GraphAlias } from './types';

export const D_MATCH = 20;
export const MIN_RECIPROCAL = 0.5;

export interface Matchable extends Placeable {
  key: string;
  setId: string;
  typeId: string;
  frame?: Frame;
  graph?: GraphAlias;
}

/** A hit's frame, for "different frames": this genome, or a source contig (its haplotype). */
export function frameKey(h: Matchable): string {
  return h.frame?.kind === 'source' ? `source:${h.frame.contig}` : 'genome';
}

function reciprocal(a0: number, a1: number, b0: number, b1: number): boolean {
  const ov = Math.min(a1, b1) - Math.max(a0, b0);
  if (ov <= 0) return false;
  return ov >= MIN_RECIPROCAL * (a1 - a0) && ov >= MIN_RECIPROCAL * (b1 - b0);
}

/** Whether two hits match in this genome's coordinates. */
export function matchInGenome(a: Matchable, b: Matchable): boolean {
  const x = displaySpan(a), y = displaySpan(b);
  if (!x || !y || x.insertion || y.insertion || !sameChrom(x.chrom, y.chrom)) return false;
  if (x.end <= x.start || y.end <= y.start) return Math.abs(x.anchor - y.anchor) <= D_MATCH;
  return reciprocal(x.start, x.end, y.start, y.end);
}

/** Bases two column lists share ([node, o0, o1) runs). */
function sharedColumns(a: GraphAlias['columns'], b: GraphAlias['columns']): number {
  const byNode = new Map<string, Array<[number, number]>>();
  for (const [node, o0, o1] of b) byNode.set(node, [...(byNode.get(node) ?? []), [o0, o1]]);
  let n = 0;
  for (const [node, o0, o1] of a) for (const [p0, p1] of byNode.get(node) ?? []) n += Math.max(0, Math.min(o1, p1) - Math.max(o0, p0));
  return n;
}

/** Whether two hits match on graph columns (the same package). */
export function matchInGraph(a: Matchable, b: Matchable): boolean {
  const g = a.graph, h = b.graph;
  if (!g || !h || g.registration !== h.registration || !g.size || !h.size) return false;
  const shared = sharedColumns(g.columns, h.columns);
  return shared > 0 && shared >= MIN_RECIPROCAL * g.size && shared >= MIN_RECIPROCAL * h.size;
}

export function sameFeature(a: Matchable, b: Matchable): boolean {
  if (a.key === b.key || a.typeId !== b.typeId) return false;
  if (a.setId === b.setId && frameKey(a) === frameKey(b)) return false;
  return matchInGenome(a, b) || matchInGraph(a, b);
}

/** `{hit key: keys of the hits that are the same feature in another frame or set}`. */
export function matchHits(hits: Matchable[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const byType = new Map<string, Matchable[]>();
  for (const h of hits) byType.set(h.typeId, [...(byType.get(h.typeId) ?? []), h]);
  for (const list of byType.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!sameFeature(list[i], list[j])) continue;
        out.set(list[i].key, [...(out.get(list[i].key) ?? []), list[j].key]);
        out.set(list[j].key, [...(out.get(list[j].key) ?? []), list[i].key]);
      }
    }
  }
  return out;
}
