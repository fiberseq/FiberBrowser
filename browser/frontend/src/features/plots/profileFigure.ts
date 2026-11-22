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
import { PROFILE_NORMALIZATIONS, plotSources, samplingText, sourceLabel } from './plotModel';
import { baseGroupsOf, isMultiSourceGroups, sourceColor, sourcesOfGroups } from './multiSource';
import { SERIES_DASHES } from '../../components/charts/ProfileLinesChart';

/** Several sources: the panels (one per group, or per comparison) and the series of each; the sources in order. */
export interface ProfileFacets {
  panels: Array<{ id: string; title: string; seriesIds: string[] }>;
  sources: Array<{ id: string; label: string; color: string }>;
  /** Each series' source. */
  sourceOf: Record<string, string>;
  /** 'panels': one chart per panel; 'overlay': one chart of every series. */
  layout: 'panels' | 'overlay';
  yScale: 'shared' | 'own';
}

export interface ProfileFigure {
  series: ProfileSeries[];
  /** Several sources (absent with one: drawn as before). */
  facets?: ProfileFacets;
  comparing: boolean;
  mode: ResolvedCompareMode | null;
  /** The comparisons drawn, in chart order (empty: not comparing). Several sources: one per comparison per source,
   *  each with its `source` and the comparison (`facet`, `facetLabel`) it belongs to. */
  pairs: SummaryPair[];
  signed: boolean;
  yLabel: string;
}

const yLabelOf = (plot: PlotSpec): string => {
  const marks = plotSources(plot).every(s => s === 'm6a');
  if (plot.profile.normalization === 'count') return marks ? 'marks per bin' : 'reads';
  if (plot.profile.normalization === 'relative') return 'relative to window mean';
  return marks ? 'marks per read per bp' : 'fraction of reads';
};

/** A profile of marks (m6A) along position: its 'fraction' is per read per bp (finishProfile's marksPerBp). */
export const isMarkProfile = (plot: PlotSpec): boolean => plotSources(plot).every(s => s === 'm6a') && plot.type !== 'size-histogram' && !plot.supplied;

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

/** The pairs of combined groups (several sources): each source's groups paired as one source's would be (Compare per
 *  source), ids of the combined groups. */
export function multiSourcePairs(plot: PlotSpec, groups: ProfileGroup[]): { mode: ResolvedCompareMode; pairs: ProfileFigure['pairs'] } | null {
  let mode: ResolvedCompareMode | null = null;
  const pairs: ProfileFigure['pairs'] = [];
  for (const src of sourcesOfGroups(groups)) {
    const mine = groups.filter(g => g.source === src);
    const idOf = new Map(mine.map(g => [g.base!, g.id]));
    const paired = profilePairs(plot, mine.map(g => ({ id: g.base!, title: g.baseTitle ?? g.title })));
    if (!paired) continue;
    mode ??= paired.mode;
    for (const p of paired.pairs) pairs.push({ id: `${src}::${p.id}`, label: `${p.label} · ${sourceLabel(src, plot.sourceLabels)}`, a: p.a.map(id => idOf.get(id)!), b: p.b.map(id => idOf.get(id)!),
      source: src, sourceColor: sourceColor(src), sourceLabel: sourceLabel(src, plot.sourceLabels), facet: p.id, facetLabel: p.label });
  }
  return mode ? { mode, pairs } : null;
}

export function profileFigure(plot: PlotSpec, groups: ProfileGroup[], binBp: number): ProfileFigure {
  const opts = { normalization: plot.profile.normalization, sigmaBp: plot.profile.sigmaBp, minCoverage: plot.profile.minCoverage, binBp, marksPerBp: isMarkProfile(plot) };
  const op = plot.compare === 'diff' ? 'diff' as const : plot.compare === 'log2ratio' ? 'log2ratio' as const : null;
  if (isMultiSourceGroups(groups)) return multiSourceFigure(plot, groups, opts, op);
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

/** Several sources: series per group (colour = source), panels per group, or per comparison with Compare on. */
function multiSourceFigure(plot: PlotSpec, groups: ProfileGroup[], opts: Parameters<typeof finishProfile>[1], op: 'diff' | 'log2ratio' | null): ProfileFigure {
  const srcs = sourcesOfGroups(groups);
  const sources = srcs.map(id => ({ id, label: sourceLabel(id, plot.sourceLabels), color: sourceColor(id) }));
  const labelOf = new Map(sources.map(x => [x.id, x.label]));
  const bases = baseGroupsOf(groups);
  // 'auto' and 'panels': one panel per group (one group: one chart); 'overlay': one chart.
  const layout: ProfileFacets['layout'] = plot.profile.multiLayout === 'overlay' ? 'overlay' : 'panels';
  const yScale = plot.profile.multiYScale;
  const paired = op ? multiSourcePairs(plot, groups) : null;
  if (op && paired) {
    const rawOf = (id: string) => groups.find(g => g.id === id)!.raw;
    const side = (ids: string[], name: string): RawProfile => (ids.length === 1 ? rawOf(ids[0]) : poolProfiles(ids.map(rawOf), name));
    const series = paired.pairs.map(c => ({ id: c.id, label: labelOf.get(c.source!) ?? c.source!, color: sourceColor(c.source!),
      values: compareProfiles(finishProfile(side(c.a, 'a'), opts), finishProfile(side(c.b, c.id.endsWith('~all') ? 'all' : 'rest'), opts), op) }));
    const facetOrder: Array<{ id: string; title: string }> = [];
    for (const c of paired.pairs) if (!facetOrder.some(f => f.id === c.facet)) facetOrder.push({ id: c.facet!, title: c.facetLabel! });
    const unit = PROFILE_NORMALIZATIONS.find(n => n.value === plot.profile.normalization)?.label.toLowerCase() ?? '';
    return { series, comparing: true, mode: paired.mode, pairs: paired.pairs, signed: true, yLabel: op === 'diff' ? `Δ ${unit}` : `log2 ratio (${unit})`,
      facets: { panels: facetOrder.map(f => ({ id: f.id, title: f.title, seriesIds: paired.pairs.filter(c => c.facet === f.id).map(c => c.id) })), sources,
        sourceOf: Object.fromEntries(paired.pairs.map(c => [c.id, c.source!])), layout: 'panels', yScale } };
  }
  // Overlay: groups told apart by dash (unless a band or state already dashes them).
  const dashOf = new Map(bases.map((b, i) => [b.id, SERIES_DASHES[i % SERIES_DASHES.length]]));
  const series = groups.map(g => ({ id: g.id, label: layout === 'overlay' && bases.length > 1 ? g.title : labelOf.get(g.source!) ?? g.title, color: sourceColor(g.source!),
    ...(g.dash ? { dash: g.dash } : layout === 'overlay' && bases.length > 1 ? { dash: dashOf.get(g.base!) } : {}), values: finishProfile(g.raw, opts) }));
  return {
    series, comparing: false, mode: null, pairs: [], signed: false, yLabel: yLabelOf(plot),
    facets: { panels: bases.map(b => ({ id: b.id, title: b.title, seriesIds: groups.filter(g => g.base === b.id).map(g => g.id) })), sources,
      sourceOf: Object.fromEntries(groups.map(g => [g.id, g.source!])), layout, yScale },
  };
}

/** One chart per comparison (each on the shared symmetric range), or one chart of all groups. Several sources: one
 *  panel per group (or comparison) with every source overlaid, on one y range unless asked otherwise; every panel's
 *  legend lists every source (a source with no reads in a panel still has its entry). */
export function profileCharts(fig: ProfileFigure, base: Omit<ProfileLinesChartProps, 'series' | 'yLabel' | 'signed'>): ProfileLinesChartProps[] {
  if (fig.facets) {
    const f = fig.facets;
    const byId = new Map(fig.series.map(s => [s.id, s]));
    const n = fig.series[0]?.values.length ?? 0;
    if (f.layout === 'overlay' && !fig.comparing) return [{ ...base, series: fig.series, yLabel: fig.yLabel }];
    const shared = f.yScale === 'shared' ? profileRange(fig.series, fig.comparing) : null;
    return f.panels.map(panel => {
      const mine = panel.seriesIds.map(id => byId.get(id)).filter((s): s is ProfileSeries => !!s);
      // Every source in the legend, in order (an empty line keeps its place).
      const series = f.sources.flatMap(src => {
        const lines = mine.filter(s => f.sourceOf[s.id] === src.id);
        return lines.length ? lines : [{ id: `${panel.id}::${src.id}::empty`, label: src.label, color: src.color, values: new Array<number | null>(n).fill(null) }];
      });
      return { ...base, title: panel.title, subtitle: undefined, series, yLabel: fig.yLabel, ...(fig.comparing ? { signed: true, signedLines: true } : {}),
        yRange: shared ?? (fig.comparing ? profileRange(series, true) : null), filename: `${base.filename}_${panel.title.replace(/[^\w.-]+/g, '_')}` };
    });
  }
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
  const head = [`# plot: ${plot.name || 'Metaprofile'}`, `# computed_for: ${locus}`, `# source: ${plotSources(plot).join(',')}`,
    `# normalization: ${plot.profile.normalization}`, `# gaussian_sigma_bp: ${plot.profile.sigmaBp}`, `# min_coverage: ${plot.profile.minCoverage}`,
    `# bin_bp: ${binBp}`, `# value: ${fig.yLabel}`, `# sampling: ${samplingText(plot.sampling, plot.where === 'random')}`];
  const n = fig.series[0]?.values.length ?? 0;
  // Several sources: each column names its group (or comparison) and source.
  const colOf = (s: ProfileSeries) => {
    if (!fig.facets) return s.label;
    const panel = fig.facets.panels.find(p => p.seriesIds.includes(s.id));
    return panel && !s.label.startsWith(panel.title) ? `${panel.title} · ${s.label}` : s.label;
  };
  const rows = [[sizes ? 'size_bp' : 'position', ...fig.series.map(colOf)].join('\t')];
  for (let i = 0; i < n; i++) rows.push([start + i * binBp + (sizes ? 0 : 1), ...fig.series.map(s => (s.values[i] == null ? 'NA' : String(+(s.values[i] as number).toPrecision(6))))].join('\t'));
  return [...head, ...rows].join('\n');
}
