import { PreviewBadge } from '../ui/PreviewBadge';
import { usePreviewsEnabled } from '../../utils/previewFeatures';
import { useState, useRef, useEffect, useMemo, type CSSProperties } from 'react';
import { useRowOverflow } from '../../hooks/useRowOverflow';
import { useBrowserStore } from '../../stores/browserStore';
import { useDafcStore } from '../../stores/dafcStore';
import {
  describePanelProvenance,
  findOpenAnalysisPanel,
  getAnalysisPanelLabel,
  getGroupedAnalysisPanels,
} from '../../plugins/registry';
import type { GroupedPlugins } from '../../plugins/registry';
import { PanelIcon } from '../ui/panelIcons';
import { ChevronDown, ChevronRight, Library, Sliders } from '../ui/Icons';
import { DatasetPanel } from '../controls/DatasetPanel';
import { useLibraryAvailable } from '../controls/library/LibraryHost';
import { openLibrary } from '../controls/library/libraryStore';
import { showDrawerPanel } from '../../stores/drawerTabsStore';

/** Compatibility panels that remain registered for old sessions and deep
 * links, but now live inside a broader workflow panel in the v1 UI. */
export const HIDDEN_PANELS = new Set<string>([
  'peak-detection',   // Analysis Rules > Peaks
  'capture',          // Primers > Capture
  'annotations',      // retained for session compatibility; not release-ready
]);

export const ANALYSIS_STRIP_HEIGHT = 32;
/** Folded, the strip keeps each panel as an icon in its colour (it was a 12-px line, easy to lose). */
export const ANALYSIS_STRIP_COLLAPSED_HEIGHT = 26;

/** The Library's chip colour (the welcome screen's data tiles are sky/brand blue too). */
const LIBRARY_CHIP_COLOR = '#0369a1';
const LIBRARY_CHIP_TITLE = 'Library: your datasets; search, tag and reopen them';

/**
 * One entry of the strip: a panel chip, or the Library (owner, 1 Oct), a chip
 * like theirs that opens the Library window (the same one as Data & Sessions >
 * Library and the palette's "Library"), not a panel of its own.
 */
export interface StripItem {
  kind: 'panel' | 'library';
  /** The panel's contentType, or 'library'. */
  key: string;
  label: string;
  color: string;
  description?: string;
  group: GroupedPlugins['group'] | null;
  /** A divider before it: the first entry of a group after the first. */
  separator: boolean;
  /** A Preview feature's panel (utils/previewFeatures). */
  preview?: string;
}

/**
 * The strip's entries in order. The Library (local only) sits right before
 * Tracks, at the head of the View group, so the two read as a pair; with the
 * View group hidden it follows the Analyze panels. It is an ordinary entry: it
 * goes to More like the panels when the strip is short.
 */
export function buildStripItems(groups: GroupedPlugins[], libraryAvailable: boolean): StripItem[] {
  const items: StripItem[] = groups.flatMap((group, gi) => group.plugins.map((plugin, pi) => ({
    kind: 'panel' as const,
    key: plugin.contentType,
    label: getAnalysisPanelLabel(plugin.contentType, true),
    color: plugin.headerColor,
    description: plugin.description,
    group: group.group,
    separator: gi > 0 && pi === 0,
    ...(plugin.preview ? { preview: plugin.preview } : {}),
  })));
  if (!libraryAvailable) return items;
  const library: StripItem = { kind: 'library', key: 'library', label: 'Library', color: LIBRARY_CHIP_COLOR, group: null, separator: false };
  const viewStart = items.findIndex(item => item.group === 'view');
  if (viewStart >= 0) {
    // Library · Tracks: the Library takes over the group's divider.
    library.separator = items[viewStart].separator;
    items[viewStart] = { ...items[viewStart], separator: false };
    items.splice(viewStart, 0, library);
    return items;
  }
  const at = items.filter(item => item.group === 'analysis').length;
  library.separator = at > 0;
  if (at < items.length) items[at] = { ...items[at], separator: true };
  items.splice(at, 0, library);
  return items;
}

function StripItemIcon({ item, size }: { item: StripItem; size: number }) {
  return item.kind === 'library'
    ? <Library size={size} aria-hidden="true" />
    : <PanelIcon contentType={item.key} size={size} />;
}

export function AnalysisStrip() {
  const panels = useBrowserStore(s => s.panels);
  const hiddenStripPanels = useBrowserStore(s => s.hiddenStripPanels);
  const analysisStripCollapsed = useBrowserStore(s => s.analysisStripCollapsed);
  const [menuOpen, setMenuOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);

  // Contacts only makes sense once a contact map (.cool/.mcool) is loaded.
  const dafcLoaded = useDafcStore(s => s.dafcLoaded);
  usePreviewsEnabled();  // re-render when Settings → Show preview features flips (the Preview panels' buttons)
  const contactPanelOpen = panels.some(panel => panel.contentType === 'contact-map');
  const needsData = (contentType: string) => contentType === 'contact-map' && !dafcLoaded && !contactPanelOpen;

  const allGroups = getGroupedAnalysisPanels()
    .map(g => ({
      ...g,
      plugins: g.plugins.filter(p => !HIDDEN_PANELS.has(p.contentType) && !needsData(p.contentType)),
    }))
    .filter(g => g.plugins.length > 0);

  const visibleGroups = allGroups.map(g => ({
    ...g,
    plugins: g.plugins.filter(p => !hiddenStripPanels.has(p.contentType)),
  })).filter(g => g.plugins.length > 0);
  const libraryAvailable = useLibraryAvailable();
  const items = buildStripItems(visibleGroups, libraryAvailable);

  // Folded strip: one row of panel icons in their colours (open panels solid), and the chevron to unfold it.
  if (analysisStripCollapsed) {
    return (
      <div
        data-testid="analysis-strip-collapsed"
        className="flex flex-shrink-0 items-center gap-1 overflow-hidden border-b border-line/80 bg-white px-1.5 dark:border-white/10 dark:bg-dark-bg"
        style={{ height: ANALYSIS_STRIP_COLLAPSED_HEIGHT }}
      >
        <button
          type="button"
          onClick={() => useBrowserStore.getState().setAnalysisStripCollapsed(false)}
          className="flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-[11px] font-medium text-gray-500 hover:bg-gray-900/[0.06] hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200"
          title="Show the analysis strip"
          aria-label="Show the analysis strip"
          aria-expanded={false}
          data-testid="analysis-strip-expand"
        >
          <ChevronRight size={12} aria-hidden="true" />
          Panels
        </button>
        <CollapsedChips items={items} />
      </div>
    );
  }

  return (
    <div
      data-testid="analysis-strip"
      className="flex items-center gap-1 px-1.5 border-b border-line/80 dark:border-white/10 bg-white dark:bg-dark-bg flex-shrink-0"
      style={{ minHeight: ANALYSIS_STRIP_HEIGHT }}
    >
      {/* Collapse toggle */}
      <button
        type="button"
        data-testid="analysis-strip-collapse"
        onClick={() => useBrowserStore.getState().setAnalysisStripCollapsed(true)}
        className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-900/[0.06] hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-300 flex-shrink-0 transition-colors"
        title="Collapse analysis strip"
        aria-label="Collapse analysis strip"
      >
        <ChevronDown size={12} />
      </button>
      <StripChips items={items} />
      {/* Minimized panels and overlays: outside the chips so they stay reachable.
          (Arranging panels is the Layout panel; the tour starts from the Tutorial panel.) */}
      <div className="flex shrink-0 items-center gap-0.5 pl-1">
        <DatasetPanel />
      </div>
      {/* Which panels the strip shows */}
      <div className="relative">
        <button
          type="button"
          data-testid="analysis-strip-configure"
          ref={gearRef}
          onClick={() => setMenuOpen(!menuOpen)}
          className={`fb-btn-ghost px-2 py-[3px] text-[11px] ${menuOpen ? 'bg-gray-900/[0.06] text-gray-900 dark:bg-white/10 dark:text-white' : ''}`}
          title="Panel options: choose which panels this strip shows"
          aria-label="Panel options"
          aria-expanded={menuOpen}
        >
          <Sliders size={14} aria-hidden="true" />
          Panels
        </button>
        {menuOpen && (
          <AnalysisStripMenu
            allGroups={allGroups}

            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/** Open a panel, bring it forward in the side-panel drawer, or close it; the Library opens its window. */
function useActivateStripItem() {
  const panels = useBrowserStore(s => s.panels);
  const openAnalysisPanel = useBrowserStore(s => s.openAnalysisPanel);
  const closeAnalysisPanel = useBrowserStore(s => s.closeAnalysisPanel);
  const isOpen = (item: StripItem) => item.kind === 'panel' && Boolean(findOpenAnalysisPanel(panels, item.key));
  const activate = (item: StripItem) => {
    if (item.kind === 'library') { openLibrary(); return; }
    const activePanel = findOpenAnalysisPanel(panels, item.key);
    // Open behind another tab of the side-panel drawer: bring it forward rather than close it.
    if (activePanel && showDrawerPanel(activePanel.id)) return;
    if (activePanel) closeAnalysisPanel(activePanel.id);
    else openAnalysisPanel(item.key);
  };
  return { isOpen, activate };
}

/** The folded strip's icons: the same toggles as the chips (and the Library), icon only. */
function CollapsedChips({ items }: { items: StripItem[] }) {
  const { isOpen, activate } = useActivateStripItem();
  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-hidden" data-testid="analysis-strip-collapsed-chips">
      {items.map(item => {
        const library = item.kind === 'library';
        const open = isOpen(item);
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={library ? undefined : open}
            aria-haspopup={library ? 'dialog' : undefined}
            aria-label={item.label}
            title={library ? LIBRARY_CHIP_TITLE : `${item.label}: click to ${open ? 'close' : 'open'}`}
            onClick={() => activate(item)}
            className="fb-strip-chip h-5 shrink-0 justify-center !px-1"
            style={{ '--chip': item.color } as CSSProperties}
            data-testid={`analysis-strip-collapsed-${item.key}`}
          >
            <StripItemIcon item={item} size={14} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The panel chips (and the Library). Chips that don't fit the strip go to a
 * More menu at its end (never clipped or scrolled out of sight).
 */
function StripChips({ items }: { items: StripItem[] }) {
  const showDetails = useBrowserStore(s => s.showAnalysisDetails);
  const { isOpen, activate } = useActivateStripItem();
  const { rowRef, measureRef, overflow } = useRowOverflow(items.length, {
    gap: 4,
    moreWidth: 76,
    deps: items.map(item => item.key),
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

  const testId = (item: StripItem) => (item.kind === 'library' ? 'analysis-strip-library' : `analysis-strip-button-${item.key}`);
  const chip = (item: StripItem) => {
    if (item.kind === 'library') {
      return (
        <button
          type="button"
          data-testid={testId(item)}
          aria-haspopup="dialog"
          onClick={() => activate(item)}
          className="fb-strip-chip"
          style={{ '--chip': item.color } as CSSProperties}
          title={LIBRARY_CHIP_TITLE}
        >
          <StripItemIcon item={item} size={13} />
          {item.label}
        </button>
      );
    }
    const isActive = isOpen(item);
    return (
      <button
        type="button"
        data-testid={testId(item)}
        aria-pressed={isActive}
        onClick={() => activate(item)}
        className="fb-strip-chip"
        style={{ '--chip': item.color } as CSSProperties}
        title={`${isActive ? 'Click to close.' : 'Click to open.'} ${showDetails ? describePanelProvenance(item.key) : item.description ?? ''}`}
      >
        <StripItemIcon item={item} size={16} />
        {item.label}
        {item.preview && <PreviewBadge feature={item.preview} />}
      </button>
    );
  };
  const separator = <div className="w-px h-[18px] bg-line dark:bg-white/10 mx-1 hidden sm:block" />;

  return (
    <div ref={rowRef} className="relative flex min-w-0 flex-1 items-center gap-1 py-0.5 pr-1" data-testid="analysis-strip-chips">
      {items.map((item, i) => (hidden.has(i) ? null : (
        <div key={item.key} className="flex shrink-0 items-center gap-1">
          {item.separator && separator}
          {chip(item)}
        </div>
      )))}
      {overflow.length > 0 && (
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={`fb-btn-ghost px-2 py-[3px] text-[11px] ${menuOpen ? 'bg-gray-900/[0.06] dark:bg-white/10' : ''}`}
            title={`More: ${overflow.map(i => items[i].label).join(', ')}`}
            data-testid="analysis-strip-more"
          >
            More ({overflow.length})
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {/* Chips that don't fit stay in the page (1 px) so the tour and tests can still open them. */}
          <span className="absolute left-0 top-0 h-[2px]" style={{ width: overflow.length * 2 }} aria-hidden="true">
            {/* Two distinct pixels each (a click lands on its centre), so a test can click any of them. */}
            {overflow.map((i, k) => (
              <button
                key={items[i].key}
                type="button"
                tabIndex={-1}
                data-testid={testId(items[i])}
                aria-label={items[i].label}
                aria-pressed={items[i].kind === 'library' ? undefined : isOpen(items[i])}
                aria-haspopup={items[i].kind === 'library' ? 'dialog' : undefined}
                onClick={() => activate(items[i])}
                className="absolute top-0 h-[2px] w-[2px] p-0"
                style={{ left: k * 2 }}
              />
            ))}
          </span>
          {menuOpen && (
            <div role="menu" className="fb-menu left-0 right-auto min-w-[12rem]" data-testid="analysis-strip-more-menu">
              {overflow.map(i => {
                const item = items[i];
                const dot = <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} aria-hidden="true" />;
                if (item.kind === 'library') {
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitem"
                      aria-haspopup="dialog"
                      className="fb-menu-item"
                      title={LIBRARY_CHIP_TITLE}
                      data-testid="analysis-strip-more-library"
                      onClick={() => { setMenuOpen(false); activate(item); }}
                    >
                      {dot}
                      <StripItemIcon item={item} size={13} />
                      <span className="flex-1">{item.label}</span>
                    </button>
                  );
                }
                const isActive = isOpen(item);
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={isActive}
                    className="fb-menu-item"
                    onClick={() => { setMenuOpen(false); activate(item); }}
                  >
                    {dot}
                    <StripItemIcon item={item} size={16} />
                    <span className="flex-1">{item.label}</span>
                    {isActive && <span className="text-[11px] text-ink-muted">open</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center gap-1">
          {items.map(item => (
            <div key={item.key} className="flex shrink-0 items-center gap-1">
              {item.separator && separator}
              <span className="fb-strip-chip" style={{ '--chip': item.color } as CSSProperties}>
                <StripItemIcon item={item} size={16} />
                {item.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Which panels the launchers show (the strip's Panels menu; the sidebar rail's too, placed by `className`). */
export function AnalysisStripMenu({
  allGroups,
  onClose,
  title = 'Strip panels',
  className = 'absolute right-0 top-full mt-1',
  style,
}: {
  allGroups: GroupedPlugins[];
  onClose: () => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const hiddenStripPanels = useBrowserStore(s => s.hiddenStripPanels);
  const toggleStripPanel = useBrowserStore(s => s.toggleStripPanel);
  const setHiddenStripPanels = useBrowserStore(s => s.setHiddenStripPanels);
  const menuRef = useRef<HTMLDivElement>(null);
  const allContentTypes = useMemo(
    () => allGroups.flatMap(group => group.plugins.map(plugin => plugin.contentType)),
    [allGroups],
  );
  const hiddenCount = allContentTypes.filter(contentType => hiddenStripPanels.has(contentType)).length;
  const visibleCount = allContentTypes.length - hiddenCount;

  // Close on click outside or Escape
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      data-testid="analysis-strip-menu"
      ref={menuRef}
      style={style}
      className={`${className} bg-white dark:bg-dark-surface border border-line dark:border-white/10 rounded-fb-lg shadow-dropdown dark:shadow-dropdown-dark z-30 py-1 min-w-[220px]`}
    >
      <div className="px-2 py-1.5 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-gray-500 dark:text-gray-400 font-medium">
            {title}
          </span>
          <span className="text-[11px] text-ink-secondary">
            {visibleCount}/{allContentTypes.length} visible
          </span>
        </div>
        {/* Only when there is something to show (it sat there greyed out). */}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setHiddenStripPanels([])}
            className="mt-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
            data-testid="analysis-strip-show-all"
          >
            Show all panels
          </button>
        )}
      </div>
      {allGroups.map(group => (
        <div key={group.group}>
          <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-0.5">
            <span className="text-[11px] font-semibold text-ink-secondary">
              {group.label}
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  const groupTypes = new Set(group.plugins.map(p => p.contentType));
                  setHiddenStripPanels([...hiddenStripPanels].filter(id => !groupTypes.has(id)));
                }}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
              >
                Show
              </button>
              <button
                type="button"
                onClick={() => {
                  setHiddenStripPanels(new Set([
                    ...hiddenStripPanels,
                    ...group.plugins.map(p => p.contentType),
                  ]));
                }}
                className="text-[11px] text-ink-secondary hover:text-gray-600 dark:hover:text-gray-300"
              >
                Hide
              </button>
            </span>
          </div>
          {group.plugins.map(p => (
            <label
              key={p.contentType}
              className="flex items-center gap-2 px-2 py-1 text-[12px] hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer text-gray-700 dark:text-gray-300"
            >
              <input
                type="checkbox"
                checked={!hiddenStripPanels.has(p.contentType)}
                onChange={() => toggleStripPanel(p.contentType)}
                className="rounded"
              />
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: p.headerColor }}
              />
              <span className="min-w-0 truncate">{p.shortLabel || p.label}</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}
