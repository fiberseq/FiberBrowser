/**
 * The metaprofile as chart series, from its groups' raw profiles: the one place that finishes profiles (normalise,
 * smooth, mask) and makes comparisons, so the live plot, Gallery cards and exports draw the same thing.
 * Comparisons (A − B, log2 A/B): each vs rest, each vs all or A vs B, with "rest" and "all" pooled exactly (raw sums),
 * drawn around 0 with red above and blue below (the comparative RdBu).
 */
import { drawProfileLines, profileRange, type ProfileLinesChartProps, type ProfileSeries } from '../../components/charts/ProfileLinesChart';
import { comparisons as sizeComparisons, resolveCompareMode, type ResolvedCompareMode } from './compare';
import { compareProfiles, finishProfile, poolProfiles, type RawProfile } from './profileEngine';
import type { PlotSpec } from './plotModel';
import type { SummaryPair } from './summary';
import type { ProfileGroup } from './useProfileData';
import { PROFILE_NORMALIZATIONS, samplingText } from './plotModel';

export interface ProfileFigure {
  series: ProfileSeries[];
  comparing: boolean;
  mode: ResolvedCompareMode | null;
  /** The comparisons drawn, in chart order (empty: not comparing). */
  pairs: SummaryPair[];
  signed: boolean;
  yLabel: string;
}

const yLabelOf = (plot: PlotSpec): string => {
  const marks = plot.source === 'm6a';
  if (plot.profile.normalization === 'count') return marks ? 'marks per bin' : 'reads';
  if (plot.profile.normalization === 'relative') return 'relative to window mean';
  return marks ? 'marks per read per bp' : 'fraction of reads';
};

/** A profile of marks (m6A) along position: its 'fraction' is per read per bp (finishProfile's marksPerBp). */
export const isMarkProfile = (plot: PlotSpec): boolean => plot.source === 'm6a' && plot.type !== 'size-histogram' && !plot.supplied;

/** The comparisons a profile plot draws (null: not comparing): each vs rest, each vs all or A vs B, as the size plots
 *  pair groups, with the groups pooled on each side. The figure and its summary both read this. */
export function profilePairs(plot: PlotSpec, groups: Array<{ id: string; title: string }>): { mode: ResolvedCompareMode; pairs: SummaryPair[] } | null {
  if (plot.compare === 'off' || groups.length < 2) return null;
  const mode = resolveCompareMode(plot.compareMode, plot.groupBy, groups.length);
  const panelOf = (id: string) => id.slice(0, id.lastIndexOf('|'));
  // The comparison pairs are the same as for size plots: reuse its pairing on stand-in matrices, then pool raw.
  const comps = sizeComparisons(groups.map(g => ({ id: g.id, title: g.title, panelKey: panelOf(g.id), matrix: [[1]] })), mode, plot.compareAB);
  const pairs = comps.map(c => {
    const pool = groups.filter(g => panelOf(g.id) === panelOf(c.a));
    const scope = pool.length > 1 ? pool : groups;
    const b = c.b === 'rest' ? scope.filter(g => g.id !== c.a).map(g => g.id) : c.b === 'all' ? scope.map(g => g.id) : [c.b];
    return { id: c.id, label: c.label, a: [c.a], b };
  });
  return { mode, pairs };
}

export function profileFigure(plot: PlotSpec, groups: ProfileGroup[], binBp: number): ProfileFigure {
  const opts = { normalization: plot.profile.normalization, sigmaBp: plot.profile.sigmaBp, minCoverage: plot.profile.minCoverage, binBp, marksPerBp: isMarkProfile(plot) };
  const op = plot.compare === 'diff' ? 'diff' as const : plot.compare === 'log2ratio' ? 'log2ratio' as const : null;
  const paired = op ? profilePairs(plot, groups) : null;
  if (op && paired) {
    const rawOf = (id: string) => groups.find(g => g.id === id)!.raw;
    const side = (ids: string[], name: string): RawProfile => (ids.length === 1 ? rawOf(ids[0]) : poolProfiles(ids.map(rawOf), name));
    const series = paired.pairs.map(c => ({ id: c.id, label: c.label, color: '#1f1f1e',
      values: compareProfiles(finishProfile(side(c.a, 'a'), opts), finishProfile(side(c.b, c.id.endsWith('~all') ? 'all' : 'rest'), opts), op) }));
    const unit = PROFILE_NORMALIZATIONS.find(n => n.value === plot.profile.normalization)?.label.toLowerCase() ?? '';
    return { series, comparing: true, mode: paired.mode, pairs: paired.pairs, signed: true, yLabel: op === 'diff' ? `Δ ${unit}` : `log2 ratio (${unit})` };
  }
  return {
    series: groups.map(g => ({ id: g.id, label: g.title, color: g.color ?? '#52514e', ...(g.dash ? { dash: g.dash } : {}), values: finishProfile(g.raw, opts) })),
    comparing: false, mode: null, pairs: [], signed: false, yLabel: yLabelOf(plot),
  };
}

/** One chart per comparison (each on the shared symmetric range), or one chart of all groups. */
export function profileCharts(fig: ProfileFigure, base: Omit<ProfileLinesChartProps, 'series' | 'yLabel' | 'signed'>): ProfileLinesChartProps[] {
  if (!fig.comparing) return [{ ...base, series: fig.series, yLabel: fig.yLabel }];
  const range = profileRange(fig.series, true);
  return fig.series.map(s => ({ ...base, title: s.label, series: [s], yLabel: fig.yLabel, signed: true, yRange: range, filename: `${base.filename}_${s.label.replace(/[^\w.-]+/g, '_')}` }));
}

/** The charts stacked into one figure (exports, Gallery). */
export function profileFigureDraw(charts: ProfileLinesChartProps[], title: string) {
  const gap = 10;
  const cw = charts[0]?.width ?? 600, ch = charts[0]?.height ?? 260;
  const head = title ? 22 : 0;
  const w = cw;
  const h = head + charts.length * (ch + gap) - gap;
  const draw = (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    if (title) { ctx.fillStyle = '#1f1f1e'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(title, 4, 15); }
    charts.forEach((c, i) => { ctx.save(); ctx.translate(0, head + i * (ch + gap)); drawProfileLines(ctx, cw, ch, c); ctx.restore(); });
  };
  return { w, h, draw };
}

export function profileThumbnail(chart: ProfileLinesChartProps | undefined, w = 168, h = 104): string {
  if (!chart || typeof document === 'undefined') return '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    drawProfileLines(ctx, w, h, { ...chart, width: w, height: h, title: undefined, subtitle: undefined });
    const url = canvas.toDataURL('image/jpeg', 0.72);
    return url.startsWith('data:image/jpeg') ? url : '';
  } catch {
    return '';
  }
}

/** The groups as TSV: position, then one column per series. */
export function profileTsv(plot: PlotSpec, fig: ProfileFigure, start: number, binBp: number, locus: string): string {
  const sizes = plot.type === 'size-histogram';
  const head = [`# plot: ${plot.name || 'Metaprofile'}`, `# computed_for: ${locus}`, `# source: ${plot.source}`,
    `# normalization: ${plot.profile.normalization}`, `# gaussian_sigma_bp: ${plot.profile.sigmaBp}`, `# min_coverage: ${plot.profile.minCoverage}`,
    `# bin_bp: ${binBp}`, `# value: ${fig.yLabel}`, `# sampling: ${samplingText(plot.sampling, plot.where === 'random')}`];
  const n = fig.series[0]?.values.length ?? 0;
  const rows = [[sizes ? 'size_bp' : 'position', ...fig.series.map(s => s.label)].join('\t')];
  for (let i = 0; i < n; i++) rows.push([start + i * binBp + (sizes ? 0 : 1), ...fig.series.map(s => (s.values[i] == null ? 'NA' : String(+(s.values[i] as number).toPrecision(6))))].join('\t'));
  return [...head, ...rows].join('\n');
}
