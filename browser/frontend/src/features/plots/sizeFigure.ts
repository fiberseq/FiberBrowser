/**
 * The size plot as charts, from its data: the one place that turns a plot's settings and its groups' matrices into
 * chart props, so the live plot, Gallery cards, side-by-side Compare and every export draw the same thing.
 *
 * Single plots use their view's colour slot (Size enrichment: magma; V-plot: viridis, by default). Comparisons (log2
 * ratio: each vs rest, each vs all, A vs B) read counts and share one symmetric scale centred on 0 in the comparative
 * slot (RdBu_r by default).
 */
import type { SizeEnrichmentChartProps } from '../../components/charts/SizeEnrichmentChart';
import { drawSizeEnrichment } from '../../components/charts/SizeEnrichmentChart';
import { ALL_READS_KEY, type FootprintSizeData } from '../../api/clustering';
import type { FootprintSizePlot } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { colorScaleFor, diffScale, displayMatrix, ratioScale, type SizeMatrix } from '../../utils/footprintSizeMatrix';
import { isEnrichment, type FootprintSizeSettings } from '../../utils/footprintSizeSettings';
import { comparisons, resolveCompareMode, type Comparison, type ResolvedCompareMode } from './compare';
import { effectiveSizeSettings, type PlotSpec } from './plotModel';


/** Whether the plot draws comparisons, given how many groups it has. */
export const isComparing = (plot: PlotSpec, nGroups: number): boolean => (plot.compare === 'log2ratio' || plot.compare === 'diff') && nGroups >= 2;

/** The settings a plot requests: comparisons read counts (no log) so groups can be summed into "rest" and "all". */
export function requestSettings(plot: PlotSpec, nGroups: number): FootprintSizeSettings {
  const s = effectiveSizeSettings(plot);
  return isComparing(plot, nGroups) ? { ...s, normalization: 'raw', log: false, ratio: null } : s;
}

export interface SizeFigure {
  charts: Array<SizeEnrichmentChartProps & { key: string; kind: 'panel' | 'compare' }>;
  comparing: boolean;
  mode: ResolvedCompareMode | null;
  comparisons: Comparison[];
}

export interface SizeFigureOptions {
  plot: PlotSpec;
  plots: FootprintSizePlot[];
  /** First genomic position of the window. */
  start: number;
  width: number;
  height: number;
  dark?: boolean;
  /** Counts belong to the locus they were computed for: blanked while updating. */
  stale?: boolean;
  stamp?: string;
}

export function sizeFigure(o: SizeFigureOptions): SizeFigure {
  const { plot, plots, start, width, height, dark = false, stale = false } = o;
  const stamp = o.stamp ?? (plot.type === 'vplot' ? 'vplot' : 'size_enrichment');
  const comparing = isComparing(plot, plots.length);
  const common = { start, width, height, dark, guides: [80, 147] };
  if (comparing) {
    const mode = resolveCompareMode(plot.compareMode, plot.groupBy, plots.length);
    const groups = plots.map(p => ({ id: p.id, title: p.title, panelKey: p.id.slice(0, p.id.lastIndexOf('|')), matrix: p.data.matrix }));
    const diff = plot.compare === 'diff';
    const comps = comparisons(groups, mode, plot.compareAB, diff ? 'diff' : 'log2ratio');
    const all: SizeMatrix = comps.flatMap(c => c.matrix);
    // The comparative colour slot (default RdBu_r centred on 0), one scale for every comparison.
    const scale = diff ? diffScale(all, plot.size) : ratioScale(all, plot.size);
    const ref = plots[0].data;
    return {
      comparing: true, mode, comparisons: comps,
      charts: comps.map(c => ({
        key: c.id, kind: 'compare' as const, matrix: c.matrix, sizeMin: ref.size_min, sizeMax: ref.size_max, sizeBin: ref.size_bin, posBin: ref.pos_bin,
        scale, title: diff ? c.label.replace(' vs ', ' − ') : c.label,
        subtitle: diff ? 'A − B of footprint size shares' : 'log2 ratio of footprint size distributions', filename: `footprint_${stamp}_${diff ? 'diff_' : ''}${c.label.replace(/[^\w.-]+/g, '_')}`,
        valueLabel: diff ? 'A − B (share)' : 'log2 ratio', ...common,
      })),
    };
  }
  const settings = effectiveSizeSettings(plot);
  const display = plots.map(p => displayMatrix(p.data.matrix, settings));
  const shared = colorScaleFor(display, settings);
  const enrichment = isEnrichment(settings.normalization);
  return {
    comparing: false, mode: null, comparisons: [],
    charts: plots.map((p, i) => ({
      key: p.id, kind: 'panel' as const, matrix: display[i], rawMatrix: p.data.matrix,
      sizeMin: p.data.size_min, sizeMax: p.data.size_max, sizeBin: p.data.size_bin, posBin: p.data.pos_bin,
      scale: settings.scale === 'shared' ? shared : colorScaleFor([display[i]], settings), title: p.title, accent: p.color,
      subtitle: stale ? '— reads · — footprints' : `${p.data.n_reads.toLocaleString()} reads · ${p.data.n_footprints.toLocaleString()} footprints`,
      filename: `footprint_${stamp}_${p.title.replace(/[^\w.-]+/g, '_')}`, valueLabel: enrichment ? 'enrichment' : 'footprints', ...common,
    })),
  };
}

/** Lay charts out `cols` across; the whole figure's size and a draw function (PNG / SVG / PDF exports, thumbnails). */
export function figureDraw(charts: SizeEnrichmentChartProps[], title: string, opts: { cols?: number; gap?: number; dark?: boolean } = {}) {
  const gap = opts.gap ?? 10;
  const n = Math.max(1, charts.length);
  const cols = Math.max(1, Math.min(n, opts.cols ?? n));
  const rows = Math.ceil(n / cols);
  const cw = charts[0]?.width ?? 240, ch = charts[0]?.height ?? 300;
  const head = title ? 22 : 0;
  const w = cols * (cw + gap) - gap;
  const h = head + rows * (ch + gap) - gap;
  const draw = (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = opts.dark ? '#1f1f1e' : '#ffffff';
    ctx.fillRect(0, 0, w, h);
    if (title) {
      ctx.fillStyle = opts.dark ? '#f0efec' : '#1f1f1e';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(title, 4, 15);
    }
    charts.forEach((props, i) => {
      ctx.save();
      ctx.translate((i % cols) * (cw + gap), head + Math.floor(i / cols) * (ch + gap));
      drawSizeEnrichment(ctx, cw, ch, props);
      ctx.restore();
    });
  };
  return { w, h, draw };
}

/** A small JPEG of the first chart (Gallery cards); '' where there is no canvas. */
export function thumbnail(chart: SizeEnrichmentChartProps | undefined, w = 168, h = 104): string {
  if (!chart || typeof document === 'undefined') return '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    drawSizeEnrichment(ctx, w, h, { ...chart, width: w, height: h, title: undefined, subtitle: undefined, guides: [] });
    const url = canvas.toDataURL('image/jpeg', 0.72);
    return url.startsWith('data:image/jpeg') ? url : '';
  } catch {
    return '';
  }
}

/** The groups of stored data as plots (Gallery): ids are "<panel key>|<group>", group "all" being every read. */
export function storedPlots(items: Array<{ id: string; title: string; color?: string }>, byPanel: Record<string, Record<string, FootprintSizeData>>): FootprintSizePlot[] {
  const out: FootprintSizePlot[] = [];
  for (const it of items) {
    const [panel, group] = [it.id.slice(0, it.id.lastIndexOf('|')), it.id.slice(it.id.lastIndexOf('|') + 1)];
    const d = byPanel[panel]?.[group === 'all' ? String(ALL_READS_KEY) : group];
    if (d) out.push({ id: it.id, title: it.title, color: it.color, data: d });
  }
  return out;
}
