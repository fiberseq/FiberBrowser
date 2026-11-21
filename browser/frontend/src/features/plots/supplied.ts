/**
 * Supplied series: plots of a run Plots cannot redo (nucleosome regularity and geometries, NFR shape, plugin data),
 * drawn by Plots from the values the panel computed. A panel calls openSuppliedPlot: the series become a Gallery card
 * (kept exactly, with the browser state), the card opens in Plots, and the plot draws through the profile machinery
 * so Compare (A − B, log2), smoothing, export and the Gallery work as for any line plot.
 *
 * As raw profiles a series is signal = its value and coverage = 1 where it has one (0 where it has none), finished as
 * counts: with smoothing off the drawn values are the supplied values exactly.
 */
import type { RawProfile } from './profileEngine';
import { captureBrowserState, openEntry } from './galleryActions';
import { setWorkspace } from './workspace';
import { recordInGallery, useGalleryStore, type SuppliedData } from './gallery';
import { newPlot, type PlotLocus, type PlotSpec, type PlotType, type SuppliedSpec } from './plotModel';
import type { ProfileGroup } from './useProfileData';

export interface SuppliedInput {
  /** The plot's type id (metaprofile for lines along a genomic axis, size-histogram for distributions, nuc-spacing...). */
  type: PlotType;
  name: string;
  spec: SuppliedSpec;
  series: SuppliedData['series'];
  /** x of each value when not evenly spaced. */
  xs?: number[];
  /** Matrices (supplied V-plots, heatmaps): blocks of labelled rows. */
  matrices?: SuppliedData['matrices'];
  /** Where it was computed (the view or the run's region). */
  locus: PlotLocus;
  datasets: string[];
  note?: string;
  /** Group by the series stand for (dataset, cluster...): only labels Compare's defaults. */
  groupBy?: PlotSpec['groupBy'];
}

/** A supplied series as a raw profile (exact under count finishing with no smoothing). */
export function suppliedRaw(id: string, values: Array<number | null>): RawProfile {
  const n = values.length;
  const coverage = new Float64Array(n), signal = new Float64Array(n);
  values.forEach((v, i) => { if (v != null && Number.isFinite(v)) { coverage[i] = 1; signal[i] = v; } });
  return { group: id, nReads: 1, coverage, signal };
}

export function suppliedGroups(data: SuppliedData): ProfileGroup[] {
  return data.series.map(s => ({ id: s.id, title: s.title, ...(s.color ? { color: s.color } : {}), ...(s.dash ? { dash: s.dash } : {}), raw: suppliedRaw(s.id, s.values) }));
}

/** The plot settings a supplied plot draws with: counts (the values), no smoothing, no coverage mask. */
export function suppliedPlotSpec(input: SuppliedInput): PlotSpec {
  const base = newPlot({ type: input.type });
  return {
    ...base, name: input.name, where: 'view', groupBy: input.groupBy ?? 'dataset', compare: 'off', pinned: input.locus, supplied: input.spec,
    profile: { ...base.profile, normalization: 'count', sigmaBp: 0, minCoverage: 0, binBp: input.spec.dx },
  };
}

export const suppliedRequestKey = (input: SuppliedInput): string => JSON.stringify({ kind: 'fiberbrowser.supplied.v1', origin: input.spec.origin, locus: input.locus,
  series: input.series.map(s => [s.id, s.values.length]), hash: hashValues([...input.series, ...(input.matrices ?? []).flatMap(m => m.rows.map((r, i) => ({ id: `${m.id}:${i}`, title: r.label, values: r.values })))]) });

function hashValues(series: SuppliedData['series']): string {
  let h = 2166136261;
  for (const s of series) for (const v of s.values) {
    const t = v == null ? 'n' : String(v);
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  }
  return (h >>> 0).toString(36);
}

/** Open the series in Plots as a working plot (its card in Current; Keep saves it to the Gallery). The same values
 *  again reopen the same plot. Returns the card id. */
export function openSuppliedPlot(input: SuppliedInput): string | null {
  const same = useGalleryStore.getState().entries.find(e => e.status === 'working' && e.requestKey === suppliedRequestKey(input));
  if (same) { openEntry(same.id); setWorkspace('plots'); return same.id; }
  const plot = suppliedPlotSpec(input);
  const { gallery, entry } = recordInGallery(useGalleryStore.getState(), {
    plot, computedFor: input.locus, requestKey: suppliedRequestKey(input), byPanel: {}, items: [...input.series.map(s => ({ id: s.id, title: s.title, color: s.color })), ...(input.matrices ?? []).map(m => ({ id: m.id, title: m.title, color: m.color }))],
    thumb: '', datasets: input.datasets, name: input.name, supplied: { ...(input.xs ? { xs: input.xs } : {}), ...(input.matrices ? { matrices: input.matrices } : {}), series: input.series }, ...(input.note ? { note: input.note } : {}),
  }, captureBrowserState());
  if (gallery !== useGalleryStore.getState()) useGalleryStore.setState(gallery, true);
  if (!entry) return null;
  openEntry(entry.id);
  setWorkspace('plots');
  return entry.id;
}

/** The series as TSV: x, then one column per series, the values exactly. */
export function suppliedTsv(name: string, spec: SuppliedSpec, data: SuppliedData): string {
  const n = Math.max(0, ...data.series.map(s => s.values.length));
  const head = [`# plot: ${name}`, `# from: ${spec.origin}`, `# x: ${spec.xLabel}`, `# value: ${spec.yLabel}`];
  const rows = [['x', ...data.series.map(s => s.title)].join('\t')];
  for (let i = 0; i < n; i++) rows.push([String(data.xs?.[i] ?? spec.x0 + i * spec.dx), ...data.series.map(s => (s.values[i] == null ? 'NA' : String(s.values[i])))].join('\t'));
  return [...head, ...rows].join('\n');
}

/** Tick labels for a supplied axis (left, middle, right). */
export function suppliedTicks(spec: SuppliedSpec, n: number, xs?: number[]): [string, string, string] {
  if (spec.xTicks) return spec.xTicks;
  if (xs && xs.length) {
    const lo = Math.min(...xs), hi = Math.max(...xs);
    const g = (x: number) => String(+x.toPrecision(4));
    return [g(lo), g((lo + hi) / 2), g(hi)];
  }
  const end = spec.x0 + n * spec.dx;
  const f = (x: number) => (Math.abs(spec.dx) < 1 ? String(+x.toFixed(3)) : Math.round(x).toLocaleString('en-US'));
  return [f(spec.x0), f((spec.x0 + end) / 2), f(end)];
}

/** The x of every value (the card's xs, or x0 + i * dx). */
export function suppliedXs(spec: SuppliedSpec, data: SuppliedData): number[] {
  const n = Math.max(0, ...data.series.map(s => s.values.length));
  return data.xs && data.xs.length === n ? data.xs : Array.from({ length: n }, (_, i) => spec.x0 + i * spec.dx);
}

/** Supplied lines of [x, y] points (the panels' chart shape) as one shared x axis and aligned values. */
export function linesToSupplied(lines: Array<{ key: string; label: string; color?: string; points: Array<[number, number | null]> }>): { xs: number[]; series: SuppliedData['series'] } {
  const xs = [...new Set(lines.flatMap(l => l.points.map(p => p[0])))].sort((a, b) => a - b);
  const at = new Map(xs.map((x, i) => [x, i]));
  return { xs, series: lines.map(l => {
    const values: Array<number | null> = new Array(xs.length).fill(null);
    for (const [x, y] of l.points) values[at.get(x)!] = y == null || !Number.isFinite(y) ? null : y;
    return { id: l.key, title: l.label, ...(l.color ? { color: l.color } : {}), values };
  }) };
}

/** The colour slot of a supplied matrix (the colormap rule): signed values the comparative RdBu, V-plots viridis,
 *  other single heatmaps magma; the plot's own pick for that slot wins (the colormap picker). */
export function suppliedMatrixColormap(plot: PlotSpec): { name: import('../../utils/footprintSizeColormaps').FootprintSizeColormap; reverse: boolean; signed: boolean } {
  const m = plot.supplied?.matrix;
  const slot = m?.signed ? 'comparative' : m?.kind === 'vplot' ? 'vplot' : 'enrichment';
  const c = plot.size.colormaps[slot];
  return { name: c.name, reverse: c.reverse, signed: !!m?.signed };
}

/** Matrices as TSV: one block per matrix, a row per matrix row, x across. */
export function suppliedMatricesTsv(name: string, spec: SuppliedSpec, data: SuppliedData): string {
  const m = spec.matrix;
  const out = [`# plot: ${name}`, `# from: ${spec.origin}`, ...(spec.measures ? [`# measures: ${spec.measures}`] : []), `# value: ${m?.valueLabel ?? ''}`];
  for (const mat of data.matrices ?? []) {
    const n = Math.max(0, ...mat.rows.map(r => r.values.length));
    out.push(`# block: ${mat.title}`, ['row', ...Array.from({ length: n }, (_, j) => String((m?.x0 ?? 0) + j * (m?.dx ?? 1)))].join('\t'));
    for (const r of mat.rows) out.push([r.label, ...r.values.map(v => (v == null ? 'NA' : String(v)))].join('\t'));
  }
  return out.join('\n');
}
