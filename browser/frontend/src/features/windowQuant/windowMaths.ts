/**
 * Window maths for Quantify a window: per-read sums in exact bp (no bins), and window means of series that exist only
 * per group as bins (stored profiles), with fractional bin weights at the window's edges.
 *
 * A unit's sums (UNIT_COLS): [num, den] in the bounds, the same over the flank (both ends of the view, for the flank
 * baseline) and over the whole view (the dataset baseline). A group's value is Σ num / Σ den over its units:
 * - a fraction layer: num = bp of the layer inside the bounds on the read, den = bp of the read inside the bounds, so
 *   the group value is the coverage-weighted mean of the reads' own fractions (each read weighs its covered bp);
 * - marks (m6A): num = marks, den = bp (marks per bp);
 * - a share of reads: num = 1 for a member, den = 1 for every read the state was evaluated in;
 * - a per-read value (a molecule's regularity score): num = value, den = 1.
 */

export const UNIT_COLS = 6;
export type UnitSums = [number, number, number, number, number, number];

/** Bp of [a0, a1) ∩ [b0, b1). */
export const overlapBp = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Merged, sorted copy of half-open intervals (a base counts once). */
/** An interval [start, end) with any extra fields (the profile engine's reads may carry a size or a quality). */
export type IntervalLike = readonly [number, number, ...number[]];

export function mergeIntervals(ivs: ReadonlyArray<IntervalLike>): Array<[number, number]> {
  const sorted = ivs.filter(iv => iv[1] > iv[0]).map(iv => [iv[0], iv[1]] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export interface WindowRead {
  start: number;
  end: number;
  intervals?: ReadonlyArray<IntervalLike>;
  points?: readonly number[];
}

export interface SumsBounds {
  /** The bounds [from, to). */
  win: [number, number];
  /** The view's two flanks. */
  flanks: Array<[number, number]>;
  /** The whole view. */
  view: [number, number];
}

/** The flanks of a view: `fraction` of its width at each end. */
export function viewFlanks(start: number, end: number, fraction: number): Array<[number, number]> {
  const w = Math.max(1, Math.round((end - start) * fraction));
  return [[start, start + w], [end - w, end]];
}

function layerAndSpan(r: WindowRead, ranges: ReadonlyArray<readonly [number, number]>, merged: Array<[number, number]> | null): [number, number] {
  let num = 0, den = 0;
  for (const [a, b] of ranges) {
    const lo = Math.max(a, r.start), hi = Math.min(b, r.end);
    if (hi <= lo) continue;
    den += hi - lo;
    if (merged) for (const [x, y] of merged) num += overlapBp(x, y, lo, hi);
    else for (const p of r.points ?? []) if (p >= lo && p < hi) num += 1;
  }
  return [num, den];
}

/** A read's sums (UNIT_COLS) for a fraction layer (intervals) or marks (points). */
export function readSums(r: WindowRead, b: SumsBounds): UnitSums {
  const merged = r.points ? null : mergeIntervals(r.intervals ?? []);
  const [n0, d0] = layerAndSpan(r, [b.win], merged);
  const [n1, d1] = layerAndSpan(r, b.flanks, merged);
  const [n2, d2] = layerAndSpan(r, [b.view], merged);
  return [n0, d0, n1, d1, n2, d2];
}

/** A share-of-reads unit: '1' a member, '0' evaluated and not a member, anything else not evaluated (null: no unit). */
export function shareSums(state: string | undefined): UnitSums | null {
  if (state === '1') return [1, 1, 0, 0, 1, 1];
  if (state === '0') return [0, 1, 0, 0, 0, 1];
  return null;
}

/** A per-read value unit (null / non-finite: no unit). */
export function valueSums(v: number | null | undefined): UnitSums | null {
  return v != null && Number.isFinite(v) ? [v, 1, 0, 0, v, 1] : null;
}

/** The fraction of each of n bins over [start, end) that lies inside [from, to) (bins at the edges count in part). */
export function binWindowWeights(n: number, start: number, end: number, from: number, to: number): Float64Array {
  const w = new Float64Array(n);
  if (!(n > 0) || !(end > start)) return w;
  const bin = (end - start) / n;
  for (let i = 0; i < n; i++) {
    const a = start + i * bin, b = a + bin;
    w[i] = overlapBp(a, b, from, to) / bin;
  }
  return w;
}

/**
 * The window mean of a binned series over [start, end) (bin i in genomic order; `reversed`: the series is stored
 * right to left), each bin weighed by its share inside the window, blank bins (null / non-finite) left out. Null when
 * no measured bin falls in the window.
 */
export function binnedWindowMean(values: ReadonlyArray<number | null | undefined>, start: number, end: number, from: number, to: number, reversed = false): number | null {
  const n = values.length;
  const w = binWindowWeights(n, start, end, from, to);
  let s = 0, ws = 0;
  for (let i = 0; i < n; i++) {
    if (!(w[i] > 0)) continue;
    const v = values[reversed ? n - 1 - i : i];
    if (v == null || !Number.isFinite(v)) continue;
    s += w[i] * v; ws += w[i];
  }
  return ws > 0 ? s / ws : null;
}
