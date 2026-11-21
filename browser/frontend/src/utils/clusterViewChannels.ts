/**
 * Cluster view channels: which signal the cluster metaprofiles show, and what the read map's dots are coloured by.
 *
 * - Metaprofile channels come from the layer registry (getMetaprofileSourceEntries over the loaded datasets), so a
 *   layer a dataset adds later (a scan's custom layer, a nucpatch layer) appears without a change here. Two
 *   regularity channels (the nucreg layer's tile score and period, mean per position) are computed on demand by the
 *   Regularity view's endpoint.
 * - `null` channels = the Default: what the default metaprofile shows (utils/defaultMetaprofile.ts), which follows
 *   the read layers switched on in Tracks unless that track is set to manual.
 * - Map colours: the cluster (default), the dataset, or a per-molecule value summarised from the reads the panel
 *   already holds (span, m6A per kb, each layer's share of the molecule, regularity median / max, the layer at a
 *   position).
 */
import type { CompactRead } from '../components/tracks/read-track/types';
import { getLayerColor, getLayerLabel, getMetaprofileSourceEntries } from './layerColors';
import { NUC_PATCH_LOW_COLOR, NUC_REG_RAMP, NUC_UNDRAWN_LAYERS, nucGeoColor, nucRegRampColor, nucRegRows, type NucPatchKind } from './nucLayers';
import { MAP_COLOR_CLUSTER } from './clusterViewSettings';

export const REG_SCORE_CHANNEL = 'nucreg.score';
export const REG_PERIOD_CHANNEL = 'nucreg.period';
export const REGULARITY_CHANNELS: ReadonlySet<string> = new Set([REG_SCORE_CHANNEL, REG_PERIOD_CHANNEL]);
/** The fraction of a cluster's molecules in a regularity patch at each position (/api/nuc/geometries, on demand). */
export const PATCH_SHARE_CHANNEL = 'nucpatch.share';
/** The fraction of a cluster's molecules in a low-regularity patch at each position. */
export const PATCH_SHARE_LOW_CHANNEL = 'nucpatch.shareLow';
/** Map colour: the high-regularity patch geometry a molecule carries (its root geometry; 0 = none). */
export const MAP_COLOR_GEOMETRY = 'geo';
/** Map colour: the low-regularity patch geometry a molecule carries. */
export const MAP_COLOR_GEOMETRY_LOW = 'geoLow';
export const isGeometryColor = (id: string) => id === MAP_COLOR_GEOMETRY || id === MAP_COLOR_GEOMETRY_LOW;
/** The patch kind a geometry colour shows. */
export const geometryColorKind = (id: string): NucPatchKind => (id === MAP_COLOR_GEOMETRY_LOW ? 'low' : 'high');

export interface ProfileChannel {
  key: string;
  label: string;
  title: string;
  color: string;
  kind: 'layer' | 'regularity' | 'patch';
}

type ChannelDataset = Parameters<typeof getMetaprofileSourceEntries>[0][number] & { data_type?: string };

/** Layers that never give a meaningful presence profile (per-call marks, segments, tiles, per-molecule scalars). */
const NOT_A_PROFILE: ReadonlySet<string> = new Set([...NUC_UNDRAWN_LAYERS, 'deam_opportunity']);

/** The key a per-cluster profile is stored under (ReadTrack: footprint is aliased to nuc, msp is fire). */
export function profileKeyOf(layer: string): string {
  if (layer === 'footprint') return 'nuc';
  if (layer === 'msp') return 'fire';
  return layer;
}

export function isRegularityChannel(key: string): boolean {
  return REGULARITY_CHANNELS.has(key);
}

export function isPatchChannel(key: string): boolean {
  return key === PATCH_SHARE_CHANNEL || key === PATCH_SHARE_LOW_CHANNEL;
}

/** Every channel a cluster metaprofile can show for these datasets, in registry order, then regularity. */
export function clusterProfileChannelOptions(datasets: ChannelDataset[]): ProfileChannel[] {
  const out: ProfileChannel[] = [];
  const seen = new Set<string>();
  for (const entry of getMetaprofileSourceEntries(datasets)) {
    if (NOT_A_PROFILE.has(entry.key)) continue;
    const key = profileKeyOf(entry.key);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: entry.label, title: entry.title, color: entry.color ?? getLayerColor(key), kind: 'layer' });
  }
  // Regularity is a nucleosome-engine product: offered for read-level (BAM) datasets.
  const readLevel = datasets.some(d => !d.data_type || d.data_type === 'bam' || d.data_type === 'bam_livelift');
  if (readLevel) {
    out.push({ key: REG_SCORE_CHANNEL, label: 'Regularity score', kind: 'regularity', color: getLayerColor('nucreg'),
      title: 'Mean regularity tile score (log2) along the region, per cluster (the nucreg layer; computed on demand, as in the nucleosome panel\'s Regularity view)' });
    out.push({ key: REG_PERIOD_CHANNEL, label: 'Regularity period', kind: 'regularity', color: '#20528c',
      title: 'Mean local repeat length (bp) of the regularity tiles along the region, per cluster (computed on demand)' });
    // Patches are the geometry analysis's (nucpatch is drawn on its own canvas, so it isn't a layer presence channel).
    out.push({ key: PATCH_SHARE_CHANNEL, label: 'High patch share', kind: 'patch', color: getLayerColor('nucpatch'),
      title: 'Fraction of the cluster\'s molecules in a high-regularity patch at each position (the nucleosome panel\'s patch section; computed on demand)' });
    out.push({ key: PATCH_SHARE_LOW_CHANNEL, label: 'Low patch share', kind: 'patch', color: NUC_PATCH_LOW_COLOR,
      title: 'Fraction of the cluster\'s molecules in a low-regularity patch at each position (computed on demand)' });
  }
  return out;
}

/** The profile keys on show: the chosen channels, else (null or empty) the default metaprofile's (defaultMetaprofileToggles). */
export function resolveProfileChannels(channels: readonly string[] | null | undefined, defaultToggles: Record<string, boolean>): string[] {
  if (channels && channels.length > 0) return [...channels];
  return Object.entries(defaultToggles).filter(([, v]) => v).map(([k]) => k);
}

export function channelLabel(key: string): string {
  if (key === REG_SCORE_CHANNEL) return 'Regularity score';
  if (key === REG_PERIOD_CHANNEL) return 'Regularity period';
  if (key === PATCH_SHARE_CHANNEL) return 'High patch share';
  if (key === PATCH_SHARE_LOW_CHANNEL) return 'Low patch share';
  return getLayerLabel(key);
}

export function channelColor(key: string): string {
  if (key === REG_SCORE_CHANNEL) return getLayerColor('nucreg');
  if (key === REG_PERIOD_CHANNEL) return '#20528c';
  if (key === PATCH_SHARE_CHANNEL) return getLayerColor('nucpatch');
  if (key === PATCH_SHARE_LOW_CHANNEL) return NUC_PATCH_LOW_COLOR;
  return getLayerColor(key);
}

/** The read-payload layer a channel needs on the reads (null: none, e.g. regularity, served by its own endpoint). */
export function channelPayloadLayer(key: string): string | null {
  if (isRegularityChannel(key) || isPatchChannel(key)) return null;
  return key;
}

/**
 * A binned track along reference coordinates (bin i spans edges[i]..edges[i+1]; null = no data) resampled onto
 * `bins` equal bins over [start, end): each output bin takes the track bin holding its centre. A bin without a
 * measurement (the server left it null: too few molecules or no scored tile) and a bin outside the track's coverage
 * stay missing (NaN: a gap in the profile line), never interpolated or extrapolated. All-empty: [].
 */
export function resampleTrack(edges: readonly number[], values: ReadonlyArray<number | null | undefined>,
  start: number, end: number, bins = 500): number[] {
  if (!(end > start) || edges.length < 2 || !values.some(v => v != null && Number.isFinite(v))) return [];
  const out: number[] = new Array(bins).fill(NaN);
  const width = (end - start) / bins;
  let j = 0, any = false;
  for (let i = 0; i < bins; i++) {
    const centre = start + (i + 0.5) * width;
    while (j < edges.length - 2 && edges[j + 1] <= centre) j++;
    if (centre < edges[0] || centre >= edges[edges.length - 1]) continue;
    const v = values[j];
    if (v != null && Number.isFinite(v)) { out[i] = v; any = true; }
  }
  return any ? out : [];
}

// ---------------------------------------------------------------------------
// Per-molecule summaries (map colours)

export interface MoleculeSummary {
  /** The molecule's span in the loaded reads (bp). */
  span: number;
  /** m6A calls per kb over that span (null: no m6A on the read). */
  m6aPerKb: number | null;
  /** Each layer's share of the span inside the view (0..1), by profile key. */
  frac: Record<string, number>;
  /** Regularity tile score median / maximum (log2; null without tiles). */
  regMedian: number | null;
  regMax: number | null;
}

const isScalarOrMark = (name: string) => NOT_A_PROFILE.has(name);

function clippedLength(intervals: ReadonlyArray<readonly [number, number, number]>, lo: number, hi: number): number {
  // Calls of one layer don't overlap; sum the clipped lengths of the positive-size intervals.
  let total = 0;
  for (const [a, b, size] of intervals) {
    if (size <= 0) continue;
    const s = Math.max(lo, a), e = Math.min(hi, b);
    if (e > s) total += e - s;
  }
  return total;
}

/** One read's summary over a view `viewWidth` bp wide (positions are view-relative). */
export function summarizeMolecule(read: CompactRead, viewWidth: number): MoleculeSummary {
  let readStart = Infinity, readEnd = -Infinity;
  for (const [s, e] of read.intervals ?? []) {
    if (s < readStart) readStart = s;
    if (e > readEnd) readEnd = e;
  }
  if (read.layers) {
    for (const layer of Object.values(read.layers)) {
      for (const [s, e] of layer?.intervals ?? []) {
        if (s < readStart) readStart = s;
        if (e > readEnd) readEnd = e;
      }
    }
  }
  const span = readEnd > readStart ? readEnd - readStart : 0;
  const lo = Math.max(0, readStart), hi = Math.min(viewWidth, readEnd);
  const inView = hi > lo ? hi - lo : 0;
  const marks = read.methyl_m6a ?? read.methyl;
  const m6aPerKb = marks && span > 0 ? marks.length / (span / 1000) : null;
  const frac: Record<string, number> = {};
  if (inView > 0) {
    if (read.layers) {
      for (const [name, layer] of Object.entries(read.layers)) {
        if (isScalarOrMark(name) || !layer?.intervals?.length) continue;
        const key = profileKeyOf(name);
        if (key in frac && name === 'footprint') continue;   // an explicit nuc layer wins over the legacy alias
        frac[key] = Math.min(1, clippedLength(layer.intervals, lo, hi) / inView);
      }
    }
    if (!('fire' in frac) && read.fire?.length) {
      frac.fire = Math.min(1, clippedLength(read.fire.map(([s, e]) => [s, e, 1] as [number, number, number]), lo, hi) / inView);
    }
  }
  let regMedian: number | null = null, regMax: number | null = null;
  const rows = nucRegRows(read.layers?.nucreg as Parameters<typeof nucRegRows>[0]);
  if (rows && rows.tiles.length) {
    const scores = rows.tiles.map(t => t.score).sort((a, b) => a - b);
    const n = scores.length;
    regMedian = n % 2 ? scores[n >> 1] : 0.5 * (scores[n / 2 - 1] + scores[n / 2]);
    regMax = scores[n - 1];
  }
  return { span, m6aPerKb, frac, regMedian, regMax };
}

/** The layer covering a view-relative position on a read: a footprint layer first (tf, nuc), then accessibility, then
 * any other layer; 'linker' inside the read without a call; null outside the read. */
export function layerStateAt(read: CompactRead, pos: number): string | null {
  let readStart = Infinity, readEnd = -Infinity;
  for (const [s, e] of read.intervals ?? []) {
    if (s < readStart) readStart = s;
    if (e > readEnd) readEnd = e;
  }
  const layers = read.layers ?? {};
  const covers = (ivs: ReadonlyArray<readonly [number, number, number]> | undefined) =>
    !!ivs?.some(([s, e, size]) => size > 0 && s <= pos && pos < e);
  for (const layer of Object.values(layers)) {
    for (const [s, e] of layer?.intervals ?? []) {
      if (s < readStart) readStart = s;
      if (e > readEnd) readEnd = e;
    }
  }
  if (!(readStart <= pos && pos < readEnd)) return null;
  const order = ['tf', 'nuc', 'footprint', 'fire', 'msp'];
  for (const name of order) {
    if (covers(layers[name]?.intervals)) return profileKeyOf(name);
  }
  if (covers(read.fire?.map(([s, e]) => [s, e, 1] as [number, number, number]))) return 'fire';
  for (const [name, layer] of Object.entries(layers)) {
    if (order.includes(name) || isScalarOrMark(name)) continue;
    if (covers(layer?.intervals)) return profileKeyOf(name);
  }
  // Primary footprints of a read without explicit nuc/tf layers.
  if (!layers.nuc && !layers.tf && covers(read.intervals)) return 'nuc';
  return 'linker';
}

/** The ids a projection may name a read by (its analysis id and its row id). */
export function readKeys(read: CompactRead): string[] {
  return read.analysis_id && read.analysis_id !== read.id ? [read.analysis_id, read.id] : [read.id];
}

// ---------------------------------------------------------------------------
// Map colours

export { MAP_COLOR_CLUSTER };

export interface MapColorOption { id: string; label: string; group: 'Groups' | 'Molecule' | 'Regularity' | 'Layer share' | 'Position' }

/** What the map can be coloured by, given the layers the summarised reads carry. */
export function mapColorOptions(fracLayers: readonly string[]): MapColorOption[] {
  return [
    { id: MAP_COLOR_CLUSTER, label: 'Cluster', group: 'Groups' },
    { id: 'dataset', label: 'Dataset', group: 'Groups' },
    { id: 'reg.median', label: 'Regularity (median)', group: 'Regularity' },
    { id: 'reg.max', label: 'Regularity (max)', group: 'Regularity' },
    { id: MAP_COLOR_GEOMETRY, label: 'High-regularity geometry carried', group: 'Regularity' },
    { id: MAP_COLOR_GEOMETRY_LOW, label: 'Low-regularity geometry carried', group: 'Regularity' },
    ...fracLayers.map(k => ({ id: `frac:${k}`, label: `${getLayerLabel(k)} share`, group: 'Layer share' as const })),
    { id: 'm6a', label: 'm6A per kb', group: 'Molecule' },
    { id: 'span', label: 'Read length (span)', group: 'Molecule' },
    { id: 'state', label: 'Layer at position', group: 'Position' },
  ];
}

export const isRegularityColor = (id: string) => id === 'reg.median' || id === 'reg.max';

const LOW = '#eef0f3';
const hex = (h: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})/i.exec(h);
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
function lerpHex(a: string, b: string, t: number): string {
  const x = hex(a), y = hex(b);
  const f = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * f)},${Math.round(x[1] + (y[1] - x[1]) * f)},${Math.round(x[2] + (y[2] - x[2]) * f)})`;
}

/** The ramp a numeric colour uses: the regularity lane's ramp, else pale to the layer's own colour. */
export function rampFor(id: string): { color: (t: number) => string; stops: string[] } {
  if (isRegularityColor(id)) return { color: nucRegRampColor, stops: [...NUC_REG_RAMP] };
  const top = id.startsWith('frac:') ? getLayerColor(id.slice(5)) : id === 'm6a' ? getLayerColor('m6a') : '#334155';
  return { color: t => lerpHex(LOW, top, t), stops: [LOW, top] };
}

export type MapLegend =
  | { kind: 'none' }
  | { kind: 'ramp'; label: string; min: number; max: number; stops: string[]; missing: number }
  | { kind: 'categories'; label: string; items: Array<{ key: string; label: string; color: string; count: number }>; missing: number };

export const STATE_COLORS: Record<string, string> = { linker: '#cbd5e1' };
/** Geometry carried: molecules carrying no geometry. */
export const GEOMETRY_NONE_COLOR = '#cbd5e1';

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/** The numeric value of a colour for one summary (null: missing). */
export function numericValue(id: string, s: MoleculeSummary | undefined): number | null {
  if (!s) return null;
  if (id === 'reg.median') return s.regMedian;
  if (id === 'reg.max') return s.regMax;
  if (id === 'm6a') return s.m6aPerKb;
  if (id === 'span') return s.span > 0 ? s.span : null;
  if (id.startsWith('frac:')) return s.frac[id.slice(5)] ?? 0;
  return null;
}

/**
 * Per-point colours for a map coloured by `id` (null for 'cluster': the map draws cluster colours). Numeric colours
 * span the 2nd..98th percentile of the known values (the regularity ramp the same, so outliers don't wash it out);
 * points without a value are null (drawn grey and faint).
 */
export function mapPointColors(id: string, points: {
  readIds: readonly string[];
  datasetIds: readonly string[];
  summaries: (datasetId: string, readId: string) => MoleculeSummary | undefined;
  states?: (datasetId: string, readId: string) => string | null | undefined;
  /** Geometry carried: root geometry number within the colour's kind (0 = none; null/undefined = no patches for the molecule). */
  geometries?: (datasetId: string, readId: string) => number | null | undefined;
  datasetColor: (datasetId: string) => string | undefined;
  datasetLabel: (datasetId: string) => string;
}): { colors: Array<string | null> | null; legend: MapLegend } {
  const n = points.readIds.length;
  if (id === MAP_COLOR_CLUSTER) return { colors: null, legend: { kind: 'none' } };
  if (id === 'dataset') {
    const counts = new Map<string, number>();
    const colors = points.datasetIds.map(ds => {
      counts.set(ds, (counts.get(ds) ?? 0) + 1);
      return points.datasetColor(ds) ?? getLayerColor(ds);
    });
    return { colors, legend: { kind: 'categories', label: 'Dataset', missing: 0,
      items: [...counts].map(([ds, count]) => ({ key: ds, label: points.datasetLabel(ds), color: points.datasetColor(ds) ?? getLayerColor(ds), count })) } };
  }
  if (isGeometryColor(id)) {
    const kind = geometryColorKind(id), L = kind === 'low' ? 'L' : 'G';
    const counts = new Map<number, number>();
    let missing = 0;
    const colors = points.readIds.map((rid, i) => {
      const g = points.geometries?.(points.datasetIds[i], rid);
      if (g == null) { missing++; return null; }
      counts.set(g, (counts.get(g) ?? 0) + 1);
      return g > 0 ? nucGeoColor(g, kind) : GEOMETRY_NONE_COLOR;
    });
    return { colors, legend: { kind: 'categories', label: kind === 'low' ? 'Low-regularity geometry carried' : 'High-regularity geometry carried', missing,
      items: [...counts].sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : a[0] - b[0]))
        .map(([g, count]) => ({ key: String(g), label: g > 0 ? `${L}${g}` : 'None', color: g > 0 ? nucGeoColor(g, kind) : GEOMETRY_NONE_COLOR, count })) } };
  }
  if (id === 'state') {
    const counts = new Map<string, number>();
    let missing = 0;
    const colors = points.readIds.map((rid, i) => {
      const st = points.states?.(points.datasetIds[i], rid);
      if (!st) { missing++; return null; }
      counts.set(st, (counts.get(st) ?? 0) + 1);
      return STATE_COLORS[st] ?? getLayerColor(st);
    });
    return { colors, legend: { kind: 'categories', label: 'Layer at position', missing,
      items: [...counts].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, label: key === 'linker' ? 'No call' : getLayerLabel(key), color: STATE_COLORS[key] ?? getLayerColor(key), count })) } };
  }
  const values = new Array<number | null>(n);
  const known: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = numericValue(id, points.summaries(points.datasetIds[i], points.readIds[i]));
    values[i] = v != null && Number.isFinite(v) ? v : null;
    if (values[i] != null) known.push(values[i]!);
  }
  const ramp = rampFor(id);
  const label = mapColorOptions([]).find(o => o.id === id)?.label ?? (id.startsWith('frac:') ? `${getLayerLabel(id.slice(5))} share` : id);
  if (!known.length) return { colors: values.map(() => null), legend: { kind: 'ramp', label, min: 0, max: 0, stops: ramp.stops, missing: n } };
  known.sort((a, b) => a - b);
  let min = quantile(known, 0.02), max = quantile(known, 0.98);
  if (!(max > min)) { min = known[0]; max = known[known.length - 1]; }
  const span = max - min;
  const colors = values.map(v => (v == null ? null : ramp.color(span > 0 ? (v - min) / span : 0.5)));
  return { colors, legend: { kind: 'ramp', label, min, max, stops: ramp.stops, missing: n - known.length } };
}

/** The read-payload layers the cluster views need on the reads (sorted): the chosen layer channels. Empty with the
 * defaults, so the default request is unchanged; map colours add nothing. */
export function clusterViewPayloadLayers(settings: { profileChannels: string[] | null; mapColorBy: string } | null | undefined): string[] {
  if (!settings) return [];
  const out = new Set<string>();
  for (const key of settings.profileChannels ?? []) {
    const layer = channelPayloadLayer(key);
    if (layer) out.add(layer);
  }
  // Map colours never change the read request: they come from /api/cluster_molecules and /api/nuc/regularity.
  return [...out].sort();
}
