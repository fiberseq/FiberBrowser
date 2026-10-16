import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type Dispatch, type FocusEvent, type ReactNode, type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { ChevronDown } from '../ui/Icons';
import { fitToolbar, nextGroupToFold, readsMinHeight } from '../../utils/toolbarFit';
import { useBrowserStore } from '../../stores/browserStore';

/**
 * The read-operations toolbar (Reads, Layers, Peaks, Cluster, Sort, Filter,
 * Quality).
 *
 * - A group opens in the row, showing all its controls, and stays open until
 *   the user folds it; each group remembers that across reloads. Several may
 *   be open: the row wraps onto a second line then (the user's choice, never
 *   a hover). (Dropdowns that closed on any click were tried on 1 Oct and
 *   rejected: sometimes you want the full controls, sometimes not.)
 * - A group whose own button carries its name (Scan, Cluster, Sort, Filter)
 *   gets an icon-only options toggle beside it, so the name shows once.
 * - Folded, a group's current values show in a small card while the pointer
 *   is on it (or it has keyboard focus); any click or Escape closes the card.
 *   The card floats over the reads, so hovering never moves anything.
 * - When even the folded groups don't fit one row, the least used go to a More
 *   menu at its end (with all their controls while it is open).
 * - The reads always keep half the window (at least 300 px; readsMinHeight),
 *   at every UI size: while the open groups would leave them less, the least
 *   used open groups show folded (never the one the user has just opened).
 *   That is only how they are drawn: they stay open, and come back as soon as
 *   there is room again (a taller window, a smaller UI size, another group folded).
 *   If that is not enough (a large UI size in a small window), the top bar and
 *   toolbar are drawn at a smaller size than the rest (useChromeZoom), never
 *   below 100%.
 */

interface ToolbarContext {
  peek: string | null;
  setPeek: Dispatch<SetStateAction<string | null>>;
  /** Groups shown in the More menu (not in the row). */
  overflow: Set<string>;
  /** The More menu's body while it is open (overflowed groups render into it). */
  moreBody: HTMLElement | null;
  /** `head`: the group's button(s), whose width (with the box's own padding and border) is its folded width. */
  register: (id: string, box: HTMLElement | null, head?: HTMLElement | null) => void;
  /** Open groups shown folded to leave the reads their height (they stay open). */
  foldedForRoom: Set<string>;
  /** A group tells the row whether it is open (the user's choice). */
  reportOpen: (id: string, open: boolean) => void;
  /** The user opened (or showed) a group, or folded one: fit the row again around that choice. */
  userToggled: (id: string, open: boolean) => void;
}

const Ctx = createContext<ToolbarContext | null>(null);

// Whether a group's summary is on screen: it is always rendered, folded into a
// hidden hover card too. A summary that asks the server something (the quality
// counts) asks only while it is shown.
const SummaryShownCtx = createContext(true);

/** Inside a ToolbarGroup summary: whether it is on screen now (true elsewhere). */
export function useToolbarSummaryShown(): boolean {
  return useContext(SummaryShownCtx);
}

/** Sets whether the summaries inside are on screen (ToolbarGroup does; tests too). */
export const ToolbarSummaryShown = SummaryShownCtx.Provider;

function closeOnEscape(event: KeyboardEvent, close: () => void) {
  if (event.key !== 'Escape') return;
  // Handled here: the global Escape (clear selection) must not run as well.
  event.preventDefault();
  event.stopPropagation();
  close();
}

export interface ToolbarGroupSpec {
  id: string;
  /** Order in which groups go to the More menu (lower = sooner); Infinity: never. */
  overflowRank: number;
}

/** A toolbar group's height (px), open or folded, while its controls fit one line. */
export const TOOLBAR_GROUP_HEIGHT = 34;
/** The tallest a control inside a group may be (the group's height less its padding and border). */
export const TOOLBAR_CONTROL_MAX_HEIGHT = 24;

const groupStorageKey = (id: string) => `fiberbrowser_toolbar_group_v2_${id}`;

/** Whether a group is open: the user's last choice for it, else `defaultOpen`. */
export function rememberedGroupOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const saved = localStorage.getItem(groupStorageKey(id));
    return saved === null ? defaultOpen : saved === 'open';
  } catch {
    return defaultOpen;
  }
}

function rememberGroupOpen(id: string, open: boolean): void {
  try { localStorage.setItem(groupStorageKey(id), open ? 'open' : 'closed'); } catch { /* per-viewer preference */ }
}

const GROUP_OPEN_EVENT = 'fiberbrowser:toolbar-group-open';

/**
 * Open or fold a group without its toggle (e.g. the tour putting a group back while
 * the group is in the More menu, where it has no toggle): the remembered state and,
 * if the group is mounted, its own.
 */
export function setToolbarGroupOpenState(id: string, open: boolean): void {
  rememberGroupOpen(id, open);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(GROUP_OPEN_EVENT, { detail: { id, open } }));
}

/** Width of a folded group: its button(s) plus the box's padding and border. */
function foldedWidth(box: HTMLElement, head: HTMLElement): number {
  const cs = getComputedStyle(box);
  const chrome = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
    .reduce((sum, k) => sum + (parseFloat(cs[k as keyof CSSStyleDeclaration] as string) || 0), 0);
  return head.offsetWidth + chrome;
}

/**
 * The most the top bar and toolbar may be zoomed (null: no limit, the UI size).
 * Set by the toolbar row while the UI size would leave the reads too little room.
 */
export const useChromeZoomCap = create<{ cap: number | null; setCap: (cap: number | null) => void }>(set => ({
  cap: null,
  setCap: cap => set(state => (state.cap === cap ? state : { cap })),
}));

/** The zoom of the top bar and toolbar: the UI size, held down while it would leave the reads too little room. */
export function useChromeZoom(): number {
  const uiScale = useBrowserStore(s => s.uiScale);
  const cap = useChromeZoomCap(s => s.cap);
  return cap === null ? uiScale : Math.min(uiScale, cap);
}

/** Height of the reads' region (the panels below the toolbar), or null when it isn't there. */
function tracksHeight(): number | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('[data-testid="tracks-region"]');
  return el ? el.getBoundingClientRect().height : null;
}

/** The row. `groups` lists the groups in display order with how readily each goes to More. */
export function ToolbarRow({ groups, children }: {
  groups: ToolbarGroupSpec[];
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreBody, setMoreBody] = useState<HTMLElement | null>(null);
  const [overflowIds, setOverflowIds] = useState<string[]>([]);
  const elements = useRef(new Map<string, { box: HTMLElement; head?: HTMLElement | null }>());
  const widths = useRef(new Map<string, number>());
  const observer = useRef<ResizeObserver | null>(null);
  // The reads' height budget (audit H5): open groups shown folded while the toolbar would leave them too little.
  const [foldedForRoom, setFoldedForRoom] = useState<string[]>([]);
  const [fitRound, setFitRound] = useState(0);
  const fitting = useRef(false);
  const openGroups = useRef(new Map<string, boolean>());
  const keepOpen = useRef<string | null>(null);
  const settledTracksHeight = useRef<number | null>(null);
  const uiScale = useBrowserStore(s => s.uiScale);
  const zoomCap = useChromeZoomCap(s => s.cap);

  const register = useCallback((id: string, box: HTMLElement | null, head?: HTMLElement | null) => {
    const prev = elements.current.get(id);
    if (prev?.box && prev.box !== box) observer.current?.unobserve(prev.box);
    if (!box) { elements.current.delete(id); return; }
    elements.current.set(id, { box, head });
    if (prev?.box !== box) observer.current?.observe(box);
  }, []);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    // Layout widths (offsetWidth), not screen ones: the toolbar may be zoomed (UI size).
    // Folded widths only: an open group may wrap the row, never send another to More.
    for (const [id, { box, head }] of elements.current) {
      if (!box.isConnected || box.closest('[data-toolbar-more-body]')) continue;
      const w = head && head.isConnected ? foldedWidth(box, head) : box.offsetWidth;
      if (w > 0) widths.current.set(id, w);
    }
    const ids = groups.map(g => g.id);
    const order = groups.map((g, i) => ({ g, i })).filter(({ g }) => Number.isFinite(g.overflowRank))
      .sort((a, b) => a.g.overflowRank - b.g.overflowRank).map(({ i }) => i);
    const next = fitToolbar({
      available: row.clientWidth,
      gap: 4,
      moreWidth: 72,
      widths: ids.map(id => widths.current.get(id) ?? 0),
      overflowOrder: order,
    }).overflow.map(i => ids[i]);
    setOverflowIds(prev => (prev.join() === next.join() ? prev : next));
  }, [groups]);

  /**
   * Start fitting the row to the reads' height budget again, from every open group shown
   * open and the UI size in full. `user`: after the user opened or folded a group (the
   * group they just opened is kept open); otherwise the room changed and nothing is kept.
   */
  const refit = useCallback((user = false) => {
    if (!user) keepOpen.current = null;
    fitting.current = true;
    setFoldedForRoom(prev => (prev.length ? [] : prev));
    useChromeZoomCap.getState().setCap(null);
    setFitRound(n => n + 1);
  }, []);

  /**
   * How many px the reads are short of their share of the window, as laid out now (<= 0: none).
   * Measured at the reads' region itself, so anything between it and the toolbar (an error bar) counts.
   */
  const shortfall = useCallback(() => {
    const row = rowRef.current;
    if (!row || typeof window === 'undefined' || !window.innerHeight) return 0;
    const tracks = document.querySelector('[data-testid="tracks-region"]');
    const top = tracks
      ? tracks.getBoundingClientRect().top
      : ((row.closest('[data-testid="operations-toolbar"]') as HTMLElement | null) ?? row).getBoundingClientRect().bottom;
    if (!(top > 0)) return 0; // no layout (jsdom)
    const scroller = row.closest('[data-browser-root]') as HTMLElement | null;
    return readsMinHeight(window.innerHeight) - (window.innerHeight - (top + (scroller?.scrollTop ?? 0)));
  }, []);

  /** A smaller zoom for the top bar and toolbar that frees `short` px (never below 100%), or null if none helps. */
  const smallerZoom = useCallback((short: number) => {
    const chrome = rowRef.current?.closest('[data-testid="scaled-main-controls"]');
    if (!chrome) return null;
    const height = chrome.getBoundingClientRect().height;
    const zoom = zoomCap === null ? uiScale : Math.min(uiScale, zoomCap);
    const floor = Math.min(1, uiScale);
    if (!(height > 0) || zoom <= floor + 0.01) return null;
    // The chrome's own height shrinks with its zoom (it wraps less, too): this frees at least `short`.
    const next = Math.max(floor, Math.floor(zoom * Math.max(0, height - short) / height * 100) / 100);
    return next < zoom - 0.01 ? next : null;
  }, [uiScale, zoomCap]);

  // One step per render, before paint: fold the next least-used open group until the reads have
  // their height; if that is not enough, draw the top bar and toolbar smaller.
  useLayoutEffect(() => {
    if (!fitting.current) return;
    const short = shortfall();
    if (short > 0) {
      const next = nextGroupToFold({
        groups,
        open: id => openGroups.current.get(id) === true,
        folded: new Set(foldedForRoom),
        inMore: new Set(overflowIds),
        keep: keepOpen.current,
      });
      if (next) { setFoldedForRoom([...foldedForRoom, next]); return; }
      const zoom = smallerZoom(short);
      if (zoom !== null) { useChromeZoomCap.getState().setCap(zoom); return; }
    }
    fitting.current = false;
    settledTracksHeight.current = tracksHeight();
  }, [fitRound, foldedForRoom, overflowIds, groups, shortfall, smallerZoom]);

  // Fit again when the room changes: the window, the UI size, or anything above the reads
  // (the top bar wrapping, a banner, a group's controls growing): the reads' region changes height.
  useLayoutEffect(() => { refit(); }, [uiScale, refit]);
  // The zoom limit belongs to this row: gone with it.
  useEffect(() => () => useChromeZoomCap.getState().setCap(null), []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let frame = 0;
    const later = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; refit(); });
    };
    window.addEventListener('resize', later);
    const tracks = document.querySelector('[data-testid="tracks-region"]');
    const ro = typeof ResizeObserver !== 'undefined' && tracks
      ? new ResizeObserver(() => {
        if (fitting.current) return;
        const h = tracksHeight();
        if (h !== null && settledTracksHeight.current !== null && Math.abs(h - settledTracksHeight.current) < 1) return;
        later();
      })
      : null;
    if (ro && tracks) ro.observe(tracks);
    return () => {
      window.removeEventListener('resize', later);
      ro?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [refit]);

  const reportOpen = useCallback((id: string, open: boolean) => { openGroups.current.set(id, open); }, []);
  const userToggled = useCallback((id: string, open: boolean) => {
    if (open) keepOpen.current = id;
    else if (keepOpen.current === id) keepOpen.current = null;
    refit(true);
  }, [refit]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    observer.current = ro;
    if (rowRef.current) ro.observe(rowRef.current);
    for (const { box } of elements.current.values()) ro.observe(box);
    return () => { ro.disconnect(); observer.current = null; };
  }, [measure]);

  // Measure after mount; after that the ResizeObserver (row and every group) catches each change of width.
  useLayoutEffect(() => { measure(); }, [measure]);

  // The More menu or a peek card closes on a click elsewhere or Escape. (Open groups stay open.)
  useEffect(() => {
    if (!moreOpen && !peek) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (moreOpen && moreRef.current && !moreRef.current.contains(target)) setMoreOpen(false);
      if (peek) {
        const card = elements.current.get(peek)?.box.querySelector('[data-toolbar-peek]');
        if (!card || !card.contains(target)) setPeek(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (moreOpen) closeOnEscape(event, () => {
        setMoreOpen(false);
        moreRef.current?.querySelector<HTMLElement>('[data-testid="toolbar-groups-more"]')?.focus();
      });
      else if (peek) closeOnEscape(event, () => setPeek(null));
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen, peek]);

  const overflow = useMemo(() => new Set(overflowIds), [overflowIds]);
  const foldedSet = useMemo(() => new Set(foldedForRoom), [foldedForRoom]);
  const ctx = useMemo<ToolbarContext>(() => ({
    peek, setPeek, overflow, moreBody: moreOpen ? moreBody : null, register,
    foldedForRoom: foldedSet, reportOpen, userToggled,
  }), [peek, overflow, moreOpen, moreBody, register, foldedSet, reportOpen, userToggled]);

  return (
    <Ctx.Provider value={ctx}>
      <div
        ref={rowRef}
        className="flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-1 text-[12px]"
        data-testid="toolbar-groups-row"
        data-folded-for-room={foldedForRoom.length ? foldedForRoom.join(' ') : undefined}
      >
        {children}
        {overflowIds.length > 0 && (
          <div ref={moreRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => { setMoreOpen(v => !v); setPeek(null); }}
              aria-haspopup="true"
              aria-expanded={moreOpen}
              className={`fb-btn-ghost px-2 py-[3px] text-[11px] ${moreOpen ? 'bg-gray-900/[0.06] dark:bg-white/10' : ''}`}
              title={`More: ${overflowIds.join(', ')}`}
              data-toolbar-overflow={overflowIds.join(' ')}
              data-testid="toolbar-groups-more"
            >
              More ({overflowIds.length})
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            {moreOpen && (
              <ClampedDropdown
                align="right"
                className="flex max-h-[calc(100vh-9rem)] w-max min-w-[16rem] flex-col gap-2 overflow-y-auto p-2"
                data-toolbar-more-body=""
                data-testid="toolbar-groups-more-menu"
                elRef={setMoreBody}
              />
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

/** A dropdown under its button that never runs off the window's right edge. */
function ClampedDropdown({ children, className = '', align = 'left', elRef, ...rest }: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right';
  elRef?: (el: HTMLDivElement | null) => void;
  [key: `data-${string}`]: string | undefined;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shift, setShift] = useState(0);
  const shiftRef = useRef(0);
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el || typeof window === 'undefined') return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      // Screen px → this element's own (possibly zoomed) px; measured without the current shift.
      const zoom = el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
      const left = rect.left - shiftRef.current * zoom;
      const right = rect.right - shiftRef.current * zoom;
      const over = right - (window.innerWidth - 8);
      const next = over > 0 ? Math.max(-over, 8 - left) / zoom : left < 8 ? (8 - left) / zoom : 0;
      if (Math.abs(next - shiftRef.current) > 0.5) { shiftRef.current = next; setShift(next); }
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  return (
    <div
      ref={el => { ref.current = el; elRef?.(el); }}
      className={`absolute top-full z-[90] mt-1 max-w-[calc(100vw-1rem)] rounded-fb-lg border border-line bg-white shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:shadow-dropdown-dark ${align === 'right' ? 'right-0' : 'left-0'} ${className}`}
      style={shift ? { transform: `translateX(${shift}px)` } : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * One group. `action` is the group's own button (Scan, Cluster…); without one
 * the group's name is the toggle. `summary` (the group's current values) shows
 * beside the open group's controls and, folded, in the hover card.
 */
export function ToolbarGroup({
  id,
  label,
  summary,
  summaryInPanel = true,
  action,
  defaultOpen = false,
  children,
}: {
  id: string;
  label: string;
  summary?: ReactNode;
  /** Show the summary with the open group's controls (off when the controls already say it). */
  summaryInPanel?: boolean;
  action?: ReactNode;
  /** Open until the user first folds it (afterwards their choice is remembered). */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('ToolbarGroup must be inside ToolbarRow');
  const { peek, setPeek, overflow, moreBody, register, foldedForRoom, reportOpen, userToggled } = ctx;
  const testId = id;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const inMore = overflow.has(id);
  const [open, setOpen] = useState(() => rememberedGroupOpen(id, defaultOpen));
  // Open, but shown folded for now so the reads keep their height (the row decides; not remembered).
  const roomFolded = open && !inMore && foldedForRoom.has(id);
  const expanded = open && !inMore && !roomFolded;
  useLayoutEffect(() => { reportOpen(id, open); }, [id, open, reportOpen]);
  useEffect(() => {
    const onSet = (event: Event) => {
      const { id: target, open: next } = (event as CustomEvent<{ id: string; open: boolean }>).detail ?? {};
      if (target === id) { setOpen(Boolean(next)); userToggled(id, Boolean(next)); }
    };
    window.addEventListener(GROUP_OPEN_EVENT, onSet);
    return () => window.removeEventListener(GROUP_OPEN_EVENT, onSet);
  }, [id, userToggled]);

  useLayoutEffect(() => {
    if (inMore) { register(id, null); return; }
    register(id, boxRef.current, headRef.current);
  });
  useEffect(() => () => register(id, null), [id, register]);
  useEffect(() => () => { if (leaveTimer.current) window.clearTimeout(leaveTimer.current); }, []);

  const toggle = () => {
    setPeek(null);
    // Shown folded for room: the user wants it shown (it is open already), so the row folds others instead.
    if (roomFolded) { userToggled(id, true); return; }
    const next = !open;
    setOpen(next);
    rememberGroupOpen(id, next);
    userToggled(id, next);
  };

  const toggleTitle = roomFolded
    ? `Show ${label} options (folded for now to leave the reads room; other groups fold instead)`
    : `${expanded ? 'Fold' : 'Show'} ${label} options`;
  const toggleButton = action ? (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex h-[22px] w-[18px] items-center justify-center rounded text-ink-muted hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-white/10 dark:hover:text-gray-200"
      title={toggleTitle}
      aria-label={`${label} options`}
      aria-expanded={expanded}
      data-group-open={open ? 'true' : 'false'}
      data-toolbar-toggle=""
      data-testid={`toolbar-group-toggle-${testId}`}
      data-tour={`${testId}-controls-expand`}
    >
      <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
    </button>
  ) : (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-white/10 dark:hover:text-gray-200"
      title={toggleTitle}
      aria-expanded={expanded}
      data-group-open={open ? 'true' : 'false'}
      data-toolbar-toggle=""
      data-testid={`toolbar-group-toggle-${testId}`}
      data-tour={`${testId}-controls-expand`}
    >
      {label}
      <ChevronDown size={11} aria-hidden="true" className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
    </button>
  );

  if (inMore) {
    // In the More menu: the group with all its controls, while the menu is open.
    if (!moreBody) return null;
    return createPortal(
      <div
        className="flex flex-col gap-1 rounded-fb border border-line/80 p-1.5 dark:border-white/10"
        data-testid={`toolbar-group-${testId}`}
        data-open="true"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-ink-muted">{label}</span>
          {action}
        </div>
        {summary && summaryInPanel && <div className="flex flex-wrap items-center gap-1"><SummaryShownCtx.Provider value>{summary}</SummaryShownCtx.Provider></div>}
        <div className="flex flex-wrap items-center gap-1">{children}</div>
      </div>,
      moreBody,
    );
  }

  const peekShown = !expanded && peek === id;
  const startPeek = () => {
    if (leaveTimer.current) { window.clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    if (summary && !expanded) setPeek(id);
  };
  const endPeek = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    // A moment's grace, to cross from the group to its card.
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      setPeek(p => (p === id ? null : p));
    }, 150);
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    let keyboard = false;
    try { keyboard = (event.target as Element).matches(':focus-visible'); } catch { keyboard = false; }
    if (keyboard) startPeek();
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!boxRef.current?.contains(event.relatedTarget as Node | null)) setPeek(p => (p === id ? null : p));
  };

  return (
    <div
      ref={boxRef}
      // One height, open or folded (TOOLBAR_GROUP_HEIGHT): every control in a group fits it
      // (index.css, [data-toolbar-controls]), so opening a group never moves the reads.
      className="relative flex min-h-[34px] min-w-0 max-w-full flex-wrap items-center gap-1 rounded-fb-lg border border-line/80 bg-white px-1 py-1 shadow-chip dark:border-white/10 dark:bg-white/[0.04] dark:shadow-none"
      data-testid={`toolbar-group-${testId}`}
      data-open={expanded ? 'true' : 'false'}
      data-folded-for-room={roomFolded ? 'true' : undefined}
      onPointerEnter={event => { if (event.pointerType !== 'touch') startPeek(); }}
      onPointerLeave={endPeek}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div ref={headRef} className="flex w-max shrink-0 flex-nowrap items-center gap-0.5 whitespace-nowrap">
        {action ? <>{action}{toggleButton}</> : toggleButton}
      </div>
      {expanded && (
        // The open group's controls, in the row; they wrap inside the group rather than run off the window.
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1" data-toolbar-controls="" data-testid={`toolbar-group-controls-${testId}`}>
          {summary && summaryInPanel && <SummaryShownCtx.Provider value>{summary}</SummaryShownCtx.Provider>}
          {children}
        </div>
      )}
      {!expanded && summary && (
        <div
          data-testid={`toolbar-group-peek-${testId}`}
          data-toolbar-peek=""
          className={`fb-toolbar-peek absolute left-0 top-full z-[90] mt-1 w-max max-w-[min(28rem,calc(100vw-2rem))] items-center gap-1 whitespace-nowrap rounded-fb-lg border border-line bg-white px-2 py-1 text-[12px] shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:shadow-dropdown-dark ${peekShown ? 'flex' : 'hidden'}`}
        >
          <SummaryShownCtx.Provider value={peekShown}>{summary}</SummaryShownCtx.Provider>
        </div>
      )}
    </div>
  );
}
