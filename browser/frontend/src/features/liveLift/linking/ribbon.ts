/**
 * The ribbon between a live-lift panel (top edge, target coordinates) and its linked source panel (bottom edge,
 * source coordinates), DESIGN_LIVE_LIFT.md §5.2: one shape per corresponding stretch, wedges at the map's gaps,
 * bands where an edge has no correspondence. Pure geometry; LiftRibbonStrip draws it.
 */

/** `/api/lift/pieces` rows: `[t_start, t_end, q_start, q_end, strand, chain, alt, source, hap]` (forward source). */
export type PieceRow = [number, number, number, number, '+' | '-', number, boolean, string, string];
/** `[chain, t_start, t_end, q_start, q_end, reason]`. */
export type GapRow = [number, number, number, number, number, string];
export interface LiftPiecesResponse {
  key: string; chrom: string; start: number; end: number; pieces: PieceRow[]; gaps: GapRow[];
  min_bp: number; alternatives_capped: number; alternatives: boolean;
}

export type RibbonShapeKind = 'primary' | 'alternative' | 'source_insertion' | 'target_insertion' | 'gap' | 'uncovered_target' | 'uncovered_source';
export interface RibbonShape {
  kind: RibbonShapeKind;
  points: Array<[number, number]>;
  /** A '-' correspondence (drawn crossed). */
  minus?: boolean;
  chain?: number;
  title: string;
}
export interface RibbonGeometry { shapes: RibbonShape[]; elsewhere: number; elsewhereContigs: string[] }

export interface RibbonInput {
  pieces: PieceRow[];
  gaps: GapRow[];
  /** Target position -> px on the top edge (the lifted panel's axis, expansions and reversal included). */
  topX: (t: number) => number;
  /** px of a target span's two ends `[at a, at b]` (an expanded insertion at either end stays outside it); default
   * `[topX(a), topX(b)]`. */
  topEdge?: (a: number, b: number) => [number, number];
  /** px range of a target point (an expanded insertion's column there), default `[topX(t), topX(t)]`. */
  topPoint?: (t: number) => [number, number];
  /** Forward source position -> px on the bottom edge (the source panel's view and orientation). */
  bottomX: (q: number) => number;
  /** The source contig the source panel shows. */
  contig: string;
  height: number;
  /** The two views (the uncovered bands are computed inside them). */
  target: { start: number; end: number };
  source: { start: number; end: number };
  /** Bands narrower than this many px are dropped. */
  minPx?: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

function union(spans: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of spans.slice().sort((x, y) => x[0] - y[0])) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

function complement(lo: number, hi: number, covered: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = lo;
  for (const [a, b] of covered) {
    if (b <= at) continue;
    if (a >= hi) break;
    if (a > at) out.push([at, Math.min(a, hi)]);
    at = Math.max(at, b);
  }
  if (at < hi) out.push([at, hi]);
  return out;
}

export function ribbonGeometry(input: RibbonInput): RibbonGeometry {
  const { pieces, gaps, topX, bottomX, contig, height: H } = input;
  const minPx = input.minPx ?? 1;
  const topEdge = input.topEdge ?? ((a: number, b: number) => [topX(a), topX(b)] as [number, number]);
  const topPoint = input.topPoint ?? ((t: number) => [topX(t), topX(t)] as [number, number]);
  const shapes: RibbonShape[] = [];
  const elsewhere = new Set<string>();
  let elsewhereCount = 0;
  const chainSource = new Map<number, string>();
  const chainMinus = new Map<number, boolean>();
  for (const p of pieces) { chainSource.set(p[5], p[7]); chainMinus.set(p[5], p[4] === '-'); }
  // Alternatives under the primaries.
  const ordered = pieces.slice().sort((a, b) => Number(b[6]) - Number(a[6]) || a[0] - b[0]);
  for (const [t0, t1, q0, q1, strand, chain, alt, source] of ordered) {
    if (source !== contig) { elsewhereCount++; elsewhere.add(source); continue; }
    const minus = strand === '-';
    const [x0, x1] = topEdge(t0, t1);
    // '+': t0 <-> q0; '-': t0 <-> q1 (the ribbon crosses).
    const b0 = bottomX(minus ? q1 : q0), b1 = bottomX(minus ? q0 : q1);
    shapes.push({ kind: alt ? 'alternative' : 'primary', minus, chain,
      points: [[x0, 0], [x1, 0], [b1, H], [b0, H]],
      title: `${alt ? 'Alternative' : 'Primary'} correspondence${minus ? ' (reverse strand)' : ''}: target ${fmt(t0)}–${fmt(t1)} ↔ ${source}:${fmt(q0)}–${fmt(q1)}` });
  }
  for (const [chain, t0, t1, q0, q1, reason] of gaps) {
    if (chainSource.get(chain) !== contig) continue;
    const minus = chainMinus.get(chain) ?? false;
    const [x0, x1] = t1 > t0 ? topEdge(t0, t1) : topPoint(t0);
    const b0 = bottomX(minus ? q1 : q0), b1 = bottomX(minus ? q0 : q1);
    const dt = t1 - t0, dq = q1 - q0;
    if (dt === 0 && dq > 0) {
      // At an expanded insertion the wedge's top is the inserted column itself.
      shapes.push({ kind: 'source_insertion', chain, minus, points: x1 !== x0 ? [[x0, 0], [x1, 0], [b1, H], [b0, H]] : [[x0, 0], [b1, H], [b0, H]],
        title: `${fmt(dq)} bp only in ${contig} (an insertion relative to the target; ${reason.replace(/_/g, ' ')})` });
    } else if (dq === 0 && dt > 0) {
      shapes.push({ kind: 'target_insertion', chain, minus, points: [[x0, 0], [x1, 0], [b0, H]],
        title: `${fmt(dt)} bp of the target with no ${contig} bases (a deletion in the source; ${reason.replace(/_/g, ' ')})` });
    } else if (dt > 0 || dq > 0) {
      shapes.push({ kind: 'gap', chain, minus, points: [[x0, 0], [x1, 0], [b1, H], [b0, H]],
        title: `Unaligned: ${fmt(dt)} bp target ↔ ${fmt(dq)} bp ${contig} (${reason.replace(/_/g, ' ')})` });
    }
  }
  const primary = pieces.filter(p => !p[6]);
  const band = (kind: 'uncovered_target' | 'uncovered_source', a: number, b: number, x: (v: number) => number, top: boolean) => {
    const [xa, xb] = top ? topEdge(a, b) : [x(a), x(b)];
    if (Math.abs(xb - xa) < minPx) return;
    const y0 = top ? 0 : H - 4, y1 = top ? 4 : H;
    shapes.push({ kind, points: [[xa, y0], [xb, y0], [xb, y1], [xa, y1]],
      title: top ? `No ${contig} correspondence: target ${fmt(a)}–${fmt(b)}` : `${contig}:${fmt(a)}–${fmt(b)} has no correspondence on this target view` });
  };
  for (const [a, b] of complement(input.target.start, input.target.end, union(primary.map(p => [p[0], p[1]] as [number, number]))))
    band('uncovered_target', a, b, topX, true);
  const onContig = primary.filter(p => p[7] === contig).map(p => [p[2], p[3]] as [number, number]);
  for (const [a, b] of complement(input.source.start, input.source.end, union(onContig)))
    band('uncovered_source', a, b, bottomX, false);
  return { shapes, elsewhere: elsewhereCount, elsewhereContigs: [...elsewhere].sort() };
}

/** px of a position in a linear view of `width` px (reversed: right to left). */
export function linearX(start: number, end: number, width: number, reversed: boolean, offset = 0): (pos: number) => number {
  const span = Math.max(1, end - start);
  return pos => offset + (reversed ? (end - pos) / span : (pos - start) / span) * width;
}
