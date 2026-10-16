/**
 * Numbers with their denominators and named estimators (usability audit Top 5): every percentage a user may compare
 * with another says what it is a fraction of, and two estimators of "the same" quantity are named apart
 * ("Estimated molecule prevalence 5.2%" vs "Confident-call read fraction 7.8%").
 *
 * Percent style follows the app's: no space before %, whole percent by default. A share that is not zero but rounds
 * to 0 reads "<1%" (with one digit, "<0.1%"); one that is not all but rounds to 100 reads ">99%".
 */

/** Named estimators: add yours here rather than writing the words inline, so every panel says them the same way. */
export const ESTIMATORS = {
  /** EM / model estimate of the share of molecules carrying it. */
  moleculePrevalence: 'Estimated molecule prevalence',
  /** Reads with a confident call for it over the reads with any call. */
  confidentReadFraction: 'Confident-call read fraction',
  /** Lower bound of the molecule prevalence. */
  prevalenceLowerBound: 'Prevalence lower bound',
} as const;

export interface PctOptions {
  /** Decimal places (default 0). */
  digits?: number;
  /** Text for a missing value (default "–"). */
  missing?: string;
}

/** A fraction (0–1) as a percent: "5%", "5.2%" (digits 1), "<1%", ">99%", "0%", "100%"; null/NaN → "–". */
export function formatPct(fraction: number | null | undefined, options: PctOptions = {}): string {
  const { digits = 0, missing = '–' } = options;
  if (fraction == null || !Number.isFinite(fraction)) return missing;
  const percent = fraction * 100;
  const step = 10 ** -digits;
  const text = (v: number) => (digits > 0 ? v.toFixed(digits) : String(Math.round(v)));
  if (percent > 0 && Number(text(percent)) === 0) return `<${text(step)}%`;
  if (percent < 100 && Number(text(percent)) >= 100) return `>${text(100 - step)}%`;
  return `${text(percent)}%`;
}

/** `n` of `d` as a percent (formatPct(n / d)); "–" when d is 0 or missing. */
export function formatCountPct(n: number | null | undefined, d: number | null | undefined, options: PctOptions = {}): string {
  if (n == null || d == null || !(d > 0)) return options.missing ?? '–';
  return formatPct(n / d, options);
}

const count = (v: number) => v.toLocaleString();

export interface ShareOptions extends PctOptions {
  /** Add the percent in brackets: "737 of 810 loaded reads (91%)". */
  pct?: boolean;
}

/** "737 of 810 loaded reads"; with `pct`, "737 of 810 loaded reads (91%)". */
export function formatShare(n: number, of: number, population: string, options: ShareOptions = {}): string {
  const base = `${count(n)} of ${count(of)}${population ? ` ${population}` : ''}`;
  return options.pct ? `${base} (${formatCountPct(n, of, options)})` : base;
}

export interface EstimateParts extends PctOptions {
  /** The estimator's name (ESTIMATORS.*). */
  estimator: string;
  /** The estimate as a fraction (0–1). */
  value: number | null | undefined;
  /** The counts it rests on, when it is a plain fraction of them. */
  n?: number;
  of?: number;
  population?: string;
}

/**
 * "Estimated molecule prevalence 5.2%"; with counts, "Confident-call read fraction 7.8% (120 of 1,540 reads)".
 * Digits default to 1 for estimates.
 */
export function formatEstimate(parts: EstimateParts): string {
  const { estimator, value, n, of, population = '' } = parts;
  const text = `${estimator} ${formatPct(value, { digits: parts.digits ?? 1, missing: parts.missing })}`;
  return n != null && of != null ? `${text} (${formatShare(n, of, population)})` : text;
}
