import { createContext, useContext } from 'react';
import { useBrowserStore, type BrowserState } from '../stores/browserStore';

export const PanelDisplayContext = createContext<string | null>(null);

export function panelReversed(s: Pick<BrowserState, 'panels' | 'navigationMode' | 'isReversed'>, panelId: string | null): boolean {
  const panel = panelId ? s.panels.find(p => p.id === panelId) : undefined;
  // A live-lift source panel is drawn relative to the main view's orientation (flipped on a '-' correspondence).
  if (panel?.liftLink) return s.isReversed !== Boolean(panel.liftLink.flip);
  return s.navigationMode === 'perPanel' && panel ? panel.reversed ?? s.isReversed : s.isReversed;
}

/** Track selectors see their panel's orientation, including plugin tracks. */
function useDisplayStore<T>(selector: (s: BrowserState) => T): T {
  const panelId = useContext(PanelDisplayContext);
  return useBrowserStore(s => {
    const isReversed = panelReversed(s, panelId);
    return selector(isReversed === s.isReversed ? s : { ...s, isReversed });
  });
}
export const usePanelDisplayStore = Object.assign(useDisplayStore, useBrowserStore);
