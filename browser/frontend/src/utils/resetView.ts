import { useBrowserStore } from '../stores/browserStore';
import { seedHistoryBaseline } from '../stores/historySlice';
import { useReadActionsStore } from '../stores/readActionsStore';

/**
 * Reset view as one undoable step (the button beside Undo/Redo and the R key):
 * a checkpoint of what is about to be cleared, the reset, then the step itself,
 * so Undo brings the clustering, filters and selections back and Redo clears
 * them again.
 */
export function resetViewUndoably(): void {
  seedHistoryBaseline(useBrowserStore.getState(), 'Before reset view', 'analysis');
  useBrowserStore.getState().resetView();
  // Reads hidden with "Exclude selected" go too (part of the step: Undo brings them back),
  // and read highlights (not saved: Undo leaves them cleared).
  useReadActionsStore.getState().clearExcluded();
  useReadActionsStore.getState().clearHighlight();
  useBrowserStore.getState().pushSnapshot('Reset view', { kind: 'analysis' });
}
