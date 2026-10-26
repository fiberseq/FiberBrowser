/**
 * Graph mode as a view mode of a dataset panel (DESIGN_GRAPH_PRIMARY §1, §4; graph primary G1).
 *
 * - A dataset panel toggles linear ⇄ graph in place: it keeps its id, stateKey, state and position; only `viewMode`
 *   and its `graphView` change (one undo step).
 * - The host draws its members' reads on the paths they bind: members are ordinary dataset panels, folded into the
 *   graph (hidden, `collapsedByGraphGroup`) with every bit of their state kept. Toggling a split lifted panel makes it
 *   the host and its haplotype siblings members.
 * - A pop-out reveals a member (one, some or all paths in view) and folding it in hides it again: it is never copied,
 *   archived or reset. A pooled host popping out a haplotype with no panel of its own makes one (`copyPanelState`).
 * - Other datasets' panels join and leave; closing the host reveals its members (stores/graphMembership.ts).
 * - The standalone graph-view panel can be made the graph view of a dataset panel.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { PER_PANEL_STATE_KEYS } from '../../stores/panelSlice';
import { generatePanelId } from '../../stores/utils';
import { withoutGraphMembership } from '../../stores/graphMembership';
import type { PanelConfig } from '../../types';
import { genomeKeyFor } from '../../utils/regionNavigation';
import { currentMatchedRun, observationShownBy, type GraphRunObservation } from '../../utils/clusterMatchedRun';
import { UNASSIGNED_CLUSTER_ID } from '../../components/tracks/read-track/constants';
import { recordKey } from '../../utils/recordKeys';
import { graphBindingFor, memberBindingFor, useGraphBindingsStore, type DatasetGraphBinding } from './bindingsStore';
import { canFollow, defaultCompared, defaultTarget, GRAPH_MAX_PATHS, DEFAULT_CONTEXT_BP, type LinearView } from './state';
import { useGraphStatusStore } from './statusStore';
import type { GraphMember, GraphRegistration, GraphViewState } from './types';
import { applyShown, decideShown, useGraphSettings } from './handoff';

export const panelKeyOf = (p: PanelConfig) => p.stateKey ?? p.datasetId ?? p.id;

export function isHost(p: PanelConfig | undefined | null): p is PanelConfig & { viewMode: 'graph' } {
  return Boolean(p && p.contentType === 'dataset' && p.viewMode === 'graph' && p.graphView?.role === 'host');
}

/** The host a panel belongs to: itself when it is one, else the host it is a member of (null: none). */
export function hostOf(panels: readonly PanelConfig[], panel: PanelConfig | undefined | null): PanelConfig | null {
  if (!panel) return null;
  if (isHost(panel)) return panel;
  const host = panel.graphMemberOf ? panels.find(p => p.id === panel.graphMemberOf) : undefined;
  return isHost(host) ? host! : null;
}

/** A host's member panels in band order (itself first); panels that are gone are left out. */
export function membersOf(panels: readonly PanelConfig[], host: PanelConfig): { member: GraphMember; panel: PanelConfig }[] {
  const out: { member: GraphMember; panel: PanelConfig }[] = [];
  for (const m of host.graphView?.members ?? [{ panelId: host.id, binding: null }]) {
    const panel = panels.find(p => p.id === m.panelId);
    if (panel && (panel.id === host.id || panel.graphMemberOf === host.id)) out.push({ member: m, panel });
  }
  if (!out.some(x => x.panel.id === host.id)) out.unshift({ member: { panelId: host.id, binding: null }, panel: host });
  return out;
}

function mainView(): LinearView {
  const s = useBrowserStore.getState();
  return { chrom: s.chrom, start: s.start, end: s.end, reference: genomeKeyFor(null, s) };
}

/** The panel's own viewport (its own view, else the main view) and reference: graph mode's one authority (§7.1). */
export function panelView(panel: PanelConfig, main: LinearView = mainView()): LinearView {
  return panel.viewportOverride ? { ...panel.viewportOverride, reference: panel.genome || main.reference || null } : main;
}

/** Split siblings of a lifted panel: the dataset's other haplotype panels on the same view (§1.2). */
export function splitSiblings(panels: readonly PanelConfig[], panel: PanelConfig): PanelConfig[] {
  if (!panel.liftHap || !panel.datasetId) return [];
  const sameView = (p: PanelConfig) => JSON.stringify(p.viewportOverride ?? null) === JSON.stringify(panel.viewportOverride ?? null);
  // One Split by haplotype's panels (its group id); panels split before groups existed match by dataset and view, and a
  // grouped panel never takes another group's panels (two copies of a dataset split on their own; graph features).
  // Siblings show the other haplotypes, on the same strand (graph features review).
  const sameGroup = (p: PanelConfig) => (p.liftSplitGroup ?? null) === (panel.liftSplitGroup ?? null)
    && (p.strand ?? null) === (panel.strand ?? null) && (p.liftHap ?? '').toUpperCase() !== (panel.liftHap ?? '').toUpperCase();
  return panels.filter(p => p.id !== panel.id && p.contentType === 'dataset' && p.datasetId === panel.datasetId && p.liftHap && sameGroup(p)
    && !p.readSubset && !p.altAllele && !p.liftLink && !isHost(p) && p.graphView?.role !== 'host' && !p.graphMemberOf && sameView(p) && (p.genome ?? null) === (panel.genome ?? null));
}

/** Why a panel cannot be viewed as a graph (null: it can). */
export function graphUnavailable(panel: PanelConfig | undefined | null): string | null {
  if (!panel || panel.contentType !== 'dataset' || !panel.datasetId) return 'Only a dataset panel has a graph view';
  if (panel.readSubset) return 'A split panel shows a subset of its reads: open the graph from its source panel';
  if (panel.liftLink) return 'A linked source panel is on its own assembly: open the graph from the lifted panel';
  if (!useGraphStatusStore.getState().status?.helper.available) return 'The graph helper is not available';
  if (!(useGraphStatusStore.getState().status?.registrations.length)) return 'No graph package is registered';
  const store = useGraphBindingsStore.getState();
  if (!graphBindingFor(panel.datasetId, store)) {
    if (store.key == null) return 'Checking which graph packages bind this dataset…';
    const why = store.problems[panel.datasetId];
    return `No registered graph package binds this dataset${why?.length ? ` (${why[0]})` : ''}`;
  }
  return null;
}

/** A host's graph state: the registration's target on the panel's contig and its bound paths (at most four). */
export function hostGraphView(reg: GraphRegistration, bound: DatasetGraphBinding, view: LinearView, members: GraphMember[],
  previous?: GraphViewState | null): GraphViewState {
  const target = defaultTarget(reg, view);
  const targetKey = target?.key ?? null;
  // Its own dataset's paths first (in map order), then the package's other compared paths.
  const mapped = targetKey ? [...new Set(reg.maps.filter(m => m.target === targetKey).map(m => m.source))] : [];
  const own = mapped.filter(k => k in bound.binding.paths);
  const selected = targetKey ? [targetKey, ...new Set([...own, ...mapped])].slice(0, GRAPH_MAX_PATHS) : [];
  const keep = previous && previous.registrationId === reg.id && previous.targetBinding === targetKey;
  return {
    schema: 2,
    role: 'host',
    registrationId: reg.id,
    packageRevision: reg.revisions.package,
    graphRevision: reg.revisions.graph,
    mapRevision: reg.revisions.maps,
    targetBinding: targetKey,
    targetReferenceId: target?.reference ?? null,
    initiatingPanelId: null,
    initiatingReferenceId: null,
    selectedPathKeys: keep ? previous!.selectedPathKeys : selected,
    targetViewport: null,
    linkMode: 'independent',
    layoutSettings: keep ? previous!.layoutSettings : { contextBp: DEFAULT_CONTEXT_BP, laneHeight: 28 },
    ...(keep && previous!.reads ? { reads: previous!.reads } : {}),
    members,
    handoff: { pinnedLinear: previous?.handoff?.pinnedLinear ?? false, shown: 'graph' },
    bandSort: previous?.bandSort ?? 'position',
    syncSelection: previous?.syncSelection ?? true,
    // A preference of the host: kept across a retarget (another registration or target too).
    ...(previous?.popOutKind ? { popOutKind: previous.popOutKind } : {}),
  };
}

export function undoable(label: string, apply: () => void): void {
  seedHistoryBaseline(useBrowserStore.getState(), `Before ${label.charAt(0).toLowerCase()}${label.slice(1)}`, 'layout');
  apply();
  useBrowserStore.getState().pushSnapshot?.(label, { kind: 'layout' });
}

const fold = (p: PanelConfig, hostId: string): PanelConfig => {
  const { graphHandoff: _h, ...rest } = p;
  return { ...rest, collapsed: true, collapsedByGraphGroup: hostId, graphMemberOf: hostId };
};
const reveal = (p: PanelConfig, mark?: string): PanelConfig => {
  const { collapsedByGraphGroup: _c, graphHandoff: _h, ...rest } = p;
  return { ...rest, collapsed: false, ...(mark ? { graphHandoff: mark } : {}) };
};

/**
 * Pure: the panels with `hostId` viewing its graph. Its split siblings join as folded members; members it had before
 * (revealed when it went linear) fold back in. Null when the panel can't be a host.
 */
export function enterGraph(panels: PanelConfig[], hostId: string, bound: DatasetGraphBinding, view: LinearView): PanelConfig[] | null {
  const host = panels.find(p => p.id === hostId);
  if (!host || host.contentType !== 'dataset' || !host.datasetId) return null;
  const target = defaultTarget(bound.registration, view);
  const previous = host.graphView?.role === 'host' ? host.graphView : null;
  const already = previous?.members?.filter(m => m.panelId !== host.id && panels.find(p => p.id === m.panelId)?.graphMemberOf === host.id) ?? [];
  const siblings = splitSiblings(panels, host).filter(p => !already.some(m => m.panelId === p.id));
  const bindingOf = (p: PanelConfig) => {
    const b = useGraphBindingsStore.getState().byDataset[p.datasetId ?? '']?.find(x => x.registration.id === bound.registration.id)?.binding;
    return b ? memberBindingFor(p.liftHap, b, target?.key ?? null, bound.registration) : null;
  };
  const members: GraphMember[] = [{ panelId: host.id, binding: memberBindingFor(host.liftHap, bound.binding, target?.key ?? null, bound.registration) },
    ...already, ...siblings.map(p => ({ panelId: p.id, binding: bindingOf(p) }))];
  const graphView = hostGraphView(bound.registration, bound, view, members, previous);
  const joining = new Set([...already.map(m => m.panelId), ...siblings.map(p => p.id)]);
  const out = panels.map(p => {
    if (p.id === host.id) return { ...p, viewMode: 'graph' as const, graphView };
    // Members join folded; a member revealed by hand (no hand-off mark) stays as the user left it.
    if (joining.has(p.id) && (!p.graphMemberOf || p.graphHandoff === host.id || p.collapsedByGraphGroup === host.id)) return fold(p, host.id);
    return p;
  });
  // Wider than the hand-off (or a view with no graph): linear at once, members side by side (§7).
  const settings = useGraphSettings.getState();
  const shown = decideShown('graph', view.end - view.start, { outBp: settings.outBp, inBp: settings.inBp,
    pinnedLinear: previous?.handoff?.pinnedLinear, followable: canFollow(target, view) });
  return applyShown(out, host.id, shown);
}

/** Pure: the host drawn linear (the toggle, D5): its folded members are revealed side by side, marked, so viewing it
 * as a graph again folds them back. Its graph state stays for next time. */
export function leaveGraph(panels: PanelConfig[], hostId: string): PanelConfig[] {
  const host = panels.find(p => p.id === hostId);
  return panels.map(p => {
    if (p.id === hostId) return { ...p, viewMode: 'linear' as const };
    if (p.graphMemberOf === hostId && p.collapsedByGraphGroup === hostId) return host ? sharedView(reveal(p, hostId), host) : reveal(p, hostId);
    return p;
  });
}

/** View a dataset panel as a graph (or linear). Returns why not, or null when done. */
export function setPanelViewMode(panelId: string, mode: 'linear' | 'graph'): string | null {
  const store = useBrowserStore.getState();
  const panel = store.panels.find(p => p.id === panelId);
  if (!panel) return 'No such panel';
  if (mode === 'linear') {
    if (panel.viewMode !== 'graph') return null;
    undoable('View as linear', () => useBrowserStore.setState(s => ({ panels: leaveGraph(s.panels, panelId) })));
    return null;
  }
  if (isHost(panel)) return null;
  // A member of a host viewed linear for now: its host views the graph again (one graph, not a second host).
  const owner = panel.graphMemberOf ? store.panels.find(p => p.id === panel.graphMemberOf) : undefined;
  if (owner && owner.graphView?.role === 'host') return setPanelViewMode(owner.id, 'graph');
  const why = graphUnavailable(panel);
  if (why) return why;
  const bound = graphBindingFor(panel.datasetId)!;
  const next = enterGraph(store.panels, panelId, bound, panelView(panel));
  if (!next) return 'This panel has no graph view';
  undoable('View as graph', () => useBrowserStore.setState({ panels: next }));
  return null;
}

/** The members a host can pop out (folded ones), and the haplotype paths of a pooled host with no panel yet. */
export function poppable(panels: readonly PanelConfig[], host: PanelConfig): { folded: PanelConfig[]; missing: { binding: string; hap: string }[] } {
  const members = membersOf(panels, host);
  const folded = members.filter(m => m.panel.id !== host.id && m.panel.collapsedByGraphGroup === host.id).map(m => m.panel);
  const missing: { binding: string; hap: string }[] = [];
  if (host.datasetId && !host.liftHap) {
    const bound = graphBindingFor(host.datasetId);
    const haps = bound?.binding.haps ?? {};
    const shown = new Set(host.graphView?.selectedPathKeys ?? []);
    // One haplotype (a strain against its reference): its one panel is it; nothing to pop out (agy G8 review).
    const distinct = new Set(Object.values(haps).map(h => h.toUpperCase()));
    for (const [binding, hap] of distinct.size > 1 ? Object.entries(haps) : []) {
      if (!shown.has(binding)) continue;
      const has = members.some(m => m.panel.datasetId === host.datasetId && m.panel.id !== host.id
        && (m.member.binding === binding || (m.panel.liftHap ?? '').toUpperCase() === hap.toUpperCase()));
      if (!has) missing.push({ binding, hap });
    }
  }
  return { folded, missing };
}

/** A graph run's record provenance on a tree node (or of the current run): its destinations, observations and the
 * record keys each observation labelled. */
export type GraphProvenance = { destinations: string[]; observations: GraphRunObservation[]; owned: Record<string, string[]> };

type ProvenanceState = { clusterTreeNodes: Record<string, { parentId: string | null; graphProvenance?: GraphProvenance }>;
  clusterMatchedRun: import('../../utils/clusterMatchedRun').ClusterMatchedRun | null;
  clusterAssignments: Record<string, Record<string, number>> };

/** The provenance of the graph runs of a tree node's lineage (itself and its ancestors) that labelled `key`. */
export function provenanceLineage(s: ProvenanceState, key: string, nodeId: string | null | undefined): GraphProvenance[] {
  const out: GraphProvenance[] = [];
  for (let n = nodeId ? s.clusterTreeNodes[nodeId] : undefined, seen = 0; n && seen < 1000; n = n.parentId ? s.clusterTreeNodes[n.parentId] : undefined, seen++) {
    if (n.graphProvenance?.destinations.includes(key)) out.push(n.graphProvenance);
  }
  return out;
}

/** The current graph run's provenance for `key`, while its labels are the shown ones (none otherwise). */
export function liveProvenance(s: ProvenanceState, key: string): GraphProvenance[] {
  const run = s.clusterMatchedRun;
  return run?.graph && run.destinations?.some(d => d.stateKey === key) && currentMatchedRun(run, s.clusterAssignments) === run
    ? [{ destinations: run.destinations.map(d => d.stateKey), observations: run.graph.observations,
      owned: Object.fromEntries(Object.entries(run.assignments).map(([o, a]) => [o, Object.keys(a).map(id => recordKey(id) ?? id)])) }] : [];
}

/** Whether every label of a map is the provenance's (unassigned aside): only then can it be split by observation. */
export function provenanceCovers(provs: readonly GraphProvenance[], labels: Record<string, number> | undefined): boolean {
  if (!provs.length || !labels) return false;
  const known = new Set(provs.flatMap(p => Object.values(p.owned).flat()));
  return Object.entries(labels).every(([rid, c]) => c === UNASSIGNED_CLUSTER_ID || known.has(recordKey(rid) ?? rid));
}

/** The labels of the observations `shows` picks (their records, by record key). */
export function provenanceShare(provs: readonly GraphProvenance[], labels: Record<string, number>,
  shows: (o: GraphRunObservation) => boolean): Record<string, number> {
  const own = new Set(provs.flatMap(p => p.observations.filter(shows).flatMap(o => p.owned[o.id] ?? [])));
  return Object.fromEntries(Object.entries(labels).filter(([rid]) => own.has(recordKey(rid) ?? rid)));
}

/** Pop members out of a host's graph (one, some or all): revealed as ordinary panels, next to the host. A pooled
 * host's haplotype with no panel yet gets one, with a copy of the host's state (`copyPanelState`). */
export function popOut(hostId: string, memberIds: string[], newHaps: { binding: string; hap: string }[] = []): string[] {
  const store = useBrowserStore.getState();
  const host = store.panels.find(p => p.id === hostId);
  if (!isHost(host)) return [];
  const made: PanelConfig[] = newHaps.map(({ hap }) => {
    const id = generatePanelId();
    return { ...withoutGraphMembership(host), id, stateKey: id, liftHap: hap, liftHaplotypeMode: 'split', collapsed: false,
      graphMemberOf: host.id, subTracks: host.subTracks.map(t => ({ ...t })), linkGroup: host.linkGroup, regionLabel: undefined };
  });
  const ids = new Set(memberIds);
  if (!ids.size && !made.length) return [];
  undoable(memberIds.length + made.length > 1 ? 'Pop out haplotypes' : 'Pop out haplotype', () => useBrowserStore.setState(s => {
    const copied = copyPanelState(s as unknown as Record<string, unknown>, panelKeyOf(host), made.map(p => p.id));
    // A graph run's labels on the host: each new haplotype panel keeps only its own observations' rows, so the other
    // haplotype's labels never scope its reads (agy review of the group B fix: a "not a carrier" pop-out hid its
    // unlabelled reads). Each tree node is filtered with the provenance of the graph runs of its lineage (itself and
    // its ancestors: a subcluster's other rows are its parent run's), and only while every label it gives the host
    // is theirs (labels a later split or grouping wrote are left as they were); a panel left with no label gets none,
    // nor a focus or picks (agy round 3, Codex round 3).
    const hostKey = panelKeyOf(host);
    const lineage = (id: string | null | undefined) => provenanceLineage(s, hostKey, id);
    const fromRun = liveProvenance(s, hostKey);
    /** Each new panel's share of ``labels`` (null: not filtered, the copy stands). */
    const share = (provs: GraphProvenance[], labels: Record<string, number> | undefined) => {
      if (!provenanceCovers(provs, labels)) return null;
      return new Map(made.map(m => [m.id, provenanceShare(provs, labels!, o => observationShownBy(o, m))]));
    };
    if (made.length) {
      const activeId = s.activeClusterTreeNodeId;
      const liveShare = share(activeId && s.clusterTreeNodes[activeId] ? lineage(activeId) : fromRun, s.clusterAssignments[hostKey]);
      if (liveShare) {
        const without = (name: string, ids: string[]) => {
          const map = (copied[name] ?? (s as unknown as Record<string, unknown>)[name]) as Record<string, unknown> | undefined;
          if (!map) return;
          const next = { ...map };
          for (const id of ids) delete next[id];
          copied[name] = next;
        };
        const empty = made.filter(m => !Object.keys(liveShare.get(m.id)!).length).map(m => m.id);
        copied.clusterAssignments = { ...((copied.clusterAssignments ?? s.clusterAssignments) as Record<string, Record<string, number>>),
          ...Object.fromEntries(made.filter(m => !empty.includes(m.id)).map(m => [m.id, liveShare.get(m.id)!])) };
        without('clusterAssignments', empty);
        without('clusterFocus', empty);
        without('selectedClusters', empty);
      }
      const nodes = Object.fromEntries(Object.entries(s.clusterTreeNodes).flatMap(([nid, n]) => {
        const got = share(lineage(nid), n.assignments?.[hostKey]);
        const per = got ? made.map(m => [m.id, got.get(m.id)!] as const).filter(([, v]) => Object.keys(v).length) : [];
        if (!per.length) return [];
        const copyOf = <T,>(map: Record<string, T> | undefined, f: (v: T) => T) => (map?.[hostKey] !== undefined && map?.[hostKey] !== null
          ? { ...map, ...Object.fromEntries(per.map(([id]) => [id, f(map[hostKey])])) } : map);
        return [[nid, {
          ...n,
          assignments: { ...n.assignments, ...Object.fromEntries(per) },
          order: copyOf(n.order, v => [...v]) ?? n.order,
          focus: copyOf(n.focus, v => (v ? [...v] : v)) ?? n.focus,
          ...(n.groupLabels?.[hostKey] ? { groupLabels: copyOf(n.groupLabels, v => ({ ...v })) } : {}),
        }]];
      }));
      if (Object.keys(nodes).length) copied.clusterTreeNodes = { ...s.clusterTreeNodes, ...nodes };
    }
    // Its exclusions too (kept in the read actions store).
    const excluded = useReadActionsStore.getState().excludedReadIds[panelKeyOf(host)];
    if (excluded?.size) for (const m of made) useReadActionsStore.getState().excludeReads(m.id, [...excluded]);
    let panels = s.panels.map(p => (ids.has(p.id) && p.graphMemberOf === hostId ? sharedView(reveal(p), host) : p));
    const idx = panels.findIndex(p => p.id === hostId);
    panels = [...panels.slice(0, idx + 1), ...made.map(p => sharedView(p, host)), ...panels.slice(idx + 1)];
    panels = panels.map(p => (p.id === hostId ? { ...p, graphView: { ...p.graphView!, members: [...(p.graphView!.members ?? []),
      ...made.map((m, i) => ({ panelId: m.id, binding: newHaps[i].binding }))] },
      } : p));
    return { panels, ...copied };
  }));
  return [...memberIds, ...made.map(p => p.id)];
}

/** A pop-out of a host with a view of its own takes that view, and the host's moves carry it along while the two
 * stay in step (§4.3; moveHostMembers). A host following the main view: its pop-outs follow it too. */
export function sharedView(p: PanelConfig, host: PanelConfig): PanelConfig {
  return host.viewportOverride ? { ...p, viewportOverride: { ...host.viewportOverride } } : p;
}

/** Pure: a host with its own view moved from `prev` to `next`: its members still showing `prev` move with it (a
 * member the user moved elsewhere stays). */
export function moveHostMembers(panels: PanelConfig[], hostId: string, prev: { chrom: string; start: number; end: number },
  next: { chrom: string; start: number; end: number }): PanelConfig[] {
  const same = (v?: { chrom: string; start: number; end: number }) => Boolean(v && v.chrom === prev.chrom && v.start === prev.start && v.end === prev.end);
  let changed = false;
  const out = panels.map(p => {
    // Folded members always (their bands are the host's window); revealed ones while they are in step.
    if (p.graphMemberOf !== hostId || !p.viewportOverride || !(p.collapsedByGraphGroup === hostId || same(p.viewportOverride))) return p;
    changed = true;
    return { ...p, viewportOverride: { ...next } };
  });
  return changed ? out : panels;
}

/** Copy a panel's per-panel state maps to new keys (a pooled host's new haplotype panel starts where the host is;
 * rows of other haplotypes simply never show there). Never a reset (`isolatePanelState` is not used: C11). */
export function copyPanelState(state: Record<string, unknown>, fromKey: string, toKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!toKeys.length) return out;
  for (const name of PER_PANEL_STATE_KEYS) {
    const map = state[name] as Record<string, unknown> | undefined;
    if (!map || !(fromKey in map)) continue;
    const value = map[fromKey];
    const copy = (v: unknown) => (v instanceof Set ? new Set(v) : Array.isArray(v) ? [...v] : v && typeof v === 'object' ? { ...(v as object) } : v);
    out[name] = { ...map, ...Object.fromEntries(toKeys.map(k => [k, copy(value)])) };
  }
  return out;
}

/** Fold members back into their host's graph (hidden; state untouched). */
export function foldIn(hostId: string, memberIds: string[]): void {
  const ids = new Set(memberIds);
  const store = useBrowserStore.getState();
  if (!isHost(store.panels.find(p => p.id === hostId))) return;
  if (!store.panels.some(p => ids.has(p.id) && p.graphMemberOf === hostId && !p.collapsedByGraphGroup)) return;
  undoable(ids.size > 1 ? 'Fold into graph' : 'Fold into graph', () => useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (ids.has(p.id) && p.graphMemberOf === hostId ? fold(p, hostId) : p)),
    fullViewPanelId: s.fullViewPanelId && ids.has(s.fullViewPanelId) ? null : s.fullViewPanelId,
  })));
}

/** Dataset panels in view that could join a host's graph: they bind one of its shown paths in the same package. */
/**
 * View as graph from a panel selection (§1.3, graph features): the panel becomes the host and the other selected
 * panels that bind one of its graph's paths join it, folded. Without a selection, or with only this panel selected,
 * it is setPanelViewMode.
 */
export function viewSelectionAsGraph(panelId: string): string | null {
  const selected = [...useBrowserStore.getState().selectedDatasets].filter(id => id !== panelId);
  const why = setPanelViewMode(panelId, 'graph');
  if (why || !selected.length || !useBrowserStore.getState().selectedDatasets.has(panelId)) return why;
  joinGraph(panelId, selected);
  return null;
}

export function joinCandidates(panels: readonly PanelConfig[], host: PanelConfig): { panel: PanelConfig; binding: string | null }[] {
  const reg = host.graphView?.registrationId;
  const shown = new Set(host.graphView?.selectedPathKeys ?? []);
  const out: { panel: PanelConfig; binding: string | null }[] = [];
  for (const p of panels) {
    // A panel at another locus or reference never joins (its band would show the host's window while it analyses
    // its own); a host, even one viewed linear for now, keeps its own members.
    if (p.id === host.id || p.contentType !== 'dataset' || !p.datasetId || p.collapsed || isHost(p) || p.graphMemberOf
      || p.graphView?.role === 'host' || p.readSubset || p.liftLink) continue;
    if (JSON.stringify(p.viewportOverride ?? null) !== JSON.stringify(host.viewportOverride ?? null) || (p.genome ?? null) !== (host.genome ?? null)) continue;
    const b = useGraphBindingsStore.getState().byDataset[p.datasetId]?.find(x => x.registration.id === reg)?.binding;
    if (!b) continue;
    const registration = useGraphStatusStore.getState().status?.registrations.find(r => r.id === reg) ?? null;
    const binding = memberBindingFor(p.liftHap, b, host.graphView?.targetBinding ?? null, registration);
    const paths = binding ? [binding] : Object.keys(b.paths);
    if (paths.some(k => shown.has(k))) out.push({ panel: p, binding });
  }
  return out;
}

/** Join panels to a host's graph ("Add panels to this graph…", "Join <host> graph"): folded, state kept. */
export function joinGraph(hostId: string, panelIds: string[]): void {
  const store = useBrowserStore.getState();
  const host = store.panels.find(p => p.id === hostId);
  if (!isHost(host)) return;
  const candidates = joinCandidates(store.panels, host).filter(c => panelIds.includes(c.panel.id));
  if (!candidates.length) return;
  const ids = new Set(candidates.map(c => c.panel.id));
  undoable(candidates.length > 1 ? 'Join graph' : 'Join graph', () => useBrowserStore.setState(s => ({
    panels: s.panels.map(p => {
      if (p.id === hostId) return { ...p, graphView: { ...p.graphView!, members: [...(p.graphView!.members ?? []),
        ...candidates.map(c => ({ panelId: c.panel.id, binding: c.binding }))] } };
      return ids.has(p.id) ? fold(p, hostId) : p;
    }),
    fullViewPanelId: s.fullViewPanelId && ids.has(s.fullViewPanelId) ? null : s.fullViewPanelId,
  })));
}

/** "Remove from graph": the member is revealed and out of the host's graph (its state stays). */
export function removeFromGraph(panelId: string): void {
  const store = useBrowserStore.getState();
  const panel = store.panels.find(p => p.id === panelId);
  if (!panel?.graphMemberOf) return;
  const hostId = panel.graphMemberOf;
  undoable('Remove from graph', () => useBrowserStore.setState(s => ({
    panels: s.panels.map(p => {
      if (p.id === panelId) {
        const { graphMemberOf: _m, collapsedByGraphGroup: _c, graphHandoff: _h, ...rest } = p;
        return { ...rest, collapsed: false };
      }
      if (p.id === hostId && p.graphView?.members) return { ...p, graphView: { ...p.graphView, members: p.graphView.members.filter(m => m.panelId !== panelId) } };
      return p;
    }),
  })));
}

/** Datasets panels a standalone graph-view panel can become the graph view of (they bind its package). */
export function conversionTargets(panels: readonly PanelConfig[], standalone: PanelConfig): PanelConfig[] {
  const reg = standalone.graphView?.registrationId;
  return panels.filter(p => p.contentType === 'dataset' && p.datasetId && !p.collapsed && !isHost(p) && p.graphView?.role !== 'host' && !p.graphMemberOf && !p.readSubset
    && !p.liftLink && useGraphBindingsStore.getState().byDataset[p.datasetId]?.some(x => x.registration.id === reg));
}

/** "Make this the graph view of <panel>…": the dataset panel views its graph with the standalone panel's
 * registration, paths and layout, at the standalone panel's viewport (its own view, or the main view), and the
 * standalone panel closes. */
export function convertStandalone(standaloneId: string, datasetPanelId: string): string | null {
  const store = useBrowserStore.getState();
  const standalone = store.panels.find(p => p.id === standaloneId);
  const panel = store.panels.find(p => p.id === datasetPanelId);
  const sv = standalone?.graphView;
  if (!standalone || !sv || !panel?.datasetId) return 'Nothing to convert';
  const bound = useGraphBindingsStore.getState().byDataset[panel.datasetId]?.find(x => x.registration.id === sv.registrationId);
  if (!bound) return 'That panel\'s dataset is not bound by this graph package';
  const at = sv.targetViewport;
  const view: LinearView = at ? { chrom: at.contig, start: at.start, end: at.end, reference: panelView(panel).reference } : panelView(panel);
  const next = enterGraph(store.panels, datasetPanelId, bound, view);
  if (!next) return 'That panel has no graph view';
  undoable('Make graph view of panel', () => useBrowserStore.setState(s => {
    const panels = next.filter(p => p.id !== standaloneId).map(p => {
      if (p.id !== datasetPanelId) return p;
      const gv = { ...p.graphView!, selectedPathKeys: sv.targetBinding === p.graphView!.targetBinding ? sv.selectedPathKeys : p.graphView!.selectedPathKeys,
        layoutSettings: sv.layoutSettings, ...(sv.reads ? { reads: sv.reads } : {}) };
      return { ...p, graphView: gv };
    });
    // The panel takes the standalone view's viewport (its own viewport is the only authority), in the same step.
    const moved = at ? panels.map(p => (p.id === datasetPanelId && p.viewportOverride ? { ...p, viewportOverride: { chrom: at.contig, start: at.start, end: at.end } } : p)) : panels;
    const main = at && !panel.viewportOverride ? { chrom: at.contig, start: at.start, end: at.end } : {};
    return { panels: moved, ...main, fullViewPanelId: s.fullViewPanelId === standaloneId ? null : s.fullViewPanelId };
  }));
  return null;
}
