/**
 * Y scaling for a set of small comparable plots (the cluster metaprofiles first; any panel that draws one chart per
 * cluster / dataset / class can use it).
 *
 * Two orthogonal choices:
 * - scale: 'perPlot' (each plot autoscales to its own range, for visibility; today's look) or 'shared' (the plots of
 *   one channel use one y range, so heights compare directly). Shared ranges are per dataset by default
 *   (`scope: 'dataset'`) or across every dataset on show (`scope: 'all'`); `shareChannels` also puts channels that
 *   have the same unit (e.g. every layer fraction) on one range.
 * - value: 'raw' (the plotted quantity, e.g. the fraction of molecules with the layer at each position) or
 *   'enrichment' relative to a baseline: the pooled profile of every read in the region across clusters (per
 *   position, the default), the plot's own flank mean (a scalar), or the dataset's mean level in the view (a scalar).
 *   Enrichment is drawn as a percentage (100% = baseline, the default), a ratio (1 = baseline) or log2 (0 = baseline).
 *
 * A baseline that is zero, missing, or below `minBaselineFraction` of its own maximum leaves a gap (never a division
 * by zero). Series from fewer than `smallReads` reads are drawn but don't set a shared range, so one tiny cluster's
 * noise can't flatten every other plot.
 *
 * Pure functions only (unit-tested in plotSetYScale.test.ts); the hook and the control live in
 * components/charts/PlotSetYScaleControl.tsx.
 */

export type YScaleMode = 'perPlot' | 'shared';
export type YValueMode = 'raw' | 'enrichment';
export type EnrichmentBaseline = 'region' | 'flank' | 'dataset';
export type EnrichmentForm = 'percent' | 'ratio' | 'log2';
export type SharedScope = 'dataset' | 'all';

export interface PlotSetYScale {
  mode: YScaleMode;
  value: YValueMode;
  baseline: EnrichmentBaseline;
  form: EnrichmentForm;
  scope: SharedScope;
  /** Shared mode: channels with the same unit share one range too (off: one range per channel). */
  shareChannels: boolean;
  /** 'flank' baseline: the fraction of the plot at each end that makes up the flank (0.02–0.45). */
  flankFraction: number;
  /** Positions whose baseline is below this fraction of the baseline's maximum are gaps (0 = only exact zeros). */
  minBaselineFraction: number;
  /** Series from fewer reads than this are drawn but don't set a shared range (0 = every series counts). */
  smallReads: number;
}

export const DEFAULT_PLOT_SET_Y_SCALE: PlotSetYScale = Object.freeze({
  mode: 'perPlot',
  value: 'raw',
  baseline: 'region',
  form: 'percent',
  scope: 'dataset',
  shareChannels: false,
  flankFraction: 0.1,
  minBaselineFraction: 0.01,
  smallReads: 5,
}) as PlotSetYScale;

const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  (typeof v === 'string' && (options as readonly string[]).includes(v) ? v as T : fallback);
const numberIn = (v: unknown, lo: number, hi: number, fallback: number): number =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** A stored value as settings: anything missing or malformed takes the default (older sessions load as defaults). */
export function normalizePlotSetYScale(raw: unknown): PlotSetYScale {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PLOT_SET_Y_SCALE;
  return {
    mode: oneOf(r.mode, ['perPlot', 'shared'] as const, d.mode),
    value: oneOf(r.value, ['raw', 'enrichment'] as const, d.value),
    baseline: oneOf(r.baseline, ['region', 'flank', 'dataset'] as const, d.baseline),
    form: oneOf(r.form, ['percent', 'ratio', 'log2'] as const, d.form),
    scope: oneOf(r.scope, ['dataset', 'all'] as const, d.scope),
    shareChannels: typeof r.shareChannels === 'boolean' ? r.shareChannels : d.shareChannels,
    flankFraction: numberIn(r.flankFraction, 0.02, 0.45, d.flankFraction),
    minBaselineFraction: numberIn(r.minBaselineFraction, 0, 0.5, d.minBaselineFraction),
    smallReads: Math.round(numberIn(r.smallReads, 0, 1000, d.smallReads)),
  };
}

export function isDefaultPlotSetYScale(s: PlotSetYScale): boolean {
  const d = DEFAULT_PLOT_SET_Y_SCALE;
  return (Object.keys(d) as (keyof PlotSetYScale)[]).every(k => s[k] === d[k]);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The mean of the finite values (null when there are none). */
export function meanOf(data: readonly number[]): number | null {
  let sum = 0, n = 0;
  for (const v of data) if (finite(v)) { sum += v; n++; }
  return n ? sum / n : null;
}

/** The mean of the outer `fraction` of the plot at each end (at least one position per end). */
export function flankMean(data: readonly number[], fraction: number): number | null {
  const n = data.length;
  if (!n) return null;
  const k = Math.max(1, Math.min(Math.floor(n / 2), Math.round(n * fraction)));
  return meanOf([...data.slice(0, k), ...data.slice(n - k)]);
}

/**
 * The read-weighted mean profile of several profiles, per position (the region baseline: every read in the region
 * across clusters). Weights are read counts; non-finite values don't count; a position nobody measured is NaN.
 */
export function pooledProfile(profiles: ReadonlyArray<{ data: readonly number[]; weight: number }>): number[] {
  const used = profiles.filter(p => p.data.length > 0 && p.weight > 0);
  if (!used.length) return [];
  const len = Math.max(...used.map(p => p.data.length));
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    let sum = 0, w = 0;
    for (const p of used) {
      const v = p.data[i];
      if (finite(v)) { sum += v * p.weight; w += p.weight; }
    }
    out[i] = w > 0 ? sum / w : NaN;
  }
  return out;
}

export interface Enriched {
  values: number[];
  /** Positions left as gaps because the baseline was zero, missing or too small there. */
  gaps: number;
  /** The baseline was empty or zero everywhere: nothing could be drawn. */
  emptyBaseline: boolean;
}

/**
 * A profile relative to a baseline (per position, or one scalar), as a percentage, a ratio or log2. A baseline
 * position that is non-finite, <= 0 or below `minBaselineFraction` × the baseline's maximum is a gap (NaN); a zero
 * signal over a valid baseline is 0% / ratio 0 / a log2 gap (log2 of 0 is undefined).
 */
export function enrichProfile(
  data: readonly number[],
  baseline: readonly number[] | number | null | undefined,
  form: EnrichmentForm,
  minBaselineFraction = 0,
): Enriched {
  const n = data.length;
  const at = typeof baseline === 'number' || baseline == null
    ? () => (baseline as number | null | undefined)
    : (i: number) => (baseline as readonly number[])[i];
  let baseMax = 0;
  if (Array.isArray(baseline)) { for (const v of baseline) if (finite(v) && v > baseMax) baseMax = v; }
  else if (finite(baseline)) baseMax = baseline as number;
  const floor = Math.max(0, minBaselineFraction) * baseMax;
  const values = new Array<number>(n);
  let gaps = 0, drawn = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    const b = at(i);
    if (!finite(v)) { values[i] = NaN; continue; }
    if (!finite(b) || b <= 0 || b < floor) { values[i] = NaN; gaps++; continue; }
    const ratio = v / b;
    values[i] = form === 'percent' ? ratio * 100 : form === 'ratio' ? ratio : (ratio > 0 ? Math.log2(ratio) : NaN);
    if (Number.isFinite(values[i])) drawn++;
  }
  return { values, gaps, emptyBaseline: n > 0 && !(baseMax > 0) && drawn === 0 };
}

/** The value of the baseline itself in an enrichment form (where its reference line goes). */
export function baselineReference(form: EnrichmentForm): number {
  return form === 'percent' ? 100 : form === 'ratio' ? 1 : 0;
}

export interface YDomain { min: number; max: number }

/** One plot of a set: its values (one array per series), the dataset it belongs to, the channel and its unit. */
export interface PlotSetMember {
  id: string;
  dataset: string;
  channel: string;
  /** The unit its values are in (channels with the same unit can share a range with `shareChannels`). */
  unit: string;
  series: ReadonlyArray<{ values: readonly number[]; reads?: number }>;
}

/** The domain one set of values needs: always holds 0 (as the charts draw today), signed when values go negative. */
export function domainOf(valuesList: ReadonlyArray<readonly number[]>): YDomain {
  let max = 0, min = 0;
  for (const values of valuesList) for (const v of values) {
    if (!finite(v)) continue;
    if (v > max) max = v;
    if (v < min) min = v;
  }
  if (!(max > 0) && !(min < 0)) max = 1;
  return { min, max };
}

/** The key of the shared range a plot belongs to. */
export function sharedGroupKey(member: Pick<PlotSetMember, 'dataset' | 'channel' | 'unit'>, s: Pick<PlotSetYScale, 'scope' | 'shareChannels'>): string {
  const what = s.shareChannels ? `unit:${member.unit}` : `channel:${member.channel}`;
  return s.scope === 'all' ? what : `${member.dataset}\u0000${what}`;
}

export interface PlotSetDomains {
  /** Each plot's y domain (per plot: its own; shared: its group's). */
  byId: Record<string, YDomain>;
  /** Shared mode: the plots each range is shared by (group key -> ids). */
  groups: Record<string, string[]>;
}

/**
 * The y domain each plot of a set is drawn with. Per plot: each plot's own range. Shared: one range per channel (or
 * unit) per dataset (or across all), from the series with at least `smallReads` reads (every series when none has).
 */
export function plotSetDomains(members: readonly PlotSetMember[], s: Pick<PlotSetYScale, 'mode' | 'scope' | 'shareChannels' | 'smallReads'>): PlotSetDomains {
  const counted = (m: PlotSetMember) => {
    const big = m.series.filter(x => x.reads == null || x.reads >= s.smallReads);
    return (big.length ? big : m.series).map(x => x.values);
  };
  const byId: Record<string, YDomain> = {};
  const groups: Record<string, string[]> = {};
  if (s.mode === 'perPlot') {
    for (const m of members) byId[m.id] = domainOf(m.series.map(x => x.values));
    return { byId, groups };
  }
  const values: Record<string, (readonly number[])[]> = {};
  for (const m of members) {
    const key = sharedGroupKey(m, s);
    (groups[key] ??= []).push(m.id);
    (values[key] ??= []).push(...counted(m));
  }
  for (const [key, ids] of Object.entries(groups)) {
    const d = domainOf(values[key]);
    for (const id of ids) byId[id] = d;
  }
  return { byId, groups };
}

const BASELINE_LABEL: Record<EnrichmentBaseline, string> = {
  region: 'region baseline',
  flank: 'own flank mean',
  dataset: 'dataset mean',
};

/** The y-axis title for a value mode: the raw label, or e.g. "% of region baseline". */
export function valueAxisLabel(s: Pick<PlotSetYScale, 'value' | 'baseline' | 'form'>, rawLabel: string): string {
  if (s.value !== 'enrichment') return rawLabel;
  const base = BASELINE_LABEL[s.baseline];
  if (s.form === 'percent') return `% of ${base}`;
  if (s.form === 'ratio') return `ratio to ${base}`;
  return `log2 vs ${base}`;
}

/** A one-line summary of the scaling ("Shared y (per dataset) · % of region baseline"). */
export function yScaleSummary(s: PlotSetYScale, rawLabel = 'raw values'): string {
  const scale = s.mode === 'perPlot'
    ? 'Own y per plot'
    : `Shared y (${s.scope === 'all' ? 'all datasets' : 'per dataset'}${s.shareChannels ? ', across channels' : ''})`;
  return `${scale} · ${valueAxisLabel(s, rawLabel)}`;
}

/** A compact number for a y maximum (0.42, 3.1, 250). */
export function formatAxisValue(v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 100) return sign + a.toFixed(0);
  if (a >= 10) return sign + a.toFixed(1);
  if (a >= 0.01) return sign + a.toFixed(2);
  return sign + a.toPrecision(2);
}
