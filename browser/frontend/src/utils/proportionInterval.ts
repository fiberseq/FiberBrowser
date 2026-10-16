/**
 * A 95% interval for a share (usability audit VAR-4: "show intervals"): Wilson's score interval, printed the way
 * utils/denominators.ts prints percentages (whole percent; a tenth of a percent near 0 or 100).
 */
import { formatCountPct } from './denominators';

/** Wilson 95% interval for n of d (fractions 0..1); null without a denominator. */
export function wilsonInterval(n: number, d: number, z = 1.96): [number, number] | null {
  if (!(d > 0)) return null;
  const p = n / d;
  const z2 = z * z;
  const centre = (p + z2 / (2 * d)) / (1 + z2 / d);
  const half = (z * Math.sqrt((p * (1 - p)) / d + z2 / (4 * d * d))) / (1 + z2 / d);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** "91% (95% CI 90–92%)": the share (formatCountPct) and its interval. */
export function formatPctInterval(n: number, d: number): string {
  const ci = wilsonInterval(n, d);
  if (!ci) return '–';
  // Near 0 or 100 % a tenth of a percent says more than "<1" or ">99" would.
  const edge = (x: number) => {
    const p = 100 * x;
    if (p > 0 && p < 0.1) return '<0.1';
    if (p < 100 && p > 99.9) return '>99.9';
    return p < 1 || p > 99 ? p.toFixed(1) : String(Math.round(p));
  };
  return `${formatCountPct(n, d)} (95% CI ${edge(ci[0])}–${edge(ci[1])}%)`;
}
