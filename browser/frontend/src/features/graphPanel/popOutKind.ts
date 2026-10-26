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
import { isHost, popOut, undoable } from './hostMode';
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
  /** Source views to open: the lifted panel they link to and the haplotype label (null: its one haplotype). */
  sources: { liftPanelId: string; hap: string | null }[];
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
    plan.sources.push({ liftPanelId: p.datasetId === host.datasetId ? host.id : p.id, hap: p.liftHap ?? null });
  }
  if (source && hasSource(host)) for (const m of missing) plan.sources.push({ liftPanelId: host.id, hap: m.hap });
  return plan;
}

/** Pop out members of a host's graph as its pop-out kind says (header menus, the checklist, the lane menu). */
export function popOutPaths(hostId: string, memberIds: string[], missing: { binding: string; hap: string }[] = []): string[] {
  const s = useBrowserStore.getState();
  const host = s.panels.find(p => p.id === hostId);
  if (!isHost(host)) return [];
  const plan = popOutPlan(s.panels, s.datasets, host, memberIds, missing);
  const out = plan.reveal.length || plan.make.length ? popOut(hostId, plan.reveal, plan.make) : [];
  if (plan.sources.length) void openSources(plan.sources);
  return out;
}

/** One after another (each opens a dataset and a reference, and takes its own undo step). A source view already
 * open is revealed (and relinked) as one undo step of its own: openLinkedSourceView records none for it (Codex
 * review, group H). */
async function openSources(sources: PopOutPlan['sources']): Promise<void> {
  for (const { liftPanelId, hap } of sources) {
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
    const id = await openLinkedSourceView(liftPanelId, hap);
    // Its labels belong to the step that opened it.
    if (id && labelLinkedSource(id)) {
      const st = useBrowserStore.getState();
      st.foldIntoCurrentSnapshot?.(serializeState(st));
    }
  }
}
