/**
 * Footprint size plots (Clusters › Charts › Footprint sizes): footprint size (y) by position (x).
 *
 * Two views, one click each:
 * - Size enrichment (the default from every entry point): each footprint fills every position it covers, each
 *   size row divided by its mean across the window (1 = as common here as that size is anywhere in the window),
 *   Gaussian-smoothed; coloured by log2, centred on 0 (1x).
 * - V-plot: the classic plot, each footprint counted once at its midpoint; counts on a sequential scale.
 *
 * Every knob is a setting with a default (bins, size range, Gaussian sigma per axis in bp, normalisation, the
 * minimum-footprints guard, colour scale). Kept free of store imports so the slice and the session code read them
 * cheaply; saved with the session (older sessions have none: the defaults).
 */
import { isDivergingColormap, isFootprintSizeColormap, type FootprintSizeColormap } from './footprintSizeColormaps';
import { getCanonicalLayerEntries, getLayerColor, getLayerLabel, getLayerTitle } from './layerColors';

export type FootprintSizeView = 'enrichment' | 'vplot';
export type FootprintSizeMode = 'midpoint' | 'span';
export type FootprintSizeNormalization = 'row' | 'column' | 'oe' | 'raw';
export type FootprintSizeGroupBy = 'clusters' | 'datasets';
export type FootprintSizeScale = 'shared' | 'per_panel';
/**
 * Which colormap a plot uses: comparative plots (the log2 ratio of two plots) are one slot; the single plots are
 * another per view (Size enrichment, V-plot). Each slot keeps its own pick.
 */
export type FootprintSizeColorSlot = 'comparative' | 'enrichment' | 'vplot';
export const FOOTPRINT_SIZE_COLOR_SLOTS: readonly FootprintSizeColorSlot[] = ['comparative', 'enrichment', 'vplot'];
export interface FootprintSizeColormapChoice {
  name: FootprintSizeColormap;
  /** Run the colormap the other way round. */
  reverse: boolean;
}

/** Comparative: RdBu_r centred on 0 (blue: lower in A, red: higher). Single plots: magma (Size enrichment, log2 or
 * linear) and viridis, the colormap V-plots have always used (V-plot). */
export const DEFAULT_FOOTPRINT_SIZE_COLORMAPS: Readonly<Record<FootprintSizeColorSlot, FootprintSizeColormapChoice>> = Object.freeze({
  comparative: Object.freeze({ name: 'rdbu_r', reverse: false }) as FootprintSizeColormapChoice,
  enrichment: Object.freeze({ name: 'magma', reverse: false }) as FootprintSizeColormapChoice,
  vplot: Object.freeze({ name: 'viridis', reverse: false }) as FootprintSizeColormapChoice,
});

/** The colormap slot of a single (non-comparative) plot drawn with these settings: its view's. */
export function colorSlotOf(s: Partial<Pick<FootprintSizeSettings, 'view'>>, comparative = false): FootprintSizeColorSlot {
  if (comparative) return 'comparative';
  return s.view === 'vplot' ? 'vplot' : 'enrichment';
}

function normalizeColormaps(r: Record<string, unknown>): Record<FootprintSizeColorSlot, FootprintSizeColormapChoice> {
  const d = DEFAULT_FOOTPRINT_SIZE_COLORMAPS;
  const out = { comparative: { ...d.comparative }, enrichment: { ...d.enrichment }, vplot: { ...d.vplot } };
  const read = (v: unknown): Partial<FootprintSizeColormapChoice> => {
    const c = v && typeof v === 'object' ? v as Record<string, unknown> : {};
    return {
      ...(isFootprintSizeColormap(c.name) ? { name: c.name } : {}),
      ...(typeof c.reverse === 'boolean' ? { reverse: c.reverse } : {}),
    };
  };
  const given = r.colormaps && typeof r.colormaps === 'object' ? r.colormaps as Record<string, unknown> : null;
  if (given && FOOTPRINT_SIZE_COLOR_SLOTS.some(k => k in given)) {
    for (const slot of FOOTPRINT_SIZE_COLOR_SLOTS) Object.assign(out[slot], read(given[slot]));
  } else if (given) {
    // The earlier signed / unsigned slots: signed served the ratio plot (and, wrongly, single log2 plots, which
    // now take the default); unsigned served the single plots, so a pick other than its default is kept for
    // Size enrichment.
    Object.assign(out.comparative, read(given.signed));
    const unsigned = read(given.unsigned);
    if (unsigned.name && unsigned.name !== 'magma') Object.assign(out.enrichment, unsigned);
  } else if (isFootprintSizeColormap(r.colormap)) {
    // An earlier single choice: a diverging map was the comparative pick, a sequential one the Size enrichment pick.
    const slot = isDivergingColormap(r.colormap) ? 'comparative' : 'enrichment';
    out[slot] = { name: r.colormap, reverse: r.reverseColormap === true };
  }
  return out;
}

export interface FootprintSizeSettings {
  view: FootprintSizeView;
  mode: FootprintSizeMode;
  normalization: FootprintSizeNormalization;
  /** Gaussian sigma down the size axis, bp (0 = off). */
  sigmaSizeBp: number;
  /** Gaussian sigma along positions, bp (0 = off). */
  sigmaPosBp: number;
  sizeBin: number;
  posBin: number;
  sizeMin: number;
  sizeMax: number;
  /** Rows (row, O/E) or columns (column) drawn from fewer footprints are left blank. */
  minFootprints: number;
  /** Enrichment: colour by log2 (centred on 0, i.e. 1x). Counts: log1p. */
  log: boolean;
  /** One colour range for every panel (the default), or each panel its own. */
  scale: FootprintSizeScale;
  /** Colour limit: enrichment, the fold change at either end (e.g. 2 = 0.5x..2x); counts, the top. null: automatic. */
  colorMax: number | null;
  /** Colormap of the cells, the colour bar and the exports, per slot (each keeps its own pick): comparative (the
   * log2 ratio plot; default RdBu_r centred on 0), enrichment (single Size enrichment plots; magma), vplot (single
   * V-plots; viridis). */
  colormaps: Record<FootprintSizeColorSlot, FootprintSizeColormapChoice>;
  /** With clusters: one plot per cluster (the default) or per dataset (all reads). */
  groupBy: FootprintSizeGroupBy;
  /** Source of the footprints: ALL_FOOTPRINTS (the footprint layers together, Nuc + TF: the default) or one of the
   * standard layers by its key ('nuc', 'tf', 'fire', a footprint-class layer...), as the Layers toolbar lists them. */
  layer: string;
  /** Show the log2 ratio of two panels (their keys) beside them. */
  ratio: [string, string] | null;
}

/** Every footprint of a read: the footprint layers together (Nuc + TF; the calls when a read has no Nuc layer), each once. */
export const ALL_FOOTPRINTS = 'all_footprints';

/**
 * A stored source as a layer key. Older settings: null or '' (the old "HMM calls (ns/nl)", which are the Nuc layer
 * in FiberHMM output) become 'nuc'; 'msp' (the internal accessibility key) becomes 'fire'; missing, the default.
 */
export function normalizeFootprintSizeLayer(v: unknown): string {
  if (v === undefined) return ALL_FOOTPRINTS;
  if (v === null || v === '' || v === 'footprint') return 'nuc';
  if (typeof v !== 'string') return ALL_FOOTPRINTS;
  if (v === 'msp') return 'fire';
  return v;
}

// Layers that hold marks (single bases), not footprint intervals: no size to plot.
const MARK_LAYERS = new Set(['m6a', 'mod', 'm5c', 'deam', 'deam_opportunity', 'deam_ct', 'deam_ga', 'ddda_mcg', 'ddda_mcg_hemi']);

export interface FootprintSizeLayerOption {
  value: string;
  label: string;
  title: string;
  color: string;
}

/**
 * The sources to offer: "All footprints" (Nuc + TF), then the interval layers the Layers toolbar lists for these
 * datasets, with the toolbar's labels (getCanonicalLayerEntries: Nuc / FP, the accessibility layer, TF, footprint
 * classes, other custom layers) and colours. The current source stays listed even when no dataset has it.
 */
export function footprintSizeLayerOptions(
  datasets: Parameters<typeof getCanonicalLayerEntries>[0], current?: string,
): FootprintSizeLayerOption[] {
  const out: FootprintSizeLayerOption[] = [{
    value: ALL_FOOTPRINTS, label: 'All footprints', color: getLayerColor('nuc'),
    title: 'All footprints: the Nuc and TF layers together, each footprint once (the nucleosome-sized and the small footprints).',
  }];
  const seen = new Set<string>([ALL_FOOTPRINTS]);
  for (const entry of getCanonicalLayerEntries(datasets)) {
    const value = entry.key === 'footprint' ? 'nuc' : entry.key === 'msp' ? 'fire' : entry.key;
    if (MARK_LAYERS.has(value) || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: entry.label, title: entry.title || getLayerTitle(value), color: entry.color ?? getLayerColor(value) });
  }
  if (current && !seen.has(current)) {
    out.push({ value: current, label: getLayerLabel(current), title: `${getLayerLabel(current)} (not in the loaded datasets)`, color: getLayerColor(current) });
  }
  return out;
}

/** A source's name, as the Layers toolbar names the layer ("All footprints" for the union). */
export function footprintSizeLayerLabel(layer: string): string {
  return layer === ALL_FOOTPRINTS ? 'All footprints' : getLayerLabel(layer);
}

export const FOOTPRINT_SIZE_NORMALIZATIONS: readonly FootprintSizeNormalization[] = ['row', 'column', 'oe', 'raw'];

/** What each view sets (the rest of the settings stay as they are). */
export const FOOTPRINT_SIZE_VIEW_PRESETS: Record<FootprintSizeView, Pick<FootprintSizeSettings,
  'view' | 'mode' | 'normalization' | 'sigmaSizeBp' | 'sigmaPosBp' | 'log'>> = {
  enrichment: { view: 'enrichment', mode: 'span', normalization: 'row', sigmaSizeBp: 10, sigmaPosBp: 20, log: true },
  // The older V-plot defaults: midpoints, counts, log1p, one 10 bp bin of smoothing on both axes.
  vplot: { view: 'vplot', mode: 'midpoint', normalization: 'raw', sigmaSizeBp: 10, sigmaPosBp: 10, log: true },
};

export const DEFAULT_FOOTPRINT_SIZE_SETTINGS: FootprintSizeSettings = Object.freeze({
  ...FOOTPRINT_SIZE_VIEW_PRESETS.enrichment,
  sizeBin: 10,
  posBin: 10,
  sizeMin: 10,
  sizeMax: 300,
  minFootprints: 20,
  scale: 'shared',
  colorMax: null,
  colormaps: DEFAULT_FOOTPRINT_SIZE_COLORMAPS,
  groupBy: 'clusters',
  layer: ALL_FOOTPRINTS,
  ratio: null,
}) as FootprintSizeSettings;

/** One sentence per view (the toggle's tooltips). */
export const FOOTPRINT_SIZE_VIEW_HELP: Record<FootprintSizeView, string> = {
  enrichment: 'Size enrichment: each footprint fills the positions it covers, and each size row is divided by its average across the window, so colour shows where each footprint size is enriched (log2, 0 = average; brighter = more, darker = less).',
  vplot: 'V-plot: the classic plot, each footprint counted once at its midpoint, coloured by how many footprints of that size are centred there.',
};

export const FOOTPRINT_SIZE_NORMALIZATION_LABELS: Record<FootprintSizeNormalization, { label: string; help: string }> = {
  row: { label: 'Per size row', help: 'Each size row over its mean across the window: where each footprint size is enriched (1 = average for that size).' },
  column: { label: 'Per position', help: 'Each position column over its mean across sizes: which sizes are over-represented at each position.' },
  oe: { label: 'Obs / expected', help: 'Observed over expected from both margins (size total x position total / grand total): 1 = what the totals predict.' },
  raw: { label: 'Counts', help: 'Footprint counts (full footprint: bases covered / bin width).' },
};

/** The normalisation gives a ratio around 1 (diverging scale) rather than counts (sequential). */
export const isEnrichment = (n: FootprintSizeNormalization): boolean => n !== 'raw';

/** The view the settings match (null: edited away from both presets). */
export function matchingView(s: FootprintSizeSettings): FootprintSizeView | null {
  for (const view of ['enrichment', 'vplot'] as const) {
    const p = FOOTPRINT_SIZE_VIEW_PRESETS[view];
    if (s.mode === p.mode && s.normalization === p.normalization && s.sigmaSizeBp === p.sigmaSizeBp
      && s.sigmaPosBp === p.sigmaPosBp) return view;
  }
  return null;
}

const num = (v: unknown, lo: number, hi: number, fallback: number, int = false): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const x = Math.min(hi, Math.max(lo, v));
  return int ? Math.round(x) : x;
};

/**
 * A stored value as settings (anything malformed falls back to that field's default). Older V-plot settings are
 * read too: `smooth` (one Gaussian sigma in bins on both axes) becomes sigma in bp per axis (times each axis's bin),
 * `rowNormalize` becomes normalization row / raw, `logNorm` becomes log.
 */
export function normalizeFootprintSizeSettings(raw: unknown): FootprintSizeSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_FOOTPRINT_SIZE_SETTINGS;
  const sizeBin = num(r.sizeBin, 1, 200, d.sizeBin, true);
  const posBin = num(r.posBin, 1, 5000, d.posBin, true);
  const sizeMin = num(r.sizeMin, 0, 5000, d.sizeMin, true);
  const sizeMax = Math.max(sizeMin + sizeBin, num(r.sizeMax, 1, 10000, d.sizeMax, true));
  const view: FootprintSizeView = r.view === 'vplot' ? 'vplot' : 'enrichment';
  const preset = FOOTPRINT_SIZE_VIEW_PRESETS[view];
  const legacySmooth = typeof r.smooth === 'number' && Number.isFinite(r.smooth) ? Math.max(0, r.smooth) : null;
  const sigmaSizeBp = num(r.sigmaSizeBp, 0, 10000, legacySmooth != null ? legacySmooth * sizeBin : preset.sigmaSizeBp);
  const sigmaPosBp = num(r.sigmaPosBp, 0, 100000, legacySmooth != null ? legacySmooth * posBin : preset.sigmaPosBp);
  const normalization = FOOTPRINT_SIZE_NORMALIZATIONS.includes(r.normalization as FootprintSizeNormalization)
    ? r.normalization as FootprintSizeNormalization
    : typeof r.rowNormalize === 'boolean' ? (r.rowNormalize ? 'row' : 'raw') : preset.normalization;
  const ratio = Array.isArray(r.ratio) && r.ratio.length === 2 && r.ratio.every(k => typeof k === 'string' && k)
    && r.ratio[0] !== r.ratio[1] ? [r.ratio[0], r.ratio[1]] as [string, string] : null;
  return {
    view,
    mode: r.mode === 'midpoint' || r.mode === 'span' ? r.mode : preset.mode,
    normalization,
    sigmaSizeBp,
    sigmaPosBp,
    sizeBin,
    posBin,
    sizeMin,
    sizeMax,
    minFootprints: num(r.minFootprints ?? r.rowMinFootprints, 0, 100000, d.minFootprints, true),
    log: typeof r.log === 'boolean' ? r.log : typeof r.logNorm === 'boolean' ? r.logNorm : preset.log,
    scale: r.scale === 'per_panel' || r.scale === 'per_cluster' ? 'per_panel' : 'shared',
    colorMax: typeof r.colorMax === 'number' && Number.isFinite(r.colorMax) && r.colorMax > 0 ? r.colorMax : null,
    colormaps: normalizeColormaps(r),
    groupBy: r.groupBy === 'datasets' ? 'datasets' : 'clusters',
    layer: normalizeFootprintSizeLayer(r.layer),
    ratio,
  };
}

/** Settings after choosing a view: its preset over the current settings. */
export function withView(s: FootprintSizeSettings, view: FootprintSizeView): FootprintSizeSettings {
  return normalizeFootprintSizeSettings({ ...s, ...FOOTPRINT_SIZE_VIEW_PRESETS[view] });
}

/** A short line of the current settings (the settings section's summary). */
export function footprintSizeSummary(s: FootprintSizeSettings): string {
  const sigma = (v: number) => (v > 0 ? `${v} bp` : 'off');
  const source = footprintSizeLayerLabel(s.layer);
  return [
    source,
    s.mode === 'span' ? 'Full footprint' : 'Midpoint',
    FOOTPRINT_SIZE_NORMALIZATION_LABELS[s.normalization].label,
    `${s.sizeMin}-${s.sizeMax} bp`,
    `bins ${s.sizeBin} x ${s.posBin} bp`,
    `Gaussian σ size ${sigma(s.sigmaSizeBp)}, position ${sigma(s.sigmaPosBp)}`,
  ].join(' · ');
}

/** What the plot shows, in a sentence (the caption under the plots). */
export function footprintSizeCaption(s: FootprintSizeSettings): string {
  const what = s.mode === 'span'
    ? 'Full footprint: each footprint fills every position it covers, in the row of its size'
    : 'Midpoint: each footprint counted once, at its centre, in the row of its size';
  const guard = s.minFootprints > 0
    ? s.normalization === 'column'
      ? ` (positions with under ${s.minFootprints} footprints left blank)`
      : s.normalization === 'raw' ? '' : ` (sizes with under ${s.minFootprints} footprints left blank)`
    : '';
  const colour = {
    row: 'colour = enrichment of that size at each position over its average across the window',
    column: 'colour = enrichment of that size at each position over the average of all sizes there',
    oe: 'colour = observed over expected from the size and position totals',
    raw: 'colour = footprint count',
  }[s.normalization];
  return `${what}; ${colour}${guard}.`;
}
