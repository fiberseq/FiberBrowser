/**
 * Quantify a window: the one spec everything reads (WINDOW_QUANT.md). The user picks three things in one header,
 * in the Plots pattern (type × source × where × group by):
 *
 * 1. Measure(s): ids from the measure registry (measures.ts): read layers, footprint / NFR families, nucleosome
 *    measures; none picked = follow the active layers (as the default metaprofile does).
 * 2. Bounds: the window dragged or typed on a metaprofile (shared by every plot in the set, genomic bp), the whole
 *    region in view, or the sites of a meta-locus pool (each read-site observation a unit, as meta-locus counts).
 * 3. Comparison: clusters, datasets, clusters × datasets, or meta-locus pools; optionally a reference group.
 *
 * Every other choice is a parameter with a default (never asked of the owner). Computation, intervals, the bars /
 * lines / table, Keep to Gallery and the link back to the reads all read this spec; it is saved in sessions
 * (store.ts), and an older session loads with the defaults and no window.
 */
import type { EnrichmentBaseline, EnrichmentForm } from '../../utils/plotSetYScale';
export { isMetaChrom } from '../metaLocus/metaChrom';

/** A window, half-open: genomic bp on one chromosome (the meta contig for a meta-locus), or, `relative`, bp from the
 *  axis anchor signed by its direction (−200..+50 = 200 bp upstream to 50 bp downstream), so it means the same thing
 *  when the view moves or across a meta-locus. */
export interface QuantWindow { chrom: string; from: number; to: number; relative?: boolean }

export type QuantBounds = 'window' | 'region' | 'sites';
export type QuantComparison = 'clusters' | 'datasets' | 'clusters-datasets' | 'pools';
export type QuantValue = 'raw' | 'enrichment';
/** auto: layers take the cluster y-scale's baseline (region by default), shares the pooled share of the groups shown. */
export type QuantBaseline = 'auto' | 'pooled' | 'rest' | 'reference' | EnrichmentBaseline;
export type QuantCompare = 'off' | 'diff' | 'log2ratio';
export type QuantStat = 'mean' | 'area';
export type QuantCi = 'auto' | 'bootstrap' | 'wilson' | 'none';
export type QuantSort = 'panel' | 'value' | 'enrichment' | 'spread';

export interface QuantSpec {
  /** Measure ids (measures.ts); empty: the active layers. */
  measures: string[];
  bounds: QuantBounds;
  comparison: QuantComparison;
  /** The reference group (an id of the result's groups); null: the first group. */
  reference: string | null;
  /** Raw (the measure's own scale) or enrichment over a baseline. */
  value: QuantValue;
  baseline: QuantBaseline;
  form: EnrichmentForm;
  /** Fractions: the mean over the bounds, or the area (mean × bounds bp: expected bp of the layer per read). */
  stat: QuantStat;
  /** Each group against the reference: difference or log2 ratio, with the bootstrap interval. */
  compare: QuantCompare;
  /** auto: Wilson for a share of reads, the seeded bootstrap over reads for everything else. */
  ci: QuantCi;
  resamples: number;
  /** The bootstrap seed; null: the sampling seed. */
  bootSeed: number | null;
  /** Equal shares across groups (shares only): Pearson chi-squared, likelihood-ratio G, or off. */
  test: 'chi2' | 'g' | 'off';
  /** p-values across measures (families): Benjamini-Hochberg, or none. */
  adjust: 'bh' | 'none';
  /** Groups with fewer reads than this are greyed out with their n (never hidden). */
  minReads: number;
  /** Reads per dataset (a seeded sample beyond it: sampling.seed). */
  readCap: number;
  seed: number;
  /** The flank baseline: this fraction of the view at each end. */
  flankFraction: number;
  /** Layers: curve units (the curve's own bins and mean over the bounds: the card equals the curve beside it) or exact
   *  bp (each read's layer bp over its bp in the bounds; short calls read lower than the curve, which counts a call in
   *  every bin it touches). */
  layerUnits: 'curve' | 'exact';
  /** Layers: the reads the panel's curves were computed from (same reads, filters and spans), or a fresh seeded sample
   *  (readCap per dataset). A panel without curves for this view uses the fresh sample. */
  readSource: 'panel' | 'fetch';
  /** Footprint size band (bp, [from, to)) of the size-band measure. */
  sizeFrom: number;
  sizeTo: number;
  chart: 'bar' | 'line';
  view: 'chart' | 'table';
  sort: QuantSort;
}

export const DEFAULT_QUANT_SPEC: QuantSpec = Object.freeze({
  measures: [], bounds: 'window', comparison: 'clusters', reference: null, value: 'raw', baseline: 'auto', form: 'log2',
  stat: 'mean', compare: 'off', ci: 'auto', resamples: 1000, bootSeed: null, test: 'chi2', adjust: 'bh', minReads: 20,
  readCap: 10000, seed: 1, flankFraction: 0.1, layerUnits: 'curve', readSource: 'panel', sizeFrom: 0, sizeTo: 90, chart: 'bar', view: 'chart', sort: 'panel',
}) as QuantSpec;

const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (typeof v === 'string' && (opts as readonly string[]).includes(v) ? v as T : d);
const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d);

export function normalizeQuantSpec(raw: unknown): QuantSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_QUANT_SPEC;
  const ff = typeof r.flankFraction === 'number' && Number.isFinite(r.flankFraction) ? Math.min(0.45, Math.max(0.02, r.flankFraction)) : d.flankFraction;
  return {
    measures: Array.isArray(r.measures) ? [...new Set(r.measures.filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length < 400))].slice(0, 64) : [],
    bounds: pick(r.bounds, ['window', 'region', 'sites'] as const, d.bounds),
    comparison: pick(r.comparison, ['clusters', 'datasets', 'clusters-datasets', 'pools'] as const, d.comparison),
    reference: typeof r.reference === 'string' && r.reference ? r.reference : null,
    value: pick(r.value, ['raw', 'enrichment'] as const, d.value),
    baseline: pick(r.baseline, ['auto', 'pooled', 'rest', 'reference', 'region', 'flank', 'dataset'] as const, d.baseline),
    form: pick(r.form, ['percent', 'ratio', 'log2'] as const, d.form),
    stat: pick(r.stat, ['mean', 'area'] as const, d.stat),
    compare: pick(r.compare, ['off', 'diff', 'log2ratio'] as const, d.compare),
    ci: pick(r.ci, ['auto', 'bootstrap', 'wilson', 'none'] as const, d.ci),
    resamples: int(r.resamples, 50, 10000, d.resamples),
    bootSeed: typeof r.bootSeed === 'number' && Number.isFinite(r.bootSeed) ? Math.round(Math.max(0, r.bootSeed)) : null,
    test: pick(r.test, ['chi2', 'g', 'off'] as const, d.test),
    adjust: pick(r.adjust, ['bh', 'none'] as const, d.adjust),
    minReads: int(r.minReads, 0, 100000, d.minReads),
    readCap: int(r.readCap, 50, 20000, d.readCap),
    seed: int(r.seed, 0, 2 ** 31 - 1, d.seed),
    flankFraction: ff,
    layerUnits: pick(r.layerUnits, ['curve', 'exact'] as const, d.layerUnits),
    readSource: pick(r.readSource, ['panel', 'fetch'] as const, d.readSource),
    ...(() => { const a = int(r.sizeFrom, 0, 100000, d.sizeFrom), b = int(r.sizeTo, 1, 100000, d.sizeTo); return a < b ? { sizeFrom: a, sizeTo: b } : { sizeFrom: d.sizeFrom, sizeTo: d.sizeTo }; })(),
    chart: pick(r.chart, ['bar', 'line'] as const, d.chart),
    view: pick(r.view, ['chart', 'table'] as const, d.view),
    sort: pick(r.sort, ['panel', 'value', 'enrichment', 'spread'] as const, d.sort),
  };
}

export function normalizeQuantWindow(raw: unknown): QuantWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const relative = r.relative === true;
  if (typeof r.chrom !== 'string' || (!r.chrom && !relative)) return null;
  const a = Number(r.from), b = Number(r.to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const from = Math.round(Math.min(a, b)), to = Math.round(Math.max(a, b));
  return to > from ? { chrom: r.chrom, from, to, ...(relative ? { relative: true } : {}) } : null;
}

/** The bounds a quantification uses: the window when one is set on this chromosome and asked for, else the view. */
export function effectiveBounds(spec: Pick<QuantSpec, 'bounds'>, window: QuantWindow | null, view: { chrom: string; start: number; end: number },
  anchor: { pos: number; strand: '+' | '-' } | null = null):
  { from: number; to: number; kind: 'window' | 'region' | 'sites'; windowMissing: boolean } {
  const whole = { from: Math.round(view.start), to: Math.round(view.end) };
  if (spec.bounds === 'sites') return { ...whole, kind: 'sites', windowMissing: false };
  if (spec.bounds === 'region') return { ...whole, kind: 'region', windowMissing: false };
  const g = windowGenomic(window, view.chrom, anchor);
  if (g) {
    const from = Math.max(whole.from, g[0]), to = Math.min(whole.to, g[1]);
    if (to > from) return { from, to, kind: 'window', windowMissing: false };
  }
  return { ...whole, kind: 'region', windowMissing: true };
}

/** "chr19:47,515,000–47,515,300 (300 bp)". */
export function boundsText(chrom: string, from: number, to: number): string {
  return `${chrom}:${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')} (${(to - from).toLocaleString('en-US')} bp)`;
}

/** A window as genomic [from, to) here: a relative window through the anchor (none without one), a genomic one on its
 *  own chromosome only. */
export function windowGenomic(w: QuantWindow | null, chrom: string, anchor: { pos: number; strand: '+' | '-' } | null): [number, number] | null {
  if (!w) return null;
  if (w.relative) {
    if (!anchor) return null;
    const x = anchor.strand === '-' ? anchor.pos - w.from : anchor.pos + w.from, y = anchor.strand === '-' ? anchor.pos - w.to : anchor.pos + w.to;
    return [Math.min(x, y), Math.max(x, y)];
  }
  return w.chrom === chrom ? [w.from, w.to] : null;
}

/** "−200 to +50 bp" for a relative window. */
export function relText(from: number, to: number): string {
  const f = (v: number) => (v > 0 ? `+${v.toLocaleString('en-US')}` : v < 0 ? `−${Math.abs(v).toLocaleString('en-US')}` : '0');
  return `${f(from)} to ${f(to)} bp`;
}
