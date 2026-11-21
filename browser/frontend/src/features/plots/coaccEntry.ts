/**
 * Co-accessibility lives in Plots (3.1.0: the Co-accessibility panel moved into Plots). Every old entry point (the
 * panel's ⌘K item and rail tile, track menus, Footprints → Co-occupancy, Export data, links and scripts that open the
 * 'co-accessibility' panel) opens a Plots co-accessibility plot of the current view on the co-accessibility settings
 * (stores/coaccStore, which the track under the reads also draws on). A session saved with the panel open restores
 * the plot as the builder's working plot (the panel is dropped, nothing else changes).
 */
import { useBrowserStore } from '../../stores/browserStore';
import { useCoaccStore } from '../../stores/coaccStore';
import { registerPanelMigration, registerRetiredPanel } from '../../plugins/registry';
import { newPlot, normalizeCoaccSettings, type PlotSpec } from './plotModel';
import { openPlots } from './workspace';

export const RETIRED_COACC_PANEL = 'co-accessibility';

/** A co-accessibility plot of the view on the co-accessibility settings (pooled for one dataset, per dataset otherwise). */
export function coaccPlotFromStore(): Partial<PlotSpec> {
  const c = useCoaccStore.getState();
  const datasets = useBrowserStore.getState().datasets ?? [];
  return {
    type: 'co-accessibility', where: 'view', groupBy: datasets.length > 1 ? 'dataset' : 'none',
    coacc: normalizeCoaccSettings({ normalization: c.coaccNormalization, signalType: c.coaccSignalType, layer: c.coaccLayer, binBp: c.coaccBinSize,
      minCoverage: c.coaccMinCoverage, scaling: c.coaccScaling }),
  };
}

/** Open Plots on a co-accessibility plot of the current view. */
export function openCoaccPlot(): boolean {
  return openPlots(coaccPlotFromStore());
}

/** A session (or snapshot) with the panel open: the panel goes and the builder holds the co-accessibility plot, once the
 *  restore has applied the session's co-accessibility settings. */
export function migrateCoaccPanel(panel: { contentType: string }): [] | null {
  if (panel.contentType !== RETIRED_COACC_PANEL) return null;
  setTimeout(() => {
    const st = useBrowserStore.getState();
    if (st.plotsWorkspace.current.type === 'co-accessibility') return;
    st.setPlotsWorkspace(ws => ({ ...ws, current: newPlot(coaccPlotFromStore()), openedFrom: null }));
  }, 0);
  return [];
}

let registered = false;
/** Called once from features/plots/register. */
export function registerCoaccEntry(): void {
  if (registered) return;
  registered = true;
  registerRetiredPanel(RETIRED_COACC_PANEL, openCoaccPlot);
  registerPanelMigration(panel => migrateCoaccPanel(panel));
}
