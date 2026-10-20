/**
 * Placing the joint layout model (layout.ts) into a scene (DESIGN_GRAPH_PANEL.md §4, "Widths and transforms"):
 * screen geometry, hit regions and the target-coordinate map, all serializable.
 *
 * - **Budgets.** A maximal unbranched run of `L` bp is `g(L) = L` up to 200 bp, else `200 + 100·log2(L/200)`
 *   virtual units (linear compression: `L`), shared by its visits in proportion to bp — one 1,000 bp node and ten
 *   100 bp nodes take the same width. A group's content is its widest allele: the base allele's own chain (nested
 *   children counted once, inside it) or an alternate allele (a family's chain); at least 12 px, plus a curve zone
 *   either side where branching paths leave and rejoin.
 * - **Scale.** Virtual units become pixels at the one scale that fills the data width (bisection: total width is
 *   monotonic in it). When the fixed pixels of many small bubbles would leave too little room, consecutive small
 *   bubbles merge into inspectable clusters; bubbles of 100 bp or more never do.
 * - **Lanes.** Each path keeps one lane. The target's lane holds the shared tube, one stripe slot per path in lane
 *   order; an alternate allele is drawn in its lead path's lane; family members share its tube. Empty filler between
 *   shorter alleles is connector space, not sequence.
 * - **Coordinates.** Target-backed geometry maps to true target coordinates (ruler ticks, cursor); an insertion slot
 *   maps to its boundary only, never to a made-up target interval. A reversed panel mirrors the finished scene.
 */
import { familyCarriers, type AltAllele, type GroupItem, type Item, type JunctionItem, type LayoutModel, type OpenEnd, type RunItem, type Visit } from './layout';
import type { GraphCoverage, Span } from './types';

export type Compression = 'log' | 'linear';

export interface SceneOptions {
  width: number;
  gutter: number;
  rightPad: number;
  rulerHeight: number;
  laneHeight: number;
  laneGap: number;
  compression: Compression;
  reversed: boolean;
  colors: Record<string, string>;
}

/** Fixed pixels of a bubble: its minimum content slot and the curve zone either side. Compact when crowded. */
export interface Metrics { min: number; curve: number }
export const ROOMY: Metrics = { min: 12, curve: 9 };
export const COMPACT: Metrics = { min: 8, curve: 5 };
export const MIN_SLOT_PX = ROOMY.min;
export const CURVE_PX = ROOMY.curve;
/** A bubble whose content is at least this many bp is never merged into a cluster. */
const MAJOR_BP = 100;

export function budget(bp: number, compression: Compression): number {
  if (bp <= 0) return 0;
  if (compression === 'linear' || bp <= 200) return bp;
  return 200 + 100 * Math.log2(bp / 200);
}

// ---------------------------------------------------------------------------------------------------- scene types

export interface Slot { key: string; y: number; h: number; color: string }

export type Prim =
  | { t: 'tube'; x0: number; x1: number; y: number; h: number; slots: Slot[]; present: string[]; nodes: number[];
      style: 'seq' | 'unresolved'; breaks: number[]; outline: string }
  | { t: 'stripe'; x0: number; x1: number; y: number; h: number; color: string; style: 'edge' | 'connector' | 'dashed' }
  | { t: 'curve'; x0: number; y0: number; x1: number; y1: number; color: string; w: number; dashed: boolean }
  | { t: 'text'; x: number; y: number; text: string; color: string; align: 'left' | 'center' | 'right'; size: number; bold: boolean }
  | { t: 'gap'; x0: number; x1: number; y: number; h: number }
  | { t: 'mark'; x: number; y: number; h: number }
  | { t: 'cap'; x: number; y: number; r: number; color: string }
  | { t: 'dots'; x0: number; x1: number; y: number; color: string }
  | { t: 'tick'; x: number; y: number; h: number; color: string }
  | { t: 'cluster'; x0: number; x1: number; y: number; h: number }
  | { t: 'frame'; x0: number; x1: number; y0: number; y1: number; color: string; dashed: boolean };

export type HitPayload =
  | { kind: 'run'; run: RunItem; host: string; visit: Visit; offset: number }
  | { kind: 'allele'; group: GroupItem | JunctionItem; allele: AltAllele; lane: string; visit: Visit | null; offset: number }
  | { kind: 'base'; group: GroupItem; lane: string }
  | { kind: 'slot'; group: GroupItem; boundary: number | null }
  | { kind: 'filler'; group: GroupItem | JunctionItem; allele: AltAllele; lane: string }
  | { kind: 'gap'; junction: JunctionItem; gap?: GraphCoverage }
  | { kind: 'complex'; group: GroupItem }
  | { kind: 'cluster'; cluster: ClusterItem }
  | { kind: 'end'; end: OpenEnd };

export interface SceneHit {
  x0: number; x1: number; y0: number; y1: number; payload: HitPayload; cursor: boolean;
  /** Inside an allele family's tube: the enclosing group and family lead (hover names the allele first). */
  within?: { group: GroupItem; allele: AltAllele };
}

/** Piecewise map between target coordinates and x: a slot (t0 === t1) is an insertion boundary. */
export interface TargetMapEntry { x0: number; x1: number; t0: number; t1: number; kind: 'seq' | 'slot' | 'gap' | 'cluster' }

export interface ClusterItem {
  kind: 'cluster';
  id: string;
  items: Item[];
  target: Span;
  bp: number;
  variants: number;
  perPath: Record<string, number>;
}

export interface SceneRow { key: string; label: string; title: string; role: 'target' | 'alternate'; color: string; top: number; center: number; height: number }

export interface Scene {
  width: number;
  height: number;
  dataLeft: number;
  dataWidth: number;
  scale: number;
  rows: SceneRow[];
  prims: Prim[];
  hits: SceneHit[];
  targetMap: TargetMapEntry[];
  clusters: number;
  metrics: Metrics;
  /** Top-level block identities in draw order (pan determinism). */
  blocks: { id: string; kind: string; x0: number; x1: number }[];
  reversed: boolean;
}

// ---------------------------------------------------------------------------------------------------- widths

type TopItem = Item | ClusterItem;

function contentWidth(items: TopItem[], scale: number, c: Compression, k: Metrics = ROOMY): number {
  let w = 0;
  for (const it of items) w += itemWidth(it, scale, c, k);
  return w;
}

function alleleWidth(a: AltAllele, scale: number, c: Compression, k: Metrics = ROOMY): number {
  return a.family ? contentWidth(a.family.chain, scale, c, k) : budget(a.bp, c) * scale;
}

function groupContent(g: GroupItem, scale: number, c: Compression, k: Metrics = ROOMY): number {
  let w = contentWidth(g.base.chain, scale, c, k);
  for (const a of g.alts) w = Math.max(w, alleleWidth(a, scale, c, k));
  return Math.max(k.min, w);
}

function junctionContent(j: JunctionItem, scale: number, c: Compression, k: Metrics = ROOMY): number {
  let w = j.gaps.reduce((t, g) => t + budget(g.span.end - g.span.start, c) * scale, 0);
  for (const a of j.alts) w = Math.max(w, budget(a.bp, c) * scale);
  return Math.max(j.gaps.length || j.alts.some(a => a.bp > 0) ? k.min * Math.max(1, j.gaps.length) : 4, w);
}

/** An item's width at a scale (tests: budgets and child-once accounting). */
export function layoutWidth(it: Item | ClusterItem, scale: number, c: Compression, k: Metrics = ROOMY): number {
  return itemWidth(it, scale, c, k);
}

function itemWidth(it: TopItem, scale: number, c: Compression, k: Metrics = ROOMY): number {
  switch (it.kind) {
    case 'run': return budget(it.bp, c) * scale;
    case 'group': return groupContent(it, scale, c, k) + 2 * k.curve;
    case 'junction': return junctionContent(it, scale, c, k) + 2 * k.curve;
    case 'cluster': return Math.max(k.min, budget(it.bp, c) * scale);
  }
}

function solveScale(items: TopItem[], available: number, c: Compression, k: Metrics): number {
  const fixed = contentWidth(items, 0, c, k);
  if (fixed >= available) return 0;
  let lo = 0, hi = 1;
  while (contentWidth(items, hi, c, k) < available && hi < 1e6) hi *= 2;
  for (let n = 0; n < 40; n++) {
    const mid = (lo + hi) / 2;
    if (contentWidth(items, mid, c, k) < available) lo = mid; else hi = mid;
  }
  return lo;
}

/** The longest allele anywhere inside a group (nested children and family sub-bubbles included). */
function maxAlleleBp(g: GroupItem): number {
  let m = Math.max(g.base.bp, ...g.alts.map(a => a.bp));
  const inner = (items: Item[]) => { for (const it of items) if (it.kind === 'group') m = Math.max(m, maxAlleleBp(it)); };
  inner(g.base.chain);
  for (const a of g.alts) if (a.family) inner(a.family.chain);
  return m;
}

/** Merge consecutive small top-level bubbles (separated by runs shorter than `distance` bp) into clusters. */
function clusterChain(chain: Item[], distance: number, anySize = false): TopItem[] {
  const out: TopItem[] = [];
  let pending: Item[] = [];
  const small = (it: Item) => it.kind === 'group' && (anySize || (it.type === 'bubble' && maxAlleleBp(it) < MAJOR_BP));
  const flush = () => {
    // Trailing runs are not part of a cluster.
    const tail: Item[] = [];
    while (pending.length && pending[pending.length - 1].kind === 'run') tail.unshift(pending.pop()!);
    const groups = pending.filter((it): it is GroupItem => it.kind === 'group');
    if (groups.length >= 2) {
      const spans = pending.map(it => (it.kind === 'run' ? it.target : it.kind === 'group' ? it.target : null)).filter((s): s is Span => s != null);
      const target = { start: Math.min(...spans.map(s => s.start)), end: Math.max(...spans.map(s => s.end)) };
      const perPath: Record<string, number> = {};
      for (const g of groups) for (const a of g.alts) for (const c of familyCarriers(a, [])) perPath[c] = (perPath[c] ?? 0) + 1;
      out.push({ kind: 'cluster', id: `c${groups[0].id}~${groups[groups.length - 1].id}`, items: pending, target,
        bp: target.end - target.start, variants: groups.length, perPath });
    } else out.push(...pending);
    out.push(...tail);
    pending = [];
  };
  for (const it of chain) {
    if (small(it)) { pending.push(it); continue; }
    if (it.kind === 'run' && pending.length && it.bp < distance) { pending.push(it); continue; }
    flush();
    out.push(it);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------------- placement

export function buildScene(model: LayoutModel, opts: SceneOptions): Scene {
  const lanes = model.rows.map(r => r.key);
  const dataLeft = opts.gutter;
  const dataWidth = Math.max(40, opts.width - opts.gutter - opts.rightPad);
  const c = opts.compression;
  const rows: SceneRow[] = model.rows.map((r, i) => {
    const top = opts.rulerHeight + opts.laneGap + i * (opts.laneHeight + opts.laneGap);
    return { ...r, color: opts.colors[r.key] ?? '#475569', top, center: top + opts.laneHeight / 2, height: opts.laneHeight };
  });
  const rowOf = new Map(rows.map(r => [r.key, r]));
  const stripe = Math.max(2, Math.min(6, Math.floor((opts.laneHeight - 12) / Math.max(1, lanes.length))));
  const colorOf = (k: string) => opts.colors[k] ?? '#475569';

  // Crowded: compact curve zones first; cluster only when the bubbles' fixed pixels would still crowd out the
  // sequence.
  let top: TopItem[] = model.chain;
  const k: Metrics = contentWidth(top, 0, c, ROOMY) > dataWidth * 0.6 ? COMPACT : ROOMY;
  const span = model.interval.end - model.interval.start;
  for (let distance = 32; contentWidth(top, 0, c, k) > dataWidth * 0.6 && distance <= 2 * span; distance *= 2) {
    top = clusterChain(model.chain, distance);
  }
  // Still overflowing (many large bubbles): cluster bubbles of any size rather than ever zeroing sequence widths;
  // every cluster lists its members.
  for (let distance = 32; contentWidth(top, 0, c, k) > dataWidth * 0.9 && distance <= 2 * span; distance *= 2) {
    top = clusterChain(model.chain, distance, true);
  }
  const clusters = top.filter(t => t.kind === 'cluster').length;
  const scale = solveScale(top, dataWidth, c, k);
  const CURVE = k.curve;

  const prims: Prim[] = [];
  const overlay: Prim[] = [];
  const hitList: SceneHit[] = [];
  let within: SceneHit['within'];
  // Hits are pushed outermost first: a later (inner, narrower) hit wins at a point.
  const hits = { push: (h: SceneHit) => { hitList.push(within ? { ...h, within } : h); } };
  const targetMap: TargetMapEntry[] = [];
  const blocks: Scene['blocks'] = [];

  /** Slot y positions of a tube in a lane, for these carriers (lane order). */
  const slotsIn = (lane: string, carriers: string[]): Map<string, Slot> => {
    const row = rowOf.get(lane)!;
    const h = carriers.length * stripe;
    const out = new Map<string, Slot>();
    carriers.forEach((k, i) => out.set(k, { key: k, y: row.center - h / 2 + i * stripe, h: stripe, color: colorOf(k) }));
    return out;
  };
  const backboneSlots = slotsIn(model.target, lanes);

  /** Node boundaries inside a run, at least 5 px apart (and from its ends): legible cuts, not a barcode. */
  const nodeEdges = (visits: Visit[], x0: number, w: number, bp: number) => {
    const out: number[] = [];
    if (bp <= 0) return out;
    let acc = 0, last = x0;
    for (let i = 0; i < visits.length - 1; i++) {
      acc += visits[i].bp;
      const x = x0 + (acc / bp) * w;
      if (x - last >= 5 && x0 + w - x >= 5) { out.push(x); last = x; }
    }
    return out;
  };

  const tube = (x0: number, w: number, slots: Map<string, Slot>, present: string[], visits: Visit[], bp: number, style: 'seq' | 'unresolved') => {
    if (w <= 0.01) return;
    const all = [...slots.values()];
    const y = Math.min(...all.map(s => s.y)), h = all.reduce((t, s) => t + s.h, 0);
    const breaks = c === 'log' && bp > 200 && w > 26 ? [x0 + w / 2] : [];
    prims.push({ t: 'tube', x0, x1: x0 + w, y, h, slots: all, present, nodes: w > 4 ? nodeEdges(visits, x0, w, bp) : [], style, breaks, outline: '#cbd5e1' });
    if (c === 'log' && bp > 200 && w > 54) {
      overlay.push({ t: 'text', x: x0 + w / 2, y: y - 3, text: formatBpShort(bp), color: '#94a3b8', align: 'center', size: 9, bold: false });
    }
  };

  /** The host stripes of `keys` straight across [x0, x1] (edges: full stripes; filler: connector). */
  const straight = (x0: number, x1: number, slots: Map<string, Slot>, keys: string[], style: 'edge' | 'connector' | 'dashed') => {
    if (x1 - x0 <= 0.01) return;
    for (const k of keys) {
      const s = slots.get(k);
      if (!s) continue;
      if (style === 'edge') prims.push({ t: 'stripe', x0, x1, y: s.y, h: s.h, color: s.color, style });
      else prims.push({ t: 'stripe', x0, x1, y: s.y + s.h / 2 - 0.75, h: 1.5, color: s.color, style });
    }
  };

  /** Lay a chain out from x in a host tube; returns its width. `onTarget`: the host is the target backbone. */
  const placeChain = (items: TopItem[], x: number, host: string, slots: Map<string, Slot>, onTarget: boolean, depth: number): number => {
    const start = x;
    for (const it of items) {
      const w = itemWidth(it, scale, c, k);
      if (depth === 0) blocks.push({ id: it.id, kind: it.kind === 'group' ? `${it.kind}:${it.type}` : it.kind, x0: x, x1: x + w });
      if (it.kind === 'run') placeRun(it, x, w, host, slots, onTarget);
      else if (it.kind === 'group') placeGroup(it, x, w, host, slots, onTarget, depth);
      else if (it.kind === 'junction') placeJunction(it, x, w, slots);
      else placeCluster(it, x, w, slots);
      x += w;
    }
    return x - start;
  };

  function placeRun(run: RunItem, x: number, w: number, host: string, slots: Map<string, Slot>, onTarget: boolean) {
    if (w <= 0.01) return;
    tube(x, w, slots, run.carriers, run.visits, run.bp, 'seq');
    const row = rowOf.get(host)!;
    hits.push({ x0: x, x1: x + w, y0: row.top, y1: row.top + row.height, cursor: onTarget,
      payload: { kind: 'run', run, host, visit: run.visits[0], offset: 0 } });
    if (onTarget) {
      let acc = 0;
      for (const v of run.visits) {
        if (v.target && v.bp > 0) {
          const x0 = x + (acc / run.bp) * w, x1 = x + ((acc + v.bp) / run.bp) * w;
          targetMap.push({ x0, x1, t0: v.target.start, t1: v.target.end, kind: 'seq' });
        }
        acc += v.bp;
      }
    }
  }

  function placeGroup(g: GroupItem, x: number, w: number, host: string, slots: Map<string, Slot>, onTarget: boolean, depth: number) {
    const gx0 = x, gx1 = x + w, cx0 = gx0 + CURVE, cx1 = gx1 - CURVE;
    const hostRow = rowOf.get(host)!;
    const baseW = contentWidth(g.base.chain, scale, c, k);
    // Base allele: its chain in the host tube, the base carriers' stripes through the curve zones and filler.
    if (baseW > 0) {
      // The group's own hit first: its base sequence and nested children (pushed after) win where they are.
      hits.push({ x0: gx0, x1: gx1, y0: hostRow.top, y1: hostRow.top + hostRow.height, cursor: false, payload: { kind: 'base', group: g, lane: host } });
      straight(gx0, cx0, slots, g.base.carriers, 'edge');
      placeChain(g.base.chain, cx0, host, slots, onTarget, depth + 1);
      straight(cx0 + baseW, cx1, slots, g.base.carriers, 'connector');
      straight(cx1, gx1, slots, g.base.carriers, 'edge');
    } else {
      // An empty base allele (an insertion slot): connector space, the boundary only.
      straight(gx0, gx1, slots, g.base.carriers, 'connector');
      if (onTarget && g.target) targetMap.push({ x0: gx0, x1: gx1, t0: g.target.start, t1: g.target.start, kind: 'slot' });
      hits.push({ x0: gx0, x1: gx1, y0: hostRow.top, y1: hostRow.top + hostRow.height, cursor: false,
        payload: { kind: 'slot', group: g, boundary: g.target ? g.target.start : null } });
    }
    if (g.type === 'complex') {
      const involved = g.alts.map(a => a.carriers[0]);
      const ys = [hostRow, ...involved.map(k => rowOf.get(k)!)];
      const y0 = Math.min(...ys.map(r => r.top)) + 1, y1 = Math.max(...ys.map(r => r.top + r.height)) - 1;
      overlay.push({ t: 'frame', x0: gx0 + 2, x1: gx1 - 2, y0, y1, color: '#d97706', dashed: true });
      if (w > 50) overlay.push({ t: 'text', x: (gx0 + gx1) / 2, y: y1 - 3, text: 'complex region', color: '#b45309', align: 'center', size: 9, bold: true });
      for (const a of g.alts) {
        const lane = a.carriers[0];
        const row = rowOf.get(lane)!;
        if (lane !== host) {
          const own = slotsIn(lane, [lane]).get(lane)!;
          const hs = slots.get(lane);
          if (hs) {
            prims.push({ t: 'curve', x0: gx0, y0: hs.y + hs.h / 2, x1: cx0, y1: own.y + own.h / 2, color: own.color, w: 1.5, dashed: true });
            prims.push({ t: 'curve', x0: cx1, y0: own.y + own.h / 2, x1: gx1, y1: hs.y + hs.h / 2, color: own.color, w: 1.5, dashed: true });
          }
          prims.push({ t: 'stripe', x0: cx0, x1: cx1, y: own.y + own.h / 2 - 0.75, h: 1.5, color: own.color, style: 'dashed' });
          if (w > 70 && a.bp > 0) overlay.push({ t: 'text', x: (cx0 + cx1) / 2, y: own.y - 3, text: `${formatBpShort(a.bp)} of its own`, color: own.color, align: 'center', size: 9, bold: false });
        }
        hits.push({ x0: gx0, x1: gx1, y0: row.top, y1: row.top + row.height, cursor: false, payload: { kind: 'complex', group: g } });
      }
      hits.push({ x0: gx0, x1: gx1, y0: hostRow.top, y1: hostRow.top + 6, cursor: false, payload: { kind: 'complex', group: g } });
      return;
    }
    for (const a of g.alts) {
      const lane = a.carriers[0];
      const row = rowOf.get(lane)!;
      const carriers = familyCarriers(a, lanes);
      const own = slotsIn(lane, carriers);
      const aw = alleleWidth(a, scale, c, k);
      const dashed = a.status !== 'ok';
      for (const k of carriers) {
        const hs = slots.get(k), as = own.get(k)!;
        if (!hs) continue;
        prims.push({ t: 'curve', x0: gx0, y0: hs.y + hs.h / 2, x1: cx0, y1: as.y + as.h / 2, color: as.color, w: as.h, dashed });
        prims.push({ t: 'curve', x0: cx1, y0: as.y + as.h / 2, x1: gx1, y1: hs.y + hs.h / 2, color: as.color, w: as.h, dashed });
      }
      // Lane hits first (sequence, then filler as connector); a family's own runs and sub-bubbles win inside.
      const seqEnd = a.bp > 0 ? cx0 + Math.max(1, aw) : cx0;
      if (a.bp > 0) hits.push({ x0: cx0, x1: seqEnd, y0: row.top, y1: row.top + row.height, cursor: false,
        payload: { kind: 'allele', group: g, allele: a, lane, visit: null, offset: 0 } });
      else hits.push({ x0: cx0, x1: cx1, y0: row.top, y1: row.top + row.height, cursor: false,
        payload: { kind: 'allele', group: g, allele: a, lane, visit: null, offset: 0 } });
      if (a.bp > 0 && cx1 > seqEnd) hits.push({ x0: seqEnd, x1: cx1, y0: row.top, y1: row.top + row.height, cursor: false,
        payload: { kind: 'filler', group: g, allele: a, lane } });
      for (const m of a.family?.members ?? []) {
        const mrow = rowOf.get(m.carriers[0]);
        if (!mrow) continue;
        hits.push({ x0: cx0, x1: seqEnd, y0: mrow.top, y1: mrow.top + mrow.height, cursor: false,
          payload: { kind: 'allele', group: g, allele: m, lane: m.carriers[0], visit: null, offset: 0 } });
        if (cx1 > seqEnd) hits.push({ x0: seqEnd, x1: cx1, y0: mrow.top, y1: mrow.top + mrow.height, cursor: false,
          payload: { kind: 'filler', group: g, allele: m, lane: m.carriers[0] } });
      }
      if (a.family) {
        const outer = within;
        within = outer ?? { group: g, allele: a };
        placeChain(a.family.chain, cx0, lane, own, false, depth + 1);
        within = outer;
      } else if (a.bp > 0) {
        tube(cx0, aw, own, carriers, a.visits, a.bp, dashed ? 'unresolved' : 'seq');
      }
      straight(cx0 + aw, cx1, own, carriers, a.bp > 0 ? 'connector' : (dashed ? 'dashed' : 'connector'));
      const label = alleleLabel(g, a);
      const tubeTop = Math.min(...[...own.values()].map(s => s.y));
      if (label && (cx1 - cx0) >= label.length * 5.2) {
        overlay.push({ t: 'text', x: (cx0 + Math.max(cx0 + aw, Math.min(cx1, cx0 + 60))) / 2, y: tubeTop - 3, text: label,
          color: colorOf(lane), align: 'center', size: 9, bold: g.base.bp === 0 && a.bp > 0 });
      }
      // Family members: their own lane says what they carry here (their shared stretches run in the lead's tube).
      for (const m of a.family?.members ?? []) {
        const mrow = rowOf.get(m.carriers[0]);
        if (!mrow) continue;
        const mlabel = alleleLabel(g, m);
        if (mlabel && (cx1 - cx0) >= mlabel.length * 5.2) {
          overlay.push({ t: 'text', x: (cx0 + Math.max(cx0 + aw, Math.min(cx1, cx0 + 60))) / 2, y: mrow.center - stripe - 2, text: mlabel,
            color: colorOf(m.carriers[0]), align: 'center', size: 9, bold: g.base.bp === 0 && m.bp > 0 });
        }
      }
    }
  }

  function placeJunction(j: JunctionItem, x: number, w: number, slots: Map<string, Slot>) {
    const gx0 = x, gx1 = x + w, cx0 = gx0 + CURVE, cx1 = gx1 - CURVE;
    const hostRow = rowOf.get(model.target)!;
    const all = [...slots.values()];
    const y = Math.min(...all.map(s => s.y)) - 2, h = all.reduce((t, s) => t + s.h, 0) + 4;
    hits.push({ x0: gx0, x1: gx1, y0: hostRow.top, y1: hostRow.top + hostRow.height, cursor: false, payload: { kind: 'gap', junction: j } });
    if (j.gaps.length) {
      // Each missing stretch in order, in proportion to its budget (at least a minimum each).
      const widths = j.gaps.map(g => Math.max(k.min, budget(g.span.end - g.span.start, c) * scale));
      const total = widths.reduce((t, x) => t + x, 0);
      const f = total > 0 ? Math.min(1, (cx1 - cx0) / total) : 1;
      let gx = cx0 + Math.max(0, (cx1 - cx0 - total * f) / 2);
      j.gaps.forEach((g, n) => {
        const gw = Math.max(2, widths[n] * f);
        prims.push({ t: 'gap', x0: gx, x1: gx + gw, y, h });
        targetMap.push({ x0: gx, x1: gx + gw, t0: g.span.start, t1: g.span.end, kind: 'gap' });
        if (gw > 54) overlay.push({ t: 'text', x: gx + gw / 2, y: y - 3, text: `${g.kind === 'graph_gap' ? 'gap' : g.kind.replace(/_/g, ' ')} ${formatBpShort(g.span.end - g.span.start)}`, color: '#64748b', align: 'center', size: 9, bold: false });
        hits.push({ x0: gx, x1: gx + gw, y0: hostRow.top, y1: hostRow.top + hostRow.height, cursor: false, payload: { kind: 'gap', junction: j, gap: g } });
        gx += gw;
      });
    }
    if (j.leftEnd === 'fragment_terminal') prims.push({ t: 'mark', x: gx0 + 1, y, h });
    if (j.rightEnd === 'fragment_terminal') prims.push({ t: 'mark', x: gx1 - 1, y, h });
    for (const a of j.alts) {
      const lane = a.carriers[0];
      const own = slotsIn(lane, a.carriers);
      if (a.bp > 0 && lane !== model.target) {
        const aw = budget(a.bp, c) * scale;
        for (const k of a.carriers) {
          const hs = slots.get(k)!, as = own.get(k)!;
          prims.push({ t: 'curve', x0: gx0, y0: hs.y + hs.h / 2, x1: cx0, y1: as.y + as.h / 2, color: as.color, w: as.h, dashed: false });
          prims.push({ t: 'curve', x0: cx1, y0: as.y + as.h / 2, x1: gx1, y1: hs.y + hs.h / 2, color: as.color, w: as.h, dashed: false });
        }
        tube(cx0, aw, own, a.carriers, a.visits, a.bp, 'seq');
        straight(cx0 + aw, cx1, own, a.carriers, 'connector');
        const row = rowOf.get(lane)!;
        hits.push({ x0: cx0, x1: cx0 + Math.max(1, aw), y0: row.top, y1: row.top + row.height, cursor: false, payload: { kind: 'allele', group: j, allele: a, lane, visit: null, offset: 0 } });
        if (cx1 > cx0 + aw + 1) hits.push({ x0: cx0 + Math.max(1, aw), x1: cx1, y0: row.top, y1: row.top + row.height, cursor: false, payload: { kind: 'filler', group: j, allele: a, lane } });
        if (cx1 - cx0 > 40) overlay.push({ t: 'text', x: cx0 + Math.min(aw, cx1 - cx0) / 2, y: Math.min(...[...own.values()].map(s => s.y)) - 3, text: `+${formatBpShort(a.bp)}`, color: colorOf(lane), align: 'center', size: 9, bold: true });
      } else {
        // Walks on with nothing of its own here: a dashed connector (continuous, no target sequence).
        straight(gx0, gx1, slots, a.carriers, 'dashed');
      }
    }
    // Compared paths with no named continuity across: their walks stop and start here.
    for (const [keys, cx] of [[j.stops, gx0], [j.starts, gx1]] as const) {
      for (const k of keys) {
        const s = slots.get(k);
        if (s) prims.push({ t: 'cap', x: cx, y: s.y + s.h / 2, r: s.h / 2 + 0.5, color: s.color });
      }
    }
  }

  function placeCluster(cl: ClusterItem, x: number, w: number, slots: Map<string, Slot>) {
    const carriers = new Set<string>();
    for (const it of cl.items) if (it.kind === 'run') it.carriers.forEach(k => carriers.add(k));
    const present = lanes.filter(k => carriers.has(k));
    const all = [...slots.values()];
    const y = Math.min(...all.map(s => s.y)), h = all.reduce((t, s) => t + s.h, 0);
    prims.push({ t: 'tube', x0: x, x1: x + w, y, h, slots: all, present, nodes: [], style: 'seq', breaks: [], outline: '#cbd5e1' });
    prims.push({ t: 'cluster', x0: x, x1: x + w, y: y - 2, h: h + 4 });
    // One dot per variant, in its carriers' lanes, at its relative target position.
    for (const it of cl.items) {
      if (it.kind !== 'group' || !it.target) continue;
      const f = cl.bp > 0 ? (it.target.start - cl.target.start) / cl.bp : 0.5;
      const dx = x + 2 + f * Math.max(0, w - 4);
      for (const a of it.alts) for (const k of familyCarriers(a, lanes)) {
        const row = rowOf.get(k);
        if (row && k !== model.target) overlay.push({ t: 'tick', x: dx, y: row.center - 4, h: 8, color: colorOf(k) });
      }
    }
    if (w > 46) overlay.push({ t: 'text', x: x + w / 2, y: y - 3, text: `${cl.variants} variants`, color: '#64748b', align: 'center', size: 9, bold: false });
    targetMap.push({ x0: x, x1: x + w, t0: cl.target.start, t1: cl.target.end, kind: 'cluster' });
    const lastRow = rows[rows.length - 1];
    hits.push({ x0: x, x1: x + w, y0: rows[0].top, y1: lastRow.top + lastRow.height, cursor: true, payload: { kind: 'cluster', cluster: cl } });
  }

  placeChain(top, dataLeft, model.target, backboneSlots, true, 0);

  // Open ends: caps where a path's verified walk stops; an unplaced run beyond gets a short dotted lead.
  targetMap.sort((p, q) => p.x0 - q.x0);
  for (const e of model.openEnds) {
    const s = backboneSlots.get(e.path);
    if (!s) continue;
    // A walk starting at `at` starts where base `at` does (after any slot there); one ending there, before it.
    const x = xForTarget(targetMap, e.at, e.side === 'left' ? 'end' : 'start');
    if (x == null) continue;
    prims.push({ t: 'cap', x, y: s.y + s.h / 2, r: s.h / 2 + 0.5, color: s.color });
    if ((e.reason === 'unplaced' || e.reason === 'budget') && e.bp > 0) {
      const x1 = e.side === 'left' ? x - 14 : x + 14;
      overlay.push({ t: 'dots', x0: Math.min(x, x1), x1: Math.max(x, x1), y: s.y + s.h / 2, color: s.color });
    }
    hits.push({ x0: x - 8, x1: x + 8, y0: s.y - 4, y1: s.y + s.h + 4, cursor: false, payload: { kind: 'end', end: e } });
  }

  // A lane with nothing placed says why, in its own row.
  for (const [key, note] of Object.entries(model.laneNotes)) {
    const row = rowOf.get(key);
    if (row) overlay.push({ t: 'text', x: dataLeft + 8, y: row.center + 3, text: `${note} — nothing placed in this view`, color: '#94a3b8', align: 'left', size: 10, bold: false });
  }
  targetMap.sort((a, b) => a.x0 - b.x0);
  const lastRow = rows[rows.length - 1];
  const scene: Scene = {
    width: opts.width, height: (lastRow ? lastRow.top + lastRow.height : opts.rulerHeight) + opts.laneGap,
    dataLeft, dataWidth, scale, rows, prims: [...prims, ...overlay], hits: hitList, targetMap, clusters, metrics: k, blocks, reversed: opts.reversed,
  };
  return opts.reversed ? mirror(scene) : scene;
}

function alleleLabel(g: GroupItem, a: AltAllele): string | null {
  if (a.status === 'unresolved') return `${formatBpShort(a.bp)} ?`;
  if (g.base.bp === 0) return `+${formatBpShort(a.bp)}`;
  if (a.bp === 0) return `−${formatBpShort(g.base.bp)}`;
  if (a.bp >= 10 || g.base.bp >= 10) return `${formatBpShort(a.bp)}/${formatBpShort(g.base.bp)}`;
  return null;
}

export function formatBpShort(bp: number): string {
  if (bp >= 10_000) return `${(bp / 1000).toFixed(1)} kb`;
  return `${Math.round(bp).toLocaleString('en-US')} bp`;
}

// ---------------------------------------------------------------------------------------------------- mapping

/**
 * x of a target coordinate on target-backed geometry (null outside it). A coordinate can occur at several x: at an
 * insertion boundary it is the whole slot. `start` gives its first x in sequence order (before the slot), `end` its
 * last (after it: where base `t` starts). `reversed`: the map belongs to a mirrored scene.
 */
export function xForTarget(map: TargetMapEntry[], t: number, edge: 'start' | 'end' = 'start', reversed = false): number | null {
  const xs: number[] = [];
  for (let n = 0; n < map.length; n++) {
    const m = map[reversed ? map.length - 1 - n : n];
    if (m.kind === 'slot') {
      if (m.t0 === t) xs.push(m.x0, m.x1);
      continue;
    }
    if (m.t1 > m.t0 && t >= m.t0 && t <= m.t1) xs.push(m.x0 + ((t - m.t0) / (m.t1 - m.t0)) * (m.x1 - m.x0));
  }
  if (!xs.length) return null;
  return edge === 'start' ? xs[0] : xs[xs.length - 1];
}

/** The target coordinate at x: a position in sequence, an insertion boundary (no interval), or null. */
export function targetAtX(map: TargetMapEntry[], x: number): { pos: number; boundary: boolean; kind: TargetMapEntry['kind'] } | null {
  for (const m of map) {
    const lo = Math.min(m.x0, m.x1), hi = Math.max(m.x0, m.x1);
    if (x < lo || x > hi) continue;
    if (m.kind === 'slot') return { pos: m.t0, boundary: true, kind: 'slot' };
    const f = hi > lo ? (x - m.x0) / (m.x1 - m.x0) : 0;
    return { pos: Math.min(m.t1 - 1, Math.max(m.t0, Math.floor(m.t0 + f * (m.t1 - m.t0)))), boundary: false, kind: m.kind };
  }
  return null;
}

/**
 * The discriminated inverse at a point: target sequence (occurrence and offset, true coordinate), a path's own
 * allele (occurrence and offset, plus its target boundary), connector space in an insertion slot (the boundary
 * only), a target gap, or a summary block. Never a made-up target base inside an insertion.
 */
export type SceneInverse =
  | { kind: 'target'; occurrence: string; offset: number; pos: number }
  | { kind: 'allele'; path: string; occurrence: string | null; offset: number; boundary: number | null; group: string }
  | { kind: 'connector'; group: string; boundary: number | null }
  | { kind: 'gap'; span: Span }
  | { kind: 'summary'; id: string; span: Span | null };

export function sceneInverse(scene: Scene, x: number, y: number): SceneInverse | null {
  const stack = scene.hits.filter(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
  const top = stack[stack.length - 1];
  if (!top) return null;
  const f = (h: SceneHit) => {
    const raw = (x - h.x0) / Math.max(1e-6, h.x1 - h.x0);
    return scene.reversed ? 1 - raw : raw;
  };
  const boundaryOf = (g: GroupItem | JunctionItem) => (g.kind === 'group' ? (g.target ? g.target.start : null) : g.target.start);
  const p = top.payload;
  switch (p.kind) {
    case 'run': {
      const at = locate(p.run.visits, p.run.bp, f(top));
      if (!at) return null;
      const offset = occurrenceOffset(at.visit, at.offset);
      if (at.visit.target) return { kind: 'target', occurrence: at.visit.occ.id, offset, pos: Math.min(at.visit.target.end - 1, at.visit.target.start + at.offset) };
      return { kind: 'allele', path: p.host, occurrence: at.visit.occ.id, offset, boundary: top.within ? boundaryOf(top.within.group) : null,
        group: top.within?.group.id ?? p.run.id };
    }
    case 'allele': {
      const boundary = boundaryOf(p.group);
      if (p.allele.bp === 0) return { kind: 'connector', group: p.group.id, boundary };
      if (!p.allele.family && !top.within && p.group.kind === 'group' && p.group.alts.every(a => a !== p.allele)) {
        // A family member: its shared stretches are the lead's runs in the lead's lane at this x.
        const lead = p.group.alts.find(a => a.family?.members.includes(p.allele));
        const run = lead && scene.hits.find(h => h.payload.kind === 'run' && h.payload.host === lead.carriers[0] && x >= h.x0 && x <= h.x1);
        if (run && run.payload.kind === 'run' && run.payload.run.carriers.includes(p.lane)) {
          const at = locate(run.payload.run.visits, run.payload.run.bp, f(run));
          const mine = at && p.allele.visits.find(v => v.occ.node === at.visit.occ.node);
          if (at && mine) return { kind: 'allele', path: p.lane, occurrence: mine.occ.id, offset: occurrenceOffset(mine, at.offset), boundary, group: p.group.id };
        }
        return { kind: 'allele', path: p.lane, occurrence: null, offset: 0, boundary, group: p.group.id };
      }
      const at = locate(p.allele.visits, p.allele.bp, f(top));
      return { kind: 'allele', path: p.lane, occurrence: at?.visit.occ.id ?? null, offset: at ? occurrenceOffset(at.visit, at.offset) : 0, boundary, group: p.group.id };
    }
    case 'filler': return { kind: 'connector', group: p.group.id, boundary: boundaryOf(p.group) };
    case 'slot': return { kind: 'connector', group: p.group.id, boundary: p.boundary };
    case 'base': {
      const t = targetAtX(scene.targetMap, x);
      return t && !t.boundary ? { kind: 'target', occurrence: '', offset: 0, pos: t.pos } : { kind: 'connector', group: p.group.id, boundary: p.group.target?.start ?? null };
    }
    case 'gap': return { kind: 'gap', span: (p.gap ?? p.junction.gap)?.span ?? p.junction.target };
    case 'complex': return { kind: 'summary', id: p.group.id, span: p.group.target };
    case 'cluster': return { kind: 'summary', id: p.cluster.id, span: p.cluster.target };
    case 'end': return { kind: 'summary', id: `${p.end.path}:${p.end.side}`, span: null };
  }
  return null;
}

/** An offset inside a drawn piece of a visit, as an offset in the whole visit (path-forward). */
function occurrenceOffset(v: Visit, offset: number): number {
  const start = v.target ? v.target.start - v.occ.path_span.start : v.occ.clip.start;
  return start + offset;
}

/** Hit test (the last match wins: overlays and narrow parts are pushed later). */
export function sceneHitAt(scene: Scene, x: number, y: number): SceneHit | null {
  for (let i = scene.hits.length - 1; i >= 0; i--) {
    const h = scene.hits[i];
    if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
  }
  return null;
}

/** Mirror a finished scene once (a user-reversed panel); biological coordinates are unchanged. */
function mirror(scene: Scene): Scene {
  const L = scene.dataLeft, R = scene.dataLeft + scene.dataWidth;
  const fx = (x: number) => L + R - x;
  const flip = <T extends { x0: number; x1: number }>(o: T): T => ({ ...o, x0: fx(o.x1), x1: fx(o.x0) });
  const prims = scene.prims.map((p): Prim => {
    switch (p.t) {
      case 'tube': return { ...flip(p), nodes: p.nodes.map(fx), breaks: p.breaks.map(fx) };
      case 'stripe': case 'gap': case 'cluster': case 'frame': case 'dots': return flip(p);
      case 'curve': return { ...p, x0: fx(p.x0), x1: fx(p.x1) };
      case 'text': return { ...p, x: fx(p.x), align: p.align === 'left' ? 'right' : p.align === 'right' ? 'left' : 'center' };
      case 'mark': case 'cap': case 'tick': return { ...p, x: fx(p.x) };
    }
  });
  const hits = scene.hits.map(h => flip(h));
  const targetMap = scene.targetMap.map(m => ({ ...m, x0: fx(m.x0), x1: fx(m.x1) })).sort((a, b) => Math.min(a.x0, a.x1) - Math.min(b.x0, b.x1));
  return { ...scene, prims, hits, targetMap, blocks: scene.blocks.map(b => flip(b)) };
}

// ---------------------------------------------------------------------------------------------------- hover text

const where = (n: number) => n.toLocaleString('en-US');

export function describeSceneHit(hit: SceneHit, x: number, model: LayoutModel, reversed = false): string {
  const own = describeOwn(hit, x, model, reversed);
  if (!hit.within) return own;
  // Inside a family's tube: name the allele this lane carries here first.
  const lane = hit.payload.kind === 'run' ? hit.payload.host : 'lane' in hit.payload ? hit.payload.lane : hit.within.allele.carriers[0];
  const allele = [hit.within.allele, ...(hit.within.allele.family?.members ?? [])].find(a => a.carriers.includes(lane)) ?? hit.within.allele;
  const outer = describeOwn({ ...hit, within: undefined, payload: { kind: 'allele', group: hit.within.group, allele, lane, visit: null, offset: 0 } }, x, model, reversed);
  return `${outer} · here: ${own}`;
}

function describeOwn(hit: SceneHit, x: number, model: LayoutModel, reversed: boolean): string | never {
  const label = (k: string) => model.rows.find(r => r.key === k)?.label ?? k;
  const p = hit.payload;
  switch (p.kind) {
    case 'run': {
      const run = p.run;
      const span = hit.x1 - hit.x0;
      const raw = (x - hit.x0) / Math.max(1, span);
      const at = run.visits.length ? locate(run.visits, run.bp, reversed ? 1 - raw : raw) : null;
      const who = run.carriers.map(label).join(', ');
      if (run.target && at?.visit.target) {
        const pos = Math.min(at.visit.target.end - 1, at.visit.target.start + at.offset);
        return `${label(p.host)} · node ${at.visit.occ.node} · ${where(pos)} on the target · ${formatBpShort(run.bp)} shared by ${who}`;
      }
      return `${label(p.host)} · node ${at?.visit.occ.node ?? '?'} · ${formatBpShort(run.bp)} shared by ${who}`;
    }
    case 'allele': {
      const a = p.allele;
      const g = p.group;
      const carriers = familyCarriers(a, model.rows.map(r => r.key)).map(label).join(', ');
      const src = a.source.map(s => `${label(s.path)} ${where(s.span.start)}-${where(s.span.end)}`).join('; ');
      if (g.kind === 'junction') return `${carriers} · ${formatBpShort(a.bp)} across a target fragment junction at ${where(g.target.start)} · source ${src}`;
      const span = g.target;
      const status = a.status === 'unresolved' ? ` · unresolved (${a.reason})` : '';
      const lens = a.family ? ` · ${[a, ...a.family.members].map(m => `${m.carriers.map(label).join('+')} ${formatBpShort(m.bp)}`).join(', ')}` : '';
      if (g.base.bp === 0 && span) return `${label(a.carriers[0])} · insertion of ${formatBpShort(a.bp)} at target boundary ${where(span.start)}${lens} · source ${src}${status}`;
      if (a.bp === 0 && span) return `${carriers} · deletion of ${formatBpShort(g.base.bp)} (target ${where(span.start)}-${where(span.end)})${status}`;
      if (span) return `${carriers} · ${formatBpShort(a.bp)} in place of target ${where(span.start)}-${where(span.end)} (${formatBpShort(g.base.bp)})${lens} · source ${src}${status}`;
      return `${carriers} · ${formatBpShort(a.bp)} in place of ${formatBpShort(g.base.bp)} of ${label(g.host)} · source ${src}${status}`;
    }
    case 'base': {
      const g = p.group;
      const alts = g.alts.map(a => `${familyCarriers(a, model.rows.map(r => r.key)).map(label).join('+')} ${formatBpShort(a.bp)}`).join(', ');
      const unavailable = g.unavailable.length ? ` · unavailable: ${g.unavailable.map(label).join(', ')}` : '';
      const span = g.target ? ` (target ${where(g.target.start)}-${where(g.target.end)})` : '';
      return `${g.base.carriers.map(label).join(', ')} ${formatBpShort(g.base.bp)}${span} · alternatives ${alts}${unavailable}`;
    }
    case 'filler': {
      const g = p.group;
      const at = g.kind === 'group' ? (g.target ? ` at target ${where(g.target.start)}` : '') : ` at the junction ${where(g.target.start)}`;
      return `${label(p.lane)} · connector space${at}: its ${formatBpShort(p.allele.bp)} allele is shorter than the slot (no sequence here)`;
    }
    case 'slot': {
      const g = p.group;
      const alts = g.alts.map(a => `${familyCarriers(a, model.rows.map(r => r.key)).map(label).join('+')} +${formatBpShort(a.bp)}`).join(', ');
      return `Insertion slot at target boundary ${p.boundary != null ? where(p.boundary) : '?'} · ${alts} · no target sequence (${g.base.carriers.map(label).join(', ')} pass straight through)`;
    }
    case 'gap': {
      const j = p.junction;
      const crossing = j.alts.map(a => `${a.carriers.map(label).join('+')}${a.bp ? ` +${formatBpShort(a.bp)}` : ''}`).join(', ');
      const g0 = p.gap ?? j.gap;
      const gap = g0 ? `${g0.kind.replace(/_/g, ' ')} ${where(g0.span.start)}-${where(g0.span.end)} (${formatBpShort(g0.span.end - g0.span.start)})` : `fragment junction at ${where(j.target.start)}`;
      return `${label(model.target)} · ${gap}${crossing ? ` · walking on: ${crossing}` : ''}${j.passing.length > 1 ? ` · no named continuity for ${j.passing.filter(k => k !== model.target).map(label).join(', ') || 'others'}` : ''}`;
    }
    case 'complex': {
      const g = p.group;
      const span = g.target ? `target ${where(g.target.start)}-${where(g.target.end)}` : 'here';
      const known = g.alts.map(a => `${label(a.carriers[0])} ${formatBpShort(a.bp)} of its own`).join(', ');
      return `Complex region ${span} (${formatBpShort(g.base.bp)} on the target) · ${g.reason ?? 'unresolved'} · ${known}${g.unavailable.length ? ` · unavailable: ${g.unavailable.map(label).join(', ')}` : ''}`;
    }
    case 'cluster': {
      const cl = p.cluster;
      const per = Object.entries(cl.perPath).map(([k, n]) => `${label(k)} ${n}`).join(', ');
      return `${cl.variants} small variants in target ${where(cl.target.start)}-${where(cl.target.end)} (${formatBpShort(cl.bp)}) · ${per} · zoom in to separate them`;
    }
    case 'end': {
      const e = p.end;
      if (e.reason === 'unplaced') return `${label(e.path)} · ${formatBpShort(e.bp)} beyond ${where(e.at)} not placed on the target (no named flank on that side)`;
      if (e.reason === 'fragment_terminal') return `${label(e.path)} · its fragment ${e.side === 'left' ? 'starts' : 'ends'} at target ${where(e.at)}`;
      if (e.reason === 'budget') return `${label(e.path)} · the response's budget cut its walk after target ${where(e.at)}${e.bp ? ` (${formatBpShort(e.bp)} beyond, unplaced)` : ''} · zoom in for the rest`;
      return `${label(e.path)} · its walk breaks at target ${where(e.at)} (no continuous named walk across)`;
    }
  }
}

function locate(visits: Visit[], bp: number, f: number): { visit: Visit; offset: number } | null {
  if (bp <= 0) return visits.length ? { visit: visits[0], offset: 0 } : null;
  const at = Math.max(0, Math.min(1, f)) * bp;
  let acc = 0;
  for (const v of visits) {
    if (at < acc + v.bp || v === visits[visits.length - 1]) return { visit: v, offset: Math.max(0, Math.min(v.bp - 1, Math.floor(at - acc))) };
    acc += v.bp;
  }
  return null;
}
