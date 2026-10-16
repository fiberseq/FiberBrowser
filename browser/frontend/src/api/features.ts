/**
 * Per-read states of selected features (footprint classes, plugin packs' kinds): browser/routers/features.py.
 * '1' member, '0' evaluated and not a member, '.' not evaluated (or a read name whose molecules disagree).
 */
import { fetchJson } from './sharedFetch';
import type { FeatureRef } from '../stores/featureStore';

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
  body: JSON.stringify({ features: features.map(f => ({ kind: f.kind, source: f.source, id: f.id, ...(f.kind === 'fp-class' ? { dataset_id: f.datasetId } : {}) })) }),
});
