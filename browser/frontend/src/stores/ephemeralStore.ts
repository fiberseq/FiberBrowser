/**
 * Ephemeral store for high-frequency mouse/pan state.
 * Separated from the main store to prevent cascading re-renders
 * when crosshair or pan offset changes (every mouse move).
 */
import { create } from 'zustand';

interface EphemeralState {
  hoveredMatchGroup: string | null;
  hoveredPanelRegion: { groupId: string; label: string } | null;
  hoveredRegion: { groupId: string; label: string } | null;
  crosshairX: number | null;
  crosshairLabel: string | null;
  crosshairGenomePos: number | null;
  /** Where the crosshair line ends (container px): the bottom of the panels under it; null: the container's bottom. */
  crosshairBottom: number | null;
  panOffset: number;
  isPanning: boolean;
  /**
   * Which view the current panOffset belongs to: 'main' for everything that
   * follows the main viewport, or a panel's own scope for a panel navigated on
   * its own (see usePanOffsetTransform), so dragging one doesn't slide the other.
   */
  panScope: string;
  setCrosshair: (x: number | null, label: string | null, genomePos?: number | null, bottom?: number | null) => void;
  /** ``scope``: the view the offset belongs to (default 'main'). */
  setPanOffset: (offset: number, scope?: string) => void;
  setIsPanning: (panning: boolean) => void;
  resetPanState: () => void;
}

export const useEphemeralStore = create<EphemeralState>((set) => ({
  hoveredMatchGroup: null,
  hoveredPanelRegion: null,
  hoveredRegion: null,
  crosshairX: null,
  crosshairLabel: null,
  crosshairGenomePos: null,
  crosshairBottom: null,
  panOffset: 0,
  isPanning: false,
  panScope: 'main',
  setCrosshair: (x, label, genomePos, bottom) => set({
    crosshairX: x,
    crosshairLabel: label,
    crosshairGenomePos: genomePos ?? null,
    crosshairBottom: bottom ?? null,
  }),
  setPanOffset: (offset, scope = 'main') => set({ panOffset: offset, panScope: scope }),
  setIsPanning: (panning) => set({ isPanning: panning }),
  resetPanState: () => set({ panOffset: 0, isPanning: false, panScope: 'main' }),
}));
