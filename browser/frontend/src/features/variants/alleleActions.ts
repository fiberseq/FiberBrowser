/**
 * The Variants panel's two ways to use an allele grouping: open the split dialog, or group the dataset's read panel.
 */
import { groupByAlleles, type AlleleGrouping, type AlleleRequest, type SnpParams, type SnpScan } from './api';
import { useBrowserStore } from '../../stores/browserStore';
import { groupInPanel } from './variantSplit';
import { panelForDataset } from './useSnpScan';

/** Reads by allele at the scan's view (the same reads the scan counted). */
export function fetchGrouping(scan: SnpScan, params: SnpParams, duplicates: boolean, request: AlleleRequest,
  signal?: AbortSignal): Promise<AlleleGrouping> {
  const r = scan.region;
  return groupByAlleles(scan.target ?? { datasetId: scan.dataset_id, chrom: r.chrom, start: r.start, end: r.end }, params, duplicates, request, signal);
}

/** "Group in this panel": a notice for the panel, or why not. */
export function groupDatasetPanel(grouping: AlleleGrouping, title: string, panelId?: string): string {
  // `panelId`: the panel whose view the grouping was read in (SVs: svComboPanel); else the dataset's own panel.
  const panels = useBrowserStore.getState().panels;
  const panel = (panelId ? panels.find(p => p.id === panelId) : undefined) ?? panelForDataset(panels, grouping.dataset_id);
  if (!panel) return 'Open a read panel of this dataset first.';
  const stateKey = panel.stateKey ?? panel.datasetId ?? panel.id;
  groupInPanel(grouping, grouping.dataset_id, stateKey, title);
  const shown = grouping.groups.filter(g => g.count > 0).map(g => `${g.label} ${g.count.toLocaleString()}`).join(', ');
  return `Grouped the reads by ${title}: ${shown}.`;
}
