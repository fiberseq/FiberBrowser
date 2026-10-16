import type { BrowserState } from '../../stores/browserStore';
import { datasetPanelView, targetPanelView } from '../../utils/panelScope';
import { clusterWindows } from '../../utils/clusterTargets';
import type { ScanTarget } from './api';

/** A dataset can have several views: scan the selected one, retaining its reference and read cohort. */
export function variantScanTarget(s: BrowserState, datasetId: string, panelId?: string): ScanTarget {
  const view = panelId ? targetPanelView(s, panelId) : datasetPanelView(s, datasetId);
  const own = clusterWindows({ ...s, panels: s.panels.filter(p => p.id === view.panelId), selectedDatasets: new Set() }, [datasetId])[0];
  return {
    datasetId, chrom: view.chrom, start: Math.floor(view.start), end: Math.ceil(view.end),
    ...(view.genome ? { genome: view.genome } : {}),
    ...(own?.read_ids !== undefined ? { readIds: own.read_ids, panelKey: own.result_key } : {}),
  };
}


/**
 * The panel the SVs tab lists SVs for: the dataset's selected panel or, when that is a "Split into panels" panel, the
 * panel it was split from (all the reads the split was made from). After a split by an SV the selected panel is the
 * Reference one (no carriers) or the Carriers opened with the insert expanded (a dataset of its own, without the
 * insertion): either way the tab still lists the SV that was split and its carriers.
 */
export function svSourcePanel(s: BrowserState, datasetId: string): { datasetId: string; panelId: string } | null {
  const own = s.panels.find(p => p.id === datasetPanelView(s, datasetId).panelId);
  let panel = own;
  const seen = new Set<string>();
  while (panel?.readSubset && !seen.has(panel.id)) {
    seen.add(panel.id);
    const source = s.panels.find(p => p.id === panel!.readSubset!.sourcePanelId && p.contentType === 'dataset' && p.datasetId);
    if (!source) return null;
    panel = source;
  }
  return panel && panel !== own && panel.datasetId ? { datasetId: panel.datasetId, panelId: panel.id } : null;
}

/** What the SVs tab scans: a split panel's source panel, all its reads at its locus; else as variantScanTarget. */
export function svScanTarget(s: BrowserState, datasetId: string): ScanTarget {
  const source = svSourcePanel(s, datasetId);
  if (!source) return variantScanTarget(s, datasetId);
  const view = targetPanelView(s, source.panelId);
  return {
    datasetId: source.datasetId, chrom: view.chrom, start: Math.floor(view.start), end: Math.ceil(view.end),
    ...(view.genome ? { genome: view.genome } : {}),
  };
}


/** Read predicates and replaced source files must not share a cached scan. */
export function variantScanIdentity(s: BrowserState, datasetId: string): string {
  const dataset = s.datasets.find(d => d.id === datasetId);
  return JSON.stringify([dataset?.source_identity ?? dataset?.paths ?? dataset?.path ?? '', s.fastaPath ?? '', s.signalFilters]);
}
