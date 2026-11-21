/**
 * Selection sync across a graph (D14, §4.3; graph features): a read selected or deselected in any panel of a host's
 * graph — the host, a folded member, a popped-out member — is selected or deselected in every other member showing
 * the same dataset, whatever its haplotype (one molecule's records on two haplotypes, a pooled copy, a copy with
 * other filters), as a Shift-click on a graph row already does for its own path. Off with the host's "Sync selection
 * across the graph". Selections are QNAMEs in every view, so a selection names the molecule in each member, and in
 * the source views linked to the graph's lifted members (P3 source-view pop-outs: the same records, by QNAME).
 */
import { useBrowserStore } from '../../stores/browserStore';
import type { PanelConfig } from '../../types';
import { hostOf, isHost, membersOf } from './hostMode';
import { qnameOfId } from '../../utils/recordKeys';

const keyOf = (p: PanelConfig) => p.stateKey ?? p.datasetId ?? p.id;

/** The selection changes to mirror for one change of `changedKey`: [stateKey, QNAMEs to add, QNAMEs to remove]. */
export function mirroredSelections(panels: readonly PanelConfig[], changedKey: string,
  before: ReadonlySet<string> | undefined, after: ReadonlySet<string> | undefined,
  current: Readonly<Record<string, ReadonlySet<string> | undefined>>): [string, string[], string[]][] {
  const panel = panels.find(p => p.contentType === 'dataset' && keyOf(p) === changedKey);
  // A linked source panel (a source-view pop-out, §4.2) belongs to the graph its lifted panel is in.
  const host = panel?.liftLink ? sourceHost(panels, panel) : hostOf(panels, panel);
  if (!panel || !host || (host.graphView as { syncSelection?: boolean } | undefined)?.syncSelection === false) return [];
  const names = (s: ReadonlySet<string> | undefined) => new Set([...(s ?? [])].map(qnameOfId));
  const was = names(before), now = names(after);
  const added = [...now].filter(q => !was.has(q)), removed = [...was].filter(q => !now.has(q));
  if (!added.length && !removed.length) return [];
  const out: [string, string[], string[]][] = [];
  // The lifted dataset whose records these are (a source panel's link names it); its members and its source panels.
  const dataset = panel.liftLink?.datasetId ?? panel.datasetId;
  const peers = [...membersOf(panels, host).map(m => m.panel).filter(m => m.datasetId === dataset),
    ...panels.filter(p => p.contentType === 'dataset' && p.liftLink?.datasetId === dataset && sourceHost(panels, p)?.id === host.id)];
  for (const m of peers) {
    const k = keyOf(m);
    if (k === changedKey) continue;
    const have = names(current[k]);
    const add = added.filter(q => !have.has(q)), drop = removed.filter(q => have.has(q));
    if (add.length || drop.length) out.push([k, add, drop]);
  }
  return out;
}

/** The host a linked source panel's lifted panel belongs to (else a host with a member of its lifted dataset). */
export function sourceHost(panels: readonly PanelConfig[], source: PanelConfig): PanelConfig | null {
  const link = source.liftLink;
  if (!link) return null;
  const direct = hostOf(panels, panels.find(p => p.id === link.liftPanelId));
  if (direct) return direct;
  return panels.find(h => isHost(h) && membersOf(panels, h).some(m => m.panel.datasetId === link.datasetId)) ?? null;
}

let started = false;
export function startSelectionSync(): void {
  if (started) return;
  started = true;
  let applying = false;
  useBrowserStore.subscribe((s, prev) => {
    if (applying || s.selectedReadIds === prev.selectedReadIds) return;
    const changed = Object.keys({ ...s.selectedReadIds, ...prev.selectedReadIds })
      .filter(k => s.selectedReadIds[k] !== prev.selectedReadIds[k]);
    const updates = new Map<string, Set<string>>();
    for (const k of changed) {
      for (const [mk, add, drop] of mirroredSelections(s.panels, k, prev.selectedReadIds[k], s.selectedReadIds[k], s.selectedReadIds)) {
        const next = updates.get(mk) ?? new Set([...(s.selectedReadIds[mk] ?? [])]);
        // The member keeps its own ids where it has them; a mirrored name is added as the QNAME.
        for (const q of add) next.add(q);
        for (const id of [...next]) if (drop.includes(qnameOfId(id))) next.delete(id);
        updates.set(mk, next);
      }
    }
    if (!updates.size) return;
    applying = true;
    try {
      useBrowserStore.setState(st => ({ selectedReadIds: { ...st.selectedReadIds, ...Object.fromEntries(updates) } }));
    } finally {
      applying = false;
    }
  });
}
