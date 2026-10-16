/**
 * The position x position matrix of one dataset minus another's (Co-accessibility's raw correlation or accessibility
 * values, A - B), on one position grid. Pure: no React, no store.
 */
import type { CoaccMatrixData } from '../api/coaccessibility';

export interface CoaccDifference {
  /** A - B per cell; null where either has no value (too little coverage). */
  matrix: (number | null)[][];
  chrom: string; start: number; end: number; bin_size: number; n_bins: number;
  /** Reads behind each matrix. */
  readsA: number; readsB: number;
  /** The largest |A - B| (the colour scale's half range). */
  maxAbs: number;
}

/** Why two matrices cannot be subtracted (they are not on the same positions), or null. */
export function gridMismatch(a: CoaccMatrixData, b: CoaccMatrixData): string | null {
  if (a.chrom !== b.chrom) return `They are on different chromosomes (${a.chrom} and ${b.chrom}).`;
  if (a.start !== b.start || a.end !== b.end) return `They cover different positions (${a.start}–${a.end} and ${b.start}–${b.end}).`;
  if (a.bin_size !== b.bin_size || a.n_bins !== b.n_bins) return `They are binned differently (${a.n_bins} × ${a.bin_size} bp and ${b.n_bins} × ${b.bin_size} bp).`;
  if (a.matrix.length !== b.matrix.length || a.matrix.some((row, i) => row.length !== b.matrix[i]?.length)) return 'Their matrices have different sizes.';
  if (a.normalization !== b.normalization) return `They are different values (${a.normalization} and ${b.normalization}).`;
  return null;
}

/** A - B cell by cell, or why not. */
export function subtractCoacc(a: CoaccMatrixData, b: CoaccMatrixData): CoaccDifference | { error: string } {
  const mismatch = gridMismatch(a, b);
  if (mismatch) return { error: `These two matrices can't be subtracted: ${mismatch}` };
  let maxAbs = 0;
  const matrix = a.matrix.map((row, i) => row.map((va, j) => {
    const vb = b.matrix[i][j];
    if (va == null || vb == null || !Number.isFinite(va) || !Number.isFinite(vb)) return null;
    const d = va - vb;
    if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
    return d;
  }));
  return { matrix, chrom: a.chrom, start: a.start, end: a.end, bin_size: a.bin_size, n_bins: a.n_bins, readsA: a.n_reads, readsB: b.n_reads, maxAbs };
}

/** Diverging colour centred on 0: red where A is higher, blue where B is, white at 0 (|d| / half range). */
export function divergingColor(d: number | null, half: number): string {
  if (d == null || !Number.isFinite(d)) return 'rgb(229, 231, 235)';
  const t = Math.max(-1, Math.min(1, d / Math.max(half, 1e-9)));
  const mix = (c: number) => Math.round(255 + (c - 255) * Math.abs(t));
  return t >= 0 ? `rgb(${mix(194)}, ${mix(65)}, ${mix(12)})` : `rgb(${mix(29)}, ${mix(78)}, ${mix(216)})`;
}

/** Why two datasets cannot be compared position by position (different references), or null. */
export function referenceMismatch(refA: string | null | undefined, refB: string | null | undefined, labelA: string, labelB: string): string | null {
  const a = refA || 'the main genome', b = refB || 'the main genome';
  return a === b ? null : `${labelA} is on ${a} and ${labelB} on ${b}: their positions don't line up, so they can't be subtracted.`;
}
