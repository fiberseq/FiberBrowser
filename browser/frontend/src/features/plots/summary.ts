/**
 * Summaries across groups (a view mode of the existing types, not a type): each group reduced to one number, drawn
 * as bars or a line across the groups in panel order (datasets in panel order: the time-course case), with 95%
 * intervals.
 * - Metaprofile: the mean signal in a window (Σ signal / Σ coverage over its bins, pooled exactly). Interval: Wilson
 *   on the reads covering the window (n = the window's mean coverage in reads, k = mean × n): approximate.
 * - Size histogram: the share of a size band (the band's weight over the group's total). Interval: Wilson, exact
 *   under count weighting (k footprints of n); approximate under bp weighting (bp are not independent).
 * - Size plots: the mean value in a size × position box (no interval: the cells are smoothed and normalised).
 * One implementation of the interval: utils/statistics.wilsonInterval.
 */
import { wilsonInterval } from '../../utils/statistics';
import { percentileInterval, poissonWeights } from '../../utils/stableSample';
import { finishProfile, poolProfiles, type ProfileFinishOptions, type RawProfile } from './profileEngine';
import type { SizeMatrix } from '../../utils/footprintSizeMatrix';

export type SummaryKind = 'window-mean' | 'band-share' | 'box-mean';

export interface SummarySettings {
  on: boolean;
  chart: 'bar' | 'line';
  /** Window (metaprofile) or position range (size plots), in the plot's x units; null: the whole axis. */
  from: number | null;
  to: number | null;
  /** Size band (histogram) or size range (size plots), bp. */
  sizeFrom: number;
  sizeTo: number;
  /** auto: bootstrap for the window and box means, exact Wilson for a band share under count weighting. */
  ci: 'auto' | 'bootstrap' | 'wilson' | 'none';
  /** Bootstrap resamples (Poisson bootstrap over units, seeded). */
  resamples: number;
  /** The bootstrap's seed; null: the plot's sampling seed. */
  bootSeed: number | null;
  /** BED: the bootstrap's units (regions are independent; reads within regions are not). */
  unit: 'regions' | 'reads';
  /** A profile's value: 'curve', the mean of the drawn curve over the window's bins (smoothing and blank bins as drawn,
   *  so a bar equals the curve beside it; the default), or 'pooled', Σ signal / Σ coverage over the window (3.1.0). */
  statistic: 'curve' | 'pooled';
}

export const DEFAULT_SUMMARY: SummarySettings = Object.freeze({ on: false, chart: 'bar', from: null, to: null, sizeFrom: 0, sizeTo: 90, ci: 'auto', resamples: 1000, bootSeed: null, unit: 'regions', statistic: 'curve' }) as SummarySettings;

export function normalizeSummary(raw: unknown): SummarySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const sf = num(r.sizeFrom) ?? DEFAULT_SUMMARY.sizeFrom, st = num(r.sizeTo) ?? DEFAULT_SUMMARY.sizeTo;
  const ci = r.ci === 'none' || r.ci === 'wilson' || r.ci === 'bootstrap' ? r.ci : 'auto';
  const rs = num(r.resamples);
  const bs = num(r.bootSeed);
  return { on: r.on === true, chart: r.chart === 'line' ? 'line' : 'bar', from: num(r.from), to: num(r.to), sizeFrom: Math.min(sf, st), sizeTo: Math.max(sf, st), ci,
    resamples: rs == null ? 1000 : Math.round(Math.min(10000, Math.max(50, rs))), bootSeed: bs == null ? null : Math.round(Math.max(0, bs)), unit: r.unit === 'reads' ? 'reads' : 'regions',
    // A summary saved before 3.1.1 has no statistic: it keeps the pooled value it was saved with; new plots start
    // from DEFAULT_SUMMARY (the curve).
    statistic: r.statistic === 'pooled' || r.statistic === 'curve' ? r.statistic : raw && typeof raw === 'object' && Object.keys(r).length ? 'pooled' : 'curve' };
}

/** The interval method a summary uses (auto: bootstrap for means, exact Wilson for a band share of counts). */
export function resolveCi(kind: SummaryKind, s: SummarySettings, countWeighting = true, normalization: 'fraction' | 'count' | 'relative' = 'fraction'): 'bootstrap' | 'wilson' | 'none' {
  // Wilson is for a share of reads: not a box mean, a count per bin or a relative value.
  if (s.ci !== 'auto') return s.ci === 'wilson' && (kind === 'box-mean' || normalization !== 'fraction' || (kind === 'window-mean' && s.statistic !== 'pooled')) ? 'none' : s.ci;
  return kind === 'band-share' && countWeighting ? 'wilson' : 'bootstrap';
}

/** A bootstrap unit (a read, or a BED region): its own raw coverage and signal over the plot's bins. */
export interface SummaryUnit { id: string; cov: ArrayLike<number>; sig: ArrayLike<number> }

/** The percentile interval of a ratio Σ num / Σ den over Poisson-bootstrap resamples of the units (seeded). */
export function bootstrapRatio(units: Array<{ id: string; num: number; den: number }>, resamples: number, seed: number, level = 0.95): [number, number] | null {
  if (!units.length) return null;
  const N = new Float64Array(resamples), D = new Float64Array(resamples);
  for (const u of units) {
    if (!u.den && !u.num) continue;
    const w = poissonWeights(seed, u.id, resamples);
    for (let b = 0; b < resamples; b++) if (w[b]) { N[b] += w[b] * u.num; D[b] += w[b] * u.den; }
  }
  const vals: number[] = [];
  for (let b = 0; b < resamples; b++) if (D[b] > 0) vals.push(N[b] / D[b]);
  return percentileInterval(vals, level);
}

/** The percentile interval of any statistic of the units' summed values, over Poisson-bootstrap resamples (seeded):
 *  each unit carries a few numbers (sums), each resample adds them weighted by the unit's draws, `stat` reads the sums. */
export function bootstrapSums(units: Array<{ id: string; v: ArrayLike<number> }>, resamples: number, seed: number, stat: (sums: Float64Array) => number | null, level = 0.95,
  weights?: BootstrapWeights): [number, number] | null {
  if (!units.length) return null;
  const k = units[0].v.length;
  const S = bootstrapDraws(units, resamples, seed, weights);
  const vals: number[] = [];
  for (let b = 0; b < resamples; b++) { const x = stat(S.subarray(b * k, b * k + k)); if (x != null && Number.isFinite(x)) vals.push(x); }
  return percentileInterval(vals, level);
}

/** Each unit's Poisson-bootstrap draws, kept per (seed, resamples, unit id): one unit gets the same draws in every group,
 *  baseline and reference it is part of, so ratios and differences between them resample jointly. */
export type BootstrapWeights = Map<string, Uint8Array>;

export function cachedPoissonWeights(cache: BootstrapWeights | undefined, seed: number, id: string, resamples: number): Uint8Array {
  if (!cache) return poissonWeights(seed, id, resamples);
  const key = `${seed}\u0000${resamples}\u0000${id}`;
  let w = cache.get(key);
  if (!w) { w = poissonWeights(seed, id, resamples); cache.set(key, w); }
  return w;
}

/** The resampled sums (resamples × k, row-major) of the units' k values: resample b adds each unit's values times its
 *  b-th Poisson(1) draw (the same draws as bootstrapSums and the server's stable_sample). */
export function bootstrapDraws(units: Array<{ id: string; v: ArrayLike<number> }>, resamples: number, seed: number, weights?: BootstrapWeights): Float64Array {
  const k = units[0]?.v.length ?? 0;
  const S = new Float64Array(resamples * k);
  for (const u of units) {
    let any = false;
    for (let j = 0; j < k; j++) if (u.v[j]) { any = true; break; }
    if (!any) continue;
    const w = cachedPoissonWeights(weights, seed, u.id, resamples);
    for (let b = 0; b < resamples; b++) if (w[b]) for (let j = 0; j < k; j++) S[b * k + j] += w[b] * u.v[j];
  }
  return S;
}

/** A unit's window sums (metaprofile) or band / total weight (histogram). */
export function unitWindow(u: SummaryUnit, start: number, binBp: number, from: number | null, to: number | null): { num: number; den: number } {
  let num = 0, den = 0;
  for (let i = 0; i < u.cov.length; i++) {
    const x = start + i * binBp;
    if ((from != null && x + binBp <= from) || (to != null && x >= to)) continue;
    num += u.sig[i]; den += u.cov[i];
  }
  return { num, den };
}

export function unitBand(u: SummaryUnit, sizeMin: number, binBp: number, sizeFrom: number, sizeTo: number): { num: number; den: number } {
  let num = 0, den = 0;
  for (let i = 0; i < u.sig.length; i++) {
    const s0 = sizeMin + i * binBp;
    den += u.sig[i];
    if (s0 >= sizeFrom && s0 < sizeTo) num += u.sig[i];
  }
  return { num, den };
}

/** "bootstrap 95% (1,000 Poisson resamples of reads, seed 1)" / "Wilson 95% (exact)" / "no interval". */
export function ciText(method: 'bootstrap' | 'wilson' | 'none', s: SummarySettings, seed: number, unitNoun: string, exact: boolean, kind: SummaryKind = 'window-mean'): string {
  if (method === 'none') return 'no interval';
  if (method === 'wilson') return exact ? 'Wilson 95% (exact for counts)' : kind === 'band-share' ? 'Wilson 95% (approximate under bp weighting)' : 'Wilson 95% on the reads covering the window (approximate)';
  return `bootstrap 95% (${s.resamples.toLocaleString('en-US')} Poisson resamples of ${unitNoun}, seed ${seed})`;
}

export interface SummaryValue {
  id: string; title: string; color?: string; value: number | null; lo: number | null; hi: number | null; n: number | null;
  /** Curve bootstrap: fewer resamples than asked (the work cap), said in the header. */
  resamplesUsed?: number;
  /** Several sources: the bar's source (its series: colour, legend) and the group or comparison it is a bar of. */
  series?: string; seriesLabel?: string; cluster?: string; clusterTitle?: string;
}

/** Whether summary values are several sources' (grouped bars: one cluster per group, one bar per source). */
export const isGroupedSummary = (values: SummaryValue[]): boolean => new Set(values.map(v => v.series).filter(Boolean)).size > 1;

/** Clusters (groups or comparisons, in order) and series (sources, in order) of grouped summary values. */
export function summaryLayout(values: SummaryValue[]): { clusters: Array<{ id: string; title: string }>; series: Array<{ id: string; label: string; color?: string }> } {
  const clusters: Array<{ id: string; title: string }> = [], series: Array<{ id: string; label: string; color?: string }> = [];
  for (const v of values) {
    const c = v.cluster ?? v.id, sId = v.series ?? '';
    if (!clusters.some(x => x.id === c)) clusters.push({ id: c, title: v.clusterTitle ?? v.title });
    if (!series.some(x => x.id === sId)) series.push({ id: sId, label: v.seriesLabel ?? sId, ...(v.color ? { color: v.color } : {}) });
  }
  return { clusters, series };
}

const wilson = (k: number, n: number) => (n > 0 ? wilsonInterval(Math.round(Math.max(0, Math.min(n, k))), Math.round(n)) : null);

/** A metaprofile group's mean in [from, to) (x of bin i = start + i * binBp), pooled raw sums. */
export function windowMean(raw: RawProfile, start: number, binBp: number, from: number | null, to: number | null, ci: boolean): Omit<SummaryValue, 'id' | 'title'> {
  let sig = 0, cov = 0, bins = 0;
  for (let i = 0; i < raw.coverage.length; i++) {
    const x = start + i * binBp;
    if ((from != null && x + binBp <= from) || (to != null && x >= to)) continue;
    sig += raw.signal[i]; cov += raw.coverage[i]; bins++;
  }
  if (!(cov > 0)) return { value: null, lo: null, hi: null, n: null };
  const value = sig / cov;
  const n = bins ? cov / bins : 0;
  const w = ci && value >= 0 && value <= 1 ? wilson(value * n, n) : null;
  return { value, lo: w ? w.low : null, hi: w ? w.high : null, n: Math.round(n) };
}

/** A histogram group's share of the size band [sizeFrom, sizeTo) (bin i covers sizeMin + i * binBp). */
export function bandShare(raw: RawProfile, sizeMin: number, binBp: number, sizeFrom: number, sizeTo: number, ci: boolean): Omit<SummaryValue, 'id' | 'title'> {
  let k = 0, n = 0;
  for (let i = 0; i < raw.signal.length; i++) {
    const s0 = sizeMin + i * binBp;
    n += raw.signal[i];
    if (s0 >= sizeFrom && s0 < sizeTo) k += raw.signal[i];
  }
  if (!(n > 0)) return { value: null, lo: null, hi: null, n: null };
  const w = ci ? wilson(k, n) : null;
  return { value: k / n, lo: w ? w.low : null, hi: w ? w.high : null, n };
}

/** The scale a size plot's summary is on: the one the plot draws (log2 enrichment, log1p counts, or the values). */
export type BoxTransform = 'log2' | 'log1p' | 'none';

export const boxTransformOf = (size: { normalization: string; log: boolean }): BoxTransform =>
  (!size.log ? 'none' : size.normalization === 'raw' ? 'log1p' : 'log2');

/** The default summary window when none is set: a normalised plot's whole axis is constant by construction, so the
 *  centre (anchor ± 100 bp, or the middle 10% of the view); otherwise the whole axis. */
export function summaryWindow(s: SummarySettings, o: { normalised: boolean; anchored: boolean; start: number; end: number }): { from: number | null; to: number | null; isDefault: boolean } {
  if (s.from != null || s.to != null || !o.normalised) return { from: s.from, to: s.to, isDefault: false };
  if (o.anchored) return { from: -100, to: 100, isDefault: true };
  const c = (o.start + o.end) / 2, half = Math.max(1, Math.round((o.end - o.start) * 0.05));
  return { from: Math.round(c - half), to: Math.round(c + half), isDefault: true };
}

/** Whether a window covers the whole axis [start, end). */
export const coversAxis = (from: number | null, to: number | null, start: number, end: number): boolean =>
  (from == null || from <= start) && (to == null || to >= end);

/** "the whole-axis mean is 1 by construction; pick a window" when the box is constant by construction: row
 *  normalisation over every position, column normalisation over every size (null otherwise). */
export function constantBoxNote(normalization: string, s: Pick<SummarySettings, 'sizeFrom' | 'sizeTo'>, win: { from: number | null; to: number | null },
  axis: { start: number; end: number; sizeMin: number; sizeMax: number }, log: boolean): string | null {
  const one = log ? '0 (log2 of 1)' : '1';
  if (normalization === 'row' && coversAxis(win.from, win.to, axis.start, axis.end)) return `Each size row is divided by its mean across the window, so the whole-axis mean is ${one} by construction; pick a window (Summary › Window).`;
  if (normalization === 'column' && s.sizeFrom <= axis.sizeMin && s.sizeTo >= axis.sizeMax) return `Each position is divided by its mean across sizes, so the mean over every size is ${one} by construction; pick a size band.`;
  return null;
}

/** A size matrix's mean over the box (sizes [sizeFrom, sizeTo) × positions [from, to)), blank cells left out, on
 *  the plot's scale (log2 enrichment: the mean of log2 of the cells; log1p counts). */
export function boxMean(m: SizeMatrix, d: { size_min: number; size_bin: number; pos_bin: number }, start: number, s: SummarySettings,
  o: { from?: number | null; to?: number | null; transform?: BoxTransform } = {}): Omit<SummaryValue, 'id' | 'title'> {
  const from = o.from !== undefined ? o.from : s.from, to = o.to !== undefined ? o.to : s.to;
  const tf = o.transform ?? 'none';
  let sum = 0, cells = 0;
  m.forEach((row, i) => {
    const size = d.size_min + i * d.size_bin;
    if (size < s.sizeFrom || size >= s.sizeTo) return;
    row.forEach((v, j) => {
      const x = start + j * d.pos_bin;
      if ((from != null && x + d.pos_bin <= from) || (to != null && x >= to)) return;
      if (v == null || !Number.isFinite(v)) return;
      const y = tf === 'log2' ? (v > 0 ? Math.log2(v) : null) : tf === 'log1p' ? Math.log1p(Math.max(0, v)) : v;
      if (y != null && Number.isFinite(y)) { sum += y; cells++; }
    });
  });
  return cells ? { value: sum / cells, lo: null, hi: null, n: cells } : { value: null, lo: null, hi: null, n: null };
}

export function summaryTsv(values: SummaryValue[], what: string): string {
  if (isGroupedSummary(values)) {
    // One row block per source: group, source, value, interval, n.
    const { series } = summaryLayout(values);
    const rows = series.flatMap(sr => values.filter(v => (v.series ?? '') === sr.id)
      .map(v => [v.clusterTitle ?? v.title, sr.label, v.value ?? 'NA', v.lo ?? 'NA', v.hi ?? 'NA', v.n ?? 'NA'].join('\t')));
    return [`# summary: ${what}`, 'group\tsource\tvalue\tlo95\thi95\tn', ...rows].join('\n');
  }
  return [`# summary: ${what}`, 'group\tvalue\tlo95\thi95\tn', ...values.map(v => [v.title, v.value ?? 'NA', v.lo ?? 'NA', v.hi ?? 'NA', v.n ?? 'NA'].join('\t'))].join('\n');
}

/** Bootstrap work budget for curve summaries (units × values × resamples): beyond it the resamples are reduced (min 200). */
export const CURVE_BOOT_BUDGET = 2e7;

/** The mean of the drawn curve (finishProfile: smoothing, blank bins, marks per bp, relative) over the window's bins;
 *  blank bins don't count; null when every bin in the window is blank. */
export function curveWindowMean(raw: RawProfile, finish: ProfileFinishOptions, start: number, from: number | null, to: number | null): number | null {
  const vals = finishProfile(raw, finish);
  let sum = 0, k = 0;
  for (let i = 0; i < vals.length; i++) {
    const x = start + i * finish.binBp;
    if ((from != null && x + finish.binBp <= from) || (to != null && x >= to)) continue;
    const v = vals[i];
    if (v != null && Number.isFinite(v)) { sum += v; k++; }
  }
  return k ? sum / k : null;
}

/** Resamples for a curve bootstrap of `units` units with `width` values each (CURVE_BOOT_BUDGET). */
export const curveResamples = (resamples: number, units: number, width: number): number =>
  Math.min(resamples, Math.max(200, Math.floor(CURVE_BOOT_BUDGET / Math.max(1, units * width))));

/** Resampled curves: each unit's per-bin coverage and signal (sides laid end to end), drawn with the same Poisson
 *  draws as every other summary, then each resample's sides rebuilt as raw profiles and handed to `stat`. */
function curveBootstrap(sides: SummaryUnit[][], n: number, resamples: number, seed: number,
  stat: (raws: RawProfile[]) => number | null): { ci: [number, number] | null; used: number } {
  const width = 2 * n * sides.length;
  // A read's coverage and signal are runs of equal values (it covers a stretch; calls fill bins): each unit is kept as
  // run-length segments, added per resample through a difference array (cost per segment, not per bin).
  const units = sides.flatMap((us, si) => us.map(u => {
    const seg: number[] = [];   // start, end, value triples over the laid-out axis
    const runs = (get: (i: number) => number, base: number) => {
      let i = 0;
      while (i < n) {
        const v = get(i);
        let e = i + 1;
        while (e < n && get(e) === v) e++;
        if (v) seg.push(base + i, base + e, v);
        i = e;
      }
    };
    runs(i => u.cov[i] ?? 0, si * 2 * n);
    runs(i => u.sig[i] ?? 0, si * 2 * n + n);
    return { id: u.id, seg: Float64Array.from(seg) };
  }));
  const nseg = units.reduce((a, u) => a + u.seg.length / 3, 0);
  // Per resample: its segments, the prefix sums, and finishing the curves (smoothing ~40 operations per bin).
  const B = curveResamples(resamples, 1, nseg + width * 40);
  const D = new Float64Array(B * (width + 1));
  for (const u of units) {
    if (!u.seg.length) continue;
    const w = poissonWeights(seed, u.id, B);
    for (let b = 0; b < B; b++) {
      const k = w[b];
      if (!k) continue;
      const off = b * (width + 1);
      for (let j = 0; j < u.seg.length; j += 3) { const kv = k * u.seg[j + 2]; D[off + u.seg[j]] += kv; D[off + u.seg[j + 1]] -= kv; }
    }
  }
  const vals: number[] = [];
  const row = new Float64Array(width);
  for (let b = 0; b < B; b++) {
    const off = b * (width + 1);
    let acc = 0;
    for (let x = 0; x < width; x++) { acc += D[off + x]; row[x] = Math.abs(acc) < 1e-9 ? 0 : acc; }
    const raws = sides.map((_, si) => ({ group: '', nReads: 0, coverage: row.slice(si * 2 * n, si * 2 * n + n), signal: row.slice(si * 2 * n + n, si * 2 * n + 2 * n) }) as RawProfile);
    const x = stat(raws);
    if (x != null && Number.isFinite(x)) vals.push(x);
  }
  return { ci: percentileInterval(vals), used: B };
}

/** The summary values of profile groups (metaprofile: window mean; histogram: band share), in group order, with the
 *  interval the settings resolve to (bootstrap over the groups' units when they have them). */
export function profileSummary(groups: Array<{ id: string; title: string; color?: string; raw: RawProfile; units?: SummaryUnit[]; source?: string; base?: string; baseTitle?: string; sourceLabel?: string }>,
  o: { histogram: boolean; start: number; binBp: number; sizeMin: number; s: SummarySettings; seed: number; countWeighting?: boolean;
    /** The profile's scale: fraction (Σ signal / Σ coverage), count (signal per bin), relative (the window over the whole axis). */
    normalization?: 'fraction' | 'count' | 'relative'; from?: number | null; to?: number | null;
    /** Mark profiles: 'fraction' is marks per read per bp (each value over binBp), as the profile drawn. */
    marksPerBp?: boolean;
    /** How the curve is drawn (statistic 'curve'): its smoothing, blank bins, normalisation and bin width. */
    finish?: ProfileFinishOptions }): SummaryValue[] {
  const kind: SummaryKind = o.histogram ? 'band-share' : 'window-mean';
  const norm = o.histogram ? 'fraction' : o.normalization ?? 'fraction';
  const method = resolveCi(kind, o.s, o.countWeighting ?? true, norm);
  const from = o.from !== undefined ? o.from : o.s.from, to = o.to !== undefined ? o.to : o.s.to;
  return groups.map(g => {
    if (o.histogram) {
      const base = bandShare(g.raw, o.sizeMin, o.binBp, o.s.sizeFrom, o.s.sizeTo, method === 'wilson');
      let lo = base.lo, hi = base.hi;
      if (method === 'bootstrap') {
        const ci = g.units?.length ? bootstrapRatio(g.units.map(u => ({ id: u.id, ...unitBand(u, o.sizeMin, o.binBp, o.s.sizeFrom, o.s.sizeTo) })), o.s.resamples, o.seed) : null;
        lo = ci ? ci[0] : null; hi = ci ? ci[1] : null;
      }
      return { id: g.id, title: g.title, ...(g.color ? { color: g.color } : {}), ...base, lo, hi, ...seriesOf(g) };
    }
    if (o.finish && o.s.statistic !== 'pooled') {
      // The drawn curve's mean over the window (a bar equals the curve); Wilson is for pooled shares, so none here.
      const value = curveWindowMean(g.raw, o.finish, o.start, from, to);
      let lo: number | null = null, hi: number | null = null, used: number | undefined;
      if (method === 'bootstrap' && g.units?.length && value != null) {
        const r = curveBootstrap([g.units], g.raw.coverage.length, o.s.resamples, o.seed, ([raw]) => curveWindowMean(raw, o.finish!, o.start, from, to));
        lo = r.ci ? r.ci[0] : null; hi = r.ci ? r.ci[1] : null; used = r.used;
      }
      const n = windowMean(g.raw, o.start, o.binBp, from, to, false).n;
      return { id: g.id, title: g.title, ...(g.color ? { color: g.color } : {}), value, lo, hi, n, ...(used != null && used < o.s.resamples ? { resamplesUsed: used } : {}), ...seriesOf(g) };
    }
    const base = windowMean(g.raw, o.start, o.binBp, from, to, method === 'wilson');
    const bins = binsOf(g.raw.coverage.length, o.start, o.binBp, from, to);
    let value = base.value;
    if (norm === 'count') value = base.value == null ? null : windowSums(g.raw, o.start, o.binBp, from, to).sig / Math.max(1, bins);
    if (norm === 'relative') {
      const all = windowSums(g.raw, o.start, o.binBp, null, null);
      value = base.value == null || !(all.cov > 0) || !(all.sig > 0) ? null : base.value / (all.sig / all.cov);
    }
    let lo = method === 'wilson' ? base.lo : null, hi = method === 'wilson' ? base.hi : null;
    if (method === 'bootstrap' && g.units?.length) {
      const side = { histogram: false, norm, bins, per: 1 };
      const us = g.units.map(u => ({ id: u.id, v: unitSums(u, side, o, from, to) }));
      const ci = bootstrapSums(us, o.s.resamples, o.seed, S => sideValue(S, 0, side));
      lo = ci ? ci[0] : null; hi = ci ? ci[1] : null;
    }
    const per = o.marksPerBp && norm === 'fraction' ? Math.max(1e-9, o.binBp) : 1;
    const scale = (v: number | null) => (v == null || per === 1 ? v : v / per);
    return { id: g.id, title: g.title, ...(g.color ? { color: g.color } : {}), ...base, value: scale(value), lo: scale(lo), hi: scale(hi), ...seriesOf(g) };
  });
}

/** A combined group's bar placement (several sources): its source and its group. */
function seriesOf(g: { title: string; source?: string; base?: string; baseTitle?: string; sourceLabel?: string }): Partial<SummaryValue> {
  if (!g.source) return {};
  const label = g.sourceLabel ?? (g.baseTitle && g.title.startsWith(`${g.baseTitle} · `) ? g.title.slice(g.baseTitle.length + 3) : g.source);
  return { series: g.source, seriesLabel: label, cluster: g.base ?? g.title, clusterTitle: g.baseTitle ?? g.title };
}

/** One side of a summary as the bootstrap carries it: what its statistic reads from four sums. */
interface SideStat { histogram: boolean; norm: 'fraction' | 'count' | 'relative'; bins: number; per: number }

/** A unit's four sums: [window signal, window coverage, axis signal, axis coverage] (profiles) or [band, total, 0, 0]
 *  (histograms). */
function unitSums(u: SummaryUnit, side: SideStat, o: { start: number; binBp: number; sizeMin: number; s: SummarySettings }, from: number | null, to: number | null): number[] {
  if (side.histogram) { const b = unitBand(u, o.sizeMin, o.binBp, o.s.sizeFrom, o.s.sizeTo); return [b.num, b.den, 0, 0]; }
  const w = unitWindow(u, o.start, o.binBp, from, to), all = unitWindow(u, o.start, o.binBp, null, null);
  return [w.num, w.den, all.num, all.den];
}

/** A side's summary value from its four sums at `off` (the one statistic of the window mean, count, relative mean and
 *  band share), divided by `per` (marks per bp). */
function sideValue(S: ArrayLike<number>, off: number, side: SideStat): number | null {
  const s0 = S[off], s1 = S[off + 1], s2 = S[off + 2], s3 = S[off + 3];
  const v = side.histogram ? (s1 > 0 ? s0 / s1 : null)
    : side.norm === 'count' ? (s1 > 0 ? s0 / Math.max(1, side.bins) : null)   // as profileSummary: none over an uncovered window
      : side.norm === 'relative' ? (s1 > 0 && s3 > 0 && s2 > 0 ? (s0 / s1) / (s2 / s3) : null)
        : (s1 > 0 ? s0 / s1 : null);
  return v == null ? null : v / side.per;
}

export type SummaryCompareOp = 'diff' | 'log2ratio';

/** A comparison as a summary pairs it: the groups pooled on each side ("rest" and "all": several; "all": A among them). */
export interface SummaryPair { id: string; label: string; a: string[]; b: string[];
  /** Several sources: the pair's source, its colour and name, and the comparison it belongs to. */
  source?: string; sourceColor?: string; sourceLabel?: string; facet?: string; facetLabel?: string }

/** A − B, or log2(A / B) (null unless both are positive). */
export function compareValues(op: SummaryCompareOp, a: number | null, b: number | null): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (op === 'diff') return a - b;
  return a > 0 && b > 0 ? Math.log2(a / b) : null;
}

/** The interval a comparison's summary uses: a seeded bootstrap (Wilson is for one group's share, not a difference). */
export const resolveCompareCi = (s: SummarySettings): 'bootstrap' | 'none' => (s.ci === 'none' || s.ci === 'wilson' ? 'none' : 'bootstrap');

type ProfileSummaryGroup = { id: string; title: string; color?: string; raw: RawProfile; units?: SummaryUnit[]; source?: string; base?: string; baseTitle?: string };
type ProfileSummaryOptions = Parameters<typeof profileSummary>[1];

/** The summary of each comparison: each side summarised as profileSummary does (the pooled window mean, count,
 *  relative mean or band share), then A − B or log2(A / B); the interval is the seeded Poisson bootstrap of that
 *  difference, A's and B's units resampled in one pass (a unit on both sides, a shared read or BED region or A within
 *  "all", gets the same draws: paired). */
export function compareSummary(groups: ProfileSummaryGroup[], pairs: SummaryPair[], o: ProfileSummaryOptions & { op: SummaryCompareOp }): SummaryValue[] {
  const byId = new Map(groups.map(g => [g.id, g]));
  const norm = o.histogram ? 'fraction' : o.normalization ?? 'fraction';
  const from = o.from !== undefined ? o.from : o.s.from, to = o.to !== undefined ? o.to : o.s.to;
  const n = groups[0]?.raw.coverage.length ?? 0;
  const side: SideStat = { histogram: o.histogram, norm, bins: binsOf(n, o.start, o.binBp, from, to), per: o.marksPerBp && norm === 'fraction' && !o.histogram ? Math.max(1e-9, o.binBp) : 1 };
  const method = resolveCompareCi(o.s);
  const pool = (ids: string[]) => {
    const gs = ids.map(id => byId.get(id)).filter((g): g is ProfileSummaryGroup => !!g);
    return { raw: poolProfiles(gs.map(g => g.raw), ids.join('+')), units: gs.every(g => g.units?.length) ? gs.flatMap(g => g.units!) : [] };
  };
  const one = (raw: RawProfile) => profileSummary([{ id: 'x', title: '', raw }], { ...o, s: { ...o.s, ci: 'none' } })[0].value;
  return pairs.map(p => {
    const A = pool(p.a), B = pool(p.b);
    const value = compareValues(o.op, one(A.raw), one(B.raw));
    let lo: number | null = null, hi: number | null = null;
    if (method === 'bootstrap' && A.units.length && B.units.length && o.finish && o.s.statistic !== 'pooled' && !o.histogram) {
      // Each side's curve mean, both sides from one set of draws (paired), as the values themselves.
      const r = curveBootstrap([A.units, B.units], n, o.s.resamples, o.seed,
        ([a, b]) => compareValues(o.op, curveWindowMean(a, o.finish!, o.start, from, to), curveWindowMean(b, o.finish!, o.start, from, to)));
      lo = r.ci ? r.ci[0] : null; hi = r.ci ? r.ci[1] : null;
    } else if (method === 'bootstrap' && A.units.length && B.units.length) {
      const zero = [0, 0, 0, 0];
      const us = [...A.units.map(u => ({ id: u.id, v: [...unitSums(u, side, o, from, to), ...zero] })), ...B.units.map(u => ({ id: u.id, v: [...zero, ...unitSums(u, side, o, from, to)] }))];
      const ci = bootstrapSums(us, o.s.resamples, o.seed, S => compareValues(o.op, sideValue(S, 0, side), sideValue(S, 4, side)));
      lo = ci ? ci[0] : null; hi = ci ? ci[1] : null;
    }
    return { id: p.id, title: p.label, value, lo, hi, n: null,
      ...(p.source ? { series: p.source, seriesLabel: p.sourceLabel ?? p.source, cluster: p.facet ?? p.id, clusterTitle: p.facetLabel ?? p.label, ...(p.sourceColor ? { color: p.sourceColor } : {}) } : {}) };
  });
}

/** The interval line of a comparison summary's header (never silent about a missing interval). */
export function compareSummaryCi(groups: Array<{ units?: SummaryUnit[] }>, s: SummarySettings, seed: number, unitNoun: string): string {
  if (s.ci === 'none') return 'no interval';
  if (s.ci === 'wilson') return 'no interval (Wilson is for one group\'s share, not a difference: pick Bootstrap or Auto)';
  if (!groups.some(g => g.units?.length)) return 'interval not available (the bootstrap needs per-unit values, not kept for this plot)';
  return `${ciText('bootstrap', s, seed, unitNoun, false)}, A and B resampled together`;
}

/** A comparison summary as drawn: one value per comparison (the figure's pairs, in its order), its header, the 0
 *  reference line and the constant-by-construction note (as profileSummaryView). */
export function compareSummaryView(groups: ProfileSummaryGroup[], pairs: SummaryPair[],
  o: { histogram: boolean; start: number; binBp: number; sizeMin: number; s: SummarySettings; seed: number; countWeighting?: boolean;
    normalization: 'fraction' | 'count' | 'relative'; anchored: boolean; unitNoun: string; what: string; marksPerBp?: boolean; op: SummaryCompareOp;
    finish?: ProfileFinishOptions }) {
  const n = groups[0]?.raw.coverage.length ?? 0;
  const end = o.start + n * o.binBp;
  const norm = o.histogram ? 'fraction' : o.normalization;
  const relative = !o.histogram && norm === 'relative';
  const win = o.histogram ? { from: o.s.from, to: o.s.to, isDefault: false } : summaryWindow(o.s, { normalised: relative, anchored: o.anchored, start: o.start, end });
  const note = relative && coversAxis(win.from, win.to, o.start, end)
    ? 'Each value is relative to its mean across the whole window, so the whole-window mean is 1 by construction on both sides; pick a window (Summary › Window).' : null;
  const values = compareSummary(groups, pairs, { ...o, normalization: norm, from: win.from, to: win.to });
  const ci = compareSummaryCi(groups, o.s, o.seed, o.unitNoun);
  const sEff = { ...o.s, from: win.from, to: win.to };
  const opText = o.op === 'diff' ? 'A − B' : 'log2(A / B)';
  const scale = relative ? ' (relative to the window, 1 = average)' : norm === 'count' ? ' (count per bin)' : '';
  const curve = !o.histogram && !!o.finish && o.s.statistic !== 'pooled';
  const head = o.histogram ? `the share of ${sEff.sizeFrom}–${sEff.sizeTo} bp` : `the ${curve ? 'curve\'s mean' : o.finish ? 'pooled mean' : 'mean'}${scale} over ${windowText(sEff.from, sEff.to, win.isDefault)}`;
  const measures = `${opText} of ${head}, one value per comparison; ${ci}. Of: ${o.what}`;
  return { values, measures, note, reference: 0, window: o.histogram ? `${sEff.sizeFrom}–${sEff.sizeTo} bp` : windowShort(sEff.from, sEff.to, win.isDefault, o.anchored) };
}

const fmtX = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(v));
const windowText = (from: number | null, to: number | null, isDefault: boolean) =>
  (from == null && to == null ? 'the whole axis' : `${from == null ? '−∞' : fmtX(from)} to ${to == null ? '+∞' : fmtX(to)}${isDefault ? ' (the default centre window)' : ''}`);

/** "centre ±100 bp", "the whole axis", "1,000 to 2,000": the summary window in a few words (the state line). */
export function windowShort(from: number | null, to: number | null, isDefault: boolean, anchored: boolean): string {
  if (from == null && to == null) return 'the whole axis';
  if (from != null && to != null && from === -to && (anchored || isDefault)) return `centre ±${fmtX(to)} bp`;
  if (isDefault && from != null && to != null) return `centre ${fmtX(from)}–${fmtX(to)}`;
  return `${from == null ? '−∞' : fmtX(from)} to ${to == null ? '+∞' : fmtX(to)}`;
}

/** The bins of [from, to) among n bins from start. */
function binsOf(n: number, start: number, binBp: number, from: number | null, to: number | null): number {
  let k = 0;
  for (let i = 0; i < n; i++) { const x = start + i * binBp; if ((from != null && x + binBp <= from) || (to != null && x >= to)) continue; k++; }
  return k;
}

function windowSums(raw: RawProfile, start: number, binBp: number, from: number | null, to: number | null): { sig: number; cov: number } {
  let sig = 0, cov = 0;
  for (let i = 0; i < raw.coverage.length; i++) {
    const x = start + i * binBp;
    if ((from != null && x + binBp <= from) || (to != null && x >= to)) continue;
    sig += raw.signal[i]; cov += raw.coverage[i];
  }
  return { sig, cov };
}

/** The interval line of a profile summary's header: the method, or that it is not available (a bootstrap needs the
 *  per-unit values, which this plot did not keep): never silent. */
export function profileSummaryCi(groups: Array<{ units?: SummaryUnit[] }>, o: { histogram: boolean; s: SummarySettings; seed: number; countWeighting?: boolean; unitNoun?: string; normalization?: 'fraction' | 'count' | 'relative' }): string {
  const kind: SummaryKind = o.histogram ? 'band-share' : 'window-mean';
  const method = resolveCi(kind, o.s, o.countWeighting ?? true, o.histogram ? 'fraction' : o.normalization ?? 'fraction');
  if (method === 'bootstrap' && !groups.some(g => g.units?.length)) return 'interval not available (the bootstrap needs per-unit values, not kept for this plot)';
  return ciText(method, o.s, o.seed, o.unitNoun ?? 'reads', o.histogram && (o.countWeighting ?? true), kind);
}

/** "Share of 0–90 bp per group, groups in panel order; bootstrap 95% (…). Of: …": what a summary measures. */
export function summaryMeasures(kind: SummaryKind, s: SummarySettings, what: string, ci?: string, o: { scale?: string; isDefault?: boolean; statistic?: 'curve' | 'pooled' } = {}): string {
  const fmtX = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(v));
  const where = s.from == null && s.to == null ? 'the whole axis' : `${s.from == null ? '−∞' : fmtX(s.from)} to ${s.to == null ? '+∞' : fmtX(s.to)}${o.isDefault ? ' (the default centre window)' : ''}`;
  const scale = o.scale ? ` (${o.scale})` : '';
  const how = o.statistic === 'curve' ? ' of the curve' : o.statistic === 'pooled' ? ' (pooled: Σ signal / Σ coverage)' : '';
  const head = kind === 'band-share' ? `Share of ${s.sizeFrom}–${s.sizeTo} bp per group` : kind === 'window-mean' ? `Mean${how}${scale} over ${where} per group` : `Mean${scale} of ${s.sizeFrom}–${s.sizeTo} bp × ${where} per group`;
  const method = resolveCi(kind, s);
  const interval = ci ?? (method === 'none' ? 'no interval' : method === 'wilson' ? ciText('wilson', s, 0, 'reads', kind === 'band-share', kind)
    : 'interval not available (the bootstrap needs per-unit values, not kept for this plot)');
  return `${head}, groups in panel order; ${interval}. Of: ${what}`;
}

/** A profile summary as drawn: its values, header, reference line and (constant by construction) note. The window
 *  defaults to the centre when the profile is relative to its window (its whole-window mean is 1 by construction). */
export function profileSummaryView(groups: Array<{ id: string; title: string; color?: string; raw: RawProfile; units?: SummaryUnit[]; source?: string; base?: string; baseTitle?: string }>,
  o: { histogram: boolean; start: number; binBp: number; sizeMin: number; s: SummarySettings; seed: number; countWeighting?: boolean;
    normalization: 'fraction' | 'count' | 'relative'; anchored: boolean; unitNoun: string; what: string; marksPerBp?: boolean;
    finish?: ProfileFinishOptions }) {
  const n = groups[0]?.raw.coverage.length ?? 0;
  const end = o.start + n * o.binBp;
  const norm = o.histogram ? 'fraction' : o.normalization;
  const relative = !o.histogram && norm === 'relative';
  const win = o.histogram ? { from: o.s.from, to: o.s.to, isDefault: false } : summaryWindow(o.s, { normalised: relative, anchored: o.anchored, start: o.start, end });
  const sEff = { ...o.s, from: win.from, to: win.to };
  const note = relative && coversAxis(win.from, win.to, o.start, end)
    ? 'Each value is relative to its mean across the whole window, so the whole-window mean is 1 by construction; pick a window (Summary › Window).' : null;
  const values = profileSummary(groups, { ...o, normalization: norm, from: win.from, to: win.to });
  const ci = profileSummaryCi(groups, { histogram: o.histogram, s: o.s, seed: o.seed, countWeighting: o.countWeighting, unitNoun: o.unitNoun, normalization: norm });
  const curve = !o.histogram && !!o.finish && o.s.statistic !== 'pooled';
  const capped = values.reduce((m, v) => (v.resamplesUsed != null ? Math.min(m, v.resamplesUsed) : m), Infinity);
  const measures = summaryMeasures(o.histogram ? 'band-share' : 'window-mean', sEff, o.what,
    ci + (Number.isFinite(capped) ? ` (capped at ${capped.toLocaleString('en-US')} resamples: a wide window)` : ''),
    { scale: relative ? 'relative to the window, 1 = average' : norm === 'count' ? 'count per bin' : undefined, isDefault: win.isDefault,
      ...(o.histogram ? {} : { statistic: curve ? 'curve' as const : 'pooled' as const }) });
  return { values, measures, note, reference: relative ? 1 : 0 };
}

/** A size plot's box summary settings: the window (the centre by default for normalised plots), the scale (log2
 *  enrichment, log1p counts, or the values), the reference line, and the note when the box is constant. */
export function boxSummarySpec(size: { normalization: string; log: boolean; sizeMin: number; sizeMax: number }, s: SummarySettings,
  axis: { start: number; end: number; anchored: boolean }) {
  const normalised = size.normalization !== 'raw';
  const win = summaryWindow(s, { normalised, anchored: axis.anchored, start: axis.start, end: axis.end });
  const transform = boxTransformOf(size);
  const note = constantBoxNote(size.normalization, s, win, { start: axis.start, end: axis.end, sizeMin: size.sizeMin, sizeMax: size.sizeMax }, transform === 'log2');
  const reference = transform === 'none' && normalised ? 1 : 0;
  const scale = transform === 'log2' ? 'log2 enrichment, 0 = average' : transform === 'log1p' ? 'log1p counts' : normalised ? 'enrichment, 1 = average' : undefined;
  return { win, transform, note, reference, scale, sEff: { ...s, from: win.from, to: win.to } };
}
