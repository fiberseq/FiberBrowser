/**
 * Showing a dataset that is open but not on screen, and the panels a closed group leaves behind.
 *
 * A dataset can stay open with no panel in view: its panel folded away by a split (or a haplotype or
 * contact-region comparison) whose panels were then closed one by one, minimized, behind another
 * panel's full view, or in a collapsed row. Opening it again (the Library's Open) shows that panel
 * instead of doing nothing.
 */
import { useBrowserStore } from '../stores/browserStore';
import type { Dataset, PanelConfig } from '../types';
export { restoreOrphanSplitSources } from '../stores/splitSources';
import { withoutGraphFold } from '../stores/graphMembership';

/** The dataset panel that stands for a dataset: its main-view one, else any of its plain panels, else any. */
export function mainDatasetPanel(panels: PanelConfig[], datasetId: string): PanelConfig | undefined {
  const own = panels.filter(p => p.contentType === 'dataset' && p.datasetId === datasetId);
  return own.find(p => !p.readSubset && !p.viewportOverride)
    ?? own.find(p => !p.readSubset)
    ?? own[0];
}

/** Whether a dataset has a panel on screen now. */
export function datasetPanelShown(datasetId: string): boolean {
  const s = useBrowserStore.getState();
  const visible = (p: PanelConfig) => p.contentType === 'dataset' && p.datasetId === datasetId && !p.collapsed
    && (!s.fullViewPanelId || s.fullViewPanelId === p.id) && !s.collapsedRows.has(p.layoutRow ?? 0);
  return s.panels.some(visible);
}

/**
 * Show an open dataset's panel: unfold it (whatever folded it), leave another panel's full view,
 * open its row; a dataset with no panel left gets a new one. Returns the panel's id.
 */
export function revealDatasetPanel(dataset: Dataset): string | null {
  const store = useBrowserStore.getState();
  if (!store.datasets.some(d => d.id === dataset.id)) store.addDataset(dataset);
  let panel = mainDatasetPanel(useBrowserStore.getState().panels, dataset.id);
  if (!panel) {
    // Open but every panel of it closed: a new panel (addDataset adds one when it has none).
    useBrowserStore.setState(s => ({ datasets: s.datasets.filter(d => d.id !== dataset.id) }));
    useBrowserStore.getState().addDataset(dataset);
    panel = mainDatasetPanel(useBrowserStore.getState().panels, dataset.id);
    if (!panel) return null;
  }
  const id = panel.id;
  useBrowserStore.setState(s => {
    const panels = s.panels.map(p => {
      if (p.id !== id) return p;
      const { collapsedBySplitGroup: _a, collapsedByHaplotypeGroup: _b, collapsedByContactRegionGroup: _c, ...rest } = withoutGraphFold(p);
      return { ...rest, collapsed: false };
    });
    const row = panel!.layoutRow ?? 0;
    const collapsedRows = s.collapsedRows.has(row) ? new Set([...s.collapsedRows].filter(r => r !== row)) : s.collapsedRows;
    return {
      panels,
      collapsedRows,
      fullViewPanelId: s.fullViewPanelId && s.fullViewPanelId !== id ? null : s.fullViewPanelId,
    };
  });
  // Bring it into view and mark it for a moment (after the layout renders it).
  if (typeof window !== 'undefined') {
    window.requestAnimationFrame?.(() => {
      const el = document.querySelector(`[data-panel-id="${id}"]`) as HTMLElement | null;
      el?.scrollIntoView?.({ block: 'nearest' });
      if (el) {
        el.dataset.revealed = 'true';
        window.setTimeout(() => { delete el.dataset.revealed; }, 1600);
      }
    });
  }
  return id;
}
