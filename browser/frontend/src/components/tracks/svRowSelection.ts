/**
 * Shift-click selection on the SV row, when a plugin pack provides it (the lab pack: SVs as selectable features for a
 * combined split). Without one, a shift-click on the SV row is a plain click (highlight its reads).
 */
import type { FeatureRef } from '../../stores/featureStore';
import { previewHidden } from '../../utils/previewFeatures';

export interface SvLikeCluster { t: string; ref: number; len: number }

export interface SvRowSelection {
  /** The selected features that are SVs of this dataset (drawn as selected). */
  selected: (features: FeatureRef[], datasetId: string) => FeatureRef[];
  /** Whether a selected feature is this cluster. */
  matches: (feature: FeatureRef, cluster: SvLikeCluster, datasetId: string, chrom: string) => boolean;
  /** Shift-click: add the cluster to the selection, or take it out. */
  toggle: (cluster: SvLikeCluster, datasetId: string, chrom: string) => void;
  /** A Preview feature's id (utils/previewFeatures): shift-click selects only while previews are on. */
  preview?: string;
}

let selection: SvRowSelection | null = null;

export function registerSvRowSelection(def: SvRowSelection): void {
  selection = def;
}

export function svRowSelection(): SvRowSelection | null {
  return selection && !previewHidden(selection.preview) ? selection : null;
}
