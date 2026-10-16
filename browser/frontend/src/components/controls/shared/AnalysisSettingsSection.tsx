import type { ReactNode } from 'react';
import { ChevronDown } from '../../ui/Icons';
import type { AnalysisTheme } from './AnalysisTabBar';

const SETTINGS_THEME_CLASSES: Record<AnalysisTheme, string> = {
  blue: 'bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800/30',
  emerald: 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800/30',
  cyan: 'bg-cyan-50 dark:bg-cyan-900/10 border-cyan-200 dark:border-cyan-800/30',
  amber: 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/30',
  violet: 'bg-violet-50 dark:bg-violet-900/10 border-violet-200 dark:border-violet-800/30',
  rose: 'bg-rose-50 dark:bg-rose-900/10 border-rose-200 dark:border-rose-800/30',
  slate: 'bg-slate-50 dark:bg-slate-900/10 border-slate-200 dark:border-slate-700/40',
  red: 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/30',
  teal: 'bg-teal-50 dark:bg-teal-900/10 border-teal-200 dark:border-teal-800/30',
  indigo: 'bg-indigo-50 dark:bg-indigo-900/10 border-indigo-200 dark:border-indigo-800/30',
  fuchsia: 'bg-fuchsia-50 dark:bg-fuchsia-900/10 border-fuchsia-200 dark:border-fuchsia-800/30',
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  theme: AnalysisTheme;
  title?: string;
  summary?: ReactNode;
  className?: string;
  buttonClassName?: string;
  contentClassName?: string;
  /** `data-tour` id for the toggle button (tutorial anchors point at it). */
  tourId?: string;
}

export function AnalysisSettingsSection({
  open,
  onOpenChange,
  children,
  theme,
  title = 'Settings',
  summary,
  className = '',
  buttonClassName = '',
  contentClassName = '',
  tourId,
}: Props) {
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        data-tour={tourId}
        onClick={() => onOpenChange(!open)}
        className={`flex items-center gap-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 w-full text-left ${buttonClassName}`}
      >
        <ChevronDown size={10} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="font-medium">{title}</span>
        {summary !== undefined && (
          <span className="text-[11px] text-ink-secondary ml-auto">{summary}</span>
        )}
      </button>

      {open && (
        <div className={`p-2 rounded border space-y-1.5 ${SETTINGS_THEME_CLASSES[theme]} ${contentClassName}`}>
          {children}
        </div>
      )}
    </div>
  );
}
