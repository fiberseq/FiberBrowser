import type { TrackListEntry } from '../api/tracks';
import type { BrowserState } from '../stores/browserStore';
import type { ColorRule, FootprintGroup, OverlapCondition } from '../types';
import type { CatalogEntry, SourceRef } from '../types/dataset';

function isMotifTrack(track: TrackListEntry): boolean {
  const category = String(track.category ?? '').toLowerCase();
  return category === 'motif'
    || category === 'motifs'
    || track.format === 'custom_motif'
    || String(track.motif_name ?? '').length > 0;
}

function hasEnabledMotifCondition(rules: ColorRule[] | undefined, groups: FootprintGroup[] | undefined): boolean {
  for (const rule of rules ?? []) {
    if (!rule.enabled) continue;
    if (rule.conditions?.some(condition => condition.target === 'motif')) return true;
  }
  for (const group of groups ?? []) {
    if (!group.enabled) continue;
    if (group.conditions?.some(condition => condition.target === 'motif')) return true;
  }
  return false;
}

interface TrackLookup {
  byIndex: Map<number, TrackListEntry>;
  indexByPath: Map<string, number>;
  motifTrackIndices: number[];
}

function buildTrackLookup(trackList: TrackListEntry[]): TrackLookup {
  const byIndex = new Map<number, TrackListEntry>();
  const indexByPath = new Map<string, number>();
  const motifTrackIndices: number[] = [];
  for (const track of trackList) {
    byIndex.set(track.index, track);
    if (track.path && !indexByPath.has(track.path)) {
      indexByPath.set(track.path, track.index);
    }
    if (isMotifTrack(track)) motifTrackIndices.push(track.index);
  }
  return { byIndex, indexByPath, motifTrackIndices };
}

function resolveCatalogTrackIndex(entry: CatalogEntry | undefined, lookup: TrackLookup): number | null {
  if (!entry) return null;
  const target = entry.path ?? entry.url;
  if (typeof entry.trackIndex === 'number') {
    const indexed = lookup.byIndex.get(entry.trackIndex);
    if (indexed && (!target || indexed.path === target)) return entry.trackIndex;
  }
  if (!target) return null;
  return lookup.indexByPath.get(target) ?? null;
}

function addConditionTracks(
  conditions: OverlapCondition[] | undefined,
  lookup: TrackLookup,
  active: Set<number>,
): void {
  for (const condition of conditions ?? []) {
    if (condition.target === 'track' && condition.trackId) {
      const trackIdx = Number.parseInt(condition.trackId, 10);
      if (Number.isFinite(trackIdx)) active.add(trackIdx);
    } else if (condition.target === 'motif') {
      for (const trackIdx of lookup.motifTrackIndices) active.add(trackIdx);
    }
  }
}

function addSourceRef(
  ref: SourceRef,
  catalogById: Map<string, CatalogEntry>,
  lookup: TrackLookup,
  active: Set<number>,
): void {
  if (ref.kind === 'metaprofile') return;
  const trackIdx = resolveCatalogTrackIndex(catalogById.get(ref.catalogEntryId), lookup);
  if (trackIdx !== null) active.add(trackIdx);
}

function addSourceCatalogEntryId(ref: SourceRef, active: Set<string>): void {
  if (ref.kind === 'metaprofile') return;
  active.add(ref.catalogEntryId);
}

export function getActiveCatalogEntryIds(
  state: Pick<BrowserState,
    'panels' | 'catalog' | 'compositeTracks' | 'activeColormap' | 'footprintGroups'
  >,
): Set<string> {
  const active = new Set<string>();
  const compositeById = new Map(state.compositeTracks.map(track => [track.id, track]));

  for (const panel of state.panels) {
    if (panel.contentType !== 'dataset' || panel.collapsed) continue;
    for (const subTrack of panel.subTracks ?? []) {
      if (!subTrack.visible || !subTrack.type.startsWith('composite-')) continue;
      const composite = compositeById.get(subTrack.type.slice('composite-'.length));
      if (!composite?.visible) continue;
      for (const source of composite.sources) {
        if (source.visible) addSourceCatalogEntryId(source.ref, active);
      }
    }
  }

  if (hasEnabledMotifCondition(state.activeColormap.rules, state.footprintGroups)) {
    for (const entry of state.catalog) {
      // A motif the user unloaded (or one only listed under Recent) stays off;
      // a motif restored from a session keeps its loaded flag and comes back.
      if (entry.kind === 'motif' && entry.loaded !== false) active.add(entry.id);
    }
  }

  return active;
}

/**
 * Return backend orthogonal-track indices whose viewport data should be fetched.
 *
 * The catalog/cart can contain many tracks that are useful as saved inventory,
 * but fetching all of them on every pan makes large sessions crawl. We only
 * hydrate tracks that are visible in a rendered dataset panel or referenced by
 * enabled labeling/footprint rules that need track/motif context.
 */
export function getActiveOrthogonalTrackIndices(
  state: Pick<BrowserState,
    'panels' | 'catalog' | 'compositeTracks' | 'activeColormap' | 'footprintGroups'
  >,
  trackList: TrackListEntry[],
): Set<number> {
  const active = new Set<number>();
  const catalogById = new Map(state.catalog.map(entry => [entry.id, entry]));
  const compositeById = new Map(state.compositeTracks.map(track => [track.id, track]));
  const lookup = buildTrackLookup(trackList);

  for (const panel of state.panels) {
    if (panel.contentType !== 'dataset' || panel.collapsed) continue;
    for (const subTrack of panel.subTracks ?? []) {
      if (!subTrack.visible) continue;
      const type = subTrack.type;
      if (type.startsWith('ortho-')) {
        const trackIdx = Number.parseInt(type.slice('ortho-'.length), 10);
        if (Number.isFinite(trackIdx)) active.add(trackIdx);
        continue;
      }
      if (!type.startsWith('composite-')) continue;
      const composite = compositeById.get(type.slice('composite-'.length));
      if (!composite?.visible) continue;
      for (const source of composite.sources) {
        if (!source.visible) continue;
        addSourceRef(source.ref, catalogById, lookup, active);
      }
    }
  }

  const enabledRules: ColorRule[] = (state.activeColormap.rules ?? []).filter(rule => rule.enabled);
  for (const rule of enabledRules) {
    addConditionTracks(rule.conditions, lookup, active);
  }

  const enabledFootprintGroups: FootprintGroup[] = (state.footprintGroups ?? []).filter(group => group.enabled);
  for (const group of enabledFootprintGroups) {
    addConditionTracks(group.conditions, lookup, active);
  }

  return active;
}
