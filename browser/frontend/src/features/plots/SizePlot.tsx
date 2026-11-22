/**
 * A footprint size plot in the Plots workspace (Size enrichment or V-plot): one panel per dataset or cluster, or, with
 * Compare, one log2-ratio (or A − B) map per comparison (each vs rest, each vs all, A vs B) on one RdBu_r scale centred on 0.
 *
 * Stale-state guard: while a Follow plot waits for the view to settle or recomputes, the previous panels are greyed,
 * their counts read "—" and the header says "Updating…" with the locus it is computing for; the numbers are never
 * shown as current for another locus. Each result that becomes current is handed to `onResult` (the Gallery keeps it).
 * A plot grouped by cluster never falls back to datasets: without clusters at its locus it says so and draws nothing.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { SizeEnrichmentChart } from '../../components/charts/SizeEnrichmentChart';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import {
  footprintSizePlots, POOLED_PANEL, useFootprintSizeData, type FootprintSizeEntry, type FootprintSizePlot, type FootprintSizesClusters, type FootprintSizesTarget,
} from '../../components/controls/cluster-detail/useFootprintSizeData';
import { densityNote, sizeMatrixTsv } from '../../utils/footprintSizeMatrix';
import { footprintSizeCaption } from '../../utils/footprintSizeSettings';
import { AnalysisStatus } from '../../components/controls/shared';
import { plotFreshness } from './follow';
import { COMPARE_MODES, compareBlocker, type CompareMode } from './compare';
import { effectiveSizeSettings, formatLocus, plotDisplayName, type PlotSpec } from './plotModel';
import { figureDraw, isComparing, requestSettings, sizeFigure, thumbnail } from './sizeFigure';
import { boxMean, boxSummarySpec, ciText, resolveCi, summaryMeasures } from './summary';
import { SummaryChart } from './SummaryChart';
import { compareStateLine, reportGroupCount } from './compareState';
import { CompareStateText } from './ProfileSummaryBlock';
import { resultIdentity } from './gallery';
import type { ReadGroupDef } from './readGroups';

export interface SizePlotResult {
  entry: FootprintSizeEntry;
  plot: PlotSpec;
  items: Array<{ id: string; title: string; color?: string }>;
  thumb: string;
}

export interface SizePlotProps {
  plot: PlotSpec;
  /** The target the plot computes for now (Follow: the settled view; Pin: its locus). */
  target: FootprintSizesTarget;
  /** The clusters at the plot's locus (group by cluster); null: none there. */
  clusters: FootprintSizesClusters | null;
  /** The view moved and the plot waits for it to settle. */
  pending: boolean;
  width: number;
  sampleSeed?: string;
  settingsKey?: string;
  /** Clicking a cell: move the shared locus there. */
  onPosition?: (pos: number) => void;
  onCompare?: (patch: Partial<Pick<PlotSpec, 'compareMode' | 'compareAB'>>) => void;
  /** The locus the plot will compute for once the view settles (Follow: the browser's view now). */
  wanted?: { chrom: string; start: number; end: number } | null;
  /** A stored result to draw at once (a Gallery entry just opened). */
  seed?: FootprintSizeEntry | null;
  /** Each result that becomes current (not stored ones). */
  onResult?: (r: SizePlotResult) => void;
  /** With no clusters here: open the newest clustered plot from the Gallery (absent: none kept). */
  onOpenClustered?: (() => void) | null;
  /** Group by read groups / selected classes: the groups (null: not grouped by them). */
  readGroups?: ReadGroupDef[] | null;
  groupsSig?: string;
  /** Why there are no read groups (nothing split / selected). */
  groupsBlocker?: string | null;
}

const GAP = 10;
const NO_PANELS: FootprintSizesTarget['panels'] = [];

const NO_PLOTS: FootprintSizePlot[] = [];

export function SizePlot({ plot, target, clusters, pending, width, sampleSeed, settingsKey, onPosition, onCompare, wanted, seed, onResult, onOpenClustered, readGroups = null, groupsSig = '', groupsBlocker = null }: SizePlotProps) {
  const dark = useBrowserStore(s => s.darkMode);
  const byCluster = plot.groupBy === 'cluster';
  const useClusters = byCluster && !!clusters && clusters.panels.length > 0;
  const clustersGone = byCluster && !useClusters;
  const clustersAt = useMemo(() => (useClusters ? { ...clusters!, chrom: target.chrom, start: target.start, end: target.end, genome: target.genome } : null),
    [useClusters, clusters, target.chrom, target.start, target.end, target.genome]);
  // Grouped by cluster with no clusters here: no request, no per-dataset stand-in.
  const shownTarget: FootprintSizesTarget = useMemo(() => (clustersAt ?? (clustersGone ? { ...target, panels: NO_PANELS } : target)),
    [clustersAt, clustersGone, target]);
  const shownClusters = useMemo(() => (useClusters ? clusters!.visible.map(c => ({ cluster: c.cluster, color: c.color })) : []), [useClusters, clusters]);
  const byGroups = !!readGroups;
  const nGroups = byGroups ? readGroups!.length : useClusters ? shownClusters.length * clusters!.panels.length : plot.groupBy === 'none' ? 1 : new Set(shownTarget.panels.map(p => p.datasetId)).size;
  // Group by None: every dataset pooled into one matrix (the server sums raw counts, then normalises once).
  const pooled = plot.groupBy === 'none' && !useClusters;
  // The box mean's seeded bootstrap over reads (summaries): the server resamples each read's own counts.
  // The box: the centre of the view by default for normalised plots; on the plot's scale (log2 / log1p / values).
  const box = boxSummarySpec(effectiveSizeSettings(plot), plot.summary, { start: target.start, end: target.end, anchored: false });
  // No box bootstrap while comparing: the summary is off then (compareState.summaryBlocker).
  // Judged on the most matrices the drawing can make (a read group spanning several datasets draws one per dataset), so a
  // plot drawn as a comparison never asks for the per-group bootstrap.
  const shownDatasets = new Set(shownTarget.panels.map(p => p.datasetId));
  const drawableGroups = byGroups
    ? readGroups!.reduce((n, g) => n + Object.entries(g.members).filter(([ds, ids]) => shownDatasets.has(ds) && ids.size > 0).length, 0)
    : nGroups;
  // Planned on the matrices the drawing makes (a read group in two datasets draws two), so the comparison it fetches for
  // (counts, or normalised A vs B) is the one it draws.
  const settings = useMemo(() => requestSettings(plot, drawableGroups), [plot, drawableGroups]);
  const bootOn = plot.summary.on && resolveCi('box-mean', plot.summary) === 'bootstrap' && !box.note && !isComparing(plot, drawableGroups);
  const bootSeed = plot.summary.bootSeed ?? plot.sampling.seed;
  const { entry, requestKey, loading, error } = useFootprintSizeData({
    target: byGroups && !readGroups!.length ? { ...shownTarget, panels: NO_PANELS } : shownTarget, useClusters, clusters: clustersAt, settings, sampleSeed, settingsKey,
    delayMs: 60, enabled: !pending, seed, pooled, readGroups, groupsSig,
    readSample: plot.sampling.mode === 'random' ? { n: plot.sampling.n, seed: plot.sampling.seed } : null,
    boxBootstrap: bootOn ? { size_from: plot.summary.sizeFrom, size_to: plot.summary.sizeTo, pos_from: box.win.from, pos_to: box.win.to, resamples: plot.summary.resamples, seed: bootSeed, transform: box.transform } : null,
  });
  const fresh = plotFreshness({ resultKey: entry?.key ?? null, wantKey: requestKey, pending, loading, error });
  const panels = useMemo(() => (pooled && shownTarget.panels.length ? [POOLED_PANEL] : shownTarget.panels), [pooled, shownTarget.panels]);
  const answered: FootprintSizePlot[] = useMemo(() => {
    if (!byGroups) return footprintSizePlots(fresh.showResult ? entry!.byPanel : null, panels, useClusters, shownClusters);
    if (!fresh.showResult || !entry) return [];
    // Read groups: one plot per group (per dataset when a group spans several), titled by the group.
    const out: FootprintSizePlot[] = [];
    for (const g of readGroups!) {
      const keys = Object.keys(entry.byPanel).filter(k => k.startsWith(`${g.id}@`));
      for (const k of keys) {
        const d = entry.byPanel[k]?.['0'];
        const ds = k.slice(g.id.length + 1);
        const label = shownTarget.panels.find(p => p.datasetId === ds)?.datasetLabel;
        if (d) out.push({ id: `${k}|0`, title: keys.length > 1 && label ? `${g.title} · ${label}` : g.title, color: g.color, data: d });
      }
    }
    return out;
  }, [byGroups, readGroups, fresh.showResult, entry, panels, useClusters, shownClusters, shownTarget.panels]);
  // Counts fetched for a comparison that came back with one group (sampling left the other empty): never drawn,
  // summarised, hovered or kept as this plot's values; the plot says so instead.
  const oneLeft = answered.length > 0 && !isComparing(plot, answered.length)
    && answered.some(p => !!p.data.normalization && p.data.normalization !== effectiveSizeSettings(plot).normalization);
  const plots = oneLeft ? NO_PLOTS : answered;
  const computedFor = entry?.locus ?? null;
  const stale = fresh.stale;
  const comparing = isComparing(plot, plots.length);
  const nCharts = comparing ? Math.max(1, plot.compareMode === 'a-vs-b' || (plot.compareMode === 'auto' && plot.groupBy !== 'cluster' && plots.length === 2) ? 1 : plots.length) : plots.length;
  const cols = Math.max(1, Math.min(nCharts || 1, Math.floor((width + GAP) / (240 + GAP))));
  const plotW = Math.max(240, Math.floor((width - (cols - 1) * GAP) / cols));
  const plotH = 300;
  const locusStart = computedFor?.start ?? target.start;
  const chrom = computedFor?.chrom ?? target.chrom;
  const figure = useMemo(() => sizeFigure({ plot, plots, start: locusStart, width: plotW, height: plotH, dark, stale }),
    [plot, plots, locusStart, plotW, dark, stale]);
  const effective = effectiveSizeSettings(plot);
  const stamp = plot.type === 'vplot' ? 'vplot' : 'size_enrichment';

  // Each result that becomes current goes to the Gallery once (stored results are not repeated).
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (fresh.state !== 'current' || !entry || entry.seeded || !onResult || plots.length === 0) return;
    // The plot's id too: a remade plot reports its result even when the request is the one on screen.
    const id = `${plot.id}|${entry.key}|${resultIdentity(plot)}`;
    if (reported.current === id) return;
    reported.current = id;
    onResult({ entry, plot, items: plots.map(p => ({ id: p.id, title: p.title, color: p.color })), thumb: thumbnail(figure.charts[0]) });
  }, [fresh.state, entry, plot, plots, figure, onResult]);

  const tsvOf = useCallback((p: FootprintSizePlot) => sizeMatrixTsv(p.data.matrix, {
    sizeMin: p.data.size_min, sizeMax: p.data.size_max, sizeBin: p.data.size_bin, posBin: p.data.pos_bin,
    nReads: p.data.n_reads, nFootprints: p.data.n_footprints,
  }, settings, { title: p.title, chrom, start: locusStart }), [settings, chrom, locusStart]);
  const allTsv = useCallback(() => {
    const parts = [`# plot: ${plotDisplayName(plot)}`, `# computed_for: ${formatLocus(computedFor)}`];
    if (figure.comparing) {
      for (const c of figure.comparisons) {
        const ref = plots[0].data;
        parts.push(sizeMatrixTsv(c.matrix, { sizeMin: ref.size_min, sizeMax: ref.size_max, sizeBin: ref.size_bin, posBin: ref.pos_bin, nReads: 0, nFootprints: 0 },
          settings, { title: c.label, chrom, start: locusStart, value: plot.compare === 'diff' ? 'A - B of footprint size shares (each side over its total)' : 'log2 ratio of footprint size distributions (each side over its total)', comparative: true }));
      }
    } else parts.push(...plots.map(tsvOf));
    return parts.join('\n');
  }, [plot, computedFor, figure, plots, tsvOf, settings, chrom, locusStart]);
  const whole = useMemo(() => figureDraw(figure.charts, `${plotDisplayName(plot)} · ${formatLocus(computedFor)}`, { cols, dark }), [figure, plot, computedFor, cols, dark]);

  const onCell = useCallback((pos: number) => onPosition?.(pos), [onPosition]);
  const densityText = comparing ? null : densityNote(plots.map(p => ({ label: p.title, nReads: p.data.n_reads, nFootprints: p.data.n_footprints })));
  const blocker = (plot.compare === 'log2ratio' || plot.compare === 'diff') && !clustersGone && fresh.state === 'current' ? compareBlocker(plots.length, plot.groupBy) : null;
  const shownWanted = pending && wanted ? wanted : shownTarget;
  // The builder's Compare reads how many groups the plot drew.
  // No clusters or no read groups here: no request runs, so the count is 0 at once.
  const knownEmpty = clustersGone || (byGroups && !readGroups!.length) || !shownTarget.panels.length;
  const drawnGroups = knownEmpty ? 0 : fresh.state === 'current' ? (entry ? plots.length : null) : null;
  const reloading = !knownEmpty && fresh.state === 'updating';
  useEffect(() => { if (drawnGroups != null || reloading) reportGroupCount(plot, drawnGroups); }, [drawnGroups, reloading, plot]);
  const stateLine = comparing && !stale ? compareStateLine({ compare: plot.compare, mode: figure.mode, pairs: figure.comparisons, summary: plot.summary.on ? 'blocked' : null }) : null;

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="plots-size-plot" data-state={clustersGone ? 'no-clusters' : fresh.state}
      data-computed-for={computedFor && fresh.state === 'current' ? formatLocus(computedFor) : ''}
      data-group={useClusters ? 'clusters' : byCluster ? 'none' : 'datasets'} data-type={plot.type} data-comparing={comparing ? figure.mode ?? '' : ''}
      data-seeded={entry?.seeded && fresh.state === 'current' ? 'true' : undefined}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="plots-status-line">
        {fresh.state === 'current' && computedFor && !clustersGone && (
          <span className="text-ink-secondary" data-testid="plots-computed-for">
            {entry?.seeded ? 'From the Gallery · ' : ''}Computed for <b className="font-semibold text-ink-primary dark:text-gray-100">{formatLocus(computedFor)}</b>
          </span>
        )}
        {fresh.state === 'updating' && !clustersGone && (
          <span className="font-medium text-amber-700 dark:text-amber-300" data-testid="plots-updating" role="status">Updating… → {formatLocus(shownWanted)}</span>
        )}
        {fresh.state === 'error' && <span className="text-red-600" data-testid="plots-error">{error}</span>}
        {plots.length > 0 && !stale && (
          <span className="ml-auto inline-flex items-center gap-1" data-testid="plots-export">
            <span className="text-ink-secondary">Export</span>
            <ChartSaveButton inline filename={`${plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80)}_${chrom}_${locusStart + 1}`} drawFn={ctx => whole.draw(ctx)} width={whole.w} height={whole.h} dataTsv={allTsv} />
          </span>
        )}
      </div>
      {clustersGone && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" data-testid="plots-no-clusters" role="status">
          <b>No clusters at {formatLocus(target)}.</b> This plot is grouped by cluster, and the reads here are not clustered (moving away clears a
          clustering). Cluster the reads here, open the clustered plot from the Gallery, or group by dataset.
          {onOpenClustered && (
            <button type="button" className="ml-2 rounded bg-amber-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-700"
              data-testid="plots-open-clustered" onClick={onOpenClustered}>Open the clustered plot (Gallery)</button>
          )}
        </div>
      )}
      {byGroups && groupsBlocker && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" data-testid="plots-groups-blocker" role="status">{groupsBlocker}</div>
      )}
      {(plot.compare === 'log2ratio' || plot.compare === 'diff') && plots.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-700 dark:text-gray-200" data-testid="plots-compare-picker">
          <span className="font-medium">Compare</span>
          <select aria-label="Compare mode" value={plot.compareMode} data-testid="plots-compare-mode"
            onChange={e => onCompare?.({ compareMode: e.target.value as CompareMode })} className="input-tool min-h-0 py-0.5 text-[11px]">
            {COMPARE_MODES.map(m => <option key={m.value} value={m.value} title={m.help}>{m.value === 'auto' ? `Default (${figure.mode === 'a-vs-b' ? 'A vs B' : figure.mode === 'each-vs-all' ? 'each vs all' : 'each vs rest'})` : m.label}</option>)}
          </select>
          {figure.mode === 'a-vs-b' && (() => {
            const a = figure.comparisons[0]?.a ?? plots[0].id;
            const b = (figure.comparisons[0]?.b as string) ?? plots[1].id;
            return (
              <>
                <span>A</span>
                <select aria-label="Compare A" value={a} data-testid="plots-compare-a" onChange={e => onCompare?.({ compareAB: [e.target.value, e.target.value === b ? a : b] })} className="input-tool min-h-0 py-0.5 text-[11px]">
                  {plots.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
                <span>vs B</span>
                <select aria-label="Compare B" value={b} data-testid="plots-compare-b" onChange={e => onCompare?.({ compareAB: [e.target.value === a ? b : a, e.target.value] })} className="input-tool min-h-0 py-0.5 text-[11px]">
                  {plots.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
                <button type="button" className="rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                  onClick={() => onCompare?.({ compareAB: [b, a] })} title="Swap A and B: flips the sign, not the colours.">Swap</button>
              </>
            );
          })()}
          <span className="text-ink-secondary">{plot.compare === 'diff' ? 'A − B of footprint size shares' : 'log2 ratio of footprint size distributions'} (each side over its own total); one RdBu scale centred on 0, red = more in the first.</span>
        </div>
      )}
      {blocker && <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" data-testid="plots-compare-blocker" role="status">{blocker}</div>}
      <CompareStateText text={stateLine} />
      {!panels.length && !clustersGone && <AnalysisStatus kind="empty" center>Open a dataset to plot its footprint sizes.</AnalysisStatus>}
      {panels.length > 0 && !fresh.showResult && fresh.state === 'updating' && (
        <AnalysisStatus kind="loading" compact>Computing {plotDisplayName(plot)} for {formatLocus(shownWanted)}…</AnalysisStatus>
      )}
      {figure.charts.length > 0 && (
        <div className={`relative flex flex-wrap gap-[10px] ${stale ? 'pointer-events-none opacity-40 grayscale' : ''}`} data-testid="plots-size-panels" aria-busy={stale || undefined}>
          {figure.charts.map(({ key, kind, ...props }) => {
            const p = plots.find(x => x.id === key);
            return (
              <SizeEnrichmentChart key={key} testId={kind === 'compare' ? 'plots-size-compare' : 'plots-size-panel'} {...props}
                dataTsv={p ? () => tsvOf(p) : undefined} onPositionClick={stale ? undefined : onCell} />
            );
          })}
        </div>
      )}
      {plot.summary.on && plots.length > 0 && !comparing && (
        <SummaryChart values={plots.map(p => ({ id: p.id, title: p.title, ...(p.color ? { color: p.color } : {}), ...boxMean(p.data.matrix, p.data, locusStart, plot.summary, { from: box.win.from, to: box.win.to, transform: box.transform }),
          ...(bootOn && p.data.box_ci ? { lo: p.data.box_ci.lo, hi: p.data.box_ci.hi } : {}) }))}
          chart={plot.summary.chart} dark={dark} reference={box.reference} note={box.note}
          yLabel={box.transform === 'log2' ? 'log2 enrichment' : box.transform === 'log1p' ? 'log1p count' : 'mean value in the box'} filename={`${plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 60)}_summary`}
          measures={summaryMeasures('box-mean', box.sEff, 'the plot above',
            bootOn ? (plots.some(p => p.data.box_ci) ? ciText('bootstrap', plot.summary, bootSeed, 'reads', false, 'box-mean') : 'interval not available') : undefined, { scale: box.scale, isDefault: box.win.isDefault })} />
      )}
      {fresh.state === 'current' && entry && oneLeft && (
        <AnalysisStatus kind="empty" center><span data-testid="plots-size-one-group">Compare needs two groups with footprints: only one came back here (with Random reads, sample more). Turn Compare off to see it.</span></AnalysisStatus>
      )}
      {fresh.state === 'current' && entry && plots.length === 0 && !clustersGone && !oneLeft && (
        <AnalysisStatus kind="empty" center>No footprints in this window for these panels.</AnalysisStatus>
      )}
      {!comparing && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-ink-secondary" data-testid="plots-counts">
          {plots.map(p => (
            <span key={p.id} data-testid="plots-count">
              <b className="font-medium text-ink-primary dark:text-gray-200">{p.title}</b>: {stale ? '—' : p.data.n_reads.toLocaleString()} reads · {stale ? '—' : p.data.n_footprints.toLocaleString()} footprints
            </span>
          ))}
        </div>
      )}
      {!stale && densityText && <div className="text-[11px] text-amber-700 dark:text-amber-300">{densityText}</div>}
      <div className="text-[11px] text-ink-secondary" data-testid="plots-caption">
        Bins {effective.sizeBin} × {effective.posBin} bp · Gaussian σ size {effective.sigmaSizeBp} bp, position {effective.sigmaPosBp} bp. {comparing ? '' : footprintSizeCaption(effective)}
      </div>
    </div>
  );
}
