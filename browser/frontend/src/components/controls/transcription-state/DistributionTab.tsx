import type { TranscriptionStateFilterResult } from '../../../api/transcription';
import { HistogramChart } from '../../charts/HistogramChart';
import type { HistogramGroup } from '../../charts/HistogramChart';
import { getDatasetDisplayLabel } from '../../../utils/datasetLabels';
import { wilsonInterval } from '../../../utils/statistics';
import { classifiedTotal } from './FiltersTab';

interface DatasetDisplay {
  id: string;
  label: string;
  color: string;
}

const formatPolIIMean = (value: number) => value.toFixed(1);

export function DistributionTab({
  elongatingGroups,
  perClusterPolII,
  targetDatasets,
  filteredSummary,
  chartWidth,
  isFullView,
}: {
  elongatingGroups: HistogramGroup[];
  perClusterPolII: HistogramGroup[];
  targetDatasets: DatasetDisplay[];
  filteredSummary: Record<string, TranscriptionStateFilterResult['summary']>;
  chartWidth: number;
  isFullView?: boolean;
}) {
  const stateGroups: HistogramGroup[] = [
    { key: 'pause', label: 'Pause', color: '#ef4444' },
    { key: 'pic', label: 'PIC', color: '#3b82f6' },
    { key: 'elongating_gte_1', label: 'Elongating', color: '#22c55e' },
  ].map(state => ({
    label: state.label,
    bars: targetDatasets.map(ds => {
      const summary = filteredSummary[ds.id];
      const total = summary ? classifiedTotal(summary) : 0;
      const count = summary ? Number(summary[state.key as keyof typeof summary] ?? 0) : 0;
      const ci = wilsonInterval(count, total);
      return {
        label: getDatasetDisplayLabel(ds),
        value: total > 0 ? (count / total) * 100 : 0,
        ciLow: ci.low * 100,
        ciHigh: ci.high * 100,
        n: total,
        color: targetDatasets.length > 1 ? ds.color : state.color,
      };
    }),
  }));

  return (
    <div className="space-y-3">
      {elongatingGroups.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-400 mb-1">Elongating Pol II count</div>
          <HistogramChart
            groups={elongatingGroups}
            yLabel="Reads"
            width={chartWidth}
            height={isFullView ? 200 : 120}
            groupedLayout={targetDatasets.length > 1}
          />
          <div className="mt-0.5 text-[11px] italic text-ink-secondary">
            Whiskers are 95% Wilson intervals over reads.
          </div>
        </div>
      )}

      <div>
        <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-400 mb-1">Mean Pol II per read by cluster</div>
        {perClusterPolII.length > 0 ? (
          <div>
            <HistogramChart
              groups={perClusterPolII}
              yLabel="Mean Pol II"
              width={chartWidth}
              height={isFullView ? 200 : 120}
              groupedLayout={targetDatasets.length > 1}
              yFormat={formatPolIIMean}
              filename="per_cluster_pol2"
            />
            <div className="mt-0.5 text-[11px] italic text-ink-secondary">
              Mean with deterministic 1,000-resample read-bootstrap 95% CI.
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-ink-secondary italic px-1 py-2">
            Cluster reads to see per-cluster Pol II means.
          </div>
        )}
      </div>

      <div>
        <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-400 mb-1">State prevalence</div>
        <HistogramChart
          groups={stateGroups}
          yLabel="Reads (%)"
          width={chartWidth}
          height={isFullView ? 220 : 150}
          groupedLayout={targetDatasets.length > 1}
          yFormat={value => `${value.toFixed(value < 10 ? 1 : 0)}%`}
          filename="transcription_state_prevalence"
        />
      </div>
      <div className="text-[11px] text-ink-secondary italic">
        States may overlap, so each bar is a separate binary read prevalence rather than a slice of a pie. Whiskers are read-level 95% Wilson intervals, not biological-replicate uncertainty.
      </div>
    </div>
  );
}
