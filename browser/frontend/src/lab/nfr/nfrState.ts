/**
 * The NFR panel's state in the browser store (stores/storeExtensions.ts): saved NFRs and their variants, the motif
 * view's parameters and the ChIP-Atlas experiment choice. Saved with sessions and undo snapshots, persisted on this
 * computer, and reset for a session without them.
 */
import { registerStoreExtension } from '../../stores/storeExtensions';
import { useBrowserStore } from '../../stores/browserStore';
import { loadPinnedMotifs, normalizePinnedMotifs, PINNED_MOTIFS_STORAGE_KEY, type PinnedMotifs } from '../../utils/pinnedMotifs';
import type { ChipAtlasSelection } from './api';
import { loadStoredChipAtlasSelections, normalizeChipAtlasSelections, storeStoredChipAtlasSelections } from './chipAtlasSelection';
import { loadNfrMotifSettings, normalizeNfrMotifSettings, storeNfrMotifSettings, type NfrMotifSettings } from './nfrMotifSettings';
import { loadSavedNfrVariants, normalizeSavedNfrVariants, sameSavedNfr, storeSavedNfrVariants, type SavedNfr } from './savedNfrVariants';
import { useAccessibilityStore } from './accessibilityStore';
import { resetJobs } from './nfrJobs';

export interface NfrStateSlice {
  // Saved NFRs with their variants (the panel's Saved tab, one entry per NFR; savedNfrVariants.ts)
  savedNfrVariants: SavedNfr[];
  /** Saves NFRs: a new NFR is added; an NFR already saved from the same run gets the newly ticked variants ticked.
   * Returns how many variants became saved. */
  addSavedNfrVariants: (entries: Omit<SavedNfr, 'id' | 'savedAt'>[]) => number;
  updateSavedNfrVariant: (id: string, patch: Partial<Pick<SavedNfr, 'name' | 'color' | 'note'>>) => void;
  /** Tick or untick one variant of a saved NFR (shown in its views or not). */
  setSavedNfrVariantShown: (id: string, variantId: string, shown: boolean) => void;
  removeSavedNfrVariant: (id: string) => void;
  clearSavedNfrVariants: () => void;
  nfrMotifSettings: NfrMotifSettings;
  setNfrMotifSettings: (patch: Partial<NfrMotifSettings> | null) => void;
  /** The ChIP-Atlas experiments the NFR panel's peak check takes, per assembly (chipAtlasSelection.ts). */
  chipAtlasSelections: Record<string, ChipAtlasSelection>;
  setChipAtlasSelection: (genome: string, selection: ChipAtlasSelection | null) => void;
}

declare module '../../stores/browserStore' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface BrowserState extends NfrStateSlice {}
}

/** Pinned motifs saved before they were shared with Footprints (the NFR motif view's own key, in old sessions). */
const LEGACY_PINNED_KEY = 'pinnedNfrMotifs';
const LEGACY_PINNED_STORAGE_KEY = 'fiberhmm_nfr_pinned_motifs';

function legacyPins(saved: Record<string, unknown> | undefined): { pinnedMotifs: PinnedMotifs } | Record<string, never> {
  return saved && !saved.pinnedMotifs && saved[LEGACY_PINNED_KEY] ? { pinnedMotifs: normalizePinnedMotifs(saved[LEGACY_PINNED_KEY]) } : {};
}

/** This computer's pinned motifs from before they moved to the shared key. */
function migrateStoredPins(): void {
  try {
    const old = localStorage.getItem(LEGACY_PINNED_STORAGE_KEY);
    if (old && !localStorage.getItem(PINNED_MOTIFS_STORAGE_KEY)) {
      localStorage.setItem(PINNED_MOTIFS_STORAGE_KEY, old);
      useBrowserStore.setState({ pinnedMotifs: loadPinnedMotifs() });
    }
  } catch { /* private mode */ }
}

export function registerNfrState(): void {
  migrateStoredPins();
  registerStoreExtension({
    id: 'lab.nfr',
    keys: ['savedNfrVariants', 'nfrMotifSettings', 'chipAtlasSelections'],
    create: (set) => ({
      savedNfrVariants: loadSavedNfrVariants(),
      addSavedNfrVariants: (entries) => {
        let added = 0;
        set(state => {
          const next = [...state.savedNfrVariants];
          // structural changes (an entry migrated with only some variants gets the missing ones, unticked) are kept even
          // when no variant becomes newly saved
          let changed = false;
          for (const e of entries) {
            const at = next.findIndex(x => sameSavedNfr(x, e));
            if (at < 0) {
              next.push({ ...e, id: crypto.randomUUID(), savedAt: Date.now() });
              added += e.variants.filter(v => v.shown).length;
              changed = true;
              continue;
            }
            const old = next[at];
            const variants = [...old.variants];
            for (const v of e.variants) {
              const i = variants.findIndex(x => x.variantId === v.variantId);
              if (i < 0) { variants.push(v); changed = true; if (v.shown) added += 1; }
              else if (v.shown && !variants[i].shown) { variants[i] = { ...variants[i], shown: true }; added += 1; changed = true; }
            }
            next[at] = { ...old, variants };
          }
          return changed ? { savedNfrVariants: normalizeSavedNfrVariants(next) } : {};
        });
        return added;
      },
      setSavedNfrVariantShown: (id, variantId, shown) => set(state => ({
        savedNfrVariants: state.savedNfrVariants.map(e => (e.id === id
          ? { ...e, variants: e.variants.map(v => (v.variantId === variantId ? { ...v, shown } : v)) } : e)),
      })),
      updateSavedNfrVariant: (id, patch) => set(state => ({
        savedNfrVariants: state.savedNfrVariants.map(e => (e.id === id ? { ...e, ...patch } : e)),
      })),
      removeSavedNfrVariant: (id) => set(state => ({ savedNfrVariants: state.savedNfrVariants.filter(e => e.id !== id) })),
      clearSavedNfrVariants: () => set({ savedNfrVariants: [] }),
      nfrMotifSettings: loadNfrMotifSettings(),
      setNfrMotifSettings: (patch: Partial<NfrMotifSettings> | null) => set(state => ({ nfrMotifSettings: patch == null ? normalizeNfrMotifSettings(undefined) : normalizeNfrMotifSettings({ ...state.nfrMotifSettings, ...patch }) })),
      chipAtlasSelections: loadStoredChipAtlasSelections(),
      setChipAtlasSelection: (genome, selection) => set(state => {
        const next = { ...state.chipAtlasSelections };
        if (selection == null) delete next[genome];
        else next[genome] = selection;
        return { chipAtlasSelections: normalizeChipAtlasSelections(next) };
      }),
    } satisfies NfrStateSlice),
    serialize: state => ({
      savedNfrVariants: normalizeSavedNfrVariants(state.savedNfrVariants),
      nfrMotifSettings: state.nfrMotifSettings,
      chipAtlasSelections: state.chipAtlasSelections,
    }),
    restoreSnapshot: s => ({
      savedNfrVariants: normalizeSavedNfrVariants(s.savedNfrVariants),
      ...(s.nfrMotifSettings ? { nfrMotifSettings: normalizeNfrMotifSettings(s.nfrMotifSettings) } : {}),
      ...(s.chipAtlasSelections ? { chipAtlasSelections: normalizeChipAtlasSelections(s.chipAtlasSelections) } : {}),
      ...legacyPins(s),
    }),
    importSettings: frontend => ('nfrMotifSettings' in frontend ? { nfrMotifSettings: normalizeNfrMotifSettings(frontend.nfrMotifSettings) } : {}),
    importSession: (frontend, state) => ({
      // Saved NFR variants are the session's: its own, or none for a session without them.
      savedNfrVariants: normalizeSavedNfrVariants(frontend ? frontend.savedNfrVariants : undefined),
      // The ChIP-Atlas experiment choice, per assembly: the session's genomes take its choice, the others keep theirs.
      ...(frontend?.chipAtlasSelections
        ? { chipAtlasSelections: { ...state.chipAtlasSelections, ...normalizeChipAtlasSelections(frontend.chipAtlasSelections) } } : {}),
      ...legacyPins(frontend),
    }),
    onSessionImport: () => {
      // A run shown before belongs to the previous session; the panel looks up the imported session's runs again.
      useAccessibilityStore.getState().reset();
      // The previous session's slow requests (motif scans, ChIP-Atlas, quantify) and their notices.
      resetJobs();
    },
    // Saved NFR variants persist like the footprint cart: whatever changes them (the Saved tab, undo, a session) is
    // written back to localStorage.
    persist: (state, previous) => {
      if (state.savedNfrVariants !== previous.savedNfrVariants) storeSavedNfrVariants(state.savedNfrVariants);
      if (state.nfrMotifSettings !== previous.nfrMotifSettings) storeNfrMotifSettings(state.nfrMotifSettings);
      if (state.chipAtlasSelections !== previous.chipAtlasSelections) storeStoredChipAtlasSelections(state.chipAtlasSelections);
    },
    settingsHistory: [{
      // The panel's Saved tab: saved NFR variants (names, colours and notes included).
      key: 'saved-nfr', kind: 'analysis', slice: 'savedNfrVariants',
      signature: s => JSON.stringify(s.savedNfrVariants),
      label: () => 'Saved NFR variants',
    }],
  });
}
