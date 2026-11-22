/**
 * The measure registry: what Quantify a window can quantify. A feature adds measures by registering a source, as
 * layers register with the layer registry (getMetaprofileSourceEntries); the picker lists every source's measures
 * grouped under its label, greyed with the reason (and a step button) when they can't be had yet.
 *
 * A measure is:
 * - `id`, `label`, the `source` it is listed under, its `unit` (the axis words) and `kind`:
 *   - 'fraction': per read, bp of a layer over the read's bp in the bounds (bootstrap interval);
 *   - 'rate': marks per bp (bootstrap; shown per kb);
 *   - 'ratio': per read, a count over a count in the bounds (footprints in a size band over all footprints; bootstrap);
 *   - 'share': per read member or not, of the reads the state was evaluated in (Wilson interval);
 *   - 'value': a per-read number, averaged over reads (bootstrap);
 *   - 'group': a series that exists only per group (a stored profile): a window mean, no per-read interval.
 * - `enrichment`: whether a ratio to a baseline means anything (not for a signed log2 score);
 * - `windowed`: the per-read value honours a window (false: per molecule over the whole region, said in the header);
 * - `available`: true, or why not, with the step that makes it available (the Plots prerequisite buttons' pattern).
 *
 * A source's `load` gives, per measure, the units (one per read, or per read-site observation on a meta-locus) keyed
 * `<dataset>\u0001<read name>`, each with its sums (windowMaths UNIT_COLS); group-level measures give values per group.
 * The engine (engine.ts) does the rest: groups, intervals, baselines, comparisons, tests.
 *
 * To add one (e.g. fiberhmm-scan outputs): registerMeasureSource({ id, label, order, list, load }) at startup.
 */
import type { BrowserState } from '../../stores/browserStore';
import type { FootprintSizesClusters, FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import type { UnitSums } from './windowMaths';

export type MeasureKind = 'fraction' | 'rate' | 'ratio' | 'share' | 'value' | 'group';

export interface MeasureStep {
  /** One of the Plots prerequisite steps (its button, running line and progress): preferred when one fits. */
  prereq?: import('../plots/prereqActions').PrereqKind;
  /** Button text ("Find classes"). */
  label: string;
  title?: string;
  /** Run it (true: started; a string: why it did not). */
  run: () => Promise<boolean | string> | boolean | string | void;
}

export interface MeasureDef {
  id: string;
  label: string;
  /** The registry source id it is listed under. */
  source: string;
  kind: MeasureKind;
  /** Axis words for the raw value ("fraction of covered bp", "share of reads"). */
  unit: string;
  color?: string;
  enrichment: boolean;
  windowed: boolean;
  /** Genomic span (families: the class / variant / geometry), for "overlaps the window". */
  span?: [number, number];
  available: true | { reason: string; step?: MeasureStep };
  /** Short note for the header (e.g. "per molecule over the whole region"). */
  note?: string;
}

export interface MeasureContext {
  state: BrowserState;
  view: { chrom: string; start: number; end: number; genome: string | null };
  /** The bounds the numbers are taken over (genomic [from, to)). */
  bounds: { from: number; to: number };
  allReads: FootprintSizesTarget;
  clusters: FootprintSizesClusters | null;
  /** Data some sources get from hooks the caller runs (nucleosome regularity per molecule: 'nuc'). */
  extras: Record<string, unknown>;
}

export interface LoadContext extends MeasureContext {
  /** The size band of the size-band measure. */
  sizeBand: [number, number];
  layerUnits: 'curve' | 'exact';
  readSource: 'panel' | 'fetch';
  readCap: number;
  seed: number;
  flankFraction: number;
  /** Keep every bin of the view per read (curve units), for the flank and dataset baselines. */
  viewBins?: boolean;
  signal?: AbortSignal;
}

/** A read's touched-bin sums over the curve's bins inside the bounds (curve units): `idx` into the bounds' bins. */
export interface BinnedUnit { idx: Int32Array; sig: Float64Array; cov: Float64Array;
  /** The same over every bin of the view (`idx` into the view's grid), kept only for the flank and dataset baselines. */
  all?: { idx: Int32Array; sig: Float64Array; cov: Float64Array } }

export interface MeasureData {
  /** Curve units (a layer read from a panel's profile pool): the per-bin sums of the curve's own binning; the group
   *  value is the curve's mean over the bins in the bounds (each bin weighed by its share inside them). */
  binned?: { weights: Float64Array; units: Map<string, BinnedUnit>; binBp: number;
    /** With full-view bins (units' `all`): the view's bin count and its flank bins (the y-scale's flank rule). */
    res?: number; flank?: Int32Array };
  /** Per-read units: key `<dataset>\u0001<read>` -> sums. */
  units?: Map<string, UnitSums>;
  /** Group-level values (kind 'group'): `<panel key>|<cluster or 'all'>` -> value. */
  groupValues?: Record<string, number | null>;
  /** Reads used / in scope per dataset (sampling), for the header. */
  sampled?: Record<string, { used: number; total?: number }>;
  /** Where the reads came from: the panel's profile pool, or a fresh sample. */
  readSource?: 'panel' | 'fetch';
}

export interface MeasureSource {
  id: string;
  label: string;
  /** Picker order (layers 10, families 20, NFR 30, nucleosomes 40). */
  order: number;
  list: (ctx: MeasureContext) => MeasureDef[];
  load: (measures: MeasureDef[], ctx: LoadContext) => Promise<Record<string, MeasureData>>;
  /** A key that changes when what `load` would answer changes (runs, assignments); part of the request key. */
  signature?: (ctx: MeasureContext) => string;
}

const sources = new Map<string, MeasureSource>();
const listeners = new Set<() => void>();

export function registerMeasureSource(src: MeasureSource): void {
  sources.set(src.id, src);
  for (const fn of listeners) fn();
}

export function measureSources(): MeasureSource[] {
  return [...sources.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function onMeasureSourcesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Every source's measures, grouped, in picker order (a source that throws lists nothing). */
export function listMeasures(ctx: MeasureContext): Array<{ source: MeasureSource; measures: MeasureDef[] }> {
  return measureSources().map(source => {
    let measures: MeasureDef[] = [];
    try { measures = source.list(ctx); } catch { measures = []; }
    return { source, measures };
  });
}

/** The unit key of a read (or read-site observation) in a dataset. */
export const unitKey = (dataset: string, read: string): string => `${dataset}\u0001${read}`;
export const unitParts = (key: string): { dataset: string; read: string } => {
  const i = key.indexOf('\u0001');
  return { dataset: key.slice(0, i), read: key.slice(i + 1) };
};

/** Test helper: forget every source. */
export function clearMeasureSourcesForTests(): void { sources.clear(); }
