/**
 * Sort by position in graph mode (DESIGN_GRAPH_PRIMARY §3.2 "Sort by position → first carried column"; §2.3 frame
 * order): a host's sub-band without a sort or clusters orders its rows by the first graph column each record carries
 * within the view, in canonical walk order, never by pixels (a mirrored panel, or a first visit the scene does not
 * draw, would reorder them).
 *
 * - **Canonical walk.** The target's walk ranks the nodes it visits; a node off the target ranks by the walk of its
 *   first carrier in binding order, right after the last ranked node before it on that walk.
 * - **Offset.** Within a node, columns run along the canonical walk's orientation of that node.
 * - **Carried.** Only bases inside an occurrence's clip (the view) and the record's coverage count.
 */
import type { GraphOccurrence, GraphRead, GraphTopology, Span } from './types';

/** A column's place in canonical walk order: [anchor rank, carrier path order, step after the anchor, offset]. */
export type ColumnKey = readonly [number, number, number, number];

export interface CanonicalWalk {
  /** Node id -> its rank and the canonical orientation of the node (true: the walk traverses it reversed). */
  nodes: Map<string, { rank: readonly [number, number, number]; reverse: boolean }>;
  /** Binding -> its occurrences in path order. */
  occurrences: Map<string, GraphOccurrence[]>;
}

/** The canonical walk of a topology. `bindingOrder`: the package's binding order (default: the topology's paths). */
export function canonicalWalk(topology: GraphTopology, bindingOrder?: readonly string[]): CanonicalWalk {
  const occurrences = new Map<string, GraphOccurrence[]>();
  for (const p of topology.paths) {
    occurrences.set(p.binding, [...p.occurrences].sort((a, b) => a.path_span.start - b.path_span.start || a.path_span.end - b.path_span.end));
  }
  const nodes: CanonicalWalk['nodes'] = new Map();
  let rank = 0;
  for (const o of occurrences.get(topology.target) ?? []) {
    if (!nodes.has(o.node)) nodes.set(o.node, { rank: [rank++, 0, 0], reverse: o.reverse });
  }
  const order = (key: string) => { const i = bindingOrder?.indexOf(key) ?? -1; return i < 0 ? 1e6 + topology.paths.findIndex(p => p.binding === key) : i; };
  const others = topology.paths.map(p => p.binding).filter(b => b !== topology.target).sort((a, b) => order(a) - order(b));
  others.forEach((b, pi) => {
    let anchor = -1, step = 0;
    for (const o of occurrences.get(b) ?? []) {
      const known = nodes.get(o.node);
      if (known) { if (known.rank[1] === 0 && known.rank[2] === 0) { anchor = known.rank[0]; step = 0; } continue; }
      nodes.set(o.node, { rank: [anchor, pi + 1, ++step], reverse: o.reverse });
    }
  });
  return { nodes, occurrences };
}

const intersect = (a: Span, b: Span): Span | null => {
  const s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
  return e > s ? { start: s, end: e } : null;
};

export function compareColumnKeys(a: ColumnKey | null | undefined, b: ColumnKey | null | undefined): number {
  if (!a || !b) return (a ? 0 : 1) - (b ? 0 : 1);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

/** The first column a record carries in the view (null: none, e.g. its path is not in the topology). */
export function firstCarriedColumn(read: Pick<GraphRead, 'b' | 's' | 'e' | 'cov'>, walk: CanonicalWalk): ColumnKey | null {
  const occs = walk.occurrences.get(read.b);
  if (!occs?.length) return null;
  const cov: Span[] = read.cov.map(([a, b]) => ({ start: a, end: b }));
  let best: ColumnKey | null = null;
  for (const o of occs) {
    if (o.path_span.end <= read.s) continue;
    if (o.path_span.start >= read.e) break;
    const node = walk.nodes.get(o.node);
    if (!node) continue;
    // The clip is in the path's traversal of the node: path coordinates from the visit's start.
    const clip = { start: o.path_span.start + o.clip.start, end: o.path_span.start + o.clip.end };
    const len = o.path_span.end - o.path_span.start;
    for (const c of cov) {
      const sl = intersect(c, clip);
      if (!sl) continue;
      // Node-forward slice [a, b), then the first base along the canonical orientation of the node.
      const a = o.reverse ? o.path_span.end - sl.end : sl.start - o.path_span.start;
      const b = o.reverse ? o.path_span.end - sl.start : sl.end - o.path_span.start;
      const key: ColumnKey = [node.rank[0], node.rank[1], node.rank[2], node.reverse ? len - b : a];
      if (compareColumnKeys(key, best) < 0) best = key;
    }
  }
  return best;
}

/** Every record's first carried column (by record key `k`). */
export function firstCarriedColumns(reads: Iterable<Pick<GraphRead, 'k' | 'b' | 's' | 'e' | 'cov'>>, topology: GraphTopology,
  bindingOrder?: readonly string[]): Map<string, ColumnKey | null> {
  const walk = canonicalWalk(topology, bindingOrder);
  const out = new Map<string, ColumnKey | null>();
  for (const r of reads) out.set(r.k, firstCarriedColumn(r, walk));
  return out;
}
