import type { PanelConfig } from '../types';

/**
 * Graph mode's panel fields (DESIGN_GRAPH_PRIMARY §1.1, §4.4), kept here beside the other group fields so the panel
 * slice's lifecycle (duplicate, reveal, remove) treats them like `collapsedBySplitGroup` and friends:
 * - `viewMode`: a dataset panel's intent, 'graph' makes it a host (absent: linear);
 * - `graphMemberOf`: on a member panel, its host's id (the host is its own first member, without this field);
 * - `collapsedByGraphGroup`: on a member, folded into its host's graph (hidden, state kept);
 * - `graphHandoff`: on a member the host revealed when it went linear (hand-off or the toggle): folded again when the
 *   host draws its graph again, unless the user revealed or folded it by hand meanwhile (which clears this).
 */
declare module '../types' {
  interface PanelConfig {
    viewMode?: 'linear' | 'graph';
    graphMemberOf?: string;
    collapsedByGraphGroup?: string;
    graphHandoff?: string;
  }
}

/** A copy of a panel (duplicate, a strand or split copy) is never a host or member: it starts linear, on its own. */
export function withoutGraphMembership<T extends PanelConfig>(panel: T): T {
  if (!panel.viewMode && !panel.graphMemberOf && !panel.collapsedByGraphGroup && !panel.graphHandoff
    && !(panel.graphView && (panel.graphView as { role?: string }).role === 'host')) return panel;
  const { viewMode: _v, graphMemberOf: _m, collapsedByGraphGroup: _c, graphHandoff: _h, ...rest } = panel;
  const out = rest as T;
  if (panel.contentType === 'dataset') delete (out as { graphView?: unknown }).graphView;
  return out;
}

/** Shown by hand (its own collapse toggle, a reveal): no longer held folded by its graph; membership stays. */
export function withoutGraphFold<T extends PanelConfig>(panel: T): T {
  if (!panel.collapsedByGraphGroup && !panel.graphHandoff) return panel;
  const { collapsedByGraphGroup: _c, graphHandoff: _h, ...rest } = panel;
  return rest as T;
}

/** A host's graph state (viewed as a graph, or linear for now: its members stay its members). */
const isHost = (p: PanelConfig | undefined) => Boolean(p && p.contentType === 'dataset' && p.viewMode
  && (p.graphView as { role?: string } | undefined)?.role === 'host');

/**
 * Members whose host is gone (closed, a session without it) or is no longer a host: shown again and out of the
 * graph, with their state (D8). A host's member list drops panels that are gone or joined another graph.
 */
export function restoreOrphanGraphMembers(panels: PanelConfig[]): PanelConfig[] {
  const byId = new Map(panels.map(p => [p.id, p]));
  let changed = false;
  const out = panels.map(p => {
    let next = p;
    if (p.graphMemberOf || p.collapsedByGraphGroup || p.graphHandoff) {
      const host = byId.get(p.graphMemberOf ?? p.collapsedByGraphGroup ?? p.graphHandoff ?? '');
      // (A host is never also a member: one graph per panel.)
      if (!isHost(host) || host!.id === p.id || isHost(p) || host!.graphMemberOf) {
        const { graphMemberOf: _m, collapsedByGraphGroup: _c, graphHandoff: _h, ...rest } = p;
        next = { ...rest, collapsed: p.collapsedByGraphGroup ? false : p.collapsed } as PanelConfig;
      }
    }
    const view = next.graphView as { role?: string; members?: { panelId: string; binding: string | null }[] } | undefined;
    if (view?.role === 'host' && Array.isArray(view.members)) {
      // Its members: the panels that say so, in the list's order, then any the list missed; itself first.
      const mine = panels.filter(q => q.id !== next.id && q.graphMemberOf === next.id && isHost(next)).map(q => q.id);
      const own = view.members.find(m => m.panelId === next.id) ?? { panelId: next.id, binding: null };
      const listed = view.members.filter(m => m.panelId !== next.id && mine.includes(m.panelId));
      const missed = mine.filter(id => !listed.some(m => m.panelId === id)).map(id => ({ panelId: id, binding: null }));
      const members = [own, ...listed, ...missed];
      if (members.length !== view.members.length || members.some((m, i) => m.panelId !== view.members![i]?.panelId)) {
        next = { ...next, graphView: { ...(next.graphView as object), members } as PanelConfig['graphView'] };
      }
    }
    if (next !== p) changed = true;
    return next;
  });
  return changed ? out : panels;
}

/**
 * A member folded into a host that is shown and drawing its graph: its reads are on screen in the host's sub-band,
 * so a Cluster run over the panels in view includes it (DESIGN_GRAPH_PRIMARY §3.4 item 1: hidden members join
 * through their host), and selecting the host selects it.
 */
export function foldedInShownGraph(panel: PanelConfig, panels: readonly PanelConfig[]): PanelConfig | null {
  if (!panel.collapsedByGraphGroup || panel.graphMemberOf !== panel.collapsedByGraphGroup) return null;
  const host = panels.find(p => p.id === panel.collapsedByGraphGroup);
  if (!isHost(host) || host!.viewMode !== 'graph' || host!.collapsed || (host!.graphView as { handoff?: { shown?: string } } | undefined)?.handoff?.shown === 'linear') return null;
  return host!;
}
