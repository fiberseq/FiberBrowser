import type { HistogramBin, ReadStatsResponse } from '../../../api/readStats';
import { AnalysisStatus } from '../shared';
import { HistogramChart } from '../../charts/HistogramChart';
import type { HistogramGroup } from '../../charts/HistogramChart';
import { wilsonCountInterval } from '../../../utils/statistics';

export function DistributionsTab({
  aggregate: agg, isBam, width, narrow,
}: {
  aggregate: ReadStatsResponse['aggregate'];
  isBam: boolean;
  width: number;
  narrow: boolean;
}) {
  const chartW = narrow ? Math.max(200, width - 24) : Math.max(200, (width - 32) / 2);
  const color = '#8b5cf6';

  const makeGroups = (bins: HistogramBin[] | null | undefined, includeReadCI: boolean): HistogramGroup[] => {
    if (!bins || bins.length === 0) return [];
    const total = bins.reduce((sum, bin) => sum + bin.count, 0);
    return bins.map(b => ({
      label: b.label,
      bars: [{
        label: b.label,
        value: b.count,
        color,
        ...(includeReadCI ? (() => {
          const ci = wilsonCountInterval(b.count, total);
          return { ciLow: ci.low, ciHigh: ci.high, n: total };
        })() : {}),
      }],
    }));
  };

  const charts = [
    { label: 'Accessibility %', groups: makeGroups(agg.hist_accessibility, true), show: true, readCI: true },
    { label: 'Footprints per Read', groups: makeGroups(agg.hist_fp_count, true), show: !!agg.hist_fp_count, readCI: true },
    { label: 'Footprint Size', groups: makeGroups(agg.hist_fp_size, false), show: true, readCI: false },
    { label: 'Read Length', groups: makeGroups(agg.hist_read_length, true), show: true, readCI: true },
    { label: 'MAPQ', groups: makeGroups(agg.hist_mapq, true), show: isBam && !!agg.hist_mapq, readCI: true },
    { label: 'Modification %', groups: makeGroups(agg.hist_methyl_pct, true), show: !!agg.hist_methyl_pct, readCI: true },
  ].filter(c => c.show);

  return (
    <div className={`grid gap-2 ${narrow ? 'grid-cols-1' : 'grid-cols-2'}`}>
      {charts.map(c => (
        <div key={c.label}>
          <div className="text-[11px] text-gray-500 mb-0.5 font-medium">{c.label}</div>
          {c.groups.length > 0 ? (
            <HistogramChart
              groups={c.groups}
              width={chartW}
              height={120}
              yLabel="Reads"
              filename={`read-stats-${c.label.toLowerCase().replace(/\s+/g, '-')}`}
            />
          ) : (
            <AnalysisStatus kind="empty" compact center>
              No data.
            </AnalysisStatus>
          )}
          {c.groups.length > 0 && (
            <div className="mt-0.5 text-[11px] italic text-ink-secondary">
              {c.readCI
                ? '95% Wilson intervals; reads with this metric are the observation unit.'
                : 'Raw footprint-event distribution; no CI shown because events within a read are correlated.'}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
