import type { BrowserState } from './browserStore';
import type { CompositeTrack } from '../types/dataset';

// ============================================================
// SAVED TRACKS SLICE — a library of cart-track presets the user can re-add
// to the cart later. Each entry is a frozen CompositeTrack template (sources
// + colors + scale + log + visibility). Loading one clones the template and
// drops a fresh-id copy into the cart. Persists in autosave alongside the
// catalog so saved presets survive reloads.
// ============================================================

export interface SavedTrack {
  id: string;          // uuid
  name: string;
  savedAt: string;     // ISO timestamp
  composite: Omit<CompositeTrack, 'id'> & { id?: string };
}

export interface SavedTracksSlice {
  savedTracks: SavedTrack[];

  /** Snapshot a CompositeTrack into the saved library. Returns the new id. */
  saveCompositeAsTrack: (compositeId: string, name: string) => string | null;
  /** Replace whole array (used by session restore). */
  setSavedTracks: (saved: SavedTrack[]) => void;
  /** Drop a saved entry from the library. */
  removeSavedTrack: (id: string) => void;
  /** Clone a saved entry into the cart with a fresh CompositeTrack id and
   *  fresh source ids. Returns the new composite's id, or null if not found. */
  loadSavedTrackToCart: (savedId: string) => string | null;
}

export function createSavedTracksSlice(
  set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void,
  get: () => BrowserState,
): SavedTracksSlice {
  const ensureSavedTrackBaseline = () => {
    const state = get();
    if ((state._historyStack?.length ?? 0) === 0) {
      state.pushSnapshot?.('Before saved track change', { kind: 'layout' });
    }
  };

  const pushSavedTrackHistory = (label: string) => {
    get().pushSnapshot?.(label, { kind: 'layout' });
  };

  return {
    savedTracks: [],

    saveCompositeAsTrack: (compositeId, name) => {
      const composite = get().compositeTracks.find(c => c.id === compositeId);
      if (!composite) return null;
      // Strip the live id and the seeded-default flag so the saved version
      // is a plain template the user can reuse.
      const { id: _id, removable: _r, groupAutoscaleSelected: _sel, ...rest } = composite;
      const saved: SavedTrack = {
        id: crypto.randomUUID(),
        name: name.trim() || composite.label || 'Saved track',
        savedAt: new Date().toISOString(),
        composite: { ...rest, groupAutoscaleSelected: false },
      };
      ensureSavedTrackBaseline();
      set(state => ({ savedTracks: [...state.savedTracks, saved] }));
      pushSavedTrackHistory(`Save track preset ${saved.name}`);
      return saved.id;
    },

    setSavedTracks: (saved) => set({ savedTracks: saved }),

    removeSavedTrack: (id) => {
      const saved = get().savedTracks.find(s => s.id === id);
      if (!saved) return;
      ensureSavedTrackBaseline();
      set(state => ({
        savedTracks: state.savedTracks.filter(s => s.id !== id),
      }));
      pushSavedTrackHistory(`Delete track preset ${saved.name}`);
    },

    loadSavedTrackToCart: (savedId) => {
      const saved = get().savedTracks.find(s => s.id === savedId);
      if (!saved) return null;
      const fresh = {
        ...saved.composite,
        // Fresh source ids so per-source mutations on the loaded copy don't
        // accidentally edit a different copy if the user loads the same
        // saved track twice.
        sources: saved.composite.sources.map(s => ({ ...s, id: crypto.randomUUID() })),
        // Force-removable copy: the seeded default's `removable: false` flag
        // shouldn't carry over to a user-loaded preset.
        removable: true,
        groupAutoscaleSelected: false,
      };
      return get().addComposite(fresh);
    },
  };
}
