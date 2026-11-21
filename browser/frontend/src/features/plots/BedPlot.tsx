/**
 * A plot of BED region sets (Where = BED region sets): Metaprofile (one line per set, or set × dataset) or Heatmap
 * (a row per region, in blocks per set), on the profile engine; Compare (A − B, log2 A/B) between sets; the counts of
 * regions used / total, reads, and what the occlusion filter excluded, on every plot. Pinned to the sets (moving the
 * view leaves it). Same Gallery hand-off and export as the other types.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { ProfileLinesChart } from '../../components/charts/ProfileLinesChart';
import { HeatmapRowsChart, drawHeatmapRows, heatmapRange } from '../../components/charts/HeatmapRowsChart';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import type { FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { AnalysisStatus } from '../../components/controls/shared';
import { COMPARE_MODES, type CompareMode } from './compare';
import { plotFreshness } from './follow';
import { packProfile, resultIdentity, type PackedHeatmap, type PackedProfile } from './gallery';
import { plotDisplayName, type PlotSpec } from './plotModel';
import { isMarkProfile, profileCharts, profileFigure, profileFigureDraw, profileThumbnail, profileTsv } from './profileFigure';
import { heatmapFigure, heatmapTsv } from './heatmapData';
import { histogramAxis, histogramFigure, histogramMeasures } from './sizeHistogram';
import { CompareStateText, ProfileSummaryBlock, profileStateLine, profileSummaryOf } from './ProfileSummaryBlock';
import { reportGroupCount } from './compareState';
import { heatmapThumbnail, packHeatmap } from './HeatmapPlot';
import { bedAxis, useBedData, type BedEntry, type BedProgress } from './bedData';
import { regionHeatmapHeader } from './regionHeatmap';
import { RegionHeatmapActions } from './RegionHeatmapActions';
import { footprintSizeLayerLabel } from '../../utils/footprintSizeSettings';
import { sampleCountsText } from './useProfileData';
import type { RegionSet } from './bedRegions';
import { MeasuresHeader, shortHeader } from './MeasuresHeader';

/** Regions done of the total and the time since the read began, with Cancel (the server stops when the request goes). */
export function BedProgressLine({ progress, onCancel }: { progress: BedProgress; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(t); }, []);
  const secs = Math.max(0, (now - progress.startedAt) / 1000);
  const pct = progress.total ? Math.round((100 * progress.done) / progress.total) : 0;
  return (
    <span className="inline-flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300" data-testid="plots-bed-progress" role="status"
      data-done={progress.done} data-total={progress.total ?? ''}>
      <span>Reading regions {progress.done.toLocaleString()} / {progress.total == null ? '…' : progress.total.toLocaleString()} · {secs.toFixed(1)} s</span>
      <span className="inline-block h-1.5 w-24 overflow-hidden rounded bg-amber-100 dark:bg-amber-900/40" aria-hidden="true">
        <span className="block h-full bg-amber-600" style={{ width: `${pct}%` }} />
      </span>
      <button type="button" data-testid="plots-bed-cancel" onClick={onCancel}
        className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-100">Cancel</button>
    </span>
  );
}

export interface BedResult { entry: BedEntry; plot: PlotSpec; thumb: string; profile?: PackedProfile; heatmap?: PackedHeatmap }

export function BedPlot({ plot, sets, target, width, sampleSeed, settingsKey, seed, onResult, onCompare }: {
  plot: PlotSpec; sets: RegionSet[]; target: FootprintSizesTarget; width: number; sampleSeed: string; settingsKey: string;
  seed?: BedEntry | null; onResult?: (r: BedResult) => void; onCompare?: (patch: Partial<Pick<PlotSpec, 'compareMode' | 'compareAB'>>) => void;
}) {
  const dark = useBrowserStore(s => s.darkMode);
  const datasets = useBrowserStore(s => s.datasets);
  const datasetLabels = useMemo(() => Object.fromEntries(datasets.map(d => [d.id, d.label ?? d.id])), [datasets]);
  const chosen = useMemo(() => sets.filter(s => plot.bed.setIds.includes(s.id)), [sets, plot.bed.setIds]);
  const { entry, requestKey, loading, error, progress, cancelled, cancel, retry } = useBedData({ plot, sets: chosen, target, sampleSeed, settingsKey, enabled: true, datasetLabels, seed });
  const fresh = plotFreshness({ resultKey: entry?.key ?? null, wantKey: requestKey, pending: false, loading, error });
  const shown = fresh.showResult ? entry : null;
  const axis = bedAxis(plot);
  const heat = plot.type === 'heatmap';
  const title = plotDisplayName(plot);
  const fname = title.replace(/[^\w.-]+/g, '_').slice(0, 80);

  const histogram = plot.type === 'size-histogram';
  const usedRegions = shown ? shown.counts.reduce((a, c) => a + c.regionsUsed, 0) : 0;
  const bedScope = `${usedRegions.toLocaleString('en-US')} regions${plot.bed.mode === 'scale' ? '' : ` (±${plot.bed.flankBp.toLocaleString('en-US')} bp around the ${plot.bed.anchor === 'centre' ? 'centre' : plot.bed.anchor})`}`;
  const profile = useMemo(() => (shown && !heat ? (histogram ? histogramFigure(plot, shown.profile.groups) : profileFigure(plot, shown.profile.groups, axis.binBp)) : null), [shown, heat, histogram, plot, axis.binBp]);
  const pCharts = useMemo(() => (profile ? profileCharts(profile, {
    start: histogram ? plot.hist.sizeMin : axis.start, binBp: histogram ? plot.hist.binBp : axis.binBp, width: Math.max(320, width), height: profile.comparing ? 200 : 300, dark, filename: fname,
    subtitle: shown?.countsText, ...(histogram ? histogramAxis(plot.hist) : { xLabel: axis.label, ...(axis.ticks ? { xTicks: axis.ticks } : {}) }),
  }) : []), [profile, axis, width, dark, fname, shown]);
  const hFig = useMemo(() => (shown && heat ? heatmapFigure(plot, shown.heatmap) : null), [shown, heat, plot]);
  const rows = hFig?.blocks.reduce((n, b) => n + b.rows.length, 0) ?? 0;
  const heatHeader = hFig && shown ? regionHeatmapHeader({ source: footprintSizeLayerLabel(plot.source), regions: usedRegions, what: 'BED regions',
    window: plot.bed.mode === 'scale' ? `scaled (${plot.bed.scaleFlankBp.toLocaleString('en-US')} bp flanks)` : `±${plot.bed.flankBp.toLocaleString('en-US')} bp`,
    sort: plot.heatmap, seed: plot.sampling.seed, clusters: hFig.clusters?.length ?? null, subsample: plot.bed.subsample === 'random' ? `random ${plot.bed.n.toLocaleString('en-US')} regions per set` : plot.bed.subsample === 'equal' ? 'equal regions per set' : null }) : '';
  const hChart = hFig && shown ? {
    blocks: hFig.blocks, start: axis.start, binBp: axis.binBp, relative: true, width: Math.max(360, width), height: Math.max(220, Math.min(820, 60 + rows * 3 + (hFig.profile ? 112 : 0))),
    valueLabel: hFig.valueLabel, colormap: hFig.colormap, reverse: hFig.reverse, signed: hFig.signed, range: heatmapRange(hFig.blocks, hFig.signed), dark, profile: hFig.profile, subtitleInExportOnly: true,
    subtitle: heatHeader ? shortHeader(plot, `${usedRegions.toLocaleString('en-US')} BED regions`) : '', filename: fname, xLabel: axis.label, ...(axis.ticks ? { xTicks: axis.ticks } : {}),
  } : null;
  const tsv = useCallback(() => {
    if (!shown) return '';
    const head = `# regions: ${shown.countsText}`;
    if (hFig) return `${head}\n${heatmapTsv(plot, hFig, shown.heatmap, 'BED region sets')}`;
    return profile ? `${head}\n${histogram ? `# measures: ${histogramMeasures(plot, bedScope)}\n` : ''}${profileTsv(plot, profile, histogram ? plot.hist.sizeMin : axis.start, histogram ? plot.hist.binBp : axis.binBp, 'BED region sets')}` : '';
  }, [shown, hFig, profile, plot, axis, histogram, bedScope]);
  const whole = useMemo(() => profileFigureDraw(pCharts, `${title} · ${chosen.map(s => s.name).join(', ')}`), [pCharts, title, chosen]);

  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (fresh.state !== 'current' || !entry || entry.seeded || !onResult) return;
    const id = `${plot.id}|${entry.key}|${resultIdentity(plot)}`;
    if (reported.current === id) return;
    reported.current = id;
    onResult(heat
      ? { entry, plot, thumb: heatmapThumbnail(hChart), heatmap: packHeatmap(entry.heatmap, plot.heatmap.maxRows) }
      : { entry, plot, thumb: profileThumbnail(pCharts[0]), profile: packProfile(entry.profile.binBp, entry.profile.groups) });
  }, [fresh.state, entry, plot, heat, hChart, pCharts, onResult]);

  const groups = shown?.profile.groups ?? [];
  // The builder's Compare reads how many groups the plot drew (the profile's lines; a region heatmap's are its own).
  // A region heatmap compares its own groups (heatmapData: two or more), so it reports those.
  const drawnGroups = fresh.state === 'current' && shown ? (heat ? (shown.heatmap?.groups?.length ?? 0) : groups.length) : null;
  useEffect(() => { if (drawnGroups != null) reportGroupCount(plot, drawnGroups); }, [drawnGroups, plot]);
  const summary = useMemo(() => (profile && shown && !heat ? profileSummaryOf({ plot, figure: profile, groups: shown.profile.groups, histogram,
    start: histogram ? plot.hist.sizeMin : axis.start, binBp: histogram ? plot.hist.binBp : axis.binBp, anchored: true,
    unitNoun: plot.summary.unit === 'reads' ? 'reads' : 'regions', marksPerBp: isMarkProfile(plot) }) : null), [profile, shown, heat, plot, histogram, axis]);
  const stateLine = profile && !fresh.stale ? profileStateLine(plot, profile, summary) : null;
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="plots-bed-plot" data-state={fresh.state} data-sets={chosen.length}
      data-groups={groups.length} data-rows={rows} data-seeded={entry?.seeded && fresh.state === 'current' ? 'true' : undefined}
      data-dashes={groups.filter(g => g.dash && g.dash.length).length} data-comparing={profile?.comparing || hFig?.comparing ? 'yes' : ''}>
      {!chosen.length && <AnalysisStatus kind="empty" center>Add a BED file by path and tick it (More options › Where: BED region sets).</AnalysisStatus>}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {shown && histogram && <MeasuresHeader testId="plots-hist-measures" short={shortHeader(plot, `${usedRegions.toLocaleString('en-US')} BED regions`)} details={histogramMeasures(plot, bedScope)} />}
        {shown && <span className="text-ink-secondary" data-testid="plots-bed-counts">{shown.countsText}</span>}
        {shown?.sampled && <span className="basis-full text-ink-secondary" data-testid="plots-sampling-counts">{sampleCountsText(shown.sampled, plot.sampling, ds => datasetLabels[ds] ?? ds)}</span>}
        {fresh.state === 'updating' && chosen.length > 0 && !cancelled && (progress
          ? <span data-testid="plots-updating"><BedProgressLine progress={progress} onCancel={cancel} /></span>
          : <span className="font-medium text-amber-700" data-testid="plots-updating" role="status">Reading regions…</span>)}
        {cancelled && (
          <span className="inline-flex items-center gap-2 text-amber-800 dark:text-amber-200" data-testid="plots-bed-cancelled" role="status">
            Cancelled{progress ? ` after ${progress.done.toLocaleString()} of ${progress.total?.toLocaleString() ?? '?'} regions` : ''}.
            <button type="button" data-testid="plots-bed-retry" onClick={retry} className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-semibold">Read again</button>
          </span>
        )}
        {fresh.state === 'error' && <span className="text-red-600" data-testid="plots-error">{error}</span>}
        {shown && !fresh.stale && (
          <span className="ml-auto inline-flex items-center gap-1" data-testid="plots-export">
            <span className="text-ink-secondary">Export</span>
            {hChart
              ? <ChartSaveButton inline filename={fname} drawFn={(ctx, w, h) => drawHeatmapRows(ctx, w, h, hChart)} width={hChart.width} height={hChart.height} dataTsv={tsv} />
              : <ChartSaveButton inline filename={fname} drawFn={ctx => whole.draw(ctx)} width={whole.w} height={whole.h} dataTsv={tsv} />}
          </span>
        )}
      </div>
      {plot.compare !== 'off' && groups.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="plots-compare-picker">
          <span className="font-medium">Compare</span>
          <select aria-label="Compare mode" value={plot.compareMode} data-testid="plots-compare-mode" onChange={e => onCompare?.({ compareMode: e.target.value as CompareMode })}
            className="input-tool min-h-0 py-0.5 text-[11px]">
            {COMPARE_MODES.map(m => <option key={m.value} value={m.value}>{m.value === 'auto' ? 'Default' : m.label}</option>)}
          </select>
          <span className="text-ink-secondary">between sets (and datasets); RdBu centred on 0.</span>
        </div>
      )}
      <CompareStateText text={stateLine} />
      {heatHeader && <MeasuresHeader testId="plots-heatmap-measures" short={shortHeader(plot, `${usedRegions.toLocaleString('en-US')} BED regions`)} details={heatHeader} />}
      {heat && <RegionHeatmapActions figure={hFig} base={chosen.map(s => s.name).join('+') || title} />}
      <div className={fresh.stale ? 'pointer-events-none opacity-40 grayscale' : ''}>
        {pCharts.map((c, i) => <ProfileLinesChart key={i} testId={profile?.comparing ? 'plots-profile-compare' : 'plots-profile-chart'} {...c} dataTsv={tsv} />)}
        {hChart && <HeatmapRowsChart {...hChart} testId="plots-heatmap-chart" dataTsv={tsv} />}
      </div>
      <ProfileSummaryBlock summary={summary} chart={plot.summary.chart} dark={dark} filename={`${fname}_summary`} />
      {fresh.state === 'current' && shown && !groups.length && <AnalysisStatus kind="empty" center>No reads over these regions.</AnalysisStatus>}
    </div>
  );
}
