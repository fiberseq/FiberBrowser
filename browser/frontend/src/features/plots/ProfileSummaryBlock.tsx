/**
 * The summary under a profile or histogram plot (view, features and BED alike): per group, or, with Compare on, per
 * comparison (summary.compareSummaryView: A − B or log2 ratio of the two sides, seeded bootstrap); and the one state
 * line that says what is shown (compareState.compareStateLine).
 */
import { compareSummaryView, profileSummaryView, type SummaryUnit } from './summary';
import { SummaryChart } from './SummaryChart';
import { compareStateLine } from './compareState';
import type { ProfileFigure } from './profileFigure';
import type { PlotSpec } from './plotModel';
import type { RawProfile } from './profileEngine';
import { sourceColor } from './multiSource';

/** Several sources: each bar takes its source's colour now (the resolver), as the lines do, never one stored earlier. */
const withSourceColors = <T extends { values: Array<{ series?: string; color?: string }> }>(sv: T): T =>
  ({ ...sv, values: sv.values.map(v => (v.series ? { ...v, color: sourceColor(v.series) } : v)) });

type Group = { id: string; title: string; color?: string; raw: RawProfile; units?: SummaryUnit[] };

export interface ProfileSummaryArgs {
  plot: PlotSpec;
  figure: ProfileFigure;
  groups: Group[];
  histogram: boolean;
  start: number;
  binBp: number;
  anchored: boolean;
  unitNoun: string;
  marksPerBp: boolean;
}

/** The summary as drawn (null: none asked for, or no groups). */
export function profileSummaryOf(a: ProfileSummaryArgs) {
  const { plot, figure, groups, histogram } = a;
  if (!plot.summary.on || !groups.length) return null;
  const common = {
    histogram, start: a.start, binBp: a.binBp, sizeMin: plot.hist.sizeMin, s: plot.summary, seed: plot.summary.bootSeed ?? plot.sampling.seed,
    countWeighting: plot.hist.weighting === 'count', normalization: plot.profile.normalization, anchored: a.anchored, unitNoun: a.unitNoun, marksPerBp: !histogram && a.marksPerBp,
    // How the curves are drawn (profileFigure's finishing), so a curve summary equals them.
    ...(histogram ? {} : { finish: { normalization: plot.profile.normalization, sigmaBp: plot.profile.sigmaBp, minCoverage: plot.profile.minCoverage, binBp: a.binBp, marksPerBp: a.marksPerBp } }),
  };
  if (figure.comparing && figure.pairs.length) {
    const op = plot.compare === 'diff' ? 'diff' as const : 'log2ratio' as const;
    const sv = compareSummaryView(groups, figure.pairs, { ...common, op, what: histogram ? 'the comparison above (each side\'s histogram)' : 'the comparison above (each side\'s profile)' });
    // A histogram's summary compares band shares, whatever the histogram's own axis (counts, per read).
    const yLabel = histogram ? (op === 'diff' ? 'Δ band share' : 'log2 ratio of band shares') : figure.yLabel;
    return { ...withSourceColors(sv), yLabel, comparing: true };
  }
  const sv = profileSummaryView(groups, { ...common, what: histogram ? 'the histogram above' : 'the profile above' });
  return { ...withSourceColors(sv), window: null, yLabel: histogram ? 'share' : figure.yLabel, comparing: false };
}

export function ProfileSummaryBlock({ summary, chart, dark, filename }: { summary: ReturnType<typeof profileSummaryOf>; chart: 'bar' | 'line'; dark: boolean; filename: string }) {
  if (!summary) return null;
  return <SummaryChart values={summary.values} chart={chart} dark={dark} reference={summary.reference} note={summary.note}
    yLabel={summary.yLabel} filename={filename} measures={summary.measures} />;
}

/** The plot's one state line (nothing when not comparing). */
export function CompareStateText({ text }: { text: string | null }) {
  if (!text) return null;
  return <div className="text-[11px] font-medium text-gray-700 dark:text-gray-200" data-testid="plots-state-line">{text}</div>;
}

/** The state line of a profile or histogram plot. */
export function profileStateLine(plot: PlotSpec, figure: ProfileFigure, summary: ReturnType<typeof profileSummaryOf>): string | null {
  return compareStateLine({
    // Several sources: the comparisons by their groups (each is drawn once per source).
    compare: figure.comparing ? plot.compare : 'off', mode: figure.mode, pairs: figure.pairs.map(p => ({ label: p.facetLabel ?? p.label })),
    summary: !plot.summary.on ? null : summary?.comparing && summary.window ? { window: summary.window } : null,
  });
}
