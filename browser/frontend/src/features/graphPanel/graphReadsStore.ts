/**
 * What each graph panel draws reads of (Gate F): its read bindings and the datasets whose molecules are on screen.
 * The shared molecule hover reads it (liveLift/linking/hover.ts `hoverScope`): a lifted or native panel of a dataset
 * a graph panel draws shares hovers with it, even with no linked source panel open; "Show source span" reads the
 * bindings to find a source panel of the same files.
 */
import { create } from 'zustand';
import type { GraphReadBinding } from './types';

interface GraphReadsState {
  byPanel: Record<string, { drawn: string[]; bindings: GraphReadBinding[] }>;
  publish: (panelId: string, drawn: string[], bindings: GraphReadBinding[]) => void;
  clear: (panelId: string) => void;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export const useGraphReadsStore = create<GraphReadsState>(set => ({
  byPanel: {},
  publish: (panelId, drawn, bindings) => set(s => {
    const prev = s.byPanel[panelId];
    const ids = [...drawn].sort();
    if (prev && same(prev.drawn, ids) && prev.bindings === bindings) return s;
    return { byPanel: { ...s.byPanel, [panelId]: { drawn: ids, bindings } } };
  }),
  clear: panelId => set(s => {
    if (!(panelId in s.byPanel)) return s;
    const { [panelId]: _gone, ...rest } = s.byPanel;
    return { byPanel: rest };
  }),
}));

/** Datasets whose molecules some open graph panel draws (`panels`: the open panel IDs). */
export function graphDrawnDatasets(byPanel: GraphReadsState['byPanel'], openPanelIds?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const [id, v] of Object.entries(byPanel)) {
    if (openPanelIds && !openPanelIds.has(id)) continue;
    for (const d of v.drawn) out.add(d);
  }
  return out;
}
