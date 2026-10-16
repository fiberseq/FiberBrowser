import type { BrowserState } from './browserStore';
import type { JupyterHighlight, JupyterMarker, JupyterFootprintColor } from '../types';


// ============================================================
// JUPYTER SLICE — Interface
// ============================================================

export interface JupyterSlice {
  jupyterHighlights: JupyterHighlight[];
  jupyterMarkers: JupyterMarker[];
  jupyterFootprintColors: JupyterFootprintColor[];
  jupyterReadOrder: Record<string, string[]>;  // dataset_id -> ordered read_ids
  jupyterReadFilter: Record<string, string[]>;  // dataset_id -> read_ids to show
  jupyterPushedReads: Array<{ id: string; intervals: [number, number, number][] }> | null;  // Custom reads from Jupyter
  jupyterVersion: number;  // For change detection
  jupyterGoto: { chrom: string; start: number; end: number } | null;  // Navigation target
  
  // Primer Design
  setJupyterHighlights: (highlights: JupyterHighlight[]) => void;
  setJupyterMarkers: (markers: JupyterMarker[]) => void;
  setJupyterFootprintColors: (colors: JupyterFootprintColor[]) => void;
  setJupyterReadOrder: (order: Record<string, string[]>) => void;
  setJupyterReadFilter: (filter: Record<string, string[]>) => void;
  setJupyterPushedReads: (reads: Array<{ id: string; intervals: [number, number, number][] }> | null) => void;
  setJupyterVersion: (version: number) => void;
  setJupyterGoto: (goto: { chrom: string; start: number; end: number } | null) => void;
  
  // Primer actions
}

// ============================================================
// JUPYTER SLICE — Implementation
// ============================================================

export function createJupyterSlice(set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void, get: () => BrowserState): JupyterSlice {
  return {
  jupyterHighlights: [],
  jupyterMarkers: [],
  jupyterFootprintColors: [],
  jupyterReadOrder: {},
  jupyterReadFilter: {},
  jupyterPushedReads: null,
  jupyterVersion: 0,
  jupyterGoto: null,
  
  setJupyterHighlights: (highlights) => set({ jupyterHighlights: highlights }),
  setJupyterMarkers: (markers) => set({ jupyterMarkers: markers }),
  setJupyterFootprintColors: (colors) => set({ jupyterFootprintColors: colors }),
  setJupyterReadOrder: (order) => set(state => {
    // Polling the notebook bridge often echoes the same order (including an
    // absent entry versus an empty one). Preserve references when unchanged so
    // a routine refresh cannot invalidate an in-flight browser operation.
    const keys = new Set([...Object.keys(state.jupyterReadOrder), ...Object.keys(order)]);
    if ([...keys].every(key => {
      const before = state.jupyterReadOrder[key] ?? [], after = order[key] ?? [];
      return before.length === after.length && before.every((id, i) => id === after[i]);
    })) return state;
    return { jupyterReadOrder: order };
  }),
  setJupyterReadFilter: (filter) => set({ jupyterReadFilter: filter }),
  setJupyterPushedReads: (reads) => set({ jupyterPushedReads: reads }),
  setJupyterVersion: (version) => set({ jupyterVersion: version }),
  setJupyterGoto: (goto) => set({ jupyterGoto: goto }),
  
  // Primer actions
  };
}
