import type { ReactNode } from 'react';

interface SubTab<K extends string> {
  key: K;
  label: string;
  icon?: ReactNode;
}

// The active sub-tab's underline takes the panel colour, like the tab bar above it.
const ACTIVE_CLASSES = {
  blue: 'border-blue-500 text-blue-700 dark:text-blue-300',
  emerald: 'border-emerald-500 text-emerald-700 dark:text-emerald-300',
  cyan: 'border-cyan-500 text-cyan-700 dark:text-cyan-300',
  amber: 'border-amber-500 text-amber-700 dark:text-amber-300',
  violet: 'border-violet-500 text-violet-700 dark:text-violet-300',
  rose: 'border-rose-500 text-rose-700 dark:text-rose-300',
  slate: 'border-slate-500 text-slate-800 dark:text-slate-200',
  red: 'border-red-500 text-red-700 dark:text-red-300',
  teal: 'border-teal-500 text-teal-700 dark:text-teal-300',
  indigo: 'border-indigo-500 text-indigo-700 dark:text-indigo-300',
  fuchsia: 'border-fuchsia-500 text-fuchsia-700 dark:text-fuchsia-300',
} as const;

/**
 * Second-level tabs under a panel's tab bar (e.g. Clusters → Charts →
 * Profiles / Composition / …): the same underlined tabs as the bar above,
 * a size smaller and without the full-width rule, wrapping onto another line
 * rather than clipping. Each carries data-analysis-tab, like a top-level tab,
 * so tours and deep links select it the same way.
 */
export function AnalysisSubTabBar<K extends string>({ tabs, activeTab, onTabChange, label, theme = 'slate', className }: {
  tabs: SubTab<K>[];
  activeTab: K;
  onTabChange: (key: K) => void;
  /** What the tabs choose between, for screen readers (e.g. "Chart"). */
  label: string;
  /** The panel colour (AnalysisTheme) for the active underline. */
  theme?: keyof typeof ACTIVE_CLASSES;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={`flex flex-wrap gap-x-1 ${className ?? ''}`} data-testid="analysis-subtabs">
      {tabs.map(tab => {
        const active = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            type="button"
            aria-pressed={active}
            data-analysis-tab={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`inline-flex items-center gap-1 whitespace-nowrap border-b-2 px-1.5 py-[3px] text-[11px] transition-colors ${
              active
                ? `${ACTIVE_CLASSES[theme]} font-semibold`
                : 'border-transparent font-medium text-ink-muted hover:border-gray-300 hover:text-gray-800 dark:hover:border-white/20 dark:hover:text-gray-200'
            }`}
          >
            {tab.icon && <span className="flex shrink-0" aria-hidden="true">{tab.icon}</span>}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Sub-tabs of a top-level tab that isn't showing: kept in the page (1 px, out of
 *  the tab order) so a tour or deep link can still switch straight to one. */
export function HiddenTabTargets<K extends string>({ tabs, onTabChange }: { tabs: SubTab<K>[]; onTabChange: (key: K) => void }) {
  return (
    <span className="absolute h-[2px]" style={{ width: tabs.length * 2 }} aria-hidden="true">
      {/* Two distinct pixels each (a click lands on its centre), so a test can click any of them. */}
      {tabs.map((tab, k) => (
        <button key={tab.key} type="button" tabIndex={-1} data-analysis-tab={tab.key} onClick={() => onTabChange(tab.key)} className="absolute top-0 h-[2px] w-[2px] overflow-hidden p-0" style={{ left: k * 2 }} />
      ))}
    </span>
  );
}
