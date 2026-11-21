/**
 * Pinned and recent genomes, as the server keeps them (api/recentGenomes.ts), and loading one in one step.
 */
import { create } from 'zustand';
import {
  clearRecentGenomes, getRecentGenomes, openRecentGenome, pinRecentGenome, removeRecentGenome, reorderPinnedGenomes,
  type RecentGenome, type RecentGenomesListing,
} from '../api/recentGenomes';
import { useBrowserStore } from './browserStore';
import { useGenomeCheckStore } from './genomeCheckStore';
import { markReferenceChosen, useReferenceNoticeStore } from './referenceNoticeStore';
import { showLoadedReference } from '../utils/referenceNavigation';
import { autoSaveNow } from '../hooks/useAutoSave';

interface RecentGenomesStore {
  pinned: RecentGenome[];
  recent: RecentGenome[];
  max: number;
  loaded: boolean;
  /** The key being opened. */
  opening: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  open: (key: string) => Promise<{ success: boolean; error?: string }>;
  remove: (key: string) => Promise<void>;
  clear: () => Promise<void>;
  setPinned: (key: string, pinned: boolean) => Promise<void>;
  reorder: (keys: string[]) => Promise<void>;
}

/** What an entry is called: its genome's name, the assembly its index names, else its file. */
export function recentGenomeLabel(e: Pick<RecentGenome, 'name' | 'genome_id' | 'assembly' | 'fasta_name' | 'key'>): string {
  return e.name || e.genome_id || e.assembly || e.fasta_name || e.key;
}

export const useRecentGenomesStore = create<RecentGenomesStore>((set, get) => {
  const apply = (l: RecentGenomesListing) => set({ pinned: l.pinned ?? [], recent: l.recent ?? [], max: l.max ?? 8, loaded: true });
  // A change clears the last error; a refresh keeps it (an open that failed says why until the next action).
  const run = async (action: () => Promise<RecentGenomesListing>, clearError = true) => {
    try { apply(await action()); if (clearError) set({ error: null }); } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); }
  };
  return {
    pinned: [], recent: [], max: 8, loaded: false, opening: null, error: null,
    refresh: () => run(getRecentGenomes, false),
    remove: key => run(() => removeRecentGenome(key)),
    clear: () => run(clearRecentGenomes),
    setPinned: (key, pinned) => run(() => pinRecentGenome(key, pinned)),
    reorder: keys => run(() => reorderPinnedGenomes(keys)),
    open: key => openNow(key),
  };

  async function openNow(key: string): Promise<{ success: boolean; error?: string }> {
      set({ opening: key, error: null });
      try {
        const res = await openRecentGenome(key);
        if (!res.success) {
          const error = res.missing ? 'File not found' : (res.error || res.fasta_error || 'Could not load it');
          set({ error });
          return { success: false, error };
        }
        markReferenceChosen();
        const store = useBrowserStore.getState();
        store.setHasFasta(res.fasta_loaded !== false);
        const entry = [...get().pinned, ...get().recent].find(e => e.key === key);
        // A registry genome by id (never a FASTA path); a local FASTA by its path.
        store.setFastaPath(entry?.kind === 'fasta' ? (res.fasta_path ?? entry.fasta ?? null) : null);
        store.setCurrentGenome(res.genome_id ?? null);
        useReferenceNoticeStore.getState().setNotice(null);
        await showLoadedReference();
        void useGenomeCheckStore.getState().refresh();
        setTimeout(() => { void autoSaveNow(); }, 500);
        return { success: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        set({ error });
        return { success: false, error };
      } finally {
        set({ opening: null });
        void get().refresh();
      }
  }
});
