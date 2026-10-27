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
 * - **Segment lane.** The nucleosome segments and events (`nseg`) are cut the same way, one piece per drawn slice;
 *   each piece keeps its whole row's span and bytes.
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
  /** nuc/tf: the call's nucsz class, named and z bytes (null: no mark, or no named byte; absent: the layer carries
   * none). */
  cls?: number | null;
  nb?: number | null;
  zb?: number | null;
}

/** A piece of a segment-lane row (`nseg`): its whole row's span, code and bytes (never the piece's). */
export interface SegPiece extends ReadPiece {
  index: number;
  row: [number, number];
  code: number;
  /** Segments: the posterior byte; events: 10 x LLR. */
  value: number;
  /** Regular segments: q-hat - 100; events: the count. */
  extra: number;
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
  /** The segment lane's pieces (absent: the read carries no lane). */
  seg?: SegPiece[];
  m6a: { x: number; pos: number }[];
  density: { x0: number; x1: number; count: number; bp: number }[];
  ins: { x: number; pos: number; len: number }[];
  /** Soft (and hard) clips at the record's ends (graph features): the boundary's x, the clipped length, and the
   * screen direction the clipped sequence lies in (-1 left, 1 right; the path may be drawn right to left). */
  clips?: { x: number; pos: number; len: number; dir: 1 | -1 }[];
  holes: { x0: number; x1: number; s0: number; s1: number; kind: 'D' | 'N' }[];
  /** Between consecutive body pieces of the walk: connector space ('connector') or bp the scene did not draw ('unplaced'). */
  connectors: { x0: number; x1: number; kind: 'connector' | 'unplaced' }[];
  extent: [number, number] | null;
  /** Aligned bp inside the scene's drawn range of this path that no placement draws (clusters, summaries). */
  unplacedBp: number;
  /** Calls, m6A ticks and segment-lane pieces left out by the panel's primitive budget (the body is still drawn). */
  marksHidden?: boolean;
}

export interface PlacementIndex { byOcc: Map<string, OccurrencePlacement[]>; occurrences: Map<string, GraphOccurrence[]>;
  /** Per path, the source spans the view asked for (its windows less the flank walked past each edge): aligned bp
   * there that no placement draws are unplaced; bp beyond them are simply outside the view. */
  domain: Map<string, Span[]>;
  /** Each occurrence's drawn parts for its own path, computed once per scene (parallel to `occurrences`). */
  parts: Map<string, { p: OccurrencePlacement; span: Span }[][]> }

/** Placements by occurrence (of the path they belong to), and each path's occurrences in path order. `flankBp`:
 * the bp the topology request walked past each window edge (GraphPanel's FLANK_BP). */
export function placementIndex(scene: Scene, topology: GraphTopology, flankBp = 1): PlacementIndex {
  const byOcc = new Map<string, OccurrencePlacement[]>();
  for (const o of scene.occurrences) {
    const list = byOcc.get(o.occ);
    if (list) list.push(o); else byOcc.set(o.occ, [o]);
  }
  const occurrences = new Map<string, GraphOccurrence[]>();
  const domain = new Map<string, Span[]>();
  const parts = new Map<string, { p: OccurrencePlacement; span: Span }[][]>();
  for (const p of topology.paths) {
    const sorted = [...p.occurrences].sort((a, b) => a.path_span.start - b.path_span.start || a.path_span.end - b.path_span.end);
    occurrences.set(p.binding, sorted);
    domain.set(p.binding, p.windows.map(w => ({ start: w.start + flankBp, end: w.end - flankBp })).filter(w => w.end > w.start));
    parts.set(p.binding, sorted.map(o => drawnParts(byOcc.get(o.id), p.binding)));
  }
  return { byOcc, occurrences, domain, parts };
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

/** Sorted, disjoint spans `a` intersected with `b` (binary search to the first that can overlap). */
function intersect(a: Span[], b: Span): Span[] {
  const out: Span[] = [];
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].end <= b.start) lo = m + 1; else hi = m; }
  for (let i = lo; i < a.length && a[i].start < b.end; i++) {
    const s = Math.max(a[i].start, b.start), e = Math.min(a[i].end, b.end);
    if (e > s) out.push({ start: s, end: e });
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

/** What of a record to place beyond its body: calls (false past the panel's budget) and m6A, as ticks or binned. */
export interface PlaceOptions { calls?: boolean; m6aBinBp?: number;
  /** Keep the per-visit record (coverage slices, holes, insertions of every visit): inspection and tests; the panel
   * draws without it. */
  visits?: boolean }

/** Place one record along its path's walk. */
export function placeRead(read: GraphRead, index: PlacementIndex, lane = read.b, opts: PlaceOptions = {}): PlacedMolecule {
  const occs = index.occurrences.get(read.b) ?? [];
  const cov: Span[] = read.cov.map(([a, b]) => ({ start: a, end: b })).sort((x, y) => x.start - y.start);
  const dels: Span[] = (read.dl ?? []).map(([pos, len]) => ({ start: pos, end: pos + len })).sort((x, y) => x.start - y.start);
  // A coverage hole is a deletion where a D event covers it and a skip (N) elsewhere: a mixed D/N hole splits.
  const splitHole = (h: Span): ReadHole[] => {
    const out2: ReadHole[] = [];
    let at2 = h.start;
    for (const d of intersect(dels, h)) {
      if (d.start > at2) out2.push({ start: at2, end: d.start, kind: 'N' });
      out2.push({ start: d.start, end: d.end, kind: 'D' });
      at2 = d.end;
    }
    if (at2 < h.end) out2.push({ start: at2, end: h.end, kind: 'N' });
    return out2;
  };
  const insSorted = [...read.ins].sort((x, y) => x[0] - y[0]);
  let insAt = 0;
  const keepVisits = opts.visits !== false;
  const pathParts = index.parts.get(read.b);
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
    const parts = pathParts?.[i] ?? drawnParts(index.byOcc.get(occ.id), read.b);
    // Holes: kept for the visit record, and drawn where a placement draws them.
    const holes: ReadHole[] = [];
    if (keepVisits || parts.length) {
      // Inside the record's alignment every uncovered base is a hole, also an occurrence it covers not at all.
      let at = span.start;
      for (const sl of slices) { if (sl.start > at) holes.push(...splitHole({ start: at, end: sl.start })); at = sl.end; }
      if (at < span.end) holes.push(...splitHole({ start: at, end: span.end }));
    }
    if (keepVisits) {
      // A read insertion belongs to the visit its boundary opens (a terminal one to the last visit).
      while (insAt < insSorted.length && insSorted[insAt][0] < span.start) insAt++;
      const ins: { pos: number; len: number }[] = [];
      for (let k = insAt; k < insSorted.length && (insSorted[k][0] < span.end || (insSorted[k][0] === read.e && span.end === read.e)); k++) {
        ins.push({ pos: insSorted[k][0], len: insSorted[k][1] });
      }
      out.visits.push({ occ: occ.id, node: occ.node, span, slices, holes, ins });
    }
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
  // Unplaced: aligned bp inside the view's own source windows of this path that no placement draws (summarised
  // geometry inside the walk or at its ends, wholly undrawn reads); bp beyond the windows are outside the view.
  const asked = (index.domain.get(read.b) ?? []).reduce((t, w) => t + intersect(cov, w).reduce((u, c) => u + c.end - c.start, 0), 0);
  const drawnAsked = (index.domain.get(read.b) ?? []).reduce((t, w) => t + drawn.reduce((u, d) => u + Math.max(0, Math.min(d.s1, w.end) - Math.max(d.s0, w.start)), 0), 0);
  out.unplacedBp = Math.max(0, asked - drawnAsked);
  // Connectors: wherever consecutive drawn slices of the walk are apart on screen (not touching or overlapping,
  // as a small difference's widened mark does). Aligned bases between them are bp the scene did not draw (a
  // cluster or a summary inside the walk); otherwise it is connector space (or a hole).
  // A connector spans only the screen gap between the two slices (never across either's body, e.g. into an
  // allele drawn right to left), and none where a drawn hole already joins them.
  const holeBp = (a0: number, b0: number) => out.holes.reduce((t, h) => t + Math.max(0, Math.min(h.s1, b0) - Math.max(h.s0, a0)), 0);
  for (let k = 1; k < rawBody.length; k++) {
    const a = rawBody[k - 1], b = rawBody[k];
    if (b.x0 <= a.x1 + 1.5 && a.x0 <= b.x1 + 1.5) continue;
    const between = intersect(cov, { start: a.s1, end: b.s0 }).reduce((t, c) => t + c.end - c.start, 0);
    if (!between && b.s0 > a.s1 && holeBp(a.s1, b.s0) >= b.s0 - a.s1) continue;
    const [x0, x1] = a.x1 <= b.x0 ? [a.x1, b.x0] : [b.x1, a.x0];
    out.connectors.push({ x0, x1, kind: between > 0 ? 'unplaced' : 'connector' });
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
  // An interval [cs, ce) cut at the drawn slices it overlaps (visit edges, coverage holes): one piece per slice.
  const cut = (cs: number, ce: number) => {
    const pieces: ReadPiece[] = [];
    for (let k = first(cs); k < drawn.length && drawn[k].s0 < ce; k++) {
      const d = drawn[k];
      const a = Math.max(cs, d.s0), b = Math.min(ce, d.s1);
      if (b <= a) continue;
      const [x0, x1] = xRangeForOffsets(d.p, a - d.vs, b - d.vs);
      pieces.push({ x0, x1, s0: a, s1: b, occ: d.occ.id, dir: d.p.dir });
    }
    return pieces;
  };
  for (const layer of (opts.calls === false ? [] : ['nuc', 'tf', 'msp']) as CallLayer[]) {
    const l: GraphReadLayer | undefined = read[layer];
    if (!l) continue;
    l.iv.forEach(([cs, ce, size], index) => {
      const qualities: Record<string, number> = {};
      for (const name of QUALITY_NAMES) { const v = l[name]?.[index]; if (v !== undefined && v !== null) qualities[name] = v; }
      const leftQ = layer === 'tf' ? qualities.el : qualities.lq;
      const rightQ = layer === 'tf' ? qualities.er : qualities.rq;
      // The footprint's class and z bytes ride on every piece of the call (no extra primitive).
      const cls = l.cls ? { cls: l.cls[index] ?? null, nb: l.nb?.[index] ?? null, zb: l.zb?.[index] ?? null } : {};
      const pieces: CallPiece[] = cut(cs, ce).map(pc => {
        // The call's source-left edge is on this piece's screen-left when the placement runs left to right.
        const srcLeft = pc.s0 === cs ? leftQ ?? 255 : undefined;
        const srcRight = pc.s1 === ce ? rightQ ?? 255 : undefined;
        return { ...pc, layer, index, call: [cs, ce, size] as [number, number, number],
          id: l.id[index] ?? null, part: l.part[index] ?? null, qualities,
          ...(pc.dir === 1 ? { edgeL: srcLeft, edgeR: srcRight } : { edgeL: srcRight, edgeR: srcLeft }),
          ...(l.inferred ? { inferred: true } : {}), ...cls };
      });
      out.calls.push(...mergeRuns(pieces, () => true));
    });
  }
  // The segment lane: rows without a code are not drawn (as the read track's lane).
  const segLane = opts.calls === false ? undefined : read.nseg;
  if (segLane?.iv.length && segLane.code) {
    const seg: SegPiece[] = [];
    segLane.iv.forEach(([cs, ce], index) => {
      const code = segLane.code![index];
      if (!code) return;
      const bytes = { index, row: [cs, ce] as [number, number], code, value: segLane.p?.[index] ?? 0, extra: segLane.q3?.[index] ?? 0 };
      seg.push(...mergeRuns(cut(cs, ce).map(pc => ({ ...pc, ...bytes })), () => true));
    });
    if (seg.length) out.seg = seg;
  }
  // m6A: ticks, or (past the budget) counts per bin of source bp placed like density.
  const binned: [number, number, number][] = [];
  if (opts.calls !== false && opts.m6aBinBp && read.m6a?.length) {
    const bins = new Map<number, number>();
    for (const pos of read.m6a) { const b = Math.floor(pos / opts.m6aBinBp) * opts.m6aBinBp; bins.set(b, (bins.get(b) ?? 0) + 1); }
    for (const [b, n] of bins) binned.push([b, b + opts.m6aBinBp, n]);
  } else if (opts.calls !== false) {
    for (const pos of read.m6a ?? []) {
      const d = at(pos);
      if (!d) continue;
      const [x0, x1] = xRangeForOffsets(d.p, pos - d.vs, pos + 1 - d.vs);
      out.m6a.push({ x: (x0 + x1) / 2, pos });
    }
  }
  for (const [s0, e0, count] of opts.calls === false ? [] : [...(read.m6a_density ?? []), ...binned]) {
    // One bin is one primitive per run of screen-contiguous slices (a bin over many nodes of one tube is one rect).
    let run: { x0: number; x1: number; bp: number; dir: 1 | -1; edge: number } | null = null;
    const flush = () => { if (run) out.density.push({ x0: run.x0, x1: run.x1, count: count * run.bp / (e0 - s0), bp: run.bp }); run = null; };
    for (let k = first(s0); k < drawn.length && drawn[k].s0 < e0; k++) {
      const d = drawn[k];
      const a = Math.max(s0, d.s0), b = Math.min(e0, d.s1);
      if (b <= a) continue;
      const [x0, x1] = xRangeForOffsets(d.p, a - d.vs, b - d.vs);
      const start = d.p.dir === 1 ? x0 : x1;
      if (run && run.dir === d.p.dir && Math.abs(run.edge - start) <= 0.5) {
        run.x0 = Math.min(run.x0, x0); run.x1 = Math.max(run.x1, x1); run.bp += b - a; run.edge = d.p.dir === 1 ? x1 : x0;
      } else { flush(); run = { x0, x1, bp: b - a, dir: d.p.dir, edge: d.p.dir === 1 ? x1 : x0 }; }
    }
    flush();
  }
  for (const [pos, len] of read.ins) {
    // The boundary before `pos`: the drawn slice ending there, else the one starting there.
    const k = first(pos - 1);
    const d = (k < drawn.length && drawn[k].s1 === pos ? drawn[k] : null) ?? at(pos);
    if (!d) continue;
    out.ins.push({ x: xAtOffset(d.p, pos - d.vs), pos, len });
  }
  for (const [pos, len, side] of read.clips ?? []) {
    // A left clip at the record's first aligned base (the slice starting there), a right one after its last (the
    // slice ending there).
    const k = first(pos - 1);
    const d = side === 'R' ? ((k < drawn.length && drawn[k].s1 === pos ? drawn[k] : null) ?? at(pos - 1)) : at(pos);
    if (!d) continue;
    (out.clips ??= []).push({ x: xAtOffset(d.p, pos - d.vs), pos, len, dir: ((side === 'L' ? -1 : 1) * d.p.dir) as 1 | -1 });
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

/** The panel's mark-primitive budget (DESIGN §7): call pieces, m6A ticks, density bins and segment-lane pieces drawn. */
export const MAX_READ_PRIMITIVES = 100_000;

/** Place every read of a response; reads whose path is not drawn are counted. The budget is decided before the
 * marks are placed: past it (estimated from the calls, segment-lane rows and m6A each read carries), m6A is placed
 * as per-pixel density bins; molecules then take their calls and lane pieces in the response's (hash) order while
 * the budget lasts, and the rest keep their bodies only (`marksHidden`; `segHidden` of them carried a lane).
 * `bpPerPx`: the view's average density (density bin size). */
export function placeReads(all: GraphRead[], index: PlacementIndex, maxPrimitives = MAX_READ_PRIMITIVES, bpPerPx = 1): {
  molecules: PlacedMolecule[]; offLane: number; unplacedBp: number; empty: number; primitives: number; m6aAsDensity: boolean; marksHidden: number;
  segHidden: number } {
  // Reads on paths the scene does not draw are counted, never estimated or placed.
  const reads = all.filter(r => index.occurrences.has(r.b));
  const offLaneReads = all.length - reads.length;
  const callsOf = (r: GraphRead) => (r.nuc?.iv.length ?? 0) + (r.tf?.iv.length ?? 0) + (r.msp?.iv.length ?? 0) + (r.nseg?.iv.length ?? 0);
  const binFor = () => {
    // Density bins as fine as the budget allows: at least a pixel, coarser when the reads' pixels would not fit.
    const calls = reads.reduce((t, r) => t + callsOf(r), 0);
    const room = Math.max(1, 0.9 * maxPrimitives - calls);
    const px = reads.reduce((t, r) => t + ((r.m6a?.length ?? 0) > 0 ? (r.e - r.s) / Math.max(1e-9, bpPerPx) : 0), 0);
    return Math.max(1, Math.ceil(bpPerPx * Math.max(1, px / room)));
  };
  const pass = (m6aBinBp: number | undefined) => {
    const molecules: PlacedMolecule[] = [];
    let unplacedBp = 0, empty = 0, primitives = 0, marksHidden = 0, segHidden = 0, spent = false;
    const offLane = offLaneReads;
    for (const r of reads) {
      // Marks are placed only until the budget is spent: the first molecule whose marks do not fit ends it, and
      // every later one places its body alone (deterministic: the response's hash order).
      const m = placeRead(r, index, r.b, { calls: !spent, m6aBinBp, visits: false });
      unplacedBp += m.unplacedBp;
      if (!m.body.length) { empty++; continue; }
      const n = m.calls.length + m.m6a.length + m.density.length + (m.seg?.length ?? 0);
      if (spent || primitives + n > maxPrimitives) {
        spent = true;
        if (n || r.m6a?.length || r.m6a_density?.length || callsOf(r)) {
          m.calls = []; m.m6a = []; m.density = []; delete m.seg; m.marksHidden = true; marksHidden++;
          if (r.nseg?.iv.length) segHidden++;
        }
      } else primitives += n;
      molecules.push(m);
    }
    return { molecules, offLane, unplacedBp, empty, primitives, marksHidden, segHidden };
  };
  // m6A as density when the reads carry more marks than the budget; or when placing them as ticks overflowed
  // (calls split over many nodes amplify), a second pass with density bins.
  const carried = reads.reduce((t, r) => t + callsOf(r) + (r.m6a?.length ?? 0) + (r.m6a_density?.length ?? 0), 0);
  const hasM6a = reads.some(r => r.m6a?.length);
  let m6aAsDensity = carried > maxPrimitives && hasM6a;
  let out = pass(m6aAsDensity ? binFor() : undefined);
  if (out.marksHidden && !m6aAsDensity && hasM6a) {
    m6aAsDensity = true;
    out = pass(binFor());
  }
  return { ...out, m6aAsDensity };
}
