import { create } from 'zustand';
import { useBrowserStore } from './browserStore';
import { isSandboxPage } from '../utils/sandbox';
import type { RegionCatalog, RegionCategory, RegionEntry } from '../types/regions';
import { deleteRegionCatalog, getRegionCatalog, putRegionCatalog, type DetectRegionsResponse } from '../api/regions';
import {
  addCategory as addCategoryTo, addEntries as addEntriesTo, emptyCatalog, ensureCategory, importBedRegions,
  mergeCatalogs, moveBetweenCatalogs, moveCategory as moveCategoryIn, moveEntries as moveEntriesIn, normalizeCatalog,
  rebaseCatalog, removeCategory as removeCategoryFrom, revertCatalogChange, removeEntries as removeEntriesFrom, updateCategory as updateCategoryIn,
  updateEntry as updateEntryIn, type NewEntry,
} from '../utils/regionCatalog';
import { parseRegionBed } from '../utils/regionBed';

/**
 * The Regions panel's catalog: every reference's named regions in categories
 * (utils/regionCatalog.ts for the operations, types/regions.ts for the model).
 *
 * Kept in the user's catalog file for that reference (GET/PUT /api/regions/catalog,
 * ~/.fiberhmm/regions) and in sessions. A reference's catalog is written back
 * only after it was read from the file (so a session or a migration never
 * replaces regions saved earlier: they are merged in). On a public server, or
 * when saving fails, the catalog lives in the session only.
 *
 * Not part of undo snapshots (a 100,000-region BED would be copied into every
 * step, and Undo of a zoom would silently drop a rename made since); edits
 * take effect at once and are saved. Removing regions or a category, and
 * moving them to another reference, can be undone in the Regions panel
 * (`undo`, the last such change: the catalogs around it are kept, which costs
 * no copy, and undoing it keeps edits made since).
 *
 * Sync: 'local' keeps a catalog in the session on purpose (a public server, a
 * tour tab); 'error' is a read that failed (the next ensureLoaded tries again,
 * and edits made meanwhile join the saved regions then).
 */

export type CatalogSync = 'loading' | 'ready' | 'local' | 'error';

/** The last removal or move between references, which the Regions panel can undo. */
export interface CatalogUndo {
  label: string;
  changes: Array<{ genome: string; before: RegionCatalog; after: RegionCatalog }>;
  /** A move between references: each moved region's id in `from` and in `to` (edits made there since go back with it). */
  move?: { from: string; to: string; entries: Array<[string, string]> };
}

export interface DatasetScan {
  state: 'running' | 'done' | 'refused' | 'error';
  message?: string;
  elapsedMs?: number;
  kind?: DetectRegionsResponse['kind'];
  genome?: string;
  regions?: number;
  /** Why it was skipped (refused): 'whole-genome', 'mismatch' (wrong reference), 'too-many'. */
  status?: DetectRegionsResponse['status'];
  /** The dataset's reads (its index). */
  reads?: number;
  /** 'index': found from the BAM index; 'reads': by reading the reads. */
  method?: DetectRegionsResponse['method'];
  /** What the scan narrowed or estimated, said (never silent). */
  note?: string;
  /** The scope scanned: the whole dataset, a chromosome, the view (its label). */
  scope?: 'dataset' | 'chrom' | 'view';
  scopeLabel?: string;
}

interface RegionCatalogState {
  catalogs: Record<string, RegionCatalog>;
  sync: Record<string, CatalogSync>;
  /** Content fingerprint of each open dataset (its detected amplicons show only while it is open). */
  fingerprints: Record<string, string>;
  /** The automatic amplicon search of each open dataset. */
  scans: Record<string, DatasetScan>;
  /** Next/previous step through this category. */
  active: { genome: string; category: string; entry: string | null } | null;
  /** The reference whose catalog the Regions panel shows (null: the panel is closed). N / P step it. */
  shown: string | null;
  /** The catalog chosen in the Regions panel's reference menu (null: the targeted panel's); kept while the panel moves or closes. */
  picked: string | null;
  /** Why a reference's saved regions could not be read (sync 'error'). */
  loadErrors: Record<string, string>;
  undo: CatalogUndo | null;
  /** Regions visited, most recent first (search ranks them higher). */
  recent: string[];
  saveError: string | null;

  ensureLoaded: (genome: string) => Promise<void>;
  catalogFor: (genome: string) => RegionCatalog;
  addCategory: (genome: string, category: Omit<RegionCategory, 'id'> & { id?: string }) => string;
  updateCategory: (genome: string, id: string, patch: Partial<Omit<RegionCategory, 'id'>>) => void;
  /** `undoable`: the Regions panel offers Undo (a removal the user asked for, not a tour's cleanup). */
  removeCategory: (genome: string, id: string, options?: { undoable?: boolean }) => void;
  moveCategory: (genome: string, id: string, beforeId: string | null, parent?: string | null) => void;
  addEntries: (genome: string, categoryId: string, entries: NewEntry[]) => string[];
  updateEntry: (genome: string, id: string, patch: Partial<Omit<RegionEntry, 'id'>>) => void;
  removeEntries: (genome: string, ids: string[], options?: { undoable?: boolean }) => void;
  moveEntries: (genome: string, ids: string[], categoryId: string, beforeId?: string | null) => void;
  /**
   * Move categories and regions to another reference's catalog: saved there first,
   * then removed here (nothing moves when the other catalog can't be read or saved).
   */
  moveToGenome: (from: string, to: string, what: { categoryIds?: string[]; entryIds?: string[] }) => Promise<{ moved: number; error?: string }>;
  /** Forget a dataset's detected amplicons on a reference (it is not on that reference). */
  dropDetected: (genome: string, fingerprint: string, sources?: Array<'auto' | 'top'>) => Promise<void>;
  /** Undo the last removal or move; returns what was undone. */
  undoLast: () => string | null;
  clearUndo: () => void;
  setShown: (genome: string | null) => void;
  setPicked: (genome: string | null) => void;
  /** Drop a reference's catalog from memory (its key now names another reference); read again on next use. */
  forget: (genome: string) => void;
  importBed: (genome: string, text: string, fileName: string, category?: string) => { imported: number; skipped: number; categories: string[]; problems: string[] };
  /** A detection's regions as a category: the dataset's amplicons ('auto') or regions found on request ('top'). */
  applyDetection: (res: DetectRegionsResponse, datasetLabel: string, kind: 'auto' | 'top', scopeLabel?: string) => string | null;
  /** Amplicon labels back to the detected ones. */
  restoreAutoLabels: (genome: string, categoryId: string) => void;
  setFingerprint: (datasetId: string, fingerprint: string | null | undefined) => void;
  setScan: (datasetId: string, scan: DatasetScan | null) => void;
  setActive: (genome: string, category: string, entry: string | null) => void;
  noteVisited: (entryId: string) => void;
  /** Forget a reference's saved regions (the file too). */
  resetGenome: (genome: string) => Promise<void>;
  sessionPayload: () => Record<string, RegionCatalog>;
  restoreSession: (payload: unknown) => void;
}

const SAVE_DELAY_MS = 500;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** One write at a time per reference: a later save never lands before an earlier one. */
const saveChains = new Map<string, Promise<unknown>>();
const loading = new Map<string, Promise<void>>();
/**
 * What the saved file holds, as far as this window knows: the catalog last read
 * or written, its revision, and the identity it was read under (writes go to that
 * catalog, whatever reference the key names by the time they land).
 */
const synced = new Map<string, { catalog: RegionCatalog; revision: number; identity?: string }>();
/** Bumped when a key is forgotten (it names another reference now): answers for the old one are dropped. */
const generations = new Map<string, number>();
const generationOf = (genome: string) => generations.get(genome) ?? 0;
// A public server keeps regions in the visitor's session (the catalog routes are refused
// there); so does a tour tab (its demo data's amplicons are not the user's regions).
let persistenceEnabled = () => !useBrowserStore.getState().publicMode && !isSandboxPage();

/** Saving to the user's file is off (a public server keeps regions in the session). */
export function setRegionCatalogPersistence(enabled: () => boolean): void {
  persistenceEnabled = enabled;
}

function enqueue<T>(genome: string, work: () => Promise<T>): Promise<T> {
  const previous = saveChains.get(genome) ?? Promise.resolve();
  const next = previous.then(work, work);
  saveChains.set(genome, next.catch(() => undefined));
  return next;
}

/**
 * Write the catalog from the revision this window last saw. Another window
 * saved meanwhile: this window's changes are put on top of what it saved
 * (utils/regionCatalog.rebaseCatalog) and written again.
 */
async function writeNow(genome: string): Promise<boolean> {
  const store = useRegionCatalogStore;
  const generation = generationOf(genome);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = store.getState().catalogs[genome];
      if (!current) return true;
      const base = synced.get(genome);
      const res = await putRegionCatalog(genome, current, base?.revision ?? 0, base?.identity);
      // The key was forgotten meanwhile (another reference now): nothing here is about it.
      if (generationOf(genome) !== generation) return res.ok;
      if (res.ok) {
        synced.set(genome, { catalog: current, revision: res.revision, identity: base?.identity });
        if (store.getState().saveError) store.setState({ saveError: null });
        return true;
      }
      const server = normalizeCatalog(res.catalog, genome);
      // The catalog as it is now (it may have changed while the request was out).
      const local = store.getState().catalogs[genome] ?? current;
      const rebased = rebaseCatalog(base?.catalog ?? emptyCatalog(genome), local, server);
      synced.set(genome, { catalog: server, revision: server.revision ?? 0, identity: base?.identity });
      store.setState(s => ({ catalogs: { ...s.catalogs, [genome]: rebased } }));
    }
    throw new Error('the catalog keeps changing in another window');
  } catch (err) {
    store.setState({ saveError: `Regions not saved: ${err instanceof Error ? err.message : String(err)}` });
    return false;
  }
}

function scheduleSave(genome: string): void {
  const state = useRegionCatalogStore.getState();
  if (state.sync[genome] !== 'ready' || !persistenceEnabled()) return;
  const existing = saveTimers.get(genome);
  if (existing) clearTimeout(existing);
  saveTimers.set(genome, setTimeout(() => {
    saveTimers.delete(genome);
    void enqueue(genome, () => writeNow(genome));
  }, SAVE_DELAY_MS));
}

/** Save a reference's catalog now (after waiting for earlier saves); whether it was saved. */
export function saveRegionCatalogNow(genome: string): Promise<boolean> {
  const timer = saveTimers.get(genome);
  if (timer) { clearTimeout(timer); saveTimers.delete(genome); }
  if (!persistenceEnabled() || useRegionCatalogStore.getState().sync[genome] !== 'ready') return Promise.resolve(false);
  return enqueue(genome, () => writeNow(genome));
}

/** Save now every catalog with changes waiting (tests, before the page goes away). */
export async function flushRegionCatalogSaves(): Promise<void> {
  await Promise.all([...saveTimers.keys()].map(genome => saveRegionCatalogNow(genome)));
  await Promise.all([...saveChains.values()]);
}

/**
 * The page is going away: send edits still waiting for their debounce now
 * (keepalive, so the request outlives the page; a catalog too big for
 * keepalive is sent as a normal request, which the browser may cut short).
 */
export function flushRegionCatalogSavesOnUnload(): void {
  if (!persistenceEnabled()) return;
  for (const genome of [...saveTimers.keys()]) {
    clearTimeout(saveTimers.get(genome)!);
    saveTimers.delete(genome);
    const current = useRegionCatalogStore.getState().catalogs[genome];
    if (!current) continue;
    const base = synced.get(genome);
    const body = JSON.stringify({ genome, catalog: current, base_revision: base?.revision ?? 0, ...(base?.identity != null ? { identity: base.identity } : {}) });
    try {
      void fetch('/api/regions/catalog', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, credentials: 'include', keepalive: body.length < 60_000,
      }).catch(() => undefined);
    } catch { /* the page is closing */ }
  }
}

export const useRegionCatalogStore = create<RegionCatalogState>((set, get) => {
  const edit = (genome: string, change: (catalog: RegionCatalog) => RegionCatalog) => {
    const before = get().catalogs[genome] ?? emptyCatalog(genome);
    const after = change(before);
    if (after === before) return;
    set(s => ({ catalogs: { ...s.catalogs, [genome]: after } }));
    scheduleSave(genome);
  };
  /** An edit the Regions panel can undo (removals). */
  const editUndoable = (label: string, genome: string, change: (catalog: RegionCatalog) => RegionCatalog) => {
    const before = get().catalogFor(genome);
    edit(genome, change);
    const after = get().catalogFor(genome);
    if (after !== before) set({ undo: { label, changes: [{ genome, before, after }] } });
  };

  return {
    catalogs: {},
    sync: {},
    fingerprints: {},
    scans: {},
    active: null,
    shown: null,
    picked: null,
    loadErrors: {},
    undo: null,
    recent: [],
    saveError: null,

    ensureLoaded: (genome) => {
      if (!genome) return Promise.resolve();
      // Callers wait for a read already on its way (a detection must not file its
      // amplicons into an empty catalog that the saved one then gets merged with).
      const pending = loading.get(genome);
      if (pending) return pending;
      // A read that failed is tried again; a read done (or a session-only catalog) is not.
      if (get().sync[genome] && get().sync[genome] !== 'error') return Promise.resolve();
      set(s => ({ sync: { ...s.sync, [genome]: 'loading' } }));
      if (!persistenceEnabled()) {
        set(s => ({ sync: { ...s.sync, [genome]: 'local' } }));
        return Promise.resolve();
      }
      const generation = generationOf(genome);
      const run = (async () => {
        try {
          const read = await getRegionCatalog(genome);
          // Forgotten meanwhile: this answer is the old reference's.
          if (generationOf(genome) !== generation) return;
          const saved = normalizeCatalog(read.catalog, genome);
          synced.set(genome, { catalog: saved, revision: saved.revision ?? 0, identity: read.identity });
          const inMemory = get().catalogs[genome];
          // Regions added meanwhile (a session, a migration, a detection) join the saved ones.
          const merged = inMemory ? mergeCatalogs(saved, inMemory) : saved;
          set(s => {
            const { [genome]: _fixed, ...loadErrors } = s.loadErrors;
            return { catalogs: { ...s.catalogs, [genome]: merged }, sync: { ...s.sync, [genome]: 'ready' }, loadErrors };
          });
          if (inMemory && (inMemory.entries.length || inMemory.categories.length)) scheduleSave(genome);
        } catch (err) {
          if (generationOf(genome) !== generation) return;
          // Not 'local': the next ensureLoaded (the Regions panel's Retry, a panel change) reads again.
          const message = err instanceof Error ? err.message : String(err);
          set(s => ({ sync: { ...s.sync, [genome]: 'error' }, loadErrors: { ...s.loadErrors, [genome]: message } }));
        } finally {
          if (generationOf(genome) === generation) loading.delete(genome);
        }
      })();
      loading.set(genome, run);
      return run;
    },

    catalogFor: (genome) => get().catalogs[genome] ?? emptyCatalog(genome),

    addCategory: (genome, category) => {
      let id = '';
      edit(genome, c => { const res = addCategoryTo(c, category); id = res.id; return res.catalog; });
      return id;
    },
    updateCategory: (genome, id, patch) => edit(genome, c => updateCategoryIn(c, id, patch)),
    removeCategory: (genome, id, options) => {
      const name = get().catalogFor(genome).categories.find(c => c.id === id)?.name ?? 'the category';
      if (options?.undoable) editUndoable(`Deleted ${name}`, genome, c => removeCategoryFrom(c, id));
      else edit(genome, c => removeCategoryFrom(c, id));
      const active = get().active;
      if (active?.genome === genome && active.category === id) set({ active: null });
    },
    moveCategory: (genome, id, beforeId, parent) => edit(genome, c => moveCategoryIn(c, id, beforeId, parent)),
    addEntries: (genome, categoryId, entries) => {
      let ids: string[] = [];
      edit(genome, c => { const res = addEntriesTo(c, categoryId, entries); ids = res.ids; return res.catalog; });
      return ids;
    },
    updateEntry: (genome, id, patch) => edit(genome, c => updateEntryIn(c, id, patch)),
    removeEntries: (genome, ids, options) => {
      if (options?.undoable) editUndoable(`Removed ${ids.length.toLocaleString()} region${ids.length === 1 ? '' : 's'}`, genome, c => removeEntriesFrom(c, ids));
      else edit(genome, c => removeEntriesFrom(c, ids));
    },
    moveEntries: (genome, ids, categoryId, beforeId = null) => edit(genome, c => moveEntriesIn(c, ids, categoryId, beforeId)),

    moveToGenome: async (from, to, what) => {
      if (!from || !to || from === to) return { moved: 0 };
      await get().ensureLoaded(to);
      // A catalog kept in the session only ('local') isn't saved; one being saved must have been read.
      const saving = persistenceEnabled() && get().sync[to] !== 'local';
      // Never into a catalog that wasn't read: its save would replace the regions saved there.
      if (saving && get().sync[to] !== 'ready') {
        return { moved: 0, error: `The ${to} regions could not be read${get().loadErrors[to] ? ` (${get().loadErrors[to]})` : ''}: nothing was moved.` };
      }
      const sourceBefore = get().catalogFor(from);
      const targetBefore = get().catalogFor(to);
      const res = moveBetweenCatalogs(sourceBefore, targetBefore, what);
      if (!res.moved && res.source.categories.length === sourceBefore.categories.length) return { moved: 0 };
      edit(to, () => res.target);
      const targetAfter = get().catalogFor(to);
      // Saved there before they leave here (a window closed between the two keeps them somewhere).
      if (saving && !(await saveRegionCatalogNow(to))) {
        edit(to, c => revertCatalogChange(targetBefore, targetAfter, c));
        return { moved: 0, error: `Not moved: ${get().saveError ?? `the ${to} regions could not be saved`}` };
      }
      const current = get().catalogFor(from);
      edit(from, () => moveBetweenCatalogs(current, emptyCatalog(to), what).source);
      set(s => ({
        undo: {
          label: `Moved ${res.moved.toLocaleString()} region${res.moved === 1 ? '' : 's'} to ${to}`,
          changes: [{ genome: from, before: current, after: get().catalogFor(from) }, { genome: to, before: targetBefore, after: targetAfter }],
          move: { from, to, entries: [...res.entryIds] },
        },
        active: s.active?.genome === from && (what.categoryIds ?? []).includes(s.active.category) ? null : s.active,
      }));
      return { moved: res.moved };
    },

    dropDetected: async (genome, fingerprint, sources = ['auto']) => {
      if (!genome || !fingerprint) return;
      await get().ensureLoaded(genome);
      const gone = get().catalogFor(genome).categories.filter(c => sources.includes(c.source as 'auto' | 'top') && c.fingerprint === fingerprint).map(c => c.id);
      if (!gone.length) return;
      edit(genome, c => gone.reduce((next, id) => removeCategoryFrom(next, id), c));
      const active = get().active;
      if (active?.genome === genome && gone.includes(active.category)) set({ active: null });
    },

    undoLast: () => {
      const undo = get().undo;
      if (!undo) return null;
      // A move: regions edited in the other catalog since go back with their edits.
      const carried = new Map<string, RegionEntry>();
      if (undo.move) {
        const moved = undo.changes.find(c => c.genome === undo.move!.to)?.after;
        const now = new Map(get().catalogFor(undo.move.to).entries.map(e => [e.id, e]));
        const was = new Map((moved?.entries ?? []).map(e => [e.id, e]));
        for (const [fromId, toId] of undo.move.entries) {
          const e = now.get(toId);
          if (e && e !== was.get(toId)) carried.set(fromId, e);
        }
      }
      for (const { genome, before, after } of undo.changes) edit(genome, c => revertCatalogChange(before, after, c));
      if (undo.move && carried.size) {
        edit(undo.move.from, c => ({
          ...c,
          entries: c.entries.map(e => {
            const edited = carried.get(e.id);
            return edited ? { ...edited, id: e.id, category: e.category } : e;
          }),
        }));
      }
      set({ undo: null });
      return undo.label;
    },
    clearUndo: () => set({ undo: null }),
    setShown: (genome) => { if (get().shown !== genome) set({ shown: genome }); },
    setPicked: (genome) => { if (get().picked !== genome) set({ picked: genome }); },
    forget: (genome) => {
      const timer = saveTimers.get(genome);
      if (timer) {
        clearTimeout(timer);
        saveTimers.delete(genome);
        // Edits still waiting go to the catalog they were made in (its identity), not lost.
        const base = synced.get(genome);
        const pending = get().catalogs[genome];
        if (pending && base && persistenceEnabled()) {
          void enqueue(genome, () => putRegionCatalog(genome, pending, base.revision, base.identity).catch(() => undefined));
        }
      }
      generations.set(genome, generationOf(genome) + 1);
      loading.delete(genome);
      synced.delete(genome);
      set(s => {
        const { [genome]: _c, ...catalogs } = s.catalogs;
        const { [genome]: _s, ...sync } = s.sync;
        return {
          catalogs, sync,
          active: s.active?.genome === genome ? null : s.active,
          undo: s.undo?.changes.some(c => c.genome === genome) ? null : s.undo,
        };
      });
    },

    importBed: (genome, text, fileName, category) => {
      const parsed = parseRegionBed(text);
      const fallback = (category ?? '').trim() || fileName.replace(/\.(bed|txt|tsv)(\.gz)?$/i, '') || 'Imported';
      let result = { imported: 0, categories: [] as string[] };
      edit(genome, c => {
        const res = importBedRegions(c, parsed.regions, fallback);
        result = { imported: res.imported, categories: res.categories };
        return res.catalog;
      });
      return { ...result, skipped: parsed.skipped, problems: parsed.problems };
    },

    applyDetection: (res, datasetLabel, kind, scopeLabel) => {
      const genome = res.genome;
      if (!res.success || !genome || !res.regions.length) return null;
      const fingerprint = res.fingerprint ?? undefined;
      const catalog = get().catalogFor(genome);
      if (kind === 'auto' && fingerprint) {
        // This dataset's amplicons are already listed (perhaps renamed): keep them.
        const known = catalog.categories.find(c => c.source === 'auto' && c.fingerprint === fingerprint);
        const coord = (r: { chrom: string; start: number; end: number }) => `${r.chrom}:${r.start}-${r.end}`;
        const knownKeys = known ? new Set(catalog.entries.filter(e => e.category === known.id).map(coord)) : null;
        if (known && knownKeys && (knownKeys.size !== res.regions.length || res.regions.some(r => !knownKeys.has(coord(r))))) {
          // Found again with other regions (a better scan): this scan's regions replace the earlier ones,
          // keeping the names given to regions found again at the same place.
          const renamed = new Map(catalog.entries.filter(e => e.category === known.id && e.autoLabel != null && e.label !== e.autoLabel)
            .map(e => [coord(e), e.label]));
          const note = `${res.regions.length} region${res.regions.length === 1 ? '' : 's'}${res.method === 'index' ? ' from the BAM index' : ` from ${(res.scanned_reads ?? 0).toLocaleString()} reads`}`;
          edit(genome, c => {
            let next = removeEntriesFrom(c, c.entries.filter(e => e.category === known.id).map(e => e.id));
            next = updateCategoryIn(next, known.id, { note, name: autoCategoryName(res, datasetLabel) });
            return addEntriesTo(next, known.id, res.regions.map(r => ({
              chrom: r.chrom, start: r.start, end: r.end, label: renamed.get(coord(r)) ?? r.label, autoLabel: r.label, source: 'auto' as const,
              reads: r.reads, ...(r.gene ? { gene: r.gene } : {}), ...(r.detail ? { detail: r.detail } : {}),
            }))).catalog;
          });
          return known.id;
        }
        if (known) {
          // Detected names follow the annotation (an earlier version named hg38 amplicons after
          // a multi-copy gene): an amplicon never renamed takes the new name; a renamed one keeps
          // its name, with the new detected one behind "Restore name".
          const fresh = new Map(res.regions.map(r => [`${r.chrom}:${r.start}-${r.end}`, r]));
          const stale = catalog.entries.some(e => {
            const r = e.category === known.id ? fresh.get(`${e.chrom}:${e.start}-${e.end}`) : undefined;
            return r && (e.autoLabel !== r.label || (e.detail ?? null) !== (r.detail ?? null));
          });
          if (stale) {
            edit(genome, c => ({
              ...c,
              entries: c.entries.map(e => {
                const r = e.category === known.id ? fresh.get(`${e.chrom}:${e.start}-${e.end}`) : undefined;
                if (!r || (e.autoLabel === r.label && (e.detail ?? null) === (r.detail ?? null))) return e;
                const renamed = e.autoLabel != null && e.label !== e.autoLabel;
                return { ...e, autoLabel: r.label, label: renamed ? e.label : r.label,
                  ...(r.gene ? { gene: r.gene } : {}), ...(r.detail ? { detail: r.detail } : {}) };
              }),
            }));
          }
          return known.id;
        }
      }
      const name = kind === 'auto'
        ? autoCategoryName(res, datasetLabel)
        : `Top regions · ${datasetLabel}${scopeLabel ? ` · ${scopeLabel}` : ''}`;
      const note = res.method === 'index'
        ? `${res.regions.length} region${res.regions.length === 1 ? '' : 's'} from the BAM index (read counts estimated) in ${Math.round(res.elapsed_ms ?? 0)} ms`
        : `${res.regions.length} region${res.regions.length === 1 ? '' : 's'} from ${(res.scanned_reads ?? 0).toLocaleString()} reads in ${Math.round(res.elapsed_ms ?? 0)} ms${res.partial ? ' (stopped early: read or time limit)' : ''}`;
      let categoryId = '';
      edit(genome, c => {
        // Found again on request: replace that category's regions; this dataset's earlier
        // scans of other chromosomes or views go (the latest scan of a dataset is what is listed).
        const again = kind === 'top' ? c.categories.find(x => x.source === 'top' && x.name === name) : undefined;
        const stale = kind === 'top' && fingerprint
          ? c.categories.filter(x => x.source === 'top' && x.fingerprint === fingerprint && x.id !== again?.id).map(x => x.id)
          : [];
        let next = stale.reduce((acc, id) => removeCategoryFrom(acc, id), c);
        next = again ? removeEntriesFrom(next, next.entries.filter(e => e.category === again.id).map(e => e.id)) : next;
        if (again) {
          categoryId = again.id;
          next = updateCategoryIn(next, again.id, { note });
        } else {
          const made = addCategoryTo(next, { name, source: kind, ...(fingerprint ? { fingerprint } : {}), dataset: datasetLabel, note });
          next = made.catalog;
          categoryId = made.id;
        }
        return addEntriesTo(next, categoryId, res.regions.map(r => ({
          chrom: r.chrom, start: r.start, end: r.end, label: r.label, autoLabel: r.label, source: kind,
          reads: r.reads, ...(r.gene ? { gene: r.gene } : {}), ...(r.detail ? { detail: r.detail } : {}),
        }))).catalog;
      });
      return categoryId || null;
    },

    restoreAutoLabels: (genome, categoryId) => edit(genome, c => ({
      ...c,
      entries: c.entries.map(e => (e.category === categoryId && e.autoLabel ? { ...e, label: e.autoLabel } : e)),
    })),

    setFingerprint: (datasetId, fingerprint) => set(s => {
      if (!fingerprint) {
        if (!(datasetId in s.fingerprints)) return s;
        const { [datasetId]: _gone, ...rest } = s.fingerprints;
        return { fingerprints: rest };
      }
      return s.fingerprints[datasetId] === fingerprint ? s : { fingerprints: { ...s.fingerprints, [datasetId]: fingerprint } };
    }),
    setScan: (datasetId, scan) => set(s => {
      if (!scan) {
        const { [datasetId]: _gone, ...rest } = s.scans;
        return { scans: rest };
      }
      return { scans: { ...s.scans, [datasetId]: scan } };
    }),
    setActive: (genome, category, entry) => set({ active: { genome, category, entry } }),
    noteVisited: (entryId) => set(s => ({ recent: [entryId, ...s.recent.filter(id => id !== entryId)].slice(0, 50) })),

    resetGenome: async (genome) => {
      const timer = saveTimers.get(genome);
      if (timer) { clearTimeout(timer); saveTimers.delete(genome); }
      if (persistenceEnabled() && get().sync[genome] === 'ready') {
        // After any save still on its way (it would bring the regions back).
        await enqueue(genome, async () => {
          const identity = synced.get(genome)?.identity;
          const res = await deleteRegionCatalog(genome, identity).catch(() => null);
          synced.set(genome, { catalog: emptyCatalog(genome), revision: res?.revision ?? 0, identity });
        });
      }
      set(s => ({
        catalogs: { ...s.catalogs, [genome]: emptyCatalog(genome) }, active: s.active?.genome === genome ? null : s.active,
        undo: s.undo?.changes.some(c => c.genome === genome) ? null : s.undo,
      }));
    },

    sessionPayload: () => {
      const out: Record<string, RegionCatalog> = {};
      for (const [genome, catalog] of Object.entries(get().catalogs)) {
        if (catalog.entries.length || catalog.categories.length) out[genome] = catalog;
      }
      return out;
    },
    restoreSession: (payload) => {
      if (!payload || typeof payload !== 'object') return;
      for (const [genome, raw] of Object.entries(payload as Record<string, unknown>)) {
        const incoming = normalizeCatalog(raw, genome);
        edit(genome, c => mergeCatalogs(c, incoming));
      }
    },
  };
});

/** Make (or find) a category by name and add regions to it; returns the category's id. */
export function addRegionsToCategory(genome: string, categoryName: string, entries: NewEntry[], extra: Partial<RegionCategory> = {}): { categoryId: string; ids: string[] } {
  const store = useRegionCatalogStore.getState();
  const found = ensureCategory(store.catalogFor(genome), categoryName, extra);
  const categoryId = found.catalog === store.catalogFor(genome) ? found.id : store.addCategory(genome, { name: categoryName, ...extra, id: found.id });
  return { categoryId, ids: store.addEntries(genome, categoryId, entries) };
}

/** A dataset's own detected category: "Amplicons · ind", "Read clusters · ind", "Regions · numb" (targeted, from its index). */
export function autoCategoryName(res: DetectRegionsResponse, datasetLabel: string): string {
  const what = res.kind === 'amplicon' ? 'Amplicons' : res.kind === 'targeted' ? 'Regions' : 'Read clusters';
  return `${what} · ${datasetLabel}`;
}

/** Whether a category is shown: a dataset's detected regions (its own, or found on request) only while that dataset is open. */
export function categoryShown(category: RegionCategory, fingerprints: Record<string, string>): boolean {
  if ((category.source !== 'auto' && category.source !== 'top') || !category.fingerprint) return true;
  return Object.values(fingerprints).includes(category.fingerprint);
}
