/** The cluster views' settings (utils/clusterViewChannels.ts uses them): kept free of other imports so the store
 * slice and the session code can read them cheaply. */
import { DEFAULT_PLOT_SET_Y_SCALE, normalizePlotSetYScale, type PlotSetYScale } from './plotSetYScale';

export const MAP_COLOR_CLUSTER = 'cluster';


export interface ClusterViewSettings {
  /** Metaprofile channels (profile keys); null = the metaprofile layers enabled in Tracks (the default view). */
  profileChannels: string[] | null;
  /** What the map's dots are coloured by ('cluster' = the default). */
  mapColorBy: string;
  /** The reference position 'Layer at position' reads (null: the middle of the view). */
  mapColorPos: number | null;
  /** The cluster mode the map is built from (null: the modes the clustering used, the default). */
  mapFeatureMode: string | null;
  /** The cluster metaprofiles' y scaling (own y per plot / shared; raw / enrichment): utils/plotSetYScale.ts. */
  yScale: PlotSetYScale;
}

export const DEFAULT_CLUSTER_VIEW_SETTINGS: ClusterViewSettings = Object.freeze({
  profileChannels: null, mapColorBy: MAP_COLOR_CLUSTER, mapColorPos: null, mapFeatureMode: null,
  yScale: DEFAULT_PLOT_SET_Y_SCALE,
}) as ClusterViewSettings;

/** A stored value as settings (anything malformed falls back to the default for that field). */
export function normalizeClusterViewSettings(raw: unknown): ClusterViewSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const channels = Array.isArray(r.profileChannels)
    ? [...new Set(r.profileChannels.filter((c): c is string => typeof c === 'string' && c.length > 0))]
    : null;
  return {
    profileChannels: channels && channels.length ? channels : null,
    mapColorBy: typeof r.mapColorBy === 'string' && r.mapColorBy ? r.mapColorBy : MAP_COLOR_CLUSTER,
    mapColorPos: typeof r.mapColorPos === 'number' && Number.isFinite(r.mapColorPos) ? Math.round(r.mapColorPos) : null,
    mapFeatureMode: typeof r.mapFeatureMode === 'string' && r.mapFeatureMode ? r.mapFeatureMode : null,
    // Sessions saved before the y-scale control load with its defaults (today's look).
    yScale: normalizePlotSetYScale(r.yScale),
  };
}
