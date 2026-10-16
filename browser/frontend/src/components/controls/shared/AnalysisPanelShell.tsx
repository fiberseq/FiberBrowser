import type { ReactNode } from 'react';
import { AnalysisTabBar, type AnalysisTheme } from './AnalysisTabBar';

interface Tab<K extends string> {
  key: K;
  label: string;
  icon?: ReactNode;
}

type BodyMode = 'panel' | 'fill' | 'none';

interface Props<K extends string> {
  tabs: Tab<K>[];
  activeTab: K;
  onTabChange: (key: K) => void;
  theme: AnalysisTheme;
  children: ReactNode;
  header?: ReactNode;
  summary?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  isFullView?: boolean;
  className?: string;
  tabBarClassName?: string;
  bodyClassName?: string;
  bodyMode?: BodyMode;
  showTabs?: boolean | 'auto';
  /** Tabs right under the panel header, above the header/summary/toolbar slots (the design's layout). */
  tabsFirst?: boolean;
  /**
   * 'standard': the Footprints panel's layout — tabs right under the coloured
   * header bar, the header/summary/toolbar rows padded px-3, the body p-3 with
   * 12 px text and space between sections. ('custom', the default, leaves the
   * spacing to the panel, as before.)
   */
  layout?: 'custom' | 'standard';
}

function bodyModeClass(mode: BodyMode, isFullView?: boolean) {
  if (mode === 'fill') return 'flex-1 overflow-auto';
  if (mode === 'none') return '';
  return isFullView ? '' : 'max-h-[400px] overflow-y-auto';
}

export function AnalysisPanelShell<K extends string>({
  tabs,
  activeTab,
  onTabChange,
  theme,
  children,
  header,
  summary,
  toolbar,
  footer,
  isFullView,
  className,
  tabBarClassName,
  bodyClassName,
  bodyMode = 'panel',
  showTabs = 'auto',
  tabsFirst = false,
  layout = 'custom',
}: Props<K>) {
  const standard = layout === 'standard';
  const bodyClasses = [
    bodyModeClass(bodyMode, isFullView),
    standard ? 'space-y-3 p-3 text-[12px] leading-[18px]' : '',
    bodyClassName,
  ].filter(Boolean).join(' ');
  const shouldShowTabs = showTabs === 'auto' ? tabs.length > 1 : showTabs;

  const tabBar = shouldShowTabs ? (
    <AnalysisTabBar
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={onTabChange}
      theme={theme}
      className={tabBarClassName ?? (standard ? 'px-2' : undefined)}
    />
  ) : null;
  const top = header || summary || toolbar;
  const first = standard || tabsFirst;
  return (
    <div className={className ?? (standard ? '' : 'space-y-2')}>
      {first && tabBar}
      {standard
        ? top && <div className="space-y-2 px-3 pt-3">{header}{summary}{toolbar}</div>
        : <>{header}{summary}{toolbar}</>}
      {!first && tabBar}
      <div className={bodyClasses}>{children}</div>
      {footer}
    </div>
  );
}
