import type { BrowserState } from './browserStore';
import type { PrimerPair, PrimerState, SavedPrimer, DafcPrimerQuad } from '../types';


// ============================================================
// PRIMER SLICE — Interface
// ============================================================

export interface PrimerSlice {
  primer: PrimerState;

  setPrimerTarget: (start: number | null, end: number | null, chrom?: string | null) => void;
  setPrimerPair: (pair: PrimerPair | null) => void;
  setPrimerConfig: (fasta: string | null, blastDb: string | null) => void;
  setPrimerDesigning: (designing: boolean) => void;
  setPrimerError: (error: string | null) => void;
  setDesignResults: (pairs: PrimerPair[]) => void;
  addSavedPrimer: (saved: SavedPrimer) => void;
  /** Bulk-append (used by BED / TSV import). Deduplicates against existing
   *  savedPrimers by (chrom, fwd_seq, rev_seq) so repeat imports are idempotent. */
  addSavedPrimers: (saved: SavedPrimer[]) => { added: number; skipped: number };
  removeSavedPrimer: (index: number) => void;
  updateSavedPrimerName: (index: number, name: string) => void;
  clearSavedPrimers: () => void;
  clearPrimers: () => void;
  setPrimerMode: (mode: 'standard' | 'dafc' | '4c') => void;
  setDafcQuads: (quads: DafcPrimerQuad[]) => void;
  setCartTrackDisplay: (mode: 'off' | 'all' | 'imported' | 'design') => void;
}

// ============================================================
// PRIMER SLICE — Implementation
// ============================================================

export function createPrimerSlice(set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void, get: () => BrowserState): PrimerSlice {
  return {
  primer: {
    targetStart: null,
    targetEnd: null,
    pair: null,
    configFasta: null,
    configBlastDb: null,
    designing: false,
    error: null,
    designResults: [],
    savedPrimers: [],
    mode: 'standard',
    dafcQuads: [],
    cartTrackDisplay: 'off',
  },

  setPrimerTarget: (start, end, chrom) => set(state => ({
    primer: { ...state.primer, targetStart: start, targetEnd: end, targetChrom: start == null ? null : (chrom ?? null) }
  })),
  setPrimerPair: (pair) => set(state => ({
    primer: { ...state.primer, pair }
  })),
  setPrimerConfig: (fasta, blastDb) => set(state => ({
    primer: { ...state.primer, configFasta: fasta, configBlastDb: blastDb }
  })),
  setPrimerDesigning: (designing) => set(state => ({
    primer: { ...state.primer, designing }
  })),
  setPrimerError: (error) => set(state => ({
    primer: { ...state.primer, error }
  })),
  setDesignResults: (pairs) => set(state => ({
    primer: { ...state.primer, designResults: pairs }
  })),
  addSavedPrimer: (saved) => set(state => ({
    primer: { ...state.primer, savedPrimers: [...state.primer.savedPrimers, saved] }
  })),
  addSavedPrimers: (incoming) => {
    // Dedup by exact (chrom, fwd_seq, rev_seq) — sequence equality is the
    // strongest signal a primer is already in the cart. Position-tolerant
    // match used separately for design-result badging; imports use strict.
    const existing = get().primer.savedPrimers;
    const seen = new Set(existing.map(p => `${p.chrom}|${p.pair.fwd_seq}|${p.pair.rev_seq}`));
    const fresh: SavedPrimer[] = [];
    let skipped = 0;
    for (const p of incoming) {
      const key = `${p.chrom}|${p.pair.fwd_seq}|${p.pair.rev_seq}`;
      if (seen.has(key)) { skipped += 1; continue; }
      seen.add(key);
      fresh.push(p);
    }
    if (fresh.length > 0) {
      set(state => ({
        primer: { ...state.primer, savedPrimers: [...state.primer.savedPrimers, ...fresh] }
      }));
    }
    return { added: fresh.length, skipped };
  },
  removeSavedPrimer: (index) => set(state => ({
    primer: { ...state.primer, savedPrimers: state.primer.savedPrimers.filter((_, i) => i !== index) }
  })),
  updateSavedPrimerName: (index, name) => set(state => ({
    primer: {
      ...state.primer,
      savedPrimers: state.primer.savedPrimers.map((p, i) => i === index ? { ...p, name } : p)
    }
  })),
  clearSavedPrimers: () => set(state => ({
    primer: { ...state.primer, savedPrimers: [] }
  })),
  clearPrimers: () => set(state => ({
    primer: {
      ...state.primer,
      pair: null,
      targetStart: null,
      targetEnd: null,
      error: null,
      designResults: [],
      dafcQuads: [],
    }
  })),
  setPrimerMode: (mode: 'standard' | 'dafc' | '4c') => set(state => ({
    primer: { ...state.primer, mode, designResults: [], dafcQuads: [], error: null }
  })),
  setDafcQuads: (quads) => set(state => ({
    primer: { ...state.primer, dafcQuads: quads }
  })),
  setCartTrackDisplay: (mode) => set(state => ({
    primer: { ...state.primer, cartTrackDisplay: mode }
  })),
  };
}
