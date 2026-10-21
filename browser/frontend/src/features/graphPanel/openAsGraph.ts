/**
 * A new lifted dataset opens in graph mode (DESIGN_GRAPH_PRIMARY §5.2, D2; graph primary G6): it is split by haplotype
 * as before (liveLift/register.tsx), then, once the read bindings say a registered package binds it, its first
 * haplotype panel becomes the host and the other haplotype panels fold into it. Without a usable package nothing
 * changes (the split panels stay). A binding that arrives after the user acted on those panels never rearranges them:
 * the header's "Linear ⇄ Graph" toggle offers it instead.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { graphBindingFor, useGraphBindingsStore } from './bindingsStore';
import { enterGraph, isHost, panelView } from './hostMode';

const pending = new Set<string>();

export function notePendingGraphOpen(datasetId: string): void {
  pending.add(datasetId);
  queueMicrotask(settlePendingGraphOpens);
}

/** Open the pending datasets whose bindings are known: as a graph when bound and untouched, else left split. */
export function settlePendingGraphOpens(): void {
  if (!pending.size) return;
  const bindings = useGraphBindingsStore.getState();
  if (bindings.key == null || bindings.loading) return;
  for (const datasetId of [...pending]) {
    const s = useBrowserStore.getState();
    const mine = s.panels.filter(p => p.contentType === 'dataset' && p.datasetId === datasetId && !p.readSubset && !p.liftLink);
    const bound = graphBindingFor(datasetId, bindings);
    if (!s.datasets.some(d => d.id === datasetId)) { pending.delete(datasetId); continue; }
    if (!bound) {
      // Not known yet for this dataset (its bindings are read again when the datasets change): wait, unless the
      // answer already covers it (it binds nothing).
      if (bindings.covered.includes(datasetId)) pending.delete(datasetId);
      continue;
    }
    pending.delete(datasetId);
    const untouched = mine.length > 1 && mine.every(p => p.liftHap && !p.collapsed && !isHost(p) && !p.graphMemberOf);
    if (!untouched) continue;
    const next = enterGraph(s.panels, mine[0].id, bound, panelView(mine[0]));
    if (!next) continue;
    seedHistoryBaseline(s, 'Before opening as graph', 'layout');
    useBrowserStore.setState({ panels: next });
    useBrowserStore.getState().pushSnapshot?.('Open as graph', { kind: 'layout' });
  }
}
