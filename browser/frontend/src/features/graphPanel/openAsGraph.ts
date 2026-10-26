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
import { offerGraphView } from './graphOffer';
import { useGraphSettings } from './handoff';
import { referenceMatches } from './state';
import { useGraphStatusStore } from './statusStore';
import { genomeKeyFor } from '../../utils/regionNavigation';

/** Dataset id -> its panels as split (a user action on them before the bindings arrive cancels the graph open). */
const pending = new Map<string, string>();

/** The dataset's panels as the user sees them: layout, and (graph features, thin report MED 4) their read state —
 * a filter, sort, selection or cluster run made on them while the bindings load cancels the open too. */
const signature = (datasetId: string) => {
  const s = useBrowserStore.getState();
  const size = (v: { size: number } | readonly unknown[] | Record<string, unknown> | null | undefined) =>
    (v == null ? null : 'size' in v && typeof v.size === 'number' ? v.size : Array.isArray(v) ? v.length : Object.keys(v).length);
  return JSON.stringify(s.panels
    .filter(p => p.contentType === 'dataset' && p.datasetId === datasetId)
    .map(p => {
      const k = p.stateKey ?? p.datasetId!;
      return [p.id, p.liftHap ?? null, p.collapsed, p.layoutRow ?? 0, p.layoutColumn ?? null, p.title ?? null, p.viewportOverride ?? null,
        p.stateKey ?? null, size(s.filteredReadIds[k]), size(s.selectedReadIds[k]), size(s.readSortOrder[k]), size(s.clusterAssignments[k])];
    }));
};

export function notePendingGraphOpen(datasetId: string): void {
  pending.set(datasetId, signature(datasetId));
  queueMicrotask(settlePendingGraphOpens);
}

/** Open the pending datasets whose bindings are known: as a graph when bound and untouched, else left split. */
export function settlePendingGraphOpens(): void {
  if (!pending.size) return;
  const bindings = useGraphBindingsStore.getState();
  if (bindings.key == null || bindings.loading) return;
  for (const [datasetId, split] of [...pending]) {
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
    // Untouched since the split (moved, renamed, hidden, navigated: left as the user has it; the header offers it).
    // (One haplotype: its one panel, which has no haplotype of its own to split by, G8.)
    const untouched = signature(datasetId) === split && mine.length >= 1 && (mine.length === 1 || mine.every(p => p.liftHap))
      && mine.every(p => !p.collapsed && !isHost(p) && !p.graphMemberOf);
    if (!untouched) { offerGraphView(datasetId); continue; }   // the chip offers it instead (§5.2 step 3)
    const next = enterGraph(s.panels, mine[0].id, bound, panelView(mine[0]));
    if (!next) continue;
    seedHistoryBaseline(s, 'Before opening as graph', 'layout');
    useBrowserStore.setState({ panels: next });
    useBrowserStore.getState().pushSnapshot?.('Open as graph', { kind: 'layout' });
  }
}

/**
 * "Open in graph mode" for a native dataset (DESIGN_GRAPH_PRIMARY §1.4, §5.3, D3: off by default): offered while
 * the graph helper is there and a registered package's target is on the loaded genome (which contig binds is known
 * once the dataset is loaded: an unbound dataset simply stays linear).
 */
export function nativeGraphOffered(): boolean {
  const status = useGraphStatusStore.getState().status;
  if (!status?.helper.available || !status.registrations.length) return false;
  const reference = genomeKeyFor(null, useBrowserStore.getState());
  return status.registrations.some(r => [...new Set(r.maps.map(m => m.target))]
    .some(k => { const b = r.bindings.find(x => x.key === k); return Boolean(b && (!reference || referenceMatches(b, reference))); }));
}

/** Whether native datasets opened from files open in graph mode (the browser setting; a form's checkbox overrides). */
export function nativeOpensAsGraph(): boolean {
  return useGraphSettings.getState().nativeOpenView === 'graph';
}

/**
 * A native dataset just opened with "Open in graph mode": its panel keeps the choice as a display preference
 * (`openAs`, saved with the session, never in LiftSettings: §1.4), and becomes a graph host once its binding is
 * known, unless the user acted on it first (the header toggle offers it then). Lifted datasets have their own
 * "Open as" (the Add live lift dialog).
 */
export function openNativeAsGraph(datasetId: string): void {
  const s = useBrowserStore.getState();
  const dataset = s.datasets.find(d => d.id === datasetId);
  if (!dataset || dataset.data_type !== 'bam') return;
  if (s.panels.some(p => p.datasetId === datasetId && p.contentType === 'dataset' && p.openAs !== 'graph')) {
    useBrowserStore.setState(st => ({ panels: st.panels.map(p => (p.datasetId === datasetId && p.contentType === 'dataset' && !p.readSubset
      ? { ...p, openAs: 'graph' as const } : p)) }));
  }
  notePendingGraphOpen(datasetId);
}
