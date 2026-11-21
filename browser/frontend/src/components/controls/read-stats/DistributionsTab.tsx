import { openPlots } from '../../../features/plots/workspace';
import { openSuppliedPlot } from '../../../features/plots/supplied';
import type { PlotLocus } from '../../../features/plots/plotModel';
import type { HistogramBin, ReadStatsResponse } from '../../../api/readStats';
import { AnalysisStatus } from '../shared';
import { HistogramChart } from '../../charts/HistogramChart';
import type { HistogramGroup } from '../../charts/HistogramChart';
import { wilsonCountInterval } from '../../../utils/statistics';

/** What each read-stats histogram measures (Plots shows it in the card's header). */
const MEASURES: Record<string, string> = {
  'Accessibility %': 'per read, gap bp over span bp of its calls; 10% bins',
  'Footprints per Read': 'per read, its footprints (size > 0)',
  'Footprint Size': 'every footprint (size > 0) of the reads, pooled; 20 bp bins from 0',
  'Read Length': 'per read, its query length',
  'MAPQ': 'per read, its mapping quality; 5-unit bins 0–60 (above 60 dropped)',
  'Modification %': 'per read, marks over its span; 10% bins',
};

/** A read-stats histogram as a supplied plot in Plots (its counts exactly, the bins' starts as x). */
export function openReadStatsHistogram(label: string, bins: HistogramBin[], scopeText: string, locus: PlotLocus): string | null {
  if (!bins.length) return null;
  const xs = bins.map(b => b.lo);
  return openSuppliedPlot({
    type: 'size-histogram', name: `Read stats · ${label}`, datasets: [], xs,
    spec: { origin: `Read stats › ${label}`, x0: xs[0], dx: bins[0].hi - bins[0].lo, xLabel: `${label} (bin start)`, yLabel: label === 'Footprint Size' ? 'footprints' : 'reads',
      measures: `${MEASURES[label] ?? label}; ${scopeText}` },
    series: [{ id: 'reads', title: label, color: '#8b5cf6', values: bins.map(b => b.count) }],
    locus,
  });
}

export function DistributionsTab({
  aggregate: agg, isBam, width, narrow, scopeText = 'the reads analysed', locus = null,
}: {
  aggregate: ReadStatsResponse['aggregate'];
  isBam: boolean;
  width: number;
  narrow: boolean;
  /** Which reads (for the Plots card's "measures"). */
  scopeText?: string;
  locus?: PlotLocus | null;
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
    { label: 'Accessibility %', bins: agg.hist_accessibility, groups: makeGroups(agg.hist_accessibility, true), show: !!agg.hist_accessibility?.length, readCI: true },
    { label: 'Footprints per Read', bins: agg.hist_fp_count, groups: makeGroups(agg.hist_fp_count, true), show: !!agg.hist_fp_count, readCI: true },
    { label: 'Footprint Size', bins: agg.hist_fp_size, groups: makeGroups(agg.hist_fp_size, false), show: !!agg.hist_fp_size?.length, readCI: false },
    { label: 'Read Length', bins: agg.hist_read_length, groups: makeGroups(agg.hist_read_length, true), show: true, readCI: true },
    { label: 'MAPQ', bins: agg.hist_mapq, groups: makeGroups(agg.hist_mapq, true), show: isBam && !!agg.hist_mapq, readCI: true },
    { label: 'Modification %', bins: agg.hist_methyl_pct, groups: makeGroups(agg.hist_methyl_pct, true), show: !!agg.hist_methyl_pct, readCI: true },
  ].filter(c => c.show);

  return (
    <div className={`grid gap-2 ${narrow ? 'grid-cols-1' : 'grid-cols-2'}`}>
      {charts.map(c => (
        <div key={c.label}>
          <div className="mb-0.5 flex items-center gap-2 text-[11px] font-medium text-gray-500">
            {c.label}
            {c.groups.length > 0 && (
              <button type="button" className="ml-auto rounded border border-amber-300 px-1 text-[10px] font-semibold text-amber-900 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-100"
                data-testid={`read-stats-open-supplied-${c.label.toLowerCase().replace(/[^a-z]+/g, '-')}`} title="Open this histogram in Plots: these exact counts (export, the Gallery)."
                onClick={() => openReadStatsHistogram(c.label, c.bins ?? [], scopeText, locus ?? { chrom: '', start: 0, end: 1, genome: null })}>Open in Plots</button>
            )}
            {/footprint size/i.test(c.label) && (
              <button type="button" className="rounded border border-gray-200 px-1 text-[10px] font-normal text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300"
                data-testid="read-stats-size-open-in-plots" title="The footprint size histogram of the view in Plots (a different measure: every footprint whose midpoint is in view, from the display sample), per dataset or cluster."
                onClick={() => openPlots({ type: 'size-histogram', where: 'view', groupBy: 'dataset' })}>the view's histogram in Plots</button>
            )}
          </div>
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
