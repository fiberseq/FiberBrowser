/**
 * A plot's header: one short line (what, where, grouping, seed) and the rest of what it measures in a collapsible
 * Details line (the full text stays in the element, for exports and tests).
 */
import { PLOT_GROUP_BY, plotSources, plotTypeInfo, sourceLabel, type PlotSpec } from './plotModel';

/** "Metaprofile of All footprints · the view · by dataset · seed 1". */
export function shortHeader(plot: PlotSpec, where: string): string {
  const what = `${plotTypeInfo(plot.type).label} of ${plotSources(plot).map(x => sourceLabel(x, plot.sourceLabels)).join(' + ')}`;
  const group = plot.groupBy === 'none' ? 'pooled' : `by ${PLOT_GROUP_BY.find(g => g.value === plot.groupBy)?.label.toLowerCase() ?? plot.groupBy}`;
  return [what, where, group, `seed ${plot.sampling.seed}`].join(' · ');
}

export function MeasuresHeader({ short, details, testId }: { short: string; details: string; testId: string }) {
  return (
    <div className="basis-full text-[11px] text-ink-primary dark:text-gray-100" data-testid={testId}>
      <div className="font-medium" data-testid={`${testId}-short`}>{short}</div>
      <details className="text-ink-secondary" data-testid={`${testId}-details`}>
        <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wide">Details</summary>
        <div className="mt-0.5">{details}</div>
      </details>
    </div>
  );
}
