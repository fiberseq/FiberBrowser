/**
 * What a pop-out shows (DESIGN_GRAPH_PRIMARY §4.2 row "lifted path, source view", D7; §5.1 "pop-out kind", per host):
 * - `lifted` (the default, and what a host saved without the setting does): the member panel is revealed;
 * - `source`: the P3 linked source panel on that haplotype's assembly opens (or an open one is revealed) instead,
 *   through the live-lift "Open source view" action (liftLink.ts openLinkedSourceView), never a copy of it;
 * - `both`: both.
 * Members with no source view (a native dataset on the target) are revealed whatever the kind.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { isLiveLift } from '../../utils/datasetKinds';
import type { PanelConfig } from '../../types';
import { linkedSourcePanels, openLinkedSourceView } from '../liveLift/linking/liftLink';
import { isHost, panelKeyOf, popOut, undoable } from './hostMode';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { qnameOfId } from '../../utils/recordKeys';
import { sourceLabels } from '../../utils/clusterMatchedRun';
import { labelLinkedSource } from './graphCluster';
import { serializeState } from '../../stores/historySlice';
import type { GraphViewState } from './types';

export type PopOutKind = NonNullable<GraphViewState['popOutKind']>;
export const POP_OUT_KINDS: readonly PopOutKind[] = ['lifted', 'source', 'both'];

/** A host's pop-out kind; absent or unknown (an older session): lifted. */
export function popOutKindOf(host: PanelConfig | null | undefined): PopOutKind {
  const k = host?.graphView?.popOutKind;
  return k === 'source' || k === 'both' ? k : 'lifted';
}

/** Set a host's pop-out kind (saved with the host; one undo step). */
export function setPopOutKind(hostId: string, kind: PopOutKind): void {
  const host = useBrowserStore.getState().panels.find(p => p.id === hostId);
  if (!isHost(host) || popOutKindOf(host) === kind) return;
  undoable(`Pop out as ${kind === 'both' ? 'lifted and source' : kind}`, () => useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.id === hostId && p.graphView ? { ...p, graphView: { ...p.graphView, popOutKind: kind } } : p)),
  })));
}

export interface PopOutPlan {
  /** Members revealed as panels (lifted kind, or members with no source view). */
  reveal: string[];
  /** Haplotypes of a pooled host with no panel yet, made as panels (lifted kind). */
  make: { binding: string; hap: string }[];
  /** Source views to open: the lifted panel they link to, the haplotype label (null: its one haplotype), and the
   * panel whose read state a new one starts with (the member, or the host for a haplotype with no panel). */
  sources: { liftPanelId: string; hap: string | null; fromPanelId: string }[];
}

/** Pure: what popping out `memberIds` and `missing` does under the host's pop-out kind. */
export function popOutPlan(panels: readonly PanelConfig[], datasets: readonly { id: string; data_type?: string; live_lift?: unknown }[],
  host: PanelConfig, memberIds: readonly string[], missing: readonly { binding: string; hap: string }[] = [], kind = popOutKindOf(host)): PopOutPlan {
  const lifted = kind !== 'source';
  const source = kind !== 'lifted';
  const plan: PopOutPlan = { reveal: [], make: lifted ? [...missing] : [], sources: [] };
  const hasSource = (p: PanelConfig) => isLiveLift(datasets.find(d => d.id === p.datasetId) as never);
  for (const id of memberIds) {
    const p = panels.find(x => x.id === id);
    if (!p) continue;
    if (!source || !hasSource(p)) { plan.reveal.push(id); continue; }
    if (lifted) plan.reveal.push(id);
    // The host's own dataset links to the host (it is on screen; a folded member is not), another dataset to its panel.
    plan.sources.push({ liftPanelId: p.datasetId === host.datasetId ? host.id : p.id, hap: p.liftHap ?? null, fromPanelId: p.id });
  }
  if (source && hasSource(host)) for (const m of missing) plan.sources.push({ liftPanelId: host.id, hap: m.hap, fromPanelId: host.id });
  return plan;
}

/** Pop out members of a host's graph as its pop-out kind says (header menus, the checklist, the lane menu). */
export function popOutPaths(hostId: string, memberIds: string[], missing: { binding: string; hap: string }[] = []): string[] {
  const s = useBrowserStore.getState();
  const host = s.panels.find(p => p.id === hostId);
  if (!isHost(host)) return [];
  const plan = popOutPlan(s.panels, s.datasets, host, memberIds, missing);
  const out = plan.reveal.length || plan.make.length ? popOut(hostId, plan.reveal, plan.make) : [];
  if (plan.sources.length) void openSources(host, plan.sources);
  return out;
}

/** One after another (each opens a dataset and a reference, and takes its own undo step). A source view already
 * open is revealed (and relinked) as one undo step of its own: openLinkedSourceView records none for it (Codex
 * review, group H). */
async function openSources(host: PanelConfig, sources: PopOutPlan['sources']): Promise<void> {
  // Mapped from the host's own view (its one viewport, §7.1), stacked beside the host (a joined dataset's lifted panel
  // is folded into the graph: agy review, group H).
  const view = host.viewportOverride ? { chrom: host.viewportOverride.chrom, start: host.viewportOverride.start, end: host.viewportOverride.end } : undefined;
  for (const { liftPanelId, hap, fromPanelId } of sources) {
    const st = useBrowserStore.getState();
    const lift = st.panels.find(p => p.id === liftPanelId);
    const existing = lift?.datasetId ? linkedSourcePanels(lift.datasetId, hap ?? lift.liftHap ?? null)[0] : undefined;
    if (existing) {
      undoable(`Show ${existing.liftLink?.hapLabel ?? hap ?? ''} source view`.replace('  ', ' '), () => {
        // (Synchronous for an open one: it relinks to this lifted panel and returns.)
        void openLinkedSourceView(liftPanelId, hap);
        useBrowserStore.setState(x => ({ panels: x.panels.map(p => (p.id === existing.id && p.collapsed ? { ...p, collapsed: false } : p)) }));
        // A peer of the graph: the current graph run's labels, by QNAME (§4.2).
        labelLinkedSource(existing.id);
      });
      continue;
    }
    const id = await openLinkedSourceView(liftPanelId, hap, { ...(view ? { view } : {}), ...(liftPanelId !== host.id ? { besidePanelId: host.id } : {}) });
    if (!id) continue;
    // A peer of the member it shows: the run's labels, else the member's own, and its read state, by QNAME; all
    // part of the step that opened it.
    labelLinkedSource(id);
    seedSourceState(fromPanelId, id);
    const after = useBrowserStore.getState();
    after.foldIntoCurrentSnapshot?.(serializeState(after));
  }
}

/**
 * A new source view popped out of a graph starts where its member is (agy review, group H): its read filter,
 * selection, exclusions, cluster order, focus and cluster names, and — when the current graph run did not label it
 * (no run, a merged or relabelled one) — the member's own cluster labels, all named by QNAME (the source rows are
 * the same records). State the source view already has is kept.
 */
export function seedSourceState(fromPanelId: string, sourcePanelId: string): void {
  const st = useBrowserStore.getState();
  const from = st.panels.find(p => p.id === fromPanelId);
  const to = st.panels.find(p => p.id === sourcePanelId);
  if (!from || !to) return;
  const fk = panelKeyOf(from), tk = panelKeyOf(to);
  const names = (ids: Iterable<string> | null | undefined) => (ids ? new Set([...ids].map(qnameOfId)) : null);
  const labels = st.clusterAssignments[fk];
  // Labels from the run just now, or the member's own here: either way the member's cluster order applies.
  let labelled = Boolean(Object.keys(st.clusterAssignments[tk] ?? {}).length);
  if (labels && Object.keys(labels).length && !labelled) {
    const byName = sourceLabels({ assignments: { m: labels } }, ['m']);
    if (Object.keys(byName).length) { st.setClusterAssignments(tk, byName, { mirror: true, merge: true, svSplit: true }); labelled = true; }
  }
  useBrowserStore.setState(cur => {
    const patch: Record<string, unknown> = {};
    const filter = names(cur.filteredReadIds[fk]);
    if (filter && !cur.filteredReadIds[tk]) patch.filteredReadIds = { ...cur.filteredReadIds, [tk]: filter };
    const selected = names(cur.selectedReadIds[fk]);
    if (selected?.size && !cur.selectedReadIds[tk]?.size) patch.selectedReadIds = { ...cur.selectedReadIds, [tk]: selected };
    if (cur.clusterOrder[fk]?.length && (labelled || !cur.clusterOrder[tk]?.length)) patch.clusterOrder = { ...cur.clusterOrder, [tk]: [...cur.clusterOrder[fk]] };
    const focus = cur.clusterFocus[fk];
    if (focus?.size && !cur.clusterFocus[tk]?.size) patch.clusterFocus = { ...cur.clusterFocus, [tk]: new Set(focus) };
    const groupNames = cur.clusterGroupLabels?.[fk];
    if (groupNames && Object.keys(groupNames).length && !cur.clusterGroupLabels?.[tk]) {
      patch.clusterGroupLabels = { ...cur.clusterGroupLabels, [tk]: { ...groupNames } };
    }
    return patch;
  });
  const excluded = useReadActionsStore.getState().excludedReadIds[fk];
  if (excluded?.size) useReadActionsStore.getState().excludeReads(tk, [...names(excluded)!]);
}
