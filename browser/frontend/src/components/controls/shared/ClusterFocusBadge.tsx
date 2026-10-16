import type { AnalysisTheme } from './AnalysisTabBar';

const BADGE_CLASSES = {
  blue: 'text-blue-500 bg-blue-50 dark:bg-blue-900/20',
  emerald: 'text-emerald-500 bg-emerald-50 dark:bg-emerald-900/20',
  cyan: 'text-cyan-600 bg-cyan-50 dark:bg-cyan-900/20 dark:text-cyan-400',
  amber: 'text-amber-500 bg-amber-50 dark:bg-amber-900/20',
  violet: 'text-violet-500 bg-violet-50 dark:bg-violet-900/20',
  rose: 'text-rose-500 bg-rose-50 dark:bg-rose-900/20',
  slate: 'text-slate-500 bg-slate-50 dark:bg-slate-900/20',
  red: 'text-red-500 bg-red-50 dark:bg-red-900/20',
  teal: 'text-teal-500 bg-teal-50 dark:bg-teal-900/20',
  indigo: 'text-indigo-500 bg-indigo-50 dark:bg-indigo-900/20',
  fuchsia: 'text-fuchsia-500 bg-fuchsia-50 dark:bg-fuchsia-900/20',
} as const;

interface Props {
  active: boolean;
  theme: AnalysisTheme;
  label?: string;
}

export function ClusterFocusBadge({ active, theme, label }: Props) {
  if (!active) return null;
  return (
    <div className={`text-[11px] ${BADGE_CLASSES[theme]} px-1.5 py-0.5 rounded`}>
      {label || 'Filtered by cluster focus'}
    </div>
  );
}
