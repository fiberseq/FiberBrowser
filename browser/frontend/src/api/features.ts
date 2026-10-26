/**
 * Per-read states of selected features (footprint classes, plugin packs' kinds): browser/routers/features.py.
 * '1' member, '0' evaluated and not a member, '.' not evaluated (or a read name whose molecules disagree).
 */
import { fetchJson } from './sharedFetch';
import { featureKindDef, type FeatureRef } from '../stores/featureStore';

/** A ref of a hub set (fiberhmm-scan sets: `hub:<16 hex>`): its states come from the scan provider. */
export const isHubSource = (source: string): boolean => source.startsWith('hub:');

export interface FeatureStateInfo {
  kind: FeatureRef['kind']; source: string; id: string; dataset_id: string | null;
  /** The datasets the feature applies to (a run's datasets; a class's own dataset). */
  datasets: string[];
  label: string;
  span: [number, number] | null;
  members: Record<string, number>;
  evaluated: Record<string, number>;
}

export interface FeatureStates {
  features: FeatureStateInfo[];
  /** dataset -> read name -> one character per feature, in request order. */
  by_dataset: Record<string, Record<string, string>>;
}

export const getFeatureStates = (features: FeatureRef[]) => fetchJson<FeatureStates>('/api/features/states', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // Per-dataset kinds (footprint classes, SVs) carry their dataset; a hub set's ref may name one to restrict to it.
  body: JSON.stringify({ features: features.map(f => ({ kind: f.kind, source: f.source, id: f.id,
    ...(f.datasetId && (featureKindDef(f.kind)?.perDataset || isHubSource(f.source)) ? { dataset_id: f.datasetId } : {}) })) }),
});
