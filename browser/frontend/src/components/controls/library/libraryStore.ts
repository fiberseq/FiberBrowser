import { create } from 'zustand';
import { getLibrary, type LibraryPayload } from '../../../api/library';
import { DEFAULT_FILTERS, type LibraryFilters, type SortState } from '../../../utils/library';

/** Opens the Library from anywhere (sidebar, welcome screen, Copilot). */
export const OPEN_LIBRARY_EVENT = 'fiberbrowser:open-library';

export function openLibrary(selectedId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_LIBRARY_EVENT, { detail: { selectedId } }));
}

const FILTERS_KEY = 'fiberbrowser.library.filters';

function savedFilters(): LibraryFilters {
  try {
    const raw = window.localStorage.getItem(FILTERS_KEY);
    if (raw) return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<LibraryFilters>), text: '' };
  } catch { /* storage unavailable */ }
  return DEFAULT_FILTERS;
}

interface LibraryState {
  payload: LibraryPayload | null;
  loaded: boolean;
  error: string | null;
  open: boolean;
  selectedId: string | null;
  checked: string[];
  filters: LibraryFilters;
  sort: SortState;
  status: string | null;
  /** What on-demand scans of suggested folders found (folder -> entry ids), for this page. */
  scanned: Record<string, string[]>;
  setOpen: (open: boolean, selectedId?: string | null) => void;
  refresh: () => Promise<LibraryPayload | null>;
  setFilters: (changes: Partial<LibraryFilters>) => void;
  resetFilters: () => void;
  setSort: (sort: SortState) => void;
  select: (id: string | null) => void;
  setChecked: (ids: string[]) => void;
  toggleChecked: (id: string) => void;
  setStatus: (status: string | null) => void;
  setScanned: (folder: string, ids: string[]) => void;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  payload: null,
  loaded: false,
  error: null,
  open: false,
  selectedId: null,
  checked: [],
  filters: savedFilters(),
  sort: { key: 'date', dir: 'desc' },
  status: null,
  scanned: {},
  setOpen: (open, selectedId) => set(state => ({
    open,
    selectedId: selectedId === undefined ? state.selectedId : selectedId,
  })),
  refresh: async () => {
    try {
      const payload = await getLibrary();
      const ids = new Set(payload.entries.map(e => e.id));
      set(state => ({
        payload, loaded: true, error: null,
        checked: state.checked.filter(id => ids.has(id)),
        selectedId: state.selectedId && ids.has(state.selectedId) ? state.selectedId : null,
      }));
      return payload;
    } catch (err) {
      set({ loaded: true, error: err instanceof Error ? err.message : 'Could not read the Library' });
      return get().payload;
    }
  },
  setFilters: changes => set(state => {
    const filters = { ...state.filters, ...changes };
    try {
      window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ ...filters, text: '' }));
    } catch { /* storage unavailable */ }
    return { filters };
  }),
  resetFilters: () => {
    try { window.localStorage.removeItem(FILTERS_KEY); } catch { /* storage unavailable */ }
    set({ filters: DEFAULT_FILTERS });
  },
  setSort: sort => set({ sort }),
  select: id => set({ selectedId: id }),
  setChecked: ids => set({ checked: [...new Set(ids)] }),
  toggleChecked: id => set(state => ({
    checked: state.checked.includes(id) ? state.checked.filter(x => x !== id) : [...state.checked, id],
  })),
  setStatus: status => set({ status }),
  setScanned: (folder, ids) => set(state => ({ scanned: { ...state.scanned, [folder]: ids } })),
}));
