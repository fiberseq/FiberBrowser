import { fetchJson } from '../../api/sharedFetch';
import type { FeatureHit, FeatureSet } from './types';
import type { HubUi, HubView } from './hubState';
import { scanSets, scanHitToFeature } from './hubData';
import type { ScanHit, ScanInfo } from './api';

export type HubScope = { kind: 'view' } | { kind: 'genome' } | { kind: 'scan'; scanId: string }
  | { kind: 'bed'; bed: string } | { kind: 'genes'; genes: string[]; flank?: number }
  | { kind: 'anchors'; anchorSetId: string; flank?: number } | { kind: 'regions'; regions: [string, number, number][] };
export interface HubPage { rows: Array<{ source: string; setId: string; hit: FeatureHit | ScanHit }>; total: number; offset: number; limit: number; hasMore: boolean }
export function queryHubPage(ui: HubUi, view: HubView, providers: FeatureSet[], anchors: { id: string; anchors: { chrom: string; pos: number }[] }[], signal: AbortSignal) {
  const scope = ui.scope ?? { kind: 'view' };
  const resolved = scope.kind === 'view' ? { ...scope, ...view } : scope.kind === 'anchors'
    ? { kind: 'anchors', flank: scope.flank, anchors: anchors.find(a => a.id === scope.anchorSetId)?.anchors.map(p => [p.chrom, p.pos]) ?? [] } : scope;
  return fetchJson<HubPage>('/api/hub/hits/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: resolved, providers, hiddenSets: ui.hiddenSets, typeFilter: ui.typeFilter,
      minPrevalence: ui.minPrevalence, minStrength: ui.minStrength, maxQ: ui.maxQ, scoreFilters: ui.scoreFilters,
      sort: ui.sort, compare: ui.compare, sharedOnly: ui.sharedOnly, offset: ui.offset ?? 0, limit: ui.pageSize ?? 100 }), signal });
}
export function pageSets(page: HubPage, scans: ScanInfo[], providers: FeatureSet[]): FeatureSet[] {
  const descriptors = new Map<string, FeatureSet>(providers.map(s => [s.setId, s]));
  for (const set of scanSets(scans)) descriptors.set(set.setId, set);
  const hits = new Map<string, FeatureHit[]>();
  for (const row of page.rows) {
    const set = descriptors.get(row.setId);
    if (!set) continue;
    const scan = scans.find(s => s.scanId === row.source);
    const info = scan?.sets.find(s => s.setId === row.setId);
    const hit = scan && info ? scanHitToFeature(info, scan.scanId, row.hit as ScanHit) : row.hit as FeatureHit;
    hits.set(row.setId, [...(hits.get(row.setId) ?? []), hit]);
  }
  return [...descriptors.values()].map(set => ({ ...set, source: { kind: 'inline', hits: hits.get(set.setId) ?? [] } }));
}
