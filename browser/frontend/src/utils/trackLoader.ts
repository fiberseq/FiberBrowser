/**
 * Track-loading helper: calls the backend `addTrack` endpoint, then
 * registers the result in the catalog and creates a 1-source composite
 * track in the cart. Use this everywhere a bigwig/bigbed/online track
 * gets loaded so the catalog/cart stay in sync.
 */
import {
  addMotifFileTracks as apiAddMotifFileTracks,
  addTrack as apiAddTrack,
  getTracks as apiGetTracks,
  removeTrack as apiRemoveTrack,
  updateTrackFilter as apiUpdateTrackFilter,
} from '../api/tracks';
import type { BackendMotifTrack } from '../api/tracks';
import { useBrowserStore } from '../stores/browserStore';
import { inferCatalogKind } from '../stores/catalogSlice';
import { makeOneSourceComposite } from '../stores/compositeTracksSlice';
import type { CatalogEntry, CatalogKind, CompositeTrack, TrackSource } from '../types/dataset';
import type { OverlapCondition } from '../types';
import { TRACK_COLORS } from '../components/tracks/TrackContainerConstants';
import { recentTracksOffered, rememberRecentTrack } from '../api/recentTracks';

interface RegisterOpts {
  /** path or URL passed to the backend addTrack endpoint. */
  pathOrUrl: string;
  /** Human label (defaults to backend-returned label or filename). */
  label?: string;
  filterNames?: string[];
  /** Backend "category" (e.g. 'motif'). Forwarded to addTrack. */
  category?: string;
  /** Backend render mode override (e.g. 'annotation', 'signal'). */
  renderMode?: string;
  /** Force online vs local. If omitted, inferred from `pathOrUrl`. */
  source?: 'online' | 'local';
  /** Override the catalog-entry kind (otherwise inferred from extension). */
  kind?: CatalogKind;
  /** Online catalog row id (e.g., UCSC track id) for online entries. */
  catalogId?: string;
  /**
   * Show a warning the server gives with a successful add (a track for another
   * assembly than the main genome) in the app's message banner. Default true;
   * openLocalPaths reports it with its other messages instead.
   */
  showWarning?: boolean;
  /** Whether to also auto-create a 1-source composite in the cart.
   *  Default: true. Set false if you want catalog-only registration. */
  autoCreateComposite?: boolean;
}

interface RegisterResult {
  success: boolean;
  message?: string;
  trackIndex?: number;
  catalogEntryId?: string;
  compositeId?: string;
  /** Added, but its chromosomes are not the main genome's (the server says which reference they fit). */
  warning?: string;
}

interface RegisterBackendMotifTrackOpts extends BackendMotifTrack {
  autoCreateComposite?: boolean;
}

interface UnloadCatalogEntriesOptions {
  removeCartReferences?: boolean;
  triggerRefresh?: boolean;
}

const MOTIF_FILE_RE = /\.(jaspar|meme|pfm|motif|homer|txt)$/i;

function detectSource(pathOrUrl: string): 'online' | 'local' {
  return /^https?:\/\//i.test(pathOrUrl) || /^s3:\/\//i.test(pathOrUrl) ? 'online' : 'local';
}

export function looksLikeMotifFile(pathOrUrl: string): boolean {
  return MOTIF_FILE_RE.test(pathOrUrl.split(/[?#]/, 1)[0] ?? pathOrUrl);
}

export async function registerTrack(opts: RegisterOpts): Promise<RegisterResult> {
  const res = await apiAddTrack(opts.pathOrUrl, opts.label, opts.filterNames, opts.category, opts.renderMode);
  if (!res.success || res.track_index == null) {
    return { success: false, message: res.message };
  }

  const store = useBrowserStore.getState();
  const source = opts.source ?? detectSource(opts.pathOrUrl);
  // The server knows how it draws the track: an annotation track (BED, bigBed,
  // UCSC tables, an unrecognised URL it read as intervals) gets an annotation row.
  const kind = opts.kind ?? (res.render_mode === 'annotation' ? 'bigbed' : inferCatalogKind(opts.pathOrUrl));
  const baseLabel = opts.label ?? res.label ?? opts.pathOrUrl.split('/').pop() ?? 'Track';
  // For motif/annotation tracks with a filter, suffix the filter into the
  // label so multiple cart rows from the same JASPAR file are distinguishable
  // (e.g. "JASPAR2026 dm6 — CTCF" vs "JASPAR2026 dm6 — MAX").
  const label = (opts.filterNames && opts.filterNames.length > 0 && opts.category === 'motif')
    ? `${baseLabel} — ${opts.filterNames.slice(0, 3).join(', ')}${opts.filterNames.length > 3 ? '…' : ''}`
    : baseLabel;

  // Catalog: dedupe by path/url
  const catalogEntryId = store.addCatalogEntry({
    source,
    kind: opts.category === 'motif' ? 'motif' : kind,
    label,
    path: source === 'local' ? opts.pathOrUrl : undefined,
    url: source === 'online' ? opts.pathOrUrl : undefined,
    catalogId: opts.catalogId,
    loaded: true,
    trackIndex: res.track_index,
    // Persist the active filter on the catalog entry so reloads re-register
    // the backend track with the same selection (e.g., a single TF picked
    // from a JASPAR file).
    ...(opts.filterNames && opts.filterNames.length > 0 ? { filterNames: opts.filterNames } : {}),
  });
  // (addCatalogEntry handles the dedup case in-place — no second set needed.)

  // (Legacy ortho-${trackIndex} slots in panel.subTracks are pruned
  // automatically by `syncPanelsForComposites` when the composite below is
  // created — see compositeTracksSlice.ts for the resolver logic.)

  let compositeId: string | undefined;
  if (opts.autoCreateComposite !== false) {
    compositeId = ensureCompositeFor(catalogEntryId, {
      label,
      source,
      kind: opts.category === 'motif' ? 'motif' : kind,
    });
  }

  // Added, but it shows nothing in the main view (its chromosomes are another assembly's).
  if (res.warning && opts.showWarning !== false) useBrowserStore.getState().setError(res.warning);
  return {
    success: true,
    trackIndex: res.track_index,
    catalogEntryId,
    compositeId,
    ...(res.warning ? { warning: res.warning } : {}),
  };
}

/** The one-source track showing a catalog entry: re-shown if it exists,
 * otherwise created with a colour not yet used. Returns its id. */
export function ensureCompositeFor(
  catalogEntryId: string,
  entry: { label: string; source: 'online' | 'local'; kind: CatalogKind },
): string {
  const store = useBrowserStore.getState();
  const existing = store.compositeTracks.find(
    c => c.sources.length === 1 &&
      'catalogEntryId' in c.sources[0].ref &&
      c.sources[0].ref.catalogEntryId === catalogEntryId,
  );
  if (existing) {
    if (!existing.visible) store.updateComposite(existing.id, { visible: true });
    return existing.id;
  }
  const used = new Set(store.compositeTracks.flatMap(c => c.sources.map(s => s.color)));
  const color = TRACK_COLORS.find(c => !used.has(c)) ?? TRACK_COLORS[store.compositeTracks.length % TRACK_COLORS.length];
  const isAnnotation = entry.kind === 'motif' || entry.kind === 'bigbed';
  return store.addComposite(makeOneSourceComposite({
    catalogEntryId,
    label: entry.label,
    kind: isAnnotation ? 'annotation' : 'signal',
    refKind: catalogRefKind(entry),
    color,
  }));
}

/** Source-reference kind for a catalog entry. */
export function catalogRefKind(entry: { source: 'online' | 'local'; kind: CatalogKind }): 'bigwig' | 'bigbed' | 'online' {
  if (entry.kind === 'motif') return 'bigbed';
  if (entry.source === 'online') return 'online';
  return entry.kind === 'bigbed' ? 'bigbed' : 'bigwig';
}

/**
 * Show a previously used source (from this session's catalog or the server's
 * recent list) as a track. It is registered with the backend lazily, when
 * the track is drawn, like any restored source.
 */
type RecentSourceEntry = {
  source: 'online' | 'local'; kind: CatalogKind; label: string;
  path?: string; url?: string; catalogId?: string; filterNames?: string[]; meta?: Record<string, unknown>;
};

/** Put a remembered source back in this session's list (no track of its own). Returns its id. */
export function addRecentSource(entry: RecentSourceEntry): string {
  const store = useBrowserStore.getState();
  const catalogEntryId = store.addCatalogEntry({
    source: entry.source,
    kind: entry.kind,
    label: entry.label,
    path: entry.path,
    url: entry.url,
    catalogId: entry.catalogId,
    loaded: false,
    ...(entry.filterNames?.length ? { filterNames: entry.filterNames } : {}),
    ...(entry.meta ? { meta: entry.meta } : {}),
  });
  store.markCatalogUnavailable(catalogEntryId, false);
  if (recentTracksOffered(store.publicMode)) void rememberRecentTrack(entry).catch(() => {});
  return catalogEntryId;
}

export function showRecentSource(entry: RecentSourceEntry): string {
  const store = useBrowserStore.getState();
  const catalogEntryId = store.addCatalogEntry({
    source: entry.source,
    kind: entry.kind,
    label: entry.label,
    path: entry.path,
    url: entry.url,
    catalogId: entry.catalogId,
    loaded: false,
    ...(entry.filterNames?.length ? { filterNames: entry.filterNames } : {}),
    ...(entry.meta ? { meta: entry.meta } : {}),
  });
  // Asking for it again is a retry: a source that failed earlier gets another go.
  store.markCatalogUnavailable(catalogEntryId, false);
  const compositeId = ensureCompositeFor(catalogEntryId, entry);
  store.triggerRefresh();
  // A reuse keeps it at the top of Recent.
  if (recentTracksOffered(store.publicMode)) void rememberRecentTrack(entry).catch(() => {});
  return compositeId;
}

export function registerBackendMotifTrack(opts: RegisterBackendMotifTrackOpts): RegisterResult {
  if (opts.track_index == null || !opts.path) {
    return { success: false, message: 'Motif track response did not include a backend track index/path' };
  }

  const store = useBrowserStore.getState();
  const label = opts.label || opts.motif_name || opts.path;
  const catalogEntryId = store.addCatalogEntry({
    source: 'local',
    kind: 'motif',
    label,
    path: opts.path,
    loaded: true,
    trackIndex: opts.track_index,
    meta: { format: 'custom_motif', ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}) },
  });

  let compositeId: string | undefined;
  if (opts.autoCreateComposite !== false) {
    compositeId = ensureCompositeFor(catalogEntryId, { label, source: 'local', kind: 'motif' });
  }

  return {
    success: true,
    trackIndex: opts.track_index,
    catalogEntryId,
    compositeId,
  };
}

export async function registerMotifFileTracks(
  filePath: string,
  threshold?: number,
  autoCreateComposite = true,
): Promise<RegisterResult & { count?: number; catalogEntryIds?: string[] }> {
  const res = await apiAddMotifFileTracks(filePath, undefined, threshold);
  if (!res.success) {
    return { success: false, message: res.message };
  }

  let first: RegisterResult | null = null;
  const catalogEntryIds: string[] = [];
  for (const track of res.tracks ?? []) {
    const registered = registerBackendMotifTrack({ ...track, autoCreateComposite });
    if (registered.catalogEntryId) catalogEntryIds.push(registered.catalogEntryId);
    if (!first) first = registered;
  }

  return {
    success: true,
    message: res.message,
    count: res.count,
    catalogEntryIds,
    trackIndex: first?.trackIndex,
    catalogEntryId: first?.catalogEntryId,
    compositeId: first?.compositeId,
  };
}

function sourceCatalogEntryId(source: TrackSource): string | null {
  return source.ref.kind === 'metaprofile' ? null : source.ref.catalogEntryId;
}

function compositeCatalogEntryIds(composite: CompositeTrack): string[] {
  return composite.sources
    .map(sourceCatalogEntryId)
    .filter((id): id is string => Boolean(id));
}

/**
 * Remove one backend track. The backend shifts the tracks after it down one
 * index, so name filters (kept by index) move with their tracks.
 */
export async function removeBackendTrack(trackIndex: number): Promise<void> {
  const res = await apiRemoveTrack(trackIndex);
  if (res && res.success === false) throw new Error(res.message || `Failed to remove track ${trackIndex}`);
  useBrowserStore.getState().shiftTrackFiltersAfterRemoval(trackIndex);
  shiftTrackRuleReferences(trackIndex);
}

/**
 * Remove a loaded track by backend index as the track browser does: its cart
 * and catalog entries go too (else the still-shown track registers it again),
 * index-keyed filters and rule references follow the shift, and views refresh.
 */
export async function removeTrackAtIndex(trackIndex: number): Promise<void> {
  const entries = await catalogEntriesForTrack(trackIndex);
  if (entries.length === 0) {
    await removeBackendTrack(trackIndex);
    useBrowserStore.getState().triggerRefresh();
    return;
  }
  if (!entries.some(entry => typeof entry.trackIndex === 'number')) await removeBackendTrack(trackIndex);
  await unloadCatalogEntries(entries.map(entry => entry.id));
}

/**
 * The catalog entries of a loaded backend track: those stamped with its index,
 * else the one entry for the same file with the same name filter. Several
 * tracks of one file (CTCF and MAX from one BigBed) are distinct, so an
 * ambiguous match gives none.
 */
async function catalogEntriesForTrack(trackIndex: number): Promise<CatalogEntry[]> {
  const catalog = useBrowserStore.getState().catalog;
  const stamped = catalog.filter(entry => entry.trackIndex === trackIndex);
  if (stamped.length > 0) return stamped;
  const normalize = (p: string) => decodeURIComponent(p).replace(/\/+$/, '');
  const filterKey = (names: readonly string[] | null | undefined) => [...(names ?? [])].sort().join(',');
  try {
    const listed = (await apiGetTracks()).tracks[trackIndex];
    if (!listed?.path) return [];
    const path = normalize(listed.path);
    const matches = catalog.filter(entry => typeof entry.trackIndex !== 'number'
      && normalize(entry.url ?? entry.path ?? '') === path
      && filterKey(entry.filterNames) === filterKey(listed.filter_names));
    return matches.length === 1 ? matches : [];
  } catch {
    return [];
  }
}

/**
 * Set a loaded track's name filter on the server, in the browser's index-keyed
 * filters and in its catalog entry, so re-registering the track later (after
 * another removal clears the catalog's indices, or on a session reload) keeps
 * the new filter rather than the one it was first loaded with.
 */
export async function setTrackNameFilter(trackIndex: number, names: string[] | null): Promise<void> {
  const filterNames = names && names.length > 0 ? names : null;
  // Found before the change: the fallback matches the track's current filter.
  const entries = await catalogEntriesForTrack(trackIndex);
  const res = await apiUpdateTrackFilter(trackIndex, filterNames);
  if (res && res.success === false) throw new Error(`Failed to set the filter of track ${trackIndex}`);
  useBrowserStore.getState().setTrackFilter(trackIndex, filterNames);
  if (entries.length > 0) {
    const ids = new Set(entries.map(entry => entry.id));
    useBrowserStore.setState(state => ({
      catalog: state.catalog.map(entry => {
        if (!ids.has(entry.id)) return entry;
        const { filterNames: _old, ...rest } = entry;
        return filterNames ? { ...rest, filterNames: [...filterNames] } : rest;
      }),
    }));
  }
  useBrowserStore.getState().triggerRefresh();
}

/** A condition on the removed track matches nothing (never silently another track). */
const REMOVED_TRACK_ID = 'removed';

/**
 * Track conditions after a backend removal: references to later tracks move
 * down one index with them; references to the removed track can no longer
 * resolve. Returns the same array when nothing changed.
 */
export function shiftTrackConditions<T extends OverlapCondition>(conditions: T[] | undefined, removedIndex: number): T[] | undefined {
  if (!conditions) return conditions;
  let changed = false;
  const next = conditions.map(cond => {
    if (cond.target !== 'track' || !cond.trackId) return cond;
    const idx = Number.parseInt(cond.trackId, 10);
    if (!Number.isFinite(idx) || idx < removedIndex) return cond;
    changed = true;
    return { ...cond, trackId: idx === removedIndex ? REMOVED_TRACK_ID : String(idx - 1) };
  });
  return changed ? next : conditions;
}

/** Labeling rules and saved footprint definitions keep pointing at their own tracks. */
function shiftTrackRuleReferences(removedIndex: number): void {
  const state = useBrowserStore.getState();
  const colormap = state.activeColormap;
  let rulesChanged = false;
  const rules = colormap.rules.map(rule => {
    const conditions = shiftTrackConditions(rule.conditions, removedIndex);
    if (conditions === rule.conditions) return rule;
    rulesChanged = true;
    return { ...rule, conditions: conditions ?? [] };
  });
  if (rulesChanged) useBrowserStore.setState({ activeColormap: { ...colormap, rules } });
  let groupsChanged = false;
  const groups = state.footprintGroups.map(group => {
    const conditions = shiftTrackConditions(group.conditions, removedIndex);
    if (conditions === group.conditions) return group;
    groupsChanged = true;
    return { ...group, conditions };
  });
  if (groupsChanged) state.setFootprintGroups(groups);
}

async function removeBackendTrackIndices(trackIndices: number[]): Promise<void> {
  const unique = [...new Set(trackIndices)]
    .filter(index => Number.isFinite(index) && index >= 0)
    .sort((a, b) => b - a);
  for (const trackIndex of unique) {
    try {
      await removeBackendTrack(trackIndex);
    } catch (error) {
      console.warn(`Failed to remove backend track ${trackIndex}`, error);
    }
  }
}

/**
 * Unload catalog-backed tracks from the live backend session. By default this
 * also removes cart references, so an X in the cart or motif list cannot leave
 * an expensive motif/bigBed source active and silently rehydrated on pan.
 */
export async function unloadCatalogEntries(
  catalogEntryIds: Iterable<string>,
  options: UnloadCatalogEntriesOptions = {},
): Promise<void> {
  const entryIds = new Set(catalogEntryIds);
  if (entryIds.size === 0) return;
  const removeCartReferences = options.removeCartReferences ?? true;
  const triggerRefresh = options.triggerRefresh ?? true;
  const store = useBrowserStore.getState();
  const entries = store.catalog.filter(entry => entryIds.has(entry.id));
  const trackIndices = entries
    .map(entry => entry.trackIndex)
    .filter((index): index is number => typeof index === 'number');

  if (removeCartReferences) {
    const composites = [...store.compositeTracks];
    for (const composite of composites) {
      const matchingSources = composite.sources.filter(source => {
        const id = sourceCatalogEntryId(source);
        return id !== null && entryIds.has(id);
      });
      if (matchingSources.length === 0) continue;
      if (matchingSources.length === composite.sources.length && composite.removable !== false) {
        useBrowserStore.getState().removeComposite(composite.id);
      } else {
        for (const source of matchingSources) {
          useBrowserStore.getState().removeSourceFrom(composite.id, source.id);
        }
      }
    }
  }

  await removeBackendTrackIndices(trackIndices);
  // Removing an orthogonal track compacts backend indices, so every stamped
  // index after the deleted slot may now be wrong. Clear all and let the next
  // active-track fetch claim or re-register the surviving entries.
  useBrowserStore.getState().clearCatalogTrackIndices();
  for (const id of entryIds) {
    useBrowserStore.getState().setCatalogLoaded(id, false);
    useBrowserStore.getState().clearCatalogTrackIndex(id);
  }
  if (triggerRefresh) useBrowserStore.getState().triggerRefresh();
}

export async function unloadCompositeTrack(composite: CompositeTrack): Promise<void> {
  const entryIds = compositeCatalogEntryIds(composite);
  useBrowserStore.getState().removeComposite(composite.id);
  const orphaned = entryIds.filter(id => useBrowserStore.getState().getCatalogRefCount(id) === 0);
  await unloadCatalogEntries(orphaned, { removeCartReferences: false });
}

export async function unloadCompositeSource(compositeId: string, source: TrackSource): Promise<void> {
  const entryId = sourceCatalogEntryId(source);
  useBrowserStore.getState().removeSourceFrom(compositeId, source.id);
  if (!entryId || useBrowserStore.getState().getCatalogRefCount(entryId) > 0) {
    useBrowserStore.getState().triggerRefresh();
    return;
  }
  await unloadCatalogEntries([entryId], { removeCartReferences: false });
}

export async function unloadOrthogonalTrackByIndex(trackIndex: number): Promise<void> {
  const store = useBrowserStore.getState();
  const track = store.orthogonalTracks.find(candidate => candidate.index === trackIndex);
  const exactEntries = store.catalog.filter(entry => entry.trackIndex === trackIndex);
  let fallbackEntries: typeof store.catalog = [];
  if (exactEntries.length === 0 && track) {
    fallbackEntries = store.catalog.filter(entry => {
      const target = entry.path ?? entry.url;
      if (track.format === 'custom_motif' && track.path && target === track.path) return true;
      return entry.kind === 'motif' && track.label === entry.label;
    });
    if (fallbackEntries.length !== 1) fallbackEntries = [];
  }
  const entryIds = (exactEntries.length > 0 ? exactEntries : fallbackEntries).map(entry => entry.id);
  if (entryIds.length > 0) {
    await unloadCatalogEntries(entryIds, { removeCartReferences: true });
    return;
  }
  await removeBackendTrackIndices([trackIndex]);
  useBrowserStore.getState().clearCatalogTrackIndices();
  useBrowserStore.getState().triggerRefresh();
}
