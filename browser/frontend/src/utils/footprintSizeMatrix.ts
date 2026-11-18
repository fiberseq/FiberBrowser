/**
 * Footprint size plots: the values each panel's matrix is coloured by, the shared colour range, the log2 ratio of
 * two panels, the note when panels rest on very different numbers of reads, and the TSV export with its settings.
 * Pure (no React, no store), so it is tested on its own.
 */
import { viridisRgb } from '../components/charts/viridis';
import { colormapRgb, FOOTPRINT_SIZE_COLORMAP_LABELS, isDivergingColormap, type FootprintSizeColormap } from './footprintSizeColormaps';
import {
  ALL_FOOTPRINTS, colorSlotOf, DEFAULT_FOOTPRINT_SIZE_COLORMAPS, FOOTPRINT_SIZE_NORMALIZATION_LABELS, footprintSizeLayerLabel, isEnrichment, type FootprintSizeSettings,
} from './footprintSizeSettings';

/** A matrix as the server sends it in raw_values mode: rows = size bins, columns = position bins, null = blank. */
export type SizeMatrix = (number | null)[][];

export interface SizePanelMeta {
  sizeMin: number;
  sizeMax: number;
  sizeBin: number;
  posBin: number;
  nReads: number;
  nFootprints: number;
}

export type ColorScaleKind = 'diverging' | 'sequential';

export interface ColorScale {
  kind: ColorScaleKind;
  /** Display-value limits (diverging: -max..max around 0 in log2, or 1/max..max linear around 1). */
  lo: number;
  hi: number;
  /** Centre (diverging only): 0 for log2, 1 for linear ratios. */
  mid: number;
  /** Legend text for the two ends and the middle. */
  loLabel: string;
  midLabel: string;
  hiLabel: string;
  /** What the colour is ("log2 enrichment", "footprints"...). */
  label: string;
  /** Colormap (absent: viridis for sequential, the blue - grey - red ramp for diverging; scales built by
   * colorScaleFor / ratioScale always carry one). */
  colormap?: FootprintSizeColormap;
  /** The colormap runs the other way round. */
  reverse?: boolean;
}

/** The colormap settings and the view, as a scale takes them (absent: the defaults, Size enrichment). */
type ColormapChoice = Partial<Pick<FootprintSizeSettings, 'colormaps' | 'view'>>;
/** A plot's colormap: comparative plots (log2 ratios) take the comparative slot, single plots their view's. */
const withColormap = (scale: ColorScale, s: ColormapChoice, comparative = false): ColorScale => {
  const c = (s.colormaps ?? DEFAULT_FOOTPRINT_SIZE_COLORMAPS)[colorSlotOf(s, comparative)];
  return { ...scale, colormap: c.name, reverse: c.reverse };
};
/** A log2 limit as the colour bar shows it: +2, 0, -2 (trailing zeros trimmed). */
const log2Label = (x: number) => String(+x.toFixed(2));

/** The value a cell is coloured by (null: blank). Enrichment: log2 when `log`. Counts: log1p when `log`. */
export function displayValue(v: number | null, s: Pick<FootprintSizeSettings, 'normalization' | 'log'>): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (isEnrichment(s.normalization)) {
    if (!s.log) return v;
    // An exact 0 (no footprints of that size here) is the low end of the scale, not a blank (blank = guarded).
    return v > 0 ? Math.log2(v) : Number.NEGATIVE_INFINITY;
  }
  return s.log ? Math.log1p(Math.max(0, v)) : v;
}

export function displayMatrix(m: SizeMatrix, s: Pick<FootprintSizeSettings, 'normalization' | 'log'>): SizeMatrix {
  return m.map(row => row.map(v => displayValue(v, s)));
}

/** The q-quantile of the finite values (q in 0..1). */
function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/** The automatic fold-change limit: the 95th percentile of |log2|, between AUTO_FOLD_MIN and AUTO_FOLD_MAX. */
export const AUTO_FOLD_MIN = 1.25;
export const AUTO_FOLD_MAX = 4;
function autoFold(absLog2: number[]): number {
  const q = quantile(absLog2, 0.95);
  return 2 ** Math.min(Math.log2(AUTO_FOLD_MAX), Math.max(Math.log2(AUTO_FOLD_MIN), q));
}

const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

/**
 * The colour scale for display matrices (one panel's, or every panel's for a shared scale).
 * Enrichment: diverging and symmetric about 1 (0 in log2); the limit is `colorMax` (a fold change) or, automatically,
 * the 95th percentile of the distance from 1 kept between 1.25x and 4x (cells with almost no footprints, e.g. where
 * no read reaches, would otherwise stretch the scale until every real difference is pale). Counts: sequential from 0 to `colorMax` or the 99th percentile.
 */
export function colorScaleFor(matrices: SizeMatrix[], s: Pick<FootprintSizeSettings, 'normalization' | 'log' | 'colorMax'> & ColormapChoice): ColorScale {
  return withColormap(baseColorScale(matrices, s), s);
}

function baseColorScale(matrices: SizeMatrix[], s: Pick<FootprintSizeSettings, 'normalization' | 'log' | 'colorMax'>): ColorScale {
  const values: number[] = [];
  for (const m of matrices) for (const row of m) for (const v of row) if (v != null && Number.isFinite(v)) values.push(v);
  if (isEnrichment(s.normalization)) {
    const log = s.log;
    let fold: number;
    if (s.colorMax && s.colorMax > 1) fold = s.colorMax;
    else {
      // Distance from the centre, in log2 either way, so ends sit at a fold change.
      const dist = values.filter(v => (log ? true : v > 0)).map(v => Math.abs(log ? v : Math.log2(v)));
      fold = autoFold(dist);
    }
    const label = log ? 'log2 enrichment' : 'enrichment';
    if (log) {
      const L = Math.log2(fold);
      return { kind: 'diverging', lo: -L, hi: L, mid: 0, loLabel: `-${log2Label(L)}`, midLabel: '0', hiLabel: `+${log2Label(L)}`, label };
    }
    return { kind: 'diverging', lo: 1 / fold, hi: fold, mid: 1, loLabel: `${fmt(1 / fold)}x`, midLabel: '1x', hiLabel: `${fmt(fold)}x`, label };
  }
  const top = s.colorMax && s.colorMax > 0
    ? (s.log ? Math.log1p(s.colorMax) : s.colorMax)
    : Math.max(1e-9, quantile(values, 0.99));
  const raw = s.log ? Math.expm1(top) : top;
  return { kind: 'sequential', lo: 0, hi: top, mid: 0, loLabel: '0', midLabel: '', hiLabel: fmt(raw), label: s.log ? 'footprints (log scale)' : 'footprints' };
}

/** The scale for a log2 ratio of two panels (symmetric; the automatic limit as for enrichment). */
export function ratioScale(m: SizeMatrix, s: ColormapChoice = {}): ColorScale {
  const dist: number[] = [];
  for (const row of m) for (const v of row) if (v != null && Number.isFinite(v)) dist.push(Math.abs(v));
  const L = Math.log2(autoFold(dist));
  return withColormap({ kind: 'diverging', lo: -L, hi: L, mid: 0, loLabel: `-${log2Label(L)}`, midLabel: '0', hiLabel: `+${log2Label(L)}`, label: 'log2 ratio' }, s, true);
}

// Diverging blue <-> red with a neutral grey midpoint (light and dark surfaces), each arm 5 steps.
const BLUE = ['#104281', '#1c5cab', '#3987e5', '#86b6ef', '#cde2fb'];
const RED = ['#fbd3d0', '#f19c97', '#e34948', '#b8302f', '#8a1f1f'];
const MID_LIGHT = '#f0efec';
const MID_DARK = '#383835';

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

function ramp(stops: string[], t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(hex(stops[i]), hex(stops[i + 1]), x - i);
}

/** -1 (low end) .. 0 (centre) .. 1 (high end) as blue - grey - red. */
export function divergingRgb(t: number, dark = false): [number, number, number] {
  const mid = dark ? MID_DARK : MID_LIGHT;
  if (t < 0) return ramp([...BLUE, mid], 1 + Math.max(-1, t));
  return ramp([mid, ...RED], Math.min(1, t));
}

/** A display value's colour on a scale. */
export function scaleRgb(v: number, scale: ColorScale, dark = false): [number, number, number] {
  const named = scale.colormap ?? null;
  if (scale.kind === 'sequential') {
    const span = scale.hi - scale.lo || 1;
    let u = Math.min(1, Math.max(0, (v - scale.lo) / span));
    // A diverging colormap keeps 0 at its middle: values from 0 up use its upper half (counts on RdBu, if picked).
    if (named && isDivergingColormap(named)) u = 0.5 + u / 2;
    if (scale.reverse) u = 1 - u;
    return named ? colormapRgb(named, u) : viridisRgb(u);
  }
  // Diverging: each arm on its own scale (log2: lo = -hi; linear ratios: 1/fold .. fold, by log2 distance).
  let t: number;
  if (scale.mid === 1) {
    const L = Math.log2(scale.hi);
    t = v > 0 ? Math.log2(v) / L : -1;
  } else {
    t = v >= scale.mid ? (v - scale.mid) / (scale.hi - scale.mid || 1) : -(scale.mid - v) / (scale.mid - scale.lo || 1);
  }
  t = Math.min(1, Math.max(-1, Number.isNaN(t) ? -1 : t));
  if (scale.reverse) t = -t;
  // The scale's range across the colormap: a symmetric range (log2 -L..+L, or 1/fold..fold) end to end, so a
  // diverging map has 0 (1x) at its white middle; a sequential one simply runs low to high.
  return named ? colormapRgb(named, (t + 1) / 2) : divergingRgb(t, dark);
}

/**
 * log2(A / B) per cell (null where either is blank or not positive). Counts are first divided by each panel's
 * footprints, so the ratio compares the size-by-position distributions, not how many reads each panel had.
 */
export function ratioMatrix(a: SizeMatrix, b: SizeMatrix, s: Pick<FootprintSizeSettings, 'normalization'>,
  footprintsA = 1, footprintsB = 1): SizeMatrix {
  const counts = !isEnrichment(s.normalization);
  const fa = counts ? Math.max(1, footprintsA) : 1;
  const fb = counts ? Math.max(1, footprintsB) : 1;
  return a.map((row, i) => row.map((va, j) => {
    const vb = b[i]?.[j];
    if (va == null || vb == null || !(va > 0) || !(vb > 0)) return null;
    return Math.log2((va / fa) / (vb / fb));
  }));
}

/**
 * A note when the panels rest on very different numbers of reads (largest / smallest >= `fold`): their plots are
 * less alike in noise than in biology. Null when they are similar (or there is one panel).
 */
export function densityNote(panels: Array<{ label: string; nReads: number; nFootprints: number }>, fold = 2): string | null {
  const withReads = panels.filter(p => p.nReads > 0);
  if (withReads.length < 2) return null;
  const sorted = [...withReads].sort((x, y) => x.nReads - y.nReads);
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  if (hi.nReads / lo.nReads < fold) return null;
  return `Read counts differ ${(hi.nReads / lo.nReads).toFixed(1)}-fold (${hi.label}: ${hi.nReads.toLocaleString()} reads, `
    + `${lo.label}: ${lo.nReads.toLocaleString()}); the panel with fewer reads is noisier, so compare patterns rather than single cells.`;
}

/** The colormap as the exports name it: its name, kind and, for a diverging one, its centre. */
export function colormapName(s: ColormapChoice, comparative = false): string {
  const c = (s.colormaps ?? DEFAULT_FOOTPRINT_SIZE_COLORMAPS)[colorSlotOf(s, comparative)];
  const name = c.name === 'rdbu_r' ? 'rdbu' : c.name;
  const kind = isDivergingColormap(c.name) ? 'diverging, centred on 0' : 'sequential';
  return `${name} (${kind})${c.reverse ? ', reversed' : ''}`;
}

/** The matrix as TSV: settings as `# key: value` lines, then one row per size bin, one column per position bin. */
export function sizeMatrixTsv(m: SizeMatrix, meta: SizePanelMeta, s: FootprintSizeSettings, extra: {
  title: string; chrom: string; start: number; value?: string;
  /** A comparative matrix (the log2 ratio of two plots): its values are log2, whatever the Log colour setting, and
   * its colormap is the comparative one. */
  comparative?: boolean;
}): string {
  // What the numbers in the file are (the colour scale is described on its own line).
  const valueNote = extra.comparative
    ? ' (log2 values: 0 = equal, +1 = twice, -1 = half)'
    : isEnrichment(s.normalization) ? ' (ratio, 1 = average; not logged)' : ' (not logged)';
  const colourScale = extra.comparative
    ? 'log2, centred on 0'
    : s.log ? (isEnrichment(s.normalization) ? 'log2, centred on 0' : 'log1p') : 'linear';
  const lines = [
    `# FiberBrowser footprint size plot: ${extra.title}`,
    `# region: ${extra.chrom}:${extra.start + 1}-${extra.start + (m[0]?.length ?? 0) * meta.posBin}`,
    `# view: ${s.view === 'enrichment' ? 'size enrichment' : 'V-plot'}`,
    `# footprint: ${s.mode === 'span' ? 'full footprint (fills every position it covers)' : 'midpoint'}`,
    `# value: ${extra.value ?? FOOTPRINT_SIZE_NORMALIZATION_LABELS[s.normalization].label}${valueNote}`,
    `# normalization: ${s.normalization}`,
    `# min_footprints: ${s.minFootprints} (blank cells: NA)`,
    `# gaussian_sigma_size_bp: ${s.sigmaSizeBp}`,
    `# gaussian_sigma_position_bp: ${s.sigmaPosBp}`,
    `# size_bin_bp: ${meta.sizeBin}`,
    `# position_bin_bp: ${meta.posBin}`,
    `# size_range_bp: ${meta.sizeMin}-${meta.sizeMax}`,
    `# colour_scale: ${colourScale}`,
    `# colormap: ${colormapName(s, !!extra.comparative)}`,
    `# source: ${s.layer === ALL_FOOTPRINTS ? 'All footprints (Nuc + TF layers, each footprint once)' : `${footprintSizeLayerLabel(s.layer)} layer (${s.layer})`}`,
    `# reads: ${meta.nReads}`,
    `# footprints: ${meta.nFootprints}`,
  ];
  const header = ['size_bp', ...Array.from({ length: m[0]?.length ?? 0 }, (_, j) => String(extra.start + j * meta.posBin + 1))];
  lines.push(header.join('\t'));
  m.forEach((row, i) => {
    lines.push([String(meta.sizeMin + i * meta.sizeBin), ...row.map(v => (v == null ? 'NA' : String(+v.toPrecision(6))))].join('\t'));
  });
  return `${lines.join('\n')}\n`;
}
