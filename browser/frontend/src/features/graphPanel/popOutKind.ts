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
import { liftHapLabels } from '../liveLift/types';
import type { PanelConfig } from '../../types';
import { linkedSourcePanels, openLinkedSourceView } from '../liveLift/linking/liftLink';
import { isHost, liveProvenance, panelKeyOf, popOut, provenanceCovers, provenanceLineage, provenanceShare, undoable, type GraphProvenance } from './hostMode';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { qnameOfId } from '../../utils/recordKeys';
import { linkedSourceObservations, sourceLabels } from '../../utils/clusterMatchedRun';
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
    // An open source view of this haplotype, on the member's strand when the views are split by strand.
    const fromStrand = st.panels.find(p => p.id === fromPanelId)?.strand ?? null;
    const open = lift?.datasetId ? linkedSourcePanels(lift.datasetId, hap ?? lift.liftHap ?? null) : [];
    const existing = open.find(p => (p.strand ?? null) === fromStrand) ?? open[0];
    if (existing) {
      undoable(`Show ${existing.liftLink?.hapLabel ?? hap ?? ''} source view`.replace('  ', ' '), () => {
        // (Synchronous for an open one: it relinks to this lifted panel and returns.)
        void openLinkedSourceView(liftPanelId, hap);
        useBrowserStore.setState(x => ({ panels: x.panels.map(p => (p.id === existing.id && p.collapsed ? { ...p, collapsed: false } : p)) }));
        // A peer of the member, as a new one is (agy review, group H round 2): its read state first, then the current
        // run's labels within that scope, then the member's clusters on every tree node.
        seedSourceReadState(fromPanelId, existing.id);
        labelLinkedSource(existing.id);
        seedSourceState(fromPanelId, existing.id);
      });
      continue;
    }
    const id = await openLinkedSourceView(liftPanelId, hap, { ...(view ? { view } : {}), ...(liftPanelId !== host.id ? { besidePanelId: host.id } : {}) });
    if (!id) continue;
    // A peer of the member it shows: the run's labels, else the member's own, and its read state, by QNAME; all
    // part of the step that opened it.
    // (Its filter first, so the run labels only the reads it shows: agy review, group H round 2.)
    seedSourceReadState(fromPanelId, id);
    labelLinkedSource(id);
    seedSourceState(fromPanelId, id);
    const after = useBrowserStore.getState();
    after.foldIntoCurrentSnapshot?.(serializeState(after));
  }
}

/**
 * A new source view popped out of a graph starts where its member is (agy review, group H): its read filter,
 * selection and exclusions by QNAME (the source rows are the same records), and its clusters on every tree node
 * that has them — labels, order, focus and names — so switching branches keeps them (Codex review, group H round 3).
 * Labels are only ever this source's haplotype and strand: split by the graph runs' record provenance when the
 * labels are theirs, else taken only from a member of that one haplotype; a pooled host's labels with no provenance
 * (a merged or regrouped run) give none, never another haplotype's (Codex round 3). The current run's labels
 * (labelLinkedSource) stay. State the source view already has is kept.
 */
export function seedSourceState(fromPanelId: string, sourcePanelId: string): void {
  const st = useBrowserStore.getState();
  const from = st.panels.find(p => p.id === fromPanelId);
  const to = st.panels.find(p => p.id === sourcePanelId);
  if (!from || !to) return;
  const fk = panelKeyOf(from), tk = panelKeyOf(to);
  // A member of exactly this haplotype (and not the other strand) has only this source's records.
  // (A single-haplotype lifted dataset's panel has no haplotype of its own: all its records are that one's.)
  const oneHap = liftHapLabels(st.datasets.find(d => d.id === from.datasetId)?.live_lift).length === 1;
  const hapOnly = (oneHap || (Boolean(from.liftHap) && (from.liftHap ?? '').toUpperCase() === (to.liftLink?.hapLabel ?? '').toUpperCase()))
    && from.datasetId === to.liftLink?.datasetId && !(from.strand && to.strand && from.strand !== to.strand);
  /** A map of the member's labels as this source's QNAME labels (null: none of them are this source's for sure). */
  const project = (labels: Record<string, number> | undefined, provs: GraphProvenance[]): Record<string, number> | null => {
    if (!labels || !Object.keys(labels).length) return null;
    let mine: Record<string, number> | null = null;
    if (provenanceCovers(provs, labels)) {
      const picked = new Set(provs.flatMap(p => linkedSourceObservations(p.observations, to).map(o => o.id)));
      mine = provenanceShare(provs, labels, o => picked.has(o.id));
    } else if (hapOnly) mine = labels;
    if (!mine) return null;
    const byName = sourceLabels({ assignments: { m: mine } }, ['m']);
    return Object.keys(byName).length ? byName : null;
  };
  const active = st.activeClusterTreeNodeId && st.clusterTreeNodes[st.activeClusterTreeNodeId] ? st.activeClusterTreeNodeId : null;
  seedSourceReadState(fromPanelId, sourcePanelId);
  useBrowserStore.setState(cur => {
    const patch: Record<string, unknown> = {};
    // Live clusters: the member's share; labels the source already has (the current run's, just now) stay only while
    // they agree with it. A source clustered on its own keeps its clusters, order, focus and names untouched.
    let live = cur.clusterAssignments[tk];
    const got = project(cur.clusterAssignments[fk], active ? provenanceLineage(cur, fk, active) : liveProvenance(cur, fk));
    const had = Boolean(live && Object.keys(live).length);
    // Its own: labels no graph run gave it, even when their numbers equal the member's (Codex post-merge review,
    // group A round 1, #2).
    if (had && !runOwned(cur, tk, active)) return {};
    if (had && got && !Object.entries(live!).every(([q, c]) => got[q] === c)) return {};
    if (had && !got && !runLabelled(cur, tk)) return {};
    if (!had && got) { live = got; patch.clusterAssignments = { ...cur.clusterAssignments, [tk]: got }; }
    const labelled = Boolean(live && Object.keys(live).length);
    const order = labelled && cur.clusterOrder[fk]?.length ? [...cur.clusterOrder[fk]] : cur.clusterOrder[tk];
    const focus = labelled && cur.clusterFocus[fk]?.size ? new Set(cur.clusterFocus[fk]!) : cur.clusterFocus[tk] ?? null;
    const groupNames = labelled && cur.clusterGroupLabels?.[fk] && Object.keys(cur.clusterGroupLabels[fk]).length
      ? { ...cur.clusterGroupLabels[fk], ...(cur.clusterGroupLabels?.[tk] ?? {}) } : cur.clusterGroupLabels?.[tk];
    if (labelled) {
      if (order) patch.clusterOrder = { ...cur.clusterOrder, [tk]: order };
      if (focus?.size) patch.clusterFocus = { ...cur.clusterFocus, [tk]: focus };
      if (groupNames) patch.clusterGroupLabels = { ...cur.clusterGroupLabels, [tk]: groupNames };
    }
    // Every tree node: the active one takes the complete live state; the others their own share of the member's.
    const nodes: Record<string, unknown> = {};
    for (const [nid, n] of Object.entries(cur.clusterTreeNodes)) {
      if (nid === active) {
        if (!labelled) continue;
        nodes[nid] = { ...n, assignments: { ...n.assignments, [tk]: { ...live! } }, order: { ...n.order, ...(order ? { [tk]: [...order] } : {}) },
          focus: { ...n.focus, [tk]: focus?.size ? [...focus] : null },
          ...(groupNames ? { groupLabels: { ...(n.groupLabels ?? {}), [tk]: { ...groupNames } } } : {}) };
        continue;
      }
      if (!n.assignments?.[fk] || (n.assignments[tk] && Object.keys(n.assignments[tk]).length)) continue;
      const got = project(n.assignments[fk], provenanceLineage(cur, fk, nid));
      if (!got) continue;
      nodes[nid] = { ...n, assignments: { ...n.assignments, [tk]: got },
        order: n.order?.[fk] ? { ...n.order, [tk]: [...n.order[fk]] } : n.order,
        focus: n.focus?.[fk] ? { ...n.focus, [tk]: [...n.focus[fk]!] } : n.focus,
        ...(n.groupLabels?.[fk] ? { groupLabels: { ...n.groupLabels, [tk]: { ...n.groupLabels[fk] } } } : {}) };
    }
    if (Object.keys(nodes).length) patch.clusterTreeNodes = { ...cur.clusterTreeNodes, ...nodes };
    return patch;
  });
}

/** Whether a source view's labels are the current graph run's (it is one of the run's destinations). */
function runLabelled(s: ReturnType<typeof useBrowserStore.getState>, key: string): boolean {
  return Boolean(s.clusterMatchedRun?.graph && s.clusterMatchedRun.destinations?.some(d => d.stateKey === key));
}

/** Whether a source view's labels came from a graph run: it is a destination of the current run, or a run of the
 * active tree node's lineage labelled it. Otherwise they are its own clustering. */
function runOwned(s: ReturnType<typeof useBrowserStore.getState>, key: string, active: string | null): boolean {
  return runLabelled(s, key) || Boolean(active && provenanceLineage(s, key, active).length);
}

/** A source view's read state from its member, by QNAME: its filter, selection and exclusions (state it already
 * has is kept). Before any labels, so the run labels only the reads it shows. */
export function seedSourceReadState(fromPanelId: string, sourcePanelId: string): void {
  const st = useBrowserStore.getState();
  const from = st.panels.find(p => p.id === fromPanelId);
  const to = st.panels.find(p => p.id === sourcePanelId);
  if (!from || !to) return;
  const fk = panelKeyOf(from), tk = panelKeyOf(to);
  const names = (ids: Iterable<string> | null | undefined) => (ids ? new Set([...ids].map(qnameOfId)) : null);
  useBrowserStore.setState(cur => {
    const patch: Record<string, unknown> = {};
    const filter = names(cur.filteredReadIds[fk]);
    if (filter && !cur.filteredReadIds[tk]) patch.filteredReadIds = { ...cur.filteredReadIds, [tk]: filter };
    const selected = names(cur.selectedReadIds[fk]);
    if (selected?.size && !cur.selectedReadIds[tk]?.size) patch.selectedReadIds = { ...cur.selectedReadIds, [tk]: selected };
    return patch;
  });
  const excluded = useReadActionsStore.getState().excludedReadIds[fk];
  const have = useReadActionsStore.getState().excludedReadIds[tk];
  if (excluded?.size && !have?.size) useReadActionsStore.getState().excludeReads(tk, [...names(excluded)!]);
}
