export const DEFAULT_CONFIDENCE_LEVEL = 0.95;
export const DEFAULT_BOOTSTRAP_RESAMPLES = 1000;

export interface ConfidenceInterval {
  low: number;
  high: number;
  confidenceLevel: number;
  method: string;
  n: number;
  resamples?: number;
}

const NORMAL_975 = 1.959963984540054;

// Peter John Acklam's inverse-normal approximation. The common 95% path uses
// the exact constant above; this keeps the exported confidence-level argument
// honest for callers that request another central interval.
function inverseNormalCDF(probability: number): number {
  const p = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, probability));
  if (Math.abs(p - 0.975) < 1e-12) return NORMAL_975;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lower = 0.02425;
  if (p < lower) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lower) return -inverseNormalCDF(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(
  successes: number,
  total: number,
  confidenceLevel = DEFAULT_CONFIDENCE_LEVEL,
): ConfidenceInterval {
  const n = Math.max(0, Math.floor(total));
  const k = Math.max(0, Math.min(n, successes));
  if (n === 0) {
    return { low: 0, high: 0, confidenceLevel, method: 'Wilson score', n };
  }

  const boundedLevel = Math.max(0.01, Math.min(0.9999, confidenceLevel));
  const z = inverseNormalCDF(0.5 + boundedLevel / 2);
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const halfWidth = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;
  return {
    low: k === 0 ? 0 : Math.max(0, center - halfWidth),
    high: k === n ? 1 : Math.min(1, center + halfWidth),
    confidenceLevel,
    method: 'Wilson score',
    n,
  };
}

/** Wilson interval expressed on the observed count scale. */
export function wilsonCountInterval(
  count: number,
  total: number,
  confidenceLevel = DEFAULT_CONFIDENCE_LEVEL,
): ConfidenceInterval {
  const ci = wilsonInterval(count, total, confidenceLevel);
  return { ...ci, low: ci.low * ci.n, high: ci.high * ci.n };
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = value + Math.imul(value ^ (value >>> 7), 61 | value) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const fraction = position - lower;
  const upper = sorted[Math.min(sorted.length - 1, lower + 1)];
  return sorted[lower] + (upper - sorted[lower]) * fraction;
}

function arithmeticMean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function sampleMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function bootstrapStatisticCI(
  input: number[],
  statistic: (values: number[]) => number,
  options: { seed: string; resamples?: number; confidenceLevel?: number },
): ConfidenceInterval {
  const values = input.filter(Number.isFinite);
  const n = values.length;
  const confidenceLevel = options.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL;
  const resamples = Math.max(1, Math.floor(options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES));
  if (n === 0) {
    return { low: 0, high: 0, confidenceLevel, method: 'read bootstrap percentile', n, resamples };
  }
  if (n === 1) {
    return { low: values[0], high: values[0], confidenceLevel, method: 'read bootstrap percentile', n, resamples };
  }

  const random = mulberry32(hashSeed(options.seed));
  const sampled = new Array<number>(n);
  const estimates = new Array<number>(resamples);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) sampled[i] = values[Math.floor(random() * n)];
    estimates[b] = statistic(sampled);
  }
  estimates.sort((a, b) => a - b);
  const alpha = 1 - confidenceLevel;
  return {
    low: quantile(estimates, alpha / 2),
    high: quantile(estimates, 1 - alpha / 2),
    confidenceLevel,
    method: 'read bootstrap percentile',
    n,
    resamples,
  };
}

export function bootstrapMeanCI(
  values: number[],
  options: { seed: string; resamples?: number; confidenceLevel?: number },
): ConfidenceInterval {
  return bootstrapStatisticCI(values, arithmeticMean, options);
}

export function bootstrapMedianCI(
  values: number[],
  options: { seed: string; resamples?: number; confidenceLevel?: number },
): ConfidenceInterval {
  return bootstrapStatisticCI(values, sampleMedian, options);
}

/** Benjamini-Hochberg adjusted p-values in the same order as the input. */
export function benjaminiHochberg(pValues: number[]): number[] {
  if (pValues.length === 0) return [];
  const indexed = pValues.map((p, index) => ({
    p: Math.max(0, Math.min(1, Number.isFinite(p) ? p : 1)),
    index,
  })).sort((a, b) => a.p - b.p || a.index - b.index);
  const adjusted = new Array<number>(pValues.length);
  let runningMinimum = 1;
  for (let i = indexed.length - 1; i >= 0; i--) {
    const rank = i + 1;
    runningMinimum = Math.min(runningMinimum, (indexed[i].p * indexed.length) / rank);
    adjusted[indexed[i].index] = Math.min(1, runningMinimum);
  }
  return adjusted;
}

// Lanczos approximation, used to keep Fisher's exact test dependency-free in
// the browser while remaining stable for tables containing thousands of reads.
function logGamma(z: number): number {
  const coefficients = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  const shifted = z - 1;
  let x = coefficients[0];
  for (let i = 1; i < coefficients.length; i++) x += coefficients[i] / (shifted + i);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Two-sided Fisher exact p-value for a 2x2 table [a b; c d]. */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  const cells = [a, b, c, d].map(value => Math.max(0, Math.round(value)));
  [a, b, c, d] = cells;
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  if (total === 0) return 1;

  const minA = Math.max(0, col1 - row2);
  const maxA = Math.min(row1, col1);
  const logDenominator = logChoose(total, row1);
  const logProbability = (x: number) => (
    logChoose(col1, x) + logChoose(total - col1, row1 - x) - logDenominator
  );
  const observed = logProbability(a);
  let pValue = 0;
  for (let x = minA; x <= maxA; x++) {
    const candidate = logProbability(x);
    if (candidate <= observed + 1e-12) pValue += Math.exp(candidate);
  }
  if (pValue > 1 - 1e-12) return 1;
  return Math.max(0, Math.min(1, pValue));
}

/** Odds ratio with Haldane-Anscombe correction when any cell is zero. */
export function oddsRatio2x2(a: number, b: number, c: number, d: number): number {
  if ([a, b, c, d].some(value => value === 0)) {
    return ((a + 0.5) * (d + 0.5)) / ((b + 0.5) * (c + 0.5));
  }
  return (a * d) / (b * c);
}

export function formatPValue(value: number): string {
  if (!Number.isFinite(value)) return 'NA';
  if (value < 0.001) return value.toExponential(1);
  return value.toFixed(3);
}
