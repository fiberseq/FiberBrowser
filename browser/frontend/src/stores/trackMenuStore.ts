import { create } from 'zustand';
import type { SubTrackType } from '../types';
import type { ContextMenuEntry } from '../components/tracks/read-track/ReadContextMenu';

/**
 * Which per-panel track menu is open (fb-n11-tracks): the right-click menu of
 * a track row, its "Set height…" box, and a request for a panel header to open
 * its "Tracks in this panel" menu. One at a time; TrackContextMenuHost draws them.
 */
export interface OpenTrackMenu {
  panelId: string;
  type: SubTrackType;
  x: number;
  y: number;
  /** The track's own items (shown first; a separator, then the kind's and the common items). */
  own?: ContextMenuEntry[];
  onOwn?: (action: string) => void;
  /** The menu's heading (default: the track's label). */
  title?: string;
}

export interface OpenHeightEdit { panelId: string; type: SubTrackType; x: number; y: number }

interface TrackMenuState {
  menu: OpenTrackMenu | null;
  heightEdit: OpenHeightEdit | null;
  /** A panel whose header should open its Tracks menu (taken by that header). */
  tracksMenuFor: string | null;
  openMenu: (menu: OpenTrackMenu) => void;
  closeMenu: () => void;
  openHeightEdit: (edit: OpenHeightEdit) => void;
  closeHeightEdit: () => void;
  openPanelTracksMenu: (panelId: string) => void;
  takeTracksMenuRequest: (panelId: string) => boolean;
}

export const useTrackMenuStore = create<TrackMenuState>((set, get) => ({
  menu: null,
  heightEdit: null,
  tracksMenuFor: null,
  openMenu: (menu) => set({ menu, heightEdit: null }),
  closeMenu: () => set({ menu: null }),
  openHeightEdit: (heightEdit) => set({ heightEdit, menu: null }),
  closeHeightEdit: () => set({ heightEdit: null }),
  openPanelTracksMenu: (panelId) => set({ tracksMenuFor: panelId, menu: null }),
  takeTracksMenuRequest: (panelId) => {
    if (get().tracksMenuFor !== panelId) return false;
    set({ tracksMenuFor: null });
    return true;
  },
}));

/** Open a panel's "Tracks in this panel" menu (its header shows it). */
export function openPanelTracksMenu(panelId: string): void {
  useTrackMenuStore.getState().openPanelTracksMenu(panelId);
}
