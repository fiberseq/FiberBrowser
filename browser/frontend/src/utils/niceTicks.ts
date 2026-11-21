/**
 * "Nice" axis ticks for every Plots figure and its exports: steps of 1, 2 or 5 × 10^k, about one major tick per
 * `targetPx` (x: 60–80 px, y: 40–50 px), with minor ticks (fifths or halves of a step) where they stay at least 8 px
 * apart. Labels: bp from an anchor read −10 kb … 0 … +10 kb; genomic positions with thousands separators (Mb when
 * the step is a megabase or more); other values with as many decimals as the step needs.
 */

export interface Ticks { major: number[]; minor: number[]; step: number }

/** The 1-2-5 step nearest above `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Ticks over [lo, hi] drawn `lengthPx` long, one major per about `targetPx`. */
export function niceTicks(lo: number, hi: number, lengthPx: number, targetPx = 70): Ticks {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || !(lengthPx > 0)) return { major: Number.isFinite(lo) ? [lo] : [], minor: [], step: 1 };
  // The 1-2-5 step whose spacing is nearest the target (not under three quarters of it), at most the range.
  let step = niceStep(((hi - lo) * targetPx) / lengthPx * 0.75);
  while (step > hi - lo && step > 1e-12) step = niceStep(step / 2.5) === step ? step / 2 : niceStep(step / 2.5);
  const eps = step * 1e-9;
  const major: number[] = [];
  for (let v = Math.ceil((lo - eps) / step) * step; v <= hi + eps; v += step) major.push(Math.abs(v) < eps ? 0 : +v.toPrecision(12));
  const pxPerUnit = lengthPx / (hi - lo);
  const sub = step / 5 * pxPerUnit >= 8 ? 5 : step / 2 * pxPerUnit >= 8 ? 2 : 0;
  const minor: number[] = [];
  if (sub) {
    const m = step / sub;
    for (let v = Math.ceil((lo - eps) / m) * m; v <= hi + eps; v += m) {
      const r = v / step;
      if (Math.abs(r - Math.round(r)) > 1e-6) minor.push(+v.toPrecision(12));
    }
  }
  return { major, minor, step };
}

const decimals = (step: number) => Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));

/** A value label at this step (enough decimals to tell the ticks apart). */
export function formatTick(v: number, step: number): string {
  if (Math.abs(v) >= 1e4 && step >= 1) return Math.round(v).toLocaleString('en-US');
  return v.toFixed(decimals(step)).replace('-', '−');
}

/** bp from an anchor: −10 kb, 0, +500 bp, +2.5 kb (kb from a 1 kb step, or when |v| ≥ 1 kb at a 500 bp step). */
export function formatRelativeBp(v: number, step: number): string {
  if (v === 0) return '0';
  const sign = v > 0 ? '+' : '−';
  const a = Math.abs(v);
  if (step >= 1000 || (a >= 1000 && step >= 500)) {
    const kb = a / 1000;
    return `${sign}${kb.toFixed(Math.max(0, decimals(step / 1000)))} kb`;
  }
  return `${sign}${Math.round(a)} bp`;
}

/** A genomic position (1-based display): 47,515,000, or 12.5 Mb at a megabase step. */
export function formatGenomic(v: number, step: number): string {
  if (step >= 1e6) return `${(v / 1e6).toFixed(decimals(step / 1e6))} Mb`;
  return Math.round(v).toLocaleString('en-US');
}
