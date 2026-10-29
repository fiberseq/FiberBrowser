import type { PanelConfig } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { graphClusterPlan, graphRequestBody } from './graphCluster';
import { recordKey } from '../../utils/recordKeys';
import { placementAt, type Scene } from './scene';
import type { GraphTopology } from './types';
import { onPackageError } from './statusStore';

export interface GraphSortSite { binding: string; occurrence: string; node: string; offset: number; target_position?: number | null }
export interface GraphSiteSort { site: GraphSortSite; order: string[]; registrationId: string }

declare module '../../types' { interface PanelConfig { graphSiteSort?: GraphSiteSort } }

/** Invert the actual occurrence transform, including mirrored and reversed tubes. */
export function siteAt(scene: Scene, topology: GraphTopology, x: number, path: string): GraphSortSite | null {
  const at = placementAt(scene, x, undefined, undefined, path);
  if (!at) return null;
  const occ = topology.paths.find(p => p.binding === path)?.occurrences.find(o => o.id === at.place.occ);
  const length = topology.nodes.find(n => n.id === occ?.node)?.length;
  if (!occ || length == null) return null;
  return { binding: path, occurrence: occ.id, node: occ.node,
    offset: occ.reverse ? length - 1 - at.offset : at.offset };
}

export function activeSiteSort(panel: PanelConfig | undefined, order: readonly string[] | undefined): GraphSiteSort | null {
  const sort = panel?.graphSiteSort;
  return sort?.site && Array.isArray(sort.order) && order?.length && order.length === sort.order.length
    && order.every((id, i) => id === sort.order[i]) ? sort : null;
}

/** The saved graph order is preserved for Resume graph; a carrier-only site has no ordering on linear rows. */
export function linearSiteOrder(panel: PanelConfig | undefined, order: string[]): string[] {
  const sort = activeSiteSort(panel, order);
  return sort && sort.site.target_position == null ? [] : order;
}

export function siteSortNotice(panel: PanelConfig | undefined, order: readonly string[] | undefined): string | null {
  const sort = activeSiteSort(panel, order);
  return sort && sort.site.target_position == null
    ? 'Site sort is on a carrier-only graph column. Linear view uses cluster order; resume graph to restore the site sort.' : null;
}

export async function sortGraphSite(hostId: string, site: GraphSortSite, sortBy: 'footprint' | 'accessibility' | 'rule', rule?: Record<string, unknown>, layer?: string): Promise<void> {
  const before = useBrowserStore.getState();
  const host = before.panels.find(p => p.id === hostId);
  const view = host?.viewportOverride ?? before;
  if (!host) return;
  const plan = graphClusterPlan({ ...before, selectedDatasets: new Set([hostId]) },
    { kind: 'peaks', regions: [{ chrom: view.chrom, start: view.start, end: view.end, mode: 'accessibility' }] });
  if (!plan || plan.host.id !== hostId || plan.refusal) throw new Error(plan?.refusal ?? 'This graph has no comparable read paths');
  const body = { ...graphRequestBody(before, plan), site, sort_by: sortBy, rule, layer };
  const response = await fetch('/api/graph/sort_site', { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) {
    onPackageError(result.error?.code);
    throw new Error(result.error?.message ?? 'Graph site sort failed');
  }
  const now = useBrowserStore.getState();
  if (now.panels !== before.panels || now.refreshGeneration !== before.refreshGeneration || now.chrom !== before.chrom
    || now.start !== before.start || now.end !== before.end || now.filteredReadIds !== before.filteredReadIds
    || now.clusterFocus !== before.clusterFocus || now.clusterAssignments !== before.clusterAssignments
    || now.activeClusterTreeNodeId !== before.activeClusterTreeNodeId || now.datasets !== before.datasets)
    throw new Error('The view changed while sorting; sort again here');
  seedHistoryBaseline(now, 'Before sorting a graph site', 'analysis');
  const orders = { ...now.readSortOrder };
  const sorts = new Map<string, GraphSiteSort>();
  for (const dest of plan.destinations) {
    const raw: string[] = dest.observations.flatMap(id => {
      const r = result.results[id];
      return (r?.read_sort_order ?? []).map((key: string) => dest.keyBy === 'qname' ? r.qnames?.[key] ?? key : key);
    });
    // Both graph and lifted rows match through their record key, independent of placement.
    const order = [...new Set(raw.map(id => recordKey(id) ?? id))];
    orders[dest.stateKey] = order;
    sorts.set(dest.panelId, { site: result.site, order, registrationId: plan.registration.id });
  }
  useBrowserStore.setState({ readSortOrder: orders,
    panels: now.panels.map(p => sorts.has(p.id) ? { ...p, graphSiteSort: sorts.get(p.id) } : p) });
  useBrowserStore.getState().pushSnapshot?.('Sort by graph site', { kind: 'analysis' });
}
