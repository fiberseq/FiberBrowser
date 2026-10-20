/**
 * Molecules along their graph walk (DESIGN_GRAPH_PANEL.md §5, Gate E): **source alignment → selected source-path
 * occurrences → scene**.
 *
 * A read (services/graph_panel/reads.py) comes in absolute source coordinates of the path it is aligned to, its
 * calls composed by the live-lift composer before any node is in sight: whole calls, their identities, legacy
 * MSPs and gaps inferred between whole calls. Here it is placed:
 *
 * - **Visits.** Each occurrence of the read's path that its alignment overlaps is one visit, whatever CIGAR holes
 *   fall inside it: the visit keeps its coverage slices and holes, never a second visit for a hole. A read
 *   insertion (CIGAR I) has no path bp: a badge at its source boundary.
 * - **Placement.** A visit's bases go through the scene's own occurrence transforms (`OccurrencePlacement`): the
 *   same x as the path's stripe or allele, marks and family tubes included, mirrored with the panel. An
 *   occurrence the scene does not draw (a cluster, a complex summary, an unplaced run) places nothing; that bp is
 *   counted, and the molecule's walk crosses it as a dashed connector. So does connector space between placements
 *   (a bypassed allele, a curve zone): no body, call or mark is drawn there.
 * - **Calls.** A call is cut at visit edges and at the read's coverage holes for drawing only. Every piece keeps
 *   the call's whole size, identity, logical part and qualities; its own left/right edge qualities go to the
 *   screen side its call edge is on (they swap where a placement runs right to left), and only on a piece that
 *   holds that edge of the call. Nothing is inferred at a node boundary.
 */
import type { OccurrencePlacement, Scene } from './scene';
import type { CallLayer } from './chromatinStyle';
import type { GraphOccurrence, GraphRead, GraphReadLayer, GraphTopology, Span } from './types';

export interface ReadPiece { x0: number; x1: number; /** absolute source span */ s0: number; s1: number; occ: string; dir: 1 | -1 }

export interface CallPiece extends ReadPiece {
  layer: CallLayer;
  index: number;
  /** The whole call: span, size and identity (never the piece's). */
  call: [number, number, number];
  id: string | null;
  part: [number, number] | null;
  qualities: Record<string, number>;
  /** Edge qualities by screen side, only where this piece holds that edge of the call. */
  edgeL?: number;
  edgeR?: number;
  inferred?: boolean;
}

/** A hole in a record's coverage: a CIGAR deletion (D) or a skip (N, a hole with no D event). */
export interface ReadHole extends Span { kind: 'D' | 'N' }

/** One visit of a record: an occurrence it overlaps, its coverage there and the holes (CIGAR D/N) inside it. */
export interface ReadVisit { occ: string; node: string; span: Span; slices: Span[]; holes: ReadHole[]; ins: { pos: number; len: number }[] }

export interface PlacedMolecule {
  read: GraphRead;
  lane: string;
  visits: ReadVisit[];
  body: ReadPiece[];
  calls: CallPiece[];
  m6a: { x: number; pos: number }[];
  density: { x0: number; x1: number; count: number; bp: number }[];
  ins: { x: number; pos: number; len: number }[];
  holes: { x0: number; x1: number; s0: number; s1: number; kind: 'D' | 'N' }[];
  /** Between consecutive body pieces of the walk: connector space ('connector') or bp the scene did not draw ('unplaced'). */
  connectors: { x0: number; x1: number; kind: 'connector' | 'unplaced' }[];
  extent: [number, number] | null;
  /** Aligned bp inside the scene's drawn range of this path that no placement draws (clusters, summaries). */
  unplacedBp: number;
  /** Calls and m6A ticks left out by the panel's primitive budget (the body is still drawn). */
  marksHidden?: boolean;
}

export interface PlacementIndex { byOcc: Map<string, OccurrencePlacement[]>; occurrences: Map<string, GraphOccurrence[]>;
  /** Per path, the source range [lo, hi) its placements draw (bp outside it are simply outside the view). */
  drawnRange: Map<string, [number, number]> }

/** Placements by occurrence (of the path they belong to), and each path's occurrences in path order. */
export function placementIndex(scene: Scene, topology: GraphTopology): PlacementIndex {
  const byOcc = new Map<string, OccurrencePlacement[]>();
  for (const o of scene.occurrences) {
    const list = byOcc.get(o.occ);
    if (list) list.push(o); else byOcc.set(o.occ, [o]);
  }
  const occurrences = new Map<string, GraphOccurrence[]>();
  const byId = new Map<string, GraphOccurrence>();
  for (const p of topology.paths) {
    occurrences.set(p.binding, [...p.occurrences].sort((a, b) => a.path_span.start - b.path_span.start || a.path_span.end - b.path_span.end));
    for (const o of p.occurrences) byId.set(`${p.binding}\u0000${o.id}`, o);
  }
  const drawnRange = new Map<string, [number, number]>();
  for (const o of scene.occurrences) {
    const occ = byId.get(`${o.path}\u0000${o.occ}`);
    if (!occ || o.end <= o.start) continue;
    const a = occ.path_span.start + o.start, b = occ.path_span.start + o.end;
    const r = drawnRange.get(o.path);
    drawnRange.set(o.path, r ? [Math.min(r[0], a), Math.max(r[1], b)] : [a, b]);
  }
  return { byOcc, occurrences, drawnRange };
}

/** x of a path-forward offset `u` (a base boundary, 0..len) in a placement. */
export function xAtOffset(p: OccurrencePlacement, u: number): number {
  const f = (u - p.start) / Math.max(1e-9, p.end - p.start);
  return p.dir === 1 ? p.x0 + f * (p.x1 - p.x0) : p.x1 - f * (p.x1 - p.x0);
}

/** The x range of path-forward offsets [a, b) of an occurrence in a placement (sorted). */
export function xRangeForOffsets(p: OccurrencePlacement, a: number, b: number): [number, number] {
  const xa = xAtOffset(p, a), xb = xAtOffset(p, b);
  return xa <= xb ? [xa, xb] : [xb, xa];
}

function intersect(a: Span[], b: Span): Span[] {
  const out: Span[] = [];
  for (const s of a) {
    const lo = Math.max(s.start, b.start), hi = Math.min(s.end, b.end);
    if (hi > lo) out.push({ start: lo, end: hi });
  }
  return out;
}

/** Each placement of an occurrence with the offsets it draws that no earlier placement drew. */
function drawnParts(list: OccurrencePlacement[] | undefined, path: string): { p: OccurrencePlacement; span: Span }[] {
  const out: { p: OccurrencePlacement; span: Span }[] = [];
  const done: Span[] = [];
  for (const p of list ?? []) {
    if (p.path !== path || p.end <= p.start) continue;
    let parts: Span[] = [{ start: p.start, end: p.end }];
    for (const d of done) {
      parts = parts.flatMap(s => {
        if (d.end <= s.start || d.start >= s.end) return [s];
        const r: Span[] = [];
        if (d.start > s.start) r.push({ start: s.start, end: d.start });
        if (d.end < s.end) r.push({ start: d.end, end: s.end });
        return r;
      });
    }
    for (const span of parts) { out.push({ p, span }); done.push(span); }
  }
  return out;
}

const QUALITY_NAMES = ['nq', 'lq', 'rq', 'aq', 'tq', 'el', 'er', 'q0'] as const;

/** Merge pieces that continue each other on screen and in source (a call or a body over contiguous nodes of one
 * tube): fewer primitives, the same geometry. Edge qualities come from the pieces that hold them. */
function mergeRuns<T extends ReadPiece & { edgeL?: number; edgeR?: number }>(pieces: T[], same: (a: T, b: T) => boolean): T[] {
  const out: T[] = [];
  for (const p of pieces) {
    const q = out[out.length - 1];
    if (q && same(q, p) && q.dir === p.dir && q.s1 === p.s0
      && (p.dir === 1 ? Math.abs(q.x1 - p.x0) <= 0.5 : Math.abs(q.x0 - p.x1) <= 0.5)) {
      const merged = { ...q, x0: Math.min(q.x0, p.x0), x1: Math.max(q.x1, p.x1), s1: p.s1 } as T;
      if ('edgeL' in q || 'edgeR' in q || 'edgeL' in p || 'edgeR' in p) {
        merged.edgeL = p.dir === 1 ? q.edgeL : p.edgeL;
        merged.edgeR = p.dir === 1 ? p.edgeR : q.edgeR;
      }
      out[out.length - 1] = merged;
    } else out.push(p);
  }
  return out;
}

/** Place one record along its path's walk. */
export function placeRead(read: GraphRead, index: PlacementIndex, lane = read.b): PlacedMolecule {
  const occs = index.occurrences.get(read.b) ?? [];
  const cov: Span[] = read.cov.map(([a, b]) => ({ start: a, end: b }));
  const dels = read.dl ?? [];
  const holeKind = (h: Span): 'D' | 'N' => (dels.some(([pos, len]) => pos < h.end && pos + len > h.start) ? 'D' : 'N');
  const out: PlacedMolecule = { read, lane, visits: [], body: [], calls: [], m6a: [], density: [], ins: [], holes: [], connectors: [], extent: null, unplacedBp: 0 };
  // Every drawn slice of the walk, in path order (disjoint in source): [source span, placement, visit start].
  const drawn: { s0: number; s1: number; p: OccurrencePlacement; vs: number; occ: GraphOccurrence }[] = [];
  let lo = 0, hi = occs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (occs[m].path_span.end <= read.s) lo = m + 1; else hi = m; }
  for (let i = lo; i < occs.length && occs[i].path_span.start < read.e; i++) {
    const occ = occs[i];
    const vs = occ.path_span.start;
    const span: Span = { start: Math.max(read.s, vs), end: Math.min(read.e, occ.path_span.end) };
    if (span.end <= span.start) continue;
    const slices = intersect(cov, span);
    const holes: ReadHole[] = [];
    let at = span.start;
    for (const sl of slices) { if (sl.start > at) holes.push({ start: at, end: sl.start, kind: 'D' }); at = sl.end; }
    if (at < span.end && slices.length) holes.push({ start: at, end: span.end, kind: 'D' });
    for (const h of holes) h.kind = holeKind(h);
    // A read insertion belongs to the visit its boundary opens (a terminal one to the last visit).
    const ins = read.ins.filter(([pos]) => (pos >= span.start && pos < span.end) || (pos === read.e && span.end === read.e))
      .map(([pos, len]) => ({ pos, len }));
    out.visits.push({ occ: occ.id, node: occ.node, span, slices, holes, ins });
    const parts = drawnParts(index.byOcc.get(occ.id), read.b);
    for (const sl of slices) {
      for (const { p, span: d } of parts) {
        const a = Math.max(sl.start, vs + d.start), b = Math.min(sl.end, vs + d.end);
        if (b <= a) continue;
        drawn.push({ s0: a, s1: b, p, vs, occ });
      }
    }
    // Holes inside drawn geometry: a line through a deletion, nothing through a skip.
    for (const h of holes) {
      for (const { p, span: d } of parts) {
        const a = Math.max(h.start, vs + d.start), b = Math.min(h.end, vs + d.end);
        if (b <= a) continue;
        const [x0, x1] = xRangeForOffsets(p, a - vs, b - vs);
        out.holes.push({ x0, x1, s0: a, s1: b, kind: h.kind });
      }
    }
  }
  drawn.sort((u, v) => u.s0 - v.s0 || u.s1 - v.s1);
  const rawBody: ReadPiece[] = drawn.map(d => {
    const [x0, x1] = xRangeForOffsets(d.p, d.s0 - d.vs, d.s1 - d.vs);
    return { x0, x1, s0: d.s0, s1: d.s1, occ: d.occ.id, dir: d.p.dir };
  });
  // Unplaced: aligned bp inside this path's drawn range that no placement draws (prefixes and suffixes too).
  const range = index.drawnRange.get(read.b);
  if (range) {
    const inRange = intersect(cov, { start: range[0], end: range[1] }).reduce((t, c) => t + c.end - c.start, 0);
    out.unplacedBp = Math.max(0, inRange - drawn.reduce((t, d) => t + d.s1 - d.s0, 0));
  }
  // Connectors: wherever consecutive drawn slices of the walk are apart on screen (not touching or overlapping,
  // as a small difference's widened mark does). Aligned bases between them are bp the scene did not draw (a
  // cluster or a summary inside the walk); otherwise it is connector space (or a hole).
  for (let k = 1; k < rawBody.length; k++) {
    const a = rawBody[k - 1], b = rawBody[k];
    if (b.x0 <= a.x1 + 1.5 && a.x0 <= b.x1 + 1.5) continue;
    const between = intersect(cov, { start: a.s1, end: b.s0 }).reduce((t, c) => t + c.end - c.start, 0);
    const xa = a.dir === 1 ? a.x1 : a.x0, xb = b.dir === 1 ? b.x0 : b.x1;
    out.connectors.push({ x0: Math.min(xa, xb), x1: Math.max(xa, xb), kind: between > 0 ? 'unplaced' : 'connector' });
  }
  out.body = mergeRuns(rawBody, () => true);
  if (out.body.length) {
    out.extent = [Math.min(...out.body.map(b => b.x0), ...out.connectors.map(c => c.x0)),
      Math.max(...out.body.map(b => b.x1), ...out.connectors.map(c => c.x1))];
  }
  // Calls, marks and insertions through the same drawn slices (binary search: only the slices a call overlaps).
  const first = (pos: number) => {
    let lo2 = 0, hi2 = drawn.length;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (drawn[m].s1 <= pos) lo2 = m + 1; else hi2 = m; }
    return lo2;
  };
  const at = (pos: number) => { const k = first(pos); return k < drawn.length && drawn[k].s0 <= pos ? drawn[k] : null; };
  for (const layer of ['nuc', 'tf', 'msp'] as CallLayer[]) {
    const l: GraphReadLayer | undefined = read[layer];
    if (!l) continue;
    l.iv.forEach(([cs, ce, size], index) => {
      const qualities: Record<string, number> = {};
      for (const name of QUALITY_NAMES) { const v = l[name]?.[index]; if (v !== undefined && v !== null) qualities[name] = v; }
      const leftQ = layer === 'tf' ? qualities.el : qualities.lq;
      const rightQ = layer === 'tf' ? qualities.er : qualities.rq;
      const pieces: CallPiece[] = [];
      for (let k = first(cs); k < drawn.length && drawn[k].s0 < ce; k++) {
        const d = drawn[k];
        const a = Math.max(cs, d.s0), b = Math.min(ce, d.s1);
        if (b <= a) continue;
        const [x0, x1] = xRangeForOffsets(d.p, a - d.vs, b - d.vs);
        // The call's source-left edge is on this piece's screen-left when the placement runs left to right.
        const srcLeft = a === cs ? leftQ ?? 255 : undefined;
        const srcRight = b === ce ? rightQ ?? 255 : undefined;
        pieces.push({ x0, x1, s0: a, s1: b, occ: d.occ.id, dir: d.p.dir, layer, index, call: [cs, ce, size],
          id: l.id[index] ?? null, part: l.part[index] ?? null, qualities,
          ...(d.p.dir === 1 ? { edgeL: srcLeft, edgeR: srcRight } : { edgeL: srcRight, edgeR: srcLeft }),
          ...(l.inferred ? { inferred: true } : {}) });
      }
      out.calls.push(...mergeRuns(pieces, () => true));
    });
  }
  for (const pos of read.m6a ?? []) {
    const d = at(pos);
    if (!d) continue;
    const [x0, x1] = xRangeForOffsets(d.p, pos - d.vs, pos + 1 - d.vs);
    out.m6a.push({ x: (x0 + x1) / 2, pos });
  }
  for (const [s0, e0, count] of read.m6a_density ?? []) {
    for (let k = first(s0); k < drawn.length && drawn[k].s0 < e0; k++) {
      const d = drawn[k];
      const a = Math.max(s0, d.s0), b = Math.min(e0, d.s1);
      if (b <= a) continue;
      const [x0, x1] = xRangeForOffsets(d.p, a - d.vs, b - d.vs);
      out.density.push({ x0, x1, count: count * (b - a) / (e0 - s0), bp: b - a });
    }
  }
  for (const [pos, len] of read.ins) {
    // The boundary before `pos`: the drawn slice ending there, else the one starting there.
    const k = first(pos - 1);
    const d = (k < drawn.length && drawn[k].s1 === pos ? drawn[k] : null) ?? at(pos);
    if (!d) continue;
    out.ins.push({ x: xAtOffset(d.p, pos - d.vs), pos, len });
  }
  return out;
}

export interface PackedLane { lane: string; rows: PlacedMolecule[][]; hidden: number }

/** Rows per lane: first fit by x extent (a molecule's records stay on their own rows, in molecule order). */
export function packMolecules(molecules: PlacedMolecule[], maxRows: number, gapPx = 3): Map<string, PackedLane> {
  const lanes = new Map<string, PackedLane>();
  const byLane = new Map<string, PlacedMolecule[]>();
  for (const m of molecules) {
    if (!m.extent) continue;
    const list = byLane.get(m.lane);
    if (list) list.push(m); else byLane.set(m.lane, [m]);
  }
  for (const [lane, list] of byLane) {
    list.sort((a, b) => a.extent![0] - b.extent![0] || a.read.k.localeCompare(b.read.k));
    const rows: PlacedMolecule[][] = [];
    const ends: number[] = [];
    let hidden = 0;
    for (const m of list) {
      let r = ends.findIndex(e => e + gapPx <= m.extent![0]);
      if (r < 0) {
        if (rows.length >= maxRows) { hidden++; continue; }
        r = rows.length; rows.push([]); ends.push(-Infinity);
      }
      rows[r].push(m);
      ends[r] = m.extent![1];
    }
    lanes.set(lane, { lane, rows, hidden });
  }
  return lanes;
}

/** The panel's mark-primitive budget (DESIGN §7): call pieces, m6A ticks and density bins drawn. */
export const MAX_READ_PRIMITIVES = 100_000;

/** Place every read of a response; reads whose path is not drawn are counted. Past the primitive budget, m6A ticks
 * become per-pixel density; if calls alone still pass it, the molecules last in the response's (hash) order keep
 * their bodies only (`marksHidden`). */
export function placeReads(reads: GraphRead[], index: PlacementIndex, maxPrimitives = MAX_READ_PRIMITIVES): {
  molecules: PlacedMolecule[]; offLane: number; unplacedBp: number; empty: number; primitives: number; m6aAsDensity: boolean; marksHidden: number } {
  const molecules: PlacedMolecule[] = [];
  let offLane = 0, unplacedBp = 0, empty = 0;
  for (const r of reads) {
    if (!index.occurrences.has(r.b)) { offLane++; continue; }
    const m = placeRead(r, index);
    unplacedBp += m.unplacedBp;
    if (!m.body.length) { empty++; continue; }
    molecules.push(m);
  }
  const count = (m: PlacedMolecule) => m.calls.length + m.m6a.length + m.density.length;
  let primitives = molecules.reduce((t, m) => t + count(m), 0);
  let m6aAsDensity = false;
  if (primitives > maxPrimitives) {
    m6aAsDensity = true;
    for (const m of molecules) {
      if (!m.m6a.length) continue;
      const bins = new Map<number, number>();
      for (const t of m.m6a) { const b = Math.floor(t.x); bins.set(b, (bins.get(b) ?? 0) + 1); }
      const bpPerPx = m.body.reduce((t, b) => t + b.s1 - b.s0, 0) / Math.max(1e-9, m.body.reduce((t, b) => t + b.x1 - b.x0, 0));
      m.density = [...m.density, ...[...bins].map(([x, n]) => ({ x0: x, x1: x + 1, count: n, bp: Math.max(1, bpPerPx) }))];
      m.m6a = [];
    }
    primitives = molecules.reduce((t, m) => t + count(m), 0);
  }
  let marksHidden = 0;
  if (primitives > maxPrimitives) {
    let used = 0;
    for (const m of molecules) {
      const n = count(m);
      if (used + n > maxPrimitives) { m.calls = []; m.m6a = []; m.density = []; m.marksHidden = true; marksHidden++; continue; }
      used += n;
    }
    primitives = used;
  }
  return { molecules, offLane, unplacedBp, empty, primitives, m6aAsDensity, marksHidden };
}
