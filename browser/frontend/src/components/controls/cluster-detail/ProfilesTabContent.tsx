import { OverlayProfileChart } from '../../charts/OverlayProfileChart';
import { channelColor as getLayerColor, channelLabel as getLayerLabel } from '../../../utils/clusterViewChannels';
import type { ClusterSummary } from './OverviewTabContent';
import { getClusterLabel } from '../../tracks/ReadTrack';
import { pickedClusterData, useClusterPicks } from './clusterPicks';
import { ClusterPickChips } from './ClusterPickChips';
import { useMemo } from 'react';
import { PlotSetYScaleControl, usePlotSetYScale } from '../../charts/PlotSetYScaleControl';
import type { PlotSetMember } from '../../../utils/plotSetYScale';
import { fullSetLegend } from '../../../utils/plotSetLegend';
import {
  baselineNote, channelBaseline, clusterAxisLabel, clusterChannelUnit, clusterEnrichmentSupported, clusterRefLine,
  clusterShownValues, coveredExtent, ENRICHMENT_OFF_REGULARITY, useClusterYScale, type ShownValues,
} from './clusterYScale';
import { useLayerColorVersion } from '../../../features/layerColours/state';

interface ProfilesTabContentProps {
  datasetIds: string[];
  multiDs: boolean;
  visibleClusterData: ClusterSummary[];
  clusterProfiles: Record<string, Record<number, Record<string, number[]>>>;
  enabledMetaProfiles: Record<string, boolean>;
  chartWidth: number;
  isFullView?: boolean;
  isReversed: boolean;
  getDatasetLabel: (datasetId: string) => string | undefined;
  getDatasetColor: (datasetId: string) => string | undefined;
  /** A layer's name in one dataset view (the accessibility layer reads "FIRE" for a FIRE file). */
  getLayerLabelFor?: (datasetId: string, layerKey: string) => string;
}

export function ProfilesTabContent({
  datasetIds,
  multiDs,
  visibleClusterData,
  clusterProfiles,
  enabledMetaProfiles,
  chartWidth,
  isFullView,
  isReversed,
  getDatasetLabel,
  getLayerLabelFor,
  getDatasetColor,
}: ProfilesTabContentProps) {
  // Re-render when the user's layer colours change (Labels → Layer colours).
  useLayerColorVersion();
  // Only the picked clusters (picked here, in the read panel or on the map); all when none is.
  const picks = useClusterPicks(datasetIds);
  const shownClusterData = pickedClusterData(visibleClusterData, picks.picked);
  const activeLayers = Object.entries(enabledMetaProfiles)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const { yScale, setYScale, datasetProfiles, readCounts } = useClusterYScale(datasetIds);

  // One chart per dataset x channel, each overlaying the shown clusters; values raw or relative to the baseline
  // (built from every cluster in the dataset, so picking or hiding clusters never moves it).
  const charts = useMemo(() => datasetIds.flatMap(sk => activeLayers.map(layerKey => {
    const allClusters = Object.entries(clusterProfiles[sk] ?? {}).map(([c, byKey]) => ({
      data: byKey?.[layerKey] ?? [], reads: readCounts[sk]?.[Number(c)] ?? 0,
    })).filter(c => c.data.length > 0);
    const baseline = channelBaseline(layerKey, datasetProfiles[sk], allClusters);
    const series = shownClusterData.map(cd => {
      const data = clusterProfiles[sk]?.[cd.cluster]?.[layerKey] || [];
      const shown: ShownValues = clusterShownValues(layerKey, data, yScale, baseline, coveredExtent(clusterProfiles[sk]?.[cd.cluster]));
      return {
        cluster: cd.cluster, data: shown.values, shown, color: cd.color, label: getClusterLabel(cd.cluster, true),
        reads: readCounts[sk]?.[cd.cluster] ?? cd.totalCount,
      };
    }).filter(item => item.data.length > 0);
    // Every chart of the set lists every cluster on show (same order, same room), so the plots line up; a cluster
    // with no data for this channel stays in the legend, hollow.
    const has = new Set(series.map(x => String(x.cluster)));
    const layerLabel = getLayerLabelFor ? getLayerLabelFor(sk, layerKey) : getLayerLabel(layerKey);
    const legendItems = fullSetLegend(shownClusterData.map(cd => ({ key: String(cd.cluster), label: getClusterLabel(cd.cluster, true), color: cd.color })),
      k => has.has(k), () => `no ${layerLabel} in this cluster`);
    return { id: `${sk}\u0000${layerKey}`, sk, layerKey, series, baseline, legendItems };
  // getLayerLabelFor (an inline callback) only names the layer in the missing-data note: left out, so the charts
  // aren't rebuilt on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [datasetIds, activeLayers.join(','), clusterProfiles, shownClusterData, yScale, datasetProfiles, readCounts]);
  const members = useMemo<PlotSetMember[]>(() => charts.map(c => ({
    id: c.id, dataset: c.sk, channel: c.layerKey,
    unit: clusterEnrichmentSupported(c.layerKey) && yScale.value === 'enrichment' ? `enrichment:${yScale.form}` : clusterChannelUnit(c.layerKey),
    series: c.series.map(x => ({ values: x.data, reads: x.reads })),
  })), [charts, yScale.value, yScale.form]);
  const domains = usePlotSetYScale(members, yScale);
  const allRegularity = activeLayers.length > 0 && activeLayers.every(k => !clusterEnrichmentSupported(k));
  const note = baselineNote(charts.flatMap(c => c.series.map(x => x.shown)), yScale);

  if (activeLayers.length === 0) {
    return (
      <div className="text-xs text-ink-secondary italic py-2">
        No metaprofile layers enabled. Add or enable metaprofile sources
        in Tracks, or pick a channel above, to populate this view.
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="cluster-profiles">
      <ClusterPickChips clusters={visibleClusterData} picks={picks} testId="profiles-picks" />
      <PlotSetYScaleControl
        value={yScale}
        onChange={setYScale}
        testId="cluster-profiles-yscale"
        rawLabel="Fraction"
        enrichment={allRegularity ? ENRICHMENT_OFF_REGULARITY : true}
        scope={multiDs ? true : 'One dataset on show: its plots already share within it'}
        shareChannels
        smallReads
        sharedHint="The clusters in one chart already share its axis; Shared y lines up the charts of a channel across datasets (across all datasets) or across channels"
        note={note}
      />
      {datasetIds.map(sk => (
        <div key={sk} className="space-y-2">
          {multiDs && (
            <div className="text-[11px] flex items-center gap-1 mb-0.5">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getDatasetColor(sk) }} />
              <span className="text-gray-600 dark:text-gray-300">{getDatasetLabel(sk)}</span>
            </div>
          )}
          {charts.filter(c => c.sk === sk).map(({ id, layerKey, series, legendItems }) => {
            if (series.length === 0) return null;
            const layerLabel = getLayerLabelFor ? getLayerLabelFor(sk, layerKey) : getLayerLabel(layerKey);
            const axisLabel = clusterAxisLabel(layerKey, yScale, layerLabel);
            const rawHere = yScale.value === 'enrichment' && !clusterEnrichmentSupported(layerKey);
            return (
              <div key={layerKey} data-testid="cluster-profile-chart" data-layer={layerKey} data-series={series.map(item => item.label).join(',')}>
                <div className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">
                  <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: getLayerColor(layerKey) }} />
                  <span>{layerLabel}</span>
                  {axisLabel !== layerLabel && <span className="text-ink-muted">· {axisLabel}</span>}
                  {rawHere && <span className="text-ink-muted" title={ENRICHMENT_OFF_REGULARITY}>· raw (no enrichment for this channel)</span>}
                  {yScale.mode === 'shared' && <span className="text-ink-muted">· shared y</span>}
                </div>
                <OverlayProfileChart
                  series={series}
                  legendItems={legendItems}
                  width={chartWidth}
                  height={isFullView ? 140 : 70}
                  showLegend={true}
                  isReversed={isReversed}
                  yLabel={axisLabel}
                  yDomain={yScale.mode === 'shared' ? domains.byId[id] : undefined}
                  refLine={clusterRefLine(layerKey, yScale)}
                  valueLabel={axisLabel}
                  filename={`cluster_profile_${sk}_${layerKey}`}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
