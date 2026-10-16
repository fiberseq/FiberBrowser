import { type ReactNode } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { FolderOpen, Chromosome, Reads, FootprintClasses, Sun, Moon } from '../ui/Icons';
import { SIDEBAR_SECTIONS } from '../../utils/settingsCatalog';
import { setSettingsSearchQuery, useSettingsSearchStore } from '../../utils/settingsSearchStore';
import { usePanelLauncherStore } from '../../stores/panelLauncherStore';
import { PanelRail } from './PanelRail';

const ICON_STRIP_WIDTH = 40;

interface SectionDef {
  id: string;
  icon: ReactNode;
  label: string;
}

export function SidebarIconStrip() {
  const {
    sidebarOpen, activeSection, openSidebarSection, setSidebarOpen, darkMode, toggleDarkMode,
  } = useBrowserStore(useShallow(s => ({
    sidebarOpen: s.sidebarOpen,
    activeSection: s.activeSection,
    openSidebarSection: s.openSidebarSection,
    setSidebarOpen: s.setSidebarOpen,
    darkMode: s.darkMode,
    toggleDarkMode: s.toggleDarkMode,
  })));
  // Rail mode (Settings › Reads & Display › Analysis panels): the panel launchers sit
  // under the settings icons.
  const railMode = usePanelLauncherStore(s => s.mode) === 'rail';

  const sections: SectionDef[] = [
    { id: 'file', icon: <FolderOpen size={16} />, label: SIDEBAR_SECTIONS.file.label },
    { id: 'genome', icon: <Chromosome size={16} />, label: SIDEBAR_SECTIONS.genome.label },
    { id: 'view', icon: <Reads size={16} />, label: SIDEBAR_SECTIONS.view.label },
    { id: 'analysis', icon: <FootprintClasses size={16} />, label: SIDEBAR_SECTIONS.analysis.label },
  ];

  // While the settings search lists its matches, no page is on show (clearing it returns to the page).
  const searching = useSettingsSearchStore(s => s.query.trim().length > 0);
  const shownPage = sidebarOpen && !searching ? activeSection : null;

  // Like an activity bar: an icon opens its settings page, another icon switches
  // the page, and the icon of the page on show closes the sidebar.
  const handleClick = (sectionId: string) => {
    if (shownPage === sectionId) { setSidebarOpen(false); return; }
    // A page asked for: the settings search (which lists matches instead) is cleared.
    if (useSettingsSearchStore.getState().query) setSettingsSearchQuery('');
    openSidebarSection(sectionId);
  };

  return (
    <div
      className="flex min-h-0 shrink-0 flex-col items-center gap-0.5 py-1.5 border-l border-line/70 bg-surface-sunken/90 dark:border-white/10 dark:bg-dark-bg/90"
      style={{ width: ICON_STRIP_WIDTH }}
      data-testid="sidebar-rail"
      data-panel-launcher-mode={railMode ? 'rail' : 'strip'}
    >
      {/* The settings pages (the only settings control: no cog elsewhere). The page
          on show is marked by a brand bar and tint; nothing is marked while closed. */}
      <div className="flex shrink-0 flex-col items-center gap-0.5" role="group" aria-label="Settings" data-testid="settings-rail-sections">
        {sections.map(s => {
          const active = shownPage === s.id;
          return (
            <button
              key={s.id}
              onClick={() => handleClick(s.id)}
              className={`relative fb-rail-btn h-8 w-8 shrink-0 ${active ? 'fb-icon-btn-active' : ''}`}
              title={active ? `Settings: ${s.label} (click to close)` : `Settings: ${s.label}`}
              aria-label={`Settings: ${s.label}`}
              aria-pressed={active}
              data-testid={`settings-rail-${s.id}`}
            >
              {active && <span className="absolute -left-1 top-1.5 bottom-1.5 w-[3px] rounded-full bg-brand-600 dark:bg-brand-400" aria-hidden="true" />}
              {s.icon}
            </button>
          );
        })}
      </div>

      {/* The analysis panel launchers (rail mode), else a spacer. */}
      {railMode ? <PanelRail /> : <div className="flex-1" />}

      {/* Dark mode toggle */}
      <button
        onClick={toggleDarkMode}
        className="fb-rail-btn mt-0.5 mb-1 shrink-0"
        title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={darkMode ? 'Light mode' : 'Dark mode'}
      >
        {darkMode ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </div>
  );
}

export { ICON_STRIP_WIDTH };
