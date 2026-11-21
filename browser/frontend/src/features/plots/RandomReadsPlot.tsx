/**
 * A size histogram of N random reads of each dataset's whole file (Where = Random reads): progress with Cancel while
 * the reads are drawn, then the histogram (every footprint of every read), the header saying what it measures and the
 * seed, the Gallery hand-off and export as for the other line plots.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { ProfileLinesChart } from '../../components/charts/ProfileLinesChart';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import type { FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { AnalysisStatus } from '../../components/controls/shared';
import { plotFreshness } from './follow';
import { plotDisplayName, type PlotSpec } from './plotModel';
import { profileCharts, profileFigureDraw, profileThumbnail, profileTsv } from './profileFigure';
import { histogramAxis, histogramFigure, histogramMeasures } from './sizeHistogram';
import { useRandomReadsData } from './randomReads';
import { sampleCountsText, type ProfileEntry } from './useProfileData';
import { BedProgressLine } from './BedPlot';
import type { MetaprofileResult } from './MetaprofilePlot';
import { MeasuresHeader, shortHeader } from './MeasuresHeader';
import { reportGroupCount } from './compareState';
import { CompareStateText, profileStateLine } from './ProfileSummaryBlock';

export function RandomReadsPlot({ plot, target, width, settingsKey, seed, onResult }: {
  plot: PlotSpec; target: FootprintSizesTarget; width: number; settingsKey: string; seed?: ProfileEntry | null; onResult?: (r: MetaprofileResult) => void;
}) {
  const dark = useBrowserStore(s => s.darkMode);
  const { entry, requestKey, loading, error, progress, cancelled, cancel, retry } = useRandomReadsData({ plot, target, settingsKey, enabled: true, seed });
  const fresh = plotFreshness({ resultKey: entry?.key ?? null, wantKey: requestKey, pending: false, loading, error });
  const groups = useMemo(() => (fresh.showResult && entry ? entry.groups : []), [fresh.showResult, entry]);
  const figure = useMemo(() => histogramFigure(plot, groups), [plot, groups]);
  const scope = 'random reads of the whole file';
  const charts = useMemo(() => profileCharts(figure, { start: plot.hist.sizeMin, binBp: plot.hist.binBp, width: Math.max(320, width), height: figure.comparing ? 200 : 300, dark,
    subtitle: groups.map(g => `${g.title}: ${g.raw.nReads.toLocaleString()} reads`).join(' · '), filename: plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80), ...histogramAxis(plot.hist) }),
  [figure, plot, width, dark, groups]);
  const whole = useMemo(() => profileFigureDraw(charts, `${plotDisplayName(plot)} · ${histogramMeasures(plot, scope)}`), [charts, plot]);
  const tsv = () => `# measures: ${histogramMeasures(plot, scope)}\n${profileTsv(plot, figure, plot.hist.sizeMin, plot.hist.binBp, 'whole file')}`;
  // The builder's Compare reads how many groups the plot drew; the state line says what is compared.
  const drawnGroups = !target.panels.length ? 0 : fresh.state === 'current' && entry ? groups.length : null;
  useEffect(() => { if (drawnGroups != null) reportGroupCount(plot, drawnGroups); }, [drawnGroups, plot]);
  const stateLine = fresh.state === 'current' ? profileStateLine(plot, figure, null) : null;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (fresh.state !== 'current' || !entry || entry.seeded || !onResult || !entry.groups.length) return;
    const id = `${plot.id}|${entry.key}`;
    if (reported.current === id) return;
    reported.current = id;
    onResult({ entry, plot, thumb: profileThumbnail(charts[0]) });
  }, [fresh.state, entry, plot, charts, onResult]);
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="plots-random-plot" data-state={cancelled ? 'cancelled' : fresh.state} data-groups={groups.length}
      data-seeded={entry?.seeded && fresh.state === 'current' ? 'true' : undefined}>
      <MeasuresHeader testId="plots-hist-measures" short={shortHeader(plot, 'random reads of the whole file')} details={histogramMeasures(plot, scope)} />
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {loading && progress && !cancelled && <BedProgressLine progress={progress} onCancel={cancel} />}
        {cancelled && <span className="inline-flex items-center gap-2 text-amber-800" data-testid="plots-random-cancelled" role="status">Cancelled.
          <button type="button" className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-semibold" onClick={retry} data-testid="plots-random-retry">Read again</button></span>}
        {fresh.state === 'error' && <span className="text-red-600" data-testid="plots-error">{error}</span>}
        {groups.length > 0 && (
          <span className="ml-auto inline-flex items-center gap-1" data-testid="plots-export">
            <span className="text-ink-secondary">Export</span>
            <ChartSaveButton inline filename={plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80)} drawFn={ctx => whole.draw(ctx)} width={whole.w} height={whole.h} dataTsv={tsv} />
          </span>
        )}
      </div>
      {!target.panels.length && <AnalysisStatus kind="empty" center>Open a dataset to draw random reads from it.</AnalysisStatus>}
      <CompareStateText text={stateLine} />
      {groups.length > 0 && charts.map((c, i) => <ProfileLinesChart key={i} testId={figure.comparing ? 'plots-profile-compare' : 'plots-profile-chart'} {...c} dataTsv={tsv} />)}
      {entry?.sampled && fresh.state === 'current' && (
        <div className="text-[11px] text-ink-secondary" data-testid="plots-sampling-counts">{sampleCountsText(entry.sampled, plot.sampling, ds => target.panels.find(p => p.datasetId === ds)?.datasetLabel ?? ds)}</div>
      )}
    </div>
  );
}
