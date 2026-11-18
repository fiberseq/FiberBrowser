/**
 * The ways to the footprint size plots (Clusters › Charts › Footprint sizes), all one click to the paper-style
 * Size enrichment view: the read menu ("Footprint size enrichment here"), ⌘K ("size enrichment", "footprint
 * sizes", "V-plot"), the Cluster toolbar's Footprint sizes button and the Clusters panel itself. None needs
 * clustering: without clusters the plots use every read in view, one per dataset.
 */
import { create } from 'zustand';
import { useBrowserStore } from '../stores/browserStore';
import { openPanelOnTab } from './analysisCommands';
import { withView, type FootprintSizeView } from './footprintSizeSettings';

/** The panel a "here" request came from (its view is the one plotted); not saved. */
export const useFootprintSizesInvokedFrom = create<{ panelId: string | null; set: (panelId: string | null) => void }>(set => ({
  panelId: null,
  set: panelId => set({ panelId }),
}));

/** Show the footprint size plots in `view` (default: Size enrichment), for the view of `panelId` when given. */
export function openFootprintSizes(options: { view?: FootprintSizeView; panelId?: string | null } = {}): boolean {
  const store = useBrowserStore.getState();
  store.setFootprintSizeSettings(withView(store.footprintSizeSettings, options.view ?? 'enrichment'));
  useFootprintSizesInvokedFrom.getState().set(options.panelId ?? null);
  openPanelOnTab('cluster-detail', 'vplot');
  return true;
}
