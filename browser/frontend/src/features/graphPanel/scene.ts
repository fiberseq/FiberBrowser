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
import { familyCarriers, MAX_REPEAT_VISITS, type AltAllele, type GroupItem, type Item, type JunctionItem, type LayoutModel, type OpenEnd, type RunItem, type Visit } from './layout';
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
  /** Draw a bubble whose every allele is shorter than this (bp) as marks on the shared tube; 0 or absent: bubbles
   * (see smallDifferenceBp). Inversions and unresolved alleles are always bubbles. */
  smallBp?: number;
  /** Extra height under a lane for its molecules (Gate E read bands), px by lane key. */
  bands?: Record<string, number>;
  /** Group IDs drawn at true bp (expanded insertions; Gate F). */
  expanded?: ReadonlySet<string>;
}

/** A marked run: consecutive runs and small differences on one host tube, drawn as one tube with marks. */
export interface MarkedItem {
  kind: 'marked';
  id: string;
  host: string;
  parts: (RunItem | GroupItem)[];
  /** Host sequence bp (runs plus the small groups' base alleles). */
  bp: number;
  target: Span | null;
}

/**
 * The small-difference threshold for a view: about four pixels' worth of bp at the window's average density,
 * 10–50 bp; zoomed in below 2.5 bp/px every difference is a bubble again (bubbles mode: always 0).
 */
export function smallDifferenceBp(spanBp: number, dataWidth: number, mode: 'marks' | 'bubbles' = 'marks'): number {
  if (mode === 'bubbles' || dataWidth <= 0) return 0;
  const bpPerPx = spanBp / dataWidth;
  if (bpPerPx < 2.5) return 0;
  return Math.round(Math.max(10, Math.min(50, 4 * bpPerPx)));
}

/** Fixed pixels of a bubble: its minimum content slot and the curve zone either side. Compact when crowded. */
export interface Metrics {
  min: number; curve: number; /** an empty junction (touching fragments), default 4 */ empty?: number;
  /** Small differences (every allele below this many bp) are marks on the shared tube, not bubbles; 0: all bubbles. */
  small?: number;
  /** Groups drawn at true bp (an insertion the user expanded with a plain click; schematic compression elsewhere). */
  expanded?: ReadonlySet<string>;
}
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
      style: 'seq' | 'unresolved'; breaks: number[]; outline: string;
      /** A marked run: which stripes are present along it (overrides `present` there). */
      segments?: { x0: number; x1: number; present: string[] }[];
      /** Chevrons along it: -1, walked against the target (an inverted allele). */
      arrows?: -1 | 1 }
  /** A repeat visit's return arc, back to the host occurrence it repeats (dashed, one of four tiers). */
  | { t: 'arc'; x0: number; y0: number; x1: number; y1: number; color: string; tier: number }
  /** A small difference on a tube stripe: a tick (substitution), notch (deletion) or caret (insertion), with a pin
   * outside the tube on the stripe's nearer side. */
  | { t: 'vmark'; x0: number; x1: number; y: number; h: number; ty0: number; ty1: number; side: 'up' | 'down';
      color: string; kind: 'sub' | 'del' | 'ins' }
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
  | { kind: 'run'; run: RunItem; host: string; visit: Visit; offset: number; stripes?: Stripe[] }
  | { kind: 'allele'; group: GroupItem | JunctionItem; allele: AltAllele; lane: string; visit: Visit | null; offset: number; stripes?: Stripe[] }
  | { kind: 'base'; group: GroupItem; lane: string; stripes?: Stripe[] }
  | { kind: 'slot'; group: GroupItem; boundary: number | null }
  | { kind: 'filler'; group: GroupItem | JunctionItem; allele: AltAllele; lane: string }
  | { kind: 'gap'; junction: JunctionItem; gap?: GraphCoverage }
  | { kind: 'complex'; group: GroupItem }
  | { kind: 'cluster'; cluster: ClusterItem }
  | { kind: 'end'; end: OpenEnd };

/** Where each carrier's stripe of a shared tube is (y range): a click on it means that path's own occurrence. */
export interface Stripe { key: string; y0: number; y1: number }

export interface SceneHit {
  x0: number; x1: number; y0: number; y1: number; payload: HitPayload; cursor: boolean;
  /** Inside an allele family's tube: the enclosing group and family lead (hover names the allele first). */
  within?: { group: GroupItem; allele: AltAllele };
}

/**
 * Where one drawn visit is (the occurrence transform): `[start, end)` path-forward offsets of the visit drawn over
 * `[x0, x1]`, increasing with x when `dir` is 1, decreasing when -1 (a minus comparison, an inverted allele, a
 * mirrored panel). `owner` is the run or allele drawing it, `lane` the lane it is in.
 */
export interface OccurrencePlacement { occ: string; node: string; lane: string; owner: string; x0: number; x1: number; start: number; end: number; dir: 1 | -1;
  /** The path whose occurrence this is: the lane's host, or another carrier on its stripe of a shared tube. */
  path: string }

/** Piecewise map between target coordinates and x: a slot (t0 === t1) is an insertion boundary. */
export interface TargetMapEntry { x0: number; x1: number; t0: number; t1: number; kind: 'seq' | 'slot' | 'gap' | 'cluster' }

export interface ClusterItem {
  kind: 'cluster';
  id: string;
  items: ChainItem[];
  target: Span;
  bp: number;
  variants: number;
  /** Variants of 100 bp or more inside (only an overflowing view clusters them). */
  major: number;
  perPath: Record<string, number>;
  /** Every member variant (nested and family ones too): its target position and carriers. */
  members: { at: number; carriers: string[]; bp: number }[];
}

export interface SceneRow { key: string; label: string; title: string; role: 'target' | 'alternate'; color: string; top: number; center: number; height: number;
  /** The lane's read band (its molecules), right under it: top y and height (0: none). */
  bandTop: number; bandHeight: number }

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
  /** The occurrence transforms of every drawn visit (inverse and forward hit lookups). */
  occurrences: OccurrencePlacement[];
  clusters: number;
  metrics: Metrics;
  /** Top-level block identities in draw order (pan determinism). */
  blocks: { id: string; kind: string; x0: number; x1: number }[];
  reversed: boolean;
}

// ---------------------------------------------------------------------------------------------------- widths

type TopItem = Item | ClusterItem | MarkedItem;
type ChainItem = Item | MarkedItem;

/** Every allele of a group, family members and nested ones included. */
function everyAllele(g: GroupItem, out: AltAllele[] = []): AltAllele[] {
  for (const a of g.alts) {
    out.push(a, ...(a.family?.members ?? []));
    for (const it of a.family?.chain ?? []) if (it.kind === 'group') everyAllele(it, out);
  }
  for (const it of g.base.chain) if (it.kind === 'group') everyAllele(it, out);
  return out;
}

/** A difference drawn as marks: a validated bubble whose alleles are all below the threshold, none inverted. */
export function isSmallDifference(g: GroupItem, small: number): boolean {
  if (small <= 0 || g.type !== 'bubble' || !g.alts.length) return false;
  if (maxAlleleBp(g) >= small) return false;
  // A family with differences inside it stays a bubble: its inner differences then show as marks on its tube.
  return everyAllele(g).every(a => a.status === 'ok' && !a.inverted && !a.family?.chain.some(it => it.kind === 'group'));
}

const foldCache = new WeakMap<Item[], Map<string, ChainItem[]>>();

/** Runs and small differences in a row become one marked run (a mark does not branch, so it does not end the run).
 * An expanded group is never folded (it is drawn as its own bubble, at true bp). */
export function foldMarks(items: Item[], small: number, expanded?: ReadonlySet<string>): ChainItem[] {
  if (!small || small <= 0) return items;
  let byT = foldCache.get(items);
  if (!byT) { byT = new Map(); foldCache.set(items, byT); }
  // Only this chain's own expanded groups are part of the key (so the cache stays bounded by the chain's groups).
  // Only expansions that change this chain's folding are part of the key: its own groups that would fold.
  const mine = expanded && expanded.size
    ? items.filter(it => it.kind === 'group' && expanded.has(it.id) && isSmallDifference(it, small)).map(it => it.id).sort() : [];
  const cacheKey = `${small}|${mine.join(',')}`;
  const hit = byT.get(cacheKey);
  if (hit) return hit;
  // Bounded per chain (the oldest entry goes first).
  if (byT.size >= 32) byT.delete(byT.keys().next().value as string);
  const out: ChainItem[] = [];
  let pending: (RunItem | GroupItem)[] = [];
  let marks = 0;
  const flush = () => {
    if (marks) {
      const spans = pending.map(p => p.target).filter((t): t is Span => t != null);
      out.push({
        kind: 'marked', id: `m${pending.find(p => p.kind === 'group')!.id}`, host: pending[0].host, parts: pending,
        bp: pending.reduce((t, p) => t + (p.kind === 'run' ? p.bp : p.base.bp), 0),
        target: spans.length ? { start: Math.min(...spans.map(x => x.start)), end: Math.max(...spans.map(x => x.end)) } : null,
      });
    } else out.push(...pending);
    pending = [];
    marks = 0;
  };
  for (const it of items) {
    if (it.kind === 'run') pending.push(it);
    else if (it.kind === 'group' && !expanded?.has(it.id) && isSmallDifference(it, small)) { pending.push(it); marks += 1; }
    else { flush(); out.push(it); }
  }
  flush();
  byT.set(cacheKey, out);
  return out;
}

function contentWidth(items: TopItem[], scale: number, c: Compression, k: Metrics = ROOMY): number {
  let w = 0;
  for (const it of items) w += itemWidth(it, scale, c, k);
  return w;
}

/** A nested chain's width: folded the same way placement folds it. */
function chainWidth(items: Item[], scale: number, c: Compression, k: Metrics = ROOMY): number {
  return contentWidth(foldMarks(items, k.small ?? 0, k.expanded), scale, c, k);
}

function alleleWidth(a: AltAllele, scale: number, c: Compression, k: Metrics = ROOMY): number {
  if (a.family) return chainWidth(a.family.chain, scale, c, k);
  const w = budget(a.bp, c) * scale;
  // An inversion's tube fills its (minimum) slot, so its chevrons and strand-flip connectors read.
  return a.inverted && a.bp > 0 ? Math.max(w, k.min * INVERSION_SLOTS) : w;
}

/** An inverted allele's slot is at least this many minimum slots wide (room for its chevrons and crossing). */
const INVERSION_SLOTS = 2.5;

/** A group's compression: true bp when it is expanded. */
const groupCompression = (g: GroupItem, c: Compression, k: Metrics): Compression => (k.expanded?.has(g.id) ? 'linear' : c);

function groupContent(g: GroupItem, scale: number, c0: Compression, k: Metrics = ROOMY): number {
  const c = groupCompression(g, c0, k);
  let w = chainWidth(g.base.chain, scale, c, k);
  for (const a of g.alts) w = Math.max(w, alleleWidth(a, scale, c, k));
  const min = g.alts.some(a => a.inverted && a.bp > 0) ? k.min * INVERSION_SLOTS : k.min;
  return Math.max(min, w);
}

function junctionContent(j: JunctionItem, scale: number, c: Compression, k: Metrics = ROOMY): number {
  // Each gap its own width (at least the minimum slot): the same widths placement draws and maps.
  let w = j.gaps.reduce((t, g) => t + Math.max(k.min, budget(g.span.end - g.span.start, c) * scale), 0);
  for (const a of j.alts) w = Math.max(w, budget(a.bp, c) * scale);
  return Math.max(j.gaps.length || j.alts.some(a => a.bp > 0) ? k.min : (k.empty ?? 4), w);
}

/** An item's width at a scale (tests: budgets and child-once accounting). */
export function layoutWidth(it: TopItem, scale: number, c: Compression, k: Metrics = ROOMY): number {
  return itemWidth(it, scale, c, k);
}

/** A marked run made only of insertions (no host sequence) still takes a few pixels. */
const MARK_ONLY_PX = 3;

function itemWidth(it: TopItem, scale: number, c: Compression, k: Metrics = ROOMY): number {
  switch (it.kind) {
    case 'run': return budget(it.bp, c) * scale;
    case 'marked': return it.bp > 0 ? budget(it.bp, c) * scale : MARK_ONLY_PX;
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
function clusterChain(chain: ChainItem[], distance: number, anySize = false, expanded?: ReadonlySet<string>): TopItem[] {
  const out: TopItem[] = [];
  let pending: ChainItem[] = [];
  // An expanded group is never clustered away.
  const small = (it: ChainItem) => it.kind === 'group' && !expanded?.has(it.id) && (anySize || (it.type === 'bubble' && maxAlleleBp(it) < MAJOR_BP));
  const runLike = (it: ChainItem) => it.kind === 'run' || it.kind === 'marked';
  const flush = () => {
    // Trailing runs are not part of a cluster.
    const tail: ChainItem[] = [];
    while (pending.length && runLike(pending[pending.length - 1])) tail.unshift(pending.pop()!);
    // A marked run's small differences are members too.
    const groups = pending.flatMap((it): GroupItem[] => (it.kind === 'group' ? [it]
      : it.kind === 'marked' ? it.parts.filter((p): p is GroupItem => p.kind === 'group') : []));
    if (pending.some(it => it.kind === 'group') && groups.length >= 2) {
      const spans = pending.map(it => (it.kind === 'run' || it.kind === 'group' || it.kind === 'marked' ? it.target : null)).filter((s): s is Span => s != null);
      const target = { start: Math.min(...spans.map(s => s.start)), end: Math.max(...spans.map(s => s.end)) };
      // Every variant inside, nested children and family sub-bubbles included: nothing is hidden by a cluster.
      const perPath: Record<string, number> = {};
      const members: ClusterItem['members'] = [];
      let major = 0;
      const visit = (g: GroupItem, at: number) => {
        const here = g.target?.start ?? at;
        for (const a of g.alts) {
          const carriers = a.carriers;
          members.push({ at: here, carriers, bp: Math.max(a.bp, g.base.bp) });
          if (Math.max(a.bp, g.base.bp) >= MAJOR_BP) major += 1;
          for (const c of carriers) perPath[c] = (perPath[c] ?? 0) + 1;
          for (const m of a.family?.members ?? []) {
            members.push({ at: here, carriers: m.carriers, bp: Math.max(m.bp, g.base.bp) });
            if (Math.max(m.bp, g.base.bp) >= MAJOR_BP) major += 1;
            for (const c of m.carriers) perPath[c] = (perPath[c] ?? 0) + 1;
          }
          for (const it of a.family?.chain ?? []) if (it.kind === 'group') visit(it, here);
        }
        for (const it of g.base.chain) if (it.kind === 'group') visit(it, here);
      };
      for (const g of groups) visit(g, g.target?.start ?? target.start);
      out.push({ kind: 'cluster', id: `c${groups[0].id}~${groups[groups.length - 1].id}`, items: pending, target,
        bp: target.end - target.start, variants: members.length, major, perPath, members });
    } else out.push(...pending);
    out.push(...tail);
    pending = [];
  };
  for (const it of chain) {
    if (small(it)) { pending.push(it); continue; }
    if (runLike(it) && pending.length && (it as RunItem | MarkedItem).bp < distance) { pending.push(it); continue; }
    flush();
    out.push(it);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------------- placement

/** A lane with nothing of its own drawn in it (every difference of that path is a mark on the shared tube). */
export const COMPACT_LANE_PX = 14;

/**
 * What a scene will hold before any geometry: small differences folded into marks, clusters when crowded, the
 * scale, and the lanes that draw something of their own (the others are compact label rows). The panel plans first
 * to size its lanes and its natural height; buildScene places the plan.
 */
export interface ScenePlan { top: TopItem[]; k: Metrics; scale: number; clusters: number; drawnLanes: Set<string>; dataWidth: number }

export function planScene(model: LayoutModel, opts: Pick<SceneOptions, 'width' | 'gutter' | 'rightPad' | 'compression' | 'smallBp' | 'expanded'>): ScenePlan {
  const dataWidth = Math.max(40, opts.width - opts.gutter - opts.rightPad);
  const c = opts.compression;
  // Crowded: compact curve zones first; cluster only when the bubbles' fixed pixels would still crowd out the
  // sequence. Small differences first become marks on the shared tube (no fixed pixels of their own).
  const small = Math.max(0, opts.smallBp ?? 0);
  const folded = foldMarks(model.chain, small, opts.expanded);
  let top: TopItem[] = folded;
  const expanded = opts.expanded && opts.expanded.size ? opts.expanded : undefined;
  const withSmall = (m: Metrics): Metrics => ({ ...m, ...(small > 0 ? { small } : {}), ...(expanded ? { expanded } : {}) });
  let k: Metrics = withSmall(contentWidth(top, 0, c, withSmall(ROOMY)) > dataWidth * 0.6 ? COMPACT : ROOMY);
  const span = model.interval.end - model.interval.start;
  for (let distance = 32; contentWidth(top, 0, c, k) > dataWidth * 0.6 && distance <= 2 * span; distance *= 2) {
    top = clusterChain(folded, distance, false, opts.expanded);
  }
  // Still overflowing (many large bubbles): cluster bubbles of any size rather than ever zeroing sequence widths;
  // every cluster lists its members.
  for (let distance = 32; contentWidth(top, 0, c, k) > dataWidth * 0.9 && distance <= 2 * span; distance *= 2) {
    top = clusterChain(folded, distance, true, opts.expanded);
  }
  // Last resort (e.g. many fragment junctions): shrink every fixed pixel in proportion, so sequence always keeps
  // some width and nothing runs past the data area.
  const fixed = contentWidth(top, 0, c, k);
  if (fixed > dataWidth * 0.7) {
    const f = (dataWidth * 0.7) / fixed;
    k = withSmall({ min: k.min * f, curve: k.curve * f, empty: (k.empty ?? 4) * f });
  }
  // Lanes drawing something of their own: an allele's lead lane (bubbles, bypasses, complex members), a junction
  // allele, a cluster's ticks, a lane note.
  const drawnLanes = new Set<string>([model.target, ...Object.keys(model.laneNotes)]);
  const walk = (items: TopItem[]) => {
    for (const it of items) {
      if (it.kind === 'group') {
        for (const a of it.alts) {
          drawnLanes.add(a.carriers[0]);
          if (a.family) walk(foldMarks(a.family.chain, small, opts.expanded));
        }
        walk(foldMarks(it.base.chain, small, opts.expanded));
      } else if (it.kind === 'junction') {
        for (const a of it.alts) if (a.bp > 0) drawnLanes.add(a.carriers[0]);
      } else if (it.kind === 'cluster') {
        for (const key of Object.keys(it.perPath)) drawnLanes.add(key);
      }
    }
  };
  walk(top);
  return { top, k, scale: solveScale(top, dataWidth, c, k), clusters: top.filter(t => t.kind === 'cluster').length, drawnLanes, dataWidth };
}

export function buildScene(model: LayoutModel, opts: SceneOptions & { plan?: ScenePlan }): Scene {
  const lanes = model.rows.map(r => r.key);
  const dataLeft = opts.gutter;
  let c = opts.compression;   // an expanded group draws at true bp (placeGroup)
  const plan = opts.plan ?? planScene(model, opts);
  const { top, k, scale, clusters, drawnLanes, dataWidth } = plan;
  const small = k.small ?? 0;
  // Rows: lanes with something of their own drawn full height, the others compact label rows.
  let rowTop = opts.rulerHeight + opts.laneGap;
  const rows: SceneRow[] = model.rows.map(r => {
    const height = drawnLanes.has(r.key) ? opts.laneHeight : Math.min(opts.laneHeight, COMPACT_LANE_PX);
    const row = { ...r, color: opts.colors[r.key] ?? '#475569', top: rowTop, center: rowTop + height / 2, height, bandTop: 0, bandHeight: 0 };
    rowTop += height + opts.laneGap;
    return row;
  });
  // Read bands under the lanes, one per path in lane order (so no bubble's branch crosses molecules).
  let bandTop = rowTop + (opts.bands && Object.values(opts.bands).some(Boolean) ? 2 : 0);
  for (const row of rows) {
    const band = Math.max(0, Math.round(opts.bands?.[row.key] ?? 0));
    if (!band) continue;
    row.bandTop = bandTop;
    row.bandHeight = band;
    bandTop += band + opts.laneGap;
  }
  const contentBottom = bandTop;
  const rowOf = new Map(rows.map(r => [r.key, r]));
  const stripe = Math.max(2, Math.min(6, Math.floor((opts.laneHeight - 12) / Math.max(1, lanes.length))));
  const colorOf = (k: string) => opts.colors[k] ?? '#475569';
  const CURVE = k.curve;

  const prims: Prim[] = [];
  const overlay: Prim[] = [];
  const hitList: SceneHit[] = [];
  let within: SceneHit['within'];
  // Hits are pushed outermost first: a later (inner, narrower) hit wins at a point.
  const hits = { push: (h: SceneHit) => { hitList.push(within ? { ...h, within } : h); } };
  const targetMap: TargetMapEntry[] = [];
  const occurrences: OccurrencePlacement[] = [];
  /** Repeat visits drawn in an allele, resolved to return arcs once every host occurrence is placed. */
  const pendingArcs: { x: number; y: number; of: string; lane: string; color: string; tier: number }[] = [];
  const blocks: Scene['blocks'] = [];

  /**
   * Record where visits are drawn over [x0, x0 + w] (in order; `flip`: right to left): the host's (`lane`'s path)
   * and, on their stripes of the same tube, every other carrier's own occurrence of the same node at the same x
   * (its offsets run with the host's when it walks the node the same way, against them when not).
   */
  const placeVisits = (visits: Visit[], x0: number, w: number, bp: number, lane: string, owner: string, flip = false,
    byCarrier?: Record<string, (Visit | null | undefined)[]>, hostPath = lane) => {
    if (bp <= 0 || w <= 0) return;
    let acc = 0;
    visits.forEach((v, t) => {
      if (v.bp <= 0) return;
      const a = x0 + (acc / bp) * w, b = x0 + ((acc + v.bp) / bp) * w;
      const [px0, px1] = flip ? [x0 + x0 + w - b, x0 + x0 + w - a] : [a, b];
      const start = v.target ? v.target.start - v.occ.path_span.start : v.occ.clip.start;
      const dir: 1 | -1 = (Boolean(v.backward) !== flip) ? -1 : 1;
      occurrences.push({ occ: v.occ.id, node: v.occ.node, lane, owner, x0: px0, x1: px1, start, end: start + v.bp, dir, path: hostPath });
      for (const [path, list] of Object.entries(byCarrier ?? {})) {
        const mv = list[t];
        if (!mv || path === hostPath || mv.occ.node !== v.occ.node) continue;
        const len = mv.occ.path_span.end - mv.occ.path_span.start;
        const same = mv.occ.reverse === v.occ.reverse;
        const [ms, me] = same ? [start, start + v.bp] : [len - (start + v.bp), len - start];
        if (ms < 0 || me > len) continue;
        occurrences.push({ occ: mv.occ.id, node: mv.occ.node, lane, owner, x0: px0, x1: px1, start: ms, end: me, dir: (same ? dir : -dir) as 1 | -1, path });
      }
      acc += v.bp;
    });
  };
  /** The y ranges of these carriers' stripes. */
  const stripesOf = (slots: Map<string, Slot>, keys: string[]): Stripe[] =>
    keys.flatMap(k => { const sl = slots.get(k); return sl ? [{ key: k, y0: sl.y, y1: sl.y + sl.h }] : []; });

  /** Slot y positions of a tube in a lane, for these carriers (lane order). */
  const slotsIn = (lane: string, carriers: string[]): Map<string, Slot> => {
    const row = rowOf.get(lane)!;
    const h = carriers.length * stripe;
    const out = new Map<string, Slot>();
    carriers.forEach((k, i) => out.set(k, { key: k, y: row.center - h / 2 + i * stripe, h: stripe, color: colorOf(k) }));
    return out;
  };
  const backboneSlots = slotsIn(model.target, lanes);

  /** Node boundaries inside a run, at least 16 px apart (5 px from its ends): legible cuts, not a barcode. */
  const nodeEdges = (visits: Visit[], x0: number, w: number, bp: number) => {
    const out: number[] = [];
    if (bp <= 0) return out;
    let acc = 0, last = x0;
    for (let i = 0; i < visits.length - 1; i++) {
      acc += visits[i].bp;
      const x = x0 + (acc / bp) * w;
      if (x - last >= (out.length ? 16 : 5) && x0 + w - x >= 5) { out.push(x); last = x; }
    }
    return out;
  };

  const tube = (x0: number, w: number, slots: Map<string, Slot>, present: string[], visits: Visit[], bp: number, style: 'seq' | 'unresolved', arrows?: -1, label = true) => {
    if (w <= 0.01) return;
    const all = [...slots.values()];
    const y = Math.min(...all.map(s => s.y)), h = all.reduce((t, s) => t + s.h, 0);
    const breaks = c === 'log' && bp > 200 && w > 26 && !arrows ? [x0 + w / 2] : [];
    prims.push({ t: 'tube', x0, x1: x0 + w, y, h, slots: all, present, nodes: w > 4 ? nodeEdges(visits, x0, w, bp) : [], style, breaks, outline: '#cbd5e1', ...(arrows ? { arrows } : {}) });
    if (label && c === 'log' && bp > 200 && w > 54) {
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
    // Nested chains (a base allele's, a family's) fold their small differences the way their widths did.
    const list: TopItem[] = depth === 0 ? items : foldMarks(items as Item[], small, k.expanded);
    for (const it of list) {
      const w = itemWidth(it, scale, c, k);
      if (depth === 0) blocks.push({ id: it.id, kind: it.kind === 'group' ? `${it.kind}:${it.type}` : it.kind, x0: x, x1: x + w });
      if (it.kind === 'run') placeRun(it, x, w, host, slots, onTarget);
      else if (it.kind === 'marked') placeMarked(it, x, w, host, slots, onTarget);
      else if (it.kind === 'group') placeGroup(it, x, w, host, slots, onTarget, depth);
      else if (it.kind === 'junction') placeJunction(it, x, w, slots);
      else placeCluster(it, x, w, slots);
      x += w;
    }
    return x - start;
  };

  function placeRun(run: RunItem, x: number, w: number, host: string, slots: Map<string, Slot>, onTarget: boolean) {
    if (w <= 0.01) return;
    // Length labels on the target backbone only: inside an allele its own label gives the length.
    tube(x, w, slots, run.carriers, run.visits, run.bp, 'seq', undefined, onTarget);
    placeVisits(run.visits, x, w, run.bp, host, run.id, false, run.byCarrier);
    const row = rowOf.get(host)!;
    hits.push({ x0: x, x1: x + w, y0: row.top, y1: row.top + row.height, cursor: onTarget,
      payload: { kind: 'run', run, host, visit: run.visits[0], offset: 0, stripes: stripesOf(slots, run.carriers) } });
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

  /** The host's sequence (target visits, at the top level) of a small group's base allele, nested children too. */
  const baseVisits = (g: GroupItem, out: Visit[] = [], carriers: Record<string, (Visit | null)[]> = {}): { visits: Visit[]; byCarrier: Record<string, (Visit | null)[]> } => {
    for (const it of g.base.chain) {
      if (it.kind === 'run') {
        const at = out.length;
        out.push(...it.visits);
        for (const [c, list] of Object.entries(it.byCarrier ?? {})) {
          const l = carriers[c] ?? (carriers[c] = []);
          while (l.length < at) l.push(null);
          l.push(...list);
        }
      } else if (it.kind === 'group') baseVisits(it, out, carriers);
    }
    return { visits: out, byCarrier: carriers };
  };

  /**
   * A marked run: one tube through runs and small differences, each part in proportion to its host bp. A small
   * difference is a mark on each carrier's stripe — a tick (substitution), a notch (deletion) or a caret
   * (insertion) — with a pin outside the tube on the stripe's nearer side; its hit (at least 8 px) wins over the run.
   */
  function placeMarked(m: MarkedItem, x: number, w: number, host: string, slots: Map<string, Slot>, onTarget: boolean) {
    const row = rowOf.get(host)!;
    const all = [...slots.values()];
    const ty0 = Math.min(...all.map(s => s.y)) - 1.5, ty1 = Math.max(...all.map(s => s.y + s.h)) + 1.5;
    const index = new Map(all.map((s, i) => [s.key, i]));
    const sideOf = (key: string): 'up' | 'down' => ((index.get(key) ?? 0) * 2 <= all.length - 1 ? 'up' : 'down');
    const segments: { x0: number; x1: number; present: string[] }[] = [];
    const visits: Visit[] = [];
    const markHits: SceneHit[] = [];
    const marks: Prim[] = [];
    let acc = 0;
    // Host sequence in proportion; a run of insertion marks only (no host bp) gives each slot an equal share.
    const zeroParts = Math.max(1, m.parts.length);
    let zeroAt = 0;
    const xAt = (bp: number) => (m.bp > 0 ? x + (bp / m.bp) * w : x + (zeroAt / zeroParts) * w);
    for (const part of m.parts) {
      const bp = part.kind === 'run' ? part.bp : part.base.bp;
      const x0 = xAt(acc);
      if (m.bp <= 0) zeroAt += 1;
      const x1 = xAt(acc + bp);
      if (part.kind === 'run') {
        segments.push({ x0, x1, present: part.carriers });
        visits.push(...part.visits);
        placeVisits(part.visits, x0, x1 - x0, bp, host, part.id, false, part.byCarrier);
        hits.push({ x0, x1, y0: row.top, y1: row.top + row.height, cursor: onTarget, payload: { kind: 'run', run: part, host, visit: part.visits[0], offset: 0, stripes: stripesOf(slots, part.carriers) } });
        if (onTarget) {
          let a = 0;
          for (const v of part.visits) {
            if (v.target && v.bp > 0) targetMap.push({ x0: x0 + (a / bp) * (x1 - x0), x1: x0 + ((a + v.bp) / bp) * (x1 - x0), t0: v.target.start, t1: v.target.end, kind: 'seq' });
            a += v.bp;
          }
        }
      } else {
        const g = part;
        const alleles = g.alts.flatMap(a => [a, ...(a.family?.members ?? [])]);
        const present = lanes.filter(key => g.base.carriers.includes(key) || alleles.some(a => a.carriers.includes(key)));
        const { visits: bvs, byCarrier: bmap } = baseVisits(g);
        if (x1 > x0) segments.push({ x0, x1, present });
        visits.push(...bvs);
        placeVisits(bvs, x0, x1 - x0, bp, host, g.id, false, bmap);
        if (g.base.bp > 0) {
          hits.push({ x0, x1, y0: row.top, y1: row.top + row.height, cursor: false, payload: { kind: 'base', group: g, lane: host, stripes: stripesOf(slots, g.base.carriers) } });
          if (onTarget) {
            let a = 0;
            for (const v of bvs) {
              if (v.target && v.bp > 0) targetMap.push({ x0: x0 + (a / bp) * (x1 - x0), x1: x0 + ((a + v.bp) / bp) * (x1 - x0), t0: v.target.start, t1: v.target.end, kind: 'seq' });
              a += v.bp;
            }
          }
        } else {
          hits.push({ x0: x0 - 2, x1: x1 + 2, y0: row.top, y1: row.top + row.height, cursor: false, payload: { kind: 'slot', group: g, boundary: g.target ? g.target.start : null } });
          if (onTarget && g.target) targetMap.push({ x0, x1, t0: g.target.start, t1: g.target.start, kind: 'slot' });
        }
        // This group's marks, then those of every difference nested in its base allele, each at its own place.
        const markGroup = (gg: GroupItem, gx0: number, gx1: number) => {
          const cx = (gx0 + gx1) / 2;
          const half = Math.max(1, (gx1 - gx0) / 2);
          for (const a of gg.alts.flatMap(al => [al, ...(al.family?.members ?? [])])) {
            const kind: 'sub' | 'del' | 'ins' = gg.base.bp === 0 ? 'ins' : a.bp === 0 ? 'del' : 'sub';
            for (const key of a.carriers) {
              const sl = slots.get(key);
              if (!sl) continue;
              // The carrier's own walk of this allele, over the mark (its forward transform).
              const own = key === a.carriers[0] ? a.visits : a.byCarrier?.[key];
              if (own && a.bp > 0) placeVisits(own, cx - half, 2 * half, a.bp, host, a.id, false, undefined, key);
              const side = sideOf(key);
              marks.push({ t: 'vmark', x0: cx - half, x1: cx + half, y: sl.y, h: sl.h, ty0, ty1, side, color: sl.color, kind });
              const hx = Math.max(4, half);
              // Two regions, never over another carrier's stripe: the mark on its own stripe, and its pin outside.
              const payload = { kind: 'allele' as const, group: gg, allele: a, lane: key, visit: null, offset: 0 };
              markHits.push({ x0: cx - hx, x1: cx + hx, y0: sl.y, y1: sl.y + sl.h, cursor: false, payload });
              markHits.push({ x0: cx - hx, x1: cx + hx, y0: side === 'up' ? ty0 - 8 : ty1, y1: side === 'up' ? ty0 : ty1 + 8, cursor: false, payload });
            }
          }
          if (gg.base.bp <= 0) return;
          let a = 0;
          for (const it of gg.base.chain) {
            if (it.kind === 'run') { a += it.bp; continue; }
            if (it.kind !== 'group') continue;
            const c0 = gx0 + (a / gg.base.bp) * (gx1 - gx0), c1 = gx0 + ((a + it.base.bp) / gg.base.bp) * (gx1 - gx0);
            markGroup(it, c0, c1);
            a += it.base.bp;
          }
        };
        markGroup(g, x0, x1);
      }
      acc += bp;
    }
    if (w > 0.01) {
      const breaks = c === 'log' && m.bp > 200 && w > 26 ? [x + w / 2] : [];
      prims.push({ t: 'tube', x0: x, x1: x + w, y: ty0 + 1.5, h: ty1 - ty0 - 3, slots: all, present: lanes.filter(key => segments.some(sg => sg.present.includes(key))),
        nodes: w > 4 ? nodeEdges(visits, x, w, m.bp) : [], style: 'seq', breaks, outline: '#cbd5e1', segments });
      // Its length label only where no mark pin sits under it.
      const lx = x + w / 2;
      if (onTarget && c === 'log' && m.bp > 200 && w > 54 && !marks.some(p => p.t === 'vmark' && p.side === 'up' && Math.abs((p.x0 + p.x1) / 2 - lx) < 26)) {
        overlay.push({ t: 'text', x: lx, y: ty0 - 2, text: formatBpShort(m.bp), color: '#94a3b8', align: 'center', size: 9, bold: false });
      }
    }
    prims.push(...marks);
    for (const h of markHits) hits.push(h);
  }

  function placeGroup(g: GroupItem, x: number, w: number, host: string, slots: Map<string, Slot>, onTarget: boolean, depth: number) {
    // An expanded group (and everything inside it) is laid out at true bp, as its width was computed.
    const outer = c;
    c = groupCompression(g, c, k);
    try { placeGroupBody(g, x, w, host, slots, onTarget, depth); } finally { c = outer; }
  }

  function placeGroupBody(g: GroupItem, x: number, w: number, host: string, slots: Map<string, Slot>, onTarget: boolean, depth: number) {
    const gx0 = x, gx1 = x + w, cx0 = gx0 + CURVE, cx1 = gx1 - CURVE;
    const hostRow = rowOf.get(host)!;
    const baseW = chainWidth(g.base.chain, scale, c, k);
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
      const inverted = Boolean(a.inverted) && !a.family && a.bp > 0;
      for (const k of carriers) {
        const hs = slots.get(k), as = own.get(k)!;
        if (!hs) continue;
        if (inverted) {
          // Strand-flip connectors: in to the allele's far end, walked right to left, out from its near end.
          prims.push({ t: 'curve', x0: gx0, y0: hs.y + hs.h / 2, x1: cx0 + aw, y1: as.y + as.h / 2, color: as.color, w: as.h, dashed });
          prims.push({ t: 'curve', x0: cx0, y0: as.y + as.h / 2, x1: gx1, y1: hs.y + hs.h / 2, color: as.color, w: as.h, dashed });
          continue;
        }
        prims.push({ t: 'curve', x0: gx0, y0: hs.y + hs.h / 2, x1: cx0, y1: as.y + as.h / 2, color: as.color, w: as.h, dashed });
        prims.push({ t: 'curve', x0: cx1, y0: as.y + as.h / 2, x1: gx1, y1: hs.y + hs.h / 2, color: as.color, w: as.h, dashed });
      }
      // Lane hits first (sequence, then filler as connector); a family's own runs and sub-bubbles win inside.
      const seqEnd = a.bp > 0 ? cx0 + Math.max(1, aw) : cx0;
      if (a.bp > 0) hits.push({ x0: cx0, x1: seqEnd, y0: row.top, y1: row.top + row.height, cursor: false,
        payload: { kind: 'allele', group: g, allele: a, lane, visit: null, offset: 0, stripes: a.family ? undefined : stripesOf(own, a.carriers) } });
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
        tube(cx0, aw, own, carriers, a.visits, a.bp, dashed ? 'unresolved' : 'seq', inverted ? -1 : undefined, !inverted);
        placeVisits(a.visits, cx0, aw, a.bp, lane, a.id, inverted, a.byCarrier);
        // Repeat visits: a return arc each (at most four tiers) back to the host occurrence they repeat.
        const tubeY = Math.min(...[...own.values()].map(sl => sl.y));
        let acc = 0;
        for (const v of a.visits) {
          if (v.repeat && v.repeat.n <= MAX_REPEAT_VISITS && v.bp > 0) {
            const mid = (acc + v.bp / 2) / a.bp;
            const x = inverted ? cx0 + aw - mid * aw : cx0 + mid * aw;
            pendingArcs.push({ x, y: tubeY - 1, of: v.repeat.of, lane: host, color: colorOf(lane), tier: Math.min(3, Math.max(0, v.repeat.n - 2)) });
          }
          acc += v.bp;
        }
      }
      if (!inverted) straight(cx0 + aw, cx1, own, carriers, a.bp > 0 ? 'connector' : (dashed ? 'dashed' : 'connector'));
      const label = alleleLabel(g, a);
      const tubeTop = Math.min(...[...own.values()].map(s => s.y));
      // The lead's label, then each family member's in its own colour (their shared stretches run in this tube).
      const texts = [label ? { text: label, color: colorOf(lane), bold: g.base.bp === 0 && a.bp > 0 } : null,
        ...(a.family?.members ?? []).map(m => { const t = alleleLabel(g, m); return t ? { text: t, color: colorOf(m.carriers[0]), bold: g.base.bp === 0 && m.bp > 0 } : null; })]
        .filter((t): t is { text: string; color: string; bold: boolean } => t != null);
      const widths = texts.map(t => t.text.length * 5.2);
      const total = widths.reduce((t, w) => t + w, 0) + 10 * Math.max(0, texts.length - 1);
      if (texts.length && (cx1 - cx0) >= total) {
        const center = (cx0 + Math.max(cx0 + aw, Math.min(cx1, cx0 + 60 * texts.length))) / 2;
        let tx = center - total / 2;
        texts.forEach((t, n) => {
          overlay.push({ t: 'text', x: tx + widths[n] / 2, y: tubeTop - 3, text: t.text, color: t.color, align: 'center', size: 9, bold: t.bold });
          tx += widths[n] + 10;
        });
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
        const gw = widths[n] * f;
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
        placeVisits(a.visits, cx0, aw, a.bp, lane, a.id, false, a.byCarrier);
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
    for (const it of cl.items) {
      if (it.kind === 'run') it.carriers.forEach(k => carriers.add(k));
      else if (it.kind === 'marked') for (const p of it.parts) if (p.kind === 'run') p.carriers.forEach(k => carriers.add(k));
    }
    const present = lanes.filter(k => carriers.has(k));
    const all = [...slots.values()];
    const y = Math.min(...all.map(s => s.y)), h = all.reduce((t, s) => t + s.h, 0);
    prims.push({ t: 'tube', x0: x, x1: x + w, y, h, slots: all, present, nodes: [], style: 'seq', breaks: [], outline: '#cbd5e1' });
    prims.push({ t: 'cluster', x0: x, x1: x + w, y: y - 2, h: h + 4 });
    // One dot per variant, in its carriers' lanes, at its relative target position.
    // One tick per member variant (nested ones too), in its carriers' lanes, at its relative target position; a
    // variant of 100 bp or more gets a taller tick.
    for (const mv of cl.members) {
      const f = cl.bp > 0 ? (mv.at - cl.target.start) / cl.bp : 0.5;
      const dx = x + 2 + Math.max(0, Math.min(1, f)) * Math.max(0, w - 4);
      for (const k of mv.carriers) {
        const row = rowOf.get(k);
        const tall = mv.bp >= MAJOR_BP;
        if (row && k !== model.target) overlay.push({ t: 'tick', x: dx, y: row.center - (tall ? 7 : 4), h: tall ? 14 : 8, color: colorOf(k) });
      }
    }
    if (w > 46) overlay.push({ t: 'text', x: x + w / 2, y: y - 3, text: `${cl.variants} variants`, color: cl.major ? '#b45309' : '#64748b', align: 'center', size: 9, bold: cl.major > 0 });
    targetMap.push({ x0: x, x1: x + w, t0: cl.target.start, t1: cl.target.end, kind: 'cluster' });
    const lastRow = rows[rows.length - 1];
    hits.push({ x0: x, x1: x + w, y0: rows[0].top, y1: lastRow.top + lastRow.height, cursor: true, payload: { kind: 'cluster', cluster: cl } });
  }

  placeChain(top, dataLeft, model.target, backboneSlots, true, 0);
  // Return arcs: from each drawn repeat visit back to the host occurrence it repeats (when that is drawn).
  for (const arc of pendingArcs) {
    const to = occurrences.find(o => o.occ === arc.of && o.lane === arc.lane);
    const hostSlots = arc.lane === model.target ? backboneSlots : null;
    if (!to || !hostSlots) continue;
    const bottom = Math.max(...[...hostSlots.values()].map(sl => sl.y + sl.h)) + 1.5;
    overlay.push({ t: 'arc', x0: arc.x, y0: arc.y, x1: (to.x0 + to.x1) / 2, y1: bottom, color: arc.color, tier: arc.tier });
  }

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
    width: opts.width, height: rows.some(r => r.bandHeight) ? contentBottom : (lastRow ? lastRow.top + lastRow.height : opts.rulerHeight) + opts.laneGap,
    dataLeft, dataWidth, scale, rows, prims: [...prims, ...overlay], hits: hitList, targetMap, occurrences, clusters, metrics: k, blocks, reversed: opts.reversed,
  };
  return opts.reversed ? mirror(scene) : scene;
}

/** "×3" when an allele repeats a node this path also walks on the host (its highest visit count). */
function repeatTag(a: AltAllele): string {
  const n = Math.max(0, ...a.visits.map(v => v.repeat?.count ?? 0));
  return n > 1 ? ` · repeat ×${n}` : '';
}

function alleleLabel(g: GroupItem, a: AltAllele): string | null {
  if (a.status === 'unresolved') return `${formatBpShort(a.bp)} ?`;
  if (a.inverted) return `inv ${formatBpShort(a.bp)}`;
  if (g.base.bp === 0 && a.visits.some(v => v.repeat)) return `+${formatBpShort(a.bp)}${repeatTag(a)}`;
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

/** Pixels per target base of the sequence drawn at `t` (null: `t` is not in drawn sequence). The layout is nonlinear:
 * an insertion drawn wide takes width that the average scale spreads over every target base, so a pan converted from
 * pixels with the average scale falls short wherever an insertion is in view. */
export function localBpScale(map: TargetMapEntry[], t: number): number | null {
  for (const m of map) if (m.kind === 'seq' && m.t1 > m.t0 && t >= m.t0 && t <= m.t1) return Math.abs(m.x1 - m.x0) / (m.t1 - m.t0);
  return null;
}

/** The target coordinate at x: a position in sequence, an insertion boundary (no interval), or null. */
export function targetAtX(map: TargetMapEntry[], x: number): { pos: number; boundary: boolean; kind: TargetMapEntry['kind'] } | null {
  for (const m of map) {
    const lo = Math.min(m.x0, m.x1), hi = Math.max(m.x0, m.x1);
    if (x < lo || x > hi) continue;
    if (m.kind === 'slot') return { pos: m.t0, boundary: true, kind: 'slot' };
    const f = hi > lo ? (x - m.x0) / (m.x1 - m.x0) : 0;
    return { pos: Math.min(m.t1 - 1, Math.max(m.t0, Math.floor(m.t0 + f * (m.t1 - m.t0) + 1e-6))), boundary: false, kind: m.kind };
  }
  return null;
}

/**
 * The discriminated inverse at a point: target sequence (occurrence and offset, true coordinate), a path's own
 * allele (occurrence and offset, plus its target boundary), connector space in an insertion slot (the boundary
 * only), a target gap, or a summary block. Never a made-up target base inside an insertion.
 */
export type SceneInverse =
  | { kind: 'target'; occurrence: string; offset: number; pos: number;
      /** On another carrier's stripe of the shared tube: that path's own occurrence and offset there. */
      carrier?: { path: string; occurrence: string; offset: number } }
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
  // Inside a family the inner groups have no target span: the enclosing group's boundary is the target position.
  const boundaryOf = (g: GroupItem | JunctionItem) => (g.kind === 'group'
    ? (g.target ? g.target.start : (top.within?.group.target?.start ?? null)) : g.target.start);
  const p = top.payload;
  switch (p.kind) {
    case 'run': {
      const at = placementAt(scene, x, p.run.id, p.host, p.host);
      const visit = at ? p.run.visits.find(v => v.occ.id === at.place.occ) : undefined;
      if (!at || !visit) return null;
      // The stripe under the pointer: that carrier's own occurrence of the node.
      const path = p.stripes?.find(st => y >= st.y0 && y <= st.y1)?.key ?? p.host;
      const mine = path !== p.host ? placementAt(scene, x, p.run.id, p.host, path) : null;
      if (visit.target) {
        return { kind: 'target', occurrence: visit.occ.id, offset: at.offset, pos: visit.occ.path_span.start + at.offset,
          ...(mine ? { carrier: { path, occurrence: mine.place.occ, offset: mine.offset } } : {}) };
      }
      const use = mine ?? at;
      return { kind: 'allele', path: mine ? path : p.host, occurrence: use.place.occ, offset: use.offset, boundary: top.within ? boundaryOf(top.within.group) : null,
        group: top.within?.group.id ?? p.run.id };
    }
    case 'allele': {
      const boundary = boundaryOf(p.group);
      if (p.allele.bp === 0) return { kind: 'connector', group: p.group.id, boundary };
      if (!p.allele.family && !top.within && p.group.kind === 'group' && p.group.alts.every(a => a !== p.allele)) {
        // A family member: its shared stretches are the lead's runs in the lead's lane at this x; the member's own
        // occurrence of that node, at the same drawn position.
        const lead = p.group.alts.find(a => a.family?.members.includes(p.allele));
        // Over a folded difference in the lead's tube: that difference's base placements.
        const base = lead && scene.hits.find(h => h.payload.kind === 'base' && h.payload.lane === lead.carriers[0] && x >= h.x0 && x <= h.x1);
        if (base && base.payload.kind === 'base') {
          const own = placementAt(scene, x, base.payload.group.id, lead!.carriers[0], p.lane);
          if (own) return { kind: 'allele', path: p.lane, occurrence: own.place.occ, offset: own.offset, boundary, group: p.group.id };
        }
        const run = lead && scene.hits.find(h => h.payload.kind === 'run' && h.payload.host === lead.carriers[0] && x >= h.x0 && x <= h.x1);
        if (run && run.payload.kind === 'run' && run.payload.run.carriers.includes(p.lane)) {
          // Its own occurrence on its stripe of the lead's tube (the run keeps every carrier's visits).
          const own = placementAt(scene, x, run.payload.run.id, lead!.carriers[0], p.lane);
          if (own) return { kind: 'allele', path: p.lane, occurrence: own.place.occ, offset: own.offset, boundary, group: p.group.id };
          const at = placementAt(scene, x, run.payload.run.id, lead!.carriers[0], lead!.carriers[0]);
          const leadVisit = at && run.payload.run.visits.find(v => v.occ.id === at.place.occ);
          const mine = leadVisit && p.allele.visits.find(v => v.occ.node === leadVisit.occ.node);
          if (at && leadVisit && mine && p.lane === p.allele.carriers[0]) {
            const u = at.place.dir === 1 ? at.offset - at.place.start : at.place.end - 1 - at.offset;
            const dir = Boolean(mine.backward) === Boolean(leadVisit.backward) ? at.place.dir : -at.place.dir;
            const len = mine.occ.clip.end - mine.occ.clip.start;
            const uu = Math.max(0, Math.min(len - 1, u));
            return { kind: 'allele', path: p.lane, occurrence: mine.occ.id, offset: dir === 1 ? mine.occ.clip.start + uu : mine.occ.clip.end - 1 - uu, boundary, group: p.group.id };
          }
        }
        return { kind: 'allele', path: p.lane, occurrence: null, offset: 0, boundary, group: p.group.id };
      }
      // The carrier: the stripe under the pointer in the allele's tube, else the lane (a mark is on its carrier's
      // stripe); each carrier's own occurrences.
      const path = p.stripes?.find(st => y >= st.y0 && y <= st.y1)?.key ?? p.lane;
      const at = placementAt(scene, x, p.allele.id, undefined, path);
      if (at) return { kind: 'allele', path, occurrence: at.place.occ, offset: at.offset, boundary, group: p.group.id };
      // A mark (no tube of its own): the carrier's first base of its allele.
      const own = path === p.allele.carriers[0] ? p.allele.visits : p.allele.byCarrier?.[path] ?? [];
      const first = own.find(v => v.bp > 0);
      return { kind: 'allele', path, occurrence: first?.occ.id ?? null, offset: first ? (first.backward ? first.occ.clip.end - 1 : first.occ.clip.start) : 0, boundary, group: p.group.id };
    }
    case 'filler': return { kind: 'connector', group: p.group.id, boundary: boundaryOf(p.group) };
    case 'slot': return { kind: 'connector', group: p.group.id, boundary: p.boundary ?? boundaryOf(p.group) };
    case 'base': {
      // A folded difference's base sequence: the stripe's own occurrence (the host's, or another carrier's).
      const host = placementAt(scene, x, p.group.id, p.lane, p.lane);
      const t = targetAtX(scene.targetMap, x);
      if (host) {
        const path = p.stripes?.find(st => y >= st.y0 && y <= st.y1)?.key ?? p.lane;
        const mine = path !== p.lane ? placementAt(scene, x, p.group.id, p.lane, path) : null;
        if (p.group.target && t && !t.boundary) {
          return { kind: 'target', occurrence: host.place.occ, offset: host.offset, pos: t.pos,
            ...(mine ? { carrier: { path, occurrence: mine.place.occ, offset: mine.offset } } : {}) };
        }
        const use = mine ?? host;
        return { kind: 'allele', path: mine ? path : p.lane, occurrence: use.place.occ, offset: use.offset, boundary: boundaryOf(p.group), group: top.within?.group.id ?? p.group.id };
      }
      return t && !t.boundary ? { kind: 'target', occurrence: '', offset: 0, pos: t.pos } : { kind: 'connector', group: p.group.id, boundary: boundaryOf(p.group) };
    }
    case 'gap': return { kind: 'gap', span: (p.gap ?? p.junction.gap)?.span ?? p.junction.target };
    case 'complex': return { kind: 'summary', id: p.group.id, span: p.group.target };
    case 'cluster': return { kind: 'summary', id: p.cluster.id, span: p.cluster.target };
    case 'end': return { kind: 'summary', id: `${p.end.path}:${p.end.side}`, span: null };
  }
  return null;
}

/** The drawn visit of `owner` (in `lane`) under x, and the path-forward offset in that occurrence. */
export function placementAt(scene: Scene, x: number, owner?: string, lane?: string, path?: string): { place: OccurrencePlacement; offset: number } | null {
  for (const o of scene.occurrences) {
    if ((owner && o.owner !== owner) || (lane && o.lane !== lane) || (path && o.path !== path)) continue;
    if (x < o.x0 || x > o.x1) continue;
    const span = o.end - o.start;
    const f = (x - o.x0) / Math.max(1e-9, o.x1 - o.x0);
    const u = Math.min(span - 1, Math.max(0, Math.floor(f * span + 1e-6)));
    return { place: o, offset: o.dir === 1 ? o.start + u : o.end - 1 - u };
  }
  return null;
}

/** The forward occurrence transform: x at the centre of an occurrence's base (path-forward `offset`), or null. */
export function xForOccurrence(scene: Scene, occ: string, offset: number, lane?: string, owner?: string): number | null {
  for (const o of scene.occurrences) {
    if (o.occ !== occ || (lane && o.lane !== lane) || (owner && o.owner !== owner)) continue;
    if (offset < o.start || offset >= o.end) continue;
    const u = o.dir === 1 ? offset - o.start : o.end - 1 - offset;
    return o.x0 + ((u + 0.5) / (o.end - o.start)) * (o.x1 - o.x0);
  }
  return null;
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
      case 'tube': return { ...flip(p), nodes: p.nodes.map(fx), breaks: p.breaks.map(fx), segments: p.segments?.map(sg => flip(sg)),
        ...(p.arrows ? { arrows: (p.arrows === -1 ? 1 : -1) as 1 | -1 } : {}) };
      case 'vmark': return flip(p);
      case 'stripe': case 'gap': case 'cluster': case 'frame': case 'dots': return flip(p);
      case 'curve': case 'arc': return { ...p, x0: fx(p.x0), x1: fx(p.x1) };
      case 'text': return { ...p, x: fx(p.x), align: p.align === 'left' ? 'right' : p.align === 'right' ? 'left' : 'center' };
      case 'mark': case 'cap': case 'tick': return { ...p, x: fx(p.x) };
    }
  });
  const hits = scene.hits.map(h => flip(h));
  const targetMap = scene.targetMap.map(m => ({ ...m, x0: fx(m.x0), x1: fx(m.x1) })).sort((a, b) => Math.min(a.x0, a.x1) - Math.min(b.x0, b.x1));
  const occurrences = scene.occurrences.map(o => ({ ...o, x0: fx(o.x1), x1: fx(o.x0), dir: (o.dir === 1 ? -1 : 1) as 1 | -1 }));
  return { ...scene, prims, hits, targetMap, occurrences, blocks: scene.blocks.map(b => flip(b)) };
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
      const reps = a.visits.filter(v => v.repeat);
      const repeat = reps.length
        ? ` · ${reps.length === 1 ? 'a repeat visit' : `${reps.length} repeat visits`} of node${new Set(reps.map(v => v.occ.node)).size > 1 ? 's' : ''} ${[...new Set(reps.map(v => v.occ.node))].slice(0, 3).join(', ')} (${reps.map(v => `visit ${v.repeat!.n} of ${v.repeat!.count}`).slice(0, 4).join(', ')}${reps.length > 4 ? ', …' : ''})`
        : '';
      if (a.inverted && span) return `${carriers} · inversion of ${formatBpShort(a.bp)}: walks target ${where(span.start)}-${where(span.end)} (${formatBpShort(g.base.bp)}) in reverse${lens} · source ${src}${status}`;
      if (a.inverted) return `${carriers} · inversion of ${formatBpShort(a.bp)} in place of ${formatBpShort(g.base.bp)} of ${label(g.host)} · source ${src}${status}`;
      if (g.base.bp === 0 && span) return `${label(a.carriers[0])} · insertion of ${formatBpShort(a.bp)} at target boundary ${where(span.start)}${lens}${repeat} · source ${src}${status}`;
      if (a.bp === 0 && span) return `${carriers} · deletion of ${formatBpShort(g.base.bp)} (target ${where(span.start)}-${where(span.end)})${status}`;
      if (span) return `${carriers} · ${formatBpShort(a.bp)} in place of target ${where(span.start)}-${where(span.end)} (${formatBpShort(g.base.bp)})${lens}${repeat} · source ${src}${status}`;
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
      const size = cl.major ? `variants (${cl.major} of 100 bp or more)` : 'small variants';
      return `${cl.variants} ${size} in target ${where(cl.target.start)}-${where(cl.target.end)} (${formatBpShort(cl.bp)}) · ${per} · zoom in to separate them`;
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
