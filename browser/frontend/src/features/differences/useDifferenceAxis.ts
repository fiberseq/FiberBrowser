import '../liveLift/persistence';
import { useContext, useMemo } from 'react';
import { PanelDisplayContext } from '../../hooks/usePanelDisplayStore';
import { useBrowserStore } from '../../stores/browserStore';
import { liveLiftViewKey } from '../liveLift/persistence';
import { makeAxis, type DifferenceExpansion } from './axis';
const EMPTY: DifferenceExpansion[] = [];

/** Columns belong to a saved reference/view, independent of source availability. */
export function useDifferenceAxis(chrom: string, start: number, end: number, width: number, reversed: boolean) {
  const panelId = useContext(PanelDisplayContext);
  const panel = useBrowserStore(s => s.panels.find(p => p.id === panelId));
  const viewKey = liveLiftViewKey(panel);
  const saved = useBrowserStore(s => s.liveLiftExpansions?.[viewKey] ?? EMPTY);
  const referenceScope = panel?.genome ?? 'main-reference';
  const axis = useMemo(() => makeAxis(start, end, width, reversed,
    saved.filter(e => e.chrom === chrom && (e.referenceScope ?? 'main-reference') === referenceScope)),
    [start, end, width, reversed, saved, chrom, referenceScope]);
  return { axis, viewKey, panelId, panel };
}
