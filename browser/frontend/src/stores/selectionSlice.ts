import type { BrowserState } from './browserStore';
import { logActivity } from '../utils/activityLog';

// ============================================================
// SELECTION SLICE — Per-read multi-selection state
// ============================================================

export interface SelectionSlice {
  selectedReadIds: Record<string, Set<string>>;  // datasetId → set of readIds
  toggleReadSelection: (datasetId: string, readId: string) => void;
  setReadSelection: (datasetId: string, readIds: Set<string>) => void;
  clearReadSelection: (datasetId?: string) => void;
}

export function createSelectionSlice(
  set: (fn: ((state: BrowserState) => Partial<BrowserState>) | Partial<BrowserState>) => void,
  _get: () => BrowserState,
): SelectionSlice {
  return {
    selectedReadIds: {},

    toggleReadSelection: (datasetId, readId) => set(state => {
      const prev = state.selectedReadIds[datasetId];
      const next = new Set(prev);
      const action = next.has(readId) ? 'deselect_read' : 'select_read';
      if (next.has(readId)) next.delete(readId);
      else next.add(readId);
      logActivity({ timestamp: Date.now(), kind: 'ui', label: action,
        details: { datasetId, readId, totalSelected: next.size } });
      return {
        selectedReadIds: { ...state.selectedReadIds, [datasetId]: next },
      };
    }),

    setReadSelection: (datasetId, readIds) => set(state => {
      logActivity({ timestamp: Date.now(), kind: 'ui', label: 'set_read_selection',
        details: { datasetId, count: readIds.size } });
      return {
        selectedReadIds: { ...state.selectedReadIds, [datasetId]: readIds },
      };
    }),

    clearReadSelection: (datasetId?) => set(state => {
      logActivity({ timestamp: Date.now(), kind: 'ui', label: 'clear_read_selection',
        details: datasetId ? { datasetId } : { all: true } });
      if (datasetId) {
        const copy = { ...state.selectedReadIds };
        delete copy[datasetId];
        return { selectedReadIds: copy };
      }
      return { selectedReadIds: {} };
    }),
  };
}
