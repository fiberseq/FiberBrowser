/**
 * fiberhmm-qc results as chart data: the per-read deamination (or m6A) rate
 * CDF against the bundled reference with its PASS (IQR) and WARN (5-95%)
 * bands, the nucleosome phasogram with the reference curve, and footprint
 * sizes. Input: <prefix>.qc.json and <prefix>.qc.curves.json
 * (fiberhmm.qc.curves.v1).
 */
import type { QcCurves, QcHistogram } from '../api/pipeline';

export type Point = [number, number];

export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT' | string;

export function verdictTone(status: Verdict | null | undefined): 'ok' | 'warn' | 'error' | 'muted' {
  if (status === 'PASS') return 'ok';
  if (status === 'WARN') return 'warn';
  if (status === 'FAIL') return 'error';
  return 'muted';
}

export function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${(100 * value).toFixed(digits)}%`;
}

function round(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

/** Thin a long point list to at most ``max`` points (keeps the first and last). */
export function thin(points: Point[], max = 400): Point[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: Point[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

export interface RateCdf {
  label: string;
  sample: Point[];
  reference: Point[];
  passBand: [number, number] | null;
  warnBand: [number, number] | null;
  median: number | null;
}

/** Per-read rate CDF in percent (x) vs cumulative fraction (y). */
export function rateCdf(curves: QcCurves | null | undefined): RateCdf | null {
  const signal = curves?.signal_rate;
  if (!signal || !signal.per_read_rates?.length) return null;
  const rates = signal.per_read_rates;
  const ecdf = signal.ecdf?.length === rates.length ? signal.ecdf : rates.map((_, i) => (i + 1) / rates.length);
  const sample = thin(rates.map((r, i) => [100 * r, ecdf[i]] as Point));
  const ref = signal.reference_ecdf;
  const reference = ref && ref.rates?.length === ref.probabilities?.length
    ? ref.rates.map((r, i) => [100 * r, ref.probabilities[i]] as Point) : [];
  const band = (v: number[] | null | undefined): [number, number] | null =>
    v && v.length === 2 ? [100 * v[0], 100 * v[1]] : null;
  const mid = rates.length ? rates[Math.floor((rates.length - 1) / 2)] : null;
  return {
    label: signal.label || 'signal',
    sample,
    reference,
    passBand: band(signal.reference_iqr),
    warnBand: band(signal.warn_interval),
    median: mid === null ? null : 100 * mid,
  };
}

export interface Phasogram {
  sample: Point[];
  reference: Point[];
  nrl: number | null;
}

/** The detrended pair-distance curve over 60-800 bp (the lags fiberhmm-qc plots). */
export function phasogram(curves: QcCurves | null | undefined, from = 60, to = 800): Phasogram | null {
  const ph = curves?.phasogram;
  if (!ph || !ph.detrended_pair_frequency?.length) return null;
  const lags = ph.lags_bp?.length === ph.detrended_pair_frequency.length
    ? ph.lags_bp : ph.detrended_pair_frequency.map((_, i) => i);
  const sample: Point[] = [];
  lags.forEach((lag, i) => { if (lag >= from && lag <= to) sample.push([lag, ph.detrended_pair_frequency[i]]); });
  const reference: Point[] = [];
  if (ph.reference?.lags_bp?.length) {
    ph.reference.lags_bp.forEach((lag, i) => {
      if (lag >= from && lag <= to) reference.push([lag, ph.reference!.detrended_pair_frequency[i]]);
    });
  }
  if (!sample.length) return null;
  return { sample, reference, nrl: ph.nrl_bp ?? null };
}

export interface SizeDistribution {
  sample: Point[];
  reference: Point[];
  n: number;
  overflow: number;
}

/** A footprint-size histogram as a step line of fractions (bin start -> fraction). */
export function sizeDistribution(hist: QcHistogram | null | undefined, maxBp?: number): SizeDistribution | null {
  if (!hist || !hist.bin_edges_bp?.length || !hist.sample_fraction_per_bin?.length) return null;
  const edges = hist.bin_edges_bp;
  const steps = (values: number[] | null | undefined): Point[] => {
    if (!values || values.length !== edges.length - 1) return [];
    const out: Point[] = [];
    values.forEach((v, i) => {
      if (maxBp !== undefined && edges[i] >= maxBp) return;
      out.push([edges[i], v], [edges[i + 1], v]);
    });
    return out;
  };
  return {
    sample: steps(hist.sample_fraction_per_bin),
    reference: steps(hist.reference_fraction_per_bin),
    n: hist.sample_n,
    overflow: hist.sample_overflow ?? 0,
  };
}

export interface Metric {
  label: string;
  value: string;
  title?: string;
}

/** The headline numbers of a fiberhmm-qc JSON. */
export function qcMetrics(qc: Record<string, any> | null | undefined): Metric[] {
  if (!qc) return [];
  const signal = qc.signal ?? {};
  const period = qc.periodicity ?? {};
  const fp = qc.footprints ?? {};
  const dedup = qc.deduplication ?? {};
  const masking = qc.variant_masking ?? {};
  const label = signal.label || 'signal';
  const stateAware = qc.overall?.verdict_basis === 'state-aware';
  const metrics: Metric[] = [
    {
      label: stateAware ? `Overall ${label} (median)` : `Median ${label}`,
      value: percent(signal.median_per_read_rate, 2),
      title: `Per-read ${label} rate; middle half ${percent(signal.q25_per_read_rate, 2)}–${percent(signal.q75_per_read_rate, 2)} (${signal.n_rate_reads ?? '—'} reads).`
        + (stateAware ? ' Counted on every aligned target base, all states together: not used by the verdict, since it mixes enzyme efficiency with how open the chromatin is.' : ''),
    },
    {
      label: 'Nucleosome repeat',
      value: period.nrl_bp ? `${period.nrl_bp} bp` : '—',
      title: `Phasogram autocorrelation ${round(period.autocorrelation_strength, 3)}; reference correlation r = ${round(period.reference_curve_correlation, 2)}; matched amplitude ${round(period.reference_pattern_amplitude_ratio, 2)}×.`,
    },
    {
      label: 'Nucleosome size (median)',
      value: fp.median_nucleosome_bp ? `${Math.round(fp.median_nucleosome_bp)} bp` : '—',
      title: `${fp.n_nucleosomes ?? 0} nucleosome footprints; ${percent(fp.fraction_nucleosome_85_250_bp, 0)} are 85–250 bp.`,
    },
    {
      label: 'TF footprint size (median)',
      value: fp.median_tf_footprint_bp ? `${Math.round(fp.median_tf_footprint_bp)} bp` : '—',
      title: `${fp.n_tf_footprints ?? 0} TF footprints.`,
    },
    {
      label: 'Duplicates',
      value: dedup.duplicate_fraction === null || dedup.duplicate_fraction === undefined ? (dedup.mode === 'not_run' ? 'not run' : '—') : percent(dedup.duplicate_fraction),
      title: dedup.full_run ? 'Whole run (fiberhmm-call duplicate marking).' : (dedup.duplicate_fraction_basis || 'QC sample.'),
    },
    {
      label: 'SNP mask',
      value: masking.applied ? `${masking.n_masked_sites ?? 0} sites` : (masking.note || 'not run'),
      title: 'Recurrent C→T/G→A SNPs masked from deamination calls (DAF SNP screen).',
    },
  ];
  // FiberHMM 3.0 DAF QC: insertion and soft-clip bases carry no evidence (fiberhmm-call masks them).
  const unaligned = qc.unaligned_masking;
  if (unaligned && typeof unaligned === 'object') {
    const fraction = num(unaligned.fraction_unaligned);
    const blocks = num(unaligned.n_reads_with_no_call_blocks);
    metrics.push({
      label: 'Unaligned bases',
      value: fraction === null ? '—' : percent(fraction, 2),
      title: `Inserted and soft-clipped bases of the sampled reads (${num(unaligned.unaligned_bases)?.toLocaleString() ?? '—'} of `
        + `${num(unaligned.query_bases)?.toLocaleString() ?? '—'}): no DAF evidence`
        + (blocks === null ? '' : `; ${blocks.toLocaleString()} reads have uncalled stretches of 50 bp or more`) + '.'
        + (typeof unaligned.note === 'string' ? ` ${unaligned.note}.` : ''),
    });
  }
  return metrics;
}

export interface VerdictItem {
  /** Section key in the QC JSON (overall, efficiency, background, periodicity, signal). */
  key: string;
  label: string;
  status: Verdict | null;
  score: number | null;
  /** False for a component the overall verdict does not use (the overall rate under a state-aware verdict). */
  inVerdict: boolean;
  title?: string;
}

export const STATE_TIPS = {
  efficiency: 'Efficiency: how often the enzyme marked accessible DNA (median per-read rate inside MSPs) — comparable between amplicons and whole-genome data.',
  background: 'Background: how often DNA outside MSPs (nucleosomes, linkers, short gaps) was marked — lower is cleaner.',
  mspShare: 'MSP share: how much of each read is accessible (in MSPs) — describes the sample, not its quality; amplicons at open loci are higher.',
  ratio: 'In-MSP ÷ outside-MSP rate (pooled): signal over background.',
  overallRate: 'Overall rate: every state together — it mixes enzyme efficiency with how open the chromatin is, so it differs between amplicons and whole-genome data.',
  source: 'Where the MSP / nucleosome states used to split the rates came from.',
} as const;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Plain-language list of the components a verdict combines. */
function componentText(names: string[], signalLabel: string): string {
  const words = names.map(n => (n === 'signal' ? `the overall ${signalLabel} rate` : n === 'efficiency' ? 'efficiency' : n === 'background' ? 'background' : n));
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The verdict chips, from a full .qc.json or the flat ``verdicts`` record of an
 * outputs.json / Library entry ({overall: 'PASS', overall_score: 80, verdict_basis, ...}).
 * A state-aware QC (FiberHMM >= 3.0 with state rates) lists Overall, Efficiency,
 * Background, Periodicity, then the overall rate marked as not in the verdict;
 * an older QC lists Overall, the rate and Periodicity as before.
 */
export function verdictItems(input: Record<string, any> | null | undefined, flat = false): VerdictItem[] {
  if (!input) return [];
  const status = (key: string): Verdict | null => (flat ? str(input[key]) : str(input[key]?.status));
  const score = (key: string): number | null => (flat ? num(input[`${key}_score`]) : num(input[key]?.score));
  const has = (key: string) => (flat ? key in input : !!input[key] && typeof input[key] === 'object');
  const signalLabel = (flat ? str((input as any).signal_label) : str(input.signal?.label)) || 'signal';
  const basis = flat ? str(input.verdict_basis) : str(input.overall?.verdict_basis);
  const stateAware = basis === 'state-aware';
  const components: string[] = !flat && Array.isArray(input.overall?.components)
    ? input.overall.components.filter((c: unknown): c is string => typeof c === 'string')
    // A flat record does not list them: an ungraded (INSUFFICIENT) state component is left out
    // when state-aware, as fiberhmm-qc does.
    : stateAware ? ['efficiency', 'background', 'periodicity'].filter(k => k === 'periodicity' || status(k) !== 'INSUFFICIENT') : ['signal', 'periodicity'];
  const used = (key: string) => components.includes(key);
  const overallTitle = basis
    ? `Overall verdict from ${componentText(components, signalLabel)}${stateAware ? ' (state-aware)' : ''}.`
    : undefined;
  const items: VerdictItem[] = [
    { key: 'overall', label: 'Overall', status: status('overall'), score: score('overall'), inVerdict: true, title: overallTitle },
  ];
  if (has('efficiency')) {
    items.push({ key: 'efficiency', label: 'Efficiency', status: status('efficiency'), score: score('efficiency'), inVerdict: stateAware && used('efficiency'), title: STATE_TIPS.efficiency });
  }
  if (has('background')) {
    items.push({ key: 'background', label: 'Background', status: status('background'), score: score('background'), inVerdict: stateAware && used('background'), title: STATE_TIPS.background });
  }
  const signal: VerdictItem = {
    key: 'signal', label: capitalize(signalLabel), status: status('signal'), score: score('signal'),
    inVerdict: !stateAware && used('signal'),
    title: stateAware
      ? `Overall ${signalLabel} rate: reported, not in the verdict — it mixes enzyme efficiency with how open the chromatin is.`
      : undefined,
  };
  const periodicity: VerdictItem = { key: 'periodicity', label: 'Periodicity', status: status('periodicity'), score: score('periodicity'), inVerdict: used('periodicity') };
  if (stateAware) items.push(periodicity, signal);
  else items.push(signal, periodicity);
  return items;
}

export function verdicts(qc: Record<string, any> | null | undefined): { label: string; status: Verdict | null; score: number | null }[] {
  return verdictItems(qc);
}

/** One sentence: what the overall verdict is based on (null for an older QC that does not say). */
export function verdictBasisText(qc: Record<string, any> | null | undefined): string | null {
  const basis = str(qc?.overall?.verdict_basis);
  if (!basis) return null;
  const label = str(qc?.signal?.label) || 'signal';
  const components: string[] = Array.isArray(qc?.overall?.components) ? qc!.overall.components : [];
  if (basis === 'state-aware') {
    return `Verdict from ${componentText(components.length ? components : ['efficiency', 'background', 'periodicity'], label)} (state-aware). `
      + `The overall ${label} rate is shown but not used: it mixes enzyme efficiency with how open the chromatin is.`;
  }
  return `Verdict from ${componentText(components.length ? components : ['signal', 'periodicity'], label)}.`;
}

export interface StateRate {
  /** Median per-read rate in the compartment (fraction). */
  value: number | null;
  /** Pooled events / opportunities, with its nominal 95% interval. */
  pooled: number | null;
  pooledCi: [number, number] | null;
  events: number | null;
  opportunities: number | null;
  reads: number | null;
  q25: number | null;
  q75: number | null;
  referenceMedian: number | null;
  status: Verdict | null;
  score: number | null;
  /** PASS / WARN bounds: efficiency is graded from below (PASS >= pass), background from above (PASS <= pass). */
  pass: number | null;
  warn: number | null;
  direction: 'high' | 'low';
  note: string | null;
}

export interface StateRates {
  available: boolean;
  /** tags | light_call | fibertools_tags | null */
  source: string | null;
  /** Where the states came from, in plain language. */
  sourceText: string;
  minMspBp: number | null;
  efficiency: StateRate;
  background: StateRate;
  ratio: number | null;
  referenceRatio: number | null;
  mspShare: number | null;
  mspShareMedian: number | null;
  referenceMspShareMedian: number | null;
  overallRate: number | null;
  referenceOverallRate: number | null;
  /** Grading notes (why a component was not graded, threshold caps), de-duplicated. */
  notes: string[];
}

function stateSourceText(block: Record<string, any>, sampled: number | null): string {
  const source = str(block.source);
  const reads = block.reads ?? {};
  const fmt = (n: unknown) => (num(n) === null ? '—' : (n as number).toLocaleString('en-US'));
  if (source === 'tags') {
    const producer = block.tag_producer ?? {};
    const by = str(producer.program) ? ` (written by ${producer.program}${str(producer.version) ? ` ${producer.version}` : ''})` : '';
    const withCalls = num(reads.reads_with_calls);
    const of = sampled ?? num(reads.reads_considered);
    const count = withCalls !== null ? ` on ${fmt(withCalls)}${of !== null ? ` of ${fmt(of)}` : ''} sampled reads` : '';
    return `States from the FiberHMM calls in the BAM${count}${by}.`;
  }
  if (source === 'light_call') {
    const light = block.light_call ?? {};
    const stopped = str(light.stopped_by);
    return `The BAM carries no calls: states from a light call (FiberHMM's HMM only, no nucleosome or TF re-call) on ${fmt(light.reads_called)} sampled reads${stopped ? `, stopped by the ${stopped}` : ''}.`;
  }
  if (source === 'fibertools_tags') {
    return "States from fibertools' calls in the BAM (Ma): reported, not graded — the references are FiberHMM calls.";
  }
  return source ? `States from ${source}.` : 'No state source.';
}

/** The state-aware rates of a .qc.json (FiberHMM >= 3.0); null for an older QC without them. */
export function stateRates(qc: Record<string, any> | null | undefined): StateRates | null {
  const block = qc?.state_rates;
  if (!block || typeof block !== 'object') return null;
  const reference = block.reference ?? {};
  const component = (key: 'efficiency' | 'background', compartment: 'msp' | 'outside_msp'): StateRate => {
    const part = block[compartment] ?? {};
    const grade = qc?.[key] ?? {};
    const refQ = reference?.[compartment];
    let refMedian = num(grade.reference_median);
    if (refMedian === null && Array.isArray(refQ?.probabilities) && Array.isArray(refQ?.quantiles)) {
      const i = refQ.probabilities.indexOf(0.5);
      refMedian = i >= 0 ? num(refQ.quantiles[i]) : null;
    }
    const ci = Array.isArray(part.aggregate_rate_wilson95) && part.aggregate_rate_wilson95.length === 2
      && part.aggregate_rate_wilson95.every((v: unknown) => num(v) !== null)
      ? [part.aggregate_rate_wilson95[0], part.aggregate_rate_wilson95[1]] as [number, number] : null;
    return {
      value: num(grade.value) ?? num(part.median_per_read_rate),
      pooled: num(part.aggregate_rate),
      pooledCi: ci,
      events: num(part.n_events),
      opportunities: num(part.n_opportunities),
      reads: num(part.n_rate_reads),
      q25: num(part.q25_per_read_rate),
      q75: num(part.q75_per_read_rate),
      referenceMedian: refMedian,
      status: str(grade.status),
      score: num(grade.score),
      pass: key === 'efficiency' ? num(grade.pass_min) : num(grade.pass_max),
      warn: key === 'efficiency' ? num(grade.warn_min) : num(grade.warn_max),
      direction: key === 'efficiency' ? 'high' : 'low',
      note: str(grade.note),
    };
  };
  const efficiency = component('efficiency', 'msp');
  const background = component('background', 'outside_msp');
  const notes = [efficiency.note, background.note, block.available === false ? str(block.note) : null]
    .filter((n): n is string => !!n)
    .filter((n, i, all) => all.indexOf(n) === i);
  return {
    available: block.available !== false,
    source: str(block.source),
    sourceText: stateSourceText(block, num(qc?.sampling?.sampled_reads)),
    minMspBp: num(block.definition?.min_msp_bp),
    efficiency,
    background,
    ratio: num(block.msp_to_outside_ratio),
    referenceRatio: num(reference?.msp_to_outside_ratio),
    mspShare: num(block.msp_length_fraction),
    mspShareMedian: num(block.median_per_read_msp_length_fraction),
    referenceMspShareMedian: num(reference?.median_per_read_msp_length_fraction),
    overallRate: num(block.all_states?.aggregate_rate),
    referenceOverallRate: num(reference?.all_states_rate),
    notes,
  };
}

/** "PASS ≥ 62.4% · WARN ≥ 55.4%" (or ≤ for background); null when not graded. */
export function bandText(rate: StateRate, digits = 1): string | null {
  if (rate.pass === null || rate.warn === null) return null;
  const op = rate.direction === 'high' ? '≥' : '≤';
  return `PASS ${op} ${percent(rate.pass, digits)} · WARN ${op} ${percent(rate.warn, digits)}`;
}

export function ratioText(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}×`;
}

export interface StateCdf {
  msp: Point[];
  outside: Point[];
  /** The reference per-read quantiles as coarse CDF points (5th-95th percentile). */
  referenceMsp: Point[];
  referenceOutside: Point[];
  xMax: number;
}

/** Per-read in-MSP and outside-MSP rate CDFs in percent from .qc.curves.json ``state_rates``. */
export function stateCdf(curves: QcCurves | null | undefined): StateCdf | null {
  const block = curves?.state_rates;
  if (!block) return null;
  const toCdf = (rates: number[] | null | undefined): Point[] => {
    const values = (rates ?? []).filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
    return thin(values.map((r, i) => [100 * r, (i + 1) / values.length] as Point));
  };
  const toRef = (part: { probabilities?: number[]; quantiles?: number[] | null } | null | undefined): Point[] => {
    if (!Array.isArray(part?.quantiles) || !Array.isArray(part?.probabilities) || part!.quantiles!.length !== part!.probabilities!.length) return [];
    const points: Point[] = [];
    part!.quantiles!.forEach((q, i) => {
      const p = part!.probabilities![i];
      if (num(q) !== null && num(p) !== null) points.push([100 * q, p]);
    });
    return points;
  };
  const msp = toCdf(block.msp_per_read_rates);
  const outside = toCdf(block.outside_msp_per_read_rates);
  if (!msp.length && !outside.length) return null;
  const referenceMsp = toRef(block.reference?.msp);
  const referenceOutside = toRef(block.reference?.outside_msp);
  const all = [...msp, ...outside, ...referenceMsp, ...referenceOutside].map(p => p[0]);
  const xMax = Math.min(100, Math.max(5, Math.ceil(Math.max(...all) / 10) * 10));
  return { msp, outside, referenceMsp, referenceOutside, xMax };
}

/**
 * The state-aware headline of a flat verdicts record (outputs.json ``qc.verdicts`` or a
 * Library entry's): efficiency and background with their rates. Empty for an older QC.
 */
export function stateSummary(flat: Record<string, unknown> | null | undefined, includeStatus = true): Metric[] {
  if (!flat) return [];
  const states = (flat.state_rates && typeof flat.state_rates === 'object' ? flat.state_rates : {}) as Record<string, unknown>;
  const out: Metric[] = [];
  const add = (key: 'efficiency' | 'background', label: string, rate: unknown, title: string) => {
    const status = includeStatus ? str(flat[key]) : null;
    const value = num(rate);
    if (!status && value === null) return;
    out.push({ label, value: [value === null ? null : percent(value), status].filter(Boolean).join(' '), title });
  };
  add('efficiency', 'Efficiency', states.msp_rate ?? flat.msp_rate, STATE_TIPS.efficiency);
  add('background', 'Background', states.outside_msp_rate ?? flat.outside_msp_rate, STATE_TIPS.background);
  return out;
}

/** Tooltip for a QC badge: what the overall verdict is based on. */
export function verdictBasisTitle(flat: Record<string, unknown> | null | undefined): string | undefined {
  if (!str(flat?.verdict_basis)) return undefined;
  // The components an ungraded (INSUFFICIENT) state component is left out of, as fiberhmm-qc does.
  return verdictItems(flat as Record<string, any>, true)[0]?.title;
}
