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
  /** Node id -> its rank and canonical orientation at its first canonical visit (true: the walk traverses it
   * reversed). */
  nodes: Map<string, { rank: readonly [number, number, number]; reverse: boolean }>;
  /** Occurrence id -> the rank and canonical orientation of that visit (a repeated node ranks per visit). */
  visits: Map<string, { rank: readonly [number, number, number]; reverse: boolean }>;
  /** Binding -> its occurrences in path order. */
  occurrences: Map<string, GraphOccurrence[]>;
}

/**
 * The canonical walk of a topology. `bindingOrder`: the package's binding order (default: the topology's paths).
 *
 * - Target visits rank by visit, in walk order (a node the target walks twice has two ranks).
 * - A carrier path is walked in the target's frame order: its baseline parity is the orientation carrying most of
 *   its matched bp (the helper's direct matches, else shared nodes; a minus-parity carrier is walked backwards, as
 *   layout.ts frames it).
 * - A carrier visit takes the target visit it is matched to: the helper's direct match when there is exactly one and
 *   the carrier walks the node once or along its baseline; else a node both walk once (an inverted run keeps its
 *   target ranks and orientation, whatever order the carrier walks it in); else, for a node either walks more than
 *   once, the first unclaimed target visit after the carrier's last anchor (colinear), never one another visit
 *   matches uniquely. An inverted run entered at a visit with several candidates begins at the furthest one it
 *   reaches without jumping across a target visit a later visit matches colinearly. A copy left without one is ranked
 *   like an insertion after the anchor (Codex review, group H round 3: an inversion is not an extra copy).
 * - An off-target node ranks right after the last anchor, in frame order, and keeps its first carrier's rank and
 *   orientation (relative to the target frame) for later carriers (agy review, group H).
 */
export function canonicalWalk(topology: GraphTopology, bindingOrder?: readonly string[]): CanonicalWalk {
  const occurrences = new Map<string, GraphOccurrence[]>();
  for (const p of topology.paths) {
    occurrences.set(p.binding, [...p.occurrences].sort((a, b) => a.path_span.start - b.path_span.start || a.path_span.end - b.path_span.end));
  }
  const nodes: CanonicalWalk['nodes'] = new Map();
  const visits: CanonicalWalk['visits'] = new Map();
  const targetOccs = occurrences.get(topology.target) ?? [];
  const targetVisits = new Map<string, { i: number; reverse: boolean }[]>();
  targetOccs.forEach((o, i) => {
    const v = { rank: [i, 0, 0] as const, reverse: o.reverse };
    visits.set(o.id, v);
    if (!nodes.has(o.node)) nodes.set(o.node, v);
    (targetVisits.get(o.node) ?? targetVisits.set(o.node, []).get(o.node)!).push({ i, reverse: o.reverse });
  });
  // The helper's direct matches (either wire form): source occurrence -> its target visits and relative orientation.
  const targetIndex = new Map(targetOccs.map((o, i) => [o.id, i]));
  const direct = new Map<string, { i: number; reverse: boolean }[]>();
  const addMatch = (src: string, tgt: string, reverse: boolean) => {
    const i = targetIndex.get(tgt);
    if (i === undefined) return;
    (direct.get(src) ?? direct.set(src, []).get(src)!).push({ i, reverse });
  };
  for (const m of topology.direct_matches ?? []) addMatch(m.source_occurrence, m.target_occurrence, m.reverse);
  for (const [p, si, ti, r] of topology.direct_match_index ?? []) {
    const src = topology.paths[p]?.occurrences[si], tgt = targetOccs.length ? topology.paths.find(x => x.binding === topology.target)?.occurrences[ti] : undefined;
    if (src && tgt) addMatch(src.id, tgt.id, r === 1);
  }
  const order = (key: string) => { const i = bindingOrder?.indexOf(key) ?? -1; return i < 0 ? 1e6 + topology.paths.findIndex(p => p.binding === key) : i; };
  const others = topology.paths.map(p => p.binding).filter(b => b !== topology.target).sort((a, b) => order(a) - order(b));
  const len = (o: GraphOccurrence) => Math.max(1, o.clip.end - o.clip.start);
  others.forEach((b, pi) => {
    const occs = occurrences.get(b) ?? [];
    const walks = new Map<string, number>();
    for (const o of occs) walks.set(o.node, (walks.get(o.node) ?? 0) + 1);
    // Baseline parity: the orientation against the target carrying the most matched bp.
    let same = 0, opposite = 0;
    for (const o of occs) {
      const d = direct.get(o.id);
      const rev = d?.length === 1 ? d[0].reverse : (() => { const t = targetVisits.get(o.node)?.[0]; return t ? o.reverse !== t.reverse : null; })();
      if (rev === null) continue;
      if (rev) opposite += len(o); else same += len(o);
    }
    const backward = opposite > same;
    const claimed = new Set<number>();
    // `anchor`: the furthest target visit taken so far (insertions rank after it; it never rewinds behind an inverted
    // run). `last` and `inverted`: the previous visit taken and whether it runs against the baseline, so a visit of
    // several candidates inside an inverted run takes the next one down of the same parity (a palindromic core:
    // agy review, group H round 2).
    let anchor = -1, step = 0, last = -1, inverted = false;
    const take = (o: GraphOccurrence, c: { i: number; inv: boolean }) => {
      // Insertions after the anchor count up from it: the count restarts only when the anchor moves on (two
      // insertions behind one anchor, around an inverted visit that does not advance it, never share a rank).
      claimed.add(c.i); if (c.i > anchor) { anchor = c.i; step = 0; } last = c.i; inverted = c.inv;
      visits.set(o.id, { rank: [c.i, 0, 0], reverse: targetOccs[c.i].reverse });
    };
    const seq = backward ? [...occs].reverse() : occs;
    // Candidates: its direct matches, else the target's visits of its node; `inv`: against the baseline parity.
    // Unique: one candidate, and the carrier walks the node once or along the baseline, in either wire form (the
    // helper matches every shared node pair, so a sole direct match alone does not make a copy unique: an inverted
    // copy upstream of the colinear one is not its match; agy post-merge review A, HIGH 1).
    const info = seq.map(o => {
      const d = direct.get(o.id), t = targetVisits.get(o.node);
      const all = d?.length ? d.map(m => ({ i: m.i, inv: m.reverse !== backward }))
        : (t ?? []).map(x => ({ i: x.i, inv: (o.reverse !== x.reverse) !== backward }));
      const unique = all.length === 1 && (walks.get(o.node) === 1 || !all[0].inv);
      return { matched: Boolean(d?.length || t), all, unique };
    });
    // A target visit some visit matches uniquely is kept for it: a visit with several candidates never takes it.
    const reserved = new Set(info.filter(x => x.unique).map(x => x.all[0].i));
    // An inverted run starting at visit j may begin at candidate `c` only if it does not jump across a target visit a
    // later visit matches colinearly, unless an inverted visit of the run right after j covers it (it takes it on the
    // way down). A target visit nothing later matches colinearly (deleted in this carrier) may be crossed.
    const lastColinear = new Map<number, number>();
    info.forEach((x, k) => { for (const c of x.all) if (!c.inv) lastColinear.set(c.i, k); });
    const reaches = (j: number, c: number) => {
      const covered = new Set<number>();
      for (let k = j + 1; k < seq.length; k++) {
        if (!info[k].matched) continue; // an insertion inside the run
        const inv = info[k].all.filter(x => x.inv && x.i > anchor && x.i < c && !claimed.has(x.i));
        if (!inv.length) break;
        for (const x of inv) covered.add(x.i);
      }
      for (let i = anchor + 1; i < c; i++) {
        if (!claimed.has(i) && !covered.has(i) && (lastColinear.get(i) ?? -1) > j) return false;
      }
      return true;
    };
    for (let j = 0; j < seq.length; j++) {
      const o = seq[j];
      const { matched, unique } = info[j];
      const cands = info[j].all.filter(c => !claimed.has(c.i) && (unique || !reserved.has(c.i)));
      if (matched) {
        // One match: that target visit, wherever it lies.
        let pick: { i: number; inv: boolean } | undefined = unique ? cands[0] : undefined;
        if (!pick && cands.length) {
          const down = cands.filter(c => c.inv && c.i < last).sort((a, b2) => b2.i - a.i)[0];
          const up = cands.filter(c => !c.inv && c.i > anchor).sort((a, b2) => a.i - b2.i)[0];
          // Inside an inverted run the next one down, else the next one up (colinear); an inverted run starting here
          // begins at the furthest candidate it reaches; nothing taken yet: the first.
          pick = (inverted ? down ?? up : up ?? down)
            ?? cands.filter(c => c.inv && c.i > anchor).sort((a, b2) => b2.i - a.i).find(c => reaches(j, c.i))
            ?? (anchor < 0 ? [...cands].sort((a, b2) => a.i - b2.i)[0] : undefined);
        }
        if (pick) { take(o, pick); continue; }
        // An extra copy: unrolled like an insertion after the anchor.
        visits.set(o.id, { rank: [anchor, pi + 1, ++step], reverse: o.reverse !== backward });
        continue;
      }
      const known = nodes.get(o.node);
      if (known) { visits.set(o.id, known); continue; }
      const v = { rank: [anchor, pi + 1, ++step] as const, reverse: o.reverse !== backward };
      nodes.set(o.node, v);
      visits.set(o.id, v);
    }
  });
  return { nodes, visits, occurrences };
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
    const node = walk.visits.get(o.id) ?? walk.nodes.get(o.node);
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
