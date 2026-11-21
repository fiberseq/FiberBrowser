/**
 * What each graph panel draws reads of (Gate F): its read bindings and the datasets whose molecules are on screen.
 * The shared molecule hover reads it (liveLift/linking/hover.ts `hoverScope`): a lifted or native panel of a dataset
 * a graph panel draws shares hovers with it, even with no linked source panel open; "Show source span" reads the
 * bindings to find a source panel of the same files.
 */
import { create } from 'zustand';
import type { GraphRead, GraphReadBinding } from './types';
import { isMoleculeRecordKey } from '../../utils/recordKeys';

/** A drawn row's haplotype as the lifted panels show it: a molecule-level record key (`fold_molecule`) whose primary
 * record's row this panel drew, on its path's haplotype, which is the haplotype a lifted panel shows all the
 * molecule's rows on (graph follow-ups item 5); or a supplementary record on its primary's haplotype (`ph`), folded
 * or not (stabilize 3, item 1). */
export interface DrawnRowHap { rk: string; datasetId: string; hap: string; strand?: string | null }

/** The rows a graph panel publishes (DrawnRowHap): supplementaries whose primary the server found, on its haplotype;
 * folded molecules' primary rows on their path's. Other rows are on their own path's haplotype, as the run that
 * labels them: nothing to route. */
export function drawnRowHapsOf(reads: readonly GraphRead[]): DrawnRowHap[] {
  return reads.filter(r => r.rk && (r.sup ? Boolean(r.ph) : Boolean(r.hap) && isMoleculeRecordKey(r.rk)))
    .map(r => ({ rk: r.rk!, datasetId: r.d, hap: (r.sup ? r.ph : r.hap)!, ...(r.ds ? { strand: r.ds } : {}) }));
}

interface GraphReadsState {
  /** registrationId: the package the bindings were verified for (another package's same-named path is not it). */
  byPanel: Record<string, { drawn: string[]; bindings: GraphReadBinding[]; registrationId?: string | null }>;
  /** Per panel: the haplotypes the lifted panels show its rows on (DrawnRowHap): folded molecules' primary rows, and
   * supplementaries whose primary the server found (`ph`). */
  rowHaps: Record<string, DrawnRowHap[]>;
  publish: (panelId: string, drawn: string[], bindings: GraphReadBinding[], registrationId?: string | null) => void;
  publishRowHaps: (panelId: string, rows: DrawnRowHap[]) => void;
  clear: (panelId: string) => void;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export const useGraphReadsStore = create<GraphReadsState>(set => ({
  byPanel: {},
  rowHaps: {},
  publishRowHaps: (panelId, rows) => set(s => (!rows.length && !(panelId in s.rowHaps) ? s : { rowHaps: { ...s.rowHaps, [panelId]: rows } })),
  publish: (panelId, drawn, bindings, registrationId = null) => set(s => {
    const prev = s.byPanel[panelId];
    const ids = [...drawn].sort();
    if (prev && same(prev.drawn, ids) && prev.bindings === bindings && prev.registrationId === registrationId) return s;
    return { byPanel: { ...s.byPanel, [panelId]: { drawn: ids, bindings, registrationId } } };
  }),
  clear: panelId => set(s => {
    if (!(panelId in s.byPanel) && !(panelId in s.rowHaps)) return s;
    const { [panelId]: _gone, ...rest } = s.byPanel;
    const { [panelId]: _haps, ...restHaps } = s.rowHaps;
    return { byPanel: rest, rowHaps: restHaps };
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
