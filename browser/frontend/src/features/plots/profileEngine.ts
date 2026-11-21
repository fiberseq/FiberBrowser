/**
 * The one profile engine (PLOTS_PANEL_PLAN.md, Phase 2): signal along position, per group, from reads.
 *
 * Input is region-shaped so the same engine serves the current view now and BED region sets / selected features
 * later (Phase 3): a region (chrom, start, end, strand, anchor) and the reads over it, each with its group, its span
 * and the intervals (or single-base marks) of the chosen source, in genomic coordinates. Output per group: the reads
 * covering each bin (coverage) and the source signal there (bases of interval, or marks, per bin), which finish into a
 * profile by a normalisation and a Gaussian smoothing, every one a parameter.
 *
 * Signal (default "fraction"): the share of reads covering a bin that have the source there (occupancy for intervals;
 * marks per covering read per bp for marks: finish with marksPerBp). Pooling groups is exact: raw sums add.
 */

import { addReadIntervals } from '../../utils/metaprofileBins';

export interface ProfileRegion {
  chrom: string;
  /** 0-based, half-open. */
  start: number;
  end: number;
  /** '-' flips the profile so downstream is to the right (BED regions; the view is '+'). */
  strand?: '+' | '-';
}

export interface ProfileRead {
  group: string;
  /** The read's name (sampling keys; absent for synthetic reads). */
  id?: string;
  /** The dataset it came from (a bootstrap unit is a dataset's read: two datasets' reads of one name are two units). */
  dataset?: string;
  /** The read's aligned span (genomic). */
  start: number;
  end: number;
  /** Source intervals (genomic, half-open); may overlap (they are merged per read so a base counts once). A third
   *  number is the footprint's whole size when the interval was clipped to the fetched window (compact reads); a
   *  fourth 1 marks a "whole" interval (BED transport) that the fetch may have cut, so its bounds are not whole. */
  intervals?: Array<[number, number] | [number, number, number] | [number, number, number, number]>;
  /** The intervals are whole footprints (not clipped to the region): BED size histograms. */
  whole?: boolean;
  /** Source marks (genomic positions), for mark layers (m6A). */
  points?: number[];
}

export interface RawProfile {
  group: string;
  nReads: number;
  /** Reads covering each bin (bp-weighted / bin width). */
  coverage: Float64Array;
  /** Source bases per bin over bin width (intervals), or marks per bin (points). */
  signal: Float64Array;
}

export type ProfileNormalization = 'fraction' | 'count' | 'relative';

export interface ProfileFinishOptions {
  normalization: ProfileNormalization;
  /** Gaussian sigma along positions, bp (0 = off); applied to signal and coverage before dividing. */
  sigmaBp: number;
  /** Bins covered by fewer reads than this are blank. */
  minCoverage: number;
  binBp: number;
  /** Mark sources (m6A): 'fraction' is marks per covering read per bp, so the per-bin mark count is divided by binBp
   *  (raw signal stays marks per bin: 'count' and pooling are unchanged). */
  marksPerBp?: boolean;
}

export const binsOf = (region: ProfileRegion, binBp: number): number => Math.max(1, Math.ceil((region.end - region.start) / Math.max(1e-9, binBp) - 1e-9));

function mergeIntervals(ivs: NonNullable<ProfileRead['intervals']>): Array<[number, number]> {
  const sorted = ivs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Add [a, b) (genomic) to per-bin sums, each bin receiving its overlap / binBp. */
function addSpan(arr: Float64Array, a: number, b: number, region: ProfileRegion, binBp: number) {
  const lo = Math.max(a, region.start), hi = Math.min(b, region.end);
  if (hi <= lo) return;
  const n = arr.length;
  // By bin index (a walk along x stalls on fractional bin widths: the boundary can floor back into the same bin).
  const first = Math.max(0, Math.min(n - 1, Math.floor((lo - region.start) / binBp)));
  const last = Math.max(first, Math.min(n - 1, Math.floor((hi - region.start) / binBp - 1e-9)));
  for (let k = first; k <= last; k++) {
    const a = Math.max(lo, region.start + k * binBp);
    // The last bin takes everything to the region's end (binsOf rounds a sliver into it).
    const b = k === n - 1 ? hi : Math.min(hi, region.start + (k + 1) * binBp);
    if (b > a) arr[k] += (b - a) / binBp;
  }
}

/** Accumulate reads over a region into raw per-group profiles (groups in first-seen order unless `groups` is given).
 *  `markScale` weighs each mark (scale-regions: plot bin / segment bin, so marks stay per plot-sized bin). */
export function accumulateProfiles(reads: ProfileRead[], region: ProfileRegion, binBp: number, groups?: string[], markScale = 1): RawProfile[] {
  const n = binsOf(region, binBp);
  const by = new Map<string, RawProfile>();
  for (const g of groups ?? []) by.set(g, { group: g, nReads: 0, coverage: new Float64Array(n), signal: new Float64Array(n) });
  for (const r of reads) {
    if (r.end <= region.start || r.start >= region.end) continue;
    let p = by.get(r.group);
    if (!p) {
      if (groups) continue;
      p = { group: r.group, nReads: 0, coverage: new Float64Array(n), signal: new Float64Array(n) };
      by.set(r.group, p);
    }
    p.nReads += 1;
    addSpan(p.coverage, r.start, r.end, region, binBp);
    if (r.intervals) for (const [a, b] of mergeIntervals(r.intervals)) addSpan(p.signal, Math.max(a, r.start), Math.min(b, r.end), region, binBp);
    if (r.points) for (const x of r.points) {
      if (x < region.start || x >= region.end || x < r.start || x >= r.end) continue;
      p.signal[Math.min(n - 1, Math.floor((x - region.start) / binBp))] += markScale;
    }
  }
  const out = [...by.values()];
  if (region.strand === '-') for (const p of out) { p.coverage.reverse(); p.signal.reverse(); }
  return out;
}

/** Sum raw profiles (pooling groups: exact, since coverage and signal are sums). */
export function poolProfiles(parts: RawProfile[], group: string): RawProfile {
  const n = parts[0]?.coverage.length ?? 0;
  const out: RawProfile = { group, nReads: 0, coverage: new Float64Array(n), signal: new Float64Array(n) };
  for (const p of parts) {
    out.nReads += p.nReads;
    for (let i = 0; i < n; i++) { out.coverage[i] += p.coverage[i]; out.signal[i] += p.signal[i]; }
  }
  return out;
}

/** A separable Gaussian along the bins (sigma in bins; 0 = a copy). Edges renormalised by the kernel mass inside. */
export function gaussianSmooth1d(v: ArrayLike<number>, sigmaBins: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  if (!(sigmaBins > 0)) { for (let i = 0; i < n; i++) out[i] = v[i]; return out; }
  const r = Math.max(1, Math.ceil(sigmaBins * 3));
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigmaBins * sigmaBins)));
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let j = -r; j <= r; j++) {
      const x = i + j;
      if (x < 0 || x >= n) continue;
      s += v[x] * k[j + r];
      w += k[j + r];
    }
    out[i] = w > 0 ? s / w : 0;
  }
  return out;
}

/** A raw profile as the values drawn: normalised, smoothed, blank where coverage is under the minimum. */
export function finishProfile(p: RawProfile, o: ProfileFinishOptions): (number | null)[] {
  const sigma = o.sigmaBp > 0 ? o.sigmaBp / Math.max(1, o.binBp) : 0;
  const cov = gaussianSmooth1d(p.coverage, sigma);
  const sig = gaussianSmooth1d(p.signal, sigma);
  const perBp = o.marksPerBp && o.normalization === 'fraction' ? Math.max(1e-9, o.binBp) : 1;
  const raw = Array.from(cov, (c, i) => (p.coverage[i] < o.minCoverage || !(c > 0) ? null : o.normalization === 'count' ? sig[i] : sig[i] / c / perBp));
  if (o.normalization !== 'relative') return raw;
  // Relative: each bin over the profile's mean across the window (1 = average here).
  const vals = raw.filter((x): x is number => x != null);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  return raw.map(x => (x == null || !(mean > 0) ? null : x / mean));
}

export type ProfileCompareOp = 'diff' | 'log2ratio';

/** A − B or log2(A / B) per bin (null where either is blank; log2 also where either is not positive). */
export function compareProfiles(a: (number | null)[], b: (number | null)[], op: ProfileCompareOp): (number | null)[] {
  return a.map((x, i) => {
    const y = b[i];
    if (x == null || y == null) return null;
    if (op === 'diff') return x - y;
    return x > 0 && y > 0 ? Math.log2(x / y) : null;
  });
}

export interface ReadRow {
  group: string;
  /** The read's start (genomic), for sorting by position. */
  start: number;
  /** Per bin: the fraction of the bin the source covers on this read (marks: marks per bp); null where the read is absent. */
  values: (number | null)[];
  /** Mean of `values` over the bins the read covers (sorting by signal). */
  mean: number;
}

/** One row per read over a region (reads × position heatmaps). */
export function readRows(reads: ProfileRead[], region: ProfileRegion, binBp: number): ReadRow[] {
  const n = binsOf(region, binBp);
  const rows: ReadRow[] = [];
  for (const r of reads) {
    if (r.end <= region.start || r.start >= region.end) continue;
    const cov = new Float64Array(n), sig = new Float64Array(n);
    addSpan(cov, r.start, r.end, region, binBp);
    if (r.intervals) for (const [a, b] of mergeIntervals(r.intervals)) addSpan(sig, Math.max(a, r.start), Math.min(b, r.end), region, binBp);
    if (r.points) for (const x of r.points) if (x >= region.start && x < region.end && x >= r.start && x < r.end) sig[Math.min(n - 1, Math.floor((x - region.start) / binBp))] += 1 / binBp;
    if (region.strand === '-') { cov.reverse(); sig.reverse(); }
    const values = Array.from(cov, (c, i) => (c > 0 ? Math.min(r.points ? Infinity : 1, sig[i] / c) : null));
    const seen = values.filter((v): v is number => v != null);
    rows.push({ group: r.group, start: r.start, values, mean: seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : 0 });
  }
  return rows;
}

export type ReadRowSort = 'signal' | 'cluster' | 'start';

/** Rows sorted: by group then signal (high first), by group then start, or by signal across groups. */
export function sortReadRows(rows: ReadRow[], sort: ReadRowSort, groupOrder: string[] = []): ReadRow[] {
  const rank = new Map(groupOrder.map((g, i) => [g, i]));
  const gk = (r: ReadRow) => rank.get(r.group) ?? groupOrder.length;
  return [...rows].sort((a, b) => {
    if (sort === 'signal') return gk(a) - gk(b) || b.mean - a.mean;
    if (sort === 'start') return gk(a) - gk(b) || a.start - b.start;
    return gk(a) - gk(b) || b.mean - a.mean;
  });
}

/** Evenly thin rows to at most `max` (keeping order): a heatmap can't show more rows than pixels anyway. */
export function thinRows<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor((i * rows.length) / max)]);
  return out;
}

/** A read for multi-channel accumulation over a [0, width) window (the read track's metaprofile tracks). */
export interface ChannelRead {
  /** The read's span in window coordinates. */
  start: number;
  end: number;
  /** Interval channels (window coordinates). */
  spans?: Record<string, Array<[number, number]>>;
  /** Mark channels (window positions). */
  points?: Record<string, number[]>;
}

/**
 * Coverage and per-channel signal over `nBins` bins of a [0, width) window. Weighting:
 * - 'overlap': each bin gets the covered fraction of its width (the Plots metaprofile);
 * - 'touch': the read track's metaprofiles. A read counts at most once per bin per channel: the union of the bins its
 *   intervals of that channel touch (utils/metaprofileBins), so two calls meeting inside one bin no longer count the
 *   read twice there. Its coverage spans [start, end) widened to every interval it adds, so no bin gets a read's
 *   signal without its coverage. Every interval-channel profile stays within [0, 1]. Mark channels (points) count
 *   each mark, as before.
 * Profiles: signal / coverage per bin (finishChannels).
 */
export function accumulateChannels(reads: ChannelRead[], nBins: number, width: number, weighting: 'overlap' | 'touch' = 'overlap'):
  { coverage: Float64Array; channels: Record<string, Float64Array> } {
  if (weighting === 'touch') return accumulateTouch(reads, nBins, width);
  const binSize = width / nBins;
  const coverage = new Float64Array(nBins);
  const channels: Record<string, Float64Array> = {};
  const get = (name: string) => (channels[name] ??= new Float64Array(nBins));
  const add = (arr: Float64Array, a: number, b: number) => {
    if (b <= 0 || a >= width) return;
    // By bin index (a walk along x stalls on non-integer bin widths: 3 * 0.7 / 0.7 floors to 2).
    const first = Math.max(0, Math.floor(a / binSize));
    const last = Math.min(nBins - 1, Math.floor((b - 1e-9) / binSize));
    for (let k = first; k <= last; k++) {
      const lo = Math.max(a, k * binSize), hi = Math.min(b, (k + 1) * binSize);
      if (hi > lo) arr[k] += (hi - lo) / binSize;
    }
  };
  for (const r of reads) {
    if (r.end > r.start) add(coverage, r.start, r.end);
    for (const [name, ivs] of Object.entries(r.spans ?? {})) {
      const arr = get(name);
      for (const [a, b] of ivs) add(arr, a, b);
    }
    for (const [name, pts] of Object.entries(r.points ?? {})) {
      const arr = get(name);
      for (const p of pts) { const k = Math.floor(p / binSize); if (k >= 0 && k < nBins) arr[k] += 1; }
    }
  }
  return { coverage, channels };
}

/** 'touch' weighting (see accumulateChannels): per read, the union of each channel's bins; span widened to its intervals. */
function accumulateTouch(reads: ChannelRead[], nBins: number, width: number): { coverage: Float64Array; channels: Record<string, Float64Array> } {
  const binSize = width / nBins;
  const covDiff = new Float64Array(nBins + 1);
  const diffs: Record<string, Float64Array> = {};
  const marks: Record<string, Float64Array> = {};
  for (const r of reads) {
    let s = r.end > r.start ? r.start : Infinity, e = r.end > r.start ? r.end : -Infinity;
    for (const [name, ivs] of Object.entries(r.spans ?? {})) {
      const diff = (diffs[name] ??= new Float64Array(nBins + 1));
      for (const [a, b] of ivs) if (b > a) { if (a < s) s = a; if (b > e) e = b; }
      addReadIntervals(diff, ivs, width, nBins);
    }
    if (e > s) addReadIntervals(covDiff, [[s, e]], width, nBins);
    for (const [name, pts] of Object.entries(r.points ?? {})) {
      const arr = (marks[name] ??= new Float64Array(nBins));
      for (const p of pts) if (p >= 0 && p < width) arr[Math.min(nBins - 1, Math.floor(p / binSize))] += 1;
    }
  }
  const cumulate = (diff: Float64Array) => {
    const out = new Float64Array(nBins);
    let run = 0;
    for (let i = 0; i < nBins; i++) { run += diff[i]; out[i] = run; }
    return out;
  };
  const channels: Record<string, Float64Array> = {};
  for (const [name, diff] of Object.entries(diffs)) channels[name] = cumulate(diff);
  for (const [name, arr] of Object.entries(marks)) {
    const have = channels[name];
    if (have) for (let i = 0; i < nBins; i++) have[i] += arr[i];
    else channels[name] = arr;
  }
  return { coverage: cumulate(covDiff), channels };
}

/** Each channel over coverage per bin (a bin no read covers keeps its raw sum, as the read track did). */
export function finishChannels(acc: { coverage: Float64Array; channels: Record<string, Float64Array> }): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [name, arr] of Object.entries(acc.channels)) out[name] = Array.from(arr, (v, i) => (acc.coverage[i] > 0 ? v / acc.coverage[i] : v));
  return out;
}
