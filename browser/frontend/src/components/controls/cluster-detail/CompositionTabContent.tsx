import { useMemo, useState } from 'react';
import { DonutChart, type DonutSegment } from '../../charts/DonutChart';
import type { ClusterSummary } from './OverviewTabContent';
import { getClusterLabel } from '../../tracks/ReadTrack';
import { AnalysisToggleGroup } from '../shared';
import { ClusterBarChart, ClusterLineChart } from './ClusterCharts';
import { pickedClusterData, useClusterPicks } from './clusterPicks';
import { ClusterPickChips } from './ClusterPickChips';

export type CompositionChartMode = 'bar' | 'pie' | 'line';

interface CompositionTabContentProps {
  datasetIds: string[];
  multiDs: boolean;
  /** The clusters on show (the hidden ones left out). */
  visibleClusterData: ClusterSummary[];
  /** Every cluster: the denominators (all assigned reads) and the test family. */
  allClusterData?: ClusterSummary[];
  chartWidth: number;
  isFullView?: boolean;
  getDatasetLabel: (datasetId: string) => string | undefined;
}

/**
 * Each dataset's share of reads in each drawn cluster. The denominator is
 * always every assigned read of the dataset (all clusters, hidden or not):
 * restricting it to the drawn clusters would turn one picked cluster into
 * 100% everywhere and defeat the coverage-aware comparisons.
 */
export function compositionProportions(
  allClusterData: ClusterSummary[],
  drawnClusterData: ClusterSummary[],
  nDatasets: number,
) {
  const datasetTotals = Array.from({ length: nDatasets }, (_, i) =>
    allClusterData.reduce((sum, cd) => sum + (cd.counts[i] ?? 0), 0));
  const proportions = new Map<number, number[]>();
  const counts = new Map<number, number[]>();
  for (const cd of drawnClusterData) {
    proportions.set(cd.cluster, datasetTotals.map((total, i) => (total > 0 ? (cd.counts[i] ?? 0) / total : 0)));
    counts.set(cd.cluster, datasetTotals.map((_, i) => cd.counts[i] ?? 0));
  }
  return {
    proportions,
    counts,
    comparisonCounts: new Map(allClusterData.map(cd => [cd.cluster, [...cd.counts]])),
    comparisonClusterIds: allClusterData.map(cd => cd.cluster),
    datasetTotals,
    colors: new Map(allClusterData.map(cd => [cd.cluster, cd.color])),
    clusterIds: drawnClusterData.map(cd => cd.cluster),
  };
}

/** A dataset's pie: the drawn clusters, the others folded into one grey "Other clusters" slice. */
export function compositionPieSegments(
  allClusterData: ClusterSummary[],
  drawnClusterData: ClusterSummary[],
  datasetIndex: number,
): DonutSegment[] {
  const drawn = new Set(drawnClusterData.map(cd => cd.cluster));
  const segments: DonutSegment[] = drawnClusterData.map(cd => ({
    label: getClusterLabel(cd.cluster, true),
    value: cd.counts[datasetIndex] ?? 0,
    color: cd.color,
  }));
  const other = allClusterData
    .filter(cd => !drawn.has(cd.cluster))
    .reduce((sum, cd) => sum + (cd.counts[datasetIndex] ?? 0), 0);
  if (other > 0) segments.push({ label: 'Other clusters', value: other, color: '#d1d5db' });
  return segments;
}

export function CompositionTabContent({
  datasetIds,
  multiDs,
  visibleClusterData,
  allClusterData = visibleClusterData,
  chartWidth,
  isFullView,
  getDatasetLabel,
}: CompositionTabContentProps) {
  const [chosenMode, setMode] = useState<CompositionChartMode>('bar');
  // Lines join the datasets, so they need two.
  const lineAvailable = datasetIds.length >= 2;
  const mode: CompositionChartMode = chosenMode === 'line' && !lineAvailable ? 'bar' : chosenMode;
  const picks = useClusterPicks(datasetIds);
  const drawn = useMemo(
    () => pickedClusterData(visibleClusterData, picks.picked),
    [visibleClusterData, picks.picked],
  );
  const data = useMemo(
    () => compositionProportions(allClusterData, drawn, datasetIds.length),
    [allClusterData, drawn, datasetIds.length],
  );
  const datasetLabels = datasetIds.map(sk => getDatasetLabel(sk) ?? sk);
  const height = isFullView ? 220 : 150;

  return (
    <div className="space-y-1.5" data-testid="cluster-composition" data-composition-mode={mode}>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <div className="text-[11px] text-gray-600 dark:text-gray-300">
          Share of each dataset's reads in each cluster
        </div>
        <AnalysisToggleGroup<CompositionChartMode>
          value={mode}
          onChange={value => value && setMode(value)}
          theme="cyan"
          options={[
            { value: 'bar', label: 'Bar', title: 'Bars: each cluster\'s share of the reads, side by side' },
            { value: 'pie', label: 'Pie', title: 'Pie: the whole of each dataset split by cluster' },
            {
              value: 'line',
              label: 'Line',
              disabled: !lineAvailable,
              title: lineAvailable
                ? 'Lines: each cluster\'s share across the datasets'
                : 'Lines join datasets: load two or more to compare them',
            },
          ]}
        />
      </div>
      <ClusterPickChips clusters={visibleClusterData} picks={picks} testId="composition-picks" />
      {mode === 'bar' && (
        <div data-testid="composition-bar">
          <ClusterBarChart
            proportions={data.proportions}
            counts={data.counts}
            comparisonCounts={data.comparisonCounts}
            comparisonClusterIds={data.comparisonClusterIds}
            datasetTotals={data.datasetTotals}
            datasetLabels={datasetLabels}
            clusterColors={data.colors}
            clusterIds={data.clusterIds}
            visibleClusterIds={null}
            width={chartWidth}
            height={height}
          />
        </div>
      )}
      {mode === 'line' && (
        <div data-testid="composition-line">
          <ClusterLineChart
            proportions={data.proportions}
            counts={data.counts}
            comparisonCounts={data.comparisonCounts}
            comparisonClusterIds={data.comparisonClusterIds}
            datasetTotals={data.datasetTotals}
            datasetLabels={datasetLabels}
            clusterColors={data.colors}
            clusterIds={data.clusterIds}
            visibleClusterIds={null}
            width={chartWidth}
            height={height}
          />
        </div>
      )}
      {mode === 'pie' && (
        <div className="flex flex-wrap gap-2 justify-center" data-testid="composition-pie">
          {datasetIds.map((sk, di) => (
            <DonutChart
              key={sk}
              title={multiDs ? getDatasetLabel(sk) : undefined}
              segments={compositionPieSegments(allClusterData, drawn, di)}
              width={multiDs ? Math.max(120, Math.floor(chartWidth / datasetIds.length) - 8) : chartWidth}
              height={isFullView ? 220 : 160}
              showConfidenceIntervals
            />
          ))}
        </div>
      )}
      <div className="text-[11px] text-ink-secondary text-center">
        {mode === 'pie'
          ? 'Out of all the dataset\'s assigned reads; 95% intervals (reads as units) are listed under each pie.'
          : 'Out of all the dataset\'s assigned reads; whiskers are 95% intervals with reads as units.'}
      </div>
    </div>
  );
}
