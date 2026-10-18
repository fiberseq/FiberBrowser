import './persistence';
import { useContext, useMemo } from 'react';
import { PanelDisplayContext } from '../../hooks/usePanelDisplayStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useLiveLiftStore } from './store';
import { liveLiftViewKey } from './persistence';
import { makeAxis, type LiveLiftExpansion } from './axis';
const EMPTY: LiveLiftExpansion[] = [];

/** Sibling native panels opt in only while a live-lift dataset is actually in
 * this view. Restored expansion state cannot distort unrelated panels. */
export function useLiveLiftAxis(chrom: string, start: number, end: number, width: number, reversed: boolean) {
  const panelId = useContext(PanelDisplayContext);
  const enabled = useLiveLiftStore(s => s.enabled);
  const panel = useBrowserStore(s => s.panels.find(p => p.id === panelId));
  const viewKey = liveLiftViewKey(panel);
  const active = useBrowserStore(s => s.panels.some(p => liveLiftViewKey(p) === viewKey
    && s.datasets.some(d => d.id === p.datasetId && d.data_type === 'bam_livelift')));
  const saved = useBrowserStore(s => s.liveLiftExpansions?.[viewKey] ?? EMPTY);
  const axis = useMemo(() => makeAxis(start, end, width, reversed,
    enabled && active ? saved.filter(e => e.chrom === chrom) : EMPTY), [start, end, width, reversed, enabled, active, saved, chrom]);
  return { axis, viewKey, panelId, panel };
}
