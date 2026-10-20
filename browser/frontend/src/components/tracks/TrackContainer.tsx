import { useShallow } from 'zustand/react/shallow';
import { PanelDisplayContext, panelReversed, usePanelDisplayStore } from '../../hooks/usePanelDisplayStore';
import { logicalOffset } from '../../utils/scaledCoordinates';
import React, { Suspense, useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { crosshairSegments, excludedRects, overlapsExcluded, type CrosshairSegment } from '../../utils/crosshairSegments';
import { useBrowserStore } from '../../stores/browserStore';
import { useEphemeralStore } from '../../stores/ephemeralStore';
import type { PanelConfig } from '../../types';
import { MainViewBar, PanelSiteBar, PANEL_SITE_BAR_HEIGHT } from './PanelSiteBar';
import { minimizedTrayShown } from './minimizedTray';
import { usePanelLauncherStore } from '../../stores/panelLauncherStore';
import { PanelHeader, PANEL_HEADER_HEIGHT } from './PanelHeader';
import { TrackContextMenuHost } from './TrackContextMenuHost';
import { getAnalysisPanel, getAnalysisPanelLabel } from '../../plugins/registry';
// DAF-C imports
import { useDafcStore } from '../../stores/dafcStore';
// Extracted sub-modules
import { TrackContainerSplitView } from './TrackContainerSplitView';
import { AnalysisPanelHeader, type DrawerDock } from './TrackContainerAnalysis';
import { TrackLabelsProvider } from './TrackLabels';
import { AnalysisStrip, ANALYSIS_STRIP_COLLAPSED_HEIGHT, ANALYSIS_STRIP_HEIGHT } from './AnalysisStrip';
import { useSubTrackDispatch, type PanelTrackLayout } from './SubTrackDispatch';
import { panelsAtMainKey, regionResolver, rulerRepeatsAbove } from '../../utils/panelRuler';
import { getTrackLabel } from './SubTrackMenu';
import { AXIS_HEIGHT } from './TrackContainerConstants';
import { getCatalog, catalogLoad, catalogLoadFailure, type Catalog, type CatalogGroup } from '../../api/catalog';
import { getDatasets } from '../../api/datasets';
import { WelcomeLibraryButton, WelcomeLoadFileButton, WelcomeReopenLastSessionButton, WelcomeTourButton } from '../controls/WelcomeLoadFileButton';
import { WelcomeDafRunButton } from '../controls/daf-run/DafRunEntryPoints';
import { openConnectCluster } from '../../utils/connectCluster';
import { isLabServerPage } from '../../utils/labServer';
import { isSandboxPage } from '../../utils/sandbox';
import { ChevronDown, ChevronLeft, ChevronRight, FolderOpen, PanelBeside, Sparkles, X } from '../ui/Icons';
import { SplitGroupStrip, SPLIT_STRIP_HEIGHT, splitStripSegments } from './SplitGroupStrip';
import { clampDrawerWidth, columnsLeftInDrawer, drawerRoom as drawerRoomFor, drawerRightOffset, DRAWER_MIN_WIDTH, flowResizePairs, headerInsetsUnderDrawer, overlayAllowed, overlayDropTarget, planRowLayout } from '../../utils/panelRowLayout';
import { DrawerResizeHandle } from './DrawerResizeHandle';
import { scrollRowsForOpened, useDrawerTabsStore } from '../../stores/drawerTabsStore';
import { activePanelId } from '../../utils/panelScope';
import { panelTitle } from '../../utils/panelTitle';
import { getDatasetDisplayLabel } from '../../utils/datasetLabels';
import { PANEL_ROW_CUE_BAND_HEIGHT, PanelRowScroller, workedPanelHandlers } from './PanelRowScroller';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { openCommandPalette } from '../../utils/commandPaletteStore';
import { runAppCommand } from '../../utils/appCommands';
import { launchOfferHidesWelcome, useLaunchUiStore } from '../../utils/launchSession';
import { useOpeningStore } from '../../stores/openingStore';
import { OpeningPanels } from './OpeningPanels';
import { PanelIcon } from '../ui/panelIcons';
import { panelFrameStyle, panelGap, roundedPanels } from '../../theme/uiTheme';

/** Catalog dataset picker for the onboarding empty state.
 *  Sets `hasCatalog` ref so the parent can hide the default "Load File" instructions. */
function OnboardingCatalog({ onHasCatalog }: { onHasCatalog?: (has: boolean) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [groups, setGroups] = useState<CatalogGroup[]>([]);
  const [loading, setLoading] = useState<Record<number, boolean>>({});

  useEffect(() => {
    getCatalog().then(res => {
      if (res.catalog) {
        setCatalog(res.catalog);
        setGroups(res.catalog.groups);
        onHasCatalog?.(true);
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!catalog) return null;

  const handleLoad = async (index: number) => {
    setLoading(prev => ({ ...prev, [index]: true }));
    try {
      const res = await catalogLoad(index);
      if (res.success) {
        setGroups(prev => prev.map((g, i) => i === index ? { ...g, loaded: true } : g));
        const dsRes = await getDatasets();
        const store = useBrowserStore.getState();
        store.setDatasets(dsRes.datasets);
        store.initModTypeDefaults();
        store.toggleModType('footprint' as any, true);
        store.toggleModType('nuc' as any, true);
        if (dsRes.datasets.some((d: any) => d.available_layers?.tf)) {
          store.toggleModType('tf' as any, true);
        }
        store.triggerRefresh();
      }
      const failure = catalogLoadFailure(res);
      if (failure) useBrowserStore.getState().setError(failure);
    } catch (err) {
      useBrowserStore.getState().setError(err instanceof Error ? err.message : 'Could not load the catalog group');
    }
    setLoading(prev => ({ ...prev, [index]: false }));
  };

  return (
    <div className="mb-4 text-left">
      <div className="text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-2">{catalog.name}</div>
      <div className="space-y-1.5">
        {groups.map((grp, i) => (
          <button
            key={i}
            onClick={() => !grp.loaded && handleLoad(i)}
            disabled={loading[i] || grp.loaded}
            className={`w-full text-left px-3 py-2 rounded border text-[12px] transition-colors ${
              grp.loaded
                ? 'border-green-300 bg-green-50 dark:bg-green-900/20 dark:border-green-700 text-green-700 dark:text-green-400'
                : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-600 dark:text-gray-400'
            } disabled:opacity-60`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{grp.name}</span>
              <span className="text-[11px] text-gray-400">
                {loading[i] ? 'loading...' : grp.loaded ? 'loaded' : `${grp.dataset_count} file${grp.dataset_count !== 1 ? 's' : ''}${grp.merge ? ' · merged' : ''}`}
              </span>
            </div>
            {grp.description && <div className="text-[11px] text-gray-400 mt-0.5">{grp.description}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Fills remaining space in a genome-only panel: drag-to-pan + onboarding hint. */
function GenomePanelSpacer() {
  const chrom = useBrowserStore(s => s.chrom);
  const start = useBrowserStore(s => s.start);
  const end = useBrowserStore(s => s.end);
  const isReversed = usePanelDisplayStore(s => s.isReversed);
  const panStartRef = useRef<{ x: number; start: number; end: number; width: number; renderedWidth: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    panStartRef.current = { x: e.clientX, start, end, width: e.currentTarget.clientWidth, renderedWidth: e.currentTarget.getBoundingClientRect().width };
    useEphemeralStore.getState().setIsPanning(true);
    useEphemeralStore.getState().setPanOffset(0);
    e.preventDefault();

    const onMove = (ev: MouseEvent) => {
      if (!panStartRef.current) return;
      const dx = logicalOffset(ev.clientX - panStartRef.current.x, panStartRef.current.width, panStartRef.current.renderedWidth);
      useEphemeralStore.getState().setPanOffset(dx);
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!panStartRef.current) return;
      const ref = panStartRef.current;
      panStartRef.current = null;
      useEphemeralStore.getState().setIsPanning(false);

      const dx = logicalOffset(ev.clientX - ref.x, ref.width, ref.renderedWidth);
      const viewportWidth = ref.width;
      const bpPerPixel = (ref.end - ref.start) / viewportWidth;
      const bpShift = Math.round(-dx * bpPerPixel) * (isReversed ? -1 : 1);
      if (Math.abs(dx) > 3) {
        useBrowserStore.getState().setViewport(chrom, ref.start + bpShift, ref.end + bpShift);
      }
      useEphemeralStore.getState().setPanOffset(0);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [chrom, start, end, isReversed]);

  return (
    <div
      data-genome-spacer
      className="flex-1 flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
      style={{ minHeight: 80 }}
      onMouseDown={handleMouseDown}
    >
      <div className="text-center px-6 max-w-lg">
        <div className="pointer-events-auto mb-3">
          <OnboardingCatalog />
        </div>
        <EmptyReadsPrompt />
        <p className="text-[12px] text-gray-400 dark:text-gray-500 mb-2 pointer-events-none">Drag here to pan.</p>
      </div>
    </div>
  );
}

/**
 * The reads area with no dataset: one empty-state sentence, the same in every panel (usability round 3, R12), and the
 * toolbar's Open beside it. Public mode opens no local files: only the pan hint shows.
 */
export const EMPTY_READS_TEXT = 'Open a BAM or choose one in the Library';

function EmptyReadsPrompt() {
  const publicMode = useBrowserStore(s => s.publicMode);
  if (publicMode) return null;
  return (
    // The spacer pans on a drag: a press on the prompt is not one.
    <div className="pointer-events-auto mb-2 flex flex-wrap items-center justify-center gap-2" data-testid="empty-reads-prompt"
      onMouseDown={e => e.stopPropagation()}>
      <span className="text-sm text-ink-muted">{EMPTY_READS_TEXT}</span>
      {/* The toolbar's Open (File > Open File), so both say the same while it opens. */}
      <button type="button" className="fb-btn-secondary h-[28px] px-2.5 text-[12px]" onClick={() => { runAppCommand('open-file'); }}
        data-testid="empty-reads-open">
        <FolderOpen size={14} aria-hidden="true" />Open
      </button>
    </div>
  );
}

/** Drag-to-pan spacer for split view panels without a read track. */
function SplitViewSpacer({ panelId, viewport }: { panelId: string; viewport: { chrom: string; start: number; end: number } }) {
  const reversed = useBrowserStore(s => panelReversed(s, panelId));
  const panStartRef = useRef<{ x: number; start: number; end: number; width: number; renderedWidth: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    panStartRef.current = { x: e.clientX, start: viewport.start, end: viewport.end, width: e.currentTarget.clientWidth, renderedWidth: e.currentTarget.getBoundingClientRect().width };
    e.preventDefault();

    const onMove = (ev: MouseEvent) => {
      if (!panStartRef.current) return;
      const dx = logicalOffset(ev.clientX - panStartRef.current.x, panStartRef.current.width, panStartRef.current.renderedWidth);
      // Use ephemeral pan offset for smooth visual feedback isn't possible per-panel,
      // so we just update the viewport on release
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!panStartRef.current) return;
      const ref = panStartRef.current;
      panStartRef.current = null;
      const dx = logicalOffset(ev.clientX - ref.x, ref.width, ref.renderedWidth);
      const viewportWidth = ref.width;
      const bpPerPixel = (ref.end - ref.start) / viewportWidth;
      const bpShift = Math.round(-dx * bpPerPixel) * (reversed ? -1 : 1);
      if (Math.abs(dx) > 3) {
        useBrowserStore.getState().setPanelViewport(panelId, ref.start + bpShift, ref.end + bpShift);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelId, viewport.start, viewport.end, reversed]);

  return (
    <div
      data-split-spacer
      className="flex-1 cursor-grab active:cursor-grabbing select-none flex items-center justify-center"
      style={{ minHeight: 40 }}
      onMouseDown={handleMouseDown}
    >
      <div className="text-center">
        <EmptyReadsPrompt />
        <span className="text-[11px] text-gray-300 dark:text-gray-600 pointer-events-none">Drag to pan</span>
      </div>
    </div>
  );
}

/** Blue vertical insertion indicator shown during panel drag. */
function DropIndicatorLine({ left, height, label }: { left: number; height: number; label?: string }) {
  return (
    <div
      className="absolute top-0 pointer-events-none z-40"
      data-testid="panel-drop-indicator"
      data-label={label}
      style={{
        left,
        width: 3,
        height,
        backgroundColor: '#3b82f6',
        borderRadius: 2,
        boxShadow: '0 0 6px rgba(59,130,246,0.5)',
        transition: 'left 0.15s ease',
      }}
    >
      {label && (
        <span className="absolute left-1/2 top-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-blue-500 px-2 py-0.5 text-[11px] font-medium text-white shadow-md">
          {label}
        </span>
      )}
    </div>
  );
}

/** Horizontal blue line indicating "new row will be created below this row". */
function HorizontalDropIndicator() {
  return (
    <div
      className="absolute left-0 right-0 bottom-0 pointer-events-none z-10"
      style={{
        height: 3,
        backgroundColor: '#3b82f6',
        borderRadius: 2,
        boxShadow: '0 0 6px rgba(59,130,246,0.5)',
      }}
    />
  );
}

/** Compute the X position for the drop indicator line given column widths and a slot index. */
function computeIndicatorX(widths: number[], insertBefore: number): number {
  let x = 0;
  for (let i = 0; i < insertBefore && i < widths.length; i++) {
    x += widths[i];
  }
  return Math.max(0, x - 1); // center the 3px line on the edge
}

function computeResizeHandleX(widths: number[], colIdx: number): number {
  let x = 0;
  for (let i = 0; i <= colIdx && i < widths.length; i++) {
    x += widths[i];
  }
  return x;
}

const HIDDEN_SUBTRACK_STRIP_HEIGHT = 24;
const MIN_READ_TRACK_HEIGHT = 120;
/** Room a header bar needs for its name and controls (Clean view, ⋯) beside the drawer. */
const HEADER_CONTROLS_MIN_WIDTH = 160;

/** The tab row of a drawer holding several side panels. */
const DRAWER_TABS_HEIGHT = 34;

function HiddenSubTrackStrip({ panel }: { panel: PanelConfig }) {
  const hiddenTracks = panel.subTracks.filter(track => !track.visible && !track.removed);

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-2 text-[11px] dark:border-white/10 dark:bg-white/[0.035]"
      data-testid={`hidden-track-strip-${panel.id}`}
      style={{ height: HIDDEN_SUBTRACK_STRIP_HEIGHT, flexShrink: 0 }}
    >
      <span className="shrink-0 text-gray-400 dark:text-gray-500">Minimized tracks:</span>
      {hiddenTracks.map(track => (
        <button
          key={track.type}
          type="button"
          data-testid={`hidden-track-restore-${track.type}`}
          onClick={(e) => useBrowserStore.getState().toggleSubTrack(panel.id, track.type, e.altKey)}
          className="shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] leading-none text-slate-600 shadow-sm hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300 dark:hover:border-blue-500/60 dark:hover:bg-blue-950/40 dark:hover:text-blue-200"
          title={`Restore ${getTrackLabel(track.type)} in all panels (Option/Alt-click: this panel only)`}
        >
          + {getTrackLabel(track.type)}
        </button>
      ))}
    </div>
  );
}

/** Group row panels into columns. Panels sharing the same layoutColumn stack vertically. */
interface ColumnGroup { column: number; panels: PanelConfig[] }
function groupByColumns(rowPanels: PanelConfig[]): ColumnGroup[] {
  const groups: ColumnGroup[] = [];
  const colToIdx = new Map<number, number>(); // layoutColumn → group index
  let nextImplicit = -1;
  for (const p of rowPanels) {
    const col = p.layoutColumn;
    if (col != null && colToIdx.has(col)) {
      groups[colToIdx.get(col)!].panels.push(p);
    } else {
      const c = col ?? nextImplicit--;
      colToIdx.set(c, groups.length);
      groups.push({ column: c, panels: [p] });
    }
  }
  return groups;
}

interface Props {
  onScanPeaks?: () => void;
  scanning?: boolean;
}

export function TrackContainer({ onScanPeaks, scanning }: Props) {
  const matchedPanelIds = useBrowserStore(useShallow(s => s.peakRules.filter(r => r.matchGroup?.origin === 'sv')
    .flatMap(r => (s.peaksByRule[r.id] ?? []).flatMap(p => p.match?.panelId ? [p.match.panelId] : []))));
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const datasets = useBrowserStore(s => s.datasets);
  // Not while the launch offer is being decided or a session is being restored (no flash over a dataset).
  const launchOfferUp = useLaunchUiStore(launchOfferHidesWelcome);
  // A dataset being opened shows its placeholder panel, not the Welcome card over it.
  const openingAny = useOpeningStore(s => s.opening.length > 0);
  // Welcome-popup dismissal: sessionStorage-persisted so once the user
  // closes it (e.g. to access the empty browser for PCR primer design)
  // it stays closed for the rest of the session. Comes back on next
  // tab/window open.
  // A tour tab never shows it: the tour loads the demo itself.
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(() => {
    if (isSandboxPage()) return true;
    try { return window.sessionStorage.getItem('fiberhmm_welcome_dismissed') === '1'; }
    catch { return false; }
  });
  const dismissWelcome = useCallback(() => {
    setWelcomeDismissed(true);
    try { window.sessionStorage.setItem('fiberhmm_welcome_dismissed', '1'); } catch {}
  }, []);
  const welcomeShown = datasets.length === 0 && !welcomeDismissed && !launchOfferUp && !openingAny;
  // A modal dialog (N12): Escape dismisses it (unless a dialog it opened, the Library, is over it), focus goes in on
  // open and back where it was on dismissal. Being modal, it holds back the browser's shortcuts, except two that
  // still make sense over it: Cmd/Ctrl+K opens the command palette (dismissing the card first), and Undo/Redo
  // (Cmd/Ctrl+Z, +Shift) still work, so closing the last dataset can be undone from here.
  const welcomeRef = useRef<HTMLDivElement>(null);
  const dismissWelcomeByUser = useDismissableDialog(welcomeRef, welcomeShown, dismissWelcome, (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
    const key = e.key.toLowerCase();
    if (key === 'z') return runAppCommand(e.shiftKey ? 'redo' : 'undo') !== false;
    if (key !== 'k' || e.shiftKey) return false;
    dismissWelcome();
    openCommandPalette();
    return true;
  // Dismissed on first launch (no opener to go back to): the toolbar's Open, else the toolbar's first control (B4).
  }, ['[data-testid="load-file-button"]', '[data-testid="top-nav"]']);
  // Update-available banner: ask the backend (which caches a 1-hour
  // GitHub Releases probe) whether a newer FiberBrowser tag exists.
  // Fetched once on welcome-popup mount; the banner is purely
  // informational, so any network failure silently leaves it hidden.
  const [versionInfo, setVersionInfo] = useState<{
    current: string;
    latest: string | null;
    update_available: boolean;
    release_url: string | null;
    release_name: string | null;
  } | null>(null);
  useEffect(() => {
    if (datasets.length > 0 || welcomeDismissed) return;
    let cancelled = false;
    fetch('/api/version', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled && data) setVersionInfo(data); })
      .catch(() => { /* offline / unreachable — leave banner hidden */ });
    return () => { cancelled = true; };
  }, [datasets.length, welcomeDismissed]);
  const chroms = useBrowserStore(s => s.chroms);
  const viewMode = useBrowserStore(s => s.viewMode);
  const crosshairX = useEphemeralStore(s => s.crosshairX);
  const crosshairLabel = useEphemeralStore(s => s.crosshairLabel);
  const crosshairBottom = useEphemeralStore(s => s.crosshairBottom);
  // The crosshair's label goes just under the top row's ruler, as measured (the first read panel's): a scrolling
  // row's chip band, split strips, a site bar or a hidden-track strip push it down (Codex review, round 3).
  const [crosshairLabelTop, setCrosshairLabelTop] = useState<number | null>(null);
  const crosshairLabelShown = crosshairLabel != null;
  useLayoutEffect(() => {
    const c = containerRef.current;
    const panel = c?.querySelector<HTMLElement>('[data-panel-id]');
    if (!crosshairLabelShown || !c || !panel) { setCrosshairLabelTop(null); return; }
    const box = c.getBoundingClientRect();
    const zoom = c.offsetWidth > 0 && box.width > 0 ? box.width / c.offsetWidth : 1;
    // The ruler itself (a site bar or a hidden-track strip can come before it), else from the panel's top.
    const ruler = panel.querySelector<HTMLElement>('[data-testid="axis-ruler"]');
    const below = ruler ? ruler.getBoundingClientRect().bottom : panel.getBoundingClientRect().top + (PANEL_HEADER_HEIGHT + AXIS_HEIGHT) * zoom;
    setCrosshairLabelTop((below - box.top) / zoom + c.scrollTop + 2);
  }, [crosshairLabelShown]);
  // The crosshair is cut around panels with coordinates of their own (utils/crosshairSegments.ts); null: none here.
  const stripHeightRef = useRef(0);
  const [crosshairCuts, setCrosshairCuts] = useState<{ segments: CrosshairSegment[]; labelHidden: boolean } | null>(null);
  const crosshairShown = crosshairX !== null;
  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!crosshairShown || !c) { setCrosshairCuts(null); return; }
    const excluded = excludedRects(c);
    if (!excluded.length) { setCrosshairCuts(null); return; }
    const top = stripHeightRef.current;
    const bottom = crosshairBottom ?? c.scrollHeight;
    const segments = crosshairSegments(crosshairX!, top, bottom, excluded);
    const labelTop = crosshairLabelTop ?? top;
    const labelLeft = Math.min(crosshairX! + 8, c.offsetWidth - 120);
    const labelHidden = overlapsExcluded({ left: labelLeft, right: labelLeft + 120, top: labelTop, bottom: labelTop + 20 }, excluded);
    setCrosshairCuts({ segments, labelHidden });
  }, [crosshairShown, crosshairX, crosshairBottom, crosshairLabelTop]);
  const panels = useBrowserStore(s => s.panels);
  const fullViewPanelId = useBrowserStore(s => s.fullViewPanelId);
  const showHiddenTrackStrip = useBrowserStore(s => s.showHiddenTrackStrip);
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  const uiScale = useBrowserStore(s => s.uiScale);
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);
  const selectedDatasets = useBrowserStore(s => s.selectedDatasets);
  const publicMode = useBrowserStore(s => s.publicMode);
  const reversedState = useBrowserStore(useShallow(s => ({ panels: s.panels, navigationMode: s.navigationMode, isReversed: s.isReversed })));

  // DAF-C state
  const dafcLoaded = useDafcStore(s => s.dafcLoaded);

  useLayoutEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);

    const observer = new ResizeObserver(updateDimensions);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateDimensions);
      observer.disconnect();
    };
  }, [uiScale, viewMode, refreshGeneration]);

  // Auto-initialize panels from datasets if not yet done,
  // or create a genome-only panel if no datasets but genome is loaded
  // (must be before conditional returns to satisfy React Rules of Hooks)
  useEffect(() => {
    if (panels.length === 0 && datasets.length > 0) {
      useBrowserStore.getState().initPanelsFromDatasets();
    } else if (panels.length === 0 && datasets.length === 0 && chroms.length > 0) {
      useBrowserStore.getState().initGenomePanel();
    }
  }, [panels.length, datasets.length, chroms.length]);

  // Row layout state
  const collapsedRows = useBrowserStore(s => s.collapsedRows);
  const analysisStripCollapsed = useBrowserStore(s => s.analysisStripCollapsed);
  // Rail mode: the panel launchers are in the sidebar rail; no strip row above the reads.
  const railMode = usePanelLauncherStore(s => s.mode) === 'rail';

  // Separate panels into visible set, then group by layoutRow
  const visiblePanels = useMemo(() =>
    fullViewPanelId
      ? panels.filter(p => p.id === fullViewPanelId)
      : panels.filter(p => !p.collapsed),
    [panels, fullViewPanelId]
  );

  const rowGroups = useMemo(() => {
    const groups = new Map<number, PanelConfig[]>();
    for (const p of visiblePanels) {
      const row = p.layoutRow ?? (p.layoutPosition === 'column' ? 1 : 0);
      if (!groups.has(row)) groups.set(row, []);
      groups.get(row)!.push(p);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([rowIndex, rowPanels]) => ({ rowIndex, panels: rowPanels }));
  }, [visiblePanels]);

  // Drag state for panel reordering
  const [dragPanelIdx, setDragPanelIdx] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    rowIndex: number;
    insertBefore: number;
    newRowAfter?: number;       // create a new row after this row index
    stackColumnIndex?: number;  // stack below the bottom panel of this column
    drawer?: boolean;           // over the drawer of side panels (not the row under it)
  } | null>(null);

  const handlePanelDragStart = useCallback((e: React.DragEvent, idx: number) => {
    setDragPanelIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  }, []);

  const STACK_ZONE_PX = 40; // bottom N pixels of a row trigger stack / new-row
  const BOUNDARY_SNAP_PX = 20; // pixels near a column boundary that trigger "new row" instead of "stack"

  const handleRowDragOver = useCallback((e: React.DragEvent, rowIndex: number, colWidths: number[]) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragPanelIdx === null) return;

    const rowRect = e.currentTarget.getBoundingClientRect();
    const mouseY = logicalOffset(e.clientY - rowRect.top, e.currentTarget.clientHeight, rowRect.height);
    const mouseX = logicalOffset(e.clientX - rowRect.left, e.currentTarget.clientWidth, rowRect.width);

    // Bottom zone → stack in column, or new row if near column boundary
    if (mouseY > e.currentTarget.clientHeight - STACK_ZONE_PX) {
      // Check if cursor is near a column boundary
      let accX = 0;
      let nearBoundary = false;
      for (let i = 0; i < colWidths.length - 1; i++) {
        accX += colWidths[i];
        const handleCenter = accX;
        if (Math.abs(mouseX - handleCenter) < BOUNDARY_SNAP_PX) {
          nearBoundary = true;
          break;
        }
      }

      if (nearBoundary) {
        // New row below this row
        setDropTarget(prev => {
          if (prev?.newRowAfter === rowIndex && !prev.drawer) return prev;
          return { rowIndex, insertBefore: 0, newRowAfter: rowIndex };
        });
      } else {
        // Stack in the column the cursor is over
        let colIdx = colWidths.length - 1;
        accX = 0;
        for (let i = 0; i < colWidths.length; i++) {
          accX += colWidths[i];
          if (mouseX < accX) { colIdx = i; break; }
        }
        setDropTarget(prev => {
          if (prev?.rowIndex === rowIndex && prev?.stackColumnIndex === colIdx && !prev.drawer) return prev;
          return { rowIndex, insertBefore: 0, stackColumnIndex: colIdx };
        });
      }
      return;
    }

    // Upper zone → insert between columns
    let accX = 0;
    let insertBefore = colWidths.length;
    for (let i = 0; i < colWidths.length; i++) {
      const pw = colWidths[i];
      if (mouseX < accX + pw / 2) { insertBefore = i; break; }
      accX += pw;
    }

    setDropTarget(prev => {
      if (prev?.rowIndex === rowIndex && prev?.insertBefore === insertBefore
          && prev?.newRowAfter == null && prev?.stackColumnIndex == null && !prev.drawer) return prev;
      return { rowIndex, insertBefore };
    });
  }, [dragPanelIdx]);

  const handleUnifiedDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (dragPanelIdx === null || !dropTarget) {
      setDragPanelIdx(null); setDropTarget(null); return;
    }
    const panel = panels[dragPanelIdx];
    if (!panel) { setDragPanelIdx(null); setDropTarget(null); return; }

    const store = useBrowserStore.getState();
    // A side panel in the drawer dropped on the row comes out of the drawer, at the drop (as "Dock beside the reads",
    // but there); a panel of the row dropped on the drawer goes into it (as "Pin to the side"). The other panels keep
    // their widths (dockPanelAt).
    const inDrawer = panel.contentType !== 'dataset' && panel.dock === 'side' && useDrawerTabsStore.getState().inDrawer.includes(panel.id);
    const columnStart = (index: number) => {
      const group = rowGroups.find(g => g.rowIndex === dropTarget.rowIndex);
      const cols = group ? groupByColumns(group.panels) : [];
      for (const col of cols.slice(index)) {
        const first = col.panels.find(p => p.id !== panel.id);
        if (first) return first.id;
      }
      return null;
    };
    if (dropTarget.drawer ? !inDrawer && panel.contentType !== 'dataset' : inDrawer) {
      // out of the drawer onto a new row or under another panel: the move and the dock are one undo step
      const stackUnder = !dropTarget.drawer && dropTarget.stackColumnIndex != null ? (() => {
        const group = rowGroups.find(g => g.rowIndex === dropTarget.rowIndex);
        const col = group ? groupByColumns(group.panels)[dropTarget.stackColumnIndex!] : null;
        return col ? col.panels[col.panels.length - 1].id : null;
      })() : null;
      const place = dropTarget.drawer ? undefined
        : dropTarget.newRowAfter != null ? { newRowAfter: dropTarget.newRowAfter }
          : stackUnder && stackUnder !== panel.id ? { stackBelow: stackUnder } : undefined;
      store.dockPanelAt(panel.id, dropTarget.rowIndex, dropTarget.drawer ? null : columnStart(dropTarget.insertBefore), dropTarget.drawer ? 'side' : 'beside', place);
      setDragPanelIdx(null); setDropTarget(null);
      return;
    }
    if (dropTarget.newRowAfter != null) {
      store.insertPanelAsNewRow(panel.id, dropTarget.newRowAfter);
    } else if (dropTarget.stackColumnIndex != null) {
      // Stack below the bottom panel of the target column
      const group = rowGroups.find(g => g.rowIndex === dropTarget.rowIndex);
      if (group) {
        const columns = groupByColumns(group.panels);
        const targetCol = columns[dropTarget.stackColumnIndex];
        if (targetCol) {
          const bottomPanel = targetCol.panels[targetCol.panels.length - 1];
          store.stackPanelBelow(panel.id, bottomPanel.id);
        }
      }
    } else {
      store.movePanelToRow(panel.id, dropTarget.rowIndex, dropTarget.insertBefore);
    }
    useBrowserStore.getState().removeEmptyRows();
    setDragPanelIdx(null); setDropTarget(null);
  }, [dragPanelIdx, dropTarget, panels, rowGroups]);

  const handlePanelDragEnd = useCallback(() => {
    setDragPanelIdx(null);
    setDropTarget(null);
  }, []);

  // Sub-track rendering via extracted hook
  const { renderSubTrack, calcFixedHeight } = useSubTrackDispatch({ onScanPeaks, scanning });
  // One coordinate ruler per stack of panels at the same region (utils/panelRuler).
  const panelsAtMain = useBrowserStore(s => panelsAtMainKey(s.panels, s));
  const regionOfPanel = useMemo(() => regionResolver(panelsAtMain), [panelsAtMain]);
  // A panel's short name (its header title's first part: "Carriers", "N2", "Footprints"), for the row's edge cues.
  const panelShortName = useCallback((id: string) => {
    const panel = panels.find(p => p.id === id);
    if (!panel) return 'Panel';
    if (panel.contentType !== 'dataset') return getAnalysisPanelLabel(panel.contentType, true);
    const ds = datasets.find(d => d.id === panel.datasetId);
    return panelTitle(panel, ds ? getDatasetDisplayLabel(ds) : panel.datasetId ?? 'Panel').primary;
  }, [panels, datasets]);

  // Rounded panels sit apart as cards: `gap` px around and between them
  // (UI_THEME.panelShape in theme/uiTheme.ts; figure renders stay edge to edge).
  const rounded = roundedPanels();
  const gap = panelGap();
  // Narrow window: side panels slide over the reads; this tucks them away for a look underneath.
  const [overlayTucked, setOverlayTucked] = useState(false);
  // The drawer's tabs (one side panel at a time when it holds several): which one shows, per row.
  const drawerActive = useDrawerTabsStore(s => s.active);
  // The drawer's width as the user resized it (null: the default).
  const drawerPreferredWidth = useDrawerTabsStore(s => s.width);
  const overlayIdsByRow = useRef<Record<number, { ids: string[]; active: string }>>({});
  const previousOverlayIds = useRef<Record<number, string[]>>({});
  overlayIdsByRow.current = {};
  useEffect(() => {
    const store = useDrawerTabsStore.getState();
    const hidden: Record<string, number> = {};
    for (const [rowKey, { ids, active }] of Object.entries(overlayIdsByRow.current)) {
      const row = Number(rowKey);
      // A panel that has just come to the drawer (opened, pinned, or squeezed out) shows.
      const before = previousOverlayIds.current[row] ?? [];
      const added = ids.filter(id => !before.includes(id));
      const shown = added.length > 0 ? added[added.length - 1] : active;
      if (shown !== store.active[row]) store.setActive(row, shown);
      for (const id of ids) if (id !== shown) hidden[id] = row;
    }
    // Remember rows that have a drawer now; a row without one (an export or full
    // view lays every panel out in the row for a moment) keeps what it had, so
    // the drawer comes back on the same tab.
    for (const [row, v] of Object.entries(overlayIdsByRow.current)) previousOverlayIds.current[Number(row)] = v.ids;
    store.setHidden(hidden);
    store.setInDrawer(Object.values(overlayIdsByRow.current).flatMap(v => v.ids));
  });
  // A panel brought forward (strip chip, tab, a newly opened panel) or asked for again
  // (Edit filters… on the drawer's active tab) shows: the drawer slides back out.
  const drawerReveals = useDrawerTabsStore(s => s.revealCount);
  useEffect(() => { setOverlayTucked(false); }, [drawerActive, drawerReveals]);
  // Panels just opened in a row that scrolls sideways (a side panel at the row's end, split panels, reference copies):
  // the row scrolls only as far as needed to show them, and keeps the panel the user works in when both fit (N4,
  // stores/drawerTabsStore.ts scrollRowsForOpened). Not when the first panels appear (a session opening: the row starts
  // at its left).
  const shownPanelIds = panels.filter(p => !p.collapsed).map(p => p.id).join(',');
  const previousShownIds = useRef<string[]>([]);
  useEffect(() => {
    const ids = shownPanelIds ? shownPanelIds.split(',') : [];
    const before = previousShownIds.current;
    previousShownIds.current = ids;
    const added = ids.filter(id => !before.includes(id));
    if (!added.length || !before.length) return;
    requestAnimationFrame(() => scrollRowsForOpened(added, activePanelId(useBrowserStore.getState())));
  }, [shownPanelIds]);
  // A panel just pinned to the side shows (the drawer slides out).
  const pinnedPanelIds = panels.filter(p => p.dock === 'side').map(p => p.id).join(',');
  useEffect(() => { if (pinnedPanelIds) setOverlayTucked(false); }, [pinnedPanelIds]);

  // Render a single panel column
  const renderPanel = useCallback((
    panel: PanelConfig,
    panelIndex: number,
    panelWidth: number,
    panelHeight: number,
    isFirstPanel: boolean,
    alignLocusBar = false,
    trackLayout?: PanelTrackLayout,
    drawerCover = 0,
    drawer: DrawerDock | null = null,
  ) => {
    const isDragging = dragPanelIdx === panelIndex;
    // A header bar beside the side-panel drawer (a lower stacked panel): its controls move
    // left of the drawer; with too little left of it, the bar goes over the drawer instead.
    const headerOverDrawer = drawerCover > 0 && panelWidth - drawerCover < HEADER_CONTROLS_MIN_WIDTH;
    const headerInset = headerOverDrawer ? 0 : drawerCover;
    const isPanelSelected = selectedDatasets.has(panel.id);

    // Analysis panels -- resolved via plugin registry
    if (panel.contentType !== 'dataset') {
      const plugin = getAnalysisPanel(panel.contentType);
      const headerColor = plugin?.headerColor ?? '#666';
      const label = plugin?.label ?? panel.contentType;
      const isFullView = fullViewPanelId === panel.id;
      const narrowAnalysis = panelWidth < 200;
      // Too narrow to be usable: offer Maximize instead of squashed controls.
      const tooNarrow = !isFullView && panelWidth < (plugin?.minUsableWidth ?? 240);
      return (
        <div
          key={panel.id}
          className="flex flex-col"
          data-panel-content-type={panel.contentType}
          data-analysis-panel-id={panel.id}
          {...(plugin?.bodyLayout === 'fill' ? { 'data-crosshair-exclude': 'true' } : {})}
          style={{
            width: panelWidth,
            height: panelHeight,
            opacity: isDragging ? 0.5 : 1,
            ...(rounded ? panelFrameStyle(headerColor) : { borderRight: '1px solid #e5e7eb' }),
          }}
        >
          <div data-panel-header style={headerOverDrawer ? { position: 'relative', zIndex: 31 } : headerInset > 0 ? { paddingRight: headerInset } : undefined}>
          <AnalysisPanelHeader
            panel={panel}
            panelIndex={panelIndex}
            headerColor={headerColor}
            label={label}
            isFullView={isFullView}
            narrow={narrowAnalysis || panelWidth - headerInset < 200}
            drawer={drawer}
            onDragStart={handlePanelDragStart}
            onDragEnd={handlePanelDragEnd}
            onFullView={() => useBrowserStore.getState().setFullViewPanel(isFullView ? null : panel.id)}
            onClose={() => useBrowserStore.getState().closeAnalysisPanel(panel.id)}
          />
          </div>
          <div style={{ height: panelHeight - PANEL_HEADER_HEIGHT, overflow: plugin?.bodyLayout === 'fill' ? 'hidden' : 'auto', minHeight: 0 }} className="bg-white dark:bg-dark-bg">
            {tooNarrow && (
              <div data-testid="panel-too-narrow" className="flex h-full flex-col items-center justify-center gap-2 p-2 text-center text-[11px] text-gray-500 dark:text-gray-400">
                <span className="font-medium text-gray-700 dark:text-gray-200">{label}</span>
                <span>Too narrow to use here.</span>
                <button
                  type="button"
                  onClick={() => useBrowserStore.getState().setFullViewPanel(panel.id)}
                  className="rounded px-2 py-1 text-white hover:opacity-90"
                  style={{ backgroundColor: headerColor }}
                >
                  Maximize
                </button>
              </div>
            )}
            {/* Stays mounted while too narrow, so the panel keeps its state. */}
            <div className={tooNarrow ? 'hidden' : 'contents'} hidden={tooNarrow}>
            {(() => {
              if (!plugin) return null;
              const PanelComponent = plugin.component;
              return (
                <PanelDisplayContext.Provider value={panel.id}>
                  <Suspense fallback={<div className="p-4 text-sm text-gray-400">Loading...</div>}>
                    <PanelComponent isFullView={isFullView} panelId={panel.id} width={panelWidth}
                      height={Math.max(0, panelHeight - PANEL_HEADER_HEIGHT)} />
                  </Suspense>
                </PanelDisplayContext.Provider>
              );
            })()}
            </div>
          </div>
        </div>
      );
    }

    // Dataset panel
    const datasetColor = datasets.find(d => d.id === panel.datasetId)?.color ?? '#4b5563';
    const hasHiddenSubTracks = !exportInProgress && showHiddenTrackStrip && panels.some(p => !p.collapsed && p.subTracks.some(track => !track.visible && !track.removed));
    const fixedH = calcFixedHeight(panel, trackLayout) + (hasHiddenSubTracks ? HIDDEN_SUBTRACK_STRIP_HEIGHT : 0)
      + (panel.viewportOverride || alignLocusBar ? PANEL_SITE_BAR_HEIGHT : 0);
    // Keep reads usable when fixed tracks outgrow a short panel; the panel
    // scrolls instead of collapsing the read track to zero height.
    const readHeight = Math.max(MIN_READ_TRACK_HEIGHT, panelHeight - fixedH);
    // (the site bar of a panel with its own view is part of the fixed height)

    return (
      <div
        key={panel.id}
        data-panel-id={panel.id}
        onMouseEnter={() => { if (panel.regionPanelGroup) useEphemeralStore.setState({ hoveredMatchGroup: null, hoveredPanelRegion: { groupId: panel.regionPanelGroup.id, label: panel.regionPanelGroup.regionLabel } }); }}
        onMouseLeave={() => { if (panel.regionPanelGroup) useEphemeralStore.setState({ hoveredMatchGroup: null, hoveredPanelRegion: null }); }}
        style={{
          width: panelWidth,
          height: panelHeight,
          ...(rounded ? panelFrameStyle(datasetColor) : { borderRight: '1px solid #e5e7eb' }),
          overflowY: 'auto',
          overflowX: 'hidden',
          opacity: isDragging ? 0.5 : 1,
        }}
        // The read canvas stays light in dark mode: so does the panel behind its tracks,
        // or the page shows through as dark bands between light rows (audit M29).
        className="flex flex-col bg-white"
      >
        <PanelDisplayContext.Provider value={panel.id}>
        <PanelHeader
          panel={panel}
          panelIndex={panelIndex}
          isSelected={isPanelSelected}
          narrow={panelWidth - headerInset < 200}
          width={panelWidth}
          insetRight={headerInset}
          overDrawer={headerOverDrawer}
          onDragStart={handlePanelDragStart}
          onDragEnd={handlePanelDragEnd}
        />
        {hasHiddenSubTracks && <HiddenSubTrackStrip panel={panel} />}
        {panel.viewportOverride && <PanelSiteBar panel={panel} />}
        {!panel.viewportOverride && alignLocusBar && <MainViewBar />}
        <TrackLabelsProvider showLabels={Boolean(panel.showTrackLabels)}>
          {panel.subTracks.map((track, trackIdx) =>
            renderSubTrack(track, trackIdx, panel, panelWidth, readHeight, isFirstPanel, trackLayout)
          )}
        </TrackLabelsProvider>
        {/* Fill remaining space with drag-to-pan for panels without a read track */}
        {!panel.datasetId && !panel.viewportOverride && <GenomePanelSpacer />}
        {panel.viewportOverride && !panel.datasetId && <SplitViewSpacer panelId={panel.id} viewport={panel.viewportOverride} />}
        </PanelDisplayContext.Provider>
      </div>
    );
  }, [calcFixedHeight, dragPanelIdx, selectedDatasets,
      handlePanelDragStart, handlePanelDragEnd, renderSubTrack,
      fullViewPanelId, exportInProgress, datasets, panels, showHiddenTrackStrip, rounded]);

  // Calculate layout -- panels grouped by layoutRow
  const ROW_COLLAPSE_BAR_HEIGHT = 20;
  // A row that scrolls sideways keeps this much under its panels for the scrollbar.
  const ROW_SCROLLBAR_ALLOWANCE = 12;
  const MINIMIZED_BAR_HEIGHT = 34;
  // Minimized dataset panels are strip buttons; this tray only while the strip is folded.
  // (Rail mode: minimized datasets are tiles in the rail, PanelRail.)
  const hasMinimized = !railMode && minimizedTrayShown(panels, analysisStripCollapsed);


  // Height distribution: divide among expanded rows equally
  const expandedRowCount = rowGroups.filter(g => !collapsedRows.has(g.rowIndex)).length;
  const collapsedBarTotal = rowGroups.filter(g => collapsedRows.has(g.rowIndex)).length * ROW_COLLAPSE_BAR_HEIGHT;
  const expandedBarTotal = expandedRowCount * ROW_COLLAPSE_BAR_HEIGHT;
  const isRenderMode = typeof window !== 'undefined' && !!window.__FIBERBROWSER_RENDER_MODE;
  const stripHeight = isRenderMode || railMode ? 0 : analysisStripCollapsed ? ANALYSIS_STRIP_COLLAPSED_HEIGHT : ANALYSIS_STRIP_HEIGHT;
  stripHeightRef.current = stripHeight;
  const reservedHeight = stripHeight + collapsedBarTotal + expandedBarTotal + (hasMinimized ? MINIMIZED_BAR_HEIGHT : 0) + gap;
  const rowHeight = expandedRowCount > 0
    ? Math.max(200, Math.floor((dimensions.height - reservedHeight) / expandedRowCount))
    : dimensions.height - reservedHeight;

  // Panel resize state + handlers
  const panelResizeRef = useRef<{
    rowIndex: number;
    leftIdx: number;
    startX: number;
    startLeftFraction: number;
    startRightFraction: number;
    totalSize: number;
  } | null>(null);

  const startColumnResize = useCallback((e: React.MouseEvent, colIdx: number, columns: ColumnGroup[], rightIdx = colIdx + 1, totalOverride?: number) => {
    e.preventDefault();
    const leftCol = columns[colIdx];
    const rightCol = columns[rightIdx];
    if (!leftCol || !rightCol) return;

    const n = columns.length;
    const defaultFrac = 1 / n;
    const leftFrac = leftCol.panels[0]?.widthFraction ?? defaultFrac;
    const rightFrac = rightCol.panels[0]?.widthFraction ?? defaultFrac;
    const dividerSpace = gap * (n + 1);
    const totalSize = totalOverride ?? dimensions.width - dividerSpace;

    // Store the panel IDs for the first panel in each column (controls the width)
    const leftId = leftCol.panels[0]?.id;
    const rightId = rightCol.panels[0]?.id;
    if (!leftId || !rightId) return;

    const resizeRatio = logicalOffset(1, e.currentTarget.clientHeight, e.currentTarget.getBoundingClientRect().height);
    panelResizeRef.current = {
      rowIndex: 0, // not used for column resize
      leftIdx: colIdx,
      startX: e.clientX,
      startLeftFraction: leftFrac,
      startRightFraction: rightFrac,
      totalSize,
    };

    const onMouseMove = (ev: MouseEvent) => {
      const ref = panelResizeRef.current;
      if (!ref) return;
      const delta = (ev.clientX - ref.startX) * resizeRatio;
      const deltaPct = delta / ref.totalSize;
      const sumFrac = ref.startLeftFraction + ref.startRightFraction;
      const minFrac = 0.1;
      let newLeft = ref.startLeftFraction + deltaPct;
      let newRight = ref.startRightFraction - deltaPct;
      if (newLeft < minFrac) { newLeft = minFrac; newRight = sumFrac - minFrac; }
      if (newRight < minFrac) { newRight = minFrac; newLeft = sumFrac - minFrac; }

      useBrowserStore.getState().setPanelWidthFraction(leftId, newLeft);
      useBrowserStore.getState().setPanelWidthFraction(rightId, newRight);
    };
    const onMouseUp = () => {
      panelResizeRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [dimensions.width, gap]);


  // ============================================================================
  // DAF-C LINKED VIEW MODE — early return (after all hooks for Rules of Hooks)
  // ============================================================================
  if ((viewMode === 'linked' && dafcLoaded) || viewMode === 'linkedSplit') {
    return <div className="h-full w-full" style={{zoom:uiScale}}><TrackContainerSplitView containerRef={containerRef} dimensions={dimensions} /></div>;
  }

  // ============================================================================
  // PANEL-BASED VIEW (replaces sideBySide + stacked modes)
  // ============================================================================
  return (
    <div
      ref={containerRef}
      data-export-container
      className={`h-full w-full flex flex-col overflow-hidden relative ${rounded ? 'bg-[rgb(var(--fb-panel-ground))]' : 'bg-white dark:bg-dark-bg'}`}
      style={uiScale !== 1 ? { zoom: uiScale } : undefined}
      onDragLeave={dragPanelIdx !== null ? (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
      } : undefined}
    >
      {/* Analysis panel strip — collapsible; figures show only the tracks */}
      {!isRenderMode && !railMode && <AnalysisStrip />}
      {/* The right-click menu of every per-panel track and its Set height box (fb-n11-tracks). */}
      {!isRenderMode && <TrackContextMenuHost />}

      {/* Crosshair overlay: the full height of the panels, below the analysis strip (it drew over its chips, audit L5) */}
      {crosshairX !== null && (
        <>
          {crosshairCuts == null ? (
            <div
              className="absolute pointer-events-none z-20"
              data-testid="ruler-crosshair"
              style={{
                left: crosshairX,
                top: stripHeight,
                // Down to the bottom of the panels under the pointer (audit L8), else the container's.
                ...(crosshairBottom != null ? { height: Math.max(0, crosshairBottom - stripHeight) } : { bottom: 0 }),
                width: 1,
                backgroundColor: 'rgba(100, 100, 100, 0.4)',
              }}
            />
          ) : crosshairCuts.segments.map((seg, i) => (
            // Cut where it would cross a panel with coordinates of its own (the graph view).
            <div key={i} className="absolute pointer-events-none z-20" data-testid="ruler-crosshair"
              style={{ left: crosshairX, top: seg.top, height: Math.max(0, seg.bottom - seg.top), width: 1, backgroundColor: 'rgba(100, 100, 100, 0.4)' }} />
          ))}
          {crosshairLabel && !crosshairCuts?.labelHidden && (
            <div
              data-testid="ruler-crosshair-label"
              className="absolute pointer-events-none z-20 bg-gray-800 text-white text-[13px] px-1.5 py-0.5 rounded whitespace-nowrap"
              style={{
                left: Math.min(crosshairX + 8, dimensions.width - 120),
                // Just under the ruler, beside the pointer (not over the strip, the header or the width label).
                top: crosshairLabelTop ?? stripHeight + gap + PANEL_HEADER_HEIGHT + AXIS_HEIGHT + 2,
              }}
            >
              {crosshairLabel}
            </div>
          )}
        </>
      )}

      {/* Datasets being opened: a placeholder panel each, at once (stores/openingStore.ts) */}
      {!isRenderMode && <OpeningPanels top={stripHeight} gap={gap} />}

      {/* Row groups */}
      {rowGroups.map((group) => {
        const isCollapsed = collapsedRows.has(group.rowIndex);
        const panelCount = group.panels.length;
        const columns = groupByColumns(group.panels);
        // Side panels keep a usable width; in a window too narrow for that they slide
        // over the reads (overlay) instead of being squeezed (figure renders and exports: never).
        const rowColumns = columns.map(col => ({
          analysis: col.panels.every(p => p.contentType !== 'dataset'),
          fraction: col.panels[0]?.widthFraction ?? null,
          pinned: col.panels.every(p => p.contentType !== 'dataset' && p.dock === 'side'),
          docked: col.panels.every(p => p.contentType !== 'dataset' && p.dock === 'beside'),
          minWidth: Math.max(0, ...col.panels.map(p => (p.contentType === 'dataset' ? 0 : getAnalysisPanel(p.contentType)?.minUsableWidth ?? 0))),
        }));
        const rowAvailable = dimensions.width - gap * (columns.length + 1);
        // On screen (not figure renders, exports or full view): panels stay where the user put them and a row too
        // narrow for their minimums scrolls sideways (utils/panelRowLayout.ts, the scroll policy).
        const onScreen = overlayAllowed({ renderMode: !!isRenderMode, exporting: !!exportInProgress, fullView: !!fullViewPanelId });
        const plan = planRowLayout(rowColumns, rowAvailable, { allowOverlay: onScreen, gap, scroll: onScreen });
        const scrolling = plan.scrollWidth != null;
        // The row's content when it scrolls: the columns in the flow and their gaps.
        const rowContentWidth = scrolling ? plan.widths.reduce((sum, w, i) => sum + (plan.overlay[i] ? 0 : w + gap), gap) : undefined;
        // Two or more split sets side by side: a header strip over each set's columns (SV-7), on screen.
        const stripSegments = onScreen ? splitStripSegments(columns, plan.widths, plan.overlay.map(o => !o), gap) : [];
        const showStrips = (group.panels.some(p => p.regionPanelGroup || matchedPanelIds.includes(p.id)) || new Set(group.panels.filter(p => p.readSubset).map(p => p.readSubset!.groupId)).size > 1) && stripSegments.length > 0;
        // Room for the horizontal scrollbar under the panels, for the band over a scrolling row that holds its edge chips
        // (round 3, R1: never over panel content), and for the split strips over the panels.
        const bodyHeight = rowHeight - (scrolling ? ROW_SCROLLBAR_ALLOWANCE + PANEL_ROW_CUE_BAND_HEIGHT : 0) - (showStrips ? SPLIT_STRIP_HEIGHT : 0);
        const isOverlayCol = (i: number) => Boolean(plan.overlay[i]);
        const colWidths = plan.widths;
        // For drag targets and indicators: each column with the gap to its left (overlay columns take none).
        const slotWidths = colWidths.map((w, i) => (isOverlayCol(i) ? 0 : w + gap));
        const overlayPanels = plan.mode === 'overlay' ? columns.filter((_, i) => isOverlayCol(i)).flatMap(c => c.panels) : [];
        const overlayColIdxs = columns.map((_, i) => i).filter(isOverlayCol);
        // The drawer: under the top header bars, at the row's right (left of side panels pinned beside the reads).
        const drawerTop = gap + PANEL_HEADER_HEIGHT + 4;
        // A scrolling row's drawer sits outside the scrolling content, under the chip band and the split strips.
        const drawerOffset = scrolling ? PANEL_ROW_CUE_BAND_HEIGHT + (showStrips ? SPLIT_STRIP_HEIGHT : 0) : 0;
        const drawerRight = scrolling ? gap : drawerRightOffset(plan, rowColumns, gap);
        // The user's width (drag its left edge), within what the row leaves beside the drawer.
        const drawerRoom = drawerRoomFor(plan, rowColumns, gap, dimensions.width, drawerRight);
        const drawerWidth = clampDrawerWidth(drawerPreferredWidth, drawerRoom);
        // Lower stacked panels' header bars run beside the drawer: their controls stay out from under it.
        const headerInsets = headerInsetsUnderDrawer(
          plan, gap, overlayPanels.length > 0 && !overlayTucked
            ? { left: dimensions.width - drawerRight - drawerWidth, right: dimensions.width - drawerRight }
            : null,
        );
        // Resize handles go between neighbouring columns in the flow (in overlay
        // mode two dataset columns can be neighbours with a side column between them).
        const flowColIdxs = columns.map((_, i) => i).filter(i => !isOverlayCol(i));
        // (A row scrolling at its panels' floors has no width to share out: no resize handles.)
        const resizePairs = scrolling ? [] : flowResizePairs(plan, rowColumns);
        // Pixels per unit of width fraction for the flow columns: in overlay mode the
        // dataset columns share the whole row in proportion to their fractions.
        const resizeTotal = plan.mode === 'overlay'
          ? (() => {
              const n = columns.length;
              const sum = flowColIdxs.reduce((a, i) => a + (columns[i].panels[0]?.widthFraction ?? 1 / n), 0) || 1;
              return flowColIdxs.reduce((a, i) => a + colWidths[i], 0) / sum;
            })()
          : undefined;

        // Collapsed row: thin bar
        if (isCollapsed) {
          return (
            <div
              key={`row-${group.rowIndex}`}
              className="flex items-center px-2 gap-1 cursor-pointer select-none border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
              style={{ height: ROW_COLLAPSE_BAR_HEIGHT, flexShrink: 0 }}
              data-tour="layout-rows"
              onClick={() => useBrowserStore.getState().toggleRowCollapsed(group.rowIndex)}
              onDragOver={dragPanelIdx !== null ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget({ rowIndex: group.rowIndex, insertBefore: 0 }); } : undefined}
              onDrop={dragPanelIdx !== null ? handleUnifiedDrop : undefined}
            >
              <ChevronRight size={11} className="text-gray-400" aria-hidden="true" />
              <span className="text-[11px] text-gray-500 dark:text-gray-400 font-medium">
                Row {group.rowIndex + 1} ({panelCount} {panelCount === 1 ? 'panel' : 'panels'})
              </span>
            </div>
          );
        }

        // Expanded row
        return (
          <div key={`row-${group.rowIndex}`} style={{ flexShrink: 0 }} {...workedPanelHandlers}>
            {/* Row collapse toggle bar */}
            {rowGroups.length > 1 && (
              <div
                className="flex items-center px-2 gap-1 cursor-pointer select-none border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
                style={{ height: ROW_COLLAPSE_BAR_HEIGHT, flexShrink: 0 }}
                data-tour="layout-rows"
                onClick={() => useBrowserStore.getState().toggleRowCollapsed(group.rowIndex)}
              >
                <ChevronDown size={11} className="text-gray-400" aria-hidden="true" />
                <span className="text-[11px] text-gray-500 dark:text-gray-400 font-medium">
                  Row {group.rowIndex + 1} ({panelCount} {panelCount === 1 ? 'panel' : 'panels'})
                </span>
              </div>
            )}
            {/* Panel flex row — columns may contain vertically stacked panels */}
            {(() => {
            const drawerNode = overlayPanels.length > 0 && (() => {
                // The drawer starts under the dataset panels' header bars, so their
                // name, read count, strand and ⋯ menu stay in reach. It covers the
                // dataset panels only: side panels docked beside them stay uncovered.
                // (lower stacked panels' headers keep their controls left of it: headerInsets).
                const innerHeight = bodyHeight - drawerTop;
                const rightOffset = drawerRight;
                // Several panels: one at a time, chosen with tabs at the top of the drawer.
                const tabbed = overlayPanels.length > 1;
                const activeId = overlayPanels.some(p => p.id === drawerActive[group.rowIndex])
                  ? drawerActive[group.rowIndex]
                  : overlayPanels[overlayPanels.length - 1].id;
                overlayIdsByRow.current[group.rowIndex] = { ids: overlayPanels.map(p => p.id), active: activeId };
                const panelH = innerHeight - (tabbed ? DRAWER_TABS_HEIGHT : 0);
                // Docking goes for the whole drawer: every tab comes out together. Only the drawer's panels: the side
                // panels already beside the reads keep their widths (round 3, B1). Under the scroll policy nothing goes
                // to the drawer by itself, so nothing stays behind (the row scrolls instead).
                const stayInDrawer = columnsLeftInDrawer(rowColumns, rowAvailable, { gap, scroll: onScreen })
                  .reduce((n, i) => n + columns[i].panels.length, 0);
                const drawerPanelIds = overlayPanels.map(p => p.id);
                const drawerDock: DrawerDock = {
                  count: overlayPanels.length,
                  stay: stayInDrawer,
                  dock: () => useBrowserStore.getState().dockPanelsBeside(drawerPanelIds),
                };
                // Pop out: one tab's panel (its column) docked beside the reads on its own.
                const popOutOf = (panel: PanelConfig) => {
                  const col = columns.findIndex(c => c.panels.includes(panel));
                  const blocked = col < 0 || columnsLeftInDrawer(rowColumns, rowAvailable, { gap, dock: [col], scroll: onScreen }).includes(col);
                  return {
                    blocked,
                    pop: () => useBrowserStore.getState().dockPanelsBeside((columns[col]?.panels ?? [panel]).map(p => p.id)),
                  };
                };
                return (
                  <>
                  <div className="pointer-events-none absolute left-0 z-30 overflow-hidden" style={{ right: rightOffset, top: drawerTop + drawerOffset, height: innerHeight }}>
                  <div
                    data-testid="analysis-overlay"
                    data-tucked={overlayTucked ? 'true' : 'false'}
                    className={`pointer-events-auto absolute right-0 top-0 flex flex-col transition-transform duration-200 ease-out ${railMode && !exportInProgress ? 'fb-drawer-slide-in' : ''}`}
                    style={{
                      width: drawerWidth, height: innerHeight,
                      filter: 'drop-shadow(0 10px 24px rgb(15 23 42 / 0.20))',
                      transform: overlayTucked ? `translateX(${drawerWidth + gap}px)` : undefined,
                    }}
                    // Dropping over the side panels targets them, not the reads underneath:
                    // the bottom stacks under the last side panel, the rest adds a side column.
                    onDragOver={dragPanelIdx !== null ? (e) => {
                      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = logicalOffset(e.clientY - rect.top, e.currentTarget.clientHeight, rect.height);
                      const next = { ...overlayDropTarget(y, e.currentTarget.clientHeight, overlayColIdxs, group.rowIndex, STACK_ZONE_PX), drawer: true };
                      setDropTarget(prev => (prev?.drawer && prev?.rowIndex === next.rowIndex && prev?.insertBefore === next.insertBefore
                        && prev?.stackColumnIndex === next.stackColumnIndex && prev?.newRowAfter == null ? prev : next));
                    } : undefined}
                    onDrop={dragPanelIdx !== null ? (e) => { e.stopPropagation(); handleUnifiedDrop(e); } : undefined}
                  >
                    {!overlayTucked && drawerRoom > 0 && (
                      <DrawerResizeHandle
                        width={drawerWidth}
                        min={Math.min(DRAWER_MIN_WIDTH, drawerRoom)}
                        max={clampDrawerWidth(Number.MAX_SAFE_INTEGER, drawerRoom)}
                        zoom={uiScale}
                        onResize={(w) => useDrawerTabsStore.getState().setWidth(w)}
                        onReset={() => useDrawerTabsStore.getState().setWidth(null)}
                      />
                    )}
                    {tabbed && (
                      <div
                        role="tablist"
                        aria-label="Side panels"
                        onKeyDown={(e) => {
                          // Left/Right move between the tabs (and don't pan the genome).
                          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                          e.preventDefault();
                          e.stopPropagation();
                          const ids = overlayPanels.map(p => p.id);
                          const next = ids[(ids.indexOf(activeId) + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
                          useDrawerTabsStore.getState().setActive(group.rowIndex, next);
                          (e.currentTarget.querySelector(`[data-drawer-tab="${next}"]`) as HTMLElement | null)?.focus();
                        }}
                        data-testid="analysis-overlay-tabs"
                        className="flex shrink-0 items-center gap-1 overflow-x-auto rounded-t-fb-lg border border-b-0 border-line bg-white px-1.5 dark:border-white/10 dark:bg-dark-surface"
                        style={{ height: DRAWER_TABS_HEIGHT }}
                      >
                        {overlayPanels.map(panel => {
                          const plugin = getAnalysisPanel(panel.contentType);
                          const selected = panel.id === activeId;
                          const label = plugin?.label ?? panel.contentType;
                          const popOut = popOutOf(panel);
                          return (
                            <span key={panel.id} role="presentation" className="inline-flex shrink-0 items-center">
                              <button
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                aria-pressed={selected}
                                tabIndex={selected ? 0 : -1}
                                data-drawer-tab={panel.id}
                                onClick={() => useDrawerTabsStore.getState().setActive(group.rowIndex, panel.id)}
                                className="fb-strip-chip shrink-0"
                                style={{ '--chip': plugin?.headerColor ?? '#666' } as React.CSSProperties}
                                data-testid={`analysis-overlay-tab-${panel.contentType}`}
                                title={`Show ${label}`}
                              >
                                <PanelIcon contentType={panel.contentType} size={16} />
                                {getAnalysisPanelLabel(panel.contentType, true)}
                              </button>
                              {selected && (
                                <button
                                  type="button"
                                  onClick={() => { if (!popOut.blocked) popOut.pop(); }}
                                  aria-disabled={popOut.blocked || undefined}
                                  aria-label={`Pop out ${label}`}
                                  title={popOut.blocked
                                    ? `${label} doesn't fit beside the reads: widen the window or close a panel`
                                    : `Pop out ${label}: a side panel of its own beside the reads (Pin to the side puts it back in the drawer)`}
                                  className={`ml-0.5 inline-flex h-[22px] w-[22px] items-center justify-center rounded text-ink-muted hover:bg-gray-900/[0.06] hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white ${popOut.blocked ? 'cursor-not-allowed opacity-40' : ''}`}
                                  data-testid={`analysis-overlay-popout-${panel.contentType}`}
                                >
                                  <PanelBeside size={13} aria-hidden="true" />
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {overlayPanels.map(panel => (
                      <div key={panel.id} className={panel.id === activeId ? 'contents' : 'hidden'} data-drawer-hidden={panel.id === activeId ? undefined : 'true'}
                        // Hidden for real (not only by class): its menus and dialogs must not count as open (Escape, shortcuts).
                        hidden={panel.id !== activeId}>
                        {renderPanel(panel, panels.indexOf(panel), drawerWidth, panelH, false, false, undefined, 0, drawerDock)}
                      </div>
                    ))}
                    {dragPanelIdx !== null && dropTarget?.rowIndex === group.rowIndex && dropTarget.drawer && (
                      dropTarget.stackColumnIndex != null && overlayColIdxs.includes(dropTarget.stackColumnIndex)
                        ? <div data-testid="analysis-overlay-drop" className="absolute left-0 right-0 bottom-0 pointer-events-none z-10" style={{ height: 3, backgroundColor: '#3b82f6', borderRadius: 2, boxShadow: '0 0 6px rgba(59,130,246,0.5)' }} />
                        : dropTarget.stackColumnIndex == null && dropTarget.newRowAfter == null && dropTarget.insertBefore === overlayColIdxs[overlayColIdxs.length - 1] + 1
                          ? <div data-testid="analysis-overlay-drop" className="absolute top-0 bottom-0 pointer-events-none z-10" style={{ left: -3, width: 3, backgroundColor: '#3b82f6', borderRadius: 2, boxShadow: '0 0 6px rgba(59,130,246,0.5)' }} />
                          : null
                    )}
                  </div>
                  </div>
                  {/* The tab that slides the drawer away and back: at its left edge, or at the reads' right edge when tucked. */}
                  <button
                    type="button"
                    onClick={() => setOverlayTucked(v => !v)}
                    className="absolute z-30 flex h-8 w-6 items-center justify-center rounded-l-fb border border-r-0 border-line bg-white text-ink-muted transition-[right] duration-200 ease-out hover:text-gray-900 dark:border-white/10 dark:bg-dark-surface dark:hover:text-white"
                    style={{ top: drawerTop + drawerOffset + 8, right: rightOffset + (overlayTucked ? 0 : drawerWidth) }}
                    title={overlayTucked ? 'Show the side panels again' : 'Slide the side panels away to see the reads under them'}
                    aria-label={overlayTucked ? 'Show side panels' : 'Hide side panels'}
                    aria-expanded={!overlayTucked}
                    data-testid="analysis-overlay-toggle"
                  >
                    {overlayTucked ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                  </button>
                  </>
                );
              })();
            const rowBody = (
            <div
              className="group/layout-row flex flex-row"
              data-testid={scrolling ? 'panel-row-content' : undefined}
              style={{ height: bodyHeight, position: 'relative', columnGap: gap, padding: gap ? `${gap}px ${gap}px 0` : undefined,
                ...(scrolling ? { width: rowContentWidth, boxSizing: 'border-box' as const } : {}) }}
              onDragOver={dragPanelIdx !== null ? (e) => handleRowDragOver(e, group.rowIndex, slotWidths) : undefined}
              onDrop={dragPanelIdx !== null ? handleUnifiedDrop : undefined}
            >
              {columns.map((col, colIdx) => {
                if (isOverlayCol(colIdx)) return null;
                const cw = colWidths[colIdx] ?? Math.floor(dimensions.width / columns.length);
                const stackCount = col.panels.length;
                const panelH = Math.floor((bodyHeight - gap * stackCount) / stackCount);
                // Beside a panel with its own locus bar, show the main view's
                // location in a bar of the same height so the tracks line up.
                const rowHasLocusBar = columns.length > 1
                  && group.panels.some(p => p.contentType === 'dataset' && p.viewportOverride);
                return (
                  <React.Fragment key={`col-${col.column}`}>
                    <div className="flex flex-col relative" style={{ width: cw, rowGap: gap }}>
                      {col.panels.map((panel, stackIdx) => {
                        const globalIdx = panels.indexOf(panel);
                        const isFirst = colIdx === 0 && stackIdx === 0 && group.rowIndex === rowGroups[0]?.rowIndex;
                        const trackLayout = { hideAxis: rulerRepeatsAbove(col.panels, stackIdx, regionOfPanel, p => panelReversed(reversedState, p.id)) };
                        return renderPanel(panel, globalIdx, cw, panelH, isFirst, rowHasLocusBar && panel.contentType === 'dataset', trackLayout,
                          stackIdx > 0 ? headerInsets[colIdx] : 0);
                      })}
                      {/* Stack indicator: horizontal line at bottom of this column */}
                      {dropTarget?.stackColumnIndex === colIdx
                        && dropTarget?.rowIndex === group.rowIndex && dragPanelIdx !== null && (
                        <div
                          className="absolute left-0 right-0 bottom-0 pointer-events-none z-10"
                          style={{
                            height: 3,
                            backgroundColor: '#3b82f6',
                            borderRadius: 2,
                            boxShadow: '0 0 6px rgba(59,130,246,0.5)',
                          }}
                        />
                      )}
                    </div>
                  </React.Fragment>
                );
              })}
              {!exportInProgress && resizePairs.map(([colIdx, rightIdx]) => (
                <div
                  key={`resize-${group.rowIndex}-${colIdx}`}
                  data-testid={`column-resize-${group.rowIndex}-${colIdx}`}
                  className="absolute top-0 bottom-0 z-20 flex w-2 -translate-x-1 cursor-col-resize items-center justify-center opacity-0 transition-opacity hover:opacity-100 group-hover/layout-row:opacity-100 group-focus-within/layout-row:opacity-100"
                  style={{ left: computeResizeHandleX(slotWidths, colIdx) + gap / 2 }}
                  onMouseDown={(e) => startColumnResize(e, colIdx, columns, rightIdx, resizeTotal)}
                  title="Resize panels"
                >
                  <div
                    className="h-3/5 rounded-sm bg-blue-400/70 shadow-[0_0_0_1px_rgba(255,255,255,0.75)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
                    style={{ width: 2 }}
                  />
                </div>
              ))}
              {/* Drop indicators: vertical line for column insert, horizontal for new row */}
              {dropTarget?.rowIndex === group.rowIndex && dragPanelIdx !== null && !dropTarget.drawer && (
                dropTarget.newRowAfter != null
                  ? <HorizontalDropIndicator />
                  : dropTarget.stackColumnIndex == null
                    ? <DropIndicatorLine
                        left={computeIndicatorX(slotWidths, dropTarget.insertBefore) + gap / 2}
                        height={bodyHeight}
                        // a panel from the drawer: the line says what the drop does
                        label={panels[dragPanelIdx]?.dock === 'side' && overlayPanels.some(p => p.id === panels[dragPanelIdx]?.id) ? 'Dock here' : undefined}
                      />
                    : null
              )}
              {!scrolling && drawerNode}
            </div>
            );
            // The pinned drawer stays over the visible row (outside the scrolling content).
            const strips = showStrips ? <SplitGroupStrip segments={stripSegments} width={rowContentWidth} /> : null;
            // The cues at the edges with panels past them (N4) sit left of a pinned drawer over the row.
            const drawerCovers = overlayPanels.length > 0 && !overlayTucked ? drawerRight + drawerWidth : 0;
            return scrolling ? (
              <div style={{ position: 'relative', height: rowHeight }}>
                <PanelRowScroller height={rowHeight} rightInset={drawerCovers} bottomInset={ROW_SCROLLBAR_ALLOWANCE}
                  layoutKey={`${group.panels.map(p => p.id).join(',')}|${colWidths.join(',')}|${dimensions.width}`} panelName={panelShortName}>
                  {strips}
                  {rowBody}
                </PanelRowScroller>
                {drawerNode}
              </div>
            ) : strips ? <>{strips}{rowBody}</> : rowBody; })()}
          </div>
        );
      })}

      {/* Minimized dataset panel chips */}
      {hasMinimized && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-gray-200 dark:border-gray-700 flex-wrap bg-gray-50 dark:bg-gray-800/50">
          <span className="text-[11px] text-gray-400 dark:text-gray-500 mr-0.5">Minimized:</span>
          {panels.filter(p => p.collapsed && p.contentType === 'dataset').map(p => {
            const ds = datasets.find(d => d.id === p.datasetId);
            return (
              <button
                key={p.id}
                onClick={() => useBrowserStore.getState().setPanelCollapsed(p.id, false)}
                className="text-[12px] px-2.5 py-1 rounded-md text-white whitespace-nowrap flex items-center gap-1.5 shadow-sm hover:brightness-110 transition-all"
                style={{ backgroundColor: ds?.color || '#666' }}
                title={`Click to restore ${ds?.label || 'Panel'}`}
                data-tour="panel-expand"
              >
                <ChevronDown size={11} className="rotate-180 opacity-80" aria-hidden="true" />
                {ds?.label || 'Panel'}
              </button>
            );
          })}
        </div>
      )}

      {/* Drop zone below all rows — drag to bottom edge of last row handles this,
          but keep a thin catch-all zone for when cursor goes past the rows entirely */}
      {dragPanelIdx !== null && rowGroups.length > 0 && (
        <div
          className="flex-shrink-0"
          style={{ height: 16 }}
          onDragOver={(e) => {
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            const lastRow = rowGroups[rowGroups.length - 1].rowIndex;
            setDropTarget(prev => {
              if (prev?.newRowAfter === lastRow && !prev.drawer) return prev;
              return { rowIndex: lastRow, insertBefore: 0, newRowAfter: lastRow };
            });
          }}
          onDrop={handleUnifiedDrop}
        />
      )}

      {/* Onboarding: dismissable popup centered over the empty browser.
          Shown when no real dataset is loaded AND user hasn't dismissed it
          this session. The backdrop is semi-transparent so the empty
          browser remains visible underneath — important for users who
          opened the app to design PCR primers (which doesn't need any
          loaded data). Clicking the backdrop, the ×, or pressing Escape
          all dismiss it for the session. */}
      {welcomeShown && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 dark:bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) dismissWelcomeByUser(); }}
        >
          <div ref={welcomeRef} role="dialog" aria-modal="true" aria-labelledby="welcome-title" tabIndex={-1}
            className="relative w-full rounded-2xl border border-line bg-white shadow-modal outline-none dark:border-white/10 dark:bg-dark-surface dark:shadow-modal-dark text-center max-w-[600px] max-h-[calc(100%-2rem)] overflow-y-auto px-7 pb-5 pt-7 mx-4" data-testid="welcome-card">
            {/* Sticky, not absolute: in a short window the card scrolls (focus coming back
                from the Library moves it), and its × must stay at the card's top edge. A
                zero-height holder 12 px from the top (net margin 0), so nothing reflows; sticky
                offsets count from inside the 28 px padding, hence -top-4. */}
            <div className="sticky -top-4 z-10 -mt-4 mb-4 h-0">
              <button
                type="button"
                onClick={dismissWelcomeByUser}
                aria-label="Dismiss welcome screen"
                title="Dismiss (use the empty browser, e.g. for primer design)"
                className="fb-icon-btn absolute -right-4 top-0"
              ><X size={16} /></button>
            </div>
            <div className="mb-3 flex justify-center">
              {/* The app icon itself (the same file as the favicon), so the two never drift. */}
              <img src="/assets/icons/favicon.svg" alt="" width={56} height={56} className="rounded-[12px] shadow-[0_10px_28px_rgba(42,79,181,0.32)]" />
            </div>
            <h2 id="welcome-title" className="mb-1.5 text-[18px] font-semibold leading-[26px] tracking-[-0.01em] text-gray-900 dark:text-gray-100">Welcome to FiberBrowser</h2>
            {versionInfo?.update_available && versionInfo.release_url && (
              <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-900/30 dark:text-amber-100">
                <Sparkles size={14} aria-hidden="true" />
                <span>
                  Update available: <strong>v{versionInfo.latest}</strong>
                  {' '}(you have v{versionInfo.current})
                </span>
                <a
                  href={versionInfo.release_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 rounded bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-700"
                >
                  View release →
                </a>
              </div>
            )}
            <p className="mx-auto mb-4 max-w-[440px] text-[13px] leading-[19px] text-ink-muted">
              Visualize single-molecule footprinting data with integrated clustering, peak detection, and multi-track analysis.
            </p>
            {!publicMode && (
              <div className="mb-4 mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="welcome-actions">
                {/* Two ways to open data side by side, then a new run and the tour.
                    (Two rows: in a short window the card scrolls, its × stays reachable.) */}
                <WelcomeReopenLastSessionButton />
                <WelcomeLoadFileButton />
                <WelcomeLibraryButton />
                <WelcomeDafRunButton />
                <WelcomeTourButton />
              </div>
            )}
            <OnboardingCatalog />
            {!publicMode && !isLabServerPage() && (
              <div className="text-[12px] text-ink-muted">
                Files on a cluster?{' '}
                <button type="button" onClick={() => openConnectCluster()} data-testid="welcome-connect-cluster"
                  className="font-medium text-blue-600 hover:underline dark:text-blue-300">Connect to cluster…</button>
              </div>
            )}
            <div className="mt-4 border-t border-line/70 pt-3 text-[11px] text-ink-faint dark:border-white/10">
              Supports BAM, BigBed, BigWig, GTF, GFF3, FASTA, cooler, and overlay formats
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
