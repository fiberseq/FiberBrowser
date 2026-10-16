/**
 * The side-panel drawer shows one panel at a time when it holds several (tabs
 * at its top). Which one is showing, per layout row, and which open panels are
 * behind another tab, so the analysis strip can bring one forward instead of
 * closing it.
 */
import { create } from 'zustand';
import { scrollForOpened, sideOf, type PanelSpan, type RowViewport } from '../utils/panelRowScroll';

/** Dispatched on a scrolling row (detail: 'left' | 'right'): its edge chip on that side pulses (PanelRowScroller). */
export const PANEL_ROW_PULSE_EVENT = 'fb-panel-row-pulse';

const DRAWER_WIDTH_KEY = 'fiberbrowser_drawer_width';

function savedDrawerWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

interface DrawerTabsState {
  /** Row index → the panel shown in that row's drawer. */
  active: Record<number, string>;
  /** Open panels behind another drawer tab → their row. */
  hidden: Record<string, number>;
  /** Panels in a drawer now (its shown tab or behind another); `active` also remembers rows without one. */
  inDrawer: string[];
  /** Counts explicit requests to show a panel: the drawer slides back out when tucked away. */
  revealCount: number;
  /** The drawer's width as the user resized it (null: the default); remembered across reloads. */
  width: number | null;
  setWidth: (width: number | null) => void;
  setActive: (row: number, panelId: string) => void;
  setHidden: (hidden: Record<string, number>) => void;
  setInDrawer: (ids: string[]) => void;
}

export const useDrawerTabsStore = create<DrawerTabsState>((set) => ({
  active: {},
  hidden: {},
  inDrawer: [],
  revealCount: 0,
  width: savedDrawerWidth(),
  setWidth: (width) => {
    const next = width != null && Number.isFinite(width) && width > 0 ? Math.round(width) : null;
    try {
      if (next == null) localStorage.removeItem(DRAWER_WIDTH_KEY);
      else localStorage.setItem(DRAWER_WIDTH_KEY, String(next));
    } catch { /* per-viewer preference */ }
    set(state => (state.width === next ? state : { width: next }));
  },
  setActive: (row, panelId) => set(state => (state.active[row] === panelId ? state : { active: { ...state.active, [row]: panelId } })),
  setHidden: (hidden) => set(state => {
    const a = Object.entries(state.hidden).sort().join();
    const b = Object.entries(hidden).sort().join();
    return a === b ? state : { hidden };
  }),
  setInDrawer: (ids) => set(state => (state.inDrawer.join() === ids.join() ? state : { inDrawer: ids })),
}));

/** Bring a panel hidden behind another drawer tab forward. Returns false when it isn't hidden. */
export function showDrawerPanel(panelId: string): boolean {
  const { hidden, setActive } = useDrawerTabsStore.getState();
  const row = hidden[panelId];
  if (row == null) return scrollPanelIntoRow(panelId);
  setActive(row, panelId);
  return true;
}

/** The panel the user last worked in (a click or focus inside it; components/tracks/PanelRowScroller.tsx). */
let workedPanel: string | null = null;

export function noteWorkedPanel(panelId: string | null): void {
  workedPanel = panelId;
}

export function lastWorkedPanel(): string | null {
  return workedPanel;
}

const PANEL_SELECTOR = '[data-panel-id], [data-analysis-panel-id]';
const panelIdOf = (el: HTMLElement) => el.dataset.panelId ?? el.dataset.analysisPanelId ?? '';

/** The panels of a scrolling row, where they sit in its content (utils/panelRowScroll.ts). */
export function panelSpansIn(scroller: HTMLElement): PanelSpan[] {
  const box = scroller.getBoundingClientRect();
  // DOMRects include the UI size's CSS zoom; scrollLeft and clientWidth don't: rects to logical pixels.
  const zoom = scroller.offsetWidth > 0 && box.width > 0 ? box.width / scroller.offsetWidth : 1;
  const out: PanelSpan[] = [];
  for (const el of scroller.querySelectorAll<HTMLElement>(PANEL_SELECTOR)) {
    if (el.parentElement?.closest(PANEL_SELECTOR)) continue;  // only a row's own panels, not anything nested in one
    const r = el.getBoundingClientRect();
    if (r.width <= 0) continue;
    const left = (r.left - box.left) / zoom + scroller.scrollLeft;
    out.push({ id: panelIdOf(el), left, right: left + r.width / zoom });
  }
  return out;
}

/** A scrolling row's viewport (the pinned drawer over it, PanelRowScroller's `rightInset`, is not in view). */
export function rowViewportOf(scroller: HTMLElement): RowViewport {
  return {
    scrollLeft: scroller.scrollLeft,
    clientWidth: scroller.clientWidth,
    scrollWidth: scroller.scrollWidth,
    rightInset: Number(scroller.dataset.rightInset) || 0,
  };
}

function panelElement(panelId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const id = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(panelId) : panelId.replace(/["\\]/g, '\\$&');
  return document.querySelector<HTMLElement>(`[data-analysis-panel-id="${id}"], [data-panel-id="${id}"]`);
}

/**
 * Panels just opened (or asked for again) in rows that scroll sideways: each such row scrolls only as far as needed
 * to show them (a set of them as one opening: the whole set, or its start), keeping the one the user works in in view
 * too when both fit (utils/panelRowScroll.ts `scrollForOpened`). When the working panel ends up past an edge, that
 * edge's chip pulses. `fallbackKeep`: the panel to keep when the user hasn't worked in one of that row yet (the active
 * panel). True when a row scrolled.
 */
export function scrollRowsForOpened(panelIds: string[], fallbackKeep?: string | null): boolean {
  const byRow = new Map<HTMLElement, Set<string>>();
  for (const id of panelIds) {
    const scroller = panelElement(id)?.closest<HTMLElement>('[data-testid="panel-row-scroll"]');
    if (scroller) byRow.set(scroller, (byRow.get(scroller) ?? new Set()).add(id));
  }
  let moved = false;
  for (const [scroller, ids] of byRow) {
    const spans = panelSpansIn(scroller);
    const opened = spans.filter(s => ids.has(s.id));
    const keepId = [workedPanel, fallbackKeep].find(k => k && !ids.has(k) && spans.some(s => s.id === k));
    const keep = keepId ? spans.find(s => s.id === keepId) ?? null : null;
    const viewport = rowViewportOf(scroller);
    const target = scrollForOpened(opened, keep, viewport);
    if (target != null) {
      scroller.scrollTo({ left: target, behavior: 'smooth' });
      moved = true;
    }
    // The working panel went past an edge (the scroll, or the panels inserted before it): that edge's chip pulses.
    const side = sideOf(keep, viewport, target ?? viewport.scrollLeft);
    if (side) scroller.dispatchEvent(new CustomEvent(PANEL_ROW_PULSE_EVENT, { detail: side }));
  }
  return moved;
}

/**
 * A panel in a row that scrolls sideways (the docking policy, utils/panelRowLayout.ts) and isn't in view: scroll it
 * into view (keeping the panel the user works in when both fit). False when it is already in view (or not in such a row).
 */
export function scrollPanelIntoRow(panelId: string): boolean {
  return scrollRowsForOpened([panelId]);
}

/**
 * An explicit request to show an open panel (opening it again, Edit filters…, the
 * tour): bring it forward if it is behind another tab, and slide a tucked drawer
 * back out even when it is already the drawer's active tab.
 */
export function revealDrawerPanel(panelId: string): void {
  const inDrawer = useDrawerTabsStore.getState().inDrawer.includes(panelId);
  showDrawerPanel(panelId);
  if (!inDrawer) scrollPanelIntoRow(panelId);
  if (inDrawer) useDrawerTabsStore.setState(state => ({ revealCount: state.revealCount + 1 }));
}
