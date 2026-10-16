import { useState, useEffect, useCallback } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import type { PanelConfig } from '../../types';
import { updateTrackFilter } from '../../api/tracks';
import { PANEL_HEADER_HEIGHT } from './PanelHeader';
import { GripVertical, Maximize, Minimize, MoreVertical, PanelBeside, PanelRight, X } from '../ui/Icons';
import { PanelIcon } from '../ui/panelIcons';
import { PreviewBadge } from '../ui/PreviewBadge';
import { getAnalysisPanel } from '../../plugins/registry';
import { UI_THEME, headerBarStyle } from '../../theme/uiTheme';
import { fitHeaderActions, useHeaderMeasure } from '../../hooks/useHeaderActionsFit';

type AnalysisActionKey = 'close' | 'fullview' | 'dock';

/** A side panel shown in the drawer over the reads: how docking it beside them goes. */
export interface DrawerDock {
  /** Panels in this drawer. */
  count: number;
  /** Side panels that would still be in the drawer after docking (0: they all fit beside the reads). */
  stay: number;
  /** Dock every panel of this drawer beside the reads. */
  dock: () => void;
}

/**
 * Why the drawer's panels can't come out: the window is too narrow for them beside
 * the reads. `stay` counts every side panel of the row that would be in the drawer,
 * which can include one now beside the reads (docking would pull it in as well).
 */
export function drawerStayMessage(stay: number, count: number): string {
  if (stay > count) return `The ${stay} side panels don't all fit beside the reads: widen the window or close one`;
  return `${stay} panel${stay === 1 ? ' stays' : 's stay'} in the drawer: widen the window or close one`;
}

/** Responsive header for analysis panels with overflow menu when narrow. */
export function AnalysisPanelHeader({
  panel, panelIndex, headerColor, label, isFullView, narrow, drawer = null,
  onDragStart, onDragEnd,
  onFullView, onClose,
}: {
  panel: PanelConfig; panelIndex: number; headerColor: string; label: string;
  isFullView: boolean; narrow: boolean;
  /** The panel is in the drawer over the reads (pinned there, or the window is too narrow). */
  drawer?: DrawerDock | null;
  onDragStart: (e: React.DragEvent, idx: number) => void;
  onDragEnd: () => void;
  onFullView: () => void; onClose: () => void;
}) {
  const [showOverflow, setShowOverflow] = useState(false);
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  const showLayoutChrome = !exportInProgress;
  // A Preview feature's panel says so beside its name (not in a figure export).
  const preview = showLayoutChrome ? getAnalysisPanel(panel.contentType)?.preview : undefined;
  // The control follows where the panel is, not only its pin: in the drawer it docks
  // the whole drawer beside the reads (every tab together), or says why it can't;
  // beside the reads it pins this panel to the side. Remembered per panel type.
  const inDrawer = Boolean(drawer);
  // Pinned but laid out in the row (a row of side panels only): unpin it.
  const pinnedInRow = !inDrawer && panel.dock === 'side';
  const blockedReason = drawer && drawer.stay > 0 ? drawerStayMessage(drawer.stay, drawer.count) : null;
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => { if (!blockedReason) setNotice(null); }, [blockedReason]);
  const dockLabel = inDrawer
    ? (drawer!.count > 1 ? 'Dock the side panels beside the reads' : 'Dock beside the reads')
    : pinnedInRow ? 'Dock beside the reads' : 'Pin to the side';
  const dockTitle = blockedReason
    ?? (inDrawer
      ? (drawer!.count > 1
        ? `Dock beside the reads: all ${drawer!.count} panels in the drawer take their own columns again`
        : 'Dock beside the reads: this panel takes its own column again')
      : pinnedInRow
        ? 'Dock beside the reads: this panel takes its own column again'
        : 'Pin to the side: a drawer that slides over the reads, so they keep the whole width');
  const toggleDock = () => {
    if (blockedReason) { setNotice(blockedReason); return; }
    if (drawer) drawer.dock();
    else useBrowserStore.getState().setPanelDock(panel.id, pinnedInRow ? 'beside' : 'side');
  };

  const actionKeys: AnalysisActionKey[] = isFullView ? ['close', 'fullview'] : ['close', 'fullview', 'dock'];
  const { headerRef, measureRef, width: headerWidth, widths } = useHeaderMeasure([actionKeys.join(','), label, showLayoutChrome]);
  // Room for the actions: the header less its padding, grip, icon and the name's minimum (or whole, if shorter).
  const nameReserve = Math.min(widths.label ?? 0, 96);
  const actionsFit = fitHeaderActions(
    headerWidth === undefined ? (narrow ? 0 : undefined) : headerWidth - 16 - 19 - 22 - nameReserve,
    actionKeys.map(key => ({ key, width: widths[key] ?? 0 })),
    { gap: 6, moreWidth: widths.more ?? 0 },
  );

  return (
    <div
      ref={headerRef}
      data-header-overflow={actionsFit.overflow.length}
      className="group/panel-header relative flex items-center pl-2.5 pr-1.5 select-none gap-1.5"
      data-testid={`analysis-panel-header-${panel.contentType}`}
      style={{ height: PANEL_HEADER_HEIGHT, ...headerBarStyle(headerColor) }}
    >
      {showLayoutChrome && (
        <span
          draggable
          className="cursor-grab leading-none opacity-0 transition-opacity hover:opacity-100 group-hover/panel-header:opacity-80 group-focus-within/panel-header:opacity-80 active:cursor-grabbing"
          title="Drag panel"
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => onDragStart(e, panelIndex)}
          onDragEnd={onDragEnd}
        >
          <GripVertical size={13} />
        </span>
      )}
      <span className="flex flex-shrink-0" style={UI_THEME.headerTone === 'tint' ? { color: headerColor } : undefined}>
        <PanelIcon contentType={panel.contentType} size={16} />
      </span>
      <span className="flex-1 truncate font-semibold text-[13px] tracking-[-0.005em]">
        {label}
        {preview && !/preview\)$/i.test(label) && <PreviewBadge feature={preview} className="ml-1.5 align-middle" />}
      </span>
      {showLayoutChrome && (() => {
        // As many actions as fit (fb-n11-tracks): close, expand, then dock; the rest in the ⋮ menu.
        const visible = (key: AnalysisActionKey) => actionsFit.shown.includes(key);
        const dockButton = (measureOnly = false) => (
          <button
            key="dock"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={measureOnly ? undefined : toggleDock}
            className={`fb-header-act ${blockedReason ? 'opacity-50' : ''}`}
            title={measureOnly ? undefined : dockTitle}
            aria-label={measureOnly ? undefined : dockLabel}
            aria-disabled={!measureOnly && blockedReason ? true : undefined}
            data-in-drawer={!measureOnly && inDrawer ? 'true' : undefined}
            data-testid={measureOnly ? undefined : `panel-dock-toggle-${panel.contentType}`}
            data-measure-key={measureOnly ? 'dock' : undefined}
            tabIndex={measureOnly ? -1 : undefined}
          >
            {inDrawer || pinnedInRow ? <PanelBeside size={13} /> : <PanelRight size={13} />}
          </button>
        );
        const fullButton = (measureOnly = false) => (
          <button key="fullview" onMouseDown={(e) => e.stopPropagation()} onClick={measureOnly ? undefined : onFullView} className="fb-header-act"
            title={measureOnly ? undefined : (isFullView ? 'Restore all panels' : 'Expand to full view')}
            aria-label={measureOnly ? undefined : (isFullView ? 'Restore all panels' : 'Expand to full view')}
            data-measure-key={measureOnly ? 'fullview' : undefined} tabIndex={measureOnly ? -1 : undefined}>
            {isFullView ? <Minimize size={13} /> : <Maximize size={13} />}
          </button>
        );
        const closeButton = (measureOnly = false) => (
          <button key="close" onMouseDown={(e) => e.stopPropagation()} onClick={measureOnly ? undefined : onClose} className="fb-header-act"
            title={measureOnly ? undefined : 'Close panel'} aria-label={measureOnly ? undefined : 'Close panel'}
            data-measure-key={measureOnly ? 'close' : undefined} tabIndex={measureOnly ? -1 : undefined}>
            <X size={14} />
          </button>
        );
        return (
          <>
            {actionsFit.overflow.length > 0 && (
              <div className="relative">
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setShowOverflow(!showOverflow)}
                  className="fb-header-act"
                  title="Panel actions"
                  aria-label="Panel actions"
                  aria-haspopup="menu"
                  aria-expanded={showOverflow}
                  data-testid={`analysis-panel-actions-${panel.contentType}`}
                >
                  <MoreVertical size={13} />
                </button>
                {showOverflow && (
                  <div
                    role="menu"
                    className="fb-menu right-0 min-w-[11rem]"
                    onMouseLeave={() => setShowOverflow(false)}
                  >
                    {!visible('dock') && !isFullView && <button role="menuitem" onMouseDown={(e) => e.stopPropagation()} onClick={() => { toggleDock(); setShowOverflow(false); }} className={`fb-menu-item ${blockedReason ? 'opacity-50' : ''}`} title={dockTitle} aria-disabled={blockedReason ? true : undefined} data-in-drawer={inDrawer ? 'true' : undefined} data-testid={`panel-dock-toggle-${panel.contentType}`}>{dockLabel}</button>}
                    {!visible('fullview') && <button role="menuitem" onMouseDown={(e) => e.stopPropagation()} onClick={() => { onFullView(); setShowOverflow(false); }} className="fb-menu-item">{isFullView ? 'Restore all panels' : 'Expand to full view'}</button>}
                    {!visible('close') && <button role="menuitem" onMouseDown={(e) => e.stopPropagation()} onClick={() => { onClose(); setShowOverflow(false); }} className="fb-menu-item hover:!text-red-600 dark:hover:!text-red-400">Close panel</button>}
                  </div>
                )}
              </div>
            )}
            {!isFullView && visible('dock') && dockButton()}
            {visible('fullview') && fullButton()}
            {visible('close') && closeButton()}
            <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
              <div ref={measureRef} className="invisible absolute left-0 top-0 flex w-max items-center gap-1.5">
                <span data-measure-key="dock" className="fb-header-act"><PanelRight size={13} /></span>
                <span data-measure-key="fullview" className="fb-header-act"><Maximize size={13} /></span>
                <span data-measure-key="close" className="fb-header-act"><X size={14} /></span>
                <span data-measure-key="more" className="fb-header-act"><MoreVertical size={13} /></span>
                <span data-measure-key="label" className="font-semibold text-[13px] tracking-[-0.005em]">{label}</span>
              </div>
            </div>
          </>
        );
      })()}
      {notice && showLayoutChrome && (
        <div
          role="status"
          data-testid={`panel-dock-notice-${panel.contentType}`}
          className="absolute right-1 top-full z-40 mt-1 max-w-[calc(100%-0.5rem)] rounded-fb border border-line bg-white px-2 py-1 text-[11.5px] font-normal text-ink shadow-md dark:border-white/10 dark:bg-dark-surface dark:text-gray-200"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {notice}
        </div>
      )}
    </div>
  );
}

/** Small filter input overlaid on annotation tracks for name filtering (e.g. JASPAR TFs). */
export function AnnotationFilterInput({ trackIndex }: { trackIndex: number }) {
  const current = useBrowserStore(s => s.trackFilters[trackIndex]);
  const setTrackFilter = useBrowserStore(s => s.setTrackFilter);
  const darkMode = useBrowserStore(s => s.darkMode);
  const shown = current?.join(', ') ?? '';
  // The input follows the shared filter (another panel showing this track, or
  // Copilot, may change it); `draft` holds only what was typed here.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [shown]);
  const value = draft ?? shown;

  const applyFilter = useCallback(async () => {
    // Untouched: leaving the box must not overwrite the shared filter.
    if (draft === null) return;
    const names = draft.split(',').map(n => n.trim()).filter(Boolean);
    const filterNames = names.length > 0 ? names : null;
    setDraft(null);
    setTrackFilter(trackIndex, filterNames);
    await updateTrackFilter(trackIndex, filterNames);
  }, [draft, trackIndex, setTrackFilter]);

  return (
    <input
      type="text"
      value={value}
      onChange={e => setDraft(e.target.value)}
      placeholder="Filter names..."
      onKeyDown={e => { if (e.key === 'Enter') applyFilter(); }}
      onBlur={applyFilter}
      style={{
        position: 'absolute', top: 1, right: 4, width: 120, height: 16,
        fontSize: 9, padding: '0 4px', border: '1px solid',
        borderColor: darkMode ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
        borderRadius: 3, background: darkMode ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)',
        color: darkMode ? '#ccc' : '#333', outline: 'none', zIndex: 10,
      }}
    />
  );
}
