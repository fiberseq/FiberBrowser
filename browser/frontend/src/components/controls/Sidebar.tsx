import { useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { openOverlayState } from '../../hooks/useKeyboardShortcuts';
import { useShallow } from 'zustand/react/shallow';
import { SidebarSection } from './SidebarSection';
import { SidebarIconStrip } from './SidebarIconStrip';
import { FileSection } from './sidebar/DataSection';
import { GenomeSection } from './sidebar/GenomeSection';
import { ViewSection } from './sidebar/ViewSection';
import { AnalysisSection } from './sidebar/AnalysisSection';
import { FolderOpen, Chromosome, Reads, FootprintClasses, Search, X } from '../ui/Icons';
import { SIDEBAR_SECTIONS, type SidebarSectionId } from '../../utils/settingsCatalog';
import { setSettingsSearchQuery, useSettingsSearchStore } from '../../utils/settingsSearchStore';
import { SettingsSearchField } from './sidebar/SettingsSearch';
import { SettingsFilterContext, computeSettingsFilter, settingsFilterCss } from './sidebar/settingsFilter';

const SECTION_ORDER: SidebarSectionId[] = ['file', 'genome', 'view', 'analysis'];
const SECTION_ICONS: Record<SidebarSectionId, ReactNode> = {
  file: <FolderOpen size={15} />,
  genome: <Chromosome size={15} />,
  view: <Reads size={15} />,
  analysis: <FootprintClasses size={15} />,
};
const SECTION_HEADING_ICONS: Record<SidebarSectionId, ReactNode> = {
  file: <FolderOpen size={12} />,
  genome: <Chromosome size={12} />,
  view: <Reads size={12} />,
  analysis: <FootprintClasses size={12} />,
};

/** After the sidebar closes, the focus goes to the rail icon of the page it showed. */
function focusRailIcon(): void {
  window.requestAnimationFrame(() => {
    const id = useBrowserStore.getState().activeSection;
    document.querySelector<HTMLElement>(`[data-testid="settings-rail-${id}"]`)?.focus();
  });
}

interface SidebarProps {
  onExport: () => void;
  onCopyLink: () => void;
  linkCopied: boolean;
  onAutozoom: () => void;
}

export function Sidebar({
  onExport, onCopyLink, linkCopied,
  onAutozoom,
}: SidebarProps) {
  const {
    sidebarOpen, sidebarWidth, setSidebarOpen, setSidebarWidth, darkMode, activeSection,
  } = useBrowserStore(useShallow(s => ({
    sidebarOpen: s.sidebarOpen,
    sidebarWidth: s.sidebarWidth,
    setSidebarOpen: s.setSidebarOpen,
    setSidebarWidth: s.setSidebarWidth,
    darkMode: s.darkMode,
    activeSection: s.activeSection,
  })));
  const page: SidebarSectionId = activeSection in SIDEBAR_SECTIONS ? activeSection as SidebarSectionId : 'file';

  // The search field's live filter (sections, subsections and settings that match).
  const settingsQuery = useSettingsSearchStore(s => s.query);
  const filter = useMemo(() => computeSettingsFilter(settingsQuery), [settingsQuery]);
  const filterCss = useMemo(() => settingsFilterCss(filter), [filter]);
  // A matching setting inside a closed fold ("Exact limits", "Advanced: …") is shown.
  useEffect(() => {
    if (!filter.active || !sidebarOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const root = document.querySelector('[data-testid="settings-sidebar"]');
      for (const id of filter.shownIds) {
        root?.querySelectorAll(`[data-setting-id="${id}"]`).forEach(el => {
          const details = el.closest('details');
          if (details) details.open = true;
        });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filter, sidebarOpen]);

  // Closing ends a settings search: the sidebar reopens (Cmd/Ctrl+B, a rail icon) on its page.
  useEffect(() => {
    if (!sidebarOpen && useSettingsSearchStore.getState().query) setSettingsSearchQuery('');
  }, [sidebarOpen]);

  // Resize handle
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    startX.current = e.clientX;
    startWidth.current = sidebarWidth;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = startX.current - ev.clientX; // dragging left = wider
      setSidebarWidth(startWidth.current + delta);
    };
    const handleMouseUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth, setSidebarWidth]);

  // Keyboard shortcut: Cmd/Ctrl+B to toggle sidebar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Not behind a dialog (Export, Library, ...): keys there belong to it.
      if ((e.metaKey || e.ctrlKey) && e.key === 'b' && !e.defaultPrevented && !openOverlayState().modal) {
        e.preventDefault();
        // Closing with the focus inside: it goes to the page's rail icon, not the document.
        const focusInside = !!document.activeElement?.closest('[data-testid="settings-sidebar"]');
        const wasOpen = useBrowserStore.getState().sidebarOpen;
        useBrowserStore.getState().toggleSidebar();
        if (wasOpen && focusInside) focusRailIcon();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const timers = new Set<number>();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sectionId?: string; subsectionId?: string }>).detail;
      const sectionId = detail?.sectionId;
      if (!sectionId) return;
      // The settings search would hide the page (or subsection) asked for: clear it.
      const { query } = useSettingsSearchStore.getState();
      if (query) {
        const shown = computeSettingsFilter(query);
        if (!shown.sections.has(sectionId) || (detail?.subsectionId && !shown.subsections.has(detail.subsectionId))) setSettingsSearchQuery('');
      }
      useBrowserStore.getState().openSidebarSection(sectionId);
      if (detail?.subsectionId) {
        try {
          window.localStorage.setItem(`fiberhmm_sidebar_${detail.subsectionId}_collapsed`, '0');
        } catch {}
        const notifySubsection = () => {
          window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-subsection', {
            detail: { subsectionId: detail.subsectionId },
          }));
        };
        for (const delay of [0, 60]) {
          const timer = window.setTimeout(() => { timers.delete(timer); notifySubsection(); }, delay);
          timers.add(timer);
        }
      }
    };
    window.addEventListener('fiberbrowser:open-sidebar-section', handler);
    return () => {
      window.removeEventListener('fiberbrowser:open-sidebar-section', handler);
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return (
    <div className="flex h-full" style={{ flexShrink: 0 }}>
      {sidebarOpen && (
        <>
          {/* Resize handle */}
          <div
            className="w-1.5 cursor-col-resize hover:bg-brand-400/30 active:bg-brand-400/50 transition-colors"
            onMouseDown={handleResizeStart}
            title="Drag to resize the settings sidebar"
          />

          {/* Sidebar content */}
          <div
            className="fb-sidebar flex flex-col h-full overflow-y-auto overflow-x-hidden border-l border-gray-200/50 dark:border-white/10"
            data-testid="settings-sidebar"
            style={{
              width: sidebarWidth,
              backgroundColor: darkMode ? 'rgba(15,21,36,0.96)' : 'rgba(255,255,255,0.96)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
            }}
          >
            {/* Sidebar header (the page shown, or the search) and the settings search */}
            <div className="sticky top-0 z-10 border-b border-gray-200/70 dark:border-white/10 flex-shrink-0" style={{ backgroundColor: 'inherit' }}>
            <div className="flex flex-nowrap items-center gap-2 h-10 px-3">
              {filter.active ? (
                <>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-ink-muted" aria-hidden="true">
                    <Search size={14} />
                  </span>
                  <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-800 dark:text-gray-100" data-testid="settings-sidebar-title">
                    Search settings
                  </h2>
                </>
              ) : (
                <>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-brand-600/10 text-brand-700 dark:bg-brand-400/15 dark:text-brand-300" aria-hidden="true">
                    {SECTION_ICONS[page]}
                  </span>
                  <h2
                    id={`sidebar-section-${page}-header`}
                    data-tour={`sidebar-${page}`}
                    className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-800 dark:text-gray-100"
                    title={SIDEBAR_SECTIONS[page].label}
                    data-testid="settings-sidebar-title"
                  >
                    {SIDEBAR_SECTIONS[page].label}
                  </h2>
                </>
              )}
              <button
                onClick={() => { setSidebarOpen(false); focusRailIcon(); }}
                className="fb-rail-btn shrink-0"
                title="Close settings (Cmd/Ctrl+B)"
                aria-label="Close settings"
                data-testid="settings-sidebar-collapse"
              >
                <X size={13} />
              </button>
            </div>
            <SettingsFilterContext.Provider value={filter}>
              <SettingsSearchField />
            </SettingsFilterContext.Provider>
            </div>
            {filterCss && <style data-testid="settings-search-style">{filterCss}</style>}

            <SettingsFilterContext.Provider value={filter}>
            {/* One page (the rail icon's section); while searching, every section with a match. */}
            {(filter.active ? SECTION_ORDER.filter(id => filter.sections.has(id)) : [page]).map(id => (
              <SidebarSection
                key={id}
                id={id}
                label={SIDEBAR_SECTIONS[id].label}
                icon={SECTION_HEADING_ICONS[id]}
                description={SIDEBAR_SECTIONS[id].description}
                heading={filter.active}
              >
                {id === 'file' && (
                  <FileSection
                    onExport={onExport}
                    onCopyLink={onCopyLink}
                    linkCopied={linkCopied}
                  />
                )}
                {id === 'genome' && <GenomeSection />}
                {id === 'view' && <ViewSection onAutozoom={onAutozoom} />}
                {id === 'analysis' && <AnalysisSection />}
              </SidebarSection>
            ))}
            </SettingsFilterContext.Provider>

          </div>
        </>
      )}

      {/* The rail: its icons open and switch the settings pages (and, in rail mode, hold the panel launchers). */}
      <SidebarIconStrip />
    </div>
  );
}
