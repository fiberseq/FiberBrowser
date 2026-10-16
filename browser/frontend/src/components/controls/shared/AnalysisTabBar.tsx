import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from '../../ui/Icons';
import { useRowOverflow } from '../../../hooks/useRowOverflow';

/**
 * Shared tab bar for analysis panels (the design system's Tabs: 12 px, an icon
 * per tab, the active tab semibold and underlined in the panel's colour).
 * Supports theme colors: emerald, cyan, amber, violet, rose, slate, red, blue.
 */

const THEME_CLASSES = {
  blue: {
    border: 'border-blue-200 dark:border-blue-800',
    active: 'border-blue-500 text-blue-700 dark:text-blue-300',
  },
  emerald: {
    border: 'border-emerald-200 dark:border-emerald-800',
    active: 'border-emerald-500 text-emerald-700 dark:text-emerald-300',
  },
  cyan: {
    border: 'border-cyan-200 dark:border-cyan-800',
    active: 'border-cyan-500 text-cyan-700 dark:text-cyan-300',
  },
  amber: {
    border: 'border-amber-200 dark:border-amber-800',
    active: 'border-amber-500 text-amber-700 dark:text-amber-300',
  },
  violet: {
    border: 'border-violet-200 dark:border-violet-800',
    active: 'border-violet-500 text-violet-700 dark:text-violet-300',
  },
  rose: {
    border: 'border-rose-200 dark:border-rose-800',
    active: 'border-rose-500 text-rose-700 dark:text-rose-300',
  },
  slate: {
    border: 'border-slate-200 dark:border-slate-700',
    active: 'border-slate-500 text-slate-700 dark:text-slate-300',
  },
  red: {
    border: 'border-red-200 dark:border-red-800',
    active: 'border-red-500 text-red-700 dark:text-red-300',
  },
  teal: {
    border: 'border-teal-200 dark:border-teal-800',
    active: 'border-teal-500 text-teal-700 dark:text-teal-300',
  },
  indigo: {
    border: 'border-indigo-200 dark:border-indigo-800',
    active: 'border-indigo-500 text-indigo-700 dark:text-indigo-300',
  },
  fuchsia: {
    border: 'border-fuchsia-200 dark:border-fuchsia-800',
    active: 'border-fuchsia-500 text-fuchsia-700 dark:text-fuchsia-300',
  },
} as const;

export type AnalysisTheme = keyof typeof THEME_CLASSES;

interface Tab<K extends string> {
  key: K;
  label: string;
  /** An icon from the set (13 px), drawn before the label. */
  icon?: ReactNode;
}

interface Props<K extends string> {
  tabs: Tab<K>[];
  activeTab: K;
  onTabChange: (key: K) => void;
  theme: AnalysisTheme;
  className?: string;
}

const TAB_CLASS = '-mb-px inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap px-2.5 py-[7px] text-[12px] border-b-2 transition-colors';
const MORE_WIDTH = 64;

/**
 * Tabs never clip: the ones that don't fit go to a "More" menu at the end of
 * the bar, and the active tab always stays in the bar.
 */
export function AnalysisTabBar<K extends string>({ tabs, activeTab, onTabChange, theme, className }: Props<K>) {
  const classes = THEME_CLASSES[theme];
  const activeIndex = tabs.findIndex(tab => tab.key === activeTab);
  const { rowRef, measureRef, overflow } = useRowOverflow(tabs.length, {
    gap: 2,
    moreWidth: MORE_WIDTH,
    pinned: activeIndex >= 0 ? [activeIndex] : [],
    deps: tabs.map(tab => `${tab.key}:${tab.label}`),
  });
  const hidden = new Set(overflow);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const tabButton = (tab: Tab<K>) => (
    <button
      type="button"
      key={tab.key}
      data-analysis-tab={tab.key}
      onClick={() => onTabChange(tab.key)}
      aria-current={activeTab === tab.key ? 'page' : undefined}
      className={`${TAB_CLASS} ${
        activeTab === tab.key
          ? `${classes.active} font-semibold`
          : 'border-transparent font-medium text-ink-muted hover:text-gray-800 hover:border-gray-300 dark:hover:text-gray-200 dark:hover:border-white/20'
      }`}
    >
      {tab.icon && <span className="flex flex-shrink-0" aria-hidden="true">{tab.icon}</span>}
      {tab.label}
    </button>
  );

  return (
    <div
      ref={rowRef}
      className={`relative flex min-w-0 gap-0.5 border-b border-line dark:border-white/10 ${className || ''}`}
    >
      {tabs.filter((_, i) => !hidden.has(i)).map(tabButton)}
      {overflow.length > 0 && (
        <div ref={menuRef} className="relative ml-auto shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={`${TAB_CLASS} border-transparent font-medium text-ink-muted hover:text-gray-800 dark:hover:text-gray-200`}
            title={`More tabs: ${overflow.map(i => tabs[i].label).join(', ')}`}
            data-testid="analysis-tab-more"
          >
            More
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {/* The tabs that don't fit stay in the page (zero width) so a tour or a
              deep link can still switch to them by their data-analysis-tab. */}
          <span className="absolute left-0 top-0 h-[2px]" style={{ width: overflow.length * 2 }} aria-hidden="true">
            {overflow.map((i, k) => (
              <button key={tabs[i].key} type="button" tabIndex={-1} data-analysis-tab={tabs[i].key} onClick={() => onTabChange(tabs[i].key)} className="absolute top-0 h-[2px] w-[2px] overflow-hidden p-0" style={{ left: k * 2 }} />
            ))}
          </span>
          {menuOpen && (
            <div role="menu" className="fb-menu right-0 left-auto min-w-[10rem]" data-testid="analysis-tab-more-menu">
              {overflow.map(i => (
                <button
                  key={tabs[i].key}
                  type="button"
                  role="menuitem"
                  className="fb-menu-item"
                  onClick={() => { setMenuOpen(false); onTabChange(tabs[i].key); }}
                >
                  {tabs[i].icon && <span className="flex flex-shrink-0" aria-hidden="true">{tabs[i].icon}</span>}
                  <span className="flex-1">{tabs[i].label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Every tab, invisible, to measure what fits. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex w-max gap-0.5">
          {tabs.map(tab => (
            <span key={tab.key} className={`${TAB_CLASS} font-semibold`}>
              {tab.icon && <span className="flex flex-shrink-0">{tab.icon}</span>}
              {tab.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
