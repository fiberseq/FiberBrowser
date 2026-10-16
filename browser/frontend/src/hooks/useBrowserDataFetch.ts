import { useEffect, useCallback, useRef, useMemo, type Dispatch, type SetStateAction } from 'react';
import { restoreMotifTrack } from '../utils/motifLoader';
import { useBrowserStore } from '../stores/browserStore';
import { getGenes } from '../api/reference';
import { addTrack, getTracks, getTracksBatch, type TrackBatchItemResponse, type TrackListEntry } from '../api/tracks';
import type { OrthogonalTrack } from '../types/dataset';
import { findChromInfo } from '../utils/chromAliases';
import { getActiveCatalogEntryIds, getActiveOrthogonalTrackIndices } from '../utils/activeOrthogonalTracks';

const AUXILIARY_PREFETCH_WINDOWS = 1.5;

// Simple debounce utility for viewport fetches
function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): T & { cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: unknown[]) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  }) as T & { cancel: () => void };

  debounced.cancel = () => {
    if (timeoutId) clearTimeout(timeoutId);
  };

  return debounced;
}

/**
 * Fetches auxiliary viewport data (genes and orthogonal tracks).
 *
 * This deliberately does not flip the global loading flag. Read panels have
 * their own loading state, and toggling the app-wide flag on every pan causes
 * unrelated tracks to re-render while the viewport-critical read request is
 * still in flight.
 */
function trackMetadata(track: TrackListEntry): OrthogonalTrack {
  const renderMode = track.render_mode === 'annotation' ? 'annotation' : 'signal';
  return {
    index: track.index,
    label: track.label,
    values: [],
    renderMode,
    ...(track.category && { category: track.category }),
    ...(track.path && { path: track.path }),
    ...(track.format && { format: track.format }),
    ...(track.motif_type && { motif_type: track.motif_type }),
    ...(track.motif_name && { motif_name: track.motif_name }),
    ...(track.motif_source && { motif_source: track.motif_source }),
  };
}

function trackListCacheKey(trackList: TrackListEntry[]): string {
  return trackList
    .map(track => `${track.index}:${track.path}:${track.render_mode ?? 'signal'}:${track.format ?? ''}`)
    .sort()
    .join('|');
}

function trackFiltersCacheKey(trackFilters: Record<number, string[] | undefined>): string {
  return Object.entries(trackFilters)
    .map(([index, names]) => `${index}:${(names ?? []).join(',')}`)
    .sort()
    .join('|');
}

function sliceSignalValues(
  values: number[],
  sourceStart: number,
  sourceEnd: number,
  viewStart: number,
  viewEnd: number,
): number[] {
  if (values.length === 0) return [];
  const sourceWidth = Math.max(1, sourceEnd - sourceStart);
  const startIdx = Math.max(0, Math.floor(((viewStart - sourceStart) / sourceWidth) * values.length));
  const endIdx = Math.min(values.length, Math.ceil(((viewEnd - sourceStart) / sourceWidth) * values.length));
  if (startIdx <= 0 && endIdx >= values.length) return values;
  return values.slice(startIdx, Math.max(startIdx + 1, endIdx));
}

function renderTracksForViewport(
  trackList: TrackListEntry[],
  activeSet: Set<number>,
  batchByIndex: Map<number, TrackBatchItemResponse>,
  sourceStart: number,
  sourceEnd: number,
  viewStart: number,
  viewEnd: number,
): OrthogonalTrack[] {
  return trackList.map((t) => {
    const base = trackMetadata(t);
    if (!activeSet.has(t.index)) return base;

    const batch = batchByIndex.get(t.index);
    if (!batch || batch.error) return base;

    const renderMode = batch.render_mode === 'annotation' ? 'annotation' : base.renderMode;
    if (renderMode === 'annotation') {
      return {
        ...base,
        label: batch.label || t.label,
        intervals: (batch.intervals || []).filter(iv => iv.end > viewStart && iv.start < viewEnd),
        renderMode: 'annotation' as const,
      };
    }

    return {
      ...base,
      label: batch.label || t.label,
      values: sliceSignalValues(batch.values || [], sourceStart, sourceEnd, viewStart, viewEnd),
      renderMode: 'signal' as const,
    };
  });
}

/**
 * Signal bins to fetch for a query: `requestedBins` across the viewport. At
 * base-level zoom, asking pyBigWig for more bins than bases creates odd-looking
 * oversampled vectors, so cap to one bin per bp.
 */
export function signalBinCount(queryWidth: number, viewportBp: number, requestedBins: number): number {
  const width = Math.max(1, queryWidth);
  return Math.max(1, Math.min(Math.round(requestedBins * (width / viewportBp)), width));
}

/**
 * Cached signal is reusable only when its bins are no coarser than the view
 * needs (a little slack for rounding), so zooming in refetches finer bins.
 */
export function cachedBinsFineEnough(cachedBpPerBin: number, viewportBp: number, requestedBins: number): boolean {
  const neededBpPerBin = Math.max(1, viewportBp / requestedBins);
  return cachedBpPerBin <= neededBpPerBin * 1.25;
}

interface AuxiliaryFetchCache {
  chrom: string;
  start: number;
  end: number;
  /** bp per bin of the cached signal (0 when none was fetched). */
  bpPerBin: number;
  activeTrackKey: string;
  activeCatalogKey: string;
  trackFiltersKey: string;
  trackListKey: string;
  refreshGeneration: number;
  genes: Awaited<ReturnType<typeof getGenes>>['genes'];
  batchByIndex: Map<number, TrackBatchItemResponse>;
}

function catalogTarget(entry: { path?: string; url?: string }): string | null {
  return entry.path ?? entry.url ?? null;
}

function hasLiveTrackIndex(entry: { trackIndex?: number; path?: string; url?: string }, trackList: TrackListEntry[]): boolean {
  if (typeof entry.trackIndex !== 'number') return false;
  const target = catalogTarget(entry);
  const match = trackList.find(track => track.index === entry.trackIndex);
  return !!match && (!target || match.path === target);
}

/** The render mode the server gives a track added without one (tracks_endpoint._default_render_mode_for_path). */
export function defaultRenderModeForPath(path: string): 'annotation' | 'signal' {
  // Motif tracks (motif://…) are registered as annotation rows too.
  if (path.startsWith('ucsc://') || path.startsWith('motif://')) return 'annotation';
  const lower = path.toLowerCase();
  return /\.(bed|bed\.gz|bb|bigbed)$/.test(lower) ? 'annotation' : 'signal';
}

/**
 * A loaded track the server would hand back for this entry anyway: same file,
 * no name filter, and the category and render mode registering it would give.
 * A track filtered to some names (say CTCF only) is a different track.
 */
export function findExistingUnfilteredTrack(
  entry: { path?: string; url?: string; filterNames?: string[]; kind?: string },
  trackList: TrackListEntry[],
): TrackListEntry | null {
  if (entry.filterNames && entry.filterNames.length > 0) return null;
  const target = catalogTarget(entry);
  if (!target) return null;
  const category = entry.kind === 'motif' ? 'motif' : null;
  const renderMode = entry.kind === 'motif' ? 'annotation' : defaultRenderModeForPath(target);
  return trackList.find(track => track.path === target
    && (track.filter_names ?? []).length === 0
    && (track.category ?? null) === category
    && (track.render_mode ?? 'signal') === renderMode) ?? null;
}

async function ensureActiveCatalogTracks(
  trackList: TrackListEntry[],
  signal: AbortSignal,
  setTrackList: Dispatch<SetStateAction<TrackListEntry[]>>,
): Promise<TrackListEntry[]> {
  const store = useBrowserStore.getState();
  const activeCatalogIds = getActiveCatalogEntryIds(store);
  if (activeCatalogIds.size === 0) return trackList;

  // First pass: claim existing track indices (cheap, sync) so we only network
  // for genuinely-new entries.
  const toRegister: typeof store.catalog = [];
  for (const entry of store.catalog) {
    if (signal.aborted) return trackList;
    if (!activeCatalogIds.has(entry.id) || entry.unavailable) continue;
    if (hasLiveTrackIndex(entry, trackList)) continue;

    const existing = findExistingUnfilteredTrack(entry, trackList);
    if (existing) {
      store.setCatalogTrackIndex(entry.id, existing.index);
      if (!entry.loaded) store.setCatalogLoaded(entry.id, true);
      continue;
    }
    if (catalogTarget(entry)) toRegister.push(entry);
  }

  // Parallelize the network registration step so a cart with N entries pays
  // a few round-trips of latency instead of N. Cap concurrency so a viewport
  // with a heavy composite or many active motif catalog entries doesn't fire
  // dozens of /api/add_track requests at once against a network-mounted index.
  const REGISTER_CONCURRENCY = 6;
  type RegisterOutcome = PromiseSettledResult<{ entry: typeof toRegister[number]; res: Awaited<ReturnType<typeof addTrack>> }>;
  const results: RegisterOutcome[] = new Array(toRegister.length);
  for (let batchStart = 0; batchStart < toRegister.length; batchStart += REGISTER_CONCURRENCY) {
    if (signal.aborted) return trackList;
    const batch = toRegister.slice(batchStart, batchStart + REGISTER_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(entry => {
        const target = catalogTarget(entry)!;
        // motif:// tracks are scans, not files: rebuild them from their ID.
        if (target.startsWith('motif://')) {
          const savedThreshold = typeof entry.meta?.threshold === 'number' ? entry.meta.threshold : undefined;
          return restoreMotifTrack(target, savedThreshold).then(res => ({ entry, res }));
        }
        return addTrack(target, entry.label, entry.filterNames, entry.kind === 'motif' ? 'motif' : undefined)
          .then(res => ({ entry, res }));
      }),
    );
    for (let i = 0; i < batchResults.length; i++) {
      results[batchStart + i] = batchResults[i];
    }
  }

  let changed = false;
  for (const outcome of results) {
    if (signal.aborted) return trackList;
    if (outcome.status === 'rejected') {
      // Without a successful result we can't know which entry failed, but the
      // map is positional so use the same index into toRegister.
      continue;
    }
    const { entry, res } = outcome.value;
    if (res.success && res.track_index !== undefined) {
      store.setCatalogTrackIndex(entry.id, res.track_index);
      if (!entry.loaded) store.setCatalogLoaded(entry.id, true);
      if (entry.filterNames && entry.filterNames.length > 0) {
        store.setTrackFilter(res.track_index, entry.filterNames);
      }
      changed = true;
    } else {
      store.markCatalogUnavailable(entry.id, true);
    }
  }
  // Mark rejected positions unavailable using the index correspondence.
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      store.markCatalogUnavailable(toRegister[i].id, true);
    }
  }

  if (!changed || signal.aborted) return trackList;
  try {
    const res = await getTracks();
    if (signal.aborted) return trackList;
    setTrackList(res.tracks);
    return res.tracks;
  } catch {
    return trackList;
  }
}

export function useBrowserDataFetch(
  trackList: TrackListEntry[],
  setTrackList: Dispatch<SetStateAction<TrackListEntry[]>>,
  viewportWidth?: number,
) {
  const isRenderMode = typeof window !== 'undefined' && window.__FIBERBROWSER_RENDER_MODE;
  const chrom = useBrowserStore(s => s.chrom);
  const start = useBrowserStore(s => s.start);
  const end = useBrowserStore(s => s.end);
  const datasets = useBrowserStore(s => s.datasets);
  const trackFilters = useBrowserStore(s => s.trackFilters);
  const panels = useBrowserStore(s => s.panels);
  const catalog = useBrowserStore(s => s.catalog);
  const compositeTracks = useBrowserStore(s => s.compositeTracks);
  const activeColormap = useBrowserStore(s => s.activeColormap);
  const footprintGroups = useBrowserStore(s => s.footprintGroups);
  // Re-fetch genes/tracks when the genome or dataset list changes mid-session
  // (e.g. after loadGenome fires asynchronously and the GTF becomes available).
  // Without this, the browser's 5-minute HTTP cache keeps serving the stale
  // "gtf_loaded: false" response from the first page-load race.
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);

  const fetchControllerRef = useRef<AbortController | null>(null);
  const auxiliaryCacheRef = useRef<AuxiliaryFetchCache | null>(null);
  const activeTrackIndices = useMemo(() => getActiveOrthogonalTrackIndices({
    panels,
    catalog,
    compositeTracks,
    activeColormap,
    footprintGroups,
  }, trackList), [panels, catalog, compositeTracks, activeColormap, footprintGroups, trackList]);
  const activeTrackKey = useMemo(
    () => Array.from(activeTrackIndices).sort((a, b) => a - b).join(','),
    [activeTrackIndices],
  );
  const activeCatalogEntryIds = useMemo(() => getActiveCatalogEntryIds({
    panels,
    catalog,
    compositeTracks,
    activeColormap,
    footprintGroups,
  }), [panels, catalog, compositeTracks, activeColormap, footprintGroups]);
  const activeCatalogKey = useMemo(
    () => Array.from(activeCatalogEntryIds).sort().join(','),
    [activeCatalogEntryIds],
  );
  const trackFiltersKey = useMemo(() => trackFiltersCacheKey(trackFilters), [trackFilters]);
  const trackListKey = useMemo(() => trackListCacheKey(trackList), [trackList]);

  const fetchData = useCallback(async () => {
    // Abort any in-flight fetch
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    const signal = controller.signal;

    try {
      const chromSize = findChromInfo(useBrowserStore.getState().chroms, chrom)?.size;
      const viewportBp = Math.max(3, end - start);
      const paddingBp = Math.round(viewportBp * AUXILIARY_PREFETCH_WINDOWS);
      const queryStart = Math.max(0, start - paddingBp);
      const queryEnd = Math.max(
        queryStart + 1,
        chromSize ? Math.min(chromSize, end + paddingBp) : end + paddingBp,
      );
      const requestedBins = viewportWidth && viewportWidth > 0 ? Math.round(viewportWidth) : 500;
      const cached = auxiliaryCacheRef.current;
      if (
        cached &&
        cached.chrom === chrom &&
        cached.start <= start &&
        cached.end >= end &&
        cachedBinsFineEnough(cached.bpPerBin, viewportBp, requestedBins) &&
        cached.activeTrackKey === activeTrackKey &&
        cached.activeCatalogKey === activeCatalogKey &&
        cached.trackFiltersKey === trackFiltersKey &&
        cached.trackListKey === trackListKey &&
        cached.refreshGeneration === refreshGeneration
      ) {
        useBrowserStore.getState().setGenes(cached.genes);
        if (trackList.length > 0) {
          const activeSet = getActiveOrthogonalTrackIndices(useBrowserStore.getState(), trackList);
          useBrowserStore.getState().setOrthogonalTracks(renderTracksForViewport(
            trackList,
            activeSet,
            cached.batchByIndex,
            cached.start,
            cached.end,
            start,
            end,
          ));
        }
        return;
      }

      let genesError: unknown = null;
      let cachedGenes: AuxiliaryFetchCache['genes'] = [];
      const genesPromise = getGenes(chrom, queryStart, queryEnd, { signal })
        .then(genesRes => {
          cachedGenes = genesRes.genes;
          if (!signal.aborted) useBrowserStore.getState().setGenes(genesRes.genes);
        })
        .catch(err => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          genesError = err;
        });

      let currentTrackList = await ensureActiveCatalogTracks(trackList, signal, setTrackList);
      if (signal.aborted) return;
      let batchByIndexForCache = new Map<number, TrackBatchItemResponse>();
      let bpPerBinForCache = 0;
      let tracksFailed = false;
      let cacheTrackListKey = trackListCacheKey(currentTrackList);

      // Fetch orthogonal tracks (signal data + annotations for annotation-mode tracks)
      if (currentTrackList.length > 0) {
        const activeSet = getActiveOrthogonalTrackIndices(useBrowserStore.getState(), currentTrackList);
        const queryWidth = Math.max(1, queryEnd - queryStart);
        const bins = signalBinCount(queryWidth, viewportBp, requestedBins);
        const activeTracks = currentTrackList.filter(t => activeSet.has(t.index));
        const annotationFilters: Record<number, string[] | undefined> = {};
        for (const track of activeTracks) {
          if ((track.render_mode || 'signal') === 'annotation') {
            annotationFilters[track.index] = trackFilters[track.index];
          }
        }

        const batchByIndex = new Map<number, TrackBatchItemResponse>();
        if (activeTracks.length > 0) {
          const batchRes = await getTracksBatch(
            activeTracks.map(track => track.index),
            chrom,
            queryStart,
            queryEnd,
            bins,
            annotationFilters,
            { signal },
          ).catch((err: unknown) => {
            // Shown empty for now, but never cached as data: the next pan retries.
            if (!(err instanceof DOMException && err.name === 'AbortError')) tracksFailed = true;
            return { tracks: [] as TrackBatchItemResponse[] };
          });
          if (signal.aborted) return;
          for (const track of batchRes.tracks) batchByIndex.set(track.index, track);
          bpPerBinForCache = queryWidth / bins;
        }
        batchByIndexForCache = batchByIndex;

        const tracks = renderTracksForViewport(currentTrackList, activeSet, batchByIndex, queryStart, queryEnd, start, end);
        if (!signal.aborted) {
          useBrowserStore.getState().setOrthogonalTracks(tracks);
        }
      } else {
        if (!signal.aborted) {
          useBrowserStore.getState().setOrthogonalTracks([]);
        }
      }

      await genesPromise;
      if (genesError) throw genesError;
      if (tracksFailed && !signal.aborted) {
        useBrowserStore.getState().setError('Could not load track data for this view; it will be retried.');
      }
      if (!signal.aborted && !tracksFailed) {
        auxiliaryCacheRef.current = {
          chrom,
          start: queryStart,
          end: queryEnd,
          bpPerBin: bpPerBinForCache,
          activeTrackKey,
          activeCatalogKey,
          trackFiltersKey,
          trackListKey: cacheTrackListKey,
          refreshGeneration,
          genes: cachedGenes,
          batchByIndex: batchByIndexForCache,
        };
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Cancel the in-flight genes fetch so its `if (!signal.aborted)` guard
      // fires — otherwise a parallel genes resolution can overwrite the
      // just-shown error banner with stale viewport gene data.
      controller.abort();
      useBrowserStore.getState().setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [chrom, start, end, datasets.length, trackList, setTrackList, trackFilters, trackFiltersKey, trackListKey, viewportWidth, refreshGeneration, activeTrackKey, activeCatalogKey]);

  // Debounce longer than read fetches so navigation stays responsive; genes
  // and external tracks can safely lag by a fraction of a second.
  const debouncedFetchData = useMemo(
    () => debounce(fetchData, 300),
    [fetchData]
  );

  useEffect(() => {
    // Legacy /api/render injects genes and track values itself; figure
    // renders restore a whole browser state and fetch like the live app.
    if (isRenderMode && !window.__FIBERBROWSER_FIGURE_MODE) return;
    debouncedFetchData();
    return () => {
      debouncedFetchData.cancel();
      fetchControllerRef.current?.abort();
    };
  }, [debouncedFetchData, isRenderMode]);
}
