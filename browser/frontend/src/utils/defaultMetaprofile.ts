import type { CompositeTrack, TrackSource } from '../types/dataset';
import { DEFAULT_METAPROFILE_ID } from '../types/dataset';
import { getMetaprofileSourceEntries } from './layerColors';
import { normalizeAnnotationLayer } from './layerAliases';

// ============================================================
// The default metaprofile follows the active read layers.
//
// One rule: while the default metaprofile cart track follows (its
// `followActiveLayers` is not false), each of its layer sources is visible
// exactly when that layer's Tracks checkbox is on. Rule-id sources and other
// added sources are never touched. A user edit of a layer source's
// visibility switches the track to manual (`followActiveLayers: false`).
//
// Everything that used the retired `enabledMetaProfiles` setting reads the
// default metaprofile's visible sources through `defaultMetaprofileToggles`.
// ============================================================

type LayerToggles = Record<string, boolean | undefined>;
type DatasetLike = Parameters<typeof getMetaprofileSourceEntries>[0][number];

/** Is the Tracks checkbox for this metaprofile layer key on? Mirrors LayerToggles.tsx:
 *  the nuc/footprint alias, FIRE = fire|msp, m6A = m6a|legacy mod. */
export function layerToggleOn(key: string, enabled: LayerToggles): boolean {
  const k = normalizeAnnotationLayer(key) ?? key;
  if (k === 'nuc') return !!(enabled.nuc ?? enabled.footprint);
  if (k === 'footprint') return !!(enabled.footprint ?? enabled.nuc);
  if (k === 'fire') return !!(enabled.fire || enabled.msp);
  if (k === 'm6a' || k === 'mod') return !!(enabled.m6a || enabled.mod);
  return !!enabled[k];
}

/** The key consumers use for a metaprofile source (footprint→nuc, msp→fire, mod→m6a; rule ids as they are). */
export function canonicalMetaprofileKey(ruleId: string): string {
  const k = normalizeAnnotationLayer(ruleId) ?? ruleId;
  if (k === 'footprint') return 'nuc';
  if (k === 'mod') return 'm6a';
  return k;
}

export function isDefaultMetaprofile(track: Pick<CompositeTrack, 'id'> | undefined | null): boolean {
  return !!track && track.id === DEFAULT_METAPROFILE_ID;
}

/** Follow mode is on unless explicitly switched off (old sessions have no field). */
export function followsActiveLayers(track: Pick<CompositeTrack, 'followActiveLayers'> | undefined | null): boolean {
  return !!track && track.followActiveLayers !== false;
}

/** The ruleIds of the default metaprofile that are read layers (the ones that follow). */
export function metaprofileLayerKeys(datasets: DatasetLike[]): Set<string> {
  return new Set(getMetaprofileSourceEntries(datasets).map(e => e.key));
}

/** A layer source: its ruleId, or an alias of it (footprint/nuc, mod/m6a, msp/fire), is a read layer.
 *  A `footprint` source kept from a footprint-only dataset still follows once a `nuc` dataset loads. */
export function isLayerSource(source: TrackSource, layerKeys: Set<string>): boolean {
  if (source.ref.kind !== 'metaprofile') return false;
  if (layerKeys.has(source.ref.ruleId)) return true;
  const canonical = canonicalMetaprofileKey(source.ref.ruleId);
  for (const key of layerKeys) if (canonicalMetaprofileKey(key) === canonical) return true;
  return false;
}

/** The default metaprofile's sources with layer-source visibility following the layer toggles.
 *  Returns the same array when nothing changes. */
export function followLayerSources(sources: TrackSource[], enabled: LayerToggles, layerKeys: Set<string>): TrackSource[] {
  let changed = false;
  const next = sources.map(source => {
    if (!isLayerSource(source, layerKeys) || source.ref.kind !== 'metaprofile') return source;
    const visible = layerToggleOn(source.ref.ruleId, enabled);
    if (source.visible === visible) return source;
    changed = true;
    return { ...source, visible };
  });
  return changed ? next : sources;
}

/** Apply the follow rule to the cart. Returns the same array when nothing changes. */
export function applyFollowActiveLayers(
  compositeTracks: CompositeTrack[],
  enabled: LayerToggles,
  datasets: DatasetLike[],
): CompositeTrack[] {
  const idx = compositeTracks.findIndex(isDefaultMetaprofile);
  if (idx < 0) return compositeTracks;
  const track = compositeTracks[idx];
  if (!followsActiveLayers(track)) return compositeTracks;
  const sources = followLayerSources(track.sources, enabled, metaprofileLayerKeys(datasets));
  if (sources === track.sources) return compositeTracks;
  const next = [...compositeTracks];
  next[idx] = { ...track, sources };
  return next;
}

/**
 * The layers (and rule ids) the default metaprofile shows, as a toggle map keyed
 * canonically (nuc, tf, fire, m6a, …; rule ids unchanged). Independent of the
 * track's eye toggle: this is "what the default metaprofile is set to show",
 * which the cluster panel's Default channel, ReadTrack's layer requests and
 * MetaTrack all follow. Before the track is seeded, the active layers.
 */
export function defaultMetaprofileToggles(state: {
  compositeTracks: CompositeTrack[];
  enabledModTypes: LayerToggles;
  datasets: DatasetLike[];
}): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const track = state.compositeTracks.find(isDefaultMetaprofile);
  if (!track) {
    for (const entry of getMetaprofileSourceEntries(state.datasets)) {
      if (layerToggleOn(entry.key, state.enabledModTypes)) out[canonicalMetaprofileKey(entry.key)] = true;
    }
    return out;
  }
  const effective = followsActiveLayers(track)
    ? followLayerSources(track.sources, state.enabledModTypes, metaprofileLayerKeys(state.datasets))
    : track.sources;
  for (const source of effective) {
    if (source.ref.kind !== 'metaprofile' || !source.visible) continue;
    out[canonicalMetaprofileKey(source.ref.ruleId)] = true;
  }
  return out;
}

/** Stable string form of defaultMetaprofileToggles, for selectors that must not churn. */
export function defaultMetaprofileTogglesKey(state: Parameters<typeof defaultMetaprofileToggles>[0]): string {
  return Object.keys(defaultMetaprofileToggles(state)).sort().join(',');
}

export function togglesFromKey(key: string): Record<string, boolean> {
  return key ? Object.fromEntries(key.split(',').map(k => [k, true])) : {};
}

/**
 * Explicit per-source settings for the default metaprofile (the Python client's
 * `set_metaprofile_layers` / `enabled_meta_profiles`): sources whose key is
 * named take the given visibility. If that changes any source, the track
 * switches to manual, as a hand edit does; a map that matches what it already
 * shows (a replayed settings snapshot) changes nothing and keeps it following.
 * Returns the same array when nothing changes.
 */
export function applyDefaultMetaprofileToggles(
  compositeTracks: CompositeTrack[],
  toggles: Record<string, boolean | undefined>,
): CompositeTrack[] {
  const idx = compositeTracks.findIndex(isDefaultMetaprofile);
  if (idx < 0) return compositeTracks;
  const wanted = new Map<string, boolean>();
  for (const [key, on] of Object.entries(toggles)) {
    if (typeof on === 'boolean') wanted.set(canonicalMetaprofileKey(key), on);
  }
  const track = compositeTracks[idx];
  let changed = false;
  const sources = track.sources.map(source => {
    if (source.ref.kind !== 'metaprofile') return source;
    const on = wanted.get(canonicalMetaprofileKey(source.ref.ruleId));
    if (on === undefined || on === source.visible) return source;
    changed = true;
    return { ...source, visible: on };
  });
  if (!changed) return compositeTracks;
  const next = [...compositeTracks];
  next[idx] = { ...track, sources, followActiveLayers: false };
  return next;
}
