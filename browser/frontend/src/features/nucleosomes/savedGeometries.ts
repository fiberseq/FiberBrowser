/**
 * Saved (starred) shared geometries: the nucleosome panel's counterpart of saved NFRs and the Footprints cart.
 *
 * An entry describes itself (kind, locus, edges, the shares per dataset when saved, the settings it was found with),
 * so it outlives the analysis. A saved geometry matches a geometry of the current analysis of the same kind and
 * chromosome when both ends lie within the grouping tolerance (`tol_bp`, the rule that groups patches into a
 * geometry); a matched entry acts as that geometry (focus, selection, the reads it groups). Saved with sessions and
 * undo snapshots, and persisted on this computer.
 */
import { registerStoreExtension } from '../../stores/storeExtensions';
import { sameChrom } from '../../utils/chromAliases';
import type { NucPatchKind } from '../../utils/nucLayers';
import type { NucGeometryRow } from './types';

export const SAVED_GEOMETRIES_STORAGE_KEY = 'fiberhmm_saved_nuc_geometries';
export const MAX_SAVED_GEOMETRIES = 200;

export interface SavedGeometry {
  id: string;
  /** G3 / L1 when saved; `name` is the user's (defaults to the label). */
  label: string;
  name: string;
  kind: NucPatchKind;
  chrom: string;
  start: number;
  end: number;
  openLeft: boolean;
  openRight: boolean;
  color: string;
  /** Per dataset, the share of molecules carrying it in full when saved (raw, and m6A density matched). */
  shares: Record<string, { full: number | null; densityMatched: number | null }>;
  /** Settings it was found with (patch + geometry parameters, as the server echoed them). */
  params?: Record<string, unknown>;
  tolBp: number;
  savedAt: number;
  note?: string;
}

const num = (v: unknown, fallback: number | null = null) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function normalizeSavedGeometries(value: unknown): SavedGeometry[] {
  if (!Array.isArray(value)) return [];
  const out: SavedGeometry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const start = num(r.start), end = num(r.end);
    if (typeof r.id !== 'string' || !r.id || typeof r.chrom !== 'string' || !r.chrom || start == null || end == null || end <= start) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const shares: SavedGeometry['shares'] = {};
    if (r.shares && typeof r.shares === 'object') {
      for (const [ds, v] of Object.entries(r.shares as Record<string, unknown>)) {
        const x = (v ?? {}) as Record<string, unknown>;
        shares[ds] = { full: num(x.full), densityMatched: num(x.densityMatched) };
      }
    }
    const label = typeof r.label === 'string' && r.label ? r.label : 'G';
    out.push({ id: r.id, label, name: typeof r.name === 'string' && r.name ? r.name : label, kind: r.kind === 'low' ? 'low' : 'high',
      chrom: r.chrom, start, end, openLeft: r.openLeft === true, openRight: r.openRight === true,
      color: typeof r.color === 'string' && r.color ? r.color : '#c8323c', shares,
      ...(r.params && typeof r.params === 'object' ? { params: r.params as Record<string, unknown> } : {}),
      tolBp: num(r.tolBp, 500)!, savedAt: num(r.savedAt, 0)!, ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}) });
    if (out.length >= MAX_SAVED_GEOMETRIES) break;
  }
  return out;
}

export function loadSavedGeometries(): SavedGeometry[] {
  try { return normalizeSavedGeometries(JSON.parse(localStorage.getItem(SAVED_GEOMETRIES_STORAGE_KEY) ?? '[]')); } catch { return []; }
}

export function storeSavedGeometries(list: SavedGeometry[]): void {
  try { localStorage.setItem(SAVED_GEOMETRIES_STORAGE_KEY, JSON.stringify(list)); } catch { /* private mode / quota */ }
}

/** A geometry of the current analysis that a saved one is: same kind and chromosome, both ends within the tolerance
 * (the larger of the saved and current tolerance); the closest when several do. Each geometry is on its own
 * chromosome (`chrom`); `chrom` here is the analysis window's, for geometries that do not name one (older answers). */
export function matchSaved(saved: Pick<SavedGeometry, 'kind' | 'chrom' | 'start' | 'end' | 'tolBp'>, chrom: string | null | undefined,
  geometries: readonly NucGeometryRow[], tolBp: number): number | null {
  const tol = Math.max(saved.tolBp, tolBp);
  let best: number | null = null, bestD = Infinity;
  geometries.forEach((g, i) => {
    const gc = (typeof g.chrom === 'string' && g.chrom) ? g.chrom : chrom;
    if (!gc || !sameChrom(saved.chrom, gc)) return;
    if ((g.kind ?? 'high') !== saved.kind) return;
    const ds = Math.abs(g.start - saved.start), de = Math.abs(g.end - saved.end);
    if (ds > tol || de > tol) return;
    if (ds + de < bestD) { best = i; bestD = ds + de; }
  });
  return best;
}

export interface SavedGeometryInput extends Omit<SavedGeometry, 'id' | 'savedAt' | 'name'> { name?: string }

export interface NucGeoStateSlice {
  savedNucGeometries: SavedGeometry[];
  /** Save a geometry (one already saved at the same kind, chromosome and edges is kept); returns the entry's id. */
  addSavedNucGeometry: (entry: SavedGeometryInput) => string;
  updateSavedNucGeometry: (id: string, patch: Partial<Pick<SavedGeometry, 'name' | 'color' | 'note'>>) => void;
  removeSavedNucGeometry: (id: string) => void;
  clearSavedNucGeometries: () => void;
}

declare module '../../stores/browserStore' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface BrowserState extends NucGeoStateSlice {}
}

const sameEntry = (a: Pick<SavedGeometry, 'kind' | 'chrom' | 'start' | 'end'>, b: Pick<SavedGeometry, 'kind' | 'chrom' | 'start' | 'end'>) =>
  a.kind === b.kind && sameChrom(a.chrom, b.chrom) && a.start === b.start && a.end === b.end;

let registered = false;
export function registerSavedGeometries(): void {
  if (registered) return;
  registered = true;
  registerStoreExtension({
    id: 'nuc.geometries',
    keys: ['savedNucGeometries'],
    create: set => ({
      savedNucGeometries: loadSavedGeometries(),
      addSavedNucGeometry: (entry: SavedGeometryInput) => {
        let id = '';
        set(state => {
          const old = state.savedNucGeometries.find(e => sameEntry(e, entry));
          if (old) { id = old.id; return {}; }
          id = crypto.randomUUID();
          const next = [...state.savedNucGeometries, { ...entry, name: entry.name ?? entry.label, id, savedAt: Date.now() }];
          return { savedNucGeometries: normalizeSavedGeometries(next) };
        });
        return id;
      },
      updateSavedNucGeometry: (id: string, patch: Partial<Pick<SavedGeometry, 'name' | 'color' | 'note'>>) => set(state => ({
        savedNucGeometries: state.savedNucGeometries.map(e => (e.id === id ? { ...e, ...patch } : e)),
      })),
      removeSavedNucGeometry: (id: string) => set(state => ({ savedNucGeometries: state.savedNucGeometries.filter(e => e.id !== id) })),
      clearSavedNucGeometries: () => set({ savedNucGeometries: [] }),
    } satisfies NucGeoStateSlice),
    serialize: state => ({ savedNucGeometries: normalizeSavedGeometries(state.savedNucGeometries) }),
    restoreSnapshot: s => ('savedNucGeometries' in s ? { savedNucGeometries: normalizeSavedGeometries(s.savedNucGeometries) } : {}),
    // The session's own saved geometries, or none for a session without them.
    importSession: frontend => ({ savedNucGeometries: normalizeSavedGeometries(frontend ? frontend.savedNucGeometries : undefined) }),
    onSessionImport: () => { void import('./geoRuns').then(m => m.useNucGeoRuns.getState().clear()); },
    persist: (state, previous) => {
      if (state.savedNucGeometries !== previous.savedNucGeometries) storeSavedGeometries(state.savedNucGeometries);
    },
    // A saved list: undoing or redoing a star never repaints the reads.
    refreshFree: true,
    settingsHistory: [{
      key: 'saved-nuc-geometries', kind: 'analysis', slice: 'savedNucGeometries',
      signature: s => JSON.stringify(s.savedNucGeometries),
      label: () => 'Saved regularity geometries',
    }],
  });
}
