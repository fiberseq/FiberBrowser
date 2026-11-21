/**
 * Panel-defined plots (Plots "From panels", ⌘K): the plots that stay in their panels because a panel's run computes
 * them. Each entry opens its panel, and, where the panel offers "Open in Plots" (supplied cards), opens the newest
 * such card in the Gallery.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { openEntry } from './galleryActions';
import { useGalleryStore } from './gallery';
import { setWorkspace } from './workspace';

export interface PanelPlot {
  id: string;
  label: string;
  /** The analysis panel's content type. */
  panel: string;
  panelLabel: string;
  description: string;
  /** Supplied cards made from it carry this origin prefix (null: it has no Open in Plots yet). */
  origin: string | null;
}

export const PANEL_PLOTS: readonly PanelPlot[] = [
  { id: 'fp-class-prevalence', label: 'Footprint class prevalence', panel: 'footprint-analysis', panelLabel: 'Footprints', description: 'Classes of a Find classes run and their prevalence per dataset.', origin: null },
  { id: 'fp-class-composition', label: 'Class composition and co-occurrence', panel: 'footprint-analysis', panelLabel: 'Footprints', description: 'Class co-occurrence on molecules (the upset-style composition and pair tables).', origin: null },
  { id: 'fp-sizes', label: 'Footprint sizes of a class', panel: 'footprint-analysis', panelLabel: 'Footprints', description: 'The size histogram of the reads at a footprint (Sizes tab).', origin: 'Footprints › Sizes' },
  { id: 'fp-class-vplot', label: 'Saved class V-plot', panel: 'footprint-analysis', panelLabel: 'Footprints', description: 'Footprint midpoints by size around a saved class.', origin: 'Footprints › Saved class V-plot' },
  { id: 'nfr-widths', label: 'NFR opening widths', panel: 'accessibility', panelLabel: 'NFR', description: 'Opening widths per variant of an NFR run.', origin: 'NFR › Opening widths' },
  { id: 'nfr-vplots', label: 'NFR V-plots per variant', panel: 'accessibility', panelLabel: 'NFR', description: 'Openings by width and position, per variant.', origin: 'NFR › V-plots' },
  { id: 'nfr-classes', label: 'NFR classes, pairs and prevalence', panel: 'accessibility', panelLabel: 'NFR', description: 'NFR variant classes, element arcs, pair tests and prevalence.', origin: null },
  { id: 'nuc-scores', label: 'Nucleosome regularity: score distribution', panel: 'nucleosomes', panelLabel: 'Nucleosomes', description: 'Tile scores against the random-packing reference.', origin: 'Nucleosomes › Score distribution' },
  { id: 'nuc-track', label: 'Nucleosome regularity along the region', panel: 'nucleosomes', panelLabel: 'Nucleosomes', description: 'Mean score (or period) by position.', origin: 'Nucleosomes › Along the region' },
  { id: 'nuc-periods', label: 'Local repeat length', panel: 'nucleosomes', panelLabel: 'Nucleosomes', description: 'The tiles\' spectral periods.', origin: 'Nucleosomes › Local repeat length' },
  { id: 'nuc-acf', label: 'm6A autocorrelation', panel: 'nucleosomes', panelLabel: 'Nucleosomes', description: 'Masked m6A autocorrelation per series.', origin: 'Nucleosomes › m6A autocorrelation' },
  { id: 'nuc-patches', label: 'Patch lengths and share in a patch', panel: 'nucleosomes', panelLabel: 'Nucleosomes', description: 'Regularity patches: lengths and share along the locus.', origin: 'Nucleosomes › Patch lengths' },
  { id: 'nuc-geometries', label: 'Shared geometries', panel: 'nucleosomes', panelLabel: 'Nucleosomes', description: 'Shared regularity geometries: map, member stack, nested pairs.', origin: null },
  { id: 'read-stats', label: 'Read stats distributions', panel: 'read-stats', panelLabel: 'Read stats', description: 'Accessibility, footprints per read, sizes, length, MAPQ, modification.', origin: 'Read stats' },
  { id: 'cluster-composition', label: 'Cluster composition and differences', panel: 'cluster-detail', panelLabel: 'Clusters', description: 'Clusters per dataset with Wilson intervals, Fisher tests and differences.', origin: null },
];

/** The newest Gallery card a panel plot supplied, if any. */
export function latestSuppliedCard(p: PanelPlot): string | null {
  if (!p.origin) return null;
  const entries = useGalleryStore.getState().entries;
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].plot.supplied?.origin?.startsWith(p.origin)) return entries[i].id;
  return null;
}

export function openPanelPlot(p: PanelPlot): void {
  setWorkspace('browser');
  useBrowserStore.getState().openAnalysisPanel(p.panel as never);
}

export function openPanelPlotCard(p: PanelPlot): boolean {
  const id = latestSuppliedCard(p);
  if (!id) return false;
  openEntry(id);
  setWorkspace('plots');
  return true;
}
