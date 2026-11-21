import { createContext, useContext, useRef } from 'react';
import { useBrowserStore, type BrowserState } from '../stores/browserStore';

export const PanelDisplayContext = createContext<string | null>(null);

/**
 * Whether the panel is on screen. Full view keeps every panel mounted (leaving it needs no remount and no refetch) but
 * hides all panels except the maximised one: those are inactive. An inactive panel suspends its work: its tracks see
 * the store as it was when it was hidden (no new view to load, nothing new to draw), its data effects start no
 * requests, its analyses ask nothing and start no automatic Analyse. When it is shown again it catches up once with
 * the latest state; with nothing changed meanwhile, nothing is asked again.
 */
export const PanelActiveContext = createContext<boolean>(true);
export const usePanelActive = () => useContext(PanelActiveContext);

/** The value as it was when the panel was hidden, while it is inactive; the live value otherwise. */
export function useFrozenWhileInactive<T>(value: T): T {
  const active = useContext(PanelActiveContext);
  const last = useRef(value);
  if (active) last.current = value;
  return active ? value : last.current;
}

/** Full view shown in place: one panel maximised over the others, which stay mounted, hidden and inactive (figure
 * renders and exports lay the maximised panel out alone instead). */
export function fullViewHidesOthers(s: Pick<BrowserState, 'fullViewPanelId' | 'exportInProgress' | 'panels'>): boolean {
  return Boolean(s.fullViewPanelId) && !s.exportInProgress
    && !(typeof window !== 'undefined' && (window as { __FIBERBROWSER_RENDER_MODE?: boolean }).__FIBERBROWSER_RENDER_MODE)
    && s.panels.some(p => p.id === s.fullViewPanelId);
}

export function panelReversed(s: Pick<BrowserState, 'panels' | 'navigationMode' | 'isReversed'>, panelId: string | null): boolean {
  const panel = panelId ? s.panels.find(p => p.id === panelId) : undefined;
  // A live-lift source panel is drawn relative to the main view's orientation (flipped on a '-' correspondence).
  if (panel?.liftLink) return s.isReversed !== Boolean(panel.liftLink.flip);
  return s.navigationMode === 'perPanel' && panel ? panel.reversed ?? s.isReversed : s.isReversed;
}

/** Track selectors see their panel's orientation, including plugin tracks; an inactive panel's selectors keep the
 * values they had when it was hidden (PanelActiveContext). */
function useDisplayStore<T>(selector: (s: BrowserState) => T): T {
  const panelId = useContext(PanelDisplayContext);
  const active = useContext(PanelActiveContext);
  const held = useRef<{ v: T } | null>(null);
  const v = useBrowserStore(s => {
    if (!active && held.current) return held.current.v;
    const isReversed = panelReversed(s, panelId);
    return selector(isReversed === s.isReversed ? s : { ...s, isReversed });
  });
  if (active || !held.current) held.current = { v };
  return v;
}
export const usePanelDisplayStore = Object.assign(useDisplayStore, useBrowserStore);
