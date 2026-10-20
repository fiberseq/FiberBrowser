/**
 * Navigation through a live-lift map on the client (DESIGN_LIVE_LIFT.md §5.1): the map summary (one row per chain),
 * coarse per-chromosome / per-source-contig outlines for synchronous approximate mapping with a known drift bound, and
 * exact 1 Mb delta-varint tiles (services/lift/navigation.py) loaded lazily into an LRU of 64.
 *
 * Mapping is synchronous: it reads whatever is loaded. What it lacked (an outline, a tile) is requested in the
 * background, and `onNavigationData` listeners hear when it arrives (the link then applies one exact correction).
 */

export type Strand = '+' | '-';
/** `[target, t_start, t_end, source, q_start, q_end, strand, hap, primary_span_bp, aligned_bp]`; index = chain. */
export type SummaryRow = [string, number, number, string, number, number, Strand, string, number, number];
export interface LiftSummary {
  key: string;
  chains: SummaryRow[];
  selected: boolean[];
  haplotypes: string[];
  labels: Record<string, string>;
  /** Source contig -> haplotype key (selected haplotypes only). */
  sources: Record<string, string>;
  targets: Record<string, number | null>;
  tile_bp: number;
  outline_max_drift: number;
}
/** `[t_start, t_end, q_start, q_end, strand, chain, max_drift, target?]` (forward source coordinates). */
export type OutlineRow = [number, number, number, number, Strand, number, number, string?];

export interface OutlineIndex { side: 0 | 1; rows: OutlineRow[]; starts: number[]; reach: number[] }
export interface DecodedTile { side: number; tile: number; start: number[]; end: number[]; other: number[]; chain: number[]; minus: boolean[]; reach: number[] }
export interface PointHit { chain: number; pos: number; drift: number }

// ── Pure decoding and lookup ────────────────────────────────────────────────

/** Rows indexed by one side's start (0: target, 1: source), with the running maximum end bounding lookups. */
export function indexOutline(rows: OutlineRow[], side: 0 | 1): OutlineIndex {
  const sorted = rows.slice().sort((a, b) => (side ? a[2] - b[2] : a[0] - b[0]) || a[5] - b[5]);
  const starts: number[] = [], reach: number[] = [];
  let top = 0;
  for (const r of sorted) {
    starts.push(side ? r[2] : r[0]);
    top = Math.max(top, side ? r[3] : r[1]);
    reach.push(top);
  }
  return { side, rows: sorted, starts, reach };
}

function lastAtOrBefore(starts: number[], x: number): number {
  let lo = 0, hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}

/** Approximate positions of `x` on the other side, off by at most each row's drift (as `Outline.lookup` in Python). */
export function outlineLookup(index: OutlineIndex, x: number): PointHit[] {
  const out: PointHit[] = [];
  for (let i = lastAtOrBefore(index.starts, x); i >= 0 && index.reach[i] > x; i--) {
    const [t0, t1, q0, q1, strand, chain, drift] = index.rows[i];
    if (index.side === 0) {
      if (x >= t1) continue;
      const d = x - t0;
      const q = strand === '+' ? q0 + d : q1 - 1 - d;
      out.push({ chain, pos: Math.min(Math.max(q, q0), q1 - 1), drift });
    } else {
      if (x >= q1) continue;
      const d = strand === '+' ? x - q0 : q1 - 1 - x;
      out.push({ chain, pos: Math.min(Math.max(t0 + d, t0), t1 - 1), drift });
    }
  }
  return out;
}

/** A navigation tile (format `GLT1`, services/lift/navigation.py); `tileBp`: the server's tile size. */
export function decodeTile(data: Uint8Array, tileBp = 1_000_000): DecodedTile {
  if (data.length < 5 || data[0] !== 0x47 || data[1] !== 0x4c || data[2] !== 0x54 || data[3] !== 0x31) {
    throw new Error('not a graphlift navigation tile');
  }
  let pos = 5;
  const uv = () => {
    let result = 0, mul = 1;
    for (;;) {
      const b = data[pos++];
      if (b === undefined) throw new Error('truncated navigation tile');
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
  };
  const unzz = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
  const side = data[4];
  const tile = uv();
  const n = uv();
  const out: DecodedTile = { side, tile, start: [], end: [], other: [], chain: [], minus: [], reach: [] };
  let prevEnd = tile * tileBp, prevOther = 0, top = 0;
  for (let i = 0; i < n; i++) {
    const s = prevEnd + unzz(uv());
    const e = s + uv();
    const o = prevOther + unzz(uv());
    const c = uv();
    out.start.push(s); out.end.push(e); out.other.push(o);
    out.chain.push(Math.floor(c / 2)); out.minus.push(c % 2 === 1);
    top = Math.max(top, e); out.reach.push(top);
    prevEnd = e; prevOther = o;
  }
  return out;
}

/** Every `(chain, position)` of `x` on the tile's side (several where pieces overlap). */
export function tileLookup(tile: DecodedTile, x: number): Array<{ chain: number; pos: number }> {
  const out: Array<{ chain: number; pos: number }> = [];
  for (let i = lastAtOrBefore(tile.start, x); i >= 0 && tile.reach[i] > x; i--) {
    if (x >= tile.end[i]) continue;
    const d = x - tile.start[i];
    const len = tile.end[i] - tile.start[i];
    out.push({ chain: tile.chain[i], pos: tile.other[i] + (tile.minus[i] ? len - 1 - d : d) });
  }
  return out;
}

// ── Per-dataset navigation state ────────────────────────────────────────────

const TILE_LRU = 64;
const MAX_EXACT_TILES = 4;

interface NavState {
  datasetId: string;
  key: string;
  summary: LiftSummary | null;
  summaryLoading: Promise<LiftSummary | null> | null;
  failed: boolean;
  targetOutlines: Map<string, OutlineIndex | 'loading' | 'failed'>;
  sourceOutlines: Map<string, OutlineIndex | 'loading' | 'failed'>;
  tiles: Map<string, DecodedTile | 'loading' | 'failed'>;
}

const states = new Map<string, NavState>();
const listeners = new Set<(datasetId: string) => void>();
let dataGeneration = 0;

/** Called (asynchronously) whenever summary, outline or tile data arrives. */
export function onNavigationData(listener: (datasetId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Bumped on every arrival: lets a consumer tell whether new data could change an answer. */
export function navigationDataGeneration(): number { return dataGeneration; }

function notify(datasetId: string) {
  dataGeneration++;
  for (const l of [...listeners]) l(datasetId);
}

type Fetcher = {
  json: (url: string) => Promise<unknown>;
  bytes: (url: string) => Promise<Uint8Array>;
};
const defaultFetcher: Fetcher = {
  json: async url => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  bytes: async url => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
};
let fetcher: Fetcher = defaultFetcher;
/** Tests replace the network. */
export function setNavigationFetcher(f: Fetcher | null): void { fetcher = f ?? defaultFetcher; }
export function resetNavigation(): void { states.clear(); }

function stateFor(datasetId: string, key: string): NavState {
  let s = states.get(datasetId);
  if (!s || s.key !== key) {
    s = { datasetId, key, summary: null, summaryLoading: null, failed: false,
      targetOutlines: new Map(), sourceOutlines: new Map(), tiles: new Map() };
    states.set(datasetId, s);
  }
  return s;
}

const q = (params: Record<string, string | number>) => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));

/** Load the summary (once per dataset and lift_key). */
export function ensureSummary(datasetId: string, key: string): Promise<LiftSummary | null> {
  const s = stateFor(datasetId, key);
  if (s.summary) return Promise.resolve(s.summary);
  if (s.summaryLoading) return s.summaryLoading;
  s.summaryLoading = (fetcher.json(`/api/lift/summary?${q({ dataset_id: datasetId, key })}`) as Promise<LiftSummary>)
    .then(summary => {
      if (states.get(datasetId) !== s) return null;
      s.summary = summary;
      notify(datasetId);
      return summary;
    })
    .catch(() => { s.failed = true; s.summaryLoading = null; return null; });
  return s.summaryLoading;
}

function requestOutline(s: NavState, side: 0 | 1, name: string): void {
  const map = side ? s.sourceOutlines : s.targetOutlines;
  if (map.has(name)) return;
  map.set(name, 'loading');
  const params: Record<string, string> = side ? { dataset_id: s.datasetId, source: name, key: s.key } : { dataset_id: s.datasetId, chrom: name, key: s.key };
  void (fetcher.json(`/api/lift/outline?${q(params)}`) as Promise<{ rows: OutlineRow[] }>)
    .then(r => { if (states.get(s.datasetId) === s) { map.set(name, indexOutline(r.rows, side)); notify(s.datasetId); } })
    // A failure is news too: waiters stop waiting, and a pending correction settles on what there is.
    .catch(() => { if (states.get(s.datasetId) === s) { map.set(name, 'failed'); notify(s.datasetId); } });
}

const tileKey = (side: 0 | 1, contig: string, tile: number) => `${side}|${contig}|${tile}`;

function requestTile(s: NavState, side: 0 | 1, contig: string, tile: number): void {
  const k = tileKey(side, contig, tile);
  if (s.tiles.has(k)) return;
  s.tiles.set(k, 'loading');
  void fetcher.bytes(`/api/lift/tiles?${q({ dataset_id: s.datasetId, side: side ? 'source' : 'target', contig, tile, key: s.key })}`)
    .then(bytes => {
      if (states.get(s.datasetId) !== s) return;
      s.tiles.set(k, decodeTile(bytes, s.summary?.tile_bp));
      while (s.tiles.size > TILE_LRU) s.tiles.delete(s.tiles.keys().next().value!);
      notify(s.datasetId);
    })
    .catch(() => { if (states.get(s.datasetId) === s) { s.tiles.set(k, 'failed'); notify(s.datasetId); } });
}

/** Load what a view needs ahead of time (the outline, and its tiles when the view is small enough to be exact). */
export async function prefetchView(datasetId: string, key: string, side: 0 | 1, contig: string, start: number, end: number): Promise<void> {
  const summary = await ensureSummary(datasetId, key);
  if (!summary) return;
  const s = stateFor(datasetId, key);
  requestOutline(s, side, contig);
  const first = Math.floor(start / summary.tile_bp), last = Math.floor(Math.max(start, end - 1) / summary.tile_bp);
  if (last - first < MAX_EXACT_TILES) for (let t = first; t <= last; t++) requestTile(s, side, contig, t);
  await waitFor(() => {
    const o = (side ? s.sourceOutlines : s.targetOutlines).get(contig);
    if (o === 'loading') return false;
    for (let t = first; t <= last && last - first < MAX_EXACT_TILES; t++) if (s.tiles.get(tileKey(side, contig, t)) === 'loading') return false;
    return true;
  }, datasetId);
}

function waitFor(done: () => boolean, datasetId: string, timeoutMs = 15_000): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { off(); resolve(); }, timeoutMs);
    const off = onNavigationData(id => { if (id === datasetId && done()) { clearTimeout(timer); off(); resolve(); } });
  });
}

/** The loaded summary of a lifted dataset, if any (synchronous). */
export function loadedSummary(datasetId: string, key: string): LiftSummary | null {
  const s = states.get(datasetId);
  return s && s.key === key ? s.summary : null;
}

// ── Span mapping ────────────────────────────────────────────────────────────

export interface Span { chrom: string; start: number; end: number }
export interface MapCandidate { chain: number; chrom: string; share: number; minus: boolean }
export interface SpanMapping extends Span {
  chain: number;
  minus: boolean;
  /** Every lookup used an exact tile. */
  exact: boolean;
  /** Other chains covering a sizeable part of the view (a disjoint or mixed-orientation correspondence). */
  candidates: MapCandidate[];
}
export type MapOutcome = { status: 'mapped'; mapping: SpanMapping } | { status: 'pending' } | { status: 'none' };

const SAMPLES = 33;
/** services/lift/navigation.py OUTLINE_GAP: rows merge across gaps up to this; a larger gap ends a row. */
const OUTLINE_GAP_BP = 2_000;
const CANDIDATE_SHARE = 0.2;

/**
 * Map a view through the lift map. `toSource`: a target view to a source contig of haplotype `hap` (or `contig`); else a
 * view on a source contig to its target. Endpoints come from the dominant chain (the one most of the view maps
 * through, or `preferChain` when it covers part of the view); an endpoint inside a gap extrapolates bp for bp from
 * that chain's nearest mapped sample, so a view inside an insertion maps to its boundary.
 */
export function mapSpan(datasetId: string, key: string, direction: 'toSource' | 'toTarget', span: Span,
  options: { contig?: string; hap?: string; preferChain?: number | null } = {}): MapOutcome {
  const s = stateFor(datasetId, key);
  const summary = s.summary;
  if (!summary) { void ensureSummary(datasetId, key); return { status: 'pending' }; }
  const side: 0 | 1 = direction === 'toSource' ? 0 : 1;
  const chains = summary.chains;
  const allowed = (c: number) => {
    const row = chains[c];
    if (!row || !summary.selected[c]) return false;
    if (direction === 'toTarget') return row[3] === span.chrom;
    return row[0] === span.chrom && (options.contig ? row[3] === options.contig : !options.hap || row[7] === options.hap);
  };
  if (direction === 'toSource' ? !(span.chrom in summary.targets) : !(span.chrom in summary.sources)) return { status: 'none' };
  const outlines = side ? s.sourceOutlines : s.targetOutlines;
  const outline = outlines.get(span.chrom);
  if (outline === undefined || outline === 'loading') { requestOutline(s, side, span.chrom); return { status: 'pending' }; }
  const width = Math.max(1, span.end - span.start);
  const firstTile = Math.floor(span.start / summary.tile_bp), lastTile = Math.floor((span.end - 1) / summary.tile_bp);
  const wantExact = lastTile - firstTile < MAX_EXACT_TILES;
  let exact = wantExact;
  const lookup = (x: number): PointHit[] => {
    const t = Math.floor(x / summary.tile_bp);
    const tile = wantExact ? s.tiles.get(tileKey(side, span.chrom, t)) : undefined;
    if (tile && typeof tile === 'object') return tileLookup(tile, x).filter(h => allowed(h.chain)).map(h => ({ ...h, drift: 0 }));
    if (wantExact && tile !== 'failed') { requestTile(s, side, span.chrom, t); }
    exact = false;
    return outline === 'failed' ? [] : outlineLookup(outline, x).filter(h => allowed(h.chain));
  };
  if (wantExact) for (const t of [firstTile - 1, lastTile + 1]) {
    if (t >= 0 && !s.tiles.has(tileKey(side, span.chrom, t))) requestTile(s, side, span.chrom, t);
  }
  const hits = new Map<number, Array<[number, number]>>();
  for (let i = 0; i < SAMPLES; i++) {
    const x = Math.floor(span.start + (i + 0.5) * width / SAMPLES);
    for (const h of lookup(x)) {
      const list = hits.get(h.chain) ?? [];
      if (!list.length || list[list.length - 1][0] !== x) list.push([x, h.pos]);
      hits.set(h.chain, list);
    }
  }
  if (!hits.size) {
    // Nothing of the view maps (a target-only stretch, or the edge of a chain): its nearest correspondence keeps
    // the same width, so a pan out of the gap continues smoothly.
    if (outline === 'failed') return { status: 'none' };
    const centre = span.start + width / 2;
    let best: { row: OutlineRow; d: number } | null = null;
    for (const row of outline.rows) {
      if (!allowed(row[5])) continue;
      const [a, b] = side ? [row[2], row[3]] : [row[0], row[1]];
      const d = centre < a ? a - centre : centre >= b ? centre - b + 1 : 0;
      if (!best || d < best.d) best = { row, d };
    }
    // Only a view inside a gap of a correspondence (an insertion, a target-only stretch) keeps following it;
    // anything farther has no correspondence here, and the linked panel stays.
    const gapBound = Math.max(width, OUTLINE_GAP_BP);
    if (!best || best.d > gapBound) return { status: 'none' };
    const [a, b] = side ? [best.row[2], best.row[3]] : [best.row[0], best.row[1]];
    const at = Math.min(Math.max(Math.round(centre), a), b - 1);
    const h = outlineLookup(outline, at).find(p => p.chain === best!.row[5]);
    if (!h) return { status: 'none' };
    const minus = best.row[4] === '-';
    const mid = h.pos + (minus ? -(centre - at) : centre - at);
    return { status: 'mapped', mapping: finish(summary, direction, best.row[5], minus, mid - width / 2, mid + width / 2, false, []) };
  }
  const ranked = [...hits.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  const chosen = options.preferChain != null && hits.has(options.preferChain) ? options.preferChain : ranked[0][0];
  const minus = chains[chosen][6] === '-';
  const samples = hits.get(chosen)!;
  const endpoint = (x: number) => {
    const direct = lookup(x).find(h => h.chain === chosen);
    if (direct) return direct.pos;
    let near = samples[0];
    for (const smp of samples) if (Math.abs(smp[0] - x) < Math.abs(near[0] - x)) near = smp;
    return near[1] + (minus ? -(x - near[0]) : x - near[0]);
  };
  const a = endpoint(span.start), b = endpoint(span.end - 1);
  const candidates: MapCandidate[] = ranked.filter(([c, list]) => c !== chosen && list.length / SAMPLES >= CANDIDATE_SHARE)
    .map(([c, list]) => ({ chain: c, chrom: direction === 'toSource' ? chains[c][3] : chains[c][0], share: list.length / SAMPLES, minus: chains[c][6] === '-' }));
  return { status: 'mapped', mapping: finish(summary, direction, chosen, minus, Math.min(a, b), Math.max(a, b) + 1, exact, candidates) };
}

function finish(summary: LiftSummary, direction: 'toSource' | 'toTarget', chain: number, minus: boolean, lo: number, hi: number,
  exact: boolean, candidates: MapCandidate[]): SpanMapping {
  const row = summary.chains[chain];
  const chrom = direction === 'toSource' ? row[3] : row[0];
  const size = direction === 'toTarget' ? summary.targets[chrom] ?? Infinity : Infinity;
  let start = Math.round(lo), end = Math.round(hi);
  if (end - start < 1) end = start + 1;
  if (start < 0) { end -= start; start = 0; }
  if (end > size) { start = Math.max(0, start - (end - size)); end = size; }
  return { chrom, start, end, chain, minus, exact, candidates };
}

/** The source contigs of a haplotype that a target chromosome maps to, most primary bp first. */
export function sourceContigsFor(summary: LiftSummary, chrom: string, hap: string): string[] {
  const bp = new Map<string, number>();
  summary.chains.forEach((row, c) => {
    if (summary.selected[c] && row[0] === chrom && row[7] === hap) bp.set(row[3], (bp.get(row[3]) ?? 0) + row[8]);
  });
  return [...bp.entries()].sort((a, b) => b[1] - a[1]).map(([contig]) => contig);
}
