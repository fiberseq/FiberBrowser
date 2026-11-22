/**
 * The quantification engine (pure): measures × groups -> values, intervals, enrichment, the comparison with a
 * reference group, and a test of equal shares across groups. One method for every measure: a group's value is
 * Σ num / Σ den over its units (windowMaths), so reads weigh by what they cover and pooling is exact.
 *
 * Intervals (95%):
 * - shares of reads: Wilson on k members of n evaluated reads (exact for counts);
 * - everything else: the seeded Poisson bootstrap over reads (summary.bootstrapDraws: the Plots summaries' method,
 *   seed handling and draws). A read keeps the same draws in its group, the baseline and the reference, so the
 *   intervals of an enrichment or a difference resample them jointly;
 * - group-level series: none (no per-read values).
 * Enrichment is the ratio of the group's sums to the baseline's sums over the same bounds (not a mean of per-bin ratios).
 */
import { benjaminiHochberg, equalSharesTest, wilsonInterval } from '../../utils/statistics';
import { percentileInterval } from '../../utils/stableSample';
import { bootstrapDraws, cachedPoissonWeights, type BootstrapWeights } from '../plots/summary';
import type { EnrichmentBaseline } from '../../utils/plotSetYScale';
import type { BinnedUnit, MeasureData, MeasureDef } from './measures';
import { unitParts } from './measures';
import type { QuantSpec } from './spec';
import { UNIT_COLS } from './windowMaths';

/** Which reads a group holds: per dataset, all its reads (cluster null) or one cluster of a panel. */
export interface GroupMatch { dataset: string; panelKey: string; cluster: number | null }

export interface QuantGroupDef {
  id: string;
  title: string;
  color?: string;
  /** The dataset when the group is within one (null: pooled across datasets). */
  dataset: string | null;
  match: GroupMatch[];
}

export type Assignments = Record<string, Record<string, number> | undefined>;

export function isMember(g: QuantGroupDef, dataset: string, read: string, assignments: Assignments): boolean {
  for (const m of g.match) {
    if (m.dataset !== dataset) continue;
    if (m.cluster == null) return true;
    const a = assignments[m.panelKey];
    // As the read panel finds a read's cluster (readFilter.clusterAssignmentForRead): its id, then without a segment suffix.
    if (a && (a[read] ?? a[read.replace(/_\d+$/, '')]) === m.cluster) return true;
  }
  return false;
}

/**
 * The reads behind one cell (measure × group), for the link back to the reads: a share's members; otherwise the group's
 * reads that cover the bounds. Curve units (a layer read from the panel's profile pool) keep a read only when it
 * covers a bin inside the bounds, so their reads are the binned units.
 */
export function cellReads(data: MeasureData | undefined, kind: MeasureDef['kind'], g: QuantGroupDef, assignments: Assignments): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!data) return out;
  const take = (key: string) => {
    const { dataset, read } = unitParts(key);
    if (isMember(g, dataset, read, assignments)) (out[dataset] ??= []).push(read);
  };
  if (data.units) for (const [key, v] of data.units) if (kind === 'share' ? v[0] > 0 : v[1] > 0) take(key);
  if (data.binned) for (const [key, u] of data.binned.units) if (u.cov.some(c => c > 0)) take(key);
  return out;
}

export interface GroupPanel { key: string; datasetId: string; label: string; datasetLabel?: string; color?: string }

/** The groups of a comparison, in panel order (clusters in the cluster list's order). */
export function buildGroups(comparison: QuantSpec['comparison'], o: {
  panels: GroupPanel[]; clusterPanels: GroupPanel[]; visible: Array<{ cluster: number; color: string }>; clusterLabel: (c: number) => string;
}): QuantGroupDef[] {
  const datasetsOf = (ps: GroupPanel[]) => {
    const seen = new Set<string>();
    return ps.filter(p => (seen.has(p.datasetId) ? false : (seen.add(p.datasetId), true)));
  };
  if (comparison === 'datasets' || comparison === 'pools') {
    return datasetsOf(o.panels).map(p => ({ id: `ds:${p.datasetId}`, title: p.datasetLabel ?? p.label, color: p.color, dataset: p.datasetId,
      match: [{ dataset: p.datasetId, panelKey: p.key, cluster: null }] }));
  }
  const cps = o.clusterPanels;
  if (!cps.length || !o.visible.length) return [];
  if (comparison === 'clusters-datasets' || cps.length === 1) {
    // Split panels of one dataset keep their own labels (allele, carriers), so their groups are told apart.
    const shared = new Set(cps.filter((p, i) => cps.findIndex(q => q.datasetId === p.datasetId) !== i).map(p => p.datasetId));
    const name = (p: GroupPanel) => (shared.has(p.datasetId) ? p.label : p.datasetLabel ?? p.label);
    return cps.flatMap(p => o.visible.map(c => ({ id: `${p.key}|${c.cluster}`, title: `${cps.length > 1 ? `${name(p)} · ` : ''}${o.clusterLabel(c.cluster)}`,
      color: c.color, dataset: p.datasetId, match: [{ dataset: p.datasetId, panelKey: p.key, cluster: c.cluster }] })));
  }
  // Clusters pooled across the clustered datasets (one clustering shares its ids across panels).
  return o.visible.map(c => ({ id: `cl:${c.cluster}`, title: o.clusterLabel(c.cluster), color: c.color, dataset: null,
    match: cps.map(p => ({ dataset: p.datasetId, panelKey: p.key, cluster: c.cluster })) }));
}

export type CiMethod = 'bootstrap' | 'wilson' | 'none';

export function ciMethodFor(def: Pick<MeasureDef, 'kind'>, ci: QuantSpec['ci']): CiMethod {
  if (def.kind === 'group') return 'none';
  if (ci === 'none') return 'none';
  if (ci === 'wilson') return def.kind === 'share' ? 'wilson' : 'none';
  if (ci === 'bootstrap') return 'bootstrap';
  return def.kind === 'share' ? 'wilson' : 'bootstrap';
}

/** The baseline a measure is enriched over: auto = the y-scale's baseline for layers, the pooled share otherwise;
 *  flank and dataset need a windowed per-read layer (others fall back to the region). */
export function baselineFor(def: Pick<MeasureDef, 'kind' | 'windowed'>, spec: Pick<QuantSpec, 'baseline'>, yScaleBaseline: EnrichmentBaseline = 'region'): Exclude<QuantSpec['baseline'], 'auto'> {
  const layer = def.kind === 'fraction' || def.kind === 'rate' || def.kind === 'ratio';
  const b = spec.baseline === 'auto' ? (layer ? yScaleBaseline : 'pooled') : spec.baseline;
  if ((b === 'flank' || b === 'dataset') && !(layer && def.windowed)) return 'region';
  return b;
}

export const BASELINE_WORDS: Record<Exclude<QuantSpec['baseline'], 'auto'>, string> = {
  pooled: 'the groups shown, pooled', rest: 'the other groups (rest)', reference: 'the reference group',
  region: 'all reads in the dataset (region)', flank: 'own flank mean', dataset: 'dataset mean over the view',
};

export interface QuantCell {
  measure: string;
  group: string;
  /** On the measure's displayed scale (fraction, per kb, bp for area, share, value). */
  value: number | null;
  lo: number | null;
  hi: number | null;
  /** Reads (units) with a value in the bounds. */
  n: number | null;
  /** Shares: members. */
  k: number | null;
  low: boolean;
  method: CiMethod;
  enrich: number | null;
  enrichLo: number | null;
  enrichHi: number | null;
  /** Versus the reference group (difference or log2 ratio of the values). */
  cmp: number | null;
  cmpLo: number | null;
  cmpHi: number | null;
}

export interface QuantMeasureInfo { id: string; label: string; kind: MeasureDef['kind']; unit: string; source: string; color?: string;
  enrichment: boolean; windowed: boolean; note?: string; baseline: string | null; method: CiMethod;
  /** Curve units (the drawn curve's bins and mean) or exact bp. */
  units?: 'curve' | 'exact';
  /** Resamples used when fewer than asked (the curve-unit bootstrap over a wide window is capped; said in the header). */
  resamplesUsed?: number }

export interface QuantTest { stat: number; df: number; p: number; q: number | null; method: 'chi2' | 'g' }

export interface QuantResult {
  cells: QuantCell[];
  groups: Array<{ id: string; title: string; color?: string; dataset: string | null }>;
  measures: QuantMeasureInfo[];
  tests: Record<string, QuantTest | null>;
  reference: string | null;
  boundsBp: number;
  seed: number;
  resamples: number;
}

export interface QuantInput {
  spec: QuantSpec;
  measures: Array<{ def: MeasureDef; data: MeasureData }>;
  groups: QuantGroupDef[];
  assignments: Assignments;
  boundsBp: number;
  seed: number;
  yScaleBaseline?: EnrichmentBaseline;
  weights?: BootstrapWeights;
}

/** The scale factor of the displayed value: per kb for marks, × bounds bp for an area. */
export function valueScale(def: Pick<MeasureDef, 'kind'>, spec: Pick<QuantSpec, 'stat'>, boundsBp: number): number {
  if (def.kind === 'rate') return spec.stat === 'area' ? boundsBp : 1000;
  if (def.kind === 'fraction' && spec.stat === 'area') return boundsBp;
  return 1;
}

export function enrichForm(ratio: number | null, form: QuantSpec['form']): number | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (form === 'percent') return ratio * 100;
  if (form === 'log2') return ratio > 0 ? Math.log2(ratio) : null;
  return ratio;
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export function computeQuant(input: QuantInput): QuantResult {
  const { spec, groups, assignments, boundsBp, seed } = input;
  const B = spec.resamples;
  const weights = input.weights ?? new Map();
  const refId = spec.reference && groups.some(g => g.id === spec.reference) ? spec.reference : groups[0]?.id ?? null;
  const cells: QuantCell[] = [];
  const tests: Record<string, QuantTest | null> = {};
  const infos: QuantMeasureInfo[] = [];
  const datasets = [...new Set(groups.flatMap(g => g.match.map(m => m.dataset)))];

  for (const { def, data } of input.measures) {
    const method = ciMethodFor(def, spec.ci);
    const enrichOn = spec.value === 'enrichment' && def.enrichment && def.kind !== 'group';
    const base = enrichOn ? baselineFor(def, spec, input.yScaleBaseline) : null;
    infos.push({ id: def.id, label: def.label, kind: def.kind, unit: def.unit, source: def.source, color: def.color, enrichment: def.enrichment,
      windowed: def.windowed, note: def.note, baseline: base, method });
    const scale = valueScale(def, spec, boundsBp);

    if (data.binned) {
      const info = infos[infos.length - 1];
      info.units = 'curve';
      // Flank and dataset need every bin of the view (loaded when one of them is in use); without them, region.
      if ((base === 'flank' || base === 'dataset') && !data.binned.res) info.baseline = 'region';
      const used = binnedMeasure(def, data.binned, { ...input, base: info.baseline as Exclude<QuantSpec['baseline'], 'auto'> | null, method, enrichOn, scale, refId, datasets, cells, weights });
      if (used < B) info.resamplesUsed = used;
      tests[def.id] = null;
      continue;
    }
    if (def.kind === 'fraction' || def.kind === 'rate') infos[infos.length - 1].units = 'exact';

    if (def.kind === 'group') {
      const vals = groups.map(g => {
        const xs = g.match.map(m => data.groupValues?.[`${m.panelKey}|${m.cluster ?? 'all'}`]).filter((x): x is number => x != null && Number.isFinite(x));
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      });
      const refV = refId ? vals[groups.findIndex(g => g.id === refId)] : null;
      groups.forEach((g, i) => {
        const v = vals[i];
        const cmp = spec.compare === 'off' || v == null || refV == null ? null : spec.compare === 'diff' ? v - refV : v > 0 && refV > 0 ? Math.log2(v / refV) : null;
        cells.push({ measure: def.id, group: g.id, value: v, lo: null, hi: null, n: null, k: null, low: false, method: 'none', enrich: null, enrichLo: null, enrichHi: null, cmp, cmpLo: null, cmpHi: null });
      });
      tests[def.id] = null;
      continue;
    }

    // Units per group and per dataset (all its reads: the region and dataset baselines).
    const units = data.units ?? new Map();
    const byGroup: Array<Array<{ id: string; v: number[] }>> = groups.map(() => []);
    const byDataset = new Map<string, Array<{ id: string; v: number[] }>>(datasets.map(d => [d, []]));
    for (const [key, v] of units) {
      const { dataset, read } = unitParts(key);
      const u = { id: key, v: v as unknown as number[] };
      byDataset.get(dataset)?.push(u);
      groups.forEach((g, i) => { if (isMember(g, dataset, read, assignments)) byGroup[i].push(u); });
    }
    const totals = (list: Array<{ v: number[] }>) => {
      const t = new Float64Array(UNIT_COLS);
      for (const u of list) for (let j = 0; j < UNIT_COLS; j++) t[j] += u.v[j];
      return t;
    };
    const T = byGroup.map(totals);
    const Td = new Map([...byDataset].map(([d, l]) => [d, totals(l)]));
    const nOf = (list: Array<{ v: number[] }>) => list.reduce((a, u) => a + (u.v[1] > 0 ? 1 : 0), 0);
    const pooled = (src: Float64Array[]) => { const t = new Float64Array(src[0]?.length ?? UNIT_COLS); for (const s of src) for (let j = 0; j < t.length; j++) t[j] += s[j]; return t; };
    const Tall = pooled(T);
    const refIdx = refId ? groups.findIndex(g => g.id === refId) : -1;

    // Baseline sums (num, den) of group i from per-group sums X (full or one resample) and per-dataset sums.
    const baseOf = (i: number, X: (j: number) => ArrayLike<number>, all: ArrayLike<number>, Dx: (d: string) => ArrayLike<number> | undefined): [number, number] | null => {
      const g = groups[i];
      const own = X(i);
      const dsSum = (c0: number) => {
        let n = 0, d = 0;
        for (const ds of new Set(g.match.map(m => m.dataset))) { const s = Dx(ds); if (s) { n += s[c0]; d += s[c0 + 1]; } }
        return [n, d] as [number, number];
      };
      switch (base) {
        case 'pooled': return [all[0], all[1]];
        case 'rest': return [all[0] - own[0], all[1] - own[1]];
        case 'reference': { if (refIdx < 0) return null; const r = X(refIdx); return [r[0], r[1]]; }
        case 'region': return dsSum(0);
        case 'flank': return [own[2], own[3]];
        case 'dataset': return dsSum(4);
        default: return null;
      }
    };

    const needBoot = method === 'bootstrap' || enrichOn || spec.compare !== 'off';
    let S: Float64Array[] = [];
    let Sd = new Map<string, Float64Array>();
    let Sall: Float64Array | null = null;
    if (needBoot && B > 0) {
      S = byGroup.map(list => (list.length ? bootstrapDraws(list, B, seed, weights) : new Float64Array(B * UNIT_COLS)));
      if (base === 'region' || base === 'dataset') Sd = new Map([...byDataset].map(([d, l]) => [d, l.length ? bootstrapDraws(l, B, seed, weights) : new Float64Array(B * UNIT_COLS)]));
      Sall = pooled(S);
    }
    const row = (A: Float64Array, b: number) => A.subarray(b * UNIT_COLS, b * UNIT_COLS + UNIT_COLS);

    const values = T.map(t => { const r = ratio(t[0], t[1]); return r == null ? null : r * scale; });
    const refValue = refIdx >= 0 ? values[refIdx] : null;
    const cmpOf = (v: number | null, r: number | null) => (v == null || r == null ? null : spec.compare === 'diff' ? v - r : v > 0 && r > 0 ? Math.log2(v / r) : null);

    groups.forEach((g, i) => {
      const t = T[i];
      const n = nOf(byGroup[i]);
      const value = values[i];
      let lo: number | null = null, hi: number | null = null;
      if (value != null && method === 'wilson') {
        const w = wilsonInterval(t[0], t[1]);
        lo = w.low * scale; hi = w.high * scale;
      }
      const vb: number[] = [], eb: number[] = [], cb: number[] = [];
      let enrich: number | null = null;
      if (enrichOn) {
        const bs = baseOf(i, j => T[j], Tall, d => Td.get(d));
        enrich = bs && value != null ? enrichForm(ratio(t[0], t[1])! / (ratio(bs[0], bs[1]) ?? NaN), spec.form) : null;
      }
      if (S.length && Sall) {
        for (let b = 0; b < B; b++) {
          const x = row(S[i], b);
          const r = ratio(x[0], x[1]);
          if (r == null) continue;
          vb.push(r * scale);
          if (enrichOn) {
            const bs = baseOf(i, j => row(S[j], b), row(Sall, b), d => { const s = Sd.get(d); return s ? row(s, b) : undefined; });
            const br = bs ? ratio(bs[0], bs[1]) : null;
            const e = br ? enrichForm(r / br, spec.form) : null;
            if (e != null) eb.push(e);
          }
          if (spec.compare !== 'off' && refIdx >= 0 && refIdx !== i) {
            const rx = row(S[refIdx], b);
            const rr = ratio(rx[0], rx[1]);
            const c = cmpOf(r * scale, rr == null ? null : rr * scale);
            if (c != null) cb.push(c);
          }
        }
        if (method === 'bootstrap' && value != null) { const ci = percentileInterval(vb); if (ci) { lo = ci[0]; hi = ci[1]; } }
      }
      const eci = enrichOn && method !== 'none' && enrich != null ? percentileInterval(eb) : null;
      const cmp = spec.compare === 'off' ? null : refIdx === i ? (value == null ? null : spec.compare === 'diff' ? 0 : 0) : cmpOf(value, refValue);
      const cci = spec.compare !== 'off' && refIdx !== i && cmp != null && method !== 'none' ? percentileInterval(cb) : null;
      cells.push({ measure: def.id, group: g.id, value, lo, hi, n, k: def.kind === 'share' ? t[0] : null, low: n < spec.minReads, method,
        enrich, enrichLo: eci ? eci[0] : null, enrichHi: eci ? eci[1] : null, cmp, cmpLo: cci ? cci[0] : null, cmpHi: cci ? cci[1] : null });
    });

    if (def.kind === 'share' && spec.test !== 'off') {
      const rows = groups.map((_, i) => ({ k: T[i][0], n: T[i][1], ok: nOf(byGroup[i]) >= spec.minReads })).filter(r => r.ok);
      const t = equalSharesTest(rows, spec.test);
      tests[def.id] = t ? { ...t, q: null, method: spec.test } : null;
    } else tests[def.id] = null;
  }

  // One p-value per measure; adjusted across the measures tested (BH) when asked.
  const tested = Object.entries(tests).filter((e): e is [string, QuantTest] => e[1] != null);
  if (tested.length) {
    const q = spec.adjust === 'bh' ? benjaminiHochberg(tested.map(([, t]) => t.p)) : tested.map(([, t]) => t.p);
    tested.forEach(([id, t], i) => { tests[id] = { ...t, q: q[i] }; });
  }

  return { cells, groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color, dataset: g.dataset })), measures: infos, tests, reference: refId, boundsBp, seed, resamples: B };
}

export const cellOf = (r: QuantResult, measure: string, group: string): QuantCell | undefined => r.cells.find(c => c.measure === measure && c.group === group);

/** The number a cell shows: the comparison when on, else enrichment when on for the measure, else the value. */
export function shownOf(c: QuantCell, spec: Pick<QuantSpec, 'compare' | 'value'>, m: Pick<QuantMeasureInfo, 'baseline'>): { v: number | null; lo: number | null; hi: number | null; what: 'cmp' | 'enrich' | 'value' } {
  if (spec.compare !== 'off') return { v: c.cmp, lo: c.cmpLo, hi: c.cmpHi, what: 'cmp' };
  if (spec.value === 'enrichment' && m.baseline) return { v: c.enrich, lo: c.enrichLo, hi: c.enrichHi, what: 'enrich' };
  return { v: c.value, lo: c.lo, hi: c.hi, what: 'value' };
}

/** Groups and measures in the order asked: panel order; groups by their (mean) shown value or enrichment, high first;
 *  measures by their spread across groups (max − min of the shown value, widest first). */
export function quantOrder(r: QuantResult, spec: Pick<QuantSpec, 'sort' | 'compare' | 'value'>): { groups: string[]; measures: string[] } {
  const groups = r.groups.map(g => g.id), measures = r.measures.map(m => m.id);
  if (spec.sort === 'panel') return { groups, measures };
  const info = new Map(r.measures.map(m => [m.id, m]));
  const shown = (c: QuantCell) => shownOf(c, spec, info.get(c.measure)!).v;
  if (spec.sort === 'spread') {
    const spread = (m: string) => {
      const xs = r.cells.filter(c => c.measure === m && !c.low).map(shown).filter((x): x is number => x != null);
      return xs.length ? Math.max(...xs) - Math.min(...xs) : -Infinity;
    };
    return { groups, measures: [...measures].sort((a, b) => spread(b) - spread(a)) };
  }
  const key = (g: string) => {
    const xs = r.cells.filter(c => c.group === g).map(c => (spec.sort === 'enrichment' ? c.enrich : c.value)).filter((x): x is number => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : -Infinity;
  };
  return { groups: [...groups].sort((a, b) => key(b) - key(a)), measures };
}

const fmt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 'NA' : String(+v.toPrecision(6)));

/** The result as TSV: one row per measure × group, with n, the value, its interval, enrichment, the comparison and the test. */
export function quantTsv(r: QuantResult, header: string[]): string {
  const g = new Map(r.groups.map(x => [x.id, x])), m = new Map(r.measures.map(x => [x.id, x]));
  const lines = header.map(h => `# ${h}`);
  lines.push(['measure', 'source', 'unit', 'group', 'n_reads', 'members', 'value', 'lo95', 'hi95', 'interval', 'enrichment', 'enrich_lo95', 'enrich_hi95', 'vs_reference', 'vs_ref_lo95', 'vs_ref_hi95', 'few_reads', 'test_p', 'test_q'].join('\t'));
  for (const c of r.cells) {
    const mi = m.get(c.measure)!, t = r.tests[c.measure];
    lines.push([mi.label, mi.source, mi.unit, g.get(c.group)?.title ?? c.group, c.n ?? 'NA', c.k ?? 'NA', fmt(c.value), fmt(c.lo), fmt(c.hi), c.method,
      fmt(c.enrich), fmt(c.enrichLo), fmt(c.enrichHi), fmt(c.cmp), fmt(c.cmpLo), fmt(c.cmpHi), c.low ? 'yes' : 'no', fmt(t?.p), fmt(t?.q)].join('\t'));
  }
  return lines.join('\n');
}


/** Bootstrap work budget for curve units (units × bins × resamples): beyond it the resamples are reduced (min 200). */
export const BINNED_BOOT_BUDGET = 6e7;

/**
 * A measure in curve units: the group's per-bin sums over the bounds' bins, the value the curve's window mean
 * (Σ w_b · S_b / C_b over Σ w_b, an uncovered bin counting 0 as the curve draws it). Baselines (pooled, rest,
 * reference, region) are curve means of their own reads; the bootstrap resamples reads jointly as elsewhere.
 * Returns the resamples used.
 */
function binnedMeasure(def: MeasureDef, bd: NonNullable<MeasureData['binned']>, o: QuantInput & {
  base: Exclude<QuantSpec['baseline'], 'auto'> | null; method: CiMethod; enrichOn: boolean; scale: number; refId: string | null; datasets: string[];
  cells: QuantCell[]; weights: BootstrapWeights;
}): number {
  const { spec, groups, assignments, seed } = o;
  const nb = bd.weights.length;
  const W = bd.weights;
  const wsum = W.reduce((a, b) => a + b, 0) || 1;
  const members: Array<Array<[string, BinnedUnit]>> = groups.map(() => []);
  const byDs = new Map<string, Array<[string, BinnedUnit]>>(o.datasets.map(d => [d, []]));
  let nnz = 0;
  for (const [key, u] of bd.units) {
    const { dataset, read } = unitParts(key);
    byDs.get(dataset)?.push([key, u]);
    groups.forEach((g, i) => { if (isMember(g, dataset, read, assignments)) { members[i].push([key, u]); nnz += u.idx.length; } });
  }
  // Flank and dataset baselines (y-scale definitions): the mean of the curve over the view's flank bins (own reads) or
  // over every bin of the view (the dataset's reads), an uncovered bin counting 0 as the curve draws it.
  const R = bd.res ?? 0;
  const viewBase = R > 0 && (o.base === 'flank' || o.base === 'dataset');
  const flank = bd.flank ?? new Int32Array(0);
  const fullSums = (list: Array<[string, BinnedUnit]>) => {
    const S = new Float64Array(R), C = new Float64Array(R);
    for (const [, u] of list) if (u.all) for (let j = 0; j < u.all.idx.length; j++) { S[u.all.idx[j]] += u.all.sig[j]; C[u.all.idx[j]] += u.all.cov[j]; }
    return { S, C };
  };
  const binsMean = (S: ArrayLike<number>, C: ArrayLike<number>, bins: ArrayLike<number> | null, off = 0) => {
    let m = 0, any = false;
    const n = bins ? bins.length : R;
    for (let k = 0; k < n; k++) { const b = bins ? bins[k] : k; const c = C[off + b]; if (c > 0) { any = true; m += S[off + b] / c; } }
    return any && n ? m / n : null;
  };
  let nnzView = 0;
  if (viewBase) for (const list of (o.base === 'flank' ? members : [...byDs.values()])) for (const [, u] of list) nnzView += u.all?.idx.length ?? 0;
  const Fg = viewBase && o.base === 'flank' ? members.map(fullSums) : [];
  const Fd = viewBase && o.base === 'dataset' ? new Map([...byDs].map(([d, l]) => [d, fullSums(l)])) : new Map<string, { S: Float64Array; C: Float64Array }>();
  const dsFull = (i: number, F: (d: string) => { S: Float64Array; C: Float64Array } | undefined, off = 0) => {
    const S = new Float64Array(R), C = new Float64Array(R);
    for (const ds of new Set(groups[i].match.map(m => m.dataset))) { const d = F(ds); if (d) for (let b = 0; b < R; b++) { S[b] += d.S[off + b]; C[b] += d.C[off + b]; } }
    return binsMean(S, C, null);
  };
  const sums = (list: Array<[string, BinnedUnit]>) => {
    const S = new Float64Array(nb), C = new Float64Array(nb);
    for (const [, u] of list) for (let j = 0; j < u.idx.length; j++) { S[u.idx[j]] += u.sig[j]; C[u.idx[j]] += u.cov[j]; }
    return { S, C };
  };
  const meanOf = (S: ArrayLike<number>, C: ArrayLike<number>, off = 0) => {
    let m = 0, any = false;
    for (let b = 0; b < nb; b++) { const c = C[off + b]; if (c > 0) { any = true; m += W[b] * (S[off + b] / c); } }
    return any ? m / wsum : null;
  };
  const T = members.map(sums);
  const Td = new Map([...byDs].map(([d, l]) => [d, sums(l)]));
  const add = (xs: Array<{ S: Float64Array; C: Float64Array }>) => { const S = new Float64Array(xs[0]?.S.length ?? 0), C = new Float64Array(S.length); for (const x of xs) for (let k = 0; k < S.length; k++) { S[k] += x.S[k]; C[k] += x.C[k]; } return { S, C }; };
  const pooled = add(T);
  const refIdx = o.refId ? groups.findIndex(g => g.id === o.refId) : -1;
  const baseOf = (i: number, X: (j: number) => { S: Float64Array; C: Float64Array }, all: { S: Float64Array; C: Float64Array }, D: (d: string) => { S: Float64Array; C: Float64Array } | undefined, off = 0,
    V?: { g: (j: number) => { S: Float64Array; C: Float64Array }; d: (ds: string) => { S: Float64Array; C: Float64Array } | undefined; off: number }): number | null => {
    if (viewBase && o.base === 'flank') { const v = V ? V.g(i) : Fg[i]; return binsMean(v.S, v.C, flank, V ? V.off : 0); }
    if (viewBase && o.base === 'dataset') return dsFull(i, V ? V.d : d => Fd.get(d), V ? V.off : 0);
    const own = X(i);
    if (o.base === 'pooled') return meanOf(all.S, all.C, off);
    if (o.base === 'rest') { const S = new Float64Array(nb), C = new Float64Array(nb); for (let b = 0; b < nb; b++) { S[b] = all.S[off + b] - own.S[off + b]; C[b] = all.C[off + b] - own.C[off + b]; } return meanOf(S, C); }
    if (o.base === 'reference') { if (refIdx < 0) return null; const r = X(refIdx); return meanOf(r.S, r.C, off); }
    if (o.base === 'region') {
      const S = new Float64Array(nb), C = new Float64Array(nb);
      for (const ds of new Set(groups[i].match.map(m => m.dataset))) { const d = D(ds); if (d) for (let b = 0; b < nb; b++) { S[b] += d.S[off + b]; C[b] += d.C[off + b]; } }
      return meanOf(S, C);
    }
    return null;
  };
  const values = T.map(t => { const m = meanOf(t.S, t.C); return m == null ? null : m * o.scale; });
  const refValue = refIdx >= 0 ? values[refIdx] : null;
  const cmpOf = (v: number | null, r: number | null) => (v == null || r == null ? null : spec.compare === 'diff' ? v - r : v > 0 && r > 0 ? Math.log2(v / r) : null);
  const needBoot = o.method === 'bootstrap';
  const B = needBoot ? Math.min(spec.resamples, Math.max(200, Math.floor(BINNED_BOOT_BUDGET / Math.max(1, nnz + (o.enrichOn ? nnzView : 0))))) : 0;
  // Per group: resampled bin sums, [b * nb + bin] (the same draws per read as everywhere: cachedPoissonWeights).
  const draws = (list: Array<[string, BinnedUnit]>) => {
    const S = new Float64Array(B * nb), C = new Float64Array(B * nb);
    for (const [key, u] of list) {
      const w = cachedPoissonWeights(o.weights, seed, key, B);
      for (let b = 0; b < B; b++) { const k = w[b]; if (!k) continue; const off = b * nb; for (let j = 0; j < u.idx.length; j++) { S[off + u.idx[j]] += k * u.sig[j]; C[off + u.idx[j]] += k * u.cov[j]; } }
    }
    return { S, C };
  };
  const D = B ? members.map(draws) : [];
  const Dd = B && o.base === 'region' ? new Map([...byDs].map(([d, l]) => [d, draws(l)])) : new Map<string, { S: Float64Array; C: Float64Array }>();
  const Dall = B ? add(D) : null;
  // Resampled full-view sums for the flank (per group) or dataset (per dataset) baseline: [b * R + bin].
  const fullDraws = (list: Array<[string, BinnedUnit]>) => {
    const S = new Float64Array(B * R), C = new Float64Array(B * R);
    for (const [key, u] of list) {
      if (!u.all) continue;
      const w = cachedPoissonWeights(o.weights, seed, key, B);
      for (let b = 0; b < B; b++) { const k = w[b]; if (!k) continue; const off = b * R; for (let j = 0; j < u.all.idx.length; j++) { S[off + u.all.idx[j]] += k * u.all.sig[j]; C[off + u.all.idx[j]] += k * u.all.cov[j]; } }
    }
    return { S, C };
  };
  const VG = B && o.enrichOn && viewBase && o.base === 'flank' ? members.map(fullDraws) : [];
  const VD = B && o.enrichOn && viewBase && o.base === 'dataset' ? new Map([...byDs].map(([d, l]) => [d, fullDraws(l)])) : new Map<string, { S: Float64Array; C: Float64Array }>();
  groups.forEach((g, i) => {
    const value = values[i];
    const n = members[i].reduce((a, [, u]) => a + (u.idx.length ? 1 : 0), 0);
    let enrich: number | null = null;
    if (o.enrichOn && value != null) { const bv = baseOf(i, j => T[j], pooled, d => Td.get(d)); enrich = bv ? enrichForm(value / o.scale / bv, spec.form) : null; }
    const vb: number[] = [], eb: number[] = [], cb: number[] = [];
    for (let b = 0; b < B && Dall; b++) {
      const off = b * nb;
      const m = meanOf(D[i].S, D[i].C, off);
      if (m == null) continue;
      vb.push(m * o.scale);
      if (o.enrichOn) { const bv = baseOf(i, j => D[j], Dall, d => Dd.get(d), off, { g: j => VG[j], d: ds => VD.get(ds), off: b * R }); const e = bv ? enrichForm(m / bv, spec.form) : null; if (e != null) eb.push(e); }
      if (spec.compare !== 'off' && refIdx >= 0 && refIdx !== i) { const r = meanOf(D[refIdx].S, D[refIdx].C, off); const c = cmpOf(m * o.scale, r == null ? null : r * o.scale); if (c != null) cb.push(c); }
    }
    const ci = o.method === 'bootstrap' && value != null ? percentileInterval(vb) : null;
    // Interval none: no whiskers for enrichment or the comparison either (as in exact bp).
    const eci = o.enrichOn && o.method !== 'none' && enrich != null ? percentileInterval(eb) : null;
    const cmp = spec.compare === 'off' ? null : refIdx === i ? (value == null ? null : 0) : cmpOf(value, refValue);
    const cci = spec.compare !== 'off' && refIdx !== i && cmp != null && o.method !== 'none' ? percentileInterval(cb) : null;
    o.cells.push({ measure: def.id, group: g.id, value, lo: ci ? ci[0] : null, hi: ci ? ci[1] : null, n, k: null, low: n < spec.minReads, method: o.method,
      enrich, enrichLo: eci ? eci[0] : null, enrichHi: eci ? eci[1] : null, cmp, cmpLo: cci ? cci[0] : null, cmpHi: cci ? cci[1] : null });
  });
  return B;
}
