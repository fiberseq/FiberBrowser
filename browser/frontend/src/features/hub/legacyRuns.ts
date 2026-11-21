/** Frozen legacy job facades remain available when the analysis panel that loaded a run is closed. */
import { create } from 'zustand';
import { fetchJson } from '../../api/sharedFetch';
import { featureKey, type FeatureRef } from '../../stores/featureStore';
import type { BrowserState } from '../../stores/browserStore';
import { registerHubProvider, type HubView } from './hubState';
import { datasetGroups, overlapsView } from './providers';
import type { FeatureSet } from './types';

interface Mapping { hasStates?: boolean; note?: string; detail?: Record<string, unknown>; jobId: string; family: string; datasetId: string; setId: string; hitId: string; typeId: string;
  chrom: string; start: number; end: number; anchor: number; label: string; legacyRef: FeatureRef }
export interface LegacyRuns { runs: { kind: string; jobId: string; path: string; active: boolean; executionEngine?: string; mappings: Mapping[] }[]; problems: unknown[] }
export const useLegacyRuns = create<{ data: LegacyRuns }>(() => ({ data: { runs: [], problems: [] } }));
let generation = 0;
export function resetLegacyRuns(): void { generation++; useLegacyRuns.setState({ data: { runs: [], problems: [] } }); }
export function adoptLegacyRuns(data: unknown): void {
  if (data && Array.isArray((data as LegacyRuns).runs)) useLegacyRuns.setState({ data: data as LegacyRuns });
}
export async function refreshLegacyRuns(): Promise<void> {
  const born = generation;
  try { const data = await fetchJson<LegacyRuns>('/api/hub/legacy'); if (born === generation) adoptLegacyRuns(data); }
  catch { /* older servers continue serving their legacy panels */ }
}
export function legacySets(s: BrowserState, view: HubView): FeatureSet[] {
  const sets = new Map<string, FeatureSet>();
  for (const run of useLegacyRuns.getState().data.runs) for (const row of run.mappings) {
    if (!overlapsView(row.chrom, row.start, row.end, view)) continue;
    let set = sets.get(row.setId);
    if (!set) {
      set = { setId: row.setId, typeId: row.typeId, type: { typeId: row.typeId, module: `browser:${run.kind}`, label: row.typeId,
        plural: row.typeId, provides: row.hasStates === false ? ['hit'] : ['hit', 'state'], anchor: 'centre', zeroWidth: false, scores: [] },
        ...(row.note ? { note: row.note } : {}), frame: { kind: 'linear', chrom: row.chrom }, datasets: [], groups: [], coverage: { territory: 'regions' }, status: 'complete',
        source: { kind: 'inline', hits: [] }, provenance: { producer: 'browser', module: run.kind, inputs: [], units: 'regions',
          summary: run.executionEngine?.startsWith('scan:') ? 'Scan engine run' : 'Restored legacy run' } };
      sets.set(row.setId, set);
    }
    if (!set.datasets.includes(row.datasetId)) { set.datasets.push(row.datasetId); set.groups = datasetGroups(s, set.datasets); }
    if (set.source.kind !== 'inline') continue;
    const hit = set.source.hits.find(h => h.hitId === row.hitId);
    if (hit) { if (!hit.legacyRefs!.some(r => featureKey(r) === featureKey(row.legacyRef))) hit.legacyRefs!.push(row.legacyRef); }
    else set.source.hits.push({ ...row, frame: set.frame, scores: {}, legacyRefs: [row.legacyRef] });
    set.count = set.source.hits.length;
  }
  return [...sets.values()];
}
export function registerLegacyHubProvider(): void {
  registerHubProvider({ id: 'legacy-jobs', sets: legacySets, subscribe: fn => useLegacyRuns.subscribe(fn) });
}
