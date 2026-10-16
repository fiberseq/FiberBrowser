/**
 * A layout row that scrolls sideways (the scroll policy, utils/panelRowLayout.ts), with a cue at each edge that has
 * panels past it (usability audit round 2, N4): a fade, and a chip with the count ("◂ 3 panels" / "2 panels ▸") that
 * scrolls the nearest hidden panel into view. The cue is ours, not the scrollbar's, so it shows where scrollbars are
 * overlays that hide until you scroll (macOS) too.
 *
 * The chips sit in a slim band of their own over the panels (round 3, R1: at mid-height they covered panel content, such
 * as an away banner, the No-reads tips or a sparkline). After panels open, the chip on the side where the panel the user
 * worked in went pulses for a moment (round 3, R2: `PANEL_ROW_PULSE_EVENT`, from stores/drawerTabsStore.ts).
 *
 * `workedPanelHandlers` (on every layout row) note the panel the user works in (a click or focus inside a panel):
 * opening a panel then keeps that one in view when both fit (utils/panelRowScroll.ts, stores/drawerTabsStore.ts).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { noteWorkedPanel, PANEL_ROW_PULSE_EVENT, panelSpansIn, rowViewportOf } from '../../stores/drawerTabsStore';
import { offscreenPanels, panelCountLabel, scrollToReveal } from '../../utils/panelRowScroll';
import { ChevronLeft, ChevronRight } from '../ui/Icons';

/** The band over a scrolling row's panels that holds its edge chips (a 24-px chip and 1 px above and below). */
export const PANEL_ROW_CUE_BAND_HEIGHT = 26;
/** How long a chip pulses (outlasts a smooth scroll, so a chip that only appears when it ends pulses too). */
const PULSE_MS = 2400;

interface Hidden { left: string[]; right: string[] }
const NONE: Hidden = { left: [], right: [] };
const same = (a: Hidden, b: Hidden) => a.left.join('\0') === b.left.join('\0') && a.right.join('\0') === b.right.join('\0');

/** The panel a pointer or focus event happened in (a dataset or an analysis panel of this row). */
function panelOf(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-panel-id], [data-analysis-panel-id]') : null;
  return el?.dataset.panelId ?? el?.dataset.analysisPanelId ?? null;
}

/**
 * Handlers for a layout row (scrolling or not): a click or focus inside a panel makes it the one the user works in,
 * so a row that only starts to scroll when a panel opens still keeps it in view.
 */
export const workedPanelHandlers = {
  onPointerDownCapture: (e: { target: EventTarget | null }) => { const id = panelOf(e.target); if (id) noteWorkedPanel(id); },
  onFocusCapture: (e: { target: EventTarget | null }) => { const id = panelOf(e.target); if (id) noteWorkedPanel(id); },
};

export function PanelRowScroller({ height, rightInset = 0, bottomInset = 0, layoutKey, panelName, children }: {
  height: number;
  /** Visible width covered at the right (the pinned drawer over the row): the right cue sits left of it. */
  rightInset?: number;
  /** The scrollbar's room under the panels: the fades stay over the panels. */
  bottomInset?: number;
  /** Changes when the row's panels or widths do (the counts are measured again). */
  layoutKey: string;
  /** A panel's short name, for the cue's tooltip. */
  panelName: (id: string) => string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Hidden>(NONE);
  const [pulse, setPulse] = useState<'left' | 'right' | null>(null);
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    frame.current = null;
    const el = ref.current;
    if (!el) return;
    const off = offscreenPanels(panelSpansIn(el), rowViewportOf(el));
    const next = { left: off.left.map(s => s.id), right: off.right.map(s => s.id) };
    setHidden(prev => (same(prev, next) ? prev : next));
  }, []);
  const schedule = useCallback(() => {
    if (frame.current == null) frame.current = requestAnimationFrame(measure);
  }, [measure]);

  useLayoutEffect(() => { measure(); }, [measure, layoutKey, rightInset]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    if (el.lastElementChild) observer.observe(el.lastElementChild);
    return () => {
      observer.disconnect();
      if (frame.current != null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [schedule, layoutKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: number | undefined;
    const onPulse = (e: Event) => {
      const side = (e as CustomEvent<unknown>).detail;
      if (side !== 'left' && side !== 'right') return;
      setPulse(side);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPulse(null), PULSE_MS);
    };
    el.addEventListener(PANEL_ROW_PULSE_EVENT, onPulse);
    return () => { el.removeEventListener(PANEL_ROW_PULSE_EVENT, onPulse); window.clearTimeout(timer); };
  }, []);

  const reveal = (side: 'left' | 'right') => {
    const el = ref.current;
    if (!el) return;
    const target = scrollToReveal(panelSpansIn(el), rowViewportOf(el), side);
    if (target != null) el.scrollTo({ left: target, behavior: 'smooth' });
  };

  const cue = (side: 'left' | 'right') => {
    const ids = hidden[side];
    if (!ids.length) return null;
    const names = ids.map(panelName);
    const count = panelCountLabel(ids.length);
    const where = side === 'left' ? 'left' : 'right';
    return (
      <>
        <div aria-hidden="true" data-testid={`panel-row-fade-${side}`}
          className={`pointer-events-none absolute z-20 w-6 ${side === 'left'
            ? 'bg-gradient-to-r from-black/[0.14] to-transparent dark:from-black/50'
            : 'bg-gradient-to-l from-black/[0.14] to-transparent dark:from-black/50'}`}
          style={{ top: PANEL_ROW_CUE_BAND_HEIGHT, bottom: bottomInset, ...(side === 'left' ? { left: 0 } : { right: rightInset }) }} />
        <button type="button" data-testid={`panel-row-more-${side}`} data-count={ids.length}
          data-pulse={pulse === side ? 'true' : undefined}
          onClick={() => reveal(side)}
          aria-label={`${count} off-screen to the ${where}: ${names.join('; ')}. Show the nearest`}
          title={`Off-screen to the ${where}:\n${names.map(n => `• ${n}`).join('\n')}\nClick to show the nearest.`}
          className={`absolute top-px z-20 inline-flex h-6 items-center gap-0.5 whitespace-nowrap rounded-full border border-line bg-white px-1.5 text-[11px] font-medium text-ink shadow-sm hover:bg-blue-50 hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-white/15 dark:bg-dark-surface dark:text-gray-100 dark:hover:bg-blue-500/20 ${pulse === side ? 'fb-cue-pulse' : ''}`}
          style={side === 'left' ? { left: 4 } : { right: rightInset + 4 }}>
          {side === 'left' && <ChevronLeft size={12} aria-hidden="true" />}
          <span>{count}</span>
          {side === 'right' && <ChevronRight size={12} aria-hidden="true" />}
        </button>
      </>
    );
  };

  return (
    <>
      {/* The chips' band: nothing of the panels is under it. */}
      <div aria-hidden="true" data-testid="panel-row-cue-band" style={{ height: PANEL_ROW_CUE_BAND_HEIGHT }} />
      <div ref={ref} data-testid="panel-row-scroll" data-right-inset={rightInset || undefined}
        className="fb-panel-row-scroll overflow-x-auto overflow-y-hidden" style={{ height: Math.max(0, height - PANEL_ROW_CUE_BAND_HEIGHT) }}
        onScroll={schedule}>
        {/* One structure whether or not a drawer is pinned (the panels never remount when it comes or goes). A pinned
            drawer covers the row's right end: as much room again after the last panel, to scroll it out from under. */}
        <div className="flex w-max">
          <div>{children}</div>
          {rightInset > 0 && <div aria-hidden="true" className="shrink-0" style={{ width: rightInset }} data-testid="panel-row-drawer-room" />}
        </div>
      </div>
      {cue('left')}
      {cue('right')}
    </>
  );
}
