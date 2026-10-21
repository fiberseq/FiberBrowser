/**
 * The graph selection (inspection.ts): one at a time, and never at the same time as a dataset difference selection
 * (selecting one clears the other: together they are the inspector's one discriminated selection). Saved with the
 * session and undo snapshots; restored only in a valid shape, and then shown live only while its registration and
 * revisions still match (GraphInspector checks selectionProblem): never re-resolved by nearest geometry.
 */
import { registerStoreExtension } from '../../stores/storeExtensions';
import { useBrowserStore } from '../../stores/browserStore';
import { useDifferenceSelection } from '../differences/selectionStore';
import { isGraphSelection, type GraphSelection } from './inspection';

declare module '../../stores/browserStore' {
  interface BrowserState {
    /** The graph view's selection (inspector open when `graphInspect`). */
    graphSelection: GraphSelection | null;
    graphInspect: boolean;
  }
}

export function restoreGraphSelection(raw: unknown): GraphSelection | null {
  return isGraphSelection(raw) ? JSON.parse(JSON.stringify(raw)) as GraphSelection : null;
}

registerStoreExtension({
  id: 'graphSelection',
  keys: ['graphSelection', 'graphInspect'],
  create: () => ({ graphSelection: null, graphInspect: false }),
  serialize: s => ({ graphSelection: s.graphSelection ?? null, graphInspect: Boolean(s.graphInspect) }),
  restoreSnapshot: saved => {
    const graphSelection = restoreGraphSelection(saved.graphSelection);
    return { graphSelection, graphInspect: Boolean(graphSelection && saved.graphInspect) };
  },
  importSession: frontend => {
    const graphSelection = restoreGraphSelection(frontend?.graphSelection);
    return { graphSelection, graphInspect: Boolean(graphSelection && frontend?.graphInspect) };
  },
});

/** Select (and optionally inspect) a graph locus or difference; clears a dataset difference selection. */
export function selectGraph(selection: GraphSelection | null, inspect = false): void {
  if (selection && useDifferenceSelection.getState().selection) useDifferenceSelection.getState().select(null);
  useBrowserStore.setState({ graphSelection: selection, graphInspect: Boolean(selection && inspect) } as never);
}

export function closeGraphInspector(): void {
  useBrowserStore.setState({ graphInspect: false } as never);
}

// A dataset difference selected elsewhere replaces the graph selection.
useDifferenceSelection.subscribe(state => {
  if (state.selection && useBrowserStore.getState().graphSelection) {
    useBrowserStore.setState({ graphSelection: null, graphInspect: false } as never);
  }
});
