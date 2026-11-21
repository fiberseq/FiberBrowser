/**
 * A plot of supplied series (supplied.ts): drawn from its Gallery card's values through the profile machinery
 * (Compare A − B / log2, smoothing, export), never recomputed here: the panel that made it re-runs it.
 */
import { useEffect, useMemo } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { ProfileLinesChart } from '../../components/charts/ProfileLinesChart';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import { AnalysisStatus } from '../../components/controls/shared';
import { COMPARE_MODES, type CompareMode } from './compare';
import { compareStateLine, reportGroupCount } from './compareState';
import { CompareStateText } from './ProfileSummaryBlock';
import type { SuppliedData } from './gallery';
import { formatLocus, plotDisplayName, type PlotSpec } from './plotModel';
import { profileCharts, profileFigure, profileFigureDraw } from './profileFigure';
import { suppliedGroups, suppliedMatricesTsv, suppliedMatrixColormap, suppliedTicks, suppliedTsv, suppliedXs } from './supplied';
import { HeatmapRowsChart, heatmapRange, drawHeatmapRows, type HeatmapRowsChartProps } from '../../components/charts/HeatmapRowsChart';

export function SuppliedPlot({ plot, data, width, onCompare }: {
  plot: PlotSpec; data: SuppliedData | null; width: number;
  onCompare?: (patch: Partial<Pick<PlotSpec, 'compareMode' | 'compareAB'>>) => void;
}) {
  const dark = useBrowserStore(s => s.darkMode);
  const spec = plot.supplied!;
  const groups = useMemo(() => (data ? suppliedGroups(data) : []), [data]);
  const n = Math.max(0, ...groups.map(g => g.raw.signal.length));
  const fig = useMemo(() => {
    const f = profileFigure(plot, groups, spec.dx);
    return { ...f, yLabel: f.comparing ? (plot.compare === 'diff' ? `Δ ${spec.yLabel}` : `log2 ratio (${spec.yLabel})`) : spec.yLabel };
  }, [plot, groups, spec.dx, spec.yLabel]);
  const charts = useMemo(() => profileCharts(fig, {
    start: spec.x0, binBp: spec.dx, width: Math.max(320, width), height: fig.comparing ? 200 : 300, dark, xLabel: spec.xLabel, xTicks: suppliedTicks(spec, n, data ? suppliedXs(spec, data) : undefined), xs: data ? suppliedXs(spec, data) : undefined,
    subtitle: `From ${spec.origin}`, filename: plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80),
  }), [fig, spec, width, dark, n, plot, data]);
  const matrixChart = useMemo(() => (data?.matrices?.length ? suppliedMatrixChart(plot, data, Math.max(320, width), dark) : null), [plot, data, width, dark]);
  const lines = groups.length > 0;
  const whole = useMemo(() => (matrixChart && !lines
    ? { w: matrixChart.width, h: matrixChart.height, draw: (ctx: CanvasRenderingContext2D) => drawHeatmapRows(ctx, matrixChart.width, matrixChart.height, matrixChart) }
    : profileFigureDraw(charts, `${plotDisplayName(plot)} · ${formatLocus(plot.pinned)}`)), [charts, plot, matrixChart, lines]);
  const tsv = () => (!data ? '' : lines ? suppliedTsv(plotDisplayName(plot), spec, data) : suppliedMatricesTsv(plotDisplayName(plot), spec, data));
  const ids = groups.map(g => g.id);
  // The builder's Compare reads how many series the card has (a matrix card has no Compare).
  const nSeries = data && !(data.matrices?.length && !groups.length) ? groups.length : null;
  useEffect(() => { if (nSeries != null) reportGroupCount(plot, nSeries); }, [nSeries, plot]);
  // Supplied cards have no summary (no per-unit values): the state line says only what is compared.
  const stateLine = fig.comparing ? compareStateLine({ compare: plot.compare, mode: fig.mode, pairs: fig.pairs, summary: null }) : null;
  const ab = plot.compareAB ?? (ids.length >= 2 ? [ids[0], ids[1]] as [string, string] : null);
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="plots-supplied-plot" data-state={data ? 'current' : 'missing'} data-groups={groups.length}
      data-comparing={fig.comparing ? fig.mode ?? '' : ''} data-origin={spec.origin}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-ink-secondary" data-testid="plots-supplied-origin">From <b className="font-semibold">{spec.origin}</b> · {formatLocus(plot.pinned)} · re-run in that panel to recompute</span>
        {spec.measures && <span className="basis-full text-ink-primary dark:text-gray-100" data-testid="plots-supplied-measures"><b>Measures:</b> {spec.measures}</span>}
        {data && (
          <span className="ml-auto inline-flex items-center gap-1" data-testid="plots-export">
            <span className="text-ink-secondary">Export</span>
            <ChartSaveButton inline filename={plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80)} drawFn={ctx => whole.draw(ctx)} width={whole.w} height={whole.h} dataTsv={tsv} />
          </span>
        )}
      </div>
      {plot.compare !== 'off' && lines && groups.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="plots-compare-picker">
          <span className="font-medium">Compare</span>
          <select aria-label="Compare mode" value={plot.compareMode} data-testid="plots-compare-mode" onChange={e => onCompare?.({ compareMode: e.target.value as CompareMode })} className="input-tool min-h-0 py-0.5 text-[11px]">
            {COMPARE_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          {fig.mode === 'a-vs-b' && ab && (
            <>
              <span>A</span>
              <select aria-label="Compare A" value={ab[0]} data-testid="plots-compare-a" className="input-tool min-h-0 py-0.5 text-[11px]"
                onChange={e => onCompare?.({ compareAB: [e.target.value, e.target.value === ab[1] ? ab[0] : ab[1]] })}>
                {groups.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
              <span>vs B</span>
              <select aria-label="Compare B" value={ab[1]} data-testid="plots-compare-b" className="input-tool min-h-0 py-0.5 text-[11px]"
                onChange={e => onCompare?.({ compareAB: [e.target.value === ab[0] ? ab[1] : ab[0], e.target.value] })}>
                {groups.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            </>
          )}
          <span className="text-ink-secondary">{plot.compare === 'diff' ? 'A − B' : 'log2(A / B)'}; red above 0, blue below, one range.</span>
        </div>
      )}
      {data && lines && <CompareStateText text={stateLine} />}
      {!data && <AnalysisStatus kind="empty" center>This plot's series came from {spec.origin}. Open its card from the Gallery, or re-run it in that panel.</AnalysisStatus>}
      {matrixChart && <HeatmapRowsChart testId="plots-supplied-matrix" {...matrixChart} dataTsv={tsv} />}
      {data && lines && (
        <div className="flex flex-col gap-2" data-testid="plots-supplied-charts">
          {charts.map((c, i) => <ProfileLinesChart key={`${i}-${c.title ?? ''}`} testId={fig.comparing ? 'plots-supplied-compare' : 'plots-supplied-chart'} {...c} dataTsv={tsv} />)}
        </div>
      )}
      {spec.note && <div className="text-[11px] text-ink-secondary" data-testid="plots-caption">{spec.note}</div>}
    </div>
  );
}

/** Supplied matrices as one heatmap figure: a block per matrix (V-plots: sizes bottom-up), coloured by the colormap
 *  rule (signed: RdBu centred on 0; V-plots: viridis; else magma), the plot's own pick winning. */
export function suppliedMatrixChart(plot: PlotSpec, data: SuppliedData, width: number, dark = false): HeatmapRowsChartProps {
  const spec = plot.supplied!;
  const m = spec.matrix ?? { kind: 'heatmap' as const, x0: 0, dx: 1, valueLabel: spec.yLabel };
  const cm = suppliedMatrixColormap(plot);
  const blocks = (data.matrices ?? []).map(mat => ({ id: mat.id, title: mat.title, ...(mat.color ? { color: mat.color } : {}),
    rows: m.kind === 'vplot' ? [...mat.rows].reverse() : mat.rows }));
  const nRows = blocks.reduce((a, b) => a + b.rows.length, 0);
  return {
    blocks, start: m.x0, binBp: m.dx, width, height: Math.min(900, Math.max(160, 40 + nRows * Math.max(2, Math.min(8, Math.floor(600 / Math.max(1, nRows)))))),
    title: plotDisplayName(plot), subtitle: spec.measures ? `Measures: ${spec.measures}` : `From ${spec.origin}`, valueLabel: m.valueLabel,
    colormap: cm.name, reverse: cm.reverse, signed: cm.signed, range: heatmapRange(blocks, cm.signed),
    filename: plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80), dark, xLabel: m.xLabel ?? spec.xLabel,
  };
}
