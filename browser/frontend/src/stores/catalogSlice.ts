import type { BrowserState } from './browserStore';
import type { CatalogEntry, CatalogKind } from '../types/dataset';

// ============================================================
// CATALOG SLICE — inventory of "primitives" (loaded bigwigs / bigbeds /
// online tracks / motifs) that composite tracks reference. The catalog is
// an inventory layer; the cart (compositeTracksSlice) is the rendering layer.
// ============================================================

export interface CatalogSlice {
  catalog: CatalogEntry[];

  /** Add an entry. Dedupes by path (local) or url (online); returns the
   *  existing or newly created entry id. */
  addCatalogEntry: (entry: Omit<CatalogEntry, 'id'> & { id?: string }) => string;
  removeCatalogEntry: (id: string) => void;
  markCatalogUnavailable: (id: string, unavailable: boolean) => void;
  relocateCatalogEntry: (id: string, newPath: string) => void;
  setCatalogLoaded: (id: string, loaded: boolean) => void;
  /** Replace whole catalog (used by session restore / migration). */
  setCatalog: (entries: CatalogEntry[]) => void;
  /** Number of cart sources referencing this catalog entry. */
  getCatalogRefCount: (id: string) => number;
  /** Stamp the backend track index on a catalog entry — called after each
   *  (re)register so source resolution can pick the right orthogonal track
   *  even when several entries share a URL. */
  setCatalogTrackIndex: (id: string, trackIndex: number) => void;
  /** Clear one transient backend index after unloading a catalog-backed track. */
  clearCatalogTrackIndex: (id: string) => void;
  /** Clear all transient backend indices after backend track deletion shifts indices. */
  clearCatalogTrackIndices: () => void;
}

function sameFilter(a?: string[], b?: string[]): boolean {
  if (!a || a.length === 0) return !b || b.length === 0;
  if (!b || b.length === 0) return false;
  if (a.length !== b.length) return false;
  // Order-insensitive compare (the picker emits names in selection order).
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((n, i) => n === sb[i]);
}

function findExisting(
  catalog: CatalogEntry[],
  path?: string,
  url?: string,
  filterNames?: string[],
): CatalogEntry | undefined {
  // Annotation/motif tracks with different filter selections from the same
  // source file are *different* entries — without this, picking CTCF then
  // MAX from the same JASPAR file collapses into one cart row.
  const matchesLocation = (c: CatalogEntry) =>
    (path && c.path === path) || (url && c.url === url);
  for (const c of catalog) {
    if (!matchesLocation(c)) continue;
    if (sameFilter(c.filterNames, filterNames)) return c;
  }
  return undefined;
}

function stripTransientTrackIndices(entries: CatalogEntry[]): CatalogEntry[] {
  return entries.map(entry => {
    const { trackIndex: _trackIndex, ...rest } = entry;
    return rest as CatalogEntry;
  });
}

export function createCatalogSlice(
  set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void,
  get: () => BrowserState,
): CatalogSlice {
  const ensureCatalogBaseline = () => {
    const state = get();
    if ((state._historyStack?.length ?? 0) === 0) {
      state.pushSnapshot?.('Before catalog change', { kind: 'layout' });
    }
  };

  const pushCatalogHistory = (label: string) => {
    get().pushSnapshot?.(label, { kind: 'layout' });
  };

  return {
    catalog: [],

    addCatalogEntry: (entry) => {
      const existing = findExisting(get().catalog, entry.path, entry.url, entry.filterNames);
      if (existing) {
        // Re-register: backend assigned a fresh track_index. Update the
        // dedup'd entry in place rather than forcing the caller to make a
        // second setCatalogTrackIndex call (saves one set per load).
        if (entry.trackIndex !== undefined && entry.trackIndex !== existing.trackIndex) {
          set(state => ({
            catalog: state.catalog.map(c =>
              c.id === existing.id ? { ...c, trackIndex: entry.trackIndex } : c
            ),
          }));
        }
        return existing.id;
      }
      const id = entry.id ?? crypto.randomUUID();
      const fullEntry: CatalogEntry = { ...entry, id } as CatalogEntry;
      set(state => ({ catalog: [...state.catalog, fullEntry] }));
      return id;
    },

    removeCatalogEntry: (id) => {
      const entry = get().catalog.find(e => e.id === id);
      if (!entry) return;
      ensureCatalogBaseline();
      set(state => ({
        catalog: state.catalog.filter(e => e.id !== id),
      }));
      pushCatalogHistory(`Delete catalog source ${entry.label || 'track'}`);
    },

    markCatalogUnavailable: (id, unavailable) => set(state => ({
      catalog: state.catalog.map(e => e.id === id ? { ...e, unavailable } : e),
    })),

    relocateCatalogEntry: (id, newPath) => {
      const entry = get().catalog.find(e => e.id === id);
      if (!entry || entry.path === newPath) return;
      ensureCatalogBaseline();
      set(state => ({
        catalog: state.catalog.map(e => e.id === id ? { ...e, path: newPath, unavailable: false } : e),
      }));
      pushCatalogHistory(`Relocate catalog source ${entry.label || 'track'}`);
    },

    setCatalogLoaded: (id, loaded) => set(state => ({
      catalog: state.catalog.map(e => e.id === id ? { ...e, loaded } : e),
    })),

    setCatalog: (entries) => set({ catalog: stripTransientTrackIndices(entries) }),

    setCatalogTrackIndex: (id, trackIndex) => set(state => ({
      catalog: state.catalog.map(e => e.id === id ? { ...e, trackIndex } : e),
    })),

    clearCatalogTrackIndex: (id) => set(state => ({
      catalog: state.catalog.map(e => {
        if (e.id !== id || e.trackIndex === undefined) return e;
        const { trackIndex: _trackIndex, ...rest } = e;
        return rest as CatalogEntry;
      }),
    })),

    clearCatalogTrackIndices: () => set(state => ({
      catalog: state.catalog.map(e => {
        if (e.trackIndex === undefined) return e;
        const { trackIndex: _trackIndex, ...rest } = e;
        return rest as CatalogEntry;
      }),
    })),

    getCatalogRefCount: (id) => {
      const composites = get().compositeTracks ?? [];
      let n = 0;
      for (const c of composites) {
        for (const s of c.sources) {
          if ('catalogEntryId' in s.ref && s.ref.catalogEntryId === id) n += 1;
        }
      }
      return n;
    },
  };
}

// Convenience factory: derive a CatalogKind from a path/url.
export function inferCatalogKind(pathOrUrl: string): CatalogKind {
  const lower = pathOrUrl.toLowerCase();
  if (lower.endsWith('.bb') || lower.endsWith('.bigbed')) return 'bigbed';
  // BED intervals are annotations, drawn like a bigBed's.
  if (lower.endsWith('.bed') || lower.endsWith('.bed.gz')) return 'bigbed';
  if (lower.endsWith('.bw') || lower.endsWith('.bigwig')) return 'bigwig';
  if (lower.endsWith('.bam')) return 'bam';
  return 'bigwig'; // sane default for signal tracks
}
