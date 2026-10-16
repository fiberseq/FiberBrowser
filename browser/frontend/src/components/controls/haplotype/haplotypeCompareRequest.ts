import { create } from 'zustand';
import { useBrowserStore } from '../../../stores/browserStore';
import type { PanelConfig } from '../../../types';
import { detectHaplotypePairs } from '../../../utils/haplotypePairs';

/** A request to fill in the haplotype comparison form (from a dataset's ⋯ menu). */
export interface HaplotypeCompareRequest {
  chrom1: string;
  chrom2: string;
  region: string;
  seq: number;
}

interface RequestState {
  request: HaplotypeCompareRequest | null;
  set: (request: HaplotypeCompareRequest | null) => void;
}

export const useHaplotypeCompareRequest = create<RequestState>(set => ({
  request: null,
  set: request => set({ request }),
}));

let seq = 0;

/** The chromosome paired with `chrom` in the loaded reference, if there is one. */
export function haplotypePartner(chrom: string, chromNames: string[]): string {
  for (const pair of detectHaplotypePairs(chromNames)) {
    if (pair.chrom1 === chrom) return pair.chrom2;
    if (pair.chrom2 === chrom) return pair.chrom1;
  }
  return '';
}

/**
 * Open the Regions panel on Compare haplotypes, with View 1 on the panel's
 * chromosome, View 2 on its detected partner and the panel's coordinates.
 */
export function openHaplotypeCompare(panel?: PanelConfig) {
  const state = useBrowserStore.getState();
  const view = panel?.viewportOverride ?? { chrom: state.chrom, start: state.start, end: state.end };
  const chromNames = state.chroms.map(c => c.name);
  // The form takes unsigned coordinates (a circular view can start below 0).
  const start = Math.max(0, Math.round(view.start));
  const end = Math.max(start + 1, Math.round(view.end));
  useHaplotypeCompareRequest.getState().set({
    chrom1: view.chrom,
    chrom2: haplotypePartner(view.chrom, chromNames),
    region: `${view.chrom}:${start.toLocaleString('en-US')}-${end.toLocaleString('en-US')}`,
    seq: ++seq,
  });
  state.openAnalysisPanel('circular-genome');
  // Make sure Regions is on screen: leave a maximized panel, open its row.
  const after = useBrowserStore.getState();
  const regions = after.panels.find(p => p.contentType === 'circular-genome');
  if (after.fullViewPanelId && after.fullViewPanelId !== regions?.id) after.setFullViewPanel(null);
  const row = regions ? (regions.layoutRow ?? 0) : null;
  if (row != null && after.collapsedRows.has(row)) after.toggleRowCollapsed(row);
}
