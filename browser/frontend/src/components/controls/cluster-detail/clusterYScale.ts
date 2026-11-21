/**
 * The cluster metaprofiles' y scaling (utils/plotSetYScale.ts applied to clusters): which channels can be shown as
 * enrichment, each channel's unit, and the baselines.
 *
 * Baselines, per dataset:
 * - region (default): every read in this region, per position: the dataset's own metaprofile for the view
 *   (ReadTrack computes it from the profile read pool the cluster profiles come from, clustered or not, with the
 *   same per-position coverage denominator). A channel the metaprofile doesn't carry (the patch shares, computed on
 *   demand per cluster) uses the read-weighted mean of every cluster's profile instead.
 * - dataset: one number, the mean of that region baseline across its covered extent.
 * - flank: one number per plot, the mean of the plot's own outer flanks within its covered extent.
 * The covered extent is where any of the profile's channels is above zero: the metaprofile leaves positions no read
 * covers at 0, which must neither count as a flank nor be drawn as 0% (they are gaps).
 * The Overview's cards average each channel across datasets (as their profiles do), so their baselines are the
 * across-dataset averages of the per-dataset ones.
 *
 * The regularity channels (a signed log2 tile score, a repeat length in bp) have no meaningful ratio to a baseline:
 * they stay raw (labelled) when enrichment is on.
 */
import { useMemo } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import type { DatasetProfile } from '../../../types/dataset';
import {
  enrichProfile, flankMean, meanOf, pooledProfile, valueAxisLabel, baselineReference,
  type PlotSetYScale,
} from '../../../utils/plotSetYScale';
import { isRegularityChannel, REG_PERIOD_CHANNEL, REG_SCORE_CHANNEL } from '../../../utils/clusterViewChannels';
import { DEFAULT_CLUSTER_VIEW_SETTINGS } from '../../../utils/clusterViewSettings';

export const ENRICHMENT_OFF_REGULARITY = 'Regularity channels are a signed log2 score and a repeat length (bp): a ratio to a baseline has no meaning, so they stay raw';

/** The unit a channel's values are in (channels with one unit can share a range). */
export function clusterChannelUnit(key: string): string {
  if (key === REG_SCORE_CHANNEL) return 'log2 score';
  if (key === REG_PERIOD_CHANNEL) return 'bp';
  return 'fraction';
}

export function clusterEnrichmentSupported(key: string): boolean {
  return !isRegularityChannel(key);
}

/** A channel's profile in a dataset's metaprofile (the same keys and precedence as the per-cluster profiles). */
export function datasetChannelProfile(dp: DatasetProfile | undefined | null, key: string): number[] | null {
  if (!dp) return null;
  const layer = dp.layers?.[key] ?? (key === 'nuc' ? dp.layers?.footprint : undefined);
  if (layer?.length) return layer;
  if (dp.rules?.[key]?.length) return dp.rules[key];
  if (key === 'mod' && dp.mod?.length) return dp.mod;
  if (key === 'fire' && dp.fire?.length) return dp.fire;
  return null;
}

/** First and last position where any channel is finite and above zero (null: none). */
export function coveredExtent(byKey: Record<string, readonly number[] | undefined> | readonly (readonly number[] | undefined)[] | null | undefined): [number, number] | null {
  if (!byKey) return null;
  const arrays = (Array.isArray(byKey) ? byKey : Object.values(byKey)) as (readonly number[] | undefined)[];
  let lo = Infinity, hi = -1;
  for (const a of arrays) {
    if (!a) continue;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) { if (i < lo) lo = i; if (i > hi) hi = i; }
    }
  }
  return hi >= 0 ? [lo, hi] : null;
}

const within = (data: readonly number[], extent: [number, number] | null | undefined) => (extent ? data.slice(extent[0], extent[1] + 1) : data);

/** All channels of a dataset metaprofile (for its covered extent). */
function datasetArrays(dp: DatasetProfile | undefined | null): (readonly number[] | undefined)[] {
  if (!dp) return [];
  return [dp.mod, dp.fire, ...Object.values(dp.rules ?? {}), ...Object.values(dp.layers ?? {})];
}

export interface ChannelBaseline {
  /** Per position (the region baseline); null when there is none. */
  region: number[] | null;
  /** The region baseline's mean across the view (the dataset baseline). */
  datasetMean: number | null;
  /** The region baseline is the read-weighted mean of the clusters (the metaprofile lacks the channel). */
  pooledFromClusters: boolean;
}

/** One dataset's baselines for a channel: its metaprofile, else every cluster's profile weighted by its reads. */
export function channelBaseline(
  key: string,
  datasetProfile: DatasetProfile | undefined | null,
  clusters: ReadonlyArray<{ data: readonly number[]; reads: number }>,
): ChannelBaseline {
  const own = datasetChannelProfile(datasetProfile, key);
  if (own) return { region: own, datasetMean: meanOf(within(own, coveredExtent(datasetArrays(datasetProfile)))), pooledFromClusters: false };
  const pooled = pooledProfile(clusters.map(c => ({ data: c.data, weight: c.reads })));
  return pooled.length ? { region: pooled, datasetMean: meanOf(within(pooled, coveredExtent([pooled]))), pooledFromClusters: true }
    : { region: null, datasetMean: null, pooledFromClusters: true };
}

/** The across-dataset average of several baselines (the Overview's combined cards). */
export function averageBaselines(list: readonly ChannelBaseline[]): ChannelBaseline {
  const regions = list.map(b => b.region).filter((r): r is number[] => !!r && r.length > 0);
  const region = regions.length ? pooledProfile(regions.map(data => ({ data, weight: 1 }))) : null;
  const means = list.map(b => b.datasetMean).filter((m): m is number => m != null && Number.isFinite(m));
  return {
    region,
    datasetMean: means.length ? means.reduce((a, b) => a + b, 0) / means.length : null,
    pooledFromClusters: list.some(b => b.pooledFromClusters),
  };
}

/**
 * The Overview cards' baseline for a channel: the datasets' metaprofiles averaged; a channel none carries (the
 * on-demand patch shares) pools the cards' own across-dataset profiles by their reads.
 */
export function overviewBaseline(
  key: string,
  datasetProfiles: ReadonlyArray<DatasetProfile | undefined | null>,
  cards: ReadonlyArray<{ data: readonly number[]; reads: number }>,
): ChannelBaseline {
  const fromDatasets = datasetProfiles.map(dp => channelBaseline(key, dp, [])).filter(b => b.region);
  return fromDatasets.length ? averageBaselines(fromDatasets) : channelBaseline(key, null, cards);
}

export interface ShownValues {
  values: number[];
  /** Drawn as enrichment (false: raw, because enrichment is off or the channel has none). */
  enriched: boolean;
  gaps: number;
  emptyBaseline: boolean;
}

/**
 * One profile as drawn under the settings: raw, or relative to its baseline. `extent` is the profile's covered
 * extent (coveredExtent over the cluster's channels): enriched values outside it are gaps, and the flank is taken
 * inside it.
 */
export function clusterShownValues(key: string, data: number[], s: PlotSetYScale, baseline: ChannelBaseline, extent?: [number, number] | null): ShownValues {
  if (s.value !== 'enrichment' || !clusterEnrichmentSupported(key)) return { values: data, enriched: false, gaps: 0, emptyBaseline: false };
  const base = s.baseline === 'flank' ? flankMean(within(data, extent), s.flankFraction)
    : s.baseline === 'dataset' ? baseline.datasetMean
      : baseline.region;
  const e = enrichProfile(data, base, s.form, s.minBaselineFraction);
  if (extent) for (let i = 0; i < e.values.length; i++) if (i < extent[0] || i > extent[1]) e.values[i] = NaN;
  return { values: e.values, enriched: true, gaps: e.gaps, emptyBaseline: e.emptyBaseline };
}

/** The y label of a channel's chart under the settings ("% of region baseline", or the channel's own label). */
export function clusterAxisLabel(key: string, s: PlotSetYScale, rawLabel: string): string {
  return clusterEnrichmentSupported(key) ? valueAxisLabel(s, rawLabel) : rawLabel;
}

/** The reference line an enriched chart draws at its baseline (none for raw). */
export function clusterRefLine(key: string, s: PlotSetYScale): number | undefined {
  return s.value === 'enrichment' && clusterEnrichmentSupported(key) ? baselineReference(s.form) : undefined;
}

/** A short note when some baselines were empty or left gaps (null: nothing to say). */
export function baselineNote(shown: readonly ShownValues[], s: PlotSetYScale): string | null {
  if (s.value !== 'enrichment') return null;
  const empty = shown.filter(v => v.enriched && v.emptyBaseline).length;
  const gaps = shown.reduce((n, v) => n + (v.enriched && !v.emptyBaseline ? v.gaps : 0), 0);
  if (empty) return `Baseline empty or zero for ${empty} profile${empty === 1 ? '' : 's'}: left blank.`;
  if (gaps) return `Baseline zero or below the minimum at ${gaps} position${gaps === 1 ? '' : 's'}: shown as gaps.`;
  return null;
}

/** Reads per cluster in each dataset (the clusters' weights for a pooled baseline and the small-cluster rule). */
export function clusterReadCounts(assignments: Record<string, number> | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  for (const c of Object.values(assignments ?? {})) out[c] = (out[c] ?? 0) + 1;
  return out;
}

/** The cluster views' y-scale settings, their setter, and what the baselines need from the store. */
export function useClusterYScale(datasetIds: readonly string[]) {
  const yScale = useBrowserStore(s => s.clusterViewSettings?.yScale ?? DEFAULT_CLUSTER_VIEW_SETTINGS.yScale);
  const setClusterViewSettings = useBrowserStore(s => s.setClusterViewSettings);
  const datasetProfiles = useBrowserStore(s => s.datasetProfiles);
  const assignments = useBrowserStore(s => s.clusterAssignments);
  const key = datasetIds.join('\u0000');
  const readCounts = useMemo(() => Object.fromEntries(datasetIds.map(sk => [sk, clusterReadCounts(assignments[sk])])) as Record<string, Record<number, number>>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assignments, key]);
  const setYScale = (patch: Partial<PlotSetYScale>) => setClusterViewSettings({ yScale: { ...yScale, ...patch } });
  return { yScale, setYScale, datasetProfiles, readCounts };
}
