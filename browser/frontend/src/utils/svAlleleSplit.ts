/**
 * "Split by this SV" (fb-n9-sv): group a panel's reads in view by one SV's
 * allele (0 carriers, 1 reference, 2 not informative) through the existing
 * cluster machinery, so everything downstream works per group. The server
 * classifies every read in view (not only the display sample):
 * POST /api/sv/split.
 */
import { fetchJson } from '../api/sharedFetch';
import { useBrowserStore } from '../stores/browserStore';
import { useSplitPanelStore } from '../stores/splitPanelStore';
import type { SvSplitDef } from '../stores/svSlice';
import { SV_SPAN_MARGIN, svAlleleLabel } from '../components/tracks/read-track/svDrawing';
import type { SvCluster } from '../components/tracks/read-track/types';

export const SV_GROUP_LABELS: Record<number, string> = { 0: 'Carriers', 1: 'Reference', 2: 'Not informative' };

export interface SvSplitResponse {
  assignments: Record<string, number>;
  counts: [number, number, number];
  label: string;
  margin: number;
}

export interface SvSplitTarget {
  stateKey: string;
  datasetId: string;
  chrom: string;
  viewStart: number;
  viewEnd: number;
}

export function requestSvSplit(target: SvSplitTarget, sv: Pick<SvCluster, 't' | 'ref' | 'len'>, margin = SV_SPAN_MARGIN, signal?: AbortSignal): Promise<SvSplitResponse> {
  return fetchJson<SvSplitResponse>('/api/sv/split', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataset_id: target.datasetId, chrom: target.chrom, start: Math.floor(target.viewStart), end: Math.ceil(target.viewEnd),
      t: sv.t, ref: sv.ref, len: sv.len, margin,
      // Reads the panel shows: duplicates too when they are on (else they'd get no group).
      include_duplicates: Boolean(useBrowserStore.getState().showDuplicateReads),
    }),
    signal,
  });
}

export function svSplitDef(target: SvSplitTarget, sv: Pick<SvCluster, 't' | 'ref' | 'len'>, response: SvSplitResponse): SvSplitDef {
  return {
    datasetId: target.datasetId, chrom: target.chrom, t: sv.t, ref: sv.ref, len: sv.len,
    end: sv.t === 'D' ? sv.ref + sv.len : sv.ref,
    margin: response.margin ?? SV_SPAN_MARGIN,
    label: svAlleleLabel(sv.t, sv.ref, sv.len, target.chrom),
    counts: response.counts,
    viewStart: target.viewStart, viewEnd: target.viewEnd,
    includeDuplicates: Boolean(useBrowserStore.getState().showDuplicateReads),
  };
}

/** Put a split's groups in the store, as a clustering run would (one undo step). */
export function applySvSplit(stateKey: string, def: SvSplitDef, assignments: Record<string, number>): void {
  const store = useBrowserStore.getState();
  store.setClusterAssignments(stateKey, assignments, { svSplit: true });
  store.setClusterOrder(stateKey, [0, 1, 2]);
  store.setClusterFocus(stateKey, null);
  store.clearClusterSelection(stateKey);
  // An allele is not an accessibility pattern: never re-derived on pan.
  store.setDynamicClustering(false);
  store.setClusterPatterns({});
  store.setClusterCentroids({}, []);
  store.setClusterPeakRegions([]);
  store.setSvSplit(stateKey, def, SV_GROUP_LABELS);
  store.pushSnapshot(`Split by SV allele: ${def.label}`);
}

export async function splitBySv(target: SvSplitTarget, sv: Pick<SvCluster, 't' | 'ref' | 'len'>): Promise<SvSplitDef> {
  const response = await requestSvSplit(target, sv);
  const def = svSplitDef(target, sv, response);
  applySvSplit(target.stateKey, def, response.assignments);
  return def;
}

/**
 * "Split into panels by this SV": the panel's reads grouped by the SV's allele, then straight to the
 * panel-count dialog for one panel per group (Carriers / Reference / Not informative; an insertion's
 * Carriers open with the insert expanded, components/controls/SplitPanelsDialog.tsx).
 */
export async function splitIntoPanelsBySv(target: SvSplitTarget, sv: Pick<SvCluster, 't' | 'ref' | 'len'>, panelId: string): Promise<SvSplitDef> {
  const def = await splitBySv(target, sv);
  useSplitPanelStore.getState().request({ kind: 'frozen', panelId, title: def.label }, [panelId]);
  return def;
}

/**
 * The reads of a new view, classified for an active split and merged into
 * its groups (reads that left the view keep theirs). Not an undo step.
 */
export async function refreshSvSplit(target: SvSplitTarget, def: SvSplitDef, signal?: AbortSignal): Promise<void> {
  const response = await requestSvSplit(target, def, def.margin, signal);
  const store = useBrowserStore.getState();
  if (store.svSplits[target.stateKey] !== def) return;  // replaced or dropped meanwhile
  const merged = { ...(store.clusterAssignments[target.stateKey] ?? {}), ...response.assignments };
  const counts: [number, number, number] = [0, 0, 0];
  for (const group of Object.values(merged)) if (group >= 0 && group <= 2) counts[group] += 1;
  store.setClusterAssignments(target.stateKey, merged, { svSplit: true, mirror: false });
  store.setSvSplit(target.stateKey, {
    ...def, counts, viewStart: target.viewStart, viewEnd: target.viewEnd,
    includeDuplicates: Boolean(store.showDuplicateReads),
  }, SV_GROUP_LABELS);
}

/** "Clear SV split": this panel's groups, names and split go (one undo step); other panels keep theirs. */
export function clearSvSplit(stateKey: string): void {
  const store = useBrowserStore.getState();
  if (!store.svSplits[stateKey]) return;
  store.setClusterAssignments(stateKey, {});
  store.setClusterOrder(stateKey, []);
  store.setClusterFocus(stateKey, null);
  store.clearClusterSelection(stateKey);
  store.setSvSelectedCluster(stateKey, null);
  store.pushSnapshot('Clear SV split');
}
