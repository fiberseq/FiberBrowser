/**
 * The analysis panel launchers in the sidebar rail, the default place for them
 * (Settings › Reads & Display › Analysis panels: Sidebar rail; Strip (classic)
 * puts them back above the reads). The rail keeps its width: one tile per
 * panel, the size of the settings icons above but filled with the panel's
 * colour (its landmark) and a white panel icon, so the two groups read apart.
 * An open panel's tile is ringed. Hover, keyboard focus or a long press shows
 * the panel's full name and what it is for; the panel opens with its full name
 * in its header (or drawer tab).
 *
 * Clicking a tile does what the strip's chip does: opens the panel beside the
 * reads, or in the side drawer right next to the rail when the reads are too
 * narrow for both (it slides in from this edge); a panel behind another drawer
 * tab comes forward; an open panel closes.
 *
 * Minimized dataset panels sit at the bottom of the launchers as round tiles in
 * the dataset's colour (click to restore): what is off screen waits at the
 * window's right edge, beside the drawer, and the reads keep their full height
 * (the strip's minimized tray would take a row under them).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useDafcStore } from '../../stores/dafcStore';
import { showDrawerPanel } from '../../stores/drawerTabsStore';
import { usePanelLauncherStore } from '../../stores/panelLauncherStore';
import { PreviewBadge } from '../ui/PreviewBadge';
import { PreviewRailHint } from './PreviewRailHint';
import { usePreviewsEnabled } from '../../utils/previewFeatures';
import { findOpenAnalysisPanel, getAnalysisPanelLabel, getGroupedAnalysisPanels } from '../../plugins/registry';
import type { GroupedPlugins } from '../../plugins/registry';
import { PanelIcon } from '../ui/panelIcons';
import { ChevronDown, Eye, Library, Reads, X } from '../ui/Icons';
import { AnalysisStripMenu, HIDDEN_PANELS } from '../tracks/AnalysisStrip';
import { useLibraryAvailable } from './library/LibraryHost';
import { openLibrary, useLibraryStore } from './library/libraryStore';
import { getDatasetDisplayLabel } from '../../utils/datasetLabels';
import { railTileColor } from '../../utils/railTileColor';
import { isSandboxPage } from '../../utils/sandbox';

/** The Library's colour (as its strip chip, AnalysisStrip's LIBRARY_CHIP_COLOR). */
const LIBRARY_COLOR = '#0369a1';
const TOOLTIP_ID = 'panel-rail-tooltip';
const HOVER_DELAY_MS = 300;
const LONG_PRESS_MS = 450;

type Launcher =
  | { kind: 'panel'; key: string; contentType: string; name: string; description: string; color: string; open: boolean; minimized: boolean; separator: boolean; preview?: string }
  | { kind: 'library'; key: string; name: string; description: string; color: string; open: boolean; separator: boolean }
  | { kind: 'dataset'; key: string; panelId: string; name: string; description: string; color: string; separator: boolean };

interface Tip { key: string; name: string; description: string; rect: DOMRect; pinned?: boolean; preview?: string }

/** The launcher groups the strip would show (same hidden panels, same data-dependent ones). */
export function useLauncherGroups(): { allGroups: GroupedPlugins[]; visibleGroups: GroupedPlugins[] } {
  const panels = useBrowserStore(s => s.panels);
  const hiddenStripPanels = useBrowserStore(s => s.hiddenStripPanels);
  const dafcLoaded = useDafcStore(s => s.dafcLoaded);
  // Settings → Show preview features adds or takes away the Preview panels' tiles.
  const previews = usePreviewsEnabled();
  return useMemo(() => {
    const contactPanelOpen = panels.some(panel => panel.contentType === 'contact-map');
    // Contacts only once a contact map is loaded (as in the strip).
    const needsData = (contentType: string) => contentType === 'contact-map' && !dafcLoaded && !contactPanelOpen;
    const allGroups = getGroupedAnalysisPanels()
      .map(g => ({ ...g, plugins: g.plugins.filter(p => !HIDDEN_PANELS.has(p.contentType) && !needsData(p.contentType)) }))
      .filter(g => g.plugins.length > 0);
    const visibleGroups = allGroups
      .map(g => ({ ...g, plugins: g.plugins.filter(p => !hiddenStripPanels.has(p.contentType)) }))
      .filter(g => g.plugins.length > 0);
    return { allGroups, visibleGroups };
  }, [panels, hiddenStripPanels, dafcLoaded, previews]);
}

/** The tiles in order: the groups (Analyze, View, Tools), the Library right after Tracks, then minimized datasets. */
export function railLaunchers(
  groups: GroupedPlugins[],
  panels: ReturnType<typeof useBrowserStore.getState>['panels'],
  opts: { library: boolean; libraryOpen: boolean; datasets: ReturnType<typeof useBrowserStore.getState>['datasets'] },
): Launcher[] {
  const out: Launcher[] = [];
  let libraryPlaced = !opts.library;
  const library = (separator: boolean): Launcher => ({
    kind: 'library', key: 'library', name: 'Library', separator,
    description: 'Your datasets: search, tag and reopen them.', color: LIBRARY_COLOR, open: opts.libraryOpen,
  });
  groups.forEach((group, gi) => {
    group.plugins.forEach((plugin, pi) => {
      const open = Boolean(findOpenAnalysisPanel(panels, plugin.contentType));
      const minimized = !open && panels.some(p => p.contentType === plugin.contentType && p.collapsed);
      out.push({
        kind: 'panel', key: plugin.contentType, contentType: plugin.contentType,
        name: getAnalysisPanelLabel(plugin.contentType), description: plugin.description ?? '',
        color: plugin.headerColor, open, minimized, separator: gi > 0 && pi === 0,
        ...(plugin.preview ? { preview: plugin.preview } : {}),
      });
      if (!libraryPlaced && plugin.contentType === 'track-browser') { out.push(library(false)); libraryPlaced = true; }
    });
    // Tracks hidden: the Library ends the View group.
    if (!libraryPlaced && group.group === 'view') { out.push(library(false)); libraryPlaced = true; }
  });
  if (!libraryPlaced) out.push(library(out.length > 0));
  const minimized = panels.filter(p => p.collapsed && p.contentType === 'dataset');
  minimized.forEach((panel, i) => {
    const ds = opts.datasets.find(d => d.id === panel.datasetId);
    out.push({
      kind: 'dataset', key: `restore-${panel.id}`, panelId: panel.id,
      name: ds ? getDatasetDisplayLabel(ds, 40) : (panel.datasetId ?? 'Dataset'),
      description: 'Minimized dataset panel: click to restore it.',
      color: ds?.color || '#666666', separator: i === 0 && out.length > 0,
    });
  });
  return out;
}

/** The panel's full name and what it does, left of the rail (never off the window). */
function RailTooltip({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(tip.rect.top);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    const centre = tip.rect.top + tip.rect.height / 2;
    setTop(Math.max(8, Math.min(window.innerHeight - h - 8, centre - h / 2)));
  }, [tip]);
  return createPortal(
    <div
      ref={ref}
      id={TOOLTIP_ID}
      role="tooltip"
      data-testid="panel-rail-tooltip"
      className="pointer-events-none fixed z-[10000] max-w-[260px] rounded-fb bg-brand-950/95 px-2.5 py-1.5 text-left text-slate-50 shadow-dropdown ring-1 ring-white/10 dark:bg-dark-elevated"
      style={{ top, right: Math.max(8, window.innerWidth - tip.rect.left + 8), maxWidth: Math.min(260, Math.max(140, tip.rect.left - 16)) }}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-semibold leading-4">{tip.name}{tip.preview && <PreviewBadge feature={tip.preview} />}</div>
      {tip.description && <div className="mt-0.5 text-[11px] leading-snug text-slate-300">{tip.description}</div>}
    </div>,
    document.body,
  );
}

/** One-time hint the first time the rail shows its launchers (per viewer). */
function RailCoachMark({ anchor, onDismiss }: { anchor: HTMLElement; onDismiss: () => void }) {
  const [rect, setRect] = useState(() => anchor.getBoundingClientRect());
  useEffect(() => {
    const update = () => setRect(anchor.getBoundingClientRect());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchor]);
  return createPortal(
    <div
      role="note"
      data-testid="panel-rail-coach"
      // Never in the way: clicks go through it to what is below (only its × takes them).
      className="pointer-events-none fixed z-[70] w-[220px] rounded-fb-lg border border-line bg-white px-3 py-2 text-[12px] text-ink shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:text-gray-100 dark:shadow-dropdown-dark"
      style={{ top: Math.max(8, Math.min(window.innerHeight - 120, rect.top - 6)), right: Math.max(8, window.innerWidth - rect.left + 10) }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Analysis panels</div>
          <div className="mt-0.5 text-[11px] leading-snug text-ink-secondary dark:text-gray-300">
            Hover or focus a coloured tile for its name; click it to open the panel.
            Prefer the classic strip above the reads? Settings › Reads &amp; Display › Analysis panels.
          </div>
        </div>
        <button type="button" className="fb-rail-btn pointer-events-auto h-5 w-5 shrink-0" aria-label="Dismiss the panel launcher hint" onClick={onDismiss} data-testid="panel-rail-coach-dismiss">
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function PanelRail() {
  const { panels, datasets, openAnalysisPanel, closeAnalysisPanel, setPanelCollapsed } = useBrowserStore(useShallow(s => ({
    panels: s.panels, datasets: s.datasets,
    openAnalysisPanel: s.openAnalysisPanel, closeAnalysisPanel: s.closeAnalysisPanel,
    setPanelCollapsed: s.setPanelCollapsed,
  })));
  const { allGroups, visibleGroups } = useLauncherGroups();
  const libraryAvailable = useLibraryAvailable();
  const libraryOpen = useLibraryStore(s => s.open);
  // The linked (split) views draw no analysis panels (TrackContainerSplitView): their tiles wait.
  const viewMode = useBrowserStore(s => s.viewMode);
  const dafcLoaded = useDafcStore(s => s.dafcLoaded);
  const splitView = (viewMode === 'linked' && dafcLoaded) || viewMode === 'linkedSplit';
  const coachSeen = usePanelLauncherStore(s => s.coachSeen);
  const dismissCoach = usePanelLauncherStore(s => s.dismissCoach);
  const launchers = useMemo(
    () => railLaunchers(visibleGroups, panels, { library: libraryAvailable, libraryOpen, datasets }),
    [visibleGroups, panels, libraryAvailable, libraryOpen, datasets],
  );

  const [tip, setTip] = useState<Tip | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const [fades, setFades] = useState({ top: false, bottom: false });
  const [captionEl, setCaptionEl] = useState<HTMLElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The tile whose long press showed its name: that touch's click doesn't also open it. */
  const longPressed = useRef<string | null>(null);
  /** The tile is being pressed (its focus is not keyboard focus). */
  const pointerFocus = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuByKeyboard = useRef(false);
  // The popup is placed from its button: a resize closes it rather than leave it adrift.
  useEffect(() => {
    if (!menuOpen) return;
    if (menuByKeyboard.current) menuRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onResize = () => setMenuOpen(false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [menuOpen]);

  const clearHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(() => () => { clearHover(); clearPress(); }, []);
  // (A blur of the tile focused before a long press must not cancel that press.)
  const hideTip = useCallback(() => { clearHover(); setTip(null); }, []);
  // Escape closes the tooltip; scrolling the rail moves it away.
  useEffect(() => {
    if (!tip) return;
    // Escape closes the tooltip only (not also the selection behind it: useKeyboardShortcuts skips handled keys).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); hideTip(); } };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', hideTip);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', hideTip);
    };
  }, [tip, hideTip]);

  // Top/bottom fades when the launchers scroll (a small window).
  const updateFades = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setFades(prev => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);
  useEffect(() => {
    updateFades();
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateFades);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateFades, launchers.length]);

  // The chevrons at the ends: scroll most of a screenful of tiles in.
  const scrollList = (direction: 1 | -1) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollBy({ top: direction * Math.max(36, el.clientHeight - 48), behavior: 'smooth' });
  };

  // The hint waits while the settings sidebar is open (it would sit over it), and an
  // analysis panel opened any other way (palette, toolbar) means the panels were found.
  const sidebarOpen = useBrowserStore(s => s.sidebarOpen);
  // Any analysis panel, whether or not its launcher is shown (Panels menu).
  const anyPanelOpen = panels.some(p => p.contentType !== 'dataset' && !p.collapsed);
  // Any panel opened while the hint is up (split panels, a copy, another dataset) means panels were found too, and
  // the hint would sit over their headers' actions (usability audit SV-8).
  const datasetPanelCount = panels.filter(p => p.contentType === 'dataset' && !p.collapsed).length;
  // (counted from when the hint first shows: datasets still opening at startup don't count)
  const firstDatasetPanelCount = useRef<number | null>(null);
  const morePanels = panels.some(p => p.readSubset) || (firstDatasetPanelCount.current !== null && datasetPanelCount > firstDatasetPanelCount.current);
  useEffect(() => {
    if (!coachSeen && (anyPanelOpen || morePanels)) dismissCoach();
  }, [coachSeen, anyPanelOpen, morePanels, dismissCoach]);
  const showCoach = !coachSeen && !anyPanelOpen && !morePanels && !sidebarOpen && datasets.length > 0 && !isSandboxPage() && captionEl !== null;
  if (showCoach && firstDatasetPanelCount.current === null) firstDatasetPanelCount.current = datasetPanelCount;

  const activate = (item: Launcher) => {
    if (!coachSeen) dismissCoach();
    hideTip();
    if (item.kind === 'library') { openLibrary(); return; }
    if (item.kind === 'dataset') { setPanelCollapsed(item.panelId, false); return; }
    if (splitView) return;
    // As the strip's chip: bring a panel behind another drawer tab forward, else open or close it.
    const open = findOpenAnalysisPanel(panels, item.contentType);
    if (open && showDrawerPanel(open.id)) return;
    if (open) closeAnalysisPanel(open.id);
    else openAnalysisPanel(item.contentType as Parameters<typeof openAnalysisPanel>[0]);
  };

  const tipFor = (item: Launcher, el: HTMLElement, pinned = false): Tip => {
    let description = item.description;
    if (item.kind === 'panel' && item.open) description = `${description}${description ? ' ' : ''}Open: click to close.`;
    if (item.kind === 'panel' && item.minimized) description = `${description}${description ? ' ' : ''}Minimized: click to restore.`;
    if (item.kind === 'panel' && splitView) description = `${description}${description ? ' ' : ''}Not in the linked split view: switch back to panels to open it.`;
    return { key: item.key, name: item.name, description, rect: el.getBoundingClientRect(), pinned,
      ...(item.kind === 'panel' && item.preview ? { preview: item.preview } : {}) };
  };

  const tileHandlers = (item: Launcher) => ({
    onPointerEnter: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === 'touch') return;
      const el = e.currentTarget;
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      // Moving along the rail with a tooltip up: the next one shows at once.
      if (tip) { setTip(tipFor(item, el)); return; }
      hoverTimer.current = setTimeout(() => setTip(tipFor(item, el)), HOVER_DELAY_MS);
    },
    onPointerLeave: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === 'touch') return;
      hideTip();
    },
    onFocus: (e: React.FocusEvent<HTMLButtonElement>) => {
      // Keyboard focus: at once (a press focuses too; hover and long press handle that).
      if (pointerFocus.current) { pointerFocus.current = false; return; }
      setTip(tipFor(item, e.currentTarget));
    },
    onBlur: () => hideTip(),
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      pointerFocus.current = true;
      longPressed.current = null;
      clearPress();
      if (e.pointerType !== 'touch') return;
      const el = e.currentTarget;
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null;
        longPressed.current = item.key;
        setTip(tipFor(item, el, true));
        clearHover();
        hoverTimer.current = setTimeout(() => setTip(null), 2500);
      }, LONG_PRESS_MS);
    },
    onPointerUp: () => {
      clearPress();
      // The press's focus has happened by now; the next focus may be the keyboard's.
      setTimeout(() => { pointerFocus.current = false; }, 0);
    },
    onPointerCancel: () => {
      // Cancelled (a scroll took over): no click follows, so nothing is left to swallow.
      clearPress();
      longPressed.current = null;
      pointerFocus.current = false;
    },
    onContextMenu: (e: React.MouseEvent) => { if (longPressed.current === item.key) e.preventDefault(); },
    onClick: () => {
      pointerFocus.current = false;
      const pressed = longPressed.current;
      longPressed.current = null;
      // A long press on this tile showed its name: that touch doesn't also open the panel.
      if (pressed === item.key) return;
      activate(item);
    },
  });

  // Up/Down move between the tiles (Tab still reaches each one).
  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const tiles = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-rail-tile]') ?? []);
    const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tiles.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : tiles.length - 1)) % tiles.length;
    tiles[next]?.focus();
  };

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    if (menuButtonRef.current && document.activeElement && document.activeElement !== document.body
      && !menuButtonRef.current.contains(document.activeElement)) {
      menuButtonRef.current.focus();
    }
  }, []);

  const tile = (item: Launcher): ReactNode => {
    const shade = railTileColor(item.color);
    const pressed = item.kind === 'dataset' ? undefined : item.open;
    const testId = item.kind === 'panel' ? `panel-rail-${item.contentType}` : item.kind === 'library' ? 'panel-rail-library' : `panel-rail-restore-${item.panelId}`;
    return (
      <div key={item.key} className="flex w-full flex-col items-center">
        {item.separator && <div className="my-1 h-px w-4 bg-line dark:bg-white/10" aria-hidden="true" />}
        <button
          type="button"
          data-rail-tile=""
          data-testid={testId}
          data-panel-launcher={item.kind === 'panel' ? item.contentType : item.kind}
          {...(item.kind === 'dataset' ? { 'data-panel-restore-id': item.panelId, 'data-tour': 'panel-expand' } : {})}
          aria-label={item.kind === 'dataset' ? `Restore ${item.name}` : item.kind === 'panel' && item.preview ? `${item.name} (Preview)` : item.name}
          aria-pressed={pressed}
          aria-haspopup={item.kind === 'library' ? 'dialog' : undefined}
          aria-disabled={item.kind === 'panel' && splitView ? true : undefined}
          aria-describedby={tip?.key === item.key ? TOOLTIP_ID : undefined}
          className={`fb-rail-tile ${item.kind === 'dataset' ? 'fb-rail-tile-round' : ''} ${item.kind === 'panel' && splitView ? 'opacity-40' : ''}`}
          style={{ '--tile': shade, '--tile-ring': item.color } as CSSProperties}
          {...tileHandlers(item)}
        >
          <span className="fb-rail-tile-face">
            {item.kind === 'panel' && <PanelIcon contentType={item.contentType} size={16} />}
            {item.kind === 'library' && <Library size={16} aria-hidden="true" />}
            {item.kind === 'dataset' && <Reads size={14} aria-hidden="true" />}
          </span>
          {item.kind === 'panel' && item.minimized && <span className="fb-rail-tile-dot" aria-hidden="true" />}
          {item.kind === 'panel' && item.preview && <span className="fb-rail-tile-preview" data-testid="panel-rail-preview-badge" aria-hidden="true">P</span>}
        </button>
      </div>
    );
  };

  return (
    <nav
      aria-label="Analysis panels"
      data-testid="panel-rail"
      className="relative flex min-h-0 w-full flex-1 flex-col items-center"
    >
      <div ref={setCaptionEl} className="mt-1.5 flex w-full shrink-0 flex-col items-center" aria-hidden="true">
        <div className="h-px w-6 bg-line dark:bg-white/10" />
        <div className="mt-1 select-none text-[10px] font-medium leading-3 text-ink-muted dark:text-gray-400">Panels</div>
      </div>
      <div className="relative mt-1 flex min-h-0 w-full flex-1 flex-col">
        <div
          ref={listRef}
          onScroll={() => { updateFades(); if (tip) hideTip(); }}
          onKeyDown={onListKeyDown}
          className="fb-rail-scroll flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden py-1"
          data-testid="panel-rail-launchers"
        >
          {launchers.map(tile)}
          {/* Lab build, previews off: a Preview panel has a tile here saying so (N8). */}
          <PreviewRailHint />
        </div>
        {/* More launchers above or below (a small window): a fade and a chevron that scrolls them in. */}
        {fades.top && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Show the panels above"
            onClick={() => scrollList(-1)}
            className="fb-rail-more absolute inset-x-0 top-0 bg-gradient-to-b from-surface-sunken via-surface-sunken/90 to-transparent dark:from-dark-bg dark:via-dark-bg/90"
            data-testid="panel-rail-fade-top"
          >
            <ChevronDown size={12} className="rotate-180" aria-hidden="true" />
          </button>
        )}
        {fades.bottom && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Show more panels"
            onClick={() => scrollList(1)}
            className="fb-rail-more absolute inset-x-0 bottom-0 bg-gradient-to-t from-surface-sunken via-surface-sunken/90 to-transparent dark:from-dark-bg dark:via-dark-bg/90"
            data-testid="panel-rail-fade-bottom"
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {/* Which launchers the rail shows (the strip's Panels menu). */}
      <button
        ref={menuButtonRef}
        type="button"
        className={`fb-rail-btn mt-1 shrink-0 ${menuOpen ? 'fb-icon-btn-active' : ''}`}
        title="Choose which panels the rail shows"
        aria-label="Choose which panels the rail shows"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        data-testid="panel-rail-configure"
        // The menu closes on a press outside it: this button toggles it instead.
        onMouseDown={e => { if (menuOpen) e.stopPropagation(); }}
        onClick={e => {
          setMenuAnchor(e.currentTarget.getBoundingClientRect());
          // Opened from the keyboard (no pointer): focus moves into it.
          menuByKeyboard.current = e.detail === 0;
          setMenuOpen(open => !open);
        }}
      >
        <Eye size={15} aria-hidden="true" />
      </button>
      {menuOpen && menuAnchor && createPortal(
        <div
          ref={menuRef}
          role="dialog"
          aria-label="Choose which panels the rail shows"
          className="fixed z-[60] overflow-y-auto"
          style={{
            right: Math.max(8, window.innerWidth - menuAnchor.left + 6),
            bottom: Math.max(8, window.innerHeight - menuAnchor.bottom),
            maxHeight: Math.max(160, menuAnchor.bottom - 8),
          }}
          data-testid="panel-rail-menu"
        >
          <AnalysisStripMenu allGroups={allGroups} onClose={closeMenu} title="Rail panels" className="relative" />
        </div>,
        document.body,
      )}
      {tip && <RailTooltip tip={tip} />}
      {showCoach && captionEl && <RailCoachMark anchor={captionEl} onDismiss={dismissCoach} />}
    </nav>
  );
}
