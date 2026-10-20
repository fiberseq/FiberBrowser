/**
 * The joint selected-path layout model (DESIGN_GRAPH_PANEL.md §4, Gate C): one bubble family for all selected
 * paths, built before any geometry.
 *
 * 1. **Target track.** The target's named visits, split into segments (one covered portion of one fragment, visits
 *    contiguous). A boundary is keyed by `(fragment, target occurrence, offset)`: "before visit i" is that visit at
 *    offset 0; a segment's terminal boundary is its last visit's end. Distinct fragments never share a key, even at
 *    one coordinate. Visits of the helper's flank margin (outside the window) are anchors only: drawn nowhere.
 * 2. **Anchors.** Each compared path's visits are matched to target visits through the helper's direct named-walk
 *    matches (never map pieces: inferred fills and absorbed tiny anchors play no part). The path's baseline
 *    orientation is the parity carrying most matched bp; a colinear chain (longest increasing target order) keeps
 *    one target visit per path visit, so a repeat visited twice is resolved by its neighbours, not by node ID.
 * 3. **Candidates.** Between consecutive anchors the path either steps straight on (shared), or leaves the target
 *    for a run of its own: an insertion (empty target allele), deletion (empty run), substitution — provided the
 *    walk is continuous (same fragment, whole adjacent visits) and both anchors are on one target segment. Otherwise
 *    it is unresolved there. Across consecutive segments (a fragment junction or graph gap) a continuous walk is a
 *    junction allele; anything else breaks the path (open ends).
 * 4. **Coalescing.** Candidates of all paths with equal flank keys form one group: the MAT/PAT Alu at 97,395 is one
 *    slot with an empty target allele and two alternate alleles. Identical walks coalesce into one allele; equal
 *    flanks alone never merge different alleles.
 * 5. **One interval family.** Groups of a segment must be disjoint or properly nested (a zero-span group strictly
 *    inside a positive one is its child; at an endpoint it takes the junction order). Crossing intervals collapse to
 *    one complex group over their minimal enclosing span, keeping every validated group outside it. Depth is at most
 *    three; deeper structure is summarized.
 * 6. **Allele families.** Alternate alleles of one group that share nodes are aligned on the first one (a family):
 *    shared stretches are drawn once, with sub-bubbles where they differ — the Alu's MAT and PAT copies run as one
 *    tube with their small differences.
 *
 * Every path in every group is the base (target) allele, an alternate allele, or unavailable: nothing is silently
 * dropped. Coordinates are zero-based half-open forward target coordinates.
 */
import type { GraphBinding, GraphCoverage, GraphOccurrence, GraphTopology, Span } from './types';

/** A continuity verdict meaning "a relative inversion, placed" (not a problem). */
export const INVERSION = 'an inversion';
/** Continuity problems that do not break a path's walk. */
const NON_BREAKING = new Set(['a local inversion', INVERSION]);
/** At most this many target visits per node are candidates for one path visit (design: four visits per node). */
const MAX_CANDIDATES_PER_VISIT = 4;
/** Nesting depth kept; deeper groups are summarized into their depth-3 ancestor. */
export const MAX_DEPTH = 3;

// ---------------------------------------------------------------------------------------------------- model types

export interface Visit {
  occ: GraphOccurrence;
  /** bp drawn: target visits clipped to the window (0 for a flank-margin anchor); path visits the walked clip. */
  bp: number;
  /** Target visits: the drawn target span; null for a flank-margin visit. */
  target: Span | null;
  /** The orientation relative to the path's baseline comparison (path visits). */
  reverse: boolean;
  /** Listed (and drawn left to right) against the path's own direction: path visits of a minus comparison. */
  backward?: boolean;
  /** A repeat visit: this path already walks the same node on the host (an earlier or later copy), at `of` (the
   * host occurrence), its `n`-th of `count` visits of the node in this view (Gate D unrolling). */
  repeat?: { of: string; n: number; count: number };
}

export interface RunItem {
  kind: 'run';
  id: string;
  /** Host lane: the target, or a family's lead path. */
  host: string;
  visits: Visit[];
  bp: number;
  /** Paths whose stripes run through it, in lane order. */
  carriers: string[];
  /** Target coordinates (target-backed runs). */
  target: Span | null;
}

export type AlleleStatus = 'ok' | 'unresolved' | 'complex' | 'junction';

export interface AltAllele {
  id: string;
  /** Paths carrying this exact walk, in lane order; the first is its lead (its lane draws it). */
  carriers: string[];
  visits: Visit[];
  bp: number;
  status: AlleleStatus;
  /** Each carrier's source span (an empty span at the boundary for a deletion). */
  source: { path: string; span: Span }[];
  reason?: string;
  /** A relative inversion: the allele walks the base allele's sequence in the opposite orientation (Gate D). */
  inverted?: boolean;
  /** Alleles aligned on this one (shared stretches drawn once); `chain` covers this allele's visits. */
  family?: { members: AltAllele[]; chain: Item[] };
}

export interface GroupItem {
  kind: 'group';
  id: string;
  type: 'bubble' | 'complex';
  depth: number;
  host: string;
  leftKey: string;
  rightKey: string;
  /** Target span of the base allele (zero-span: start === end, the boundary). Null at an allele level. */
  target: Span | null;
  /** The base allele: the host's own sequence (target visits at the top level), with nested children. */
  base: { carriers: string[]; chain: Item[]; bp: number };
  alts: AltAllele[];
  /** Selected paths with no verified traversal here. */
  unavailable: string[];
  reason?: string;
  /** Collapsed members (complex groups): what each involved path is known to carry. */
  collapsed?: { path: string; bp: number; target: Span | null }[];
}

export interface JunctionItem {
  kind: 'junction';
  id: string;
  /** The first missing target stretch between the segments (a graph gap), or null for touching fragments. */
  gap: GraphCoverage | null;
  /** Every missing stretch here, in order (graph gaps, budget omissions): the whole coverage partition. */
  gaps: GraphCoverage[];
  /** Its target span (gap span, or the junction coordinate as an empty span). */
  target: Span;
  leftEnd: string;
  rightEnd: string;
  /** Paths walking continuously across it, with what they carry there. */
  alts: AltAllele[];
  /** Compared paths whose stripes stop here (present before, no named continuity across) and start here. */
  passing: string[];
  stops: string[];
  starts: string[];
}

export type Item = RunItem | GroupItem | JunctionItem;

export interface OpenEnd {
  path: string;
  side: 'left' | 'right';
  /** Target coordinate where the path's verified walk stops. */
  at: number;
  reason: 'fragment_terminal' | 'unplaced' | 'broken' | 'window_clip' | 'budget';
  /** Unplaced bp beyond the stop (a run with no anchor on that side). */
  bp: number;
  source: Span | null;
}

export interface LayoutRow {
  key: string;
  label: string;
  title: string;
  role: 'target' | 'alternate';
}

export interface LayoutModel {
  interval: Span;
  target: string;
  rows: LayoutRow[];
  chain: Item[];
  openEnds: OpenEnd[];
  /** A lane with nothing placed and why (not extracted, budget, no correspondence). */
  laneNotes: Record<string, string>;
  complete: boolean;
  correspondenceComplete: boolean;
  summaries: string[];
  stats: {
    nodes: number; edges: number; visits: number;
    groups: number; insertions: number; deletions: number; substitutions: number; complex: number;
    /** Placed relative inversions (Gate D); repeat visits unrolled (non-anchor visits of an anchored node). */
    inversions: number; repeats: number;
    unresolved: number; unplaced: number; anchors: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------------------------------- helpers

export function visitPiece(o: GraphOccurrence): Span {
  return { start: o.path_span.start + o.clip.start, end: o.path_span.start + o.clip.end };
}

function clipTo(span: Span, window: Span): Span | null {
  const start = Math.max(span.start, window.start), end = Math.min(span.end, window.end);
  return end > start ? { start, end } : null;
}

const visitLength = (o: GraphOccurrence) => o.path_span.end - o.path_span.start;

/** The lane label: the binding key, without a trailing "_<its contig>" (per-chromosome packages), upper-cased when
 * short (MAT/PAT are display labels only; their colours follow the label). */
export function laneLabel(binding: GraphBinding | undefined, key: string): string {
  let k = binding?.key ?? key;
  const contig = binding?.path.contig;
  if (contig && k.endsWith(`_${contig}`) && k.length > contig.length + 1) k = k.slice(0, -(contig.length + 1));
  return k.length <= 4 ? k.toUpperCase() : k;
}

function laneTitle(binding: GraphBinding | undefined, key: string): string {
  if (!binding) return key;
  const p = binding.path;
  return `${binding.assembly} · ${p.sample}#${p.haplotype}#${p.contig}`;
}

export function summaryText(s: Record<string, unknown>): string {
  const reason = String(s.reason ?? s.kind ?? 'summary');
  const span = (s.span ?? s.target) as Span | undefined;
  const where = span ? ` ${span.start.toLocaleString('en-US')}-${span.end.toLocaleString('en-US')}` : '';
  const binding = s.binding ? ` (${s.binding})` : '';
  return `${reason.replace(/_/g, ' ')}${binding}${where}`;
}

/** A short stable hash (FNV-1a, base 36) for block identities built from occurrence keys. */
export function stableId(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Longest chain of pairs strictly increasing in both coordinates; pairs must be sorted by (a asc, b desc). */
function colinearChain<T extends { a: number; b: number }>(pairs: T[]): T[] {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const b = pairs[k].b;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]].b < b) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out: T[] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

// ---------------------------------------------------------------------------------------------------- one level

/** The host sequence of one level: the target track, or a family's lead allele. */
interface Backbone {
  host: string;
  visits: Visit[];
  /** Segments as [from, to) visit ranges, in order. */
  segments: { from: number; to: number; fragment: string }[];
  /** Index of the segment holding each visit. */
  segOf: Int32Array;
  key(seg: number, p: number): string;
  /** The base allele's carriers outside any member (the target, or the lead allele's own carriers). */
  own: string[];
}

interface Anchor { j: number; i: number }

interface Candidate {
  path: string;
  seg: number;
  p: number;
  q: number;
  visits: Visit[];
  status: AlleleStatus;
  reason?: string;
  source: Span;
  inverted?: boolean;
}



interface MemberSolution {
  key: string;
  anchors: Anchor[];
  /** Connected run per anchor (a break starts a new one). */
  runOf: Int32Array;
  /** Anchor index at each backbone visit (-1: none). */
  anchorAt: Int32Array;
  candidates: Candidate[];
}

function signature(visits: Visit[]): string {
  return visits.map(v => `${v.occ.node}${v.reverse ? '-' : '+'}`).join(',');
}

function sourceSpanOf(visits: Visit[], fallback: number): Span {
  if (!visits.length) return { start: fallback, end: fallback };
  let start = Infinity, end = -Infinity;
  for (const v of visits) {
    const s = visitPiece(v.occ);
    if (s.start < start) start = s.start;
    if (s.end > end) end = s.end;
  }
  return { start, end };
}

interface LevelInput {
  backbone: Backbone;
  members: { key: string; visits: Visit[]; anchors: Anchor[]; continuous: (a: Anchor, b: Anchor) => string | null }[];
  depth: number;
  /** Target-coordinate span of a base stretch [p,q) on segment seg (top level only). */
  targetSpan: ((seg: number, p: number, q: number) => Span) | null;
  lanes: string[];
  idPrefix: string;
}

interface LevelResult {
  chains: Item[][];
  solutions: MemberSolution[];
  /** Continuous walks across the junction after each segment. */
  junctions: Map<number, Candidate[]>;
  counts: { groups: number; complex: number; unresolved: number };
}

/** Candidates → groups → validated family → chains, for one backbone. */
function solveLevel(input: LevelInput, buildFamilies: (g: GroupItem) => void): LevelResult {
  const { backbone: bb, lanes } = input;
  const n = bb.visits.length;
  const order = new Map(lanes.map((k, i) => [k, i]));
  const byLane = (a: string, b: string) => (order.get(a) ?? 99) - (order.get(b) ?? 99);
  const solutions: MemberSolution[] = [];
  for (const m of input.members) {
    const anchorAt = new Int32Array(n).fill(-1);
    m.anchors.forEach((a, k) => { if (a.i >= 0 && a.i < n) anchorAt[a.i] = k; });
    const runOf = new Int32Array(m.anchors.length);
    const candidates: Candidate[] = [];
    let run = 0;
    for (let k = 0; k < m.anchors.length; k++) {
      if (k > 0) {
        const a = m.anchors[k - 1], b = m.anchors[k];
        const between = m.visits.slice(a.j + 1, b.j);
        const sa = a.i < 0 ? 0 : bb.segOf[a.i], sb = b.i >= n ? bb.segments.length - 1 : bb.segOf[b.i];
        const problem = m.continuous(a, b);
        // A discontinuous walk (fragment change, gap in the walk, window cut) breaks the path's run: it does not
        // walk any enclosing base allele across it. A local inversion is continuous (Gate D draws it).
        const breaking = problem != null && !NON_BREAKING.has(problem);
        if (sa === sb) {
          if (b.i === a.i + 1 && b.j === a.j + 1 && !problem) {
            // shared step
          } else if (b.i === a.i + 1 && b.j === a.j + 1 && problem !== INVERSION) {
            // Adjacent on both sides but not one walk: open ends, never an empty "insertion".
            run += 1;
          } else {
            const fallback = a.j >= 0 && a.j < m.visits.length
              ? (m.visits[a.j].reverse ? m.visits[a.j].occ.path_span.start : m.visits[a.j].occ.path_span.end) : 0;
            const inverted = problem === INVERSION;
            candidates.push({ path: m.key, seg: sa, p: a.i + 1, q: b.i, visits: between,
              status: problem && !inverted ? 'unresolved' : 'ok', reason: problem && !inverted ? problem : undefined,
              source: sourceSpanOf(between, fallback), inverted: inverted || undefined });
            if (breaking) run += 1;
          }
        } else if (sb === sa + 1 && a.i === bb.segments[sa].to - 1 && b.i === bb.segments[sb].from && !problem) {
          // Walks on across the junction between consecutive segments.
          const fallback = m.visits[a.j].occ.path_span.end;
          candidates.push({ path: m.key, seg: sa, p: a.i + 1, q: -1, visits: between, status: 'junction',
            source: sourceSpanOf(between, fallback) });
        } else {
          run += 1;
        }
      }
      runOf[k] = run;
    }
    solutions.push({ key: m.key, anchors: m.anchors, runOf, anchorAt, candidates });
  }

  // -------------------------------------------------- groups by equal flank keys, per segment
  const counts = { groups: 0, complex: 0, unresolved: 0 };
  interface Proto { seg: number; p: number; q: number; cands: Candidate[]; type: 'bubble' | 'complex'; collapsed?: Candidate[]; reason?: string }
  const protos = new Map<string, Proto>();
  const junctions = new Map<number, Candidate[]>();
  for (const s of solutions) {
    for (const c of s.candidates) {
      if (c.status === 'junction') {
        const list = junctions.get(c.seg) ?? [];
        list.push(c);
        junctions.set(c.seg, list);
        continue;
      }
      const k = `${c.seg}:${c.p}:${c.q}`;
      const proto = protos.get(k) ?? { seg: c.seg, p: c.p, q: c.q, cands: [], type: 'bubble' as const };
      proto.cands.push(c);
      protos.set(k, proto);
    }
  }
  // -------------------------------------------------- one interval family per segment: collapse crossings
  const perSeg = new Map<number, Proto[]>();
  for (const pr of protos.values()) {
    const list = perSeg.get(pr.seg) ?? [];
    list.push(pr);
    perSeg.set(pr.seg, list);
  }
  const crosses = (a: { p: number; q: number }, b: { p: number; q: number }) =>
    (a.p < b.p && b.p < a.q && a.q < b.q) || (b.p < a.p && a.p < b.q && b.q < a.q);
  /**
   * Crossing components by one sorted sweep (union-find over intervals still open at each start), each collapsed to
   * its minimal enclosing span with everything inside it; repeated only while a new complex block crosses another
   * group. Validated groups outside every block are kept.
   */
  function collapseCrossings(seg: number, list: Proto[]): Proto[] {
    let groups = list.slice();
    for (let round = 0; round < 64; round++) {
      groups.sort((x, y) => x.p - y.p || y.q - x.q);
      const parent = groups.map((_, k) => k);
      const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
      let active: number[] = [];
      let unions = 0;
      for (let k = 0; k < groups.length; k++) {
        const g = groups[k];
        if (g.p === g.q) continue;
        active = active.filter(o => groups[o].q > g.p);
        for (const o of active) if (crosses(groups[o], g) && find(o) !== find(k)) { parent[find(o)] = find(k); unions += 1; }
        active.push(k);
      }
      if (!unions) return groups;
      const comps = new Map<number, Proto[]>();
      groups.forEach((g, k) => { const r = find(k); const l = comps.get(r) ?? []; l.push(g); comps.set(r, l); });
      const blocks = [...comps.values()].filter(l => l.length > 1).map(l => ({
        p: Math.min(...l.map(g => g.p)), q: Math.max(...l.map(g => g.q)), inside: [] as Proto[],
      })).sort((x, y) => x.p - y.p || y.q - x.q);
      // One ordered pass: each group joins the block that contains it, found by binary search on block starts and
      // a backwards walk bounded by the running maximum end (blocks overlapping each other merge next round).
      const maxQ: number[] = [];
      blocks.forEach((bk, n) => { maxQ[n] = Math.max(bk.q, n ? maxQ[n - 1] : -Infinity); });
      const absorbed = new Set<Proto>();
      for (const g of groups) {
        let lo = 0, hi = blocks.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (blocks[m].p <= g.p) lo = m + 1; else hi = m; }
        for (let n = lo - 1; n >= 0 && maxQ[n] >= g.q; n--) {
          const bk = blocks[n];
          const zeroAtEdge = g.p === g.q && (g.p === bk.p || g.p === bk.q);
          if (g.q <= bk.q && !zeroAtEdge) { bk.inside.push(g); absorbed.add(g); break; }
        }
      }
      const complexes: Proto[] = blocks.map(bk => ({ seg, p: bk.p, q: bk.q, cands: [], type: 'complex' as const,
        collapsed: bk.inside.flatMap(g => g.collapsed ?? g.cands), reason: 'crossing intervals' }));
      groups = [...groups.filter(g => !absorbed.has(g)), ...complexes];
    }
    return groups;
  }
  const finalPerSeg = new Map<number, Proto[]>();
  for (const [seg, list] of perSeg) finalPerSeg.set(seg, collapseCrossings(seg, list));

  // -------------------------------------------------- statuses: base traversal per path
  // Per path and boundary b (0..n): 1 on the base there, 2 inside one of its own candidates, 0 absent; and the
  // connected run it is on. A path on the base at both flanks of a group, on one run, walks its base allele (its
  // own nested candidates inside are children); inside its own candidate around a flank it is elsewhere (an
  // ancestor's alternate allele), not unavailable.
  const boundaryState = new Map<string, { state: Int8Array; run: Int32Array }>();
  for (const s of solutions) {
    const state = new Int8Array(n + 1), runAt = new Int32Array(n + 1).fill(-1);
    const anchorIdx = (i: number) => (i >= 0 && i < n ? s.anchorAt[i]
      : i === -1 ? (s.anchors[0]?.i === -1 ? 0 : -1) : (s.anchors[s.anchors.length - 1]?.i === n ? s.anchors.length - 1 : -1));
    // Own positive candidates starting / ending at each boundary (the path enters or leaves its allele there).
    const starts = new Uint8Array(n + 1), ends = new Uint8Array(n + 1);
    for (const c of s.candidates) {
      if (c.status === 'junction' || c.q <= c.p) continue;
      starts[c.p] = 1;
      ends[c.q] = 1;
    }
    for (let b = 0; b <= n; b++) {
      const left = anchorIdx(b - 1), right = anchorIdx(b);
      // Through b on the base: present on both sides of it, one connected run (its own allele next to b counts as
      // a side: junction order puts a zero-span group before a positive one starting there).
      const both = left >= 0 && right >= 0 && s.runOf[left] === s.runOf[right];
      if (both || (left >= 0 && starts[b]) || (right >= 0 && ends[b])) {
        state[b] = 1;
        runAt[b] = s.runOf[left >= 0 ? left : right];
      }
    }
    for (const c of s.candidates) {
      if (c.status === 'junction') continue;
      for (let b = c.p + 1; b < c.q; b++) state[b] = 2;
    }
    boundaryState.set(s.key, { state, run: runAt });
  }
  const traverses = (s: MemberSolution, p: number, q: number) => {
    const st = boundaryState.get(s.key)!;
    return st.state[p] === 1 && st.state[q] === 1 && st.run[p] === st.run[q];
  };
  const elsewhere = (s: MemberSolution, p: number, q: number) => {
    const st = boundaryState.get(s.key)!;
    return st.state[p] === 2 || st.state[q] === 2;
  };

  // -------------------------------------------------- nesting tree and chains
  const makeGroup = (pr: Proto, depth: number, children: Proto[], childMap: Map<Proto, Proto[]>): GroupItem => {
    const leftKey = bb.key(pr.seg, pr.p), rightKey = bb.key(pr.seg, pr.q);
    const id = `${input.idPrefix}g${stableId(`${leftKey}>${rightKey}`)}`;
    const carriersAlt = new Set((pr.type === 'complex' ? pr.collapsed! : pr.cands).map(c => c.path));
    const baseCarriers = [...bb.own];
    const unavailable: string[] = [];
    for (const s of solutions) {
      if (carriersAlt.has(s.key)) continue;
      if (traverses(s, pr.p, pr.q)) baseCarriers.push(s.key);
      else if (!elsewhere(s, pr.p, pr.q)) unavailable.push(s.key);
    }
    baseCarriers.sort(byLane);
    let alts: AltAllele[] = [];
    if (pr.type === 'bubble') {
      const bySig = new Map<string, Candidate[]>();
      for (const c of pr.cands) {
        const sig = `${c.status}|${c.inverted ? 'inv|' : ''}${signature(c.visits)}`;
        const list = bySig.get(sig) ?? [];
        list.push(c);
        bySig.set(sig, list);
      }
      alts = [...bySig.values()].map(list => {
        list.sort((a, b) => byLane(a.path, b.path));
        const c = list[0];
        if (c.status === 'unresolved') counts.unresolved += 1;
        return {
          id: `${id}.${stableId(`${list.map(x => x.path).join('+')}|${signature(c.visits)}`)}`,
          carriers: list.map(x => x.path), visits: c.visits, bp: c.visits.reduce((t, v) => t + v.bp, 0),
          status: c.status, reason: c.reason, source: list.map(x => ({ path: x.path, span: x.source })),
          ...(c.inverted ? { inverted: true } : {}),
        };
      }).sort((a, b) => byLane(a.carriers[0], b.carriers[0]));
    } else {
      counts.complex += 1;
      const byPath = new Map<string, Candidate[]>();
      for (const c of pr.collapsed!) {
        const list = byPath.get(c.path) ?? [];
        list.push(c);
        byPath.set(c.path, list);
      }
      alts = [...byPath.entries()].sort((a, b) => byLane(a[0], b[0])).map(([path, list]) => {
        const visits = list.flatMap(c => c.visits);
        return {
          id: `${id}.${stableId(path)}`, carriers: [path], visits, bp: visits.reduce((t, v) => t + v.bp, 0),
          status: 'complex' as const, reason: pr.reason, source: list.map(c => ({ path, span: c.source })),
        };
      });
    }
    counts.groups += 1;
    const base = chainFor(pr.seg, pr.p, pr.q, children, childMap, depth + 1);
    const group: GroupItem = {
      kind: 'group', id, type: pr.type, depth, host: bb.host, leftKey, rightKey,
      target: input.targetSpan ? input.targetSpan(pr.seg, pr.p, pr.q) : null,
      base: { carriers: baseCarriers, chain: base, bp: bb.visits.slice(pr.p, pr.q).reduce((t, v) => t + v.bp, 0) },
      alts, unavailable: unavailable.sort(byLane), reason: pr.reason,
      collapsed: pr.type === 'complex' ? alts.map(a => ({ path: a.carriers[0], bp: a.bp, target: null })) : undefined,
    };
    if (pr.type === 'bubble') buildFamilies(group);
    return group;
  };

  /** Base visits [from, to) of a segment as runs and groups, `groups` being this level's (already nested). */
  function chainFor(seg: number, from: number, to: number, groups: Proto[], childMap: Map<Proto, Proto[]>, depth: number): Item[] {
    const items: Item[] = [];
    let run: Visit[] = [];
    let runCarriers: string[] = [];
    let runStart = from;
    const presentAt = (i: number) => {
      const out = [...bb.own];
      for (const s of solutions) if (s.anchorAt[i] >= 0) out.push(s.key);
      return out.sort(byLane);
    };
    const flush = () => {
      if (!run.length) return;
      const spans = run.map(v => v.target).filter((t): t is Span => t != null);
      items.push({
        kind: 'run', id: `${input.idPrefix}r${stableId(`${bb.key(seg, runStart)}`)}`, host: bb.host, visits: run,
        bp: run.reduce((t, v) => t + v.bp, 0), carriers: runCarriers,
        target: spans.length ? { start: spans[0].start, end: spans[spans.length - 1].end } : null,
      });
      run = [];
    };
    const sorted = groups.slice().sort((a, b) => a.p - b.p || (a.q - a.p) - (b.q - b.p));
    let g = 0;
    let i = from;
    for (;;) {
      while (g < sorted.length && sorted[g].p === i && sorted[g].q === i) {
        flush();
        items.push(makeGroup(sorted[g], depth, childMap.get(sorted[g]) ?? [], childMap));
        g += 1;
      }
      if (g < sorted.length && sorted[g].p === i && sorted[g].q > i) {
        flush();
        const pr = sorted[g];
        items.push(makeGroup(pr, depth, childMap.get(pr) ?? [], childMap));
        i = pr.q;
        g += 1;
        runStart = i;
        continue;
      }
      if (i >= to) break;
      // Stripes where the path is anchored: inside a complex region too, so what each path walks stays visible.
      const carriers = presentAt(i);
      if (run.length && carriers.join(',') !== runCarriers.join(',')) { flush(); runStart = i; }
      if (!run.length) { runCarriers = carriers; runStart = i; }
      run.push(bb.visits[i]);
      i += 1;
    }
    flush();
    return items;
  }

  const chains: Item[][] = [];
  for (let seg = 0; seg < bb.segments.length; seg++) {
    const list = finalPerSeg.get(seg) ?? [];
    // Containment tree: parent = innermost positive interval containing it (zero-span: strictly inside).
    const sorted = list.slice().sort((a, b) => a.p - b.p || b.q - a.q || (a.q === a.p ? 1 : 0) - (b.q === b.p ? 1 : 0));
    const childMap = new Map<Proto, Proto[]>();
    const roots: Proto[] = [];
    const depthOf = new Map<Proto, number>();
    const stack: Proto[] = [];
    for (const pr of sorted) {
      const zero = pr.p === pr.q;
      let parent: Proto | undefined;
      if (zero) {
        // An insertion never pops an interval it sits at the endpoint of (later children still nest in it): drop
        // only intervals that end at or before it, then take the innermost one strictly around it.
        while (stack.length && stack[stack.length - 1].q <= pr.p) stack.pop();
        for (let k = stack.length - 1; k >= 0; k--) if (stack[k].p < pr.p && pr.p < stack[k].q) { parent = stack[k]; break; }
      } else {
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (top.p <= pr.p && pr.q <= top.q && !(top.p === pr.p && top.q === pr.q)) break;
          stack.pop();
        }
        parent = stack[stack.length - 1];
      }
      if (parent) {
        const d = (depthOf.get(parent) ?? 0) + 1;
        if (d >= MAX_DEPTH) {
          // Deeper than three: summarized into the deepest kept ancestor.
          parent.type = 'complex';
          parent.collapsed = [...(parent.collapsed ?? parent.cands), ...(pr.collapsed ?? pr.cands)];
          parent.reason = parent.reason ?? 'nesting deeper than three levels';
          continue;
        }
        depthOf.set(pr, d);
        const kids = childMap.get(parent) ?? [];
        kids.push(pr);
        childMap.set(parent, kids);
      } else {
        depthOf.set(pr, 0);
        roots.push(pr);
      }
      if (!zero) stack.push(pr);
    }
    // A complex group's children are part of it.
    for (const [parent, kids] of [...childMap]) {
      if (parent.type !== 'complex') continue;
      const absorb = (k: Proto): Candidate[] => [...(k.collapsed ?? k.cands), ...(childMap.get(k) ?? []).flatMap(absorb)];
      parent.collapsed = [...(parent.collapsed ?? parent.cands), ...kids.flatMap(absorb)];
      childMap.delete(parent);
    }
    const seginfo = bb.segments[seg];
    chains.push(chainFor(seg, seginfo.from, seginfo.to, roots, childMap, input.depth));
  }
  return { chains, solutions, junctions, counts };
}

// ---------------------------------------------------------------------------------------------------- top level

function segmentsOf(target: GraphOccurrence[], coverage: GraphCoverage[]) {
  const segments: { from: number; to: number; fragment: string; leftEnd: string; rightEnd: string }[] = [];
  for (let i = 0; i < target.length; i++) {
    const o = target[i], prev = target[i - 1];
    if (!prev || prev.fragment !== o.fragment || prev.path_span.end !== o.path_span.start) {
      const portion = coverage.find(c => c.fragment === o.fragment && c.span.start < o.path_span.end && o.path_span.start < c.span.end);
      segments.push({ from: i, to: i + 1, fragment: o.fragment, leftEnd: portion?.left_end ?? 'unknown', rightEnd: portion?.right_end ?? 'unknown' });
    } else {
      segments[segments.length - 1].to = i + 1;
      const portion = coverage.find(c => c.fragment === o.fragment && c.span.start < o.path_span.end && o.path_span.start < c.span.end);
      if (portion) segments[segments.length - 1].rightEnd = portion.right_end ?? 'unknown';
    }
  }
  return segments;
}

/**
 * Build the joint layout model of a helper topology. Pure and deterministic: the same response gives the same
 * model, and a group's identity depends only on its flank occurrences (stable across pans).
 */
export function buildLayout(topology: GraphTopology, bindings: GraphBinding[]): LayoutModel {
  const window = topology.interval;
  const byKey = new Map(bindings.map(b => [b.key, b]));
  const lanes = topology.paths.map(p => p.binding);
  const targetPath = topology.paths.find(p => p.binding === topology.target) ?? topology.paths[0];
  const targetOccs = (targetPath?.occurrences ?? []).slice();
  const tVisits: Visit[] = targetOccs.map(o => {
    const drawn = clipTo(visitPiece(o), window);
    return { occ: o, bp: drawn ? drawn.end - drawn.start : 0, target: drawn, reverse: false };
  });
  const tIndex = new Map(targetOccs.map((o, i) => [o.id, i]));
  const segs = segmentsOf(targetOccs, targetPath?.coverage ?? []);
  const segOf = new Int32Array(tVisits.length);
  segs.forEach((s, k) => { for (let i = s.from; i < s.to; i++) segOf[i] = k; });
  const backbone: Backbone = {
    host: topology.target, visits: tVisits, segments: segs, segOf, own: [topology.target],
    key: (seg, p) => {
      const s = segs[seg];
      return p < s.to ? `${s.fragment}|${targetOccs[p].id}|0` : `${s.fragment}|${targetOccs[s.to - 1].id}|end`;
    },
  };
  const targetSpan = (seg: number, p: number, q: number): Span => {
    const s = segs[seg];
    if (p >= q) {
      const at = p < s.to ? targetOccs[p].path_span.start : targetOccs[s.to - 1].path_span.end;
      return { start: at, end: at };
    }
    return { start: targetOccs[p].path_span.start, end: targetOccs[q - 1].path_span.end };
  };

  // Direct matches per path visit (either wire form).
  const matches = new Map<string, Map<string, { i: number; reverse: boolean }[]>>();
  const listed = (topology.direct_matches ?? []).slice();
  for (const [p, s, t, r] of topology.direct_match_index ?? []) {
    const src = topology.paths[p]?.occurrences[s], tgt = targetOccs[t];
    if (src && tgt) listed.push({ target_occurrence: tgt.id, source_occurrence: src.id, source_binding: topology.paths[p].binding, reverse: r === 1, provenance: 'direct_named_walk' });
  }
  for (const m of listed) {
    const i = tIndex.get(m.target_occurrence);
    if (i === undefined) continue;
    let perPath = matches.get(m.source_binding);
    if (!perPath) { perPath = new Map(); matches.set(m.source_binding, perPath); }
    const list = perPath.get(m.source_occurrence) ?? [];
    list.push({ i, reverse: m.reverse });
    perPath.set(m.source_occurrence, list);
  }

  const openEnds: OpenEnd[] = [];
  const members: LevelInput['members'] = [];
  const anchorCounts: Record<string, number> = {};
  const memberVisits = new Map<string, Visit[]>();
  for (const path of topology.paths) {
    if (path.binding === topology.target) continue;
    const perPath = matches.get(path.binding) ?? new Map();
    // Baseline orientation: the parity carrying most matched bp.
    let plus = 0, minus = 0;
    for (const o of path.occurrences) {
      for (const m of perPath.get(o.id) ?? []) (m.reverse ? (minus += visitLength(o)) : (plus += visitLength(o)));
    }
    const reverse = minus > plus;
    const ordered = reverse ? path.occurrences.slice().reverse() : path.occurrences.slice();
    const visits: Visit[] = ordered.map(o => ({ occ: o, bp: o.clip.end - o.clip.start, target: null, reverse: o.reverse !== reverse,
      ...(reverse ? { backward: true } : {}) }));
    memberVisits.set(path.binding, visits);
    // Candidates of the baseline parity. A visit with one candidate that no other visit also claims is unique; the
    // colinear chain of unique pairs is the frame. A repeat visit (several candidates, at most four) is placed only
    // when exactly one candidate lies between its unique neighbours; two visits claiming one target visit (a
    // duplication) are not placed. Unplaced visits stay part of a run (an allele or an open end), never dropped.
    const cands: number[][] = visits.map(v => (perPath.get(v.occ.id) ?? [])
      .filter((m: { reverse: boolean }) => m.reverse === reverse).map((m: { i: number }) => m.i));
    // A target visit claimed by several path visits (a tandem or nearby repeat walked more often than the target
    // walks it) takes the earliest colinear claimant; the other copies stay in the walk as repeat visits of it
    // (insertions), unrolled by occurrence rather than left unplaced.
    const claimants = new Map<number, number[]>();
    cands.forEach((c, j) => { if (c.length === 1) { const l = claimants.get(c[0]) ?? []; l.push(j); claimants.set(c[0], l); } });
    const unique: { a: number; b: number }[] = [];
    cands.forEach((c, j) => { if (c.length === 1) unique.push({ a: j, b: c[0] }); });
    unique.sort((x, y) => x.a - y.a || y.b - x.b);
    const frame = colinearChain(unique);
    for (let k = 0; k < frame.length; k++) {
      const list = claimants.get(frame[k].b)!;
      if (list.length < 2) continue;
      const lo = k > 0 ? frame[k - 1].a : -1;
      const earliest = list.find(j => j > lo && j < frame[k].a);
      if (earliest !== undefined) frame[k] = { a: earliest, b: frame[k].b };
    }
    const pairs = frame.slice();
    let f = 0;
    const resolved: { a: number; b: number }[] = [];
    cands.forEach((c, j) => {
      if (c.length < 2 || c.length > MAX_CANDIDATES_PER_VISIT) return;
      while (f < frame.length && frame[f].a < j) f += 1;
      const prev = frame[f - 1], next = frame[f];
      const fits = c.filter(i => (!prev || i > prev.b) && (!next || i < next.b));
      if (fits.length === 1) resolved.push({ a: j, b: fits[0] });
    });
    // Two repeat visits resolving onto one target visit (a duplicated copy) are both left unplaced.
    const resolvedClaims = new Map<number, number>();
    for (const r of resolved) resolvedClaims.set(r.b, (resolvedClaims.get(r.b) ?? 0) + 1);
    for (const r of resolved) if (resolvedClaims.get(r.b) === 1) pairs.push(r);
    pairs.sort((x, y) => x.a - y.a || y.b - x.b);
    const anchors = colinearChain(pairs).map(p => ({ j: p.a, i: p.b }));
    anchorCounts[path.binding] = anchors.length;
    annotateRepeats(visits, anchors, targetOccs);
    const continuous = (a: Anchor, b: Anchor): string | null => {
      const va = visits[a.j], vb = visits[b.j];
      // The window may cut a visit: then the walk between the two is not all here.
      const exitWhole = reverse ? va.occ.clip.start === 0 : va.occ.clip.end === visitLength(va.occ);
      const entryWhole = reverse ? vb.occ.clip.end === visitLength(vb.occ) : vb.occ.clip.start === 0;
      if (!exitWhole || !entryWhole) return 'the walk leaves the extracted window';
      for (let j = a.j + 1; j <= b.j; j++) {
        const x = visits[j - 1].occ, y = visits[j].occ;
        if (x.fragment !== y.fragment) return 'a fragment change';
        if (reverse ? y.path_span.end !== x.path_span.start : y.path_span.start !== x.path_span.end) return 'a discontinuous walk';
        if (j < b.j && (y.clip.start !== 0 || y.clip.end !== visitLength(y))) return 'the walk leaves the extracted window';
      }
      if (b.i <= a.i) return 'target order reversed';
      // Visits matched in the opposite orientation inside the span: a relative inversion (Gate D), not a
      // substitution. Placed when those matches run against target order (one per visit, each target visit once)
      // and carry at least half the allele's bp; anything less consistent stays an unresolved local inversion.
      let invBp = 0, allBp = 0, last = Infinity, consistent = true, any = false;
      const used = new Set<number>();
      for (let j = a.j + 1; j < b.j; j++) {
        allBp += visits[j].bp;
        const opposite = (perPath.get(visits[j].occ.id) ?? []).filter((m: { reverse: boolean; i: number }) => m.reverse !== reverse && m.i > a.i && m.i < b.i);
        if (!opposite.length) continue;
        any = true;
        const fit = opposite.filter((m: { i: number }) => m.i < last && !used.has(m.i));
        if (fit.length !== 1) { consistent = false; continue; }
        last = fit[0].i;
        used.add(last);
        invBp += visits[j].bp;
      }
      if (!any) return null;
      return consistent && invBp * 2 >= allBp ? INVERSION : 'a local inversion';
    };
    members.push({ key: path.binding, visits, anchors, continuous });
    // Open ends: the walk before the first anchor and after the last.
    if (anchors.length) {
      const first = anchors[0], last = anchors[anchors.length - 1];
      const lead = visits.slice(0, first.j), tail = visits.slice(last.j + 1);
      const portionEnd = (o: GraphOccurrence, side: 'left' | 'right') => {
        const c = path.coverage.find(x => x.fragment === o.fragment && x.span.start <= visitPiece(o).start && visitPiece(o).end <= x.span.end);
        return side === 'left' ? c?.left_end : c?.right_end;
      };
      const firstAt = targetOccs[first.i].path_span.start, lastAt = targetOccs[last.i].path_span.end;
      const leadBp = lead.reduce((t, v) => t + v.bp, 0), tailBp = tail.reduce((t, v) => t + v.bp, 0);
      const firstOcc = visits[first.j].occ, lastOcc = visits[last.j].occ;
      const leftTerminal = portionEnd(firstOcc, reverse ? 'right' : 'left') === 'fragment_terminal'
        && (reverse ? visitPiece(firstOcc).end : visitPiece(firstOcc).start) === (reverse ? firstOcc.path_span.end : firstOcc.path_span.start);
      const rightTerminal = portionEnd(lastOcc, reverse ? 'left' : 'right') === 'fragment_terminal'
        && (reverse ? visitPiece(lastOcc).start : visitPiece(lastOcc).end) === (reverse ? lastOcc.path_span.start : lastOcc.path_span.end);
      if (leadBp > 0) openEnds.push({ path: path.binding, side: 'left', at: firstAt, reason: 'unplaced', bp: leadBp, source: sourceSpanOf(lead, 0) });
      else if (leftTerminal && firstAt > window.start) openEnds.push({ path: path.binding, side: 'left', at: firstAt, reason: 'fragment_terminal', bp: 0, source: null });
      if (tailBp > 0) openEnds.push({ path: path.binding, side: 'right', at: lastAt, reason: 'unplaced', bp: tailBp, source: sourceSpanOf(tail, 0) });
      else if (rightTerminal && lastAt < window.end) openEnds.push({ path: path.binding, side: 'right', at: lastAt, reason: 'fragment_terminal', bp: 0, source: null });
      // Breaks inside: each side of a break is an open end.
      for (let k = 1; k < anchors.length; k++) {
        const a = anchors[k - 1], b = anchors[k];
        const sa = segOf[a.i], sb = segOf[b.i];
        const problem = continuous(a, b);
        const junctionOk = sb === sa + 1 && a.i === segs[sa].to - 1 && b.i === segs[sb].from && !problem;
        // Across segments without a junction walk, or adjacent visits that are not one walk: each side ends.
        const adjacentBreak = sa === sb && b.i === a.i + 1 && b.j === a.j + 1 && problem != null && !NON_BREAKING.has(problem);
        if ((sa !== sb && !junctionOk) || adjacentBreak) {
          const bp = visits.slice(a.j + 1, b.j).reduce((t, v) => t + v.bp, 0);
          openEnds.push({ path: path.binding, side: 'right', at: targetOccs[a.i].path_span.end, reason: 'broken', bp, source: bp ? sourceSpanOf(visits.slice(a.j + 1, b.j), 0) : null });
          openEnds.push({ path: path.binding, side: 'left', at: targetOccs[b.i].path_span.start, reason: 'broken', bp: 0, source: null });
        }
      }
    } else if (visits.length) {
      const bp = visits.reduce((t, v) => t + v.bp, 0);
      openEnds.push({ path: path.binding, side: 'left', at: window.start, reason: 'unplaced', bp, source: sourceSpanOf(visits, 0) });
    }
  }

  const familyCounter = { n: 0 };
  const buildFamilies = (g: GroupItem) => alignFamilies(g, lanes, familyCounter);
  const level = solveLevel({ backbone, members, depth: 0, targetSpan, lanes, idPrefix: '' }, buildFamilies);
  const junctions = level.junctions;

  // The top-level chain: segments, with junction items (gaps, fragment boundaries) between and at the window edges.
  const coverage = targetPath?.coverage ?? [];
  const gaps = coverage.filter(c => c.fragment == null && c.span.end > c.span.start);
  // Covered target sequence the response leaves out (a walk or frame budget): explicit, never squeezed away.
  const budgetReason = (span: Span) => {
    const s = (topology.summaries ?? []).find(x => x.binding === topology.target && x.source && (x.source as Span).start < span.end && span.start < (x.source as Span).end);
    return String(s?.reason ?? 'omitted');
  };
  {
    const visited = targetOccs.map(visitPiece).sort((a, b) => a.start - b.start);
    for (const c of coverage) {
      if (c.fragment == null) continue;
      const span = { start: Math.max(c.span.start, window.start), end: Math.min(c.span.end, window.end) };
      let at = span.start;
      for (const v of visited) {
        if (v.end <= at || v.start >= span.end) continue;
        if (v.start > at) gaps.push({ span: { start: at, end: v.start }, kind: budgetReason({ start: at, end: v.start }), fragment: null });
        at = Math.max(at, v.end);
      }
      if (at < span.end) gaps.push({ span: { start: at, end: span.end }, kind: budgetReason({ start: at, end: span.end }), fragment: null });
    }
    gaps.sort((a, b) => a.span.start - b.span.start);
  }
  const chain: Item[] = [];
  const gapsBetween = (lo: number, hi: number) => gaps.filter(c => c.span.start >= lo && c.span.end <= hi);
  const span = (list: GraphCoverage[], fallback: Span) => (list.length ? { start: list[0].span.start, end: list[list.length - 1].span.end } : fallback);
  const solutionOf = new Map(level.solutions.map(s => [s.key, s]));
  if (segs.length === 0) {
    chain.push({ kind: 'junction', id: 'jempty', gap: gaps[0] ?? null, gaps, target: span(gaps, window), leftEnd: 'unavailable', rightEnd: 'unavailable', alts: [], passing: [], stops: [], starts: [] });
  }
  segs.forEach((s, k) => {
    const startAt = targetOccs[s.from].path_span.start;
    if (k === 0) {
      const lead = gapsBetween(window.start, Math.max(window.start, startAt));
      if (lead.length) chain.push({ kind: 'junction', id: `jl${stableId(backbone.key(0, s.from))}`, gap: lead[0], gaps: lead, target: span(lead, window), leftEnd: 'unavailable', rightEnd: s.leftEnd, alts: [], passing: [], stops: [], starts: [] });
    }
    chain.push(...level.chains[k]);
    const endAt = targetOccs[s.to - 1].path_span.end;
    const next = segs[k + 1];
    if (next) {
      const nextAt = targetOccs[next.from].path_span.start;
      const between = gapsBetween(endAt, nextAt);
      const gap = between[0] ?? null;
      const crossing = junctions.get(k) ?? [];
      const bySig = new Map<string, Candidate[]>();
      for (const c of crossing) {
        const sig = signature(c.visits);
        const list = bySig.get(sig) ?? [];
        list.push(c);
        bySig.set(sig, list);
      }
      const id = `j${stableId(`${backbone.key(k, s.to)}>${backbone.key(k + 1, next.from)}`)}`;
      const alts: AltAllele[] = [...bySig.values()].map(list => ({
        id: `${id}.${stableId(list.map(c => c.path).join('+'))}`, carriers: list.map(c => c.path).sort((a, b) => lanes.indexOf(a) - lanes.indexOf(b)),
        visits: list[0].visits, bp: list[0].visits.reduce((t, v) => t + v.bp, 0), status: 'junction' as const,
        source: list.map(c => ({ path: c.path, span: c.source })),
      }));
      const crossingPaths = new Set(crossing.map(c => c.path));
      const passing = [topology.target, ...[...solutionOf.keys()].filter(key => !crossingPaths.has(key))];
      const stops = [...solutionOf.values()].filter(x => !crossingPaths.has(x.key) && x.anchorAt[s.to - 1] >= 0).map(x => x.key);
      const starts = [...solutionOf.values()].filter(x => !crossingPaths.has(x.key) && x.anchorAt[next.from] >= 0).map(x => x.key);
      chain.push({ kind: 'junction', id, gap, gaps: between, target: span(between, { start: endAt, end: nextAt }), leftEnd: s.rightEnd, rightEnd: next.leftEnd, alts, passing, stops, starts });
    } else {
      const trail = gapsBetween(Math.min(endAt, window.end), window.end);
      if (trail.length) chain.push({ kind: 'junction', id: `jr${stableId(backbone.key(k, s.to))}`, gap: trail[0], gaps: trail, target: span(trail, window), leftEnd: s.rightEnd, rightEnd: 'unavailable', alts: [], passing: [], stops: [], starts: [] });
    }
  });

  // Statistics and summaries.
  let insertions = 0, deletions = 0, substitutions = 0, inversions = 0, unplaced = 0;
  const walk = (items: Item[]) => {
    for (const it of items) {
      if (it.kind !== 'group') continue;
      if (it.type === 'bubble') {
        // Each distinct allele once, family members included (their sub-bubbles are within their own allele).
        for (const a of it.alts.flatMap(x => [x, ...(x.family?.members ?? [])])) {
          if (a.status !== 'ok') continue;
          if (a.inverted) inversions += 1;
          else if (it.base.bp === 0 && a.bp > 0) insertions += 1;
          else if (a.bp === 0) deletions += 1;
          else substitutions += 1;
        }
      }
      walk(it.base.chain);
    }
  };
  walk(chain);
  for (const e of openEnds) if (e.reason === 'unplaced' && e.bp > 0) unplaced += 1;
  // Open ends sit on drawn target geometry: a flank-margin or window-clipped anchor ends at the window edge.
  for (const e of openEnds) e.at = Math.max(window.start, Math.min(window.end, e.at));
  // Walks the response cut short (budget summaries on that path): their last placed visit is an open end.
  const budgetCut = new Set(['wire_limit', 'walk_limit', 'selected_node_limit', 'portion_visit_or_step_limit', 'unexpected_early_endmarker']);
  const laneNotes: Record<string, string> = {};
  for (const path of topology.paths) {
    if (path.binding === topology.target) continue;
    const cut = (topology.summaries ?? []).filter(s => s.binding === path.binding && budgetCut.has(String(s.reason)));
    const n = anchorCounts[path.binding] ?? 0;
    if (cut.length && n) {
      const ends = openEnds.filter(e => e.path === path.binding && e.side === 'right' && e.reason !== 'broken');
      // The walk's last stretch here is the budget's cut, whatever was left unplaced before it.
      for (const e of ends) if (e.reason !== 'fragment_terminal') e.reason = 'budget';
      if (!ends.length) {
        const member = members.find(x => x.key === path.binding)!;
        const last = member.anchors[member.anchors.length - 1];
        openEnds.push({ path: path.binding, side: 'right', at: Math.max(window.start, Math.min(window.end, targetOccs[last.i].path_span.end)), reason: 'budget', bp: 0, source: null });
      }
    }
    if (!n) {
      const why = cut[0]?.reason ?? (topology.summaries ?? []).find(s => s.binding === path.binding)?.reason
        ?? (path.occurrences.length ? 'no direct match to the target here' : 'nothing extracted here');
      laneNotes[path.binding] = String(why).replace(/_/g, ' ');
    }
  }
  const summaries = (topology.summaries ?? []).map(s => summaryText(s as Record<string, unknown>));
  for (const path of topology.paths) {
    for (const s of path.plan?.summaries ?? []) summaries.push(summaryText({ binding: path.binding, ...(s as Record<string, unknown>) }));
  }
  const visits = topology.paths.reduce((t, p) => t + p.occurrences.length, 0);
  let repeats = 0;
  for (const list of memberVisits.values()) for (const v of list) if (v.repeat) repeats += 1;
  return {
    interval: window, target: topology.target, chain, openEnds, laneNotes,
    rows: topology.paths.map(p => ({
      key: p.binding, label: laneLabel(byKey.get(p.binding), p.binding), title: laneTitle(byKey.get(p.binding), p.binding),
      role: p.binding === topology.target ? 'target' as const : 'alternate' as const,
    })),
    complete: topology.complete, correspondenceComplete: topology.correspondence_complete, summaries,
    stats: {
      nodes: topology.nodes.length, edges: topology.edges.length, visits,
      groups: level.counts.groups + familyCounter.n, insertions, deletions, substitutions, inversions, repeats, complex: level.counts.complex,
      unresolved: level.counts.unresolved, unplaced, anchors: anchorCounts,
    },
  };
}

// ---------------------------------------------------------------------------------------------------- repeats

/** At most this many visits of one node per path are unrolled with return arcs (design: four). */
export const MAX_REPEAT_VISITS = 4;

/**
 * Unrolling repeats by occurrence: a path visit that is not an anchor but walks a node this path also walks as an
 * anchor (a tandem copy, a repeat inside an insertion) is a repeat visit of that anchored host occurrence — the
 * nearest one along the path. Every visit of such a node is numbered (n of count), anchors included.
 */
function annotateRepeats(visits: Visit[], anchors: Anchor[], host: GraphOccurrence[]): void {
  const anchoredAt = new Map<string, { j: number; i: number }[]>();
  for (const a of anchors) {
    if (a.j < 0 || a.j >= visits.length || a.i < 0 || a.i >= host.length) continue;
    const node = visits[a.j].occ.node;
    const list = anchoredAt.get(node) ?? [];
    list.push(a);
    anchoredAt.set(node, list);
  }
  if (!anchoredAt.size) return;
  const byNode = new Map<string, number[]>();
  visits.forEach((v, j) => {
    if (!anchoredAt.has(v.occ.node)) return;
    const list = byNode.get(v.occ.node) ?? [];
    list.push(j);
    byNode.set(v.occ.node, list);
  });
  const anchorJ = new Set(anchors.map(a => a.j));
  for (const [node, js] of byNode) {
    if (js.length < 2) continue;
    const anchored = anchoredAt.get(node)!;
    js.forEach((j, n) => {
      if (anchorJ.has(j)) return;
      let best = anchored[0];
      for (const a of anchored) if (Math.abs(a.j - j) < Math.abs(best.j - j)) best = a;
      visits[j].repeat = { of: host[best.i].id, n: n + 1, count: js.length };
    });
  }
}

// ---------------------------------------------------------------------------------------------------- families

/**
 * Align a group's alternate alleles that share nodes on the first of them (lane order): shared stretches become
 * one tube, differences sub-bubbles. A member needs shared bp of at least a fifth of the shorter allele (and 10 bp)
 * — one tiny common node does not make two alleles one family.
 */
function alignFamilies(group: GroupItem, lanes: string[], counter: { n: number }): void {
  if (group.depth + 1 >= MAX_DEPTH || group.alts.length < 2) return;
  const remaining = group.alts.filter(a => a.status === 'ok' && a.visits.length > 0);
  const kept: AltAllele[] = group.alts.filter(a => !remaining.includes(a));
  while (remaining.length) {
    const lead = remaining.shift()!;
    const leadCount = new Map<string, number>();
    lead.visits.forEach(v => leadCount.set(`${v.occ.node}${v.reverse ? '-' : '+'}`, (leadCount.get(`${v.occ.node}${v.reverse ? '-' : '+'}`) ?? 0) + 1));
    const leadAt = new Map<string, number>();
    lead.visits.forEach((v, i) => leadAt.set(`${v.occ.node}${v.reverse ? '-' : '+'}`, i));
    const members: { allele: AltAllele; anchors: Anchor[] }[] = [];
    for (let k = 0; k < remaining.length; k++) {
      const other = remaining[k];
      const count = new Map<string, number>();
      other.visits.forEach(v => count.set(`${v.occ.node}${v.reverse ? '-' : '+'}`, (count.get(`${v.occ.node}${v.reverse ? '-' : '+'}`) ?? 0) + 1));
      const pairs: { a: number; b: number }[] = [];
      other.visits.forEach((v, j) => {
        const sig = `${v.occ.node}${v.reverse ? '-' : '+'}`;
        if (count.get(sig) === 1 && leadCount.get(sig) === 1) pairs.push({ a: j, b: leadAt.get(sig)! });
      });
      pairs.sort((x, y) => x.a - y.a || y.b - x.b);
      const chain = colinearChain(pairs);
      const shared = chain.reduce((t, p) => t + other.visits[p.a].bp, 0);
      if (!chain.length || shared < Math.max(10, 0.2 * Math.min(lead.bp, other.bp))) continue;
      members.push({ allele: other, anchors: [{ j: -1, i: -1 }, ...chain.map(p => ({ j: p.a, i: p.b })), { j: other.visits.length, i: lead.visits.length }] });
    }
    if (!members.length) { kept.push(lead); continue; }
    for (const m of members) remaining.splice(remaining.indexOf(m.allele), 1);
    // Each member allele may have several carriers; at this level a member is keyed by its first carrier.
    const memberKey = (a: AltAllele) => a.carriers[0];
    const n = lead.visits.length;
    const backbone: Backbone = {
      host: lead.carriers[0], visits: lead.visits, segments: [{ from: 0, to: n, fragment: lead.id }], segOf: new Int32Array(n),
      own: lead.carriers.slice(),
      key: (_seg, p) => (p < n ? `${lead.id}|${lead.visits[p].occ.id}|0` : `${lead.id}|end`),
    };
    const level = solveLevel({
      backbone, depth: group.depth + 1, targetSpan: null, lanes, idPrefix: `${lead.id}/`,
      members: members.map(m => ({
        key: memberKey(m.allele), visits: m.allele.visits, anchors: m.anchors,
        continuous: (a, b) => (b.i <= a.i ? 'order reversed' : null),
      })),
    }, () => undefined);
    counter.n += level.counts.groups;
    // Member alleles with several carriers: their other carriers ride with the first everywhere.
    const expand = (items: Item[]) => {
      for (const it of items) {
        if (it.kind === 'run') it.carriers = expandCarriers(it.carriers, members.map(m => m.allele), lanes);
        else if (it.kind === 'group') {
          it.base.carriers = expandCarriers(it.base.carriers, members.map(m => m.allele), lanes);
          it.unavailable = expandCarriers(it.unavailable, members.map(m => m.allele), lanes);
          for (const a of it.alts) a.carriers = expandCarriers(a.carriers, members.map(m => m.allele), lanes);
          expand(it.base.chain);
        }
      }
    };
    expand(level.chains[0]);
    lead.family = { members: members.map(m => m.allele), chain: level.chains[0] };
    kept.push(lead);
  }
  const order = new Map(lanes.map((k, i) => [k, i]));
  group.alts = kept.sort((a, b) => (order.get(a.carriers[0]) ?? 99) - (order.get(b.carriers[0]) ?? 99));
}

function expandCarriers(keys: string[], alleles: AltAllele[], lanes: string[]): string[] {
  const out = new Set(keys);
  for (const a of alleles) if (keys.includes(a.carriers[0])) for (const c of a.carriers) out.add(c);
  return [...out].sort((x, y) => lanes.indexOf(x) - lanes.indexOf(y));
}

/** All paths of an allele and its family (lead first). */
export function familyCarriers(a: AltAllele, lanes: string[]): string[] {
  const out = new Set(a.carriers);
  for (const m of a.family?.members ?? []) for (const c of m.carriers) out.add(c);
  return [...out].sort((x, y) => lanes.indexOf(x) - lanes.indexOf(y));
}
