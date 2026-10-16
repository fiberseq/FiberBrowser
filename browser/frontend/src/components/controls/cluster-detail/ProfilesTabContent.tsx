import { OverlayProfileChart } from '../../charts/OverlayProfileChart';
import { getLayerColor, getLayerLabel } from '../../../utils/layerColors';
import type { ClusterSummary } from './OverviewTabContent';
import { getClusterLabel } from '../../tracks/ReadTrack';
import { pickedClusterData, useClusterPicks } from './clusterPicks';
import { ClusterPickChips } from './ClusterPickChips';

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
  getDatasetColor,
}: ProfilesTabContentProps) {
  // Only the picked clusters (picked here, in the read panel or on the map); all when none is.
  const picks = useClusterPicks(datasetIds);
  const shownClusterData = pickedClusterData(visibleClusterData, picks.picked);
  const activeLayers = Object.entries(enabledMetaProfiles)
    .filter(([, v]) => v)
    .map(([k]) => k);

  if (activeLayers.length === 0) {
    return (
      <div className="text-xs text-ink-secondary italic py-2">
        No metaprofile layers enabled. Add or enable metaprofile sources
        in Tracks to populate this view.
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="cluster-profiles">
      <ClusterPickChips clusters={visibleClusterData} picks={picks} testId="profiles-picks" />
      {datasetIds.map(sk => (
        <div key={sk} className="space-y-2">
          {multiDs && (
            <div className="text-[11px] flex items-center gap-1 mb-0.5">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getDatasetColor(sk) }} />
              <span className="text-gray-600 dark:text-gray-300">{getDatasetLabel(sk)}</span>
            </div>
          )}
          {activeLayers.map(layerKey => {
            const series = shownClusterData.map(cd => ({
              data: clusterProfiles[sk]?.[cd.cluster]?.[layerKey] || [],
              color: cd.color,
              label: getClusterLabel(cd.cluster, true),
            })).filter(s => s.data.length > 0);
            if (series.length === 0) return null;
            return (
              <div key={layerKey} data-testid="cluster-profile-chart" data-series={series.map(item => item.label).join(',')}>
                <div className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-400 mb-0.5">
                  <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: getLayerColor(layerKey) }} />
                  <span>{getLayerLabel(layerKey)}</span>
                </div>
                <OverlayProfileChart
                  series={series}
                  width={chartWidth}
                  height={isFullView ? 140 : 70}
                  showLegend={true}
                  isReversed={isReversed}
                  yLabel={getLayerLabel(layerKey)}
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
