/**
 * Footprint size histogram (Plots Phase 2; replaces the Footprints, Read stats and QC size histograms): the sizes of the
 * source's footprints in the view, per group, on the profile machinery. Each group is a raw profile over size bins
 * (signal = footprints in the bin; coverage = the group's footprints for a density, its reads for per-read, 1 for
 * counts), so finishing, smoothing, exact pooling and Compare are the metaprofile's.
 */
import { finishProfile, type RawProfile } from './profileEngine';
import { profileFigure, type ProfileFigure } from './profileFigure';
import { HISTOGRAM_NORMALIZATIONS, samplingText, type HistogramSettings, type PlotSpec } from './plotModel';
import { footprintSizeLayerLabel } from '../../utils/footprintSizeSettings';
import type { ProfileRead } from './profileEngine';
import type { ProfileGroup } from './useProfileData';

/** Bins of a histogram's size axis. */
export const histogramBins = (h: HistogramSettings): number => Math.max(1, Math.ceil((h.sizeMax - h.sizeMin) / h.binBp));

/**
 * One region's footprint sizes per group, as raw profiles over size bins: signal = the weight in each bin (count, or
 * bp: the footprint's length, or under "clipped" its bp inside the region), coverage = the denominator (fraction: the
 * group's total weight in range; per read: the reads touching the region; raw: 1) so that pooling regions (raw sums)
 * stays exact. A footprint's size is always its whole length.
 */
export function histogramAccumulate(reads: ProfileRead[], region: { start: number; end: number }, h: HistogramSettings, groups: string[]): RawProfile[] {
  const n = histogramBins(h);
  const by = new Map(groups.map(g => [g, { group: g, nReads: 0, coverage: new Float64Array(n), signal: new Float64Array(n), weight: 0 }]));
  for (const r of reads) {
    const p = by.get(r.group);
    if (!p) continue;
    let any = false;
    for (const iv of r.intervals ?? []) {
      const [a0, b0] = iv;
      if (b0 <= a0) continue;
      // The whole footprint: sent whole (BED transport), or clipped to the fetched window (compact reads) with its size.
      const [a, b] = r.whole ? [a0, b0] : originalBounds(a0, b0, iv[2], region);
      // A footprint the fetch cut (it reached past the margin across a deletion): its midpoint is unknown, so it is not
      // taken as one inside the region (its reference span exceeds the margin: rarely centred on the window). Overlap
      // and clipped are exact (the cut is outside the region).
      if (r.whole && iv[3] === 1 && h.inclusion === 'midpoint') continue;
      const mid = (a + b) / 2;
      const inside = h.inclusion === 'midpoint' ? mid >= region.start && mid < region.end : a < region.end && b > region.start;
      if (!inside) continue;
      any = true;
      // The size axis bins the footprint's own size (the third field, as the server size plots do).
      const size = iv[2] ?? b0 - a0;
      if (size < h.sizeMin || size >= h.sizeMax) continue;
      const w = h.weighting === 'count' ? 1 : h.inclusion === 'clipped' ? Math.min(b, region.end) - Math.max(a, region.start) : size;
      p.signal[Math.min(n - 1, Math.floor((size - h.sizeMin) / h.binBp))] += w;
      p.weight += w;
    }
    if (any || (r.start < region.end && r.end > region.start)) p.nReads += 1;
  }
  return [...by.values()].map(p => {
    const denom = h.normalization === 'density' ? p.weight : h.normalization === 'per-read' ? p.nReads : 1;
    p.coverage.fill(denom);
    return { group: p.group, nReads: p.nReads, coverage: p.coverage, signal: p.signal };
  });
}

/** A clipped interval's whole bounds from its size: cut at the region's start, it ends at b; cut at the end, it starts
 *  at a. Cut at both (wider than the region) its offset is unknown: the size is kept, centred on the clipped part. */
export function originalBounds(a: number, b: number, size: number | undefined, region: { start: number; end: number }): [number, number] {
  if (size == null || !(size > b - a)) return [a, b];
  const cutStart = a <= region.start, cutEnd = b >= region.end;
  if (cutStart && !cutEnd) return [b - size, b];
  if (cutEnd && !cutStart) return [a, a + size];
  const mid = (a + b) / 2;
  return [mid - size / 2, mid + size / 2];
}

/** The view's histogram (one region: the view). */
export function histogramRaws(reads: ProfileRead[], groups: Array<{ id: string }>, view: { start: number; end: number }, plot: PlotSpec): RawProfile[] {
  return histogramAccumulate(reads, view, plot.hist, groups.map(g => g.id));
}

/** "Footprints, midpoint in 1,000 regions, count, fraction": what a histogram measures (its header). */
export function histogramMeasures(plot: PlotSpec, scope: string): string {
  const h = plot.hist;
  const inc = h.inclusion === 'midpoint' ? 'midpoint in' : h.inclusion === 'overlap' ? 'overlapping' : 'clipped to';
  const norm = HISTOGRAM_NORMALIZATIONS.find(x => x.value === h.normalization)?.label.toLowerCase() ?? '';
  return `${footprintSizeLayerLabel(plot.source)}, ${inc} ${scope}, ${h.weighting === 'bp' ? 'bp covered' : 'count'}, ${norm}; ${h.sizeMin}–${h.sizeMax} bp in ${h.binBp} bp bins${h.logX ? ', log size axis' : ''}; ${samplingText(plot.sampling, plot.where === 'random')}`;
}

/** Log x: each bin's centre on log10 (the chart places values by x), with size tick labels. */
export function histogramAxis(h: HistogramSettings): { xs?: number[]; xTicks?: [string, string, string]; guides?: number[]; xLabel: string } {
  const n = histogramBins(h);
  const centres = Array.from({ length: n }, (_, i) => h.sizeMin + (i + 0.5) * h.binBp);
  const guides = h.guidesOn ? h.guides : undefined;
  if (!h.logX) return { xLabel: `Footprint size (${h.binBp} bp bins)`, ...(guides ? { guides } : {}) };
  const xs = centres.map(c => Math.log10(Math.max(0.5, c)));
  const lo = xs[0], hi = xs[n - 1];
  const f = (v: number) => `${Math.round(10 ** v)}`;
  return { xs, xTicks: [f(lo), f((lo + hi) / 2), f(hi)], xLabel: `Footprint size (bp, log scale; ${h.binBp} bp bins)`, ...(guides ? { guides: guides.map(g => Math.log10(g)) } : {}) };
}

/** The plot the profile machinery finishes a histogram with (fraction of the denominator, its smoothing, no mask). */
export function histogramAsProfile(plot: PlotSpec): PlotSpec {
  return { ...plot, profile: { ...plot.profile, normalization: plot.hist.normalization === 'count' ? 'count' : 'fraction', sigmaBp: plot.hist.sigmaBp, minCoverage: 0, binBp: plot.hist.binBp } };
}

export function histogramFigure(plot: PlotSpec, groups: ProfileGroup[]): ProfileFigure {
  const fig = profileFigure(histogramAsProfile(plot), groups, plot.hist.binBp);
  const norm = HISTOGRAM_NORMALIZATIONS.find(n => n.value === plot.hist.normalization)?.label.toLowerCase() ?? '';
  const what = plot.hist.weighting === 'bp' ? 'bp covered' : 'footprints';
  const unit = plot.hist.normalization === 'count' ? what : plot.hist.normalization === 'density' ? `fraction of ${what}` : `${what} per read`;
  void norm;
  return { ...fig, yLabel: fig.comparing ? (plot.compare === 'diff' ? `Δ ${unit}` : `log2 ratio (${unit})`) : unit };
}

export { finishProfile };
