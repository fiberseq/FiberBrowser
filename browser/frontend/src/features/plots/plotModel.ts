/**
 * The Plots workspace's plot model (native/nuc_regularity/PLOTS_PANEL_PLAN.md): every plot is
 * Type × Source × Where × Group by, plus an optional Compare, with its type's own settings, a name, and whether it
 * follows the browser's view or is pinned to a locus. Kept free of store and React imports so the store extension,
 * the session code and the tests read it cheaply.
 *
 * Phase 1 draws the footprint size types (Size enrichment, V-plot) on the current view, by dataset or by cluster,
 * with log2(A/B); the other choices are listed and disabled ("coming soon") so the model and the session format
 * already hold them.
 */
import {
  ALL_FOOTPRINTS, DEFAULT_FOOTPRINT_SIZE_SETTINGS, FOOTPRINT_SIZE_VIEW_PRESETS, footprintSizeLayerLabel,
  normalizeFootprintSizeLayer, normalizeFootprintSizeSettings, type FootprintSizeSettings, type FootprintSizeView,
} from '../../utils/footprintSizeSettings';
import { COMPARE_MODES, type CompareMode } from './compare';
import type { ProfileNormalization } from './profileEngine';
import { DEFAULT_BED_SETTINGS, normalizeBedSettings, type BedSettings } from './bedRegions';
import { DEFAULT_SUMMARY, normalizeSummary, type SummarySettings } from './summary';
import { normalizeQuantSpec, normalizeQuantWindow } from '../windowQuant/spec';
import { normalizeAxisFrame } from '../windowQuant/axisFrame';

export type PlotType = 'size-enrichment' | 'vplot' | 'metaprofile' | 'heatmap' | 'size-histogram' | 'differential' | 'nuc-spacing' | 'co-accessibility';
export type PlotWhere = 'view' | 'features' | 'bed' | 'random';
export type PlotGroupBy = 'none' | 'dataset' | 'cluster' | 'classes' | 'read-groups' | 'bed';
export type PlotCompare = 'off' | 'diff' | 'log2ratio';

/** A locus a plot is pinned to (or was computed for). `genome` null: the main reference. */
export interface PlotLocus {
  chrom: string;
  start: number;
  end: number;
  genome: string | null;
}

export interface PlotSpec {
  id: string;
  name: string;
  type: PlotType;
  /** ALL_FOOTPRINTS or a layer key as the Layers toolbar lists it ('nuc', 'tf', 'fire', a class layer...): the first
   *  of `sources`, kept for every reader of one source (size types, heatmaps, older sessions). */
  source: string;
  /** The sources drawn, in chip order: several for the multi-source types (Metaprofile: one line per source per
   *  group), one otherwise. Layer keys, ALL_FOOTPRINTS, or a feature family (`fam:<set>|<hit>`, hub/familySources). */
  sources: string[];
  /** Names of the non-layer sources (families), so a stored plot can say what it drew without the run loaded. */
  sourceLabels?: Record<string, string>;
  where: PlotWhere;
  groupBy: PlotGroupBy;
  compare: PlotCompare;
  /** How groups are compared (auto: each vs rest for clusters; A vs B for exactly two datasets). */
  compareMode: CompareMode;
  /** A vs B: two of the plot's groups by id (null: the first two). */
  compareAB: [string, string] | null;
  /** null: follows the browser's view. A locus: pinned there (BED and feature-set plots are always pinned). */
  pinned: PlotLocus | null;
  /** The dataset panel the plot was made from (the read menu's "here"): its datasets and clusters are plotted, as
   *  the panel the user works in would be. Absent: the active panel (an unknown id falls back to it). */
  panel?: string;
  /** Size plots, log2 ratio: compare the size-by-position shares (absent, the default) or each side's enrichment under
   *  the plot's normalisation ('enrichment': per size row, per position or obs / expected, as the plots show it). */
  sizeCompareOn?: 'enrichment';
  /** The size types' settings (bins, smoothing, normalisation, colour). Source, grouping and ratio live above. */
  size: FootprintSizeSettings;
  /** The profile types' settings (Metaprofile, Heatmap: bin, smoothing, signal, coverage mask, reads per dataset). */
  profile: ProfileSettings;
  /** Heatmap settings (rows: reads × position over the view, or features × position for selected features). */
  heatmap: HeatmapSettings;
  /** Footprint size histogram settings. */
  hist: HistogramSettings;
  /** Where = BED region sets: the sets (by id), anchors, subsampling and the occlusion filter. */
  bed: BedSettings;
  /** Differential features: which features, the test, strata and thresholds. */
  diff: DiffSettings;
  /** A plot whose series a panel supplied (a run Plots cannot redo: nucleosome regularity, NFR shape, plugins...): its
   *  axis and where it came from. The values live in its Gallery card, never in the plot (undo, sessions). */
  supplied?: SuppliedSpec | null;
  /** Co-accessibility settings (the Co-accessibility panel's, same endpoint and numbers). */
  coacc: CoaccSettings;
  /** The plot's read sampling and its seed (every random step of the plot uses this seed: utils/stableSample). */
  sampling: SamplingSettings;
  /** Summary across groups: each group reduced to one number, as bars or a line in panel order (a view mode). */
  summary: SummarySettings;
  /** Profiles over the view: the x-axis in genome coordinates (absent) or relative to an anchor (windowQuant/axisFrame). */
  axis?: import('../windowQuant/axisFrame').AxisFrame;
}

export type SamplingMode = 'all' | 'random';

/** Reads used: all in scope, or a random N per dataset (seeded, stable: the same seed gives the same reads). */
export interface SamplingSettings {
  mode: SamplingMode;
  /** Random N reads per dataset (and N per dataset for Where = random reads of the whole file). */
  n: number;
  /** The seed of every random step of this plot (region and read sampling, depth matching). Changed only by New seed. */
  seed: number;
}

export const DEFAULT_SAMPLING: SamplingSettings = Object.freeze({ mode: 'all', n: 10_000, seed: 1 }) as SamplingSettings;

export function normalizeSampling(raw: unknown): SamplingSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d);
  return { mode: r.mode === 'random' ? 'random' : 'all', n: int(r.n, 1, 1_000_000, DEFAULT_SAMPLING.n), seed: int(r.seed, 0, 2 ** 31 - 1, DEFAULT_SAMPLING.seed) };
}

/** "10,000 random reads per dataset, seed 1" / "all reads, seed 1". */
export function samplingText(s: SamplingSettings, wholeFile = false): string {
  return s.mode === 'random' || wholeFile ? `${s.n.toLocaleString('en-US')} random reads per dataset${wholeFile ? ' (whole file)' : ''}, seed ${s.seed}` : `all reads in scope, seed ${s.seed}`;
}

export type CoaccNormalization = 'correlation' | 'raw' | 'oe' | 'oe_distance';

/** Co-accessibility: every alternative a parameter with a default (the panel's defaults). */
export interface CoaccSettings {
  normalization: CoaccNormalization;
  /** accessibility, nucleosome, small_fp, linker, all_fp or size:lo-hi (the panel's signal types). */
  signalType: string;
  /** Bin width (bp); 0: automatic (about 150 bins). */
  binBp: number;
  /** Cells with fewer co-covering reads are blank. */
  minCoverage: number;
  /** A FiberHMM layer the signal is read from (null: the default calls). */
  layer: string | null;
  /** Colour scaling of the values (log and sqrt draw negatives at the low end: they have no log or root). */
  scaling: 'linear' | 'log' | 'sqrt';
}

export const COACC_NORMALIZATIONS: readonly { value: CoaccNormalization; label: string; help: string; signed: boolean }[] = [
  { value: 'correlation', label: 'Correlation', help: 'Pearson correlation of two positions\' accessibility over the reads covering both (−1..1).', signed: true },
  { value: 'raw', label: 'Co-accessibility', help: 'The share of reads covering both positions that are accessible at both.', signed: false },
  { value: 'oe', label: 'Observed / expected', help: 'Co-accessibility over the product of the two positions\' accessibility.', signed: false },
  { value: 'oe_distance', label: 'O / E by distance', help: 'Co-accessibility over the mean at that distance.', signed: false },
];

export const DEFAULT_COACC_SETTINGS: CoaccSettings = Object.freeze({ normalization: 'correlation', signalType: 'accessibility', binBp: 0, minCoverage: 20, layer: null, scaling: 'linear' }) as CoaccSettings;

export function normalizeCoaccSettings(raw: unknown): CoaccSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_COACC_SETTINGS;
  const num = (v: unknown, lo: number, hi: number, dv: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : dv);
  return {
    normalization: COACC_NORMALIZATIONS.some(n => n.value === r.normalization) ? r.normalization as CoaccNormalization : d.normalization,
    signalType: typeof r.signalType === 'string' && /^(accessibility|nucleosome|small_fp|linker|all_fp|size:\d+-\d+)$/.test(r.signalType) ? r.signalType : d.signalType,
    binBp: num(r.binBp, 0, 10000, d.binBp),
    minCoverage: num(r.minCoverage, 1, 10000, d.minCoverage),
    layer: typeof r.layer === 'string' && r.layer.length > 0 && r.layer.length < 80 ? r.layer : null,
    scaling: r.scaling === 'log' || r.scaling === 'sqrt' ? r.scaling : 'linear',
  };
}

/** The axis and origin of supplied series: x of value i = x0 + i * dx. */
export interface SuppliedSpec {
  /** The panel and view that made it ("Nucleosomes › Local repeat length"). */
  origin: string;
  x0: number;
  dx: number;
  xLabel: string;
  yLabel: string;
  /** Tick labels (left, middle, right); absent: numbers. */
  xTicks?: [string, string, string];
  /** The series are of a quantity, not reads: Compare A − B / log2 work, smoothing applies, normalisation does not. */
  note?: string;
  /** What the numbers measure (which reads or molecules, the sample, the bins), shown in the plot's header. */
  measures?: string;
  /** Supplied matrices (V-plots, heatmaps): x of column j = x0 + j * dx; rows labelled; signed values centre on 0. */
  matrix?: { kind: 'vplot' | 'heatmap'; x0: number; dx: number; valueLabel: string; signed?: boolean; xLabel?: string };
  /** Quantify a window (features/windowQuant): the spec, the window and the bounds it was computed over; the values are
   *  in the card (SuppliedData.quant). */
  quant?: QuantRecord;
}

export interface QuantRecord {
  spec: import('../windowQuant/spec').QuantSpec;
  window: import('../windowQuant/spec').QuantWindow | null;
  bounds: { chrom: string; from: number; to: number; kind: 'window' | 'region' | 'sites' };
  /** The axis frame (a relative window is relative to this anchor) and the anchor as resolved when computed. */
  axis?: import('../windowQuant/axisFrame').AxisFrame;
  anchor?: { pos: number; strand: '+' | '-'; name: string } | null;
}

export function normalizeQuantRecord(raw: unknown): QuantRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const b = r.bounds && typeof r.bounds === 'object' ? r.bounds as Record<string, unknown> : null;
  if (!b || typeof b.chrom !== 'string' || !Number.isFinite(Number(b.from)) || !Number.isFinite(Number(b.to))) return null;
  const kind = b.kind === 'window' || b.kind === 'sites' ? b.kind : 'region';
  const a = r.anchor && typeof r.anchor === 'object' ? r.anchor as Record<string, unknown> : null;
  const anchor = a && Number.isFinite(Number(a.pos)) ? { pos: Number(a.pos), strand: a.strand === '-' ? '-' as const : '+' as const, name: typeof a.name === 'string' ? a.name.slice(0, 200) : '' } : null;
  return { spec: normalizeQuantSpec(r.spec), window: normalizeQuantWindow(r.window), bounds: { chrom: b.chrom, from: Number(b.from), to: Number(b.to), kind },
    ...(r.axis ? { axis: normalizeAxisFrame(r.axis) } : {}), ...(anchor ? { anchor } : {}) };
}

export function normalizeSupplied(raw: unknown): SuppliedSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : '');
  const ticks = Array.isArray(r.xTicks) && r.xTicks.length === 3 && r.xTicks.every(t => typeof t === 'string') ? r.xTicks as [string, string, string] : undefined;
  const m = r.matrix && typeof r.matrix === 'object' ? r.matrix as Record<string, unknown> : null;
  const matrix = m ? { kind: m.kind === 'vplot' ? 'vplot' as const : 'heatmap' as const, x0: num(m.x0, 0), dx: num(m.dx, 1) || 1, valueLabel: str(m.valueLabel),
    ...(m.signed === true ? { signed: true } : {}), ...(str(m.xLabel) ? { xLabel: str(m.xLabel) } : {}) } : null;
  return { origin: str(r.origin) || 'a panel', x0: num(r.x0, 0), dx: num(r.dx, 1) || 1, xLabel: str(r.xLabel), yLabel: str(r.yLabel), ...(ticks ? { xTicks: ticks } : {}),
    ...(str(r.note) ? { note: str(r.note) } : {}), ...(typeof r.measures === 'string' && r.measures ? { measures: r.measures.slice(0, 2000) } : {}), ...(matrix ? { matrix } : {}),
    ...(r.quant ? (q => (q ? { quant: q } : {}))(normalizeQuantRecord(r.quant)) : {}) };
}

export type DiffFeatures = 'peaks' | 'classes' | 'geometries' | 'hub-selection' | 'all';
export type DiffTest = 'fisher' | 'chi2';

/** Differential features: every alternative a parameter with a default. */
export interface DiffSettings {
  /** The features tested: the hub's sets in view of one kind, the hub selection, or every set with per-read states. */
  features: DiffFeatures;
  test: DiffTest;
  /** CMH over equal-count bins of the reads' m6A per kb (A and B compared at matched marking density). */
  densityMatch: boolean;
  densityBins: number;
  /** CMH over replicates: A's i-th dataset paired with B's i-th (datasets), or each dataset (clusters, read groups). */
  replicateAware: boolean;
  /** Evaluated reads needed on each side for a test. */
  minReads: number;
  /** Thresholds drawn on the volcano and used for the up / down calls. */
  qMax: number;
  deltaMin: number;
  /** Group by dataset: the datasets on each side (empty: the first and the second dataset). */
  sideA: string[];
  sideB: string[];
  /** Features tested at most (by position). */
  maxFeatures: number;
}

export const DIFF_FEATURES: readonly { value: DiffFeatures; label: string; help: string }[] = [
  { value: 'peaks', label: 'Peaks', help: 'The peaks in view (each peak rule\'s), per read open (MSP over the peak) or not.' },
  { value: 'classes', label: 'Footprint classes', help: 'The classes of the shown Find classes run in view: per read a member or not (of the reads the class was scored on).' },
  { value: 'geometries', label: 'Nucleosome geometries', help: 'The shared regularity geometries of the Nucleosomes panel in view: per read carrying it or not.' },
  { value: 'hub-selection', label: 'Hub selection', help: 'The hits selected in the Feature hub (any kind with per-read states).' },
  { value: 'all', label: 'All in view', help: 'Every hub set in view with per-read states.' },
];

export const DEFAULT_DIFF_SETTINGS: DiffSettings = Object.freeze({
  features: 'peaks', test: 'fisher', densityMatch: false, densityBins: 5, replicateAware: false, minReads: 5, qMax: 0.05, deltaMin: 0.1,
  sideA: [] as string[], sideB: [] as string[], maxFeatures: 500,
}) as DiffSettings;

export function normalizeDiffSettings(raw: unknown): DiffSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_DIFF_SETTINGS;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 64) : []);
  const num = (v: unknown, lo: number, hi: number, dv: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dv);
  return {
    features: DIFF_FEATURES.some(f => f.value === r.features) ? r.features as DiffFeatures : d.features,
    test: r.test === 'chi2' ? 'chi2' : 'fisher',
    densityMatch: r.densityMatch === true,
    densityBins: Math.round(num(r.densityBins, 2, 10, d.densityBins)),
    replicateAware: r.replicateAware === true,
    minReads: Math.round(num(r.minReads, 1, 1000, d.minReads)),
    qMax: num(r.qMax, 1e-6, 1, d.qMax),
    deltaMin: num(r.deltaMin, 0, 1, d.deltaMin),
    sideA: ids(r.sideA), sideB: ids(r.sideB),
    maxFeatures: Math.round(num(r.maxFeatures, 1, 2000, d.maxFeatures)),
  };
}

export type HistogramNormalization = 'density' | 'count' | 'per-read';
export type HistogramWeighting = 'count' | 'bp';
export type HistogramInclusion = 'midpoint' | 'overlap' | 'clipped';

/** Footprint size histogram: every alternative a parameter with a default. */
export interface HistogramSettings {
  binBp: number;
  sizeMin: number;
  sizeMax: number;
  /** density (Fraction): the group's share in each size bin; count (Raw); per-read: per read touching the regions. */
  normalization: HistogramNormalization;
  /** Gaussian sigma along sizes, bp (0 = off). */
  sigmaBp: number;
  /** count: each footprint counts 1; bp: its length (Fraction then shows the share of footprint-covered bp). */
  weighting: HistogramWeighting;
  /** midpoint inside the region; any overlap; or clipped (overlapping, and under bp only the bp inside count). */
  inclusion: HistogramInclusion;
  /** Size axis on a log scale. */
  logX: boolean;
  /** Size-class guide lines (bp), drawn when on (TF < 90 / nucleosome ≥ 90 by default). */
  guidesOn: boolean;
  guides: number[];
}

export const HISTOGRAM_NORMALIZATIONS: readonly { value: HistogramNormalization; label: string; help: string }[] = [
  { value: 'count', label: 'Raw', help: 'Footprints (or bp, under bp weighting) in each size bin.' },
  { value: 'density', label: 'Fraction', help: 'The group\'s share in each size bin (sums to 1): of its footprints, or of its footprint-covered bp under bp weighting.' },
  { value: 'per-read', label: 'Per read', help: 'Per read touching the regions (a read in two regions counts in each).' },
];

export const HISTOGRAM_WEIGHTINGS: readonly { value: HistogramWeighting; label: string; help: string }[] = [
  { value: 'count', label: 'Count', help: 'Each footprint counts 1.' },
  { value: 'bp', label: 'bp covered', help: 'Each footprint counts its length (clipped: its bp inside the region).' },
];

export const HISTOGRAM_INCLUSIONS: readonly { value: HistogramInclusion; label: string; help: string }[] = [
  { value: 'midpoint', label: 'Midpoint inside', help: 'A footprint counts in a region when its midpoint is inside.' },
  { value: 'overlap', label: 'Any overlap', help: 'A footprint counts in every region it overlaps (whole).' },
  { value: 'clipped', label: 'Clipped to the region', help: 'Overlapping footprints; under bp weighting only their bp inside the region count.' },
];

export const DEFAULT_HISTOGRAM_SETTINGS: HistogramSettings = Object.freeze({ binBp: 5, sizeMin: 0, sizeMax: 400, normalization: 'density', sigmaBp: 0,
  weighting: 'count', inclusion: 'midpoint', logX: false, guidesOn: false, guides: [90] as number[] }) as HistogramSettings;

export function normalizeHistogramSettings(raw: unknown): HistogramSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_HISTOGRAM_SETTINGS;
  const binBp = clampNum(r.binBp, 1, 200, d.binBp);
  const sizeMin = clampNum(r.sizeMin, 0, 5000, d.sizeMin);
  const guides = Array.isArray(r.guides) ? r.guides.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0).slice(0, 8).map(Math.round) : [...d.guides];
  return {
    binBp, sizeMin, sizeMax: Math.max(sizeMin + binBp, clampNum(r.sizeMax, 1, 20000, d.sizeMax)),
    normalization: HISTOGRAM_NORMALIZATIONS.some(n => n.value === r.normalization) ? r.normalization as HistogramNormalization : d.normalization,
    sigmaBp: clampNum(r.sigmaBp, 0, 1000, d.sigmaBp),
    weighting: r.weighting === 'bp' ? 'bp' : 'count',
    inclusion: HISTOGRAM_INCLUSIONS.some(n => n.value === r.inclusion) ? r.inclusion as HistogramInclusion : d.inclusion,
    logX: r.logX === true,
    guidesOn: r.guidesOn === true,
    guides,
  };
}

/** Region heatmap rows: by the mean signal in a window (default: the whole window), the signal at the centre, k-means
 *  clusters of the rows (seeded), the BED file's order, or a BED column (score). */
export type HeatmapSort = 'mean' | 'centre' | 'cluster' | 'bed' | 'score';

export const HEATMAP_SORTS: readonly { value: HeatmapSort; label: string; help: string }[] = [
  { value: 'mean', label: 'Mean signal', help: 'By the mean signal in the sort window (the whole window unless set), high first, within each group.' },
  { value: 'centre', label: 'Signal at centre', help: 'By the signal in the centre bin (the anchor), high first.' },
  { value: 'cluster', label: 'Clusters (k-means)', help: 'k-means of the rows (their profiles in every group), seeded with the plot\'s seed: row blocks per cluster, a profile per cluster.' },
  { value: 'bed', label: 'BED order', help: 'As the regions are in the BED file (selected features: by position).' },
  { value: 'score', label: 'BED column', help: 'By a numeric column of the BED file (5: score), high first.' },
];

/** Heatmap settings: every alternative a parameter with a default. */
export interface HeatmapSettings {
  /** Rows sorted within each group (HEATMAP_SORTS). */
  sort: HeatmapSort;
  /** Mean signal: the window it is taken over, in the x axis' bp (null: the whole window). */
  sortFrom: number | null;
  sortTo: number | null;
  /** Clusters: k. */
  k: number;
  /** BED column (1-based; 5 = score). */
  scoreColumn: number;
  /** Rows drawn (more are thinned evenly, keeping the order). */
  maxRows: number;
  /** Features × position: the window around each feature's centre (bp). */
  windowBp: number;
  /** Features × position: features read at most (the first selected, by position). */
  maxFeatures: number;
}

export const DEFAULT_HEATMAP_SETTINGS: HeatmapSettings = Object.freeze({ sort: 'mean', sortFrom: null, sortTo: null, k: 3, scoreColumn: 5, maxRows: 400, windowBp: 1000, maxFeatures: 200 }) as HeatmapSettings;

export function normalizeHeatmapSettings(raw: unknown): HeatmapSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_HEATMAP_SETTINGS;
  return {
    // Before the region heatmap: 'signal' (by mean) and 'start' (by position).
    sort: r.sort === 'start' ? 'bed' : HEATMAP_SORTS.some(x => x.value === r.sort) ? r.sort as HeatmapSort : 'mean',
    sortFrom: typeof r.sortFrom === 'number' && Number.isFinite(r.sortFrom) ? Math.round(r.sortFrom) : null,
    sortTo: typeof r.sortTo === 'number' && Number.isFinite(r.sortTo) ? Math.round(r.sortTo) : null,
    k: clampNum(r.k, 2, 12, d.k),
    scoreColumn: clampNum(r.scoreColumn, 4, 30, d.scoreColumn),
    maxRows: clampNum(r.maxRows, 10, 5000, d.maxRows),
    windowBp: clampNum(r.windowBp, 20, 200000, d.windowBp),
    maxFeatures: clampNum(r.maxFeatures, 1, 5000, d.maxFeatures),
  };
}

/** Metaprofile settings: every alternative a parameter with a default (profileEngine.ts). */
export interface ProfileSettings {
  binBp: number;
  /** Gaussian sigma along positions, bp (0 = off). */
  sigmaBp: number;
  normalization: ProfileNormalization;
  /** Bins covered by fewer reads are blank. */
  minCoverage: number;
  /** Reads sampled per dataset (the server's display sample, seeded). */
  readCap: number;
  /** Size bands of the source's footprints (inner edges, bp): default < 90, 90–200, > 200. */
  bandEdges: number[];
  /** 'off': every footprint; a band index: only footprints of that band; 'each': one line per band. */
  band: 'off' | 'each' | number;
  /** Group reads by their state at the anchor (view or feature centre): open, TF-sized or nucleosome-sized footprint. */
  conditionOn: boolean;
  /** The anchor window: centre ± this many bp. */
  conditionBp: number;
  /** Footprints at least this long are nucleosome-sized (shorter: TF-sized). */
  conditionNucBp: number;
  /** Several sources: 'auto' (one panel per group with every source overlaid when there are several groups, else
   *  one chart), 'panels' (always one panel per group) or 'overlay' (one chart; groups told apart by dash). */
  multiLayout: 'auto' | 'panels' | 'overlay';
  /** Several sources in panels: one y range across the panels ('shared') or each its own ('own'). */
  multiYScale: 'shared' | 'own';
}

export const PROFILE_NORMALIZATIONS: readonly { value: ProfileNormalization; label: string; help: string }[] = [
  { value: 'fraction', label: 'Fraction of reads', help: 'The share of reads covering each position that have the source there (marks: per read per bp).' },
  { value: 'count', label: 'Counts', help: 'Reads with the source at each position (marks: marks per bin).' },
  { value: 'relative', label: 'Relative to window', help: 'The fraction over its mean across the window: 1 = average here.' },
];

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = Object.freeze({ binBp: 10, sigmaBp: 20, normalization: 'fraction', minCoverage: 5, readCap: 2000,
  bandEdges: [90, 200] as number[], band: 'off', conditionOn: false, conditionBp: 10, conditionNucBp: 90, multiLayout: 'auto', multiYScale: 'shared' }) as ProfileSettings;

const clampNum = (v: unknown, lo: number, hi: number, d: number, int = true): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return int ? Math.round(n) : n;
};

export function normalizeProfileSettings(raw: unknown): ProfileSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PROFILE_SETTINGS;
  return {
    binBp: clampNum(r.binBp, 1, 10000, d.binBp),
    sigmaBp: clampNum(r.sigmaBp, 0, 100000, d.sigmaBp),
    normalization: PROFILE_NORMALIZATIONS.some(n => n.value === r.normalization) ? r.normalization as ProfileNormalization : d.normalization,
    minCoverage: clampNum(r.minCoverage, 0, 100000, d.minCoverage),
    readCap: clampNum(r.readCap, 50, 20000, d.readCap),
    ...normalizeBands(r),
    conditionOn: r.conditionOn === true,
    conditionBp: clampNum(r.conditionBp, 0, 5000, d.conditionBp),
    conditionNucBp: clampNum(r.conditionNucBp, 1, 1000, d.conditionNucBp),
    multiLayout: r.multiLayout === 'panels' || r.multiLayout === 'overlay' ? r.multiLayout : 'auto',
    multiYScale: r.multiYScale === 'own' ? 'own' : 'shared',
  };
}

function normalizeBands(r: Record<string, unknown>): Pick<ProfileSettings, 'bandEdges' | 'band'> {
  const edges = Array.isArray(r.bandEdges)
    ? [...new Set(r.bandEdges.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0).map(Math.round))].sort((a, b) => a - b).slice(0, 8)
    : [...DEFAULT_PROFILE_SETTINGS.bandEdges];
  const band = r.band === 'each' ? 'each' : typeof r.band === 'number' && Number.isInteger(r.band) && r.band >= 0 && r.band <= edges.length ? r.band : 'off';
  return { bandEdges: edges.length ? edges : [...DEFAULT_PROFILE_SETTINGS.bandEdges], band };
}

/** "< 90 bp", "90–200 bp", "> 200 bp" (band i of the edges). */
export function bandLabel(edges: number[], i: number): string {
  if (i === 0) return `< ${edges[0]} bp`;
  if (i >= edges.length) return `≥ ${edges[edges.length - 1]} bp`;
  return `${edges[i - 1]}–${edges[i]} bp`;
}

export const PLOTS_STATE_VERSION = 1;
/** How long a Follow plot waits after the view stops moving before it recomputes (ms). */
export const DEFAULT_FOLLOW_DELAY_MS = 300;
export const MIN_FOLLOW_DELAY_MS = 0;
export const MAX_FOLLOW_DELAY_MS = 5000;

export interface PlotTypeInfo {
  type: PlotType;
  label: string;
  /** Drawn in this build. */
  available: boolean;
  /** The phase that brings it (for "coming soon"). */
  phase?: number;
  help: string;
}

export const PLOT_TYPES: readonly PlotTypeInfo[] = [
  { type: 'size-enrichment', label: 'Size enrichment', available: true,
    help: 'Footprint size by position, each size row over its mean across the window: where each footprint size is enriched.' },
  { type: 'vplot', label: 'V-plot', available: true,
    help: 'The classic V-plot: each footprint counted once at its midpoint, by size.' },
  { type: 'metaprofile', label: 'Metaprofile', available: true, help: 'Signal along position, one line per group: the share of reads with the source at each position.' },
  { type: 'heatmap', label: 'Heatmap', available: true, help: 'One row per region (selected features or BED regions), its signal across the window, with the metaprofile on top; sorted by mean, centre, k-means clusters, BED order or a BED column. Magma; comparisons RdBu.' },
  { type: 'size-histogram', label: 'Size histogram', available: true, help: 'Footprint sizes over the view, selected features or BED region sets, one line per group: counts or bp covered, by midpoint, overlap or clipped, raw, fraction or per read.' },
  { type: 'differential', label: 'Differential features', available: true,
    help: 'One test per feature (peaks, footprint classes, nucleosome geometries) between A and B: the share of reads open or occupied, Fisher / chi-squared or CMH, BH q; volcano, MA and a table.' },
  { type: 'nuc-spacing', label: 'Nucleosome spacing', available: false, phase: 5, help: 'Nucleosome repeat, autocorrelation and patches: open them from the Nucleosomes panel (Open in Plots on each chart); its run computes them.' },
  { type: 'co-accessibility', label: 'Co-accessibility', available: true, help: 'Position × position co-opening over the view, per dataset (the Co-accessibility panel\'s numbers): correlation on RdBu centred on 0, the others on magma; Compare A − B.' },
];

export const PLOT_WHERE: readonly { value: PlotWhere; label: string; available: boolean; phase?: number; help: string; types?: readonly PlotType[] }[] = [
  { value: 'view', label: 'Current view', available: true, help: 'The view the browser shows; a Follow plot moves with it.' },
  { value: 'features', label: 'Selected features', available: true, types: ['heatmap', 'metaprofile', 'size-histogram'], help: 'The selected peaks, each centred in a window (pinned to the selection): one row each (heatmap) or pooled (metaprofile).' },
  { value: 'random', label: 'Random reads (whole file)', available: true, types: ['size-histogram'],
    help: 'N reads drawn at random from each dataset\'s whole BAM, whatever the locus (seeded: the same seed gives the same reads), proportionally across contigs; primary mapped reads only. For plots that need no anchor.' },
  { value: 'bed', label: 'BED region sets', available: true, types: ['metaprofile', 'heatmap', 'size-histogram', 'size-enrichment', 'vplot'], help: 'The regions of one or more BED files, each a group: anchored (centre, start = TSS, end; strand-aware) or scaled, subsampled, with an occlusion filter (pinned).' },
];

export const PLOT_GROUP_BY: readonly { value: PlotGroupBy; label: string; available: boolean; phase?: number; help: string; types?: readonly PlotType[] }[] = [
  { value: 'none', label: 'None', available: true, help: 'Every dataset pooled into one: counts are summed before normalising, so it is the same as one dataset of all the reads.' },
  { value: 'dataset', label: 'Dataset', available: true, help: 'One plot per dataset, all its reads in view.' },
  { value: 'cluster', label: 'Cluster', available: true, help: 'One plot per cluster of the current clustering.' },
  { value: 'classes', label: 'Selected classes', available: true, help: 'One group per selected footprint class (or feature): the reads that are members (a read can be in several).' },
  { value: 'read-groups', label: 'Read groups', available: true, help: 'One group per split panel (Split into panels: alleles, SV carriers, patterns): its reads.' },
  { value: 'bed', label: 'BED file', available: false, phase: 3, help: 'Each BED file a group.' },
];

export const PLOT_COMPARE: readonly { value: PlotCompare; label: string; available: boolean; phase?: number; help: string; types?: readonly PlotType[] }[] = [
  { value: 'off', label: 'Off', available: true, help: 'Each group on its own.' },
  { value: 'diff', label: 'A − B', available: true, types: ['size-enrichment', 'vplot', 'metaprofile', 'heatmap', 'size-histogram', 'co-accessibility'], help: 'A minus B, around 0 (red above, blue below; RdBu centred on 0). Size plots: the difference of size shares, each side over its own total.' },
  { value: 'log2ratio', label: 'log2 ratio', available: true, help: 'log2 ratio of footprint size distributions: each group vs the rest, vs all, or A vs B; RdBu_r centred on 0, one scale.' },
];

/** Whether a Where choice works for a plot type (Selected features: heatmaps for now). */
export const whereAvailable = (w: (typeof PLOT_WHERE)[number], type: PlotType): boolean => w.available && (!w.types || w.types.includes(type))
  // The heatmap is per region (selected features or BED regions); its reads × position mode over the view is retired.
  && !(type === 'heatmap' && w.value === 'view');

/** Why a Where does not apply to a type (the disabled pill's tooltip), or null. */
export function whereBlockedReason(w: (typeof PLOT_WHERE)[number], type: PlotType): string | null {
  if (whereAvailable(w, type)) return null;
  if (w.value === 'view' && type === 'heatmap') return 'The heatmap is per region: selected features or BED regions (its reads × position mode over the view redrew the read track and was retired).';
  if (w.value === 'random') return 'Random reads of the whole file have no common position: this type plots along an anchor (positions around a locus or feature). Use a size histogram, or a view / BED set.';
  return null;
}

/** Whether a Group by choice works for a plot type (None: profiles only for now). */
export const groupAvailable = (g: (typeof PLOT_GROUP_BY)[number], type: PlotType): boolean => g.available && (!g.types || g.types.includes(type))
  // Differential features compare two groups: datasets, clusters, or read groups / classes.
  && !(type === 'differential' && (g.value === 'none' || g.value === 'bed'))
  // Co-accessibility: per dataset, or the datasets pooled (the panel's Combined).
  && !(type === 'co-accessibility' && g.value !== 'dataset' && g.value !== 'none');

/** Whether a Compare choice works for a plot type (A − B: profiles only for now). */
export const compareAvailable = (c: (typeof PLOT_COMPARE)[number], type: PlotType): boolean => c.available && (!c.types || c.types.includes(type))
  && !(type === 'differential' && c.value !== 'off')
  && !(type === 'co-accessibility' && c.value === 'log2ratio');

/** The layers that hold single-base marks, not footprints: listed as sources, disabled for the size types. */
export const MARK_SOURCES = new Set(['m6a', 'mod', 'm5c']);

export const isSizeType = (t: PlotType): boolean => t === 'size-enrichment' || t === 'vplot';
export const isProfileType = (t: PlotType): boolean => t === 'metaprofile' || t === 'heatmap';
export const isLineType = (t: PlotType): boolean => t === 'metaprofile' || t === 'size-histogram';
export const plotTypeInfo = (t: PlotType): PlotTypeInfo => PLOT_TYPES.find(p => p.type === t) ?? PLOT_TYPES[0];
const viewOfType = (t: PlotType): FootprintSizeView => (t === 'vplot' ? 'vplot' : 'enrichment');

let counter = 0;
/** A new plot id (unique within the page and across sessions in practice). */
export function newPlotId(): string {
  counter += 1;
  return `plot-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** The size settings a type starts from: its view preset over the defaults (magma / RdBu_r by colour mode). */
export function sizeSettingsForType(type: PlotType, base: FootprintSizeSettings = DEFAULT_FOOTPRINT_SIZE_SETTINGS): FootprintSizeSettings {
  return normalizeFootprintSizeSettings({ ...base, ...FOOTPRINT_SIZE_VIEW_PRESETS[viewOfType(type)] });
}

/** A new plot: Size enrichment of all footprints in the current view, by dataset, following the view. */
export function newPlot(patch: Partial<PlotSpec> = {}): PlotSpec {
  const type = patch.type ?? 'size-enrichment';
  return normalizePlot({
    id: newPlotId(), name: '', type, source: ALL_FOOTPRINTS, where: type === 'heatmap' ? 'features' : 'view', groupBy: 'dataset', compare: 'off',
    compareMode: 'auto', compareAB: null, pinned: null, size: sizeSettingsForType(type), profile: DEFAULT_PROFILE_SETTINGS, heatmap: DEFAULT_HEATMAP_SETTINGS, hist: DEFAULT_HISTOGRAM_SETTINGS, bed: DEFAULT_BED_SETTINGS, diff: DEFAULT_DIFF_SETTINGS, coacc: DEFAULT_COACC_SETTINGS, sampling: DEFAULT_SAMPLING, summary: DEFAULT_SUMMARY, ...patch,
  });
}

/** Set a plot's type (the size types switch between their view presets; others keep the settings). */
export function withType(plot: PlotSpec, type: PlotType): PlotSpec {
  if (type === plot.type) return plot;
  // A size type always takes its own view preset (a V-plot from a Metaprofile is a V-plot: midpoints, counts).
  const size = isSizeType(type) && plot.type !== type ? sizeSettingsForType(type, plot.size) : plot.size;
  // A single-source type keeps the first selected source (sourcesForType); marks have no footprint sizes, so a size
  // plot of a mark source plots all footprints instead.
  const sources = sourcesForType(type, plotSources(plot));
  const source = sources[0];
  const where = type === 'heatmap' && (plot.where === 'view' || plot.where === 'random') ? 'features'
    : (type !== 'heatmap' && type !== 'metaprofile' && type !== 'size-histogram' && (plot.where === 'features' || (plot.where === 'bed' && !isSizeType(type))))
    || (type !== 'size-histogram' && plot.where === 'random') ? 'view' : plot.where;
  if (type === 'co-accessibility') {
    const groupBy = plot.groupBy === 'none' ? 'none' : 'dataset';
    return { ...plot, type, size, source, sources, where: 'view', compare: plot.compare === 'diff' ? 'diff' : 'off', groupBy };
  }
  if (type === 'differential') {
    const groupBy = plot.groupBy === 'none' || plot.groupBy === 'bed' ? 'dataset' : plot.groupBy;
    return { ...plot, type, size, source, sources, where: 'view', compare: 'off', groupBy };
  }
  return { ...plot, type, size, source, sources, where };
}

const PLOT_TYPE_SET = new Set<PlotType>(PLOT_TYPES.map(p => p.type));

function normalizeLocus(v: unknown): PlotLocus | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const start = Number(r.start), end = Number(r.end);
  if (typeof r.chrom !== 'string' || !r.chrom || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { chrom: r.chrom, start: Math.round(start), end: Math.round(end), genome: typeof r.genome === 'string' && r.genome ? r.genome : null };
}

const oneOf = <T extends string>(v: unknown, options: readonly { value: T }[], fallback: T): T =>
  options.some(o => o.value === v) ? v as T : fallback;

/** A stored plot as a plot (anything malformed falls back to that field's default; a plot needs an id). */
export function normalizePlot(raw: unknown): PlotSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const type: PlotType = PLOT_TYPE_SET.has(r.type as PlotType) ? r.type as PlotType : 'size-enrichment';
  const where = oneOf(r.where, PLOT_WHERE, 'view');
  const ab = Array.isArray(r.compareAB) && r.compareAB.length === 2 && r.compareAB.every(k => typeof k === 'string' && k)
    && r.compareAB[0] !== r.compareAB[1] ? [r.compareAB[0], r.compareAB[1]] as [string, string] : null;
  const size = normalizeFootprintSizeSettings(r.size ?? sizeSettingsForType(type));
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newPlotId(),
    name: typeof r.name === 'string' ? r.name.slice(0, 200) : '',
    type,
    ...normalizeSources(r, type),
    where,
    groupBy: oneOf(r.groupBy, PLOT_GROUP_BY, 'dataset'),
    compare: oneOf(r.compare, PLOT_COMPARE, 'off'),
    compareMode: oneOf(r.compareMode, COMPARE_MODES, 'auto'),
    compareAB: ab,
    // BED and feature-set plots never follow the view.
    pinned: normalizeLocus(r.pinned),
    ...(typeof r.panel === 'string' && r.panel ? { panel: r.panel } : {}),
    ...(r.sizeCompareOn === 'enrichment' ? { sizeCompareOn: 'enrichment' as const } : {}),
    // The plot-level fields own source, grouping and ratio: keep the copy in `size` neutral.
    size: { ...size, ratio: null },
    profile: normalizeProfileSettings(r.profile),
    heatmap: normalizeHeatmapSettings(r.heatmap),
    hist: normalizeHistogramSettings(r.hist),
    bed: normalizeBedSettings(r.bed),
    diff: normalizeDiffSettings(r.diff),
    coacc: normalizeCoaccSettings(r.coacc),
    summary: normalizeSummary(r.summary),
    // Old plots kept their BED region seed as the plot's seed.
    sampling: normalizeSampling(r.sampling ?? (r.bed && typeof r.bed === 'object' && typeof (r.bed as Record<string, unknown>).seed === 'number' ? { seed: (r.bed as Record<string, unknown>).seed } : undefined)),
    ...(r.supplied ? { supplied: normalizeSupplied(r.supplied) } : {}),
    ...(r.axis && typeof r.axis === 'object' && (r.axis as Record<string, unknown>).mode === 'relative' ? { axis: normalizeAxisFrame(r.axis) } : {}),
  };
}

/** The size settings a plot's request uses: its own, with its source, grouping and log2(A/B) pair. */
export function effectiveSizeSettings(plot: PlotSpec, ratio: [string, string] | null = null): FootprintSizeSettings {
  return {
    ...plot.size,
    layer: plot.source,
    groupBy: plot.groupBy === 'cluster' ? 'clusters' : 'datasets',
    ratio: plot.compare === 'log2ratio' ? ratio : null,
  };
}

export const followsView = (plot: Pick<PlotSpec, 'pinned' | 'where'>): boolean => plot.where === 'view' && plot.pinned == null;

/** "1,010,000–1,012,000" with the chromosome: what a header says a plot was computed for. */
export function formatLocus(l: Pick<PlotLocus, 'chrom' | 'start' | 'end'> | null | undefined): string {
  if (!l) return '—';
  return `${l.chrom}:${(Math.round(l.start) + 1).toLocaleString('en-US')}–${Math.round(l.end).toLocaleString('en-US')}`;
}

export function formatWidth(bp: number): string {
  if (bp >= 1e6) return `${(bp / 1e6).toFixed(bp >= 1e7 ? 0 : 1)} Mb`;
  if (bp >= 1e3) return `${(bp / 1e3).toFixed(bp >= 1e4 ? 0 : 1)} kb`;
  return `${Math.round(bp)} bp`;
}

/** "Size enrichment · All footprints · current view · by dataset" (a plot's title line and saved-card meta). */
export function describePlot(plot: PlotSpec): string {
  const where = PLOT_WHERE.find(w => w.value === plot.where)?.label.toLowerCase() ?? 'current view';
  const group = plot.groupBy === 'none' ? null : `by ${PLOT_GROUP_BY.find(g => g.value === plot.groupBy)?.label.toLowerCase()}`;
  const compare = plot.compare === 'off' ? null : PLOT_COMPARE.find(c => c.value === plot.compare)?.label;
  if (plot.type === 'differential') {
    const feats = DIFF_FEATURES.find(f => f.value === plot.diff.features)?.label ?? 'Peaks';
    const strata = [plot.diff.densityMatch ? 'density matched' : null, plot.diff.replicateAware ? 'replicates' : null].filter(Boolean).join(', ');
    return [plotTypeInfo(plot.type).label, feats, where, group, strata || null].filter(Boolean).join(' · ');
  }
  if (plot.type === 'co-accessibility') {
    // Its own signal and normalisation (the Source picker does not apply).
    const norm = COACC_NORMALIZATIONS.find(n => n.value === plot.coacc.normalization)?.label;
    const signal = COACC_SIGNAL_LABELS[plot.coacc.signalType] ?? plot.coacc.signalType;
    return [plotTypeInfo(plot.type).label, `${signal}${plot.coacc.layer ? ` (${plot.coacc.layer})` : ''}`, norm, where, group, compare].filter(Boolean).join(' · ');
  }
  return [plotTypeInfo(plot.type).label, plotSources(plot).map(s => sourceLabel(s, plot.sourceLabels)).join(' + '), where, group, compare].filter(Boolean).join(' · ');
}

/** The co-accessibility signals as the panel named them. */
export const COACC_SIGNAL_LABELS: Record<string, string> = { accessibility: 'Accessibility', nucleosome: 'Nucleosome', small_fp: 'Small footprint', linker: 'Linker', all_fp: 'All footprints' };

/** The name a plot shows: its own, else its description. */
export const plotDisplayName = (plot: PlotSpec): string => plot.name.trim() || describePlot(plot);

/** A copy under a new id, named "… (copy)". */
export function duplicatePlot(plot: PlotSpec): PlotSpec {
  return { ...plot, id: newPlotId(), name: `${plotDisplayName(plot)} (copy)`, sources: [...plotSources(plot)], ...(plot.sourceLabels ? { sourceLabels: { ...plot.sourceLabels } } : {}), size: { ...plot.size }, profile: { ...plot.profile, bandEdges: [...plot.profile.bandEdges] }, heatmap: { ...plot.heatmap }, hist: { ...plot.hist, guides: [...plot.hist.guides] }, bed: { ...plot.bed, setIds: [...plot.bed.setIds] }, diff: { ...plot.diff, sideA: [...plot.diff.sideA], sideB: [...plot.diff.sideB] }, coacc: { ...plot.coacc }, sampling: { ...plot.sampling }, summary: { ...plot.summary } };
}

// ------------------------------------------------------------------ several sources
/** The types that draw several sources at once (one line per source per group). Size histograms, V-plots, size
 *  enrichment and heatmaps draw one: a size distribution or a matrix per source would need its own axis. */
export const MULTI_SOURCE_TYPES: readonly PlotType[] = ['metaprofile'];
export const isMultiSourceType = (t: PlotType): boolean => MULTI_SOURCE_TYPES.includes(t);
/** Sources one plot draws at most (more lines than this stop being readable). */
export const MAX_SOURCES = 8;

/** A source's name: the Layers toolbar's for a layer, the stored name for a family. */
export function sourceLabel(src: string, labels?: Record<string, string>): string {
  if (labels?.[src]) return labels[src];
  if (src.startsWith('fam:')) return src.slice(src.lastIndexOf('|') + 1);
  return footprintSizeLayerLabel(src);
}

/**
 * The sources a plot draws. `sources` when it agrees with `source`; a writer that set only `source` (an older session,
 * a panel's Open in Plots, a `{ source }` patch through updateCurrentPlot, which does not normalise) wins: one
 * source. Single-source types draw the first.
 */
export function plotSources(plot: Pick<PlotSpec, 'type' | 'source'> & { sources?: unknown }): string[] {
  const list = Array.isArray(plot.sources) ? plot.sources.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 300) : [];
  const ok = list.length > 0 && (plot.source == null || list[0] === plot.source);
  const out = ok ? [...new Set(list)] : [plot.source || ALL_FOOTPRINTS];
  return isMultiSourceType(plot.type) ? out.slice(0, MAX_SOURCES) : out.slice(0, 1);
}

/** The sources a type keeps: all (capped) for a multi-source type; else the first selected (marks become all
 *  footprints for the size types, which have no mark sizes). */
export function sourcesForType(type: PlotType, sources: string[]): string[] {
  const list = sources.length ? sources : [ALL_FOOTPRINTS];
  if (isMultiSourceType(type)) return list.slice(0, MAX_SOURCES);
  // One source: the first layer (a feature family is a metaprofile source only: it has no footprints to size or bin).
  const first = list.find(x => !x.startsWith('fam:')) ?? ALL_FOOTPRINTS;
  return [(isSizeType(type) || type === 'size-histogram') && MARK_SOURCES.has(first) ? ALL_FOOTPRINTS : first];
}

/** A plot with these sources (`source` follows the first; family names kept for the ones drawn). */
export function withSources<T extends PlotSpec>(plot: T, sources: string[], labels: Record<string, string> = {}): T {
  const list = sourcesForType(plot.type, [...new Set(sources)]);
  const merged = { ...(plot.sourceLabels ?? {}), ...labels };
  const kept = Object.fromEntries(list.filter(s => merged[s]).map(s => [s, merged[s]]));
  const { sourceLabels: _old, ...rest } = plot;
  return { ...rest, source: list[0], sources: list, ...(Object.keys(kept).length ? { sourceLabels: kept } : {}) } as T;
}

/** Whether a source is a mark layer (marks per read per bp: an axis of its own, never mixed with intervals). */
export const isMarkSource = (src: string): boolean => MARK_SOURCES.has(src);

/** Why `src` can't join the selected sources (null: it can). Marks are per bp and intervals a fraction of reads. */
export function sourceMixBlocker(selected: string[], src: string): string | null {
  if (selected.includes(src)) return null;
  const marks = selected.some(isMarkSource);
  if (isMarkSource(src) && selected.length && !marks) return 'm6A is marks per read per bp, the others a fraction of reads: it replaces them (one axis per plot).';
  if (!isMarkSource(src) && marks) return 'm6A is marks per read per bp, this a fraction of reads: it replaces m6A (one axis per plot).';
  return null;
}

/**
 * The sources after a chip click. Single-source types: the chip alone. Multi-source: toggles it; at least one stays
 * (the last one can't be cleared); a mark source and interval sources never mix (the click replaces them); at most
 * MAX_SOURCES (the oldest selected beyond that is dropped).
 */
export function toggleSource(type: PlotType, selected: string[], src: string): string[] {
  if (!isMultiSourceType(type)) return [src];
  if (selected.includes(src)) return selected.length > 1 ? selected.filter(s => s !== src) : selected;
  if (sourceMixBlocker(selected, src)) return [src];
  const next = [...selected, src];
  return next.length > MAX_SOURCES ? next.slice(next.length - MAX_SOURCES) : next;
}

function normalizeSources(r: Record<string, unknown>, type: PlotType): Pick<PlotSpec, 'source' | 'sources' | 'sourceLabels'> {
  // Older plots and sessions: `source` alone (normalised as before: null / '' were the Nuc layer, ...).
  const source = normalizeFootprintSizeLayer(r.source);
  const raw = Array.isArray(r.sources) ? r.sources.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 300) : [];
  const fromList = raw.length ? raw.map(x => (x.startsWith('fam:') ? x : normalizeFootprintSizeLayer(x))) : [];
  const sources = plotSources({ type, source: r.source === undefined && fromList.length ? fromList[0] : source, sources: fromList });
  const rawLabels = r.sourceLabels && typeof r.sourceLabels === 'object' ? r.sourceLabels as Record<string, unknown> : {};
  const labels = Object.fromEntries(sources.filter(s => typeof rawLabels[s] === 'string').map(s => [s, String(rawLabels[s]).slice(0, 200)]));
  return { source: sources[0], sources, ...(Object.keys(labels).length ? { sourceLabels: labels } : {}) };
}
