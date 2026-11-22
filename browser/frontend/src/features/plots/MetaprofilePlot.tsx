/**
 * Metaprofile in the Plots workspace: signal along position, one line per group (dataset, cluster, or every dataset
 * pooled), from the one profile engine; Compare draws each vs rest / each vs all / A vs B as A − B or log2(A/B)
 * around 0. Same stale-state guard, Gallery hand-off and export as the size plots.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMetaLocusStore } from '../metaLocus/metaLocusStore';
import { anchorWord, isMetaChrom } from '../metaLocus/metaChrom';
import { isResolved, resolveAnchor, toRelative } from '../windowQuant/axisFrame';
import { useBrowserStore } from '../../stores/browserStore';
import { ProfileLinesChart } from '../../components/charts/ProfileLinesChart';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import type { FootprintSizesClusters, FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { AnalysisStatus } from '../../components/controls/shared';
import { COMPARE_MODES, compareBlocker, type CompareMode } from './compare';
import { plotFreshness } from './follow';
import type { ReadGroupDef } from './readGroups';
import { resultIdentity } from './gallery';
import { formatLocus, plotDisplayName, type PlotSpec } from './plotModel';
import { isMarkProfile, profileCharts, profileFigure, profileFigureDraw, profileThumbnail, profileTsv } from './profileFigure';
import { sampleCountsText, useProfileData, type ProfileEntry } from './useProfileData';
import { histogramAxis, histogramFigure, histogramMeasures } from './sizeHistogram';
import { bandsText } from './sizeBands';
import { CompareStateText, ProfileSummaryBlock, profileStateLine, profileSummaryOf } from './ProfileSummaryBlock';
import { reportGroupCount } from './compareState';
import { PROFILE_NORMALIZATIONS, samplingText } from './plotModel';
import { selectedFeatures } from './heatmapData';
import { PrereqButton } from './prereqActions';
import { MeasuresHeader, shortHeader } from './MeasuresHeader';
import { baseGroupsOf } from './multiSource';
import { plotSources, sourceLabel } from './plotModel';
import { useLayerColorVersion } from '../layerColours/state';

export interface MetaprofileResult {
  entry: ProfileEntry;
  plot: PlotSpec;
  thumb: string;
}

export interface MetaprofilePlotProps {
  plot: PlotSpec;
  target: FootprintSizesTarget;
  clusters: FootprintSizesClusters | null;
  pending: boolean;
  width: number;
  sampleSeed: string;
  settingsKey: string;
  wanted?: { chrom: string; start: number; end: number } | null;
  onPosition?: (pos: number) => void;
  onCompare?: (patch: Partial<Pick<PlotSpec, 'compareMode' | 'compareAB'>>) => void;
  seed?: ProfileEntry | null;
  onResult?: (r: MetaprofileResult) => void;
  onOpenClustered?: (() => void) | null;
  readGroups?: ReadGroupDef[] | null;
  groupsSig?: string;
  groupsBlocker?: string | null;
}

const NO_PANELS: FootprintSizesTarget['panels'] = [];

export function MetaprofilePlot({ plot, target, clusters, pending: viewPending, width, sampleSeed, settingsKey, wanted, onPosition, onCompare, seed, onResult, onOpenClustered, readGroups = null, groupsSig = '', groupsBlocker = null }: MetaprofilePlotProps) {
  const dark = useBrowserStore(s => s.darkMode);
  // Where = Selected features: pooled over the selected peaks' windows; moving the view leaves it alone.
  const featureMode = plot.where === 'features' && (plot.type === 'metaprofile' || plot.type === 'size-histogram');
  const pending = featureMode ? false : viewPending;
  const selectedPeaks = useBrowserStore(s => s.selectedPeaks);
  const features = useMemo(() => (featureMode ? selectedFeatures(plot.heatmap.maxFeatures, plot.heatmap.windowBp) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [featureMode, plot.heatmap.maxFeatures, plot.heatmap.windowBp, selectedPeaks]);
  const byCluster = plot.groupBy === 'cluster';
  const clustersGone = byCluster && !(clusters && clusters.panels.length);
  const shownTarget = useMemo(() => (clustersGone ? { ...target, panels: NO_PANELS } : target), [clustersGone, target]);
  const { entry, requestKey, loading, error } = useProfileData({
    plot, target: readGroups && !readGroups.length ? { ...shownTarget, panels: NO_PANELS } : shownTarget, clusters: byCluster ? clusters : null,
    sampleSeed, settingsKey, enabled: !pending, seed, readGroups, groupsSig, features,
  });
  const fresh = plotFreshness({ resultKey: entry?.key ?? null, wantKey: requestKey, pending, loading, error });
  const groups = fresh.showResult && entry ? entry.groups : [];
  const binBp = entry?.binBp ?? plot.profile.binBp;
  const histogram = plot.type === 'size-histogram';
  // Source colours come from the layer colour resolver: redraw (lines and bars) when the user changes one.
  const layerColorVersion = useLayerColorVersion();
  const figure = useMemo(() => (histogram ? histogramFigure(plot, groups) : profileFigure(plot, groups, binBp)), [histogram, plot, groups, binBp, layerColorVersion]);   // eslint-disable-line react-hooks/exhaustive-deps
  const computedFor = entry?.locus ?? null;
  // A histogram's x axis is footprint size from its smallest size; a profile's is position.
  const start = histogram ? plot.hist.sizeMin : featureMode ? -Math.round(plot.heatmap.windowBp / 2) : computedFor?.start ?? target.start;
  const locusText = formatLocus(computedFor);
  const stale = fresh.stale;
  // One legend: each line's entry carries its reads (one line: the count under the title instead).
  const nOf = useMemo(() => new Map(groups.map(g => [g.id, g.raw.nReads])), [groups]);
  // Several sources: lines are sources (the legend names them); each panel says its reads per source.
  const multi = !!figure.facets;
  const baseGroups = useMemo(() => baseGroupsOf(groups), [groups]);
  const legendFigure = useMemo(() => (multi || figure.comparing || figure.series.length < 2 ? figure
    : { ...figure, series: figure.series.map(s0 => ({ ...s0, label: nOf.has(s0.id) ? `${s0.label} · ${stale ? '—' : nOf.get(s0.id)!.toLocaleString()} reads` : s0.label })) }), [figure, nOf, stale, multi]);
  // Relative x (a view profile): distances from the anchor, signed by its direction; Plots draws genome left to right.
  const genes = useBrowserStore(s => s.genes);
  const metaStatus = useMetaLocusStore(s => s.status);
  const relAxis = useMemo(() => {
    if (histogram || featureMode || plot.axis?.mode !== 'relative' || !computedFor) return null;
    const flank = Number(metaStatus?.flank_bp ?? metaStatus?.spec?.flank_bp ?? 0);
    const meta = isMetaChrom(computedFor.chrom) && flank > 0 ? { site: flank, word: anchorWord(metaStatus?.spec?.anchor) } : null;
    const a = resolveAnchor(plot.axis, { chrom: computedFor.chrom, start: computedFor.start, end: computedFor.end, genes, meta });
    if (!isResolved(a)) return { xLabel: `Position (relative axis: ${a.reason})` };
    const f = (g: number) => { const r = toRelative(g, a); return r > 0 ? `+${r.toLocaleString('en-US')}` : r.toLocaleString('en-US'); };
    return { xLabel: a.axisLabel, xTicks: [f(computedFor.start), f(Math.round((computedFor.start + computedFor.end) / 2)), f(computedFor.end)] as [string, string, string] };
  }, [histogram, featureMode, plot.axis, computedFor, genes, metaStatus]);
  const charts0 = useMemo(() => profileCharts(legendFigure, {
    start, binBp, width: Math.max(320, width), height: figure.comparing ? 200 : multi && (figure.facets?.panels.length ?? 1) > 1 ? 240 : 300, dark,
    ...(!multi && (figure.comparing || figure.series.length < 2) ? { subtitle: stale ? '— reads' : groups.map(g => `${g.title}: ${g.raw.nReads.toLocaleString()} reads`).join(' · ') } : {}),
    filename: plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80),
    ...(histogram ? histogramAxis(plot.hist) : featureMode ? { xLabel: `bp from the feature centre (${binBp} bp bins), ${features.length} features pooled` } : relAxis ?? {}),
  }), [legendFigure, figure, start, binBp, width, dark, stale, groups, plot, histogram, featureMode, features.length, multi, relAxis]);
  // Several sources, one panel per group: its reads per source under its title (family lines count the reads scored on
  // the family, so they can differ).
  const charts = useMemo(() => (!multi || figure.comparing || figure.facets?.layout === 'overlay' ? charts0 : charts0.map((c, i) => {
    const panel = figure.facets!.panels[i];
    const mine = groups.filter(g => g.base === panel?.id);
    return { ...c, subtitle: stale ? '— reads' : mine.map(g => `${sourceLabel(g.source!, plot.sourceLabels)} ${g.raw.nReads.toLocaleString()}`).join(' · ') + ' reads' };
  })), [multi, charts0, figure, groups, stale, plot.sourceLabels]);
  const whole = useMemo(() => profileFigureDraw(charts, `${plotDisplayName(plot)} · ${locusText}`), [charts, plot, locusText]);
  const tsv = useCallback(() => profileTsv(plot, figure, start, binBp, locusText), [plot, figure, start, binBp, locusText]);

  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (fresh.state !== 'current' || !entry || entry.seeded || !onResult || entry.groups.length === 0) return;
    const id = `${plot.id}|${entry.key}|${resultIdentity(plot)}`;
    if (reported.current === id) return;
    reported.current = id;
    onResult({ entry, plot, thumb: profileThumbnail(charts[0]) });
  }, [fresh.state, entry, plot, charts, onResult]);

  const blocker = plot.compare !== 'off' && fresh.state === 'current' && !clustersGone ? compareBlocker(baseGroups.length, plot.groupBy) : null;
  // The builder's Compare reads how many groups the plot drew.
  // No clusters here: no request runs, so the count is 0 at once (a stale count never keeps Compare on).
  // Known empty (no clusters, no read groups, no selected features, nothing open): 0 at once; while this plot reloads
  // the count is unknown (Compare is not blocked meanwhile), so an earlier count never outlives its inputs.
  const knownEmpty = clustersGone || (!!readGroups && !readGroups.length) || (featureMode && !features.length) || !target.panels.length;
  // Groups, not lines: one dataset drawn as three sources is still one group (Compare needs two).
  const drawnGroups = knownEmpty ? 0 : fresh.state === 'current' ? (entry ? baseGroups.length : null) : null;
  const reloading = !knownEmpty && fresh.state === 'updating';
  useEffect(() => { if (drawnGroups != null || reloading) reportGroupCount(plot, drawnGroups); }, [drawnGroups, reloading, plot]);
  const summary = useMemo(() => profileSummaryOf({ plot, figure, groups, histogram, start, binBp, anchored: featureMode, unitNoun: 'reads', marksPerBp: isMarkProfile(plot) }),
    [plot, figure, groups, histogram, start, binBp, featureMode, layerColorVersion]);   // eslint-disable-line react-hooks/exhaustive-deps
  const stateLine = profileStateLine(plot, figure, summary);
  const shownWanted = pending && wanted ? wanted : shownTarget;

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid={histogram ? 'plots-histogram-plot' : 'plots-profile-plot'} data-state={clustersGone ? 'no-clusters' : fresh.state}
      data-computed-for={computedFor && fresh.state === 'current' ? locusText : ''} data-type={plot.type}
      data-comparing={figure.comparing ? figure.mode ?? '' : ''} data-groups={multi ? baseGroups.length : groups.length}
      data-sources={JSON.stringify(plotSources(plot))} data-lines={figure.series.length} data-panels={charts.length}
      data-series-per-panel={JSON.stringify(charts.map(c => c.series.length))} data-legend={JSON.stringify(charts.map(c => c.series.map(x => x.label)))}
      data-line-colors={JSON.stringify([...new Set(figure.series.map(x => x.color))])}
      data-seeded={entry?.seeded && fresh.state === 'current' ? 'true' : undefined}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {fresh.state === 'current' && computedFor && !clustersGone && (
          <span className="text-ink-secondary" data-testid="plots-computed-for">{entry?.seeded ? 'From the Gallery · ' : ''}Computed for <b className="font-semibold">{locusText}</b></span>
        )}
        {fresh.state === 'updating' && !clustersGone && (
          <span className="font-medium text-amber-700 dark:text-amber-300" data-testid="plots-updating" role="status">Updating… → {formatLocus(shownWanted)}</span>
        )}
        {fresh.state === 'error' && <span className="text-red-600" data-testid="plots-error">{error}</span>}
        {groups.length > 0 && !stale && (
          <span className="ml-auto inline-flex items-center gap-1" data-testid="plots-export">
            <span className="text-ink-secondary">Export</span>
            <ChartSaveButton inline filename={`${plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80)}_${target.chrom}_${start + 1}`}
              drawFn={ctx => whole.draw(ctx)} width={whole.w} height={whole.h} dataTsv={tsv} />
          </span>
        )}
      </div>
      {clustersGone && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100" data-testid="plots-no-clusters" role="status">
          <b>No clusters at {formatLocus(target)}.</b> This plot is grouped by cluster, and the reads here are not clustered. Cluster the reads here,
          open the clustered plot from the Gallery, or group by dataset.
          {onOpenClustered && <button type="button" className="ml-2 rounded bg-amber-600 px-2 py-0.5 text-[11px] font-semibold text-white" data-testid="plots-open-clustered" onClick={onOpenClustered}>Open the clustered plot (Gallery)</button>}
        </div>
      )}
      {!histogram && <MeasuresHeader testId="plots-profile-measures" short={shortHeader(plot, featureMode ? `${features.length.toLocaleString()} feature windows` : `the view${computedFor ? ` ${locusText}` : ''}`)} details={profileMeasures(plot, featureMode ? `${features.length.toLocaleString()} feature windows` : 'the view')} />}
      {histogram && <MeasuresHeader testId="plots-hist-measures" short={shortHeader(plot, featureMode ? `${features.length.toLocaleString()} feature windows` : `the view${computedFor ? ` ${locusText}` : ''}`)} details={histogramMeasures(plot, featureMode ? `${features.length.toLocaleString()} feature windows` : 'the view')} />}
      {readGroups && groupsBlocker && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" data-testid="plots-groups-blocker" role="status">{groupsBlocker}</div>
      )}
      {plot.compare !== 'off' && baseGroups.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-700 dark:text-gray-200" data-testid="plots-compare-picker">
          <span className="font-medium">Compare</span>
          <select aria-label="Compare mode" value={plot.compareMode} data-testid="plots-compare-mode" onChange={e => onCompare?.({ compareMode: e.target.value as CompareMode })}
            className="input-tool min-h-0 py-0.5 text-[11px]">
            {COMPARE_MODES.map(m => <option key={m.value} value={m.value}>{m.value === 'auto' ? `Default (${figure.mode === 'a-vs-b' ? 'A vs B' : figure.mode === 'each-vs-all' ? 'each vs all' : 'each vs rest'})` : m.label}</option>)}
          </select>
          {figure.mode === 'a-vs-b' && (
            <>
              <span>A</span>
              <select aria-label="Compare A" value={plot.compareAB?.[0] ?? baseGroups[0].id} data-testid="plots-compare-a" className="input-tool min-h-0 py-0.5 text-[11px]"
                onChange={e => onCompare?.({ compareAB: [e.target.value, (plot.compareAB?.[1] ?? baseGroups[1].id) === e.target.value ? (plot.compareAB?.[0] ?? baseGroups[0].id) : (plot.compareAB?.[1] ?? baseGroups[1].id)] })}>
                {baseGroups.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
              <span>vs B</span>
              <select aria-label="Compare B" value={plot.compareAB?.[1] ?? baseGroups[1].id} data-testid="plots-compare-b" className="input-tool min-h-0 py-0.5 text-[11px]"
                onChange={e => onCompare?.({ compareAB: [(plot.compareAB?.[0] ?? baseGroups[0].id) === e.target.value ? (plot.compareAB?.[1] ?? baseGroups[1].id) : (plot.compareAB?.[0] ?? baseGroups[0].id), e.target.value] })}>
                {baseGroups.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            </>
          )}
          <span className="text-ink-secondary">{plot.compare === 'diff' ? 'A − B' : 'log2(A / B)'} of the profile{multi ? ', per source (each source\'s groups compared; a line per source in its colour), one range.' : '; red above 0, blue below, one range.'}</span>
        </div>
      )}
      {blocker && <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" data-testid="plots-compare-blocker" role="status">{blocker}</div>}
      {!stale && <CompareStateText text={stateLine} />}
      {fresh.state === 'current' && entry?.missingSources?.length ? (
        <div className="text-[11px] text-amber-800 dark:text-amber-200" data-testid="plots-missing-sources" role="status">
          Not drawn: {entry.missingSources.map(m => `${sourceLabel(m.source, plot.sourceLabels)} (${m.reason})`).join('; ')}.
        </div>
      ) : null}
      {!shownTarget.panels.length && !clustersGone && <AnalysisStatus kind="empty" center>Open a dataset to plot its profile.</AnalysisStatus>}
      {featureMode && !features.length && <AnalysisStatus kind="empty" center><span className="inline-flex flex-wrap items-center gap-2">No selected features to pool a profile over. <PrereqButton kind="select-peaks" /></span></AnalysisStatus>}
      {shownTarget.panels.length > 0 && !fresh.showResult && fresh.state === 'updating' && (
        <AnalysisStatus kind="loading" compact>Computing {plotDisplayName(plot)} for {formatLocus(shownWanted)}…</AnalysisStatus>
      )}
      {groups.length > 0 && (
        <div className={`flex flex-col gap-2 ${stale ? 'pointer-events-none opacity-40 grayscale' : ''}`} data-testid="plots-profile-charts" aria-busy={stale || undefined}>
          {charts.map((c, i) => (
            <ProfileLinesChart key={`${i}-${c.title ?? ''}`} testId={figure.comparing ? 'plots-profile-compare' : 'plots-profile-chart'} {...c}
              dataTsv={tsv} onPositionClick={stale || histogram || featureMode ? undefined : onPosition} />
          ))}
        </div>
      )}
      {fresh.state === 'current' && entry && groups.length === 0 && !clustersGone && (
        <AnalysisStatus kind="empty" center>No reads with this source in this window.</AnalysisStatus>
      )}
      <ProfileSummaryBlock summary={summary} chart={plot.summary.chart} dark={dark} filename={`${plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 60)}_summary`} />
      {entry?.sampled && fresh.state === 'current' && <div className="text-[11px] text-ink-secondary" data-testid="plots-sampling-counts">{sampleCountsText(entry.sampled, plot.sampling, ds => target.panels.find(p => p.datasetId === ds)?.datasetLabel ?? ds)}</div>}
      <div className="text-[11px] text-ink-secondary" data-testid="plots-caption">
        {histogram
          ? `${histogramMeasures(plot, featureMode ? `${features.length.toLocaleString()} feature windows` : 'the view')}${plot.hist.sigmaBp ? `; Gaussian σ ${plot.hist.sigmaBp} bp` : ''}; up to ${plot.profile.readCap.toLocaleString()} reads per dataset (a seeded sample).`
          : `Bins ${binBp} bp · Gaussian σ ${plot.profile.sigmaBp} bp · positions under ${plot.profile.minCoverage} reads blank · up to ${plot.profile.readCap.toLocaleString()} reads per dataset (a seeded sample).`}
      </div>
    </div>
  );
}

/** "All footprints < 90 bp over the view, fraction of reads; 10 bp bins …; all reads in scope, seed 1": what a metaprofile measures. */
export function profileMeasures(plot: PlotSpec, scope: string): string {
  const p = plot.profile;
  const norm = PROFILE_NORMALIZATIONS.find(n => n.value === p.normalization)?.label.toLowerCase() ?? p.normalization;
  return [`${plotSources(plot).map(x => sourceLabel(x, plot.sourceLabels)).join(' + ')} over ${scope}, ${norm}; ${p.binBp} bp bins${p.sigmaBp ? `, Gaussian σ ${p.sigmaBp} bp` : ''}`, bandsText(p), samplingText(plot.sampling)].filter(Boolean).join('; ');
}
