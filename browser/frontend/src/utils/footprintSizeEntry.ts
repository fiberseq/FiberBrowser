/**
 * The ways to the footprint size plots, all in Plots (the Clusters panel's own Footprint sizes tab and its size
 * buttons were retired in 3.1.1): the read menu ("Footprint size enrichment here"), ⌘K ("size enrichment",
 * "footprint sizes", "V-plot") and the Clusters panel's "Footprint sizes → Plots". Each opens Plots on Size
 * enrichment (or V-plot), one plot per cluster when there are clusters (pinned to the clustered locus, where the
 * clusters belong), else one per dataset from all reads in view. None needs clustering.
 */
import { getStateKeyMap, getTargetDatasetIds, useBrowserStore } from '../stores/browserStore';
import { openPlots } from '../features/plots/workspace';
import type { PlotLocus } from '../features/plots/plotModel';
import { clusterChartScope } from '../components/controls/cluster-detail/clusterChartScope';
import { activePanelView, type PanelView } from './panelScope';
import type { FootprintSizeView } from './footprintSizeSettings';

const locusOf = (v: PanelView): PlotLocus => ({ chrom: v.chrom, start: Math.round(v.start), end: Math.round(v.end), genome: v.genome ?? null });

/** The clustered state keys Plots groups by (usePlotTargets): the focused panels' keys with assignments, live-lifted
 *  datasets left out. */
function plottableClusteredKeys(s: ReturnType<typeof useBrowserStore.getState>): string[] {
  const keyMap = getStateKeyMap(s.selectedDatasets, s.panels, s.datasets);
  const keys: string[] = [];
  for (const dsId of getTargetDatasetIds(s.selectedDatasets, s.panels, s.datasets)) {
    for (const sk of keyMap[dsId] ?? [dsId]) if (!keys.includes(sk)) keys.push(sk);
  }
  return keys.filter(sk => {
    const dsId = Object.entries(keyMap).find(([, sks]) => sks.includes(sk))?.[0] ?? sk;
    const ds = s.datasets.find(d => d.id === dsId);
    return Boolean(ds) && ds!.data_type !== 'bam_livelift' && Object.keys(s.clusterAssignments?.[sk] ?? {}).length > 0;
  });
}

/**
 * Open Plots on the footprint size plots in `view` (default: Size enrichment). `panelId`: the panel a "here" request
 * came from (its view is plotted). `clusterLocus`: the clustered locus as the Clusters panel shows it (else worked
 * out from the store, as Plots does). `byDataset`: one plot per dataset even if other panels are clustered (the
 * Clusters panel showing no clusters for the panels in focus).
 */
export function openFootprintSizes(options: { view?: FootprintSizeView; panelId?: string | null; clusterLocus?: PlotLocus | null; byDataset?: boolean } = {}): boolean {
  const s = useBrowserStore.getState();
  const type = options.view === 'vplot' ? 'vplot' : 'size-enrichment';
  const clustered = options.byDataset ? [] : plottableClusteredKeys(s);
  // A "here" request plots that panel (its datasets and clusters, at its view); Plots is told which panel it was.
  const panelId = options.panelId && s.panels.some(p => p.id === options.panelId && p.contentType === 'dataset') ? options.panelId : null;
  const askedPanel = panelId ? s.panels.find(p => p.id === panelId) : undefined;
  const askedKey = askedPanel ? (askedPanel.stateKey ?? askedPanel.datasetId ?? null) : null;
  const askedClustered = !askedKey || Object.keys(s.clusterAssignments?.[askedKey] ?? {}).length > 0;
  const scoped = panelId ? { panel: panelId } : {};
  // Clusters: when the asking panel is clustered (or, asked from nowhere in particular, any panel in focus is).
  if (clustered.length && askedClustered) {
    const keys = askedKey && !clustered.includes(askedKey) ? [askedKey, ...clustered] : clustered;
    const scope = clusterChartScope(s, keys, panelId);
    const pinned = options.clusterLocus ?? (scope.keys.length ? locusOf(scope.view) : null);
    if (pinned) return openPlots({ type, where: 'view', groupBy: 'cluster', pinned, ...scoped });
  }
  // By dataset: follows the browser's view, or pinned to the asking panel's own view when it shows another.
  const asked = panelId ? activePanelView(s, panelId) : null;
  return openPlots({ type, where: 'view', groupBy: 'dataset', pinned: asked && !asked.followsMain ? locusOf(asked) : null, ...scoped });
}
